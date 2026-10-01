/**
 * Move authoring service (roadmap N35; design plan §13.1).
 *
 * Authored move templates are library artifacts of kind `move` in the `move-discovery-draft`
 * layer, recorded through the ordinary library addition gate, so every draft and every review is
 * an addition event. The workflow is append-only:
 *
 * - `authorMoveDraft` stores a schema-valid template as a draft artifact
 *   `<moveId>.draft.<commandId>`. A draft is never retrievable; the validation report it returns
 *   is advisory.
 * - `reviewMoveDraft` records a human decision as a new artifact `<moveId>.review.<commandId>` that
 *   restates the template with its review (reviewer, time, decision, notes, digest). Approval runs
 *   `validateMoveTemplate` first and refuses, recording nothing, when it fails.
 * - The session's catalog gains the LATEST approved review of each move whose digest still matches
 *   its template. A later draft or rejection never withdraws an approved version; a later approval
 *   replaces it, and because the definition hash changes the N19 preview regeneration applies.
 *   Stored suggestion sets and previews are never touched.
 */
import {
  type LibraryAdditionEvent,
  type LibraryArtifact,
  type LibraryMove,
  type LibraryMoveReview,
  type MoveReviewDecision,
} from "@proof/library";
import {
  authoredMacroDefinition,
  authoredMoveDefinition,
  authoredMoveTemplateSchema,
  validateMoveTemplate,
  type AuthoredMoveTemplate,
  type MoveTemplateValidation,
  type MoveTemplateValidationOptions,
} from "@proof/moves/authoring";
import type { MoveDefinition } from "@proof/moves";
import { definitionHash, type DefinitionCatalog, type MacroDefinition } from "./approved-catalog";
import {
  addLibraryArtifact,
  listLibrary,
  readAdditionEvents,
  type LibraryRepositoryFailure,
  type LibraryStore,
} from "./library-repository";

export type AuthoringFailure =
  | LibraryRepositoryFailure
  | Readonly<{
      status: "rejected";
      diagnostics: readonly [Readonly<{ code: string; message: string }>];
      /** The template validation diagnostics, when validation refused the request. */
      validation?: Extract<MoveTemplateValidation, { ok: false }>["diagnostics"];
    }>;

function refused(
  code: string,
  message: string,
  validation?: Extract<MoveTemplateValidation, { ok: false }>["diagnostics"],
): AuthoringFailure {
  return {
    status: "rejected",
    diagnostics: [{ code, message }],
    ...(validation === undefined ? {} : { validation }),
  };
}

export type MoveRevisionStatus = "draft" | MoveReviewDecision;

/** One draft revision with the review that decided it, if any. */
export type AuthoredMoveRevision = Readonly<{
  draftArtifactId: string;
  reviewArtifactId?: string;
  revision: number;
  authorId: string;
  status: MoveRevisionStatus;
  definitionDigest: string;
  review?: LibraryMoveReview;
  template: Readonly<Record<string, unknown>>;
}>;

export type AuthoredMoveSummary = Readonly<{
  moveId: string;
  name: string;
  revisions: readonly AuthoredMoveRevision[];
  /** The review artifact whose version the catalog currently holds, if any. */
  activeArtifactId?: string;
  /** Whether the active version is in the session's retrieval and materialization catalog. */
  retrievable: boolean;
}>;

function moveArtifacts(artifacts: readonly LibraryArtifact[]): LibraryMove[] {
  return artifacts.filter(
    (artifact): artifact is LibraryMove =>
      artifact.kind === "move" && artifact.layer === "move-discovery-draft",
  );
}

function templateId(artifact: LibraryMove): string | undefined {
  const id = artifact.template["id"];
  return typeof id === "string" ? id : undefined;
}

/** Fold drafts and their reviews into one summary per move, in first-draft order. */
export function summarizeAuthoredMoves(
  artifacts: readonly LibraryArtifact[],
): readonly AuthoredMoveSummary[] {
  const moves = moveArtifacts(artifacts);
  const reviewsByDraft = new Map<string, LibraryMove>();
  for (const artifact of moves) {
    if (artifact.review !== undefined) reviewsByDraft.set(artifact.review.reviewOf, artifact);
  }
  const summaries = new Map<
    string,
    { name: string; revisions: AuthoredMoveRevision[]; active?: LibraryMove }
  >();
  for (const artifact of moves) {
    if (artifact.review !== undefined) continue;
    const moveId = templateId(artifact);
    if (moveId === undefined) continue;
    const entry = summaries.get(moveId) ?? { name: artifact.name, revisions: [] };
    const review = reviewsByDraft.get(artifact.id);
    entry.name = artifact.name;
    entry.revisions.push({
      draftArtifactId: artifact.id,
      ...(review === undefined ? {} : { reviewArtifactId: review.id }),
      revision: entry.revisions.length + 1,
      authorId: artifact.authorId,
      status: review?.review?.decision ?? "draft",
      definitionDigest: artifact.definitionDigest,
      ...(review?.review === undefined ? {} : { review: review.review }),
      template: artifact.template,
    });
    if (review?.review?.decision === "approved") entry.active = review;
    summaries.set(moveId, entry);
  }
  return [...summaries].map(([moveId, entry]) => {
    const definition =
      entry.active === undefined
        ? undefined
        : (approvedDefinition(entry.active, moveId) ?? approvedMacro(entry.active, moveId));
    return {
      moveId,
      name: entry.name,
      revisions: entry.revisions,
      ...(entry.active === undefined ? {} : { activeArtifactId: entry.active.id }),
      retrievable: definition !== undefined,
    };
  });
}

/** The catalog definition of an approved review artifact, or undefined when it is not one. */
function approvedDefinition(artifact: LibraryMove, moveId: string): MoveDefinition | undefined {
  const { approval, review } = artifact;
  if (approval.status !== "approved" || review?.decision !== "approved") return undefined;
  // The stored digest must still describe the stored template.
  if (definitionHash(artifact.template) !== artifact.definitionDigest) return undefined;
  const definition = authoredMoveDefinition(
    artifact.template,
    { status: "approved", reviewerId: approval.reviewerId },
    `authored by ${artifact.authorId}`,
  );
  return definition?.id === moveId ? definition : undefined;
}

/** The macro of an approved review artifact (a template of two or more steps), if it is one. */
function approvedMacro(artifact: LibraryMove, moveId: string): MacroDefinition | undefined {
  const { approval, review } = artifact;
  if (approval.status !== "approved" || review?.decision !== "approved") return undefined;
  if (definitionHash(artifact.template) !== artifact.definitionDigest) return undefined;
  const macro = authoredMacroDefinition(
    artifact.template,
    { status: "approved", reviewerId: approval.reviewerId },
    `authored by ${artifact.authorId}`,
  );
  return macro?.definition.id === moveId
    ? { move: macro.definition, template: macro.template }
    : undefined;
}

/** The latest approved review of each move among a session's stored move artifacts. */
function latestApprovedReviews(artifacts: readonly LibraryArtifact[]): Map<string, LibraryMove> {
  const latest = new Map<string, LibraryMove>();
  for (const artifact of moveArtifacts(artifacts)) {
    const moveId = templateId(artifact);
    if (moveId !== undefined && artifact.review?.decision === "approved") {
      latest.set(moveId, artifact);
    }
  }
  return latest;
}

/** The approved, retrievable definitions among a session's stored move artifacts. */
export function approvedAuthoredMoves(
  artifacts: readonly LibraryArtifact[],
): readonly MoveDefinition[] {
  return [...latestApprovedReviews(artifacts)].flatMap(([moveId, artifact]) => {
    const definition = approvedDefinition(artifact, moveId);
    return definition === undefined ? [] : [definition];
  });
}

/** The approved multi-step macros among a session's stored move artifacts. */
export function approvedAuthoredMacros(
  artifacts: readonly LibraryArtifact[],
): readonly MacroDefinition[] {
  return [...latestApprovedReviews(artifacts)].flatMap(([moveId, artifact]) => {
    const macro = approvedMacro(artifact, moveId);
    return macro === undefined ? [] : [macro];
  });
}

/**
 * The definitions a session retrieves and applies with: the base catalog plus the session's
 * approved authored moves. Drafts, rejections and change requests contribute nothing.
 */
export async function sessionDefinitions(
  base: DefinitionCatalog,
  library: LibraryStore | undefined,
  sessionId: string,
): Promise<DefinitionCatalog> {
  if (library === undefined) return base;
  const listed = await listLibrary(library, { sessionId, layers: ["move-discovery-draft"] });
  if (listed.status !== "found") return base;
  const taken = (id: string) => base.moves.some((move) => move.id === id);
  const authored = approvedAuthoredMoves(listed.artifacts).filter((move) => !taken(move.id));
  const macros = approvedAuthoredMacros(listed.artifacts).filter(({ move }) => !taken(move.id));
  if (authored.length === 0 && macros.length === 0) return base;
  return Object.freeze({
    moves: [...base.moves, ...authored],
    ...(macros.length === 0 ? {} : { macros: [...(base.macros ?? []), ...macros] }),
    catalog: base.catalog,
  });
}

export type SessionAuthoredMoves = Readonly<{
  status: "found";
  moves: readonly AuthoredMoveSummary[];
}>;

export async function readAuthoredMoves(
  library: LibraryStore,
  sessionId: string,
): Promise<SessionAuthoredMoves | LibraryRepositoryFailure> {
  const listed = await listLibrary(library, { sessionId, layers: ["move-discovery-draft"] });
  if (listed.status !== "found") return listed;
  return { status: "found", moves: summarizeAuthoredMoves(listed.artifacts) };
}

/** Whether the move's latest approved version is in the session's retrieval catalog. */
function isRetrievable(artifacts: readonly LibraryArtifact[], moveId: string | undefined): boolean {
  return (
    approvedAuthoredMoves(artifacts).some(({ id }) => id === moveId) ||
    approvedAuthoredMacros(artifacts).some(({ move }) => move.id === moveId)
  );
}

const CLASSIFICATION = { domains: ["proof-moves"], level: "foundational" } as const;

function artifactShape(template: AuthoredMoveTemplate, authorId: string) {
  return {
    kind: "move" as const,
    name: template.name,
    description: template.description,
    renderings: { latex: template.name, naturalLanguage: template.description },
    classification: CLASSIFICATION,
    provenance: { kind: "curated" as const, source: `authored:${authorId}` },
    layer: "move-discovery-draft" as const,
    related: template.requiredArtifacts.map(({ kind, id }) => ({ kind, id })),
    priority: 0,
    template: template as unknown as Record<string, unknown>,
    definitionDigest: definitionHash(template),
    authorId,
  };
}

async function existingAddition(
  library: LibraryStore,
  sessionId: string,
  eventId: string,
): Promise<LibraryRepositoryFailure | { event?: LibraryAdditionEvent }> {
  const read = await readAdditionEvents(library, sessionId);
  if (read.status !== "found") return read;
  const event = read.events.find(({ id }) => id === eventId);
  return event === undefined ? {} : { event };
}

export type AuthorDraftInput = Readonly<{
  commandId: string;
  sessionId: string;
  authorId: string;
  occurredAt: string;
  template: unknown;
  validation: MoveTemplateValidationOptions;
}>;

export type AuthorDraftResult =
  | Readonly<{
      status: "recorded";
      replayed: boolean;
      artifact: LibraryMove;
      revision: number;
      /** Advisory: a draft may be saved while it is still failing validation. */
      validation: MoveTemplateValidation;
    }>
  | AuthoringFailure;

export async function authorMoveDraft(
  library: LibraryStore,
  input: AuthorDraftInput,
): Promise<AuthorDraftResult> {
  const parsed = authoredMoveTemplateSchema.safeParse(input.template);
  if (!parsed.success) {
    const validation = validateMoveTemplate(input.template, input.validation);
    return refused(
      "invalid-template",
      "The template is not a well-formed authored move.",
      validation.ok ? undefined : validation.diagnostics,
    );
  }
  const template = parsed.data;
  const validation = validateMoveTemplate(template, input.validation);
  const eventId = `library-addition:${input.commandId}`;
  const prior = await existingAddition(library, input.sessionId, eventId);
  if ("status" in prior) return prior;
  const listed = await listLibrary(library, {
    sessionId: input.sessionId,
    layers: ["move-discovery-draft"],
  });
  if (listed.status !== "found") return listed;
  const drafts = moveArtifacts(listed.artifacts).filter(
    (artifact) => artifact.review === undefined && templateId(artifact) === template.id,
  );
  if (prior.event !== undefined) {
    const artifact = prior.event.artifact;
    if (artifact.kind !== "move" || artifact.definitionDigest !== definitionHash(template)) {
      return refused("event-id-conflict", "The command ID is bound to another addition.");
    }
    const position = drafts.findIndex(({ id }) => id === artifact.id);
    return { status: "recorded", replayed: true, artifact, revision: position + 1, validation };
  }
  const artifact = {
    id: `${template.id}.draft.${input.commandId}`,
    ...artifactShape(template, input.authorId),
    approval: { status: "draft" as const },
  };
  const added = await addLibraryArtifact(library, {
    id: eventId,
    sessionId: input.sessionId,
    occurredAt: input.occurredAt,
    layer: "move-discovery-draft",
    origin: { kind: "user", actorId: input.authorId },
    artifact,
  });
  if (added.status !== "recorded") return added;
  if (!added.admitted || added.event.artifact.kind !== "move") {
    return refused(
      "library-admission-rejected",
      added.event.admission.decision === "rejected"
        ? (added.event.admission.diagnostics[0]?.message ?? "The draft was not admitted.")
        : "The draft was not admitted.",
    );
  }
  return {
    status: "recorded",
    replayed: added.replayed,
    artifact: added.event.artifact,
    revision: drafts.length + 1,
    validation,
  };
}

export type ReviewDraftInput = Readonly<{
  commandId: string;
  sessionId: string;
  reviewerId: string;
  occurredAt: string;
  draftArtifactId: string;
  decision: MoveReviewDecision;
  notes: string;
  validation: MoveTemplateValidationOptions;
}>;

export type ReviewDraftResult =
  | Readonly<{
      status: "recorded";
      replayed: boolean;
      artifact: LibraryMove;
      decision: MoveReviewDecision;
      definitionDigest: string;
      /** Whether the approved move is now in the session's retrieval catalog. */
      retrievable: boolean;
    }>
  | AuthoringFailure;

export async function reviewMoveDraft(
  library: LibraryStore,
  input: ReviewDraftInput,
): Promise<ReviewDraftResult> {
  const listed = await listLibrary(library, {
    sessionId: input.sessionId,
    layers: ["move-discovery-draft"],
  });
  if (listed.status !== "found") return listed;
  const moves = moveArtifacts(listed.artifacts);
  const eventId = `library-addition:${input.commandId}`;
  const prior = await existingAddition(library, input.sessionId, eventId);
  if ("status" in prior) return prior;
  if (prior.event !== undefined) {
    const artifact = prior.event.artifact;
    if (
      artifact.kind !== "move" ||
      artifact.review === undefined ||
      artifact.review.reviewOf !== input.draftArtifactId
    ) {
      return refused("event-id-conflict", "The command ID is bound to another addition.");
    }
    return {
      status: "recorded",
      replayed: true,
      artifact,
      decision: artifact.review.decision,
      definitionDigest: artifact.definitionDigest,
      retrievable: isRetrievable(moves, templateId(artifact)),
    };
  }
  const draft = moves.find(
    ({ id, review }) => id === input.draftArtifactId && review === undefined,
  );
  if (draft === undefined) {
    return refused("draft-not-found", "The session has no such move draft.");
  }
  if (moves.some(({ review }) => review?.reviewOf === draft.id)) {
    return refused("draft-already-reviewed", "The draft already has a recorded review.");
  }
  if (input.decision !== "approved" && input.notes.trim().length === 0) {
    return refused("review-notes-required", "A rejection or change request needs notes.");
  }
  const parsed = authoredMoveTemplateSchema.safeParse(draft.template);
  if (!parsed.success || definitionHash(parsed.data) !== draft.definitionDigest) {
    return refused("draft-corrupt", "The stored template does not match its recorded digest.");
  }
  const template = parsed.data;
  if (input.decision === "approved") {
    // Approval requires the template to pass validation now, against this session's environment.
    const validation = validateMoveTemplate(template, input.validation);
    if (!validation.ok) {
      return refused(
        "move-validation-failed",
        "The template does not pass validation, so it cannot be approved.",
        validation.diagnostics,
      );
    }
  }
  const review: LibraryMoveReview = {
    decision: input.decision,
    reviewerId: input.reviewerId,
    reviewedAt: input.occurredAt,
    notes: input.notes,
    reviewOf: draft.id,
    definitionDigest: draft.definitionDigest,
  };
  const artifact = {
    ...artifactShape(template, draft.authorId),
    id: `${template.id}.review.${input.commandId}`,
    approval:
      input.decision === "approved"
        ? { status: "approved" as const, reviewerId: input.reviewerId }
        : input.decision === "rejected"
          ? { status: "rejected" as const, reason: input.notes }
          : { status: "draft" as const },
    review,
  };
  const added = await addLibraryArtifact(library, {
    id: eventId,
    sessionId: input.sessionId,
    occurredAt: input.occurredAt,
    layer: "move-discovery-draft",
    origin: { kind: "user", actorId: input.reviewerId },
    artifact,
  });
  if (added.status !== "recorded") return added;
  if (!added.admitted || added.event.artifact.kind !== "move") {
    return refused(
      "library-admission-rejected",
      added.event.admission.decision === "rejected"
        ? (added.event.admission.diagnostics[0]?.message ?? "The review was not admitted.")
        : "The review was not admitted.",
    );
  }
  return {
    status: "recorded",
    replayed: added.replayed,
    artifact: added.event.artifact,
    decision: input.decision,
    definitionDigest: draft.definitionDigest,
    retrievable:
      input.decision === "approved" && isRetrievable([...moves, added.event.artifact], template.id),
  };
}
