/**
 * Proof-artifact import (design plan §19, roadmap N27).
 *
 * An uploaded artifact is untrusted. `validateProofArtifact` revalidates it completely before
 * anything is written; the digest only detects accidental corruption, so an artifact whose digest
 * was recomputed after tampering is still rejected by the checks below:
 *
 * 1. the strict versioned schema, with every snapshot validated against the session operators;
 * 2. the digest over the uploaded content;
 * 3. identities and referential integrity: unique IDs, one rooted tree whose nodes are all
 *    reachable, every edge with exactly one command record and one transition event, and every
 *    reference (suggestion sets, previews, replay steps, interaction events, inquiry records) to a
 *    record in the artifact;
 * 4. displayed suggestion sets against their historical snapshot, and every preview re-prepared;
 * 5. every transition replayed through `prepareProofCommand` (the kernel's `applyTransition`) from
 *    its parent snapshot, reproducing the stored command record, child snapshot, edge and event;
 * 6. replay-step records, deletion tombstones, interaction events and inquiry commands (each
 *    re-prepared by `prepareInquiryCommand` against the earlier records);
 * 7. the library: background revisions replayed, every addition event re-run through the
 *    admission gate, and the final library recomputed; LLM call records against their schema;
 * 8. the derived final material (N17 solved status, pruned proof, sorry assumptions) and the
 *    translation dictionary, recomputed and compared.
 *
 * Imported IDs. The imported session keeps every record ID of the artifact and gets a new session
 * ID derived from the digest (`session:artifact:<first 32 hex digits>`). Storage keys are
 * `(session_id, id)`, so original IDs cannot collide with other sessions, and keeping them keeps
 * every stored snapshot, operation and reference byte-identical: remapping would rewrite the
 * static history the artifact documents. Only `ARTIFACT_SESSION_ID_FIELDS` are rebased. Importing
 * the same artifact again finds the same session (idempotent, `replayed: true`).
 *
 * The session and all its rows are inserted in one transaction, which marks the session read-only
 * as its last write; nothing is written when any check fails.
 */
import {
  admissionRecord,
  admitLibraryArtifact,
  applyBackgroundRevisions,
  libraryLayerSchema,
  type BackgroundProfile,
  type LibraryAdditionEvent,
  type LibraryArtifact,
} from "@proof/library";
import {
  PROOF_ARTIFACT_VERSION,
  canonicalArtifactJson,
  deriveArtifactFinalMaterial,
  deriveTranslationDictionary,
  inquiryRecordInputFields,
  parseProofArtifact,
  prepareInquiryCommand,
  prepareMovePreview,
  prepareProofCommand,
  proofArtifactDigestSchema,
  suggestionSetMatchesNode,
  withArtifactSessionId,
  type DisplayedSuggestionSet,
  type InquiryContextEdge,
  type InquiryRecord,
  type JsonObject,
  type JsonValue,
  type MovePreview,
  type ProofArtifact,
  type ProofEdge,
  type ProofArtifactDiagnostic,
  type ProofArtifactImportRecord,
  type ProofNode,
  type ProtocolEnvironment,
} from "@proof/protocol";
import type { MoveDefinition } from "@proof/moves";
import { runMovePlan, validateMoveTemplate } from "@proof/moves/authoring";
import {
  APPROVED_DEFINITIONS,
  type DefinitionCatalog,
  type MacroDefinition,
} from "./approved-catalog";
import { approvedAuthoredMacros, approvedAuthoredMoves } from "./move-authoring";
import { artifactDigest } from "./artifact-export";
import { storedLlmCallSchema } from "./llm-call-repository";
import {
  ProofStoreTransactionError,
  displayedMoveSelections,
  isReadOnlySessionRecord,
  proofSessionIdSchema,
  transactionFailure,
  type ProofSession,
  type ProofSessionId,
  type ProofStore,
  type RepositoryFailure,
} from "./proof-repository";

export type ValidatedProofArtifact = Readonly<{
  artifact: ProofArtifact;
  digest: string;
}>;

export type ValidateProofArtifactResult =
  | Readonly<{ ok: true; value: ValidatedProofArtifact }>
  | Readonly<{ ok: false; diagnostics: readonly [ProofArtifactDiagnostic] }>;

export type ImportProofArtifactResult =
  | Readonly<{
      status: "imported";
      sessionId: string;
      digest: string;
      sourceSessionId: string;
      replayed: boolean;
    }>
  /** Revalidation failed; nothing was written (HTTP 422). */
  | Readonly<{ status: "invalid"; diagnostics: readonly [ProofArtifactDiagnostic] }>
  /** The derived session ID holds another session (HTTP 409). */
  | Readonly<{ status: "conflict"; diagnostics: readonly [ProofArtifactDiagnostic] }>
  | Readonly<{ status: "failed"; failure: RepositoryFailure }>;

export type ImportProofArtifactOptions = Readonly<{
  definitions?: DefinitionCatalog;
  now?: () => Date;
}>;

/** The session ID an artifact with this digest is imported under. */
export function importedSessionId(digest: string): ProofSessionId {
  return proofSessionIdSchema.parse(
    `session:artifact:${digest.replace(/^sha256:/, "").slice(0, 32)}`,
  ) as ProofSessionId;
}

/** Revalidate an untrusted artifact completely; see the module comment for every check. */
export function validateProofArtifact(
  input: unknown,
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
): ValidateProofArtifactResult {
  try {
    // Version, then a well-formed digest over the content (accidental corruption), then every
    // section; a missing or malformed digest is a schema failure.
    const header = input as Readonly<{ artifactVersion?: unknown; digest?: unknown }>;
    if (
      typeof input === "object" &&
      input !== null &&
      !Array.isArray(input) &&
      header.artifactVersion === PROOF_ARTIFACT_VERSION &&
      proofArtifactDigestSchema.safeParse(header.digest).success &&
      artifactDigest(input) !== header.digest
    ) {
      return reject("digest-mismatch", "The artifact content does not match its digest.", [
        "digest",
      ]);
    }
    const parsed = parseProofArtifact(input);
    if (!parsed.ok) return parsed;
    const artifact = parsed.artifact;
    const digest = artifact.digest;
    const failure = new ArtifactValidator(artifact, definitions).validate();
    return failure === undefined
      ? { ok: true, value: { artifact, digest } }
      : { ok: false, diagnostics: [failure] };
  } catch (error: unknown) {
    if (error instanceof ArtifactRejection) return { ok: false, diagnostics: [error.diagnostic] };
    return reject("invalid-artifact", "The artifact could not be inspected safely.", []);
  }
}

/** Revalidate an artifact and store it as a new read-only session (or find its earlier import). */
export async function importProofArtifact(
  store: ProofStore,
  input: unknown,
  options: ImportProofArtifactOptions = {},
): Promise<ImportProofArtifactResult> {
  const validated = validateProofArtifact(input, options.definitions ?? APPROVED_DEFINITIONS);
  if (!validated.ok) return { status: "invalid", diagnostics: validated.diagnostics };
  const { artifact, digest } = validated.value;
  const sessionId = importedSessionId(digest);
  const importedAt = (options.now?.() ?? new Date()).toISOString();

  const attempt = async (): Promise<ImportProofArtifactResult> =>
    store.transaction(async (transaction) => {
      const existing = await transaction.lockSession(sessionId);
      if (existing !== undefined) {
        const record = await transaction.readArtifactImport(sessionId);
        const sameImport =
          isReadOnlySessionRecord(existing) &&
          typeof record === "object" &&
          record !== null &&
          (record as Readonly<{ digest?: unknown }>).digest === digest;
        return sameImport
          ? imported(sessionId, digest, artifact.sessionId, true)
          : {
              status: "conflict" as const,
              diagnostics: [
                {
                  code: "session-conflict",
                  message: `The session ${sessionId} already exists with other content.`,
                },
              ] as const,
            };
      }

      const rebased = withArtifactSessionId(artifact, sessionId);
      const { tree } = artifact;
      const session: ProofSession = {
        id: sessionId,
        rootNodeId: tree.rootNodeId,
        currentNodeId: tree.currentNodeId,
        operators: artifact.initialState.operators,
        ...(artifact.problemSetup.metadata === null
          ? {}
          : { metadata: artifact.problemSetup.metadata }),
      };
      await transaction.insertSession(session);
      for (const node of tree.nodes) await transaction.insertNode(sessionId, node);
      for (const set of tree.suggestionSets) {
        await transaction.insertSuggestionSet(sessionId, set);
      }
      for (const preview of tree.previews) await transaction.insertPreview(sessionId, preview);
      for (const command of tree.commands) await transaction.insertCommand(sessionId, command);
      for (const edge of tree.edges) await transaction.insertEdge(sessionId, edge);
      for (const event of tree.events) await transaction.insertEvent(sessionId, event);
      for (const step of tree.replaySteps) await transaction.insertReplayStep(sessionId, step);
      for (const deletion of tree.deletions) {
        await transaction.insertDeletion(sessionId, deletion);
      }
      for (const event of bySequence(artifact.interactionEvents)) {
        await transaction.insertInteractionEvent(sessionId, event);
      }
      for (const record of bySequence(artifact.inquiryRecords)) {
        await transaction.insertInquiryRecord(sessionId, record);
      }
      const record: ProofArtifactImportRecord = {
        sessionId,
        digest,
        sourceSessionId: artifact.sessionId,
        importedAt,
        library: toJson(rebased.library) as JsonObject,
        llmCalls: rebased.llmCalls,
      };
      await transaction.insertArtifactImport(record);
      if (!(await transaction.markSessionReadOnly(sessionId))) {
        throw new Error("The imported session could not be marked read-only.");
      }
      return imported(sessionId, digest, artifact.sessionId, false);
    });

  try {
    return await attempt();
  } catch (error: unknown) {
    // A concurrent import of the same artifact may have created the session first (PostgreSQL
    // does not lock an absent row); one retry then finds it. Whatever the retry commits or
    // finds is the answer.
    if (error instanceof ProofStoreTransactionError && error.outcome === "rolled-back") {
      try {
        return await attempt();
      } catch {
        // Report the original failure.
      }
    }
    return { status: "failed", failure: transactionFailure(error, "The import failed.") };
  }
}

function imported(
  sessionId: string,
  digest: string,
  sourceSessionId: string,
  replayed: boolean,
): ImportProofArtifactResult {
  return { status: "imported", sessionId, digest, sourceSessionId, replayed };
}

class ArtifactRejection extends Error {
  constructor(readonly diagnostic: ProofArtifactDiagnostic) {
    super(diagnostic.message);
    this.name = "ArtifactRejection";
  }
}

type Path = readonly (string | number)[];

function reject(
  code: string,
  message: string,
  path: Path,
): Readonly<{ ok: false; diagnostics: readonly [ProofArtifactDiagnostic] }> {
  return { ok: false, diagnostics: [{ code, message, path: [...path] }] };
}

function fail(code: string, message: string, path: Path): never {
  throw new ArtifactRejection({ code, message, path: [...path] });
}

/**
 * The authored moves an artifact's own library section approves: the latest approved `move`
 * review of each move in its admitted `move-discovery-draft` addition events, whose recorded
 * digest still describes the template and whose template passes `validateMoveTemplate` here.
 * Moves of the importing server's other sessions are never consulted.
 */
function artifactAuthoredMoves(
  artifact: ProofArtifact,
  base: DefinitionCatalog,
  operators: NonNullable<ProtocolEnvironment["operators"]>,
  results: NonNullable<ProtocolEnvironment["results"]>,
): Readonly<{ moves: readonly MoveDefinition[]; macros: readonly MacroDefinition[] }> {
  const admitted = artifact.library.additionEvents.flatMap((event) =>
    event.admission.decision === "admitted" &&
    event.layer === "move-discovery-draft" &&
    event.artifact.kind === "move"
      ? [event.artifact]
      : [],
  );
  const approvedTemplates = new Map<string, unknown>();
  for (const move of admitted) {
    const id = move.template["id"];
    if (typeof id === "string" && move.review?.decision === "approved") {
      approvedTemplates.set(id, move.template);
    }
  }
  const catalog = base.catalog(operators).results;
  const valid = (id: string) =>
    !base.moves.some((move) => move.id === id) &&
    validateMoveTemplate(approvedTemplates.get(id), {
      operators,
      results,
      artifactExists: (reference) =>
        reference.kind === "result" &&
        catalog.some(({ id: resultId }) => resultId === reference.id),
    }).ok;
  return {
    moves: approvedAuthoredMoves(admitted).filter((move) => valid(move.id)),
    // Macros are revalidated the same way; each applied macro is also re-run (checkMacros).
    macros: approvedAuthoredMacros(admitted).filter(({ move }) => valid(move.id)),
  };
}

/** Every revalidation step after the schema and the digest; throws `ArtifactRejection`. */
class ArtifactValidator {
  private readonly environment: ProtocolEnvironment;
  private readonly nodes = new Map<string, ProofNode>();
  private readonly suggestionSets = new Map<string, DisplayedSuggestionSet>();
  private readonly previews = new Map<string, MovePreview>();
  private readonly commandIds = new Set<string>();
  private readonly deletedNodeIds = new Set<string>();

  private readonly definitions: DefinitionCatalog;

  constructor(
    private readonly artifact: ProofArtifact,
    baseDefinitions: DefinitionCatalog,
  ) {
    this.definitions = baseDefinitions;
    const operators = artifact.initialState.operators;
    let results: ProtocolEnvironment["results"];
    try {
      results = baseDefinitions.catalog(operators).kernelResults;
    } catch {
      results = undefined;
    }
    if (results === undefined) {
      fail("invalid-artifact", "The approved results cannot be adapted to the session operators.", [
        "initialState",
        "operators",
      ]);
    }
    // The base catalog plus the authored moves approved in THIS artifact's own library section.
    const { moves: authored, macros } = artifactAuthoredMoves(
      artifact,
      baseDefinitions,
      operators,
      results,
    );
    if (authored.length > 0 || macros.length > 0) {
      this.definitions = Object.freeze({
        moves: [...baseDefinitions.moves, ...authored],
        ...(macros.length === 0 ? {} : { macros }),
        catalog: baseDefinitions.catalog,
      });
    }
    this.environment = {
      operators,
      results,
      ...(authored.length === 0 ? {} : { moves: authored }),
    };
  }

  validate(): ProofArtifactDiagnostic | undefined {
    try {
      this.checkTree();
      this.checkSuggestionSets();
      this.checkPreviews();
      this.checkTransitions();
      this.checkMacroApplications();
      this.checkReplaySteps();
      this.checkDeletions();
      this.checkInteractionEvents();
      this.checkInquiryRecords();
      this.checkLibrary();
      this.checkLlmCalls();
      this.checkDerived();
      return undefined;
    } catch (error: unknown) {
      if (error instanceof ArtifactRejection) return error.diagnostic;
      throw error;
    }
  }

  /** Unique IDs and states, and one rooted tree reaching every node and the cursor. */
  private checkTree(): void {
    const { tree } = this.artifact;
    const states = new Set<string>();
    tree.nodes.forEach((node, index) => {
      if (this.nodes.has(node.id) || states.has(node.state.id)) {
        fail("duplicate-id", `The node ${node.id} or its state is listed twice.`, [
          "tree",
          "nodes",
          index,
        ]);
      }
      this.nodes.set(node.id, node);
      states.add(node.state.id);
    });
    unique(tree.edges, (edge) => edge.id, ["tree", "edges"]);
    unique(tree.events, (event) => event.id, ["tree", "events"]);
    unique(tree.commands, (command) => command.prepared.command.commandId, ["tree", "commands"]);
    unique(tree.suggestionSets, (set) => set.id, ["tree", "suggestionSets"]);
    unique(tree.previews, (preview) => preview.id, ["tree", "previews"]);
    unique(tree.replaySteps, (step) => step.commandId, ["tree", "replaySteps"]);
    unique(tree.deletions, (deletion) => deletion.id, ["tree", "deletions"]);
    unique(tree.deletions, (deletion) => deletion.commandId, ["tree", "deletions"]);
    unique(this.artifact.interactionEvents, (event) => event.id, ["interactionEvents"]);
    unique(this.artifact.interactionEvents, (event) => String(event.sequence), [
      "interactionEvents",
    ]);
    unique(this.artifact.inquiryRecords, (record) => record.id, ["inquiryRecords"]);
    unique(this.artifact.inquiryRecords, (record) => String(record.sequence), ["inquiryRecords"]);
    tree.suggestionSets.forEach((set) => this.suggestionSets.set(set.id, set));
    tree.previews.forEach((preview) => this.previews.set(preview.id, preview));
    tree.commands.forEach((command) => this.commandIds.add(command.prepared.command.commandId));

    this.requireNode(tree.rootNodeId, ["tree", "rootNodeId"]);
    this.requireNode(tree.currentNodeId, ["tree", "currentNodeId"]);
    const children = new Set<string>();
    const byParent = new Map<string, string[]>();
    tree.edges.forEach((edge, index) => {
      this.requireNode(edge.parentNodeId, ["tree", "edges", index, "parentNodeId"]);
      this.requireNode(edge.childNodeId, ["tree", "edges", index, "childNodeId"]);
      if (edge.childNodeId === tree.rootNodeId || children.has(edge.childNodeId)) {
        fail("invalid-tree", `The node ${edge.childNodeId} has more than one parent.`, [
          "tree",
          "edges",
          index,
        ]);
      }
      children.add(edge.childNodeId);
      byParent.set(edge.parentNodeId, [
        ...(byParent.get(edge.parentNodeId) ?? []),
        edge.childNodeId,
      ]);
    });
    const reached = new Set<string>([tree.rootNodeId]);
    const queue = [tree.rootNodeId as string];
    for (let index = 0; index < queue.length; index += 1) {
      for (const child of byParent.get(queue[index] as string) ?? []) {
        if (!reached.has(child)) {
          reached.add(child);
          queue.push(child);
        }
      }
    }
    if (reached.size !== this.nodes.size) {
      fail("invalid-tree", "Some nodes are not reachable from the root.", ["tree", "nodes"]);
    }
  }

  private checkSuggestionSets(): void {
    this.artifact.tree.suggestionSets.forEach((set, index) => {
      const path = ["tree", "suggestionSets", index];
      const node = this.requireNode(set.nodeId, [...path, "nodeId"]);
      if (set.stateId !== node.state.id || !suggestionSetMatchesNode(set, node, this.environment)) {
        fail(
          "suggestion-set-mismatch",
          `The suggestion set ${set.id} does not match its historical snapshot.`,
          path,
        );
      }
    });
  }

  private checkPreviews(): void {
    this.artifact.tree.previews.forEach((preview, index) => {
      const path = ["tree", "previews", index];
      const node = this.requireNode(preview.nodeId, [...path, "nodeId"]);
      const set = this.requireSuggestionSet(preview.suggestionSetId, [...path, "suggestionSetId"]);
      if (set.nodeId !== node.id) {
        fail("dangling-reference", `The preview ${preview.id} names another node's set.`, path);
      }
      const prepared = prepareMovePreview(
        node,
        set,
        {
          id: preview.id,
          suggestionSetId: preview.suggestionSetId,
          chosenSuggestionId: preview.chosenSuggestionId,
          moveId: preview.moveId,
          operation: preview.operation,
          ...(preview.menuSelection === undefined ? {} : { menuSelection: preview.menuSelection }),
          ...(preview.definitions === undefined ? {} : { definitions: preview.definitions }),
          ...(preview.macro === undefined
            ? {}
            : {
                macro: {
                  steps: preview.macro.steps.map(({ id, moveId, operation }) => ({
                    id,
                    moveId,
                    operation,
                  })),
                },
              }),
        },
        this.environment,
      );
      if (!prepared.ok || !sameJson(prepared.preview, preview)) {
        fail(
          "preview-not-reproduced",
          `The preview ${preview.id} is not reproduced from its snapshot: ${
            prepared.ok ? "the stored preview differs" : prepared.diagnostics[0].message
          }`,
          path,
        );
      }
    });
  }

  /** Replay every transition through the kernel from its stored parent snapshot. */
  private checkTransitions(): void {
    const { tree } = this.artifact;
    const commands = new Map(
      tree.commands.map((command) => [command.prepared.command.commandId as string, command]),
    );
    const events = new Map(tree.events.map((event) => [event.edgeId as string, event]));
    if (tree.commands.length !== tree.edges.length || tree.events.length !== tree.edges.length) {
      fail(
        "dangling-reference",
        "Every edge needs exactly one command record and one transition event.",
        ["tree", "edges"],
      );
    }
    tree.edges.forEach((edge, index) => {
      const path = ["tree", "edges", index];
      const command = commands.get(edge.commandId);
      const event = events.get(edge.id);
      if (command === undefined || event === undefined) {
        fail(
          "dangling-reference",
          `The edge ${edge.id} has no command record or transition event.`,
          path,
        );
      }
      const parent = this.requireNode(edge.parentNodeId, [...path, "parentNodeId"]);
      const child = this.requireNode(edge.childNodeId, [...path, "childNodeId"]);
      const stored = command.prepared.command;
      const suggestionSet =
        stored.suggestionSetId === undefined
          ? undefined
          : this.requireSuggestionSet(stored.suggestionSetId, [...path, "suggestionSetId"]);
      const preview =
        stored.previewId === undefined
          ? undefined
          : this.requirePreview(stored.previewId, [...path, "previewId"]);
      const replayed = prepareProofCommand(parent, stored, {
        trustedActor: stored.actor,
        ...(this.environment.operators === undefined
          ? {}
          : { operators: this.environment.operators }),
        ...(this.environment.results === undefined ? {} : { results: this.environment.results }),
        ...(this.environment.moves === undefined ? {} : { moves: this.environment.moves }),
        ...(suggestionSet === undefined ? {} : { suggestionSet }),
        ...(preview === undefined ? {} : { preview }),
      });
      if (!replayed.ok) {
        fail(
          "transition-not-reproduced",
          `The kernel rejects the transition of edge ${edge.id}: ${replayed.diagnostics[0].message}`,
          path,
        );
      }
      if (
        !sameJson(replayed, command) ||
        !sameJson(replayed.prepared.edge, edge) ||
        !sameJson(replayed.prepared.event, event) ||
        !sameJson(replayed.prepared.node, child)
      ) {
        fail(
          "transition-not-reproduced",
          `Replaying edge ${edge.id} from its parent snapshot does not reproduce the stored child, edge, event and command record.`,
          path,
        );
      }
    });
  }

  /**
   * Every macro application (edges sharing a macro link) is re-run with the artifact's own
   * approved macro: the steps must be consecutive, name the template's primitives, and carry
   * exactly the operations the template produces from the first step's displayed selections.
   */
  private checkMacroApplications(): void {
    const { tree } = this.artifact;
    const applications = new Map<string, { edge: ProofEdge; index: number }[]>();
    tree.edges.forEach((edge, index) => {
      if (edge.macro === undefined) return;
      const steps = applications.get(edge.macro.previewId) ?? [];
      steps.push({ edge, index });
      applications.set(edge.macro.previewId, steps);
    });
    for (const [previewId, entries] of applications) {
      const steps = [...entries].sort((a, b) => a.edge.macro!.stepIndex - b.edge.macro!.stepIndex);
      const path = ["tree", "edges", steps[0]?.index ?? 0];
      const first = steps[0]?.edge;
      const link = first?.macro;
      if (first === undefined || link === undefined) continue;
      const macro = this.definitions.macros?.find(({ move }) => move.id === link.moveId);
      if (macro === undefined) {
        fail(
          "macro-not-approved",
          `The edge ${first.id} applies the macro ${link.moveId}, which the artifact does not approve.`,
          path,
        );
      }
      const plan = macro.template.plan.steps;
      const baseCommandId = first.commandId.replace(/:macro:1$/, "");
      if (
        steps.length !== plan.length ||
        steps.some(
          ({ edge }, position) =>
            edge.macro?.moveId !== link.moveId ||
            edge.macro.stepIndex !== position + 1 ||
            edge.macro.stepCount !== plan.length ||
            edge.macro.stepId !== plan[position]?.id ||
            edge.moveId !== plan[position]?.moveId ||
            edge.commandId !== `${baseCommandId}:macro:${position + 1}` ||
            (position > 0 && edge.parentNodeId !== steps[position - 1]?.edge.childNodeId),
        )
      ) {
        fail(
          "macro-application-invalid",
          `The steps of macro ${link.moveId} do not form one complete, consecutive application.`,
          path,
        );
      }
      const preview = this.requirePreview(previewId, path);
      const parent = this.requireNode(first.parentNodeId, [...path, "parentNodeId"]);
      const last = this.requireNode(steps.at(-1)!.edge.childNodeId, path);
      const set = this.requireSuggestionSet(preview.suggestionSetId, path);
      const chosen = set.suggestions.find(({ id }) => id === preview.chosenSuggestionId);
      const selections = chosen === undefined ? undefined : displayedMoveSelections(set, chosen);
      const run =
        selections === undefined
          ? undefined
          : runMovePlan(
              macro.template,
              parent.state,
              selections,
              preview.menuSelection?.choices ?? {},
              this.environment,
              baseCommandId,
            );
      if (
        run === undefined ||
        !run.ok ||
        preview.moveId !== link.moveId ||
        preview.nodeId !== parent.id ||
        !sameJson(
          run.operations,
          steps.map(({ edge }) => edge.operation),
        ) ||
        !sameJson(run.state, last.state) ||
        !sameJson(run.state, preview.afterState)
      ) {
        fail(
          "macro-not-reproduced",
          `Re-running the approved macro ${link.moveId} does not reproduce its recorded steps.`,
          path,
        );
      }
    }
  }

  private checkReplaySteps(): void {
    const { tree } = this.artifact;
    const resultNodes = new Map(
      tree.commands.map((command) => [
        command.prepared.command.commandId as string,
        command.prepared.node.id as string,
      ]),
    );
    unique(tree.replaySteps, (step) => `${step.replayCommandId}\u0000${step.index}`, [
      "tree",
      "replaySteps",
    ]);
    tree.replaySteps.forEach((step, index) => {
      const path = ["tree", "replaySteps", index];
      if (resultNodes.get(step.commandId) !== step.nodeId) {
        fail(
          "dangling-reference",
          `The replay step ${step.commandId} does not name its command's result node.`,
          path,
        );
      }
      this.requireNode(step.targetNodeId, [...path, "targetNodeId"]);
    });
  }

  /** ID-only tombstones: the deleted identities never reappear among the live records. */
  private checkDeletions(): void {
    const { tree } = this.artifact;
    const liveEdges = new Set(tree.edges.map(({ id }) => id as string));
    const liveEvents = new Set(tree.events.map(({ id }) => id as string));
    tree.deletions.forEach((deletion, index) => {
      const path = ["tree", "deletions", index];
      const revived =
        deletion.deletedNodeIds.some((id) => this.nodes.has(id)) ||
        deletion.deletedEdgeIds.some((id) => liveEdges.has(id)) ||
        deletion.deletedEventIds.some((id) => liveEvents.has(id)) ||
        deletion.deletedCommandIds.some((id) => this.commandIds.has(id)) ||
        this.commandIds.has(deletion.commandId);
      if (revived) {
        fail(
          "deletion-invalid",
          `The tombstone ${deletion.id} names a record that is still live.`,
          path,
        );
      }
      deletion.deletedNodeIds.forEach((id) => this.deletedNodeIds.add(id));
    });
  }

  private checkInteractionEvents(): void {
    this.artifact.interactionEvents.forEach((event, index) => {
      const path = ["interactionEvents", index];
      const node = this.requireNode(event.nodeId, [...path, "nodeId"]);
      if (event.stateId !== node.state.id) {
        fail(
          "interaction-event-invalid",
          `The interaction event ${event.id} is anchored at another snapshot.`,
          path,
        );
      }
    });
  }

  /** Re-prepare every inquiry command (each run of consecutive sequences) from earlier records. */
  private checkInquiryRecords(): void {
    const records = bySequence(this.artifact.inquiryRecords);
    const earlier = new Map<string, InquiryRecord>();
    const edges = new Map<string, InquiryContextEdge>(
      this.artifact.tree.edges.map((edge) => [edge.childNodeId as string, edge]),
    );
    const results = new Set<string>(
      this.definitions.catalog(this.artifact.initialState.operators).results.map(({ id }) => id),
    );
    const methods = {
      moves: new Set<string>(this.definitions.moves.map(({ id }) => id)),
      results,
    };
    for (let start = 0; start < records.length;) {
      const first = records[start] as InquiryRecord;
      let end = start + 1;
      while (
        end < records.length &&
        records[end]?.commandId === first.commandId &&
        records[end]?.sequence === (records[end - 1]?.sequence ?? 0) + 1
      ) {
        end += 1;
      }
      const run = records.slice(start, end);
      const index = this.artifact.inquiryRecords.indexOf(first);
      const path = ["inquiryRecords", index];
      if (run.some((record) => record.nodeId !== first.nodeId)) {
        fail("inquiry-record-invalid", "An inquiry command has one anchor node.", path);
      }
      const prepared = prepareInquiryCommand(
        {
          commandId: first.commandId,
          nodeId: first.nodeId,
          records: run.map((record) => inquiryRecordInputFields(record)),
        },
        {
          actor: first.actor,
          nodes: this.nodes,
          records: earlier,
          suggestionSets: this.suggestionSets,
          edges,
          methods,
        },
        { firstSequence: first.sequence, recordedAt: first.recordedAt },
      );
      if (!prepared.ok) {
        fail(
          "inquiry-record-invalid",
          `The inquiry command ${first.commandId} does not revalidate: ${prepared.diagnostics[0].message}`,
          path,
        );
      }
      if (!sameJson(prepared.records, run)) {
        fail(
          "inquiry-record-invalid",
          `The inquiry command ${first.commandId} is not reproduced from its stored inputs.`,
          path,
        );
      }
      run.forEach((record) => earlier.set(record.id, record));
      start = end;
    }
  }

  /** Revisions, the admission gate over every addition event, and the final library. */
  private checkLibrary(): void {
    const { library, sessionId } = this.artifact;
    const metadata = this.artifact.problemSetup.metadata;
    const environment = { operators: library.operators };
    library.additionEvents.forEach((event, index) => {
      if (event.sequence !== index) {
        fail("library-invalid", "Addition events must be listed in sequence order from 0.", [
          "library",
          "additionEvents",
          index,
        ]);
      }
    });
    unique(library.additionEvents, (event) => event.id, ["library", "additionEvents"]);
    library.backgroundRevisions.forEach((revision, index) => {
      if (revision.sequence !== index) {
        fail("library-invalid", "Background revisions must be in sequence order from 0.", [
          "library",
          "backgroundRevisions",
          index,
        ]);
      }
    });
    const revisions = library.backgroundRevisions;
    const initialProfile: BackgroundProfile | undefined =
      revisions[0]?.previous ?? metadata?.background;
    if (revisions.length > 0) {
      const replayed =
        initialProfile === undefined
          ? undefined
          : applyBackgroundRevisions(initialProfile, revisions, sessionId);
      if (
        metadata === null ||
        replayed === undefined ||
        !replayed.ok ||
        !sameJson(replayed.profile, metadata.background)
      ) {
        fail(
          "library-invalid",
          "The background revisions do not lead to the session's background profile.",
          ["library", "backgroundRevisions"],
        );
      }
    }

    const knownNodeIds = new Set<string>([...this.nodes.keys()]);
    let prefix = 0;
    const admitted: { artifact: LibraryArtifact; sequence: number }[] = [];
    library.additionEvents.forEach((event, index) => {
      const path = ["library", "additionEvents", index];
      const found = this.admissionPrefix(event, initialProfile, prefix, knownNodeIds);
      if (found === undefined) {
        fail(
          "library-admission-mismatch",
          `The admission gate does not reproduce the recorded decision of ${event.id}.`,
          path,
        );
      }
      prefix = found;
      if (event.admission.decision === "admitted") {
        if (admitted.some(({ artifact }) => artifact.id === event.artifact.id)) {
          fail("library-invalid", `The artifact ${event.artifact.id} is admitted twice.`, path);
        }
        admitted.push({ artifact: event.artifact, sequence: event.sequence });
      }
    });

    const globals = library.finalLibrary.filter(({ layer }) => layer === "global");
    const sessionPart = library.finalLibrary.filter(({ layer }) => layer !== "global");
    if (!sameJson(library.finalLibrary, [...globals, ...sessionPart])) {
      fail("final-library-mismatch", "Global artifacts are listed before session layers.", [
        "library",
        "finalLibrary",
      ]);
    }
    const expected = admitted
      .sort(
        (left, right) =>
          layerRank(left.artifact.layer) - layerRank(right.artifact.layer) ||
          left.sequence - right.sequence ||
          compareStrings(left.artifact.id, right.artifact.id),
      )
      .map(({ artifact }) => artifact);
    if (!sameJson(sessionPart, expected)) {
      fail(
        "final-library-mismatch",
        "The session's final library differs from the admitted addition events.",
        ["library", "finalLibrary"],
      );
    }
    const ids = new Set(expected.map(({ id }) => id as string));
    globals.forEach((artifact) => {
      const index = library.finalLibrary.indexOf(artifact);
      const gate = admitLibraryArtifact({ artifact, layer: "global", environment });
      if (!gate.ok || ids.has(artifact.id)) {
        fail(
          "library-admission-mismatch",
          `The global artifact ${artifact.id} is not admissible.`,
          ["library", "finalLibrary", index],
        );
      }
      ids.add(artifact.id);
    });
  }

  /**
   * The smallest revision prefix under which the gate reproduces the event's recorded admission.
   * Additions and revisions have no common sequence, so the prefix (the revisions recorded before
   * the addition) is constrained by what is recorded: it never decreases from one addition to the
   * next, it includes every revision that occurred strictly before the addition, and it excludes
   * every revision that occurred strictly after it.
   */
  private admissionPrefix(
    event: LibraryAdditionEvent,
    initialProfile: BackgroundProfile | undefined,
    from: number,
    knownNodeIds: ReadonlySet<string>,
  ): number | undefined {
    const { library, sessionId } = this.artifact;
    const provenance = event.artifact.provenance;
    const derivedNode =
      provenance.kind === "derived" && provenance.sessionId === sessionId
        ? provenance.proofNodeId
        : undefined;
    // A derived node deleted later may or may not have existed when the event was recorded.
    const nodeChoices: (readonly string[])[] =
      derivedNode === undefined
        ? [[]]
        : knownNodeIds.has(derivedNode)
          ? [[derivedNode]]
          : this.deletedNodeIds.has(derivedNode)
            ? [[derivedNode], []]
            : [[]];
    const at = Date.parse(event.occurredAt);
    const revisionTimes = library.backgroundRevisions.map(({ occurredAt }) =>
      Date.parse(occurredAt),
    );
    const before = revisionTimes.filter((time) => time < at).length;
    const notAfter = revisionTimes.filter((time) => time <= at).length;
    for (let prefix = Math.max(from, before); prefix <= notAfter; prefix += 1) {
      for (const proofNodeIds of nodeChoices) {
        const gate = admitLibraryArtifact({
          artifact: event.artifact,
          layer: event.layer,
          sessionId,
          profile: initialProfile,
          revisions: library.backgroundRevisions.slice(0, prefix),
          proofNodeIds,
          environment: { operators: library.operators },
        });
        if (sameJson(admissionRecord(gate), event.admission)) return prefix;
      }
    }
    return undefined;
  }

  private checkLlmCalls(): void {
    this.artifact.llmCalls.forEach((call, index) => {
      const parsed = storedLlmCallSchema.safeParse(call);
      if (
        !parsed.success ||
        parsed.data.owner.kind !== "proof-session" ||
        parsed.data.owner.id !== this.artifact.sessionId
      ) {
        fail("llm-call-invalid", "An LLM call record is invalid or belongs elsewhere.", [
          "llmCalls",
          index,
        ]);
      }
    });
    unique(this.artifact.llmCalls, (call) => String(call.id), ["llmCalls"]);
  }

  private checkDerived(): void {
    const { tree } = this.artifact;
    const final = deriveArtifactFinalMaterial({
      rootNodeId: tree.rootNodeId,
      nodes: tree.nodes,
      edges: tree.edges,
    });
    if (!sameJson(final, this.artifact.final)) {
      fail(
        "final-material-mismatch",
        "The solved status, pruned proof or sorry assumptions differ from the stored tree's.",
        ["final"],
      );
    }
    const dictionary = deriveTranslationDictionary(this.artifact.initialState.operators);
    if (!sameJson(dictionary, this.artifact.translationDictionary)) {
      fail(
        "translation-dictionary-mismatch",
        "The translation dictionary differs from the session operators' presentation metadata.",
        ["translationDictionary"],
      );
    }
  }

  private requireNode(nodeId: string, path: Path): ProofNode {
    const node = this.nodes.get(nodeId);
    if (node === undefined) {
      fail("dangling-reference", `The node ${nodeId} is not in the artifact.`, path);
    }
    return node;
  }

  private requireSuggestionSet(id: string, path: Path): DisplayedSuggestionSet {
    const set = this.suggestionSets.get(id);
    if (set === undefined) {
      fail("dangling-reference", `The suggestion set ${id} is not in the artifact.`, path);
    }
    return set;
  }

  private requirePreview(id: string, path: Path): MovePreview {
    const preview = this.previews.get(id);
    if (preview === undefined) {
      fail("dangling-reference", `The preview ${id} is not in the artifact.`, path);
    }
    return preview;
  }
}

function unique<Item>(items: readonly Item[], keyOf: (item: Item) => string, path: Path): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const key = keyOf(item);
    if (seen.has(key)) fail("duplicate-id", `The ID ${key} is listed twice.`, [...path, index]);
    seen.add(key);
  });
}

function bySequence<Item extends Readonly<{ sequence: number }>>(items: readonly Item[]): Item[] {
  return [...items].sort((left, right) => left.sequence - right.sequence);
}

function layerRank(layer: string): number {
  return libraryLayerSchema.options.indexOf(layer as (typeof libraryLayerSchema.options)[number]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value) ?? "null") as JsonValue;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalArtifactJson(toJson(left)) === canonicalArtifactJson(toJson(right));
}
