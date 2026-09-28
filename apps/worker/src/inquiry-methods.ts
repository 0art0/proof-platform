/**
 * Worker wiring of the method-created inquiry records (refinement §3.4, §6, §10; roadmap N24).
 * The pure protocol derivations in `inquiry-methods.ts` turn a stored action into one inquiry
 * command; this module loads the stored data they need and records the command through the single
 * inquiry command path (`recordInquiryCommandWithin` → `prepareInquiryCommand`).
 *
 * - "Try this theorem" executes the proof command and records its inquiry command in the same
 *   transaction: either both are recorded or neither is.
 * - "Investigate this hypothesis" records its command alone; it changes no proof state.
 * - "Extract a conditional lemma" is a minimal hook into N12: it checks the stored tree, extracts
 *   the derived result with `extractDerivedResult`, adds it to the session's derived layer as a
 *   draft through `addLibraryArtifact`, and then records the inquiry command. The library store is
 *   separate, so the two writes are linked by IDs rather than atomic; both are idempotent, so a
 *   retry with the same request completes an interrupted extraction.
 *
 * Each method derives its command from the inquiry records recorded before it, so a retry derives
 * and replays exactly the stored command.
 */
import {
  backgroundClassificationSchema,
  deterministicRenderingsSchema,
  extractDerivedResult,
  libraryAdditionEventIdSchema,
  type LibraryAdditionEvent,
  type LibraryResult,
} from "@proof/library";
import {
  actorSchema,
  commandIdSchema,
  deriveConditionalLemmaInquiry,
  deriveHypothesisInvestigation,
  deriveTryResultInquiry,
  planConditionalLemma,
  proofNodeIdSchema,
  stableIdentifierSchema,
  tryResultInquiryCommandId,
  type Actor,
  type DeriveInquiryCommandResult,
  type InquiryRecord,
  type PrepareProofCommandSuccess,
  type ProofNode,
} from "@proof/protocol";
import { z } from "zod";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "./approved-catalog";
import {
  inquiryRecordsBefore,
  recordInquiryCommand,
  recordInquiryCommandWithin,
} from "./inquiry-repository";
import {
  addLibraryArtifact,
  type LibraryRepositoryFailure,
  type LibraryStore,
} from "./library-repository";
import {
  ProofStoreTransactionError,
  executeProofCommandWithin,
  loadNode,
  loadProofHistory,
  loadSession,
  loadSuggestionSet,
  proofSessionIdSchema,
  repositoryFailure,
  safeParse,
  transactionFailure,
  type ProofSessionId,
  type ProofStore,
  type ProofStoreTransaction,
  type RepositoryFailure,
} from "./proof-repository";

export type InquiryMethodOptions = Readonly<{
  definitions?: DefinitionCatalog;
  now?: () => Date;
}>;

const targetSchema = z
  .object({ kind: z.enum(["goal", "obligation"]), id: stableIdentifierSchema })
  .strict();

// ---------------------------------------------------------------------------------------------
// Try this theorem
// ---------------------------------------------------------------------------------------------

export type TryResultCommandResult =
  | Readonly<{
      status: "committed";
      result: PrepareProofCommandSuccess;
      /** The "Try this theorem" inquiry records, recorded with the transition. */
      records: readonly InquiryRecord[];
      replayed: boolean;
    }>
  | RepositoryFailure;

/**
 * Apply a displayed result suggestion as "Try this theorem": execute the proof command and record
 * its attempt, missing-premise objectives and unmet-condition obstructions atomically. The
 * inquiry command ID is `tryResultInquiryCommandId(commandId)`.
 */
export async function executeTryResultCommand(
  store: ProofStore,
  sessionIdInput: unknown,
  commandInput: unknown,
  trustedActorInput: unknown,
  options: InquiryMethodOptions = {},
): Promise<TryResultCommandResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const actor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || actor === undefined) {
    return repositoryFailure(
      "rejected",
      "command-rejected",
      "The session ID or trusted actor is invalid.",
    );
  }
  const definitions = options.definitions ?? APPROVED_DEFINITIONS;
  try {
    return await store.transaction(async (transaction) => {
      const executed = await executeProofCommandWithin(
        transaction,
        sessionId,
        commandInput,
        actor,
        definitions,
      );
      if (executed.status !== "committed") return executed;
      const { parent, node, edge, command } = executed.result.prepared;
      if (edge.suggestionSetId === undefined) {
        return abort(
          repositoryFailure(
            "rejected",
            "inquiry-command-rejected",
            "Try this theorem needs a transition chosen from a displayed result suggestion.",
          ),
        );
      }
      const loadedSession = await loadSession(transaction, sessionId, definitions);
      if (!loadedSession.ok) return abort(loadedSession.failure);
      const suggestionSet = await loadSuggestionSet(
        transaction,
        loadedSession.session,
        edge.suggestionSetId,
      );
      if (!suggestionSet.ok) return abort(suggestionSet.failure);
      const inquiryCommandId = tryResultInquiryCommandId(command.commandId);
      const records = await priorRecords(transaction, loadedSession.session, inquiryCommandId);
      const recorded = await recordDerived(
        transaction,
        sessionId,
        deriveTryResultInquiry({
          commandId: inquiryCommandId,
          parent,
          child: node,
          edge,
          suggestionSet: suggestionSet.suggestionSet,
          records,
        }),
        actor,
        options,
      );
      return {
        status: "committed" as const,
        result: executed.result,
        records: recorded,
        replayed: executed.replayed,
      };
    });
  } catch (error: unknown) {
    return methodFailure(error, "The Try this theorem command could not be recorded.");
  }
}

// ---------------------------------------------------------------------------------------------
// Investigate this hypothesis
// ---------------------------------------------------------------------------------------------

export const hypothesisInvestigationRequestSchema = z
  .object({
    commandId: commandIdSchema,
    nodeId: proofNodeIdSchema,
    target: targetSchema,
    hypothesisId: stableIdentifierSchema,
  })
  .strict();
export type HypothesisInvestigationRequest = z.infer<typeof hypothesisInvestigationRequestSchema>;

export type InquiryMethodRecordResult =
  | Readonly<{ status: "committed"; records: readonly InquiryRecord[]; replayed: boolean }>
  | RepositoryFailure;

/** Record "Investigate this hypothesis": Determine the target without that hypothesis. */
export async function investigateHypothesis(
  store: ProofStore,
  sessionIdInput: unknown,
  requestInput: unknown,
  trustedActorInput: unknown,
  options: InquiryMethodOptions = {},
): Promise<InquiryMethodRecordResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const request = safeParse(hypothesisInvestigationRequestSchema, requestInput);
  const actor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || request === undefined || actor === undefined) {
    return repositoryFailure(
      "rejected",
      "inquiry-command-rejected",
      "The session ID, hypothesis investigation, or trusted actor is invalid.",
    );
  }
  const definitions = options.definitions ?? APPROVED_DEFINITIONS;
  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId, definitions);
      if (!loadedSession.ok) return loadedSession.failure;
      const loadedNode = await loadNode(
        transaction,
        loadedSession.session,
        loadedSession.environment,
        request.nodeId as ProofNode["id"],
        "inquiry-command-rejected",
        "invalid-current-node",
      );
      if (!loadedNode.ok) return loadedNode.failure;
      const stored = await priorRecords(transaction, loadedSession.session, request.commandId);
      const derived = deriveHypothesisInvestigation({
        commandId: request.commandId,
        node: loadedNode.node,
        target: request.target,
        hypothesisId: request.hypothesisId,
        records: stored,
      });
      if (!derived.ok) {
        return repositoryFailure(
          "rejected",
          "inquiry-command-rejected",
          derived.diagnostics[0].message,
        );
      }
      return await recordInquiryCommandWithin(
        transaction,
        sessionId,
        derived.request,
        actor,
        options,
      );
    });
  } catch (error: unknown) {
    return methodFailure(error, "The hypothesis investigation could not be recorded.");
  }
}

// ---------------------------------------------------------------------------------------------
// Extract a conditional lemma (minimal N12 hook)
// ---------------------------------------------------------------------------------------------

export const conditionalLemmaRequestSchema = z
  .object({
    /** The inquiry command recording the extraction. */
    commandId: commandIdSchema,
    /** The N12 library-addition event adding the derived result. */
    additionEventId: libraryAdditionEventIdSchema,
    occurredAt: z.string().datetime({ offset: true }),
    nodeId: proofNodeIdSchema,
    target: targetSchema,
    lemma: z
      .object({
        id: stableIdentifierSchema,
        name: z.string().min(1).max(200),
        classification: backgroundClassificationSchema,
        renderings: deterministicRenderingsSchema,
      })
      .strict(),
  })
  .strict();
export type ConditionalLemmaRequest = z.infer<typeof conditionalLemmaRequestSchema>;

export type ExtractConditionalLemmaResult =
  | Readonly<{
      status: "committed";
      /** The derived result, added to the session's derived layer as a draft. */
      lemma: LibraryResult;
      event: LibraryAdditionEvent;
      records: readonly InquiryRecord[];
      replayed: boolean;
    }>
  | RepositoryFailure
  | LibraryRepositoryFailure;

/**
 * Extract a target closed in the stored subtree below its node as a conditional lemma retaining
 * every hypothesis of its context, add it to the session's derived library layer (N12) as a
 * draft, and record the inquiry observation naming it.
 */
export async function extractConditionalLemma(
  store: ProofStore,
  libraryStore: LibraryStore,
  sessionIdInput: unknown,
  requestInput: unknown,
  trustedActorInput: unknown,
  options: InquiryMethodOptions = {},
): Promise<ExtractConditionalLemmaResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const request = safeParse(conditionalLemmaRequestSchema, requestInput);
  const actor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || request === undefined || actor === undefined) {
    return repositoryFailure(
      "rejected",
      "inquiry-command-rejected",
      "The session ID, conditional-lemma request, or trusted actor is invalid.",
    );
  }
  const history = await loadProofHistory(store, sessionId);
  if (history.status !== "loaded") return history;
  const planned = planConditionalLemma({
    nodes: history.nodes,
    edges: history.edges.map(({ edge }) => edge),
    nodeId: request.nodeId,
    target: request.target,
  });
  if (!planned.ok) {
    return repositoryFailure(
      "rejected",
      "inquiry-command-rejected",
      planned.diagnostics[0].message,
    );
  }
  const extraction = extractDerivedResult({
    sessionId,
    proofNodeId: request.nodeId,
    id: request.lemma.id,
    name: request.lemma.name,
    context: planned.plan.context,
    conclusion: planned.plan.conclusion,
    usedHypothesisIds: planned.plan.retainedHypothesisIds,
    classification: request.lemma.classification,
    renderings: request.lemma.renderings,
    approval: { status: "draft" },
    operators: history.session.operators,
  });
  if (!extraction.ok) {
    return repositoryFailure(
      "rejected",
      "inquiry-command-rejected",
      extraction.diagnostics[0].message,
    );
  }
  const added = await addLibraryArtifact(libraryStore, {
    id: request.additionEventId,
    sessionId,
    occurredAt: request.occurredAt,
    layer: "derived",
    origin: { kind: "derived", actorId: actor.id },
    artifact: extraction.result,
  });
  if (added.status !== "recorded") return added;
  if (!added.admitted) {
    return repositoryFailure(
      "rejected",
      "inquiry-command-rejected",
      `The derived result was not admitted: ${
        added.event.admission.diagnostics[0]?.message ?? "the admission gate rejected it"
      }`,
    );
  }
  const derived = deriveConditionalLemmaInquiry({
    commandId: request.commandId,
    plan: planned.plan,
    lemmaId: extraction.result.id,
  });
  if (!derived.ok) {
    return repositoryFailure(
      "rejected",
      "inquiry-command-rejected",
      derived.diagnostics[0].message,
    );
  }
  const recorded = await recordInquiryCommand(store, sessionId, derived.request, actor, options);
  if (recorded.status !== "committed") return recorded;
  return {
    status: "committed",
    lemma: extraction.result,
    event: added.event,
    records: recorded.records,
    replayed: recorded.replayed,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** A failure that must roll back what the transaction already wrote. */
class MethodAbort extends Error {
  constructor(readonly failure: RepositoryFailure) {
    super(failure.diagnostics[0].message);
    this.name = "MethodAbort";
  }
}

function abort(failure: RepositoryFailure): never {
  throw new MethodAbort(failure);
}

function methodFailure(error: unknown, fallbackMessage: string): RepositoryFailure {
  if (error instanceof ProofStoreTransactionError && error.cause instanceof MethodAbort) {
    return error.cause.failure;
  }
  return transactionFailure(error, fallbackMessage);
}

async function priorRecords(
  transaction: ProofStoreTransaction,
  session: Parameters<typeof inquiryRecordsBefore>[1],
  commandId: string,
): Promise<readonly InquiryRecord[]> {
  const records = await inquiryRecordsBefore(transaction, session, commandId);
  if (records === undefined) {
    return abort(
      repositoryFailure(
        "rejected",
        "invalid-inquiry-record",
        "A stored inquiry record failed runtime validation or identity checks.",
      ),
    );
  }
  return records;
}

/** Record a derived command inside the transaction; any rejection rolls the transaction back. */
async function recordDerived(
  transaction: ProofStoreTransaction,
  sessionId: ProofSessionId,
  derived: DeriveInquiryCommandResult,
  actor: Actor,
  options: InquiryMethodOptions,
): Promise<readonly InquiryRecord[]> {
  if (!derived.ok) {
    return abort(
      repositoryFailure("rejected", "inquiry-command-rejected", derived.diagnostics[0].message),
    );
  }
  const recorded = await recordInquiryCommandWithin(
    transaction,
    sessionId,
    derived.request,
    actor,
    options,
  );
  return recorded.status === "committed" ? recorded.records : abort(recorded);
}
