/**
 * The versioned, self-contained proof artifact (design plan §19, §4.6; roadmap N27).
 *
 * An artifact is static documentary history: every section is a copy of stored rows (snapshots,
 * displayed suggestion sets with their selections, previews, edges, transition events, command
 * records, replay steps, deletion tombstones, interaction events, inquiry records, and library
 * addition events), never a recomputation. Only the final material (solved status, provability
 * route, pruned proof, sorry assumptions) and the translation dictionary are derived, and they are
 * derived deterministically by `deriveArtifactFinalMaterial` and `deriveTranslationDictionary`
 * from the stored sections, so an importer can recompute and compare them.
 *
 * Sections (§19.2) and where they come from:
 *
 * - `problemSetup`: the session metadata (problem, background profile, preferences, library
 *   layer IDs). Setup edits and topic/vocabulary manifest stages are not stored (N26 keeps drafts
 *   in the browser), so they are absent.
 * - `initialState`: the root node ID and the session operators; the root snapshot is in `tree`.
 * - `library`: the library's operator environment, the session's addition events (admitted and
 *   rejected) and background revisions, and the final active library (global + session layers).
 * - `tree`: the full retained tree with complete snapshots, edges, transition events, the
 *   validated command records (chosen moves, parameters, kernel operations), displayed suggestion
 *   sets (selections, ranking and applicability evidence), previews, semantic-replay step records
 *   and the ID-only deletion tombstones. Deleted work is absent.
 * - `interactionEvents` (including backtracking-with-information events) and `inquiryRecords`.
 * - `final` and `translationDictionary` (derived), and `llmCalls` (stored LLM call records, if any).
 *
 * `digest` is `sha256:` of `canonicalArtifactJson` of the artifact without `digest`. The digest
 * detects accidental corruption only; an importer must revalidate every section.
 *
 * Session identity. The only fields that name the exporting session are listed in
 * `ARTIFACT_SESSION_ID_FIELDS`; `withArtifactSessionId` rewrites exactly those, so two artifacts of
 * the same history under different session IDs compare equal after rebasing one onto the other.
 */
import {
  backgroundRevisionEventSchema,
  createLibraryAdditionEventSchema,
  createLibraryArtifactSchema,
  libraryPacksForOperators,
  type BackgroundRevisionEvent,
  type LibraryAdditionEvent,
  type LibraryArtifact,
} from "@proof/library";
import {
  operatorDeclarationsSchema,
  operatorPresentationSchema,
  stableIdentifierSchema,
  type OperatorDeclaration,
  type OperatorPresentation,
} from "@proof/mathjson-model";
import { z } from "zod";
import { analyzeDiscoveryTree, prunedProof } from "./discovery-tree";
import { inquiryRecordSchema, type InquiryRecord } from "./inquiry";
import { interactionEventSchema, type InteractionEvent } from "./interaction-events";
import { proofDeletionRecordSchema, type ProofDeletionRecord } from "./move-deletion";
import { semanticReplayStepRecordSchema, type SemanticReplayStepRecord } from "./semantic-replay";
import { proofSessionMetadataSchema, type ProofSessionMetadata } from "./session-metadata";
import {
  createMovePreviewSchema,
  createPrepareProofCommandSuccessSchema,
  createProofEdgeSchema,
  createProofNodeSchema,
  createTransitionEventSchema,
  displayedSuggestionSetSchema,
  type DisplayedSuggestionSet,
  type MovePreview,
  type PrepareProofCommandSuccess,
  type ProofEdge,
  type ProofNode,
  type TransitionEvent,
} from "./index";

/**
 * The version `exportProofArtifact` writes: transitions carry the kernel's evidence and a
 * per-session transition sequence, and previews carry their evidence (design plan §19; N40).
 */
export const PROOF_ARTIFACT_VERSION = 2;
/** Version 1 stored neither; an importer still accepts it and derives what it shows. */
export const LEGACY_ARTIFACT_VERSION = 1;
export const SUPPORTED_ARTIFACT_VERSIONS = [
  LEGACY_ARTIFACT_VERSION,
  PROOF_ARTIFACT_VERSION,
] as const;
export type ProofArtifactVersion = (typeof SUPPORTED_ARTIFACT_VERSIONS)[number];
export const PROOF_ARTIFACT_KIND = "proof-artifact";

export const proofArtifactDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type ProofArtifactDigest = z.infer<typeof proofArtifactDigestSchema>;

/**
 * Paths of every field that names the exporting session (`*` is any array index). Everything
 * else in an artifact is independent of the session ID it was stored under.
 */
export const ARTIFACT_SESSION_ID_FIELDS = [
  "sessionId",
  "library.additionEvents.*.sessionId",
  "library.additionEvents.*.artifact.provenance.sessionId (derived provenance naming the session)",
  "library.backgroundRevisions.*.sessionId",
  "library.finalLibrary.*.provenance.sessionId (derived provenance naming the session)",
  "llmCalls.*.owner.id (owner kind proof-session naming the session)",
] as const;

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export const proofArtifactProvenanceSchema = z.discriminatedUnion("kind", [
  /** Exported from a session built in this service. */
  z.object({ kind: z.literal("session") }).strict(),
  /** Exported from a read-only session that was created by importing another artifact. */
  z
    .object({
      kind: z.literal("import"),
      sourceSessionId: stableIdentifierSchema,
      sourceDigest: proofArtifactDigestSchema,
    })
    .strict(),
]);
export type ProofArtifactProvenance = z.infer<typeof proofArtifactProvenanceSchema>;

export const translationDictionaryEntrySchema = z
  .object({
    operatorId: stableIdentifierSchema,
    symbol: z.string().min(1),
    /** The stored LaTeX and natural-language presentation metadata of the operator. */
    presentation: operatorPresentationSchema.optional(),
    /** Starter packs that introduce this exact declaration. */
    packIds: z.array(stableIdentifierSchema),
  })
  .strict();
export type TranslationDictionaryEntry = Readonly<{
  operatorId: string;
  symbol: string;
  presentation?: OperatorPresentation | undefined;
  packIds: readonly string[];
}>;

export const translationDictionarySchema = z
  .object({
    activePackIds: z.array(stableIdentifierSchema),
    entries: z.array(translationDictionaryEntrySchema),
  })
  .strict();
export type TranslationDictionary = Readonly<{
  activePackIds: readonly string[];
  entries: readonly TranslationDictionaryEntry[];
}>;

export const artifactFinalMaterialSchema = z
  .object({
    solved: z.boolean(),
    /** The N17 `analyzeDiscoveryTree` result over the stored tree. */
    analysis: jsonValueSchema,
    /** The N17 pruned proof when solved, otherwise null. */
    prunedProof: jsonValueSchema,
    /** Every universally closed sorry assumption in the retained snapshots, by ID. */
    sorryAssumptions: z.array(jsonValueSchema),
  })
  .strict();
export type ArtifactFinalMaterial = Readonly<{
  solved: boolean;
  analysis: JsonValue;
  prunedProof: JsonValue;
  sorryAssumptions: readonly JsonValue[];
}>;

export type ProofArtifactTree = Readonly<{
  rootNodeId: ProofNode["id"];
  currentNodeId: ProofNode["id"];
  nodes: readonly ProofNode[];
  edges: readonly ProofEdge[];
  events: readonly TransitionEvent[];
  commands: readonly PrepareProofCommandSuccess[];
  suggestionSets: readonly DisplayedSuggestionSet[];
  previews: readonly MovePreview[];
  replaySteps: readonly SemanticReplayStepRecord[];
  deletions: readonly ProofDeletionRecord[];
}>;

export type ProofArtifactLibrary = Readonly<{
  /** The library's operator environment: the global registry merged with the session's. */
  operators: readonly OperatorDeclaration[];
  additionEvents: readonly LibraryAdditionEvent[];
  backgroundRevisions: readonly BackgroundRevisionEvent[];
  /** The active library in listing order: global artifacts, then the session's layers. */
  finalLibrary: readonly LibraryArtifact[];
}>;

export type ProofArtifact = Readonly<{
  artifactVersion: ProofArtifactVersion;
  kind: typeof PROOF_ARTIFACT_KIND;
  digest: ProofArtifactDigest;
  sessionId: string;
  provenance: ProofArtifactProvenance;
  problemSetup: Readonly<{ metadata: ProofSessionMetadata | null }>;
  initialState: Readonly<{
    rootNodeId: ProofNode["id"];
    operators: readonly OperatorDeclaration[];
  }>;
  library: ProofArtifactLibrary;
  tree: ProofArtifactTree;
  interactionEvents: readonly InteractionEvent[];
  inquiryRecords: readonly InquiryRecord[];
  final: ArtifactFinalMaterial;
  translationDictionary: TranslationDictionary;
  llmCalls: readonly JsonObject[];
}>;

/** The artifact without its digest: the content the digest covers. */
export type ProofArtifactContent = Omit<ProofArtifact, "digest">;

export type ProofArtifactEnvironment = Readonly<{
  /** The session operators (`initialState.operators`). */
  operators: readonly OperatorDeclaration[];
  /** The library operator environment (`library.operators`). */
  libraryOperators: readonly OperatorDeclaration[];
}>;

/**
 * The strict artifact schema for one operator environment. Use `parseProofArtifact` for input
 * whose environment is not yet known; it reads the environment from the artifact first.
 */
export function createProofArtifactSchema(
  environment: ProofArtifactEnvironment,
): z.ZodType<ProofArtifact> {
  const protocolEnvironment = { operators: environment.operators };
  const libraryEnvironment = { operators: environment.libraryOperators };
  const libraryArtifactSchema = createLibraryArtifactSchema(libraryEnvironment);
  return z
    .object({
      artifactVersion: z.union([
        z.literal(LEGACY_ARTIFACT_VERSION),
        z.literal(PROOF_ARTIFACT_VERSION),
      ]),
      kind: z.literal(PROOF_ARTIFACT_KIND),
      digest: proofArtifactDigestSchema,
      sessionId: stableIdentifierSchema,
      provenance: proofArtifactProvenanceSchema,
      problemSetup: z.object({ metadata: proofSessionMetadataSchema.nullable() }).strict(),
      initialState: z
        .object({
          rootNodeId: stableIdentifierSchema,
          operators: operatorDeclarationsSchema,
        })
        .strict(),
      library: z
        .object({
          operators: operatorDeclarationsSchema,
          additionEvents: z.array(createLibraryAdditionEventSchema(libraryEnvironment)),
          backgroundRevisions: z.array(backgroundRevisionEventSchema),
          finalLibrary: z.array(libraryArtifactSchema),
        })
        .strict(),
      tree: z
        .object({
          rootNodeId: stableIdentifierSchema,
          currentNodeId: stableIdentifierSchema,
          nodes: z.array(createProofNodeSchema(protocolEnvironment)),
          edges: z.array(createProofEdgeSchema(protocolEnvironment)),
          events: z.array(createTransitionEventSchema(protocolEnvironment)),
          commands: z.array(createPrepareProofCommandSuccessSchema(protocolEnvironment)),
          suggestionSets: z.array(displayedSuggestionSetSchema),
          previews: z.array(createMovePreviewSchema(protocolEnvironment)),
          replaySteps: z.array(semanticReplayStepRecordSchema),
          deletions: z.array(proofDeletionRecordSchema),
        })
        .strict(),
      interactionEvents: z.array(interactionEventSchema),
      inquiryRecords: z.array(inquiryRecordSchema),
      final: artifactFinalMaterialSchema,
      translationDictionary: translationDictionarySchema,
      llmCalls: z.array(jsonObjectSchema),
    })
    .strict()
    .superRefine((artifact, context) => {
      addStoredEvidenceIssues(artifact as unknown as ProofArtifact, context);
      if (artifact.initialState.rootNodeId !== artifact.tree.rootNodeId) {
        context.addIssue({
          code: "custom",
          message: "The initial state names a different root node than the tree.",
          path: ["initialState", "rootNodeId"],
        });
      }
      if (!sameJson(artifact.initialState.operators, environment.operators)) {
        context.addIssue({
          code: "custom",
          message: "The session operators differ from the parsing environment.",
          path: ["initialState", "operators"],
        });
      }
      if (!sameJson(artifact.library.operators, environment.libraryOperators)) {
        context.addIssue({
          code: "custom",
          message: "The library operators differ from the parsing environment.",
          path: ["library", "operators"],
        });
      }
      const libraryOperators = new Map(
        artifact.library.operators.map((operator) => [operator.symbol, operator]),
      );
      artifact.initialState.operators.forEach((operator, index) => {
        if (!sameJson(libraryOperators.get(operator.symbol), operator)) {
          context.addIssue({
            code: "custom",
            message: `The library environment must declare the session operator ${operator.symbol} identically.`,
            path: ["initialState", "operators", index],
          });
        }
      });
      artifact.library.additionEvents.forEach((event, index) => {
        if (event.sessionId !== artifact.sessionId) {
          context.addIssue({
            code: "custom",
            message: "Every addition event belongs to the artifact's session scope.",
            path: ["library", "additionEvents", index, "sessionId"],
          });
        }
      });
      artifact.library.backgroundRevisions.forEach((revision, index) => {
        if (revision.sessionId !== artifact.sessionId) {
          context.addIssue({
            code: "custom",
            message: "Every background revision belongs to the artifact's session.",
            path: ["library", "backgroundRevisions", index, "sessionId"],
          });
        }
      });
    }) as unknown as z.ZodType<ProofArtifact>;
}

export const proofArtifactDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    /** The artifact path the diagnostic is about, when there is one. */
    path: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();
export type ProofArtifactDiagnostic = z.infer<typeof proofArtifactDiagnosticSchema>;

export type ParseProofArtifactResult =
  | Readonly<{ ok: true; artifact: ProofArtifact }>
  | Readonly<{ ok: false; diagnostics: readonly [ProofArtifactDiagnostic] }>;

/**
 * Parse an untrusted artifact: its version first (`unsupported-version`), then its operator
 * environments, then every section strictly in that environment (`invalid-artifact`, with the
 * first failing path).
 */
export function parseProofArtifact(input: unknown): ParseProofArtifactResult {
  try {
    if (!isPlainObject(input)) {
      return parseFailure("invalid-artifact", "A proof artifact must be a JSON object.", []);
    }
    if (!SUPPORTED_ARTIFACT_VERSIONS.some((version) => version === input.artifactVersion)) {
      return parseFailure(
        "unsupported-version",
        `Only artifact versions ${SUPPORTED_ARTIFACT_VERSIONS.join(" and ")} are supported.`,
        ["artifactVersion"],
      );
    }
    const initialState = isPlainObject(input.initialState) ? input.initialState : {};
    const library = isPlainObject(input.library) ? input.library : {};
    const operators = operatorDeclarationsSchema.safeParse(initialState.operators);
    if (!operators.success) {
      return parseFailure("invalid-artifact", "The session operator environment is invalid.", [
        "initialState",
        "operators",
      ]);
    }
    const libraryOperators = operatorDeclarationsSchema.safeParse(library.operators);
    if (!libraryOperators.success) {
      return parseFailure("invalid-artifact", "The library operator environment is invalid.", [
        "library",
        "operators",
      ]);
    }
    const parsed = createProofArtifactSchema({
      operators: operators.data,
      libraryOperators: libraryOperators.data,
    }).safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return parseFailure(
        "invalid-artifact",
        issue?.message ?? "The artifact does not match its strict schema.",
        (issue?.path ?? []).map((segment) =>
          typeof segment === "number" ? segment : String(segment),
        ),
      );
    }
    return { ok: true, artifact: parsed.data };
  } catch {
    return parseFailure("invalid-artifact", "The artifact could not be inspected safely.", []);
  }
}

/** Canonical JSON: object keys sorted, undefined properties dropped, no whitespace. */
export function canonicalArtifactJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalArtifactJson(item))).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalArtifactJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The content a digest covers: the artifact without its `digest` field. */
export function proofArtifactContent(
  artifact: ProofArtifact | ProofArtifactContent,
): ProofArtifactContent {
  const content: Record<string, unknown> = { ...artifact };
  delete content.digest;
  return content as ProofArtifactContent;
}

/**
 * Rebase an artifact onto another session ID: rewrites exactly `ARTIFACT_SESSION_ID_FIELDS`
 * where they name the artifact's current session. The digest is left as it was.
 */
export function withArtifactSessionId<Artifact extends ProofArtifact | ProofArtifactContent>(
  artifact: Artifact,
  sessionId: string,
): Artifact {
  const source = artifact.sessionId;
  const rebaseProvenance = <Value extends Readonly<{ provenance: unknown }>>(
    value: Value,
  ): Value => {
    const provenance = value.provenance as Readonly<{ kind?: unknown; sessionId?: unknown }>;
    return provenance.kind === "derived" && provenance.sessionId === source
      ? { ...value, provenance: { ...provenance, sessionId } }
      : value;
  };
  return {
    ...artifact,
    sessionId,
    library: {
      ...artifact.library,
      additionEvents: artifact.library.additionEvents.map((event) => ({
        ...event,
        ...(event.sessionId === source ? { sessionId } : {}),
        artifact: rebaseProvenance(event.artifact),
      })),
      backgroundRevisions: artifact.library.backgroundRevisions.map((revision) =>
        revision.sessionId === source ? { ...revision, sessionId } : revision,
      ),
      finalLibrary: artifact.library.finalLibrary.map(rebaseProvenance),
    },
    llmCalls: artifact.llmCalls.map((call) => {
      const owner = call.owner;
      return isPlainObject(owner) && owner.kind === "proof-session" && owner.id === source
        ? { ...call, owner: { ...owner, id: sessionId } }
        : call;
    }),
  } as Artifact;
}

/**
 * The derived final material (design plan §19.2 "Final material") over the stored tree: the N17
 * analysis (solved status, chosen route, evidence and sorry/background summaries), the pruned
 * proof when solved, and every distinct sorry assumption in the retained snapshots, by ID.
 */
export function deriveArtifactFinalMaterial(
  tree: Readonly<{
    rootNodeId: string;
    nodes: readonly ProofNode[];
    edges: readonly ProofEdge[];
  }>,
): ArtifactFinalMaterial {
  const edges = [...tree.edges].sort((left, right) => compareStrings(left.id, right.id));
  const analysis = analyzeDiscoveryTree({
    nodes: tree.nodes,
    edges,
    rootId: tree.rootNodeId as ProofNode["id"],
  });
  const solved = analysis.ok && analysis.solved;
  const pruned = analysis.ok && analysis.solved ? prunedProof(analysis) : undefined;
  const assumptions = new Map<string, unknown>();
  for (const node of tree.nodes) {
    for (const assumption of node.state.assumptions ?? []) {
      if (!assumptions.has(assumption.id)) assumptions.set(assumption.id, assumption);
    }
  }
  return {
    solved,
    analysis: toJson(analysis),
    prunedProof: pruned?.ok === true ? toJson(pruned.proof) : null,
    sorryAssumptions: [...assumptions.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([, assumption]) => toJson(assumption)),
  };
}

/**
 * The translation dictionary: each session operator's stored presentation metadata (LaTeX
 * template and parse trigger, natural-language templates) and the starter packs that introduce
 * its exact declaration, plus the packs active for the session's operators.
 */
export function deriveTranslationDictionary(
  operators: readonly OperatorDeclaration[],
): TranslationDictionary {
  const packs = libraryPacksForOperators(operators);
  return {
    activePackIds: packs.map(({ id }) => id),
    entries: operators.map((operator) => ({
      operatorId: operator.id,
      symbol: operator.symbol,
      ...(operator.presentation === undefined
        ? {}
        : { presentation: toJson(operator.presentation) as OperatorPresentation }),
      packIds: packs
        .filter((pack) =>
          pack.operators.some(
            (declared) => declared.symbol === operator.symbol && sameJson(declared, operator),
          ),
        )
        .map(({ id }) => id),
    })),
  };
}

/** `POST /artifacts` success: the read-only session the artifact was imported into. */
export const proofArtifactImportResponseSchema = z
  .object({
    sessionId: stableIdentifierSchema,
    digest: proofArtifactDigestSchema,
    sourceSessionId: stableIdentifierSchema,
    readOnly: z.literal(true),
    replayed: z.boolean(),
  })
  .strict();
export type ProofArtifactImportResponse = z.infer<typeof proofArtifactImportResponseSchema>;

/** `POST /artifacts` rejection (422): every diagnostic names what failed revalidation. */
export const proofArtifactRejectionResponseSchema = z
  .object({ diagnostics: z.array(proofArtifactDiagnosticSchema).min(1) })
  .strict();

/**
 * The worker's record of one import (migration 0011): the uploaded artifact's digest and source
 * session, and the sections that have no proof-store rows, already rebased onto the imported
 * session. Re-exporting the read-only session reads them back statically.
 */
export const proofArtifactImportRecordSchema = z
  .object({
    sessionId: stableIdentifierSchema,
    digest: proofArtifactDigestSchema,
    sourceSessionId: stableIdentifierSchema,
    importedAt: z.string().datetime({ offset: true }),
    library: jsonObjectSchema,
    llmCalls: z.array(jsonObjectSchema),
  })
  .strict();
export type ProofArtifactImportRecord = Readonly<{
  sessionId: string;
  digest: string;
  sourceSessionId: string;
  importedAt: string;
  library: JsonObject;
  llmCalls: readonly JsonObject[];
}>;

/**
 * Version 1 stores no transition evidence or sequence, so a version-1 artifact must carry none.
 * Version 2 stores both, so every edge, transition event, command record and preview must carry
 * its evidence, every edge and event its sequence, the two records of one transition the same
 * values, sequences must be distinct, and a transition must follow the one that produced its
 * parent. Whether the stored evidence is what the kernel reports is the importer's replay check.
 */
function addStoredEvidenceIssues(artifact: ProofArtifact, context: z.RefinementCtx): void {
  const { tree } = artifact;
  const issue = (message: string, path: (string | number)[]) =>
    context.addIssue({ code: "custom", message, path });
  if (artifact.artifactVersion === LEGACY_ARTIFACT_VERSION) {
    const stored = (value: Readonly<{ evidence?: unknown; sequence?: unknown }>) =>
      value.evidence !== undefined || value.sequence !== undefined;
    tree.edges.forEach((edge, index) => {
      if (stored(edge))
        issue("A version-1 artifact stores no transition evidence.", ["tree", "edges", index]);
    });
    tree.events.forEach((event, index) => {
      if (stored(event))
        issue("A version-1 artifact stores no transition evidence.", ["tree", "events", index]);
    });
    tree.commands.forEach((command, index) => {
      const { edge, event } = command.prepared;
      if (stored(edge) || stored(event) || stored(command.receipt)) {
        issue("A version-1 artifact stores no transition evidence.", ["tree", "commands", index]);
      }
    });
    tree.previews.forEach((preview, index) => {
      if (
        preview.evidence !== undefined ||
        (preview.macro?.steps ?? []).some((step) => step.evidence !== undefined)
      ) {
        issue("A version-1 artifact stores no transition evidence.", ["tree", "previews", index]);
      }
    });
    return;
  }
  tree.edges.forEach((edge, index) => {
    if (edge.evidence === undefined || edge.sequence === undefined) {
      issue("A version-2 edge must store its evidence and transition sequence.", [
        "tree",
        "edges",
        index,
      ]);
    }
  });
  tree.events.forEach((event, index) => {
    if (event.evidence === undefined || event.sequence === undefined) {
      issue("A version-2 event must store its evidence and transition sequence.", [
        "tree",
        "events",
        index,
      ]);
    }
  });
  tree.commands.forEach((command, index) => {
    const { edge, event } = command.prepared;
    if (
      edge.evidence === undefined ||
      edge.sequence === undefined ||
      event.evidence === undefined ||
      event.sequence === undefined ||
      command.receipt.evidence === undefined ||
      command.receipt.sequence === undefined
    ) {
      issue("A version-2 command record must store its evidence and transition sequence.", [
        "tree",
        "commands",
        index,
      ]);
    }
  });
  tree.previews.forEach((preview, index) => {
    if (
      preview.evidence === undefined ||
      (preview.macro?.steps ?? []).some((step) => step.evidence === undefined)
    ) {
      issue("A version-2 preview must store its evidence.", ["tree", "previews", index]);
    }
  });
  const eventSequences = new Map(
    tree.events.map((event) => [event.edgeId as string, event.sequence]),
  );
  const bySequence = new Map<number, number>();
  const incoming = new Map<string, number | undefined>();
  tree.edges.forEach((edge) => incoming.set(edge.childNodeId, edge.sequence));
  tree.edges.forEach((edge, index) => {
    if (edge.sequence === undefined) return;
    if (bySequence.has(edge.sequence)) {
      issue("Transition sequences must be distinct.", ["tree", "edges", index, "sequence"]);
    }
    bySequence.set(edge.sequence, index);
    if (eventSequences.get(edge.id) !== edge.sequence) {
      issue("An edge and its event must store the same transition sequence.", [
        "tree",
        "edges",
        index,
        "sequence",
      ]);
    }
    const parentSequence = incoming.get(edge.parentNodeId);
    if (parentSequence !== undefined && parentSequence >= edge.sequence) {
      issue("A transition must be sequenced after the transition that produced its parent.", [
        "tree",
        "edges",
        index,
        "sequence",
      ]);
    }
  });
}

/**
 * Remove the stored transition evidence and sequence from a prepared command record: the shape a
 * version-1 artifact (and a record written before they were stored) has.
 */
export function withoutStoredTransitionEvidence(
  prepared: PrepareProofCommandSuccess,
): PrepareProofCommandSuccess {
  return {
    ...prepared,
    prepared: {
      ...prepared.prepared,
      edge: withoutEvidenceFields(prepared.prepared.edge),
      event: withoutEvidenceFields(prepared.prepared.event),
    },
    receipt: withoutEvidenceFields(prepared.receipt),
  };
}

/** The same for a preview and its macro steps. */
export function previewWithoutStoredEvidence(preview: MovePreview): MovePreview {
  const stripped = withoutEvidenceFields(preview);
  return preview.macro === undefined
    ? stripped
    : {
        ...stripped,
        macro: { steps: preview.macro.steps.map((step) => withoutEvidenceFields(step)) },
      };
}

/** Remove `evidence` and `sequence` from a stored edge, event or other record. */
export function withoutEvidenceFields<Value extends object>(record: Value): Value {
  const copy: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  delete copy.evidence;
  delete copy.sequence;
  return copy as Value;
}

function parseFailure(
  code: string,
  message: string,
  path: readonly (string | number)[],
): Readonly<{ ok: false; diagnostics: readonly [ProofArtifactDiagnostic] }> {
  return { ok: false, diagnostics: [{ code, message, path: [...path] }] };
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value) ?? "null") as JsonValue;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalArtifactJson(left) === canonicalArtifactJson(right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
