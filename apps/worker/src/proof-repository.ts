import {
  actorSchema,
  analyzeBacktrack,
  backtrackAnalysisRequestSchema,
  backtrackAutoCloseCommandId,
  backtrackWithInformationCommandSchema,
  commandIdSchema,
  createPrepareProofCommandSuccessSchema,
  createMovePreviewSchema,
  createProofEdgeSchema,
  createProofNodeSchema,
  definitionChanges,
  deletePreviousMoveCommandSchema,
  deletionReceipt,
  displayedSuggestionSetSchema,
  interactionEventIdSchema,
  interactionEventRequestFields,
  interactionEventSchema,
  planBacktrackWithInformation,
  planPreviousMoveDeletion,
  prepareDisplayedSuggestionSet,
  prepareMovePreview,
  prepareProofCommand,
  proofSessionMetadataSchema,
  movePreviewIdSchema,
  menuChoicesSchema,
  moveMenuSelectionSchema,
  parameterMenusSchema,
  proofDeletionRecordSchema,
  proofNodeIdSchema,
  recordInteractionEventRequestSchema,
  suggestionAuthorizesMove,
  suggestionIdSchema,
  suggestionSetMatchesNode,
  suggestionSetIdSchema,
  RESULT_APPLICATION_MOVE_IDS,
  type Actor,
  type ApplyKernelCommand,
  type BacktrackAnalysis,
  type BacktrackDiagnostic,
  type DefinitionReference,
  type DeletePreviousMoveReceipt,
  type DisplayedSuggestionSet,
  type InteractionEvent,
  type InteractionEventId,
  type MovePreview,
  type MovePreviewId,
  type MoveMenuSelection,
  type ParameterMenuRecord,
  type PrepareProofCommandSuccess,
  type ProofCommandReceipt,
  type ProofEdge,
  type ProofDeletionRecord,
  type ProofNode,
  type ProofSessionMetadata,
  type ProtocolEnvironment,
  type SuggestionSetId,
  type TransitionEvent,
} from "@proof/protocol";
import {
  commandIdGenerator,
  materializeMoveOperation,
  materializeResultApplication,
  type MaterializationResult,
  type MoveMenuChoices,
  type MoveSelectionInput,
  type MoveSelections,
} from "@proof/moves";
import type { RetrievalIndex } from "@proof/retrieval";
import { z } from "zod";
import { APPROVED_DEFINITIONS, definitionHash, type DefinitionCatalog } from "./approved-catalog";

const stableStorageIdentifierSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const proofSessionIdSchema = stableStorageIdentifierSchema.brand("ProofSessionId");
export type ProofSessionId = z.infer<typeof proofSessionIdSchema>;
type OperatorDeclaration = NonNullable<ProtocolEnvironment["operators"]>[number];

const operatorEnvironmentSchema: z.ZodType<readonly OperatorDeclaration[]> = z
  .unknown()
  .transform((value, context) => {
    if (!Array.isArray(value)) {
      context.addIssue({ code: "custom", message: "Operators must be an array." });
      return z.NEVER;
    }
    try {
      const operators = value as readonly OperatorDeclaration[];
      createProofNodeSchema({ operators });
      return operators;
    } catch {
      context.addIssue({ code: "custom", message: "The operator environment is invalid." });
      return z.NEVER;
    }
  });

export type ProofSession = Readonly<{
  id: ProofSessionId;
  rootNodeId: ProofNode["id"];
  currentNodeId: ProofNode["id"];
  operators: readonly OperatorDeclaration[];
  /** Documentary session context; absent for sessions created before migration 0003. */
  metadata?: ProofSessionMetadata | undefined;
}>;

export const proofSessionSchema: z.ZodType<ProofSession> = z
  .object({
    id: proofSessionIdSchema,
    rootNodeId: proofNodeIdSchema,
    currentNodeId: proofNodeIdSchema,
    operators: operatorEnvironmentSchema,
    metadata: proofSessionMetadataSchema.optional(),
  })
  .strict();

/** Relational identities are retained beside JSONB so both representations are checked. */
export type StoredProofNodeRecord = Readonly<{
  sessionId: ProofSessionId;
  nodeId: ProofNode["id"];
  stateId: ProofNode["state"]["id"];
  node: unknown;
}>;

/** Relational identities are retained beside JSONB so both representations are checked. */
export type StoredDisplayedSuggestionSetRecord = Readonly<{
  sessionId: ProofSessionId;
  suggestionSetId: SuggestionSetId;
  nodeId: ProofNode["id"];
  stateId: ProofNode["state"]["id"];
  suggestionSet: unknown;
}>;

/** Relational identities are retained beside JSONB so both representations are checked. */
export type StoredProofEdgeRecord = Readonly<{
  sessionId: ProofSessionId;
  edgeId: ProofEdge["id"];
  parentNodeId: ProofNode["id"];
  childNodeId: ProofNode["id"];
  commandId: ApplyKernelCommand["commandId"];
  suggestionSetId: SuggestionSetId | null;
  chosenSuggestionId: string | null;
  previewId: MovePreviewId | null;
  edge: unknown;
}>;

/** The live records "Delete previous move" asks a store to remove, in dependency order. */
export type ProofRecordDeletionRequest = Readonly<{
  nodeIds: readonly ProofNode["id"][];
  edgeIds: readonly ProofEdge["id"][];
  commandIds: readonly ApplyKernelCommand["commandId"][];
  /** Previews chosen by deleted edges; removed only when no retained edge still references one. */
  chosenPreviewIds: readonly MovePreviewId[];
}>;

/** The IDs a store actually removed from each table (unvalidated until the repository checks). */
export type ProofRecordDeletionResult = Readonly<{
  /** Interaction events anchored at deleted nodes or naming a deleted chosen preview. */
  interactionEventIds: readonly string[];
  eventIds: readonly string[];
  edgeIds: readonly string[];
  previewIds: readonly string[];
  suggestionSetIds: readonly string[];
  commandIds: readonly string[];
  nodeIds: readonly string[];
}>;

export interface ProofStoreTransaction {
  lockSession(sessionId: ProofSessionId): Promise<unknown | undefined>;
  readNode(sessionId: ProofSessionId, nodeId: ProofNode["id"]): Promise<unknown | undefined>;
  readCommand(
    sessionId: ProofSessionId,
    commandId: ApplyKernelCommand["commandId"],
  ): Promise<unknown | undefined>;
  readSuggestionSet(
    sessionId: ProofSessionId,
    suggestionSetId: SuggestionSetId,
  ): Promise<unknown | undefined>;
  readPreview(sessionId: ProofSessionId, previewId: MovePreviewId): Promise<unknown | undefined>;
  listEdges(sessionId: ProofSessionId): Promise<readonly unknown[]>;
  insertSession(session: ProofSession): Promise<void>;
  insertNode(sessionId: ProofSessionId, node: ProofNode): Promise<void>;
  insertSuggestionSet(
    sessionId: ProofSessionId,
    suggestionSet: DisplayedSuggestionSet,
  ): Promise<void>;
  insertPreview(sessionId: ProofSessionId, preview: MovePreview): Promise<void>;
  insertEdge(sessionId: ProofSessionId, edge: ProofEdge): Promise<void>;
  insertEvent(sessionId: ProofSessionId, event: TransitionEvent): Promise<void>;
  insertCommand(sessionId: ProofSessionId, result: PrepareProofCommandSuccess): Promise<void>;
  advanceCurrentNode(
    sessionId: ProofSessionId,
    expectedNodeId: ProofNode["id"],
    nextNodeId: ProofNode["id"],
  ): Promise<boolean>;
  repointCurrentNode(
    sessionId: ProofSessionId,
    expectedNodeId: ProofNode["id"],
    targetNodeId: ProofNode["id"],
  ): Promise<boolean>;
  /**
   * The deletion tombstone issued by this command ID, or else the one that deleted the apply
   * command with this ID.
   */
  readDeletion(
    sessionId: ProofSessionId,
    commandId: ApplyKernelCommand["commandId"],
  ): Promise<unknown | undefined>;
  /**
   * Remove events of the deleted edges, the edges, previews anchored at deleted nodes or chosen by
   * deleted edges, suggestion sets anchored at deleted nodes, command records, then the nodes.
   */
  deleteProofRecords(
    sessionId: ProofSessionId,
    request: ProofRecordDeletionRequest,
  ): Promise<ProofRecordDeletionResult>;
  insertDeletion(sessionId: ProofSessionId, deletion: ProofDeletionRecord): Promise<void>;
  /** `{ sessionId, eventId, sequence, nodeId, event }` for one interaction event, if present. */
  readInteractionEvent(
    sessionId: ProofSessionId,
    eventId: InteractionEventId,
  ): Promise<unknown | undefined>;
  /** The highest interaction-event sequence in the session, or 0. Called under the session lock. */
  lastInteractionSequence(sessionId: ProofSessionId): Promise<number>;
  insertInteractionEvent(sessionId: ProofSessionId, event: InteractionEvent): Promise<void>;
  /** Interaction-event records in increasing sequence order, in the read-record shape. */
  listInteractionEvents(
    sessionId: ProofSessionId,
    query: InteractionEventQuery,
  ): Promise<readonly unknown[]>;
}

export type InteractionEventQuery = Readonly<{
  nodeId?: ProofNode["id"] | undefined;
  afterSequence: number;
  limit: number;
}>;

export interface ProofStore {
  transaction<Result>(
    work: (transaction: ProofStoreTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export class ProofStoreTransactionError extends Error {
  readonly outcome: "rolled-back" | "commit-unknown";
  override readonly cause: unknown;

  constructor(outcome: "rolled-back" | "commit-unknown", message: string, cause?: unknown) {
    super(message);
    this.name = "ProofStoreTransactionError";
    this.outcome = outcome;
    this.cause = cause;
  }
}

class SerializedStaleCommandError extends Error {
  constructor() {
    super("The locked session pointer changed before it could be advanced.");
    this.name = "SerializedStaleCommandError";
  }
}

export type RepositoryDiagnosticCode =
  | "invalid-initial-session"
  | "session-not-found"
  | "invalid-session-record"
  | "current-node-not-found"
  | "invalid-current-node"
  | "invalid-command-record"
  | "invalid-suggestion-set-record"
  | "suggestion-set-not-found"
  | "suggestion-set-rejected"
  | "invalid-preview-record"
  | "preview-not-found"
  | "preview-rejected"
  | "invalid-edge-record"
  | "invalid-proof-history"
  | "backtrack-rejected"
  | "serialized-stale-backtrack"
  | "command-rejected"
  | "command-deleted"
  | "delete-rejected"
  | "delete-requires-confirmation"
  | "invalid-deletion-record"
  | "serialized-stale-delete"
  | "serialized-stale-command"
  | "backtrack-with-information-rejected"
  | "backtrack-symbols-unavailable"
  | "backtrack-with-information-conflict"
  | "interaction-event-rejected"
  | "interaction-event-conflict"
  | "invalid-interaction-event-record"
  | "storage-failure"
  | "commit-unknown";

export type RepositoryDiagnostic = Readonly<{
  code: RepositoryDiagnosticCode;
  message: string;
}>;

export type RepositoryFailure = Readonly<{
  status: "rejected" | "uncertain";
  diagnostics: readonly [RepositoryDiagnostic];
}>;

export type InitializeProofSessionResult =
  Readonly<{ status: "committed"; session: ProofSession; node: ProofNode }> | RepositoryFailure;

export type LoadCurrentProofSessionResult =
  Readonly<{ status: "loaded"; session: ProofSession; node: ProofNode }> | RepositoryFailure;

export type ExecuteProofCommandResult =
  | Readonly<{
      status: "committed";
      result: PrepareProofCommandSuccess;
      replayed: boolean;
    }>
  | RepositoryFailure;

export type RecordDisplayedSuggestionSetResult =
  | Readonly<{
      status: "committed";
      suggestionSet: DisplayedSuggestionSet;
      replayed: boolean;
    }>
  | RepositoryFailure;

export type ReadDisplayedSuggestionSetResult =
  Readonly<{ status: "loaded"; suggestionSet: DisplayedSuggestionSet }> | RepositoryFailure;

export type RecordMovePreviewResult =
  | Readonly<{
      status: "committed";
      preview: MovePreview;
      replayed: boolean;
      /**
       * Present when the preview with the requested ID was built from definitions that have since
       * changed: `preview` is then a regenerated preview and this is the stale preview's ID.
       */
      regeneratedFrom?: MovePreviewId;
    }>
  | RepositoryFailure;

export type RecordMovePreviewOptions = Readonly<{
  definitions?: DefinitionCatalog;
  /**
   * Allows regenerating a stale preview for this command and records who caused it. Without it
   * a preview ID whose stored evidence differs from the request is rejected.
   */
  regeneration?: Readonly<{ commandId: ApplyKernelCommand["commandId"]; actor: Actor }>;
  now?: () => Date;
}>;

export type RecordInteractionEventResult =
  Readonly<{ status: "committed"; event: InteractionEvent; replayed: boolean }> | RepositoryFailure;

export type ListInteractionEventsResult =
  Readonly<{ status: "loaded"; events: readonly InteractionEvent[] }> | RepositoryFailure;

/**
 * The chosen move still needs menu choices. Nothing was recorded; the caller shows `menus` and
 * retries with item IDs for `missingParameters`.
 */
export type MoveRequiresInput = Readonly<{
  status: "requires-input";
  suggestionSetId: SuggestionSetId;
  chosenSuggestionId: z.infer<typeof suggestionIdSchema>;
  menus: readonly ParameterMenuRecord[];
  missingParameters: readonly string[];
  diagnostics: readonly [Readonly<{ code: "requires-input"; message: string }>];
}>;

export type MaterializeMoveChoiceResult =
  | Readonly<{ status: "materialized"; request: MaterializedMovePreviewRequest }>
  | MoveRequiresInput
  | RepositoryFailure;

export type ProofHistoryEdge = Readonly<{ edge: ProofEdge; name: string }>;

export type LoadProofHistoryResult =
  | Readonly<{
      status: "loaded";
      session: ProofSession;
      nodes: readonly ProofNode[];
      edges: readonly ProofHistoryEdge[];
    }>
  | RepositoryFailure;

export type BacktrackProofSessionResult =
  | Readonly<{
      status: "committed";
      session: ProofSession;
      node: ProofNode;
      replayed: boolean;
    }>
  | RepositoryFailure;

export type DeletePreviousMoveResult =
  | Readonly<{
      status: "committed";
      receipt: DeletePreviousMoveReceipt;
      deletion: ProofDeletionRecord;
      replayed: boolean;
    }>
  | RepositoryFailure;

export type DeletePreviousMoveOptions = Readonly<{ now?: () => Date }>;

export type AnalyzeBacktrackResult =
  Readonly<{ status: "loaded"; analysis: BacktrackAnalysis }> | RepositoryFailure;

export type BacktrackedInteractionEvent = Extract<
  InteractionEvent,
  { kind: "backtracked-with-information" }
>;

export type BacktrackWithInformationResult =
  | Readonly<{
      status: "committed";
      session: ProofSession;
      /** The node the cursor moved to: the case split, or the auto-close after it. */
      node: ProofNode;
      /** The case-split receipt, then the auto-close receipt when a case closed. */
      receipts: readonly ProofCommandReceipt[];
      /** The recorded backtrack: source, proposition, eligible and chosen ancestors, focus. */
      backtrack: BacktrackedInteractionEvent;
      replayed: boolean;
    }>
  | RepositoryFailure;

export type BacktrackWithInformationOptions = Readonly<{
  definitions?: DefinitionCatalog;
  now?: () => Date;
}>;

export const moveChoiceSchema = z
  .object({
    commandId: commandIdSchema,
    suggestionSetId: suggestionSetIdSchema,
    chosenSuggestionId: suggestionIdSchema,
    /** Parameter ID → menu item ID; arbitrary expressions are never accepted. */
    menuChoices: menuChoicesSchema.optional(),
  })
  .strict();

export const backtrackProofSessionSchema = z
  .object({
    expectedCurrentNodeId: proofNodeIdSchema,
    targetNodeId: proofNodeIdSchema,
  })
  .strict();

export type MaterializedMovePreviewRequest = Readonly<{
  id: MovePreviewId;
  suggestionSetId: SuggestionSetId;
  chosenSuggestionId: z.infer<typeof suggestionIdSchema>;
  moveId: MovePreview["moveId"];
  operation: MovePreview["operation"];
  /** Present when the move displayed a choice menu or the caller chose menu items. */
  menuSelection?: MoveMenuSelection;
  /** Content hashes of the move and library definitions the materialization used. */
  definitions: readonly DefinitionReference[];
}>;

const initializeInputSchema = z
  .object({
    sessionId: proofSessionIdSchema,
    rootNode: z.unknown(),
    operators: operatorEnvironmentSchema.optional(),
    metadata: proofSessionMetadataSchema.optional(),
  })
  .strict();

/** Create the session and its root node in one transaction. */
export async function initializeProofSession(
  store: ProofStore,
  input: unknown,
): Promise<InitializeProofSessionResult> {
  const parsedInput = safeParse(initializeInputSchema, input);
  if (parsedInput === undefined) {
    return repositoryFailure(
      "rejected",
      "invalid-initial-session",
      "The initial proof-session request is invalid.",
    );
  }
  const environment = frozenEnvironment(parsedInput.operators ?? []);
  if (environment === undefined) {
    return repositoryFailure(
      "rejected",
      "invalid-initial-session",
      "The initial operator environment cannot be detached safely.",
    );
  }
  const parsedRootNode = safeParse(createProofNodeSchema(environment), parsedInput.rootNode);
  const rootNode = parsedRootNode === undefined ? undefined : freezeDetached(parsedRootNode);
  if (rootNode === undefined) {
    return repositoryFailure(
      "rejected",
      "invalid-initial-session",
      "The root node is not executable in the supplied operator environment.",
    );
  }
  const session = deepFreeze({
    id: parsedInput.sessionId,
    rootNodeId: rootNode.id,
    currentNodeId: rootNode.id,
    operators: environment.operators ?? [],
    ...(parsedInput.metadata === undefined
      ? {}
      : { metadata: structuredClone(parsedInput.metadata) }),
  }) satisfies ProofSession;

  try {
    return await store.transaction(async (transaction) => {
      await transaction.insertSession(session);
      await transaction.insertNode(session.id, rootNode);
      return { status: "committed" as const, session, node: rootNode };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The proof session could not be initialized atomically.");
  }
}

/** Load one session and its current immutable proof-node snapshot. */
export async function loadCurrentProofSession(
  store: ProofStore,
  sessionIdInput: unknown,
): Promise<LoadCurrentProofSessionResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  if (sessionId === undefined) {
    return repositoryFailure(
      "rejected",
      "invalid-session-record",
      "The proof-session ID is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const loadedNode = await loadNode(
        transaction,
        loadedSession.session,
        loadedSession.environment,
        loadedSession.session.currentNodeId,
        "current-node-not-found",
        "invalid-current-node",
      );
      if (!loadedNode.ok) return loadedNode.failure;

      return {
        status: "loaded" as const,
        session: loadedSession.session,
        node: loadedNode.node,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The proof session could not be loaded.");
  }
}

/** Read immutable displayed evidence against the historical node it records. */
export async function readDisplayedSuggestionSet(
  store: ProofStore,
  sessionIdInput: unknown,
  suggestionSetIdInput: unknown,
): Promise<ReadDisplayedSuggestionSetResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const suggestionSetId = safeParse(suggestionSetIdSchema, suggestionSetIdInput) as
    SuggestionSetId | undefined;
  if (sessionId === undefined || suggestionSetId === undefined) {
    return repositoryFailure(
      "rejected",
      "suggestion-set-rejected",
      "The session ID or suggestion-set ID is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const loadedSuggestionSet = await loadSuggestionSet(
        transaction,
        loadedSession.session,
        suggestionSetId,
      );
      if (!loadedSuggestionSet.ok) return loadedSuggestionSet.failure;
      const loadedNode = await loadNode(
        transaction,
        loadedSession.session,
        loadedSession.environment,
        loadedSuggestionSet.suggestionSet.nodeId,
        "current-node-not-found",
        "invalid-current-node",
      );
      if (!loadedNode.ok) return loadedNode.failure;
      if (
        loadedSuggestionSet.suggestionSet.stateId !== loadedNode.node.state.id ||
        !suggestionSetMatchesNode(
          loadedSuggestionSet.suggestionSet,
          loadedNode.node,
          loadedSession.environment,
        )
      ) {
        return repositoryFailure(
          "rejected",
          "invalid-suggestion-set-record",
          "The stored suggestion set does not match its historical proof-node snapshot.",
        );
      }

      return { status: "loaded" as const, suggestionSet: loadedSuggestionSet.suggestionSet };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The displayed suggestion set could not be read.");
  }
}

/** Run retrieval and atomically retain the exact ordered evidence; retries must reproduce it. */
export async function recordDisplayedSuggestionSet(
  store: ProofStore,
  index: RetrievalIndex,
  sessionIdInput: unknown,
  requestInput: unknown,
): Promise<RecordDisplayedSuggestionSetResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const suggestionSetId = suggestionSetIdFromUnknown(requestInput, "id");
  if (sessionId === undefined || suggestionSetId === undefined) {
    return repositoryFailure(
      "rejected",
      "suggestion-set-rejected",
      "The session ID or suggestion-set request is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;

      const loadedCurrentNode = await loadNode(
        transaction,
        session,
        environment,
        session.currentNodeId,
        "current-node-not-found",
        "invalid-current-node",
      );
      if (!loadedCurrentNode.ok) return loadedCurrentNode.failure;
      const currentNode = loadedCurrentNode.node;

      const prepared = prepareDisplayedSuggestionSet(index, currentNode, requestInput, environment);
      if (!prepared.ok) {
        return repositoryFailure(
          "rejected",
          "suggestion-set-rejected",
          prepared.diagnostics[0]?.message ?? "The suggestion request was rejected.",
        );
      }

      const existingInput = await transaction.readSuggestionSet(session.id, suggestionSetId);
      if (existingInput !== undefined) {
        const loadedExisting = parseSuggestionSetRecord(existingInput, session, suggestionSetId);
        if (
          loadedExisting === undefined ||
          !suggestionSetMatchesNode(loadedExisting, currentNode, environment)
        ) {
          return repositoryFailure(
            "rejected",
            "invalid-suggestion-set-record",
            "The stored suggestion set failed runtime validation or snapshot identity checks.",
          );
        }
        if (!jsonEquals(loadedExisting, prepared.suggestionSet)) {
          return repositoryFailure(
            "rejected",
            "suggestion-set-rejected",
            "The suggestion-set ID is already anchored to a different request or result.",
          );
        }
        return { status: "committed" as const, suggestionSet: loadedExisting, replayed: true };
      }

      await transaction.insertSuggestionSet(session.id, prepared.suggestionSet);
      return {
        status: "committed" as const,
        suggestionSet: prepared.suggestionSet,
        replayed: false,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The suggestion-set transaction failed.");
  }
}

/**
 * Resolve a persisted displayed choice, with its menu choices, to a trusted primitive request.
 * Generated IDs are derived from the command ID; every other parameter is a menu item regenerated
 * from the historical snapshot, so a stale or fabricated item ID is rejected. A choice that still
 * needs menu input returns the menus instead of a request.
 */
export async function materializeMoveChoice(
  store: ProofStore,
  sessionIdInput: unknown,
  choiceInput: unknown,
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
): Promise<MaterializeMoveChoiceResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const choice = safeParse(moveChoiceSchema, choiceInput);
  if (sessionId === undefined || choice === undefined) {
    return repositoryFailure(
      "rejected",
      "preview-rejected",
      "The session ID or persisted move choice is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId, definitions);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;
      const deleted = await deletedCommandFailure(transaction, session.id, choice.commandId);
      if (deleted !== undefined) return deleted;
      const previewId = derivedPreviewId(choice.commandId);
      const existingInput = await transaction.readPreview(session.id, previewId);

      const loadedSuggestionSet = await loadSuggestionSet(
        transaction,
        session,
        choice.suggestionSetId,
      );
      if (!loadedSuggestionSet.ok) return loadedSuggestionSet.failure;
      const suggestionSet = loadedSuggestionSet.suggestionSet;
      const chosen = suggestionSet.suggestions.find(
        (suggestion) => suggestion.id === choice.chosenSuggestionId,
      );
      if (chosen === undefined) {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          "The chosen suggestion was not present in the persisted displayed suggestion set.",
        );
      }
      const loadedParentNode = await loadNode(
        transaction,
        session,
        environment,
        suggestionSet.nodeId,
        "current-node-not-found",
        "invalid-current-node",
      );
      if (!loadedParentNode.ok) return loadedParentNode.failure;
      if (
        !suggestionSetMatchesNode(suggestionSet, loadedParentNode.node, environment) ||
        (existingInput === undefined && session.currentNodeId !== loadedParentNode.node.id)
      ) {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          "The displayed move suggestion is stale for the current proof node.",
        );
      }
      const chosenSuggestionId = safeParse(suggestionIdSchema, chosen.id) as
        z.infer<typeof suggestionIdSchema> | undefined;
      if (chosenSuggestionId === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-suggestion-set-record",
          "The chosen suggestion has an invalid persistent identity.",
        );
      }

      const menuChoices: MoveMenuChoices = choice.menuChoices ?? {};
      const materialized = materializeSuggestion(
        loadedParentNode.node,
        suggestionSet,
        chosen,
        environment,
        choice.commandId,
        menuChoices,
        definitions,
      );
      if (!materialized.ok) {
        if (materialized.requiresInput === undefined) return materialized.failure;
        return {
          status: "requires-input" as const,
          suggestionSetId: suggestionSet.id,
          chosenSuggestionId,
          ...materialized.requiresInput,
        };
      }
      const { moveId, result, references } = materialized;
      const menuSelection = recordedMenuSelection(result.menus, menuChoices);
      if (menuSelection === null) {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          "The displayed parameter menus failed runtime validation.",
        );
      }
      const request: MaterializedMovePreviewRequest = {
        id: previewId,
        suggestionSetId: suggestionSet.id,
        chosenSuggestionId,
        moveId: moveId as MovePreview["moveId"],
        operation: result.operation,
        ...(menuSelection === undefined ? {} : { menuSelection }),
        definitions: references,
      };
      // An existing preview for this command ID is compared by `recordMovePreview`, which
      // regenerates it when only the approved definitions behind it changed.
      return {
        status: "materialized" as const,
        request,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The move choice could not be materialized.");
  }
}

/**
 * Persist one concrete move preview without advancing the proof session.
 *
 * With `options.regeneration`, a preview ID whose stored evidence was built for the same displayed
 * choice but from different approved definitions (or a different resulting operation) is stale:
 * a fresh preview is recorded under a derived ID, together with a `preview-regenerated`
 * interaction event, and returned with `regeneratedFrom` (refinement §12.2).
 */
export async function recordMovePreview(
  store: ProofStore,
  sessionIdInput: unknown,
  requestInput: unknown,
  options: RecordMovePreviewOptions = {},
): Promise<RecordMovePreviewResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const previewId = movePreviewIdFromUnknown(requestInput, "id");
  const suggestionSetId = suggestionSetIdFromUnknown(requestInput, "suggestionSetId");
  if (sessionId === undefined || previewId === undefined || suggestionSetId === undefined) {
    return repositoryFailure(
      "rejected",
      "preview-rejected",
      "The session ID or move-preview request is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(
        transaction,
        sessionId,
        options.definitions ?? APPROVED_DEFINITIONS,
      );
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;

      const existingInput = await transaction.readPreview(session.id, previewId);
      let stale: MovePreview | undefined;
      if (existingInput !== undefined) {
        const existing = safeParse(createMovePreviewSchema(environment), existingInput);
        if (existing === undefined || existing.id !== previewId) {
          return repositoryFailure(
            "rejected",
            "invalid-preview-record",
            "The stored move preview failed runtime validation or identity checks.",
          );
        }
        if (!movePreviewRequestMatches(existing, requestInput)) {
          if (options.regeneration === undefined || !sameDisplayedChoice(existing, requestInput)) {
            return repositoryFailure(
              "rejected",
              "preview-rejected",
              "The preview ID is already linked to a different move-preview request.",
            );
          }
          if (await previewWasApplied(transaction, session.id, existing.id)) {
            // History is static: an applied preview is replayed, never regenerated.
            const detached = freezeDetached(existing);
            return detached === undefined
              ? repositoryFailure(
                  "rejected",
                  "invalid-preview-record",
                  "The stored move preview could not be detached safely.",
                )
              : { status: "committed" as const, preview: detached, replayed: true };
          }
          stale = existing;
        } else {
          const detached = freezeDetached(existing);
          return detached === undefined
            ? repositoryFailure(
                "rejected",
                "invalid-preview-record",
                "The stored move preview could not be detached safely.",
              )
            : { status: "committed" as const, preview: detached, replayed: true };
        }
      }

      const freshId =
        stale === undefined ? previewId : regeneratedPreviewId(stale.id, requestInput);
      const freshRequest =
        stale === undefined ? requestInput : { ...(requestInput as object), id: freshId };
      if (stale !== undefined) {
        const regeneratedInput = await transaction.readPreview(session.id, freshId);
        if (regeneratedInput !== undefined) {
          const regenerated = safeParse(createMovePreviewSchema(environment), regeneratedInput);
          const detached = regenerated === undefined ? undefined : freezeDetached(regenerated);
          if (
            detached === undefined ||
            detached.id !== freshId ||
            !movePreviewRequestMatches(detached, freshRequest)
          ) {
            return repositoryFailure(
              "rejected",
              "invalid-preview-record",
              "The stored regenerated preview failed validation or identity checks.",
            );
          }
          return {
            status: "committed" as const,
            preview: detached,
            replayed: true,
            regeneratedFrom: stale.id,
          };
        }
      }

      const suggestionSetInput = await transaction.readSuggestionSet(session.id, suggestionSetId);
      if (suggestionSetInput === undefined) {
        return repositoryFailure(
          "rejected",
          "suggestion-set-not-found",
          "The preview references a suggestion set that does not exist in this session.",
        );
      }
      const suggestionSet = parseSuggestionSetRecord(suggestionSetInput, session, suggestionSetId);
      if (suggestionSet === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-suggestion-set-record",
          "The stored suggestion set failed runtime validation or identity checks.",
        );
      }

      const loadedCurrentNode = await loadNode(
        transaction,
        session,
        environment,
        session.currentNodeId,
        "current-node-not-found",
        "invalid-current-node",
      );
      if (!loadedCurrentNode.ok) return loadedCurrentNode.failure;
      const currentNode = loadedCurrentNode.node;

      const prepared = prepareMovePreview(currentNode, suggestionSet, freshRequest, environment);
      if (!prepared.ok) {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          prepared.diagnostics[0]?.message ?? "The move preview was rejected.",
        );
      }
      await transaction.insertPreview(session.id, prepared.preview);
      if (stale === undefined || options.regeneration === undefined) {
        return { status: "committed" as const, preview: prepared.preview, replayed: false };
      }

      const event = await appendInteractionEvent(
        transaction,
        session.id,
        currentNode,
        options.regeneration.actor,
        options.now,
        {
          id: `event:${freshId}`,
          kind: "preview-regenerated",
          commandId: options.regeneration.commandId,
          stalePreviewId: stale.id,
          previewId: prepared.preview.id,
          operationChanged:
            stale.moveId !== prepared.preview.moveId ||
            !jsonEquals(stale.operation, prepared.preview.operation),
          changedDefinitions: definitionChanges(
            stale.definitions ?? [],
            prepared.preview.definitions ?? [],
          ),
        },
      );
      if (event === undefined) {
        // Throwing rolls the regenerated preview back with the event.
        throw new Error("The preview-regeneration event failed runtime validation.");
      }
      return {
        status: "committed" as const,
        preview: prepared.preview,
        replayed: false,
        regeneratedFrom: stale.id,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The move-preview transaction failed.");
  }
}

/** The stored preview and the request name the same displayed choice and menu choices. */
function sameDisplayedChoice(preview: MovePreview, request: unknown): boolean {
  return (
    isDataRecord(request) &&
    request.suggestionSetId === preview.suggestionSetId &&
    request.chosenSuggestionId === preview.chosenSuggestionId &&
    jsonEquals(
      isDataRecord(request.menuSelection) ? request.menuSelection.choices : undefined,
      preview.menuSelection?.choices,
    )
  );
}

async function previewWasApplied(
  transaction: ProofStoreTransaction,
  sessionId: ProofSessionId,
  previewId: MovePreviewId,
): Promise<boolean> {
  const edges = await transaction.listEdges(sessionId);
  return edges.some((row) => isDataRecord(row) && row.previewId === previewId);
}

/** A deterministic ID for the regeneration of `stalePreviewId` with this exact content. */
function regeneratedPreviewId(stalePreviewId: MovePreviewId, request: unknown): MovePreviewId {
  const content = isDataRecord(request)
    ? {
        moveId: request.moveId,
        operation: request.operation,
        menuSelection: request.menuSelection,
        definitions: request.definitions,
      }
    : {};
  const digest = definitionHash(content).slice("sha256:".length, "sha256:".length + 16);
  return `${stalePreviewId}:regenerated:${digest}` as MovePreviewId;
}

type InteractionEventFields = Readonly<Record<string, unknown>> &
  Readonly<{ id: string; kind: InteractionEvent["kind"] }>;

/** Assign the next sequence number and insert one validated event anchored at `node`. */
async function appendInteractionEvent(
  transaction: ProofStoreTransaction,
  sessionId: ProofSessionId,
  node: ProofNode,
  actor: Actor,
  now: (() => Date) | undefined,
  fields: InteractionEventFields,
): Promise<InteractionEvent | undefined> {
  const last = await transaction.lastInteractionSequence(sessionId);
  if (!Number.isSafeInteger(last) || last < 0) {
    throw new Error("The stored interaction-event sequence is invalid.");
  }
  const parsed = safeParse(interactionEventSchema, {
    ...fields,
    sequence: last + 1,
    nodeId: node.id,
    stateId: node.state.id,
    actor: { id: actor.id, kind: actor.kind },
    recordedAt: (now?.() ?? new Date()).toISOString(),
  });
  const event = parsed === undefined ? undefined : freezeDetached(parsed);
  if (event === undefined) return undefined;
  await transaction.insertInteractionEvent(sessionId, event);
  return event;
}

/**
 * Record one client interaction event (refinement §12.1). It is anchored to an existing node of
 * the session and receives the next per-session sequence number. Retrying the same event ID with
 * the same content replays the stored event; different content under that ID is rejected.
 */
export async function recordInteractionEvent(
  store: ProofStore,
  sessionIdInput: unknown,
  requestInput: unknown,
  trustedActorInput: unknown,
  options: Readonly<{ now?: () => Date }> = {},
): Promise<RecordInteractionEventResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const request = safeParse(recordInteractionEventRequestSchema, requestInput);
  const actor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || request === undefined || actor === undefined) {
    return repositoryFailure(
      "rejected",
      "interaction-event-rejected",
      "The session ID, interaction event, or trusted actor is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;

      const existingInput = await transaction.readInteractionEvent(
        session.id,
        request.id as InteractionEventId,
      );
      if (existingInput !== undefined) {
        const existing = parseInteractionEventRecord(existingInput, session, request.id);
        if (existing === undefined) {
          return repositoryFailure(
            "rejected",
            "invalid-interaction-event-record",
            "The stored interaction event failed runtime validation or identity checks.",
          );
        }
        if (
          !jsonEquals(interactionEventRequestFields(existing), request) ||
          existing.actor.id !== actor.id ||
          existing.actor.kind !== actor.kind
        ) {
          return repositoryFailure(
            "rejected",
            "interaction-event-conflict",
            "The interaction-event ID is already recorded with different content.",
          );
        }
        return { status: "committed" as const, event: existing, replayed: true };
      }

      const loadedNode = await loadNode(
        transaction,
        session,
        environment,
        request.nodeId as ProofNode["id"],
        "interaction-event-rejected",
        "invalid-current-node",
      );
      if (!loadedNode.ok) return loadedNode.failure;
      const node = loadedNode.node;
      const invalid = await interactionEventReferenceFailure(transaction, session, node, request);
      if (invalid !== undefined) {
        return repositoryFailure("rejected", "interaction-event-rejected", invalid);
      }
      const event = await appendInteractionEvent(
        transaction,
        session.id,
        node,
        actor,
        options.now,
        request,
      );
      return event === undefined
        ? repositoryFailure(
            "rejected",
            "interaction-event-rejected",
            "The interaction event failed runtime validation against its anchor node.",
          )
        : { status: "committed" as const, event, replayed: false };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The interaction event could not be recorded.");
  }
}

/** Why an event's references do not belong to its anchor node, or undefined when they do. */
async function interactionEventReferenceFailure(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  node: ProofNode,
  request: z.infer<typeof recordInteractionEventRequestSchema>,
): Promise<string | undefined> {
  const targets = new Set([
    ...node.state.goals.map(({ id }) => `goal\u0000${id}`),
    ...node.state.obligations.map(({ id }) => `obligation\u0000${id}`),
  ]);
  const hasTarget = (target: Readonly<{ kind: string; id: string }>) =>
    targets.has(`${target.kind}\u0000${target.id}`);
  const anchoredSet = async (
    suggestionSetId: SuggestionSetId,
  ): Promise<DisplayedSuggestionSet | string> => {
    const loaded = await loadSuggestionSet(transaction, session, suggestionSetId);
    if (!loaded.ok) return "The referenced suggestion set does not exist in this session.";
    return loaded.suggestionSet.nodeId === node.id
      ? loaded.suggestionSet
      : "The referenced suggestion set is anchored to a different proof node.";
  };

  switch (request.kind) {
    case "selection-changed":
      return request.selections.every(
        ({ anchor }) => anchor.stateId === node.state.id && hasTarget(anchor.target),
      )
        ? undefined
        : "Every selection must be anchored to a goal or obligation of the event's node.";
    case "suggestions-requested": {
      // The request precedes the set; if it already exists it must belong to this node.
      const input = await transaction.readSuggestionSet(
        session.id,
        request.suggestionSetId as SuggestionSetId,
      );
      if (input === undefined) return undefined;
      const set = await anchoredSet(request.suggestionSetId as SuggestionSetId);
      return typeof set === "string" ? set : undefined;
    }
    case "suggestions-displayed": {
      const set = await anchoredSet(request.suggestionSetId as SuggestionSetId);
      if (typeof set === "string") return set;
      const order = set.suggestions.map(({ id }) => id);
      let cursor = 0;
      for (const id of request.suggestionIds) {
        const index = order.indexOf(id, cursor);
        if (index < 0) return "Displayed suggestions must appear in the set, in stored order.";
        cursor = index + 1;
      }
      return undefined;
    }
    case "preview-requested":
    case "menu-expanded": {
      const set = await anchoredSet(request.suggestionSetId as SuggestionSetId);
      if (typeof set === "string") return set;
      const suggestionId =
        request.kind === "preview-requested" ? request.chosenSuggestionId : request.suggestionId;
      return set.suggestions.some(({ id }) => id === suggestionId)
        ? undefined
        : "The referenced suggestion was not displayed in that suggestion set.";
    }
    case "preview-rejected": {
      const input = await transaction.readPreview(session.id, request.previewId as MovePreviewId);
      return isDataRecord(input) && input.id === request.previewId && input.nodeId === node.id
        ? undefined
        : "The rejected preview does not exist at the event's proof node.";
    }
    case "focus-changed":
      return hasTarget(request.target)
        ? undefined
        : "The focus target is not a goal or obligation of the event's node.";
    case "objective-changed":
      return undefined;
    case "interaction-ended-without-action": {
      if (request.suggestionSetId === undefined) return undefined;
      const set = await anchoredSet(request.suggestionSetId as SuggestionSetId);
      return typeof set === "string" ? set : undefined;
    }
  }
}

/** Read a session's interaction events in sequence order, optionally for one anchor node. */
export async function listInteractionEvents(
  store: ProofStore,
  sessionIdInput: unknown,
  queryInput: unknown = {},
): Promise<ListInteractionEventsResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const query = safeParse(interactionEventQuerySchema, queryInput);
  if (sessionId === undefined || query === undefined) {
    return repositoryFailure(
      "rejected",
      "interaction-event-rejected",
      "The session ID or interaction-event query is invalid.",
    );
  }
  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session } = loadedSession;
      const rows = await transaction.listInteractionEvents(session.id, {
        ...(query.nodeId === undefined ? {} : { nodeId: query.nodeId as ProofNode["id"] }),
        afterSequence: query.afterSequence ?? 0,
        limit: query.limit ?? MAX_INTERACTION_EVENTS_PER_READ,
      });
      if (!Array.isArray(rows)) {
        return repositoryFailure(
          "rejected",
          "invalid-interaction-event-record",
          "The stored interaction-event collection is invalid.",
        );
      }
      const events: InteractionEvent[] = [];
      for (const row of rows) {
        const eventId = isDataRecord(row) ? row.eventId : undefined;
        const event =
          typeof eventId === "string"
            ? parseInteractionEventRecord(row, session, eventId)
            : undefined;
        const previous = events.at(-1);
        if (
          event === undefined ||
          event.sequence <= (query.afterSequence ?? 0) ||
          (query.nodeId !== undefined && event.nodeId !== query.nodeId) ||
          (previous !== undefined && event.sequence <= previous.sequence)
        ) {
          return repositoryFailure(
            "rejected",
            "invalid-interaction-event-record",
            "A stored interaction event failed validation, identity, or ordering checks.",
          );
        }
        events.push(event);
      }
      return { status: "loaded" as const, events };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The interaction events could not be read.");
  }
}

const MAX_INTERACTION_EVENTS_PER_READ = 1000;

export const interactionEventQuerySchema = z
  .object({
    nodeId: proofNodeIdSchema.optional(),
    afterSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(MAX_INTERACTION_EVENTS_PER_READ).optional(),
  })
  .strict();

function parseInteractionEventRecord(
  input: unknown,
  session: ProofSession,
  expectedEventId: string,
): InteractionEvent | undefined {
  if (!isStrictDataRecord(input, ["sessionId", "eventId", "sequence", "nodeId", "event"])) {
    return undefined;
  }
  const event = safeParse(interactionEventSchema, input.event);
  if (
    event === undefined ||
    safeParse(proofSessionIdSchema, input.sessionId) !== session.id ||
    safeParse(interactionEventIdSchema, input.eventId) !== expectedEventId ||
    event.id !== expectedEventId ||
    input.sequence !== event.sequence ||
    input.nodeId !== event.nodeId
  ) {
    return undefined;
  }
  return freezeDetached(event);
}

/** Load the complete validated rooted discovery tree using only retained records. */
export async function loadProofHistory(
  store: ProofStore,
  sessionIdInput: unknown,
): Promise<LoadProofHistoryResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  if (sessionId === undefined) {
    return repositoryFailure(
      "rejected",
      "invalid-session-record",
      "The proof-session ID is invalid.",
    );
  }
  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      return loadProofHistoryInTransaction(
        transaction,
        loadedSession.session,
        loadedSession.environment,
      );
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The proof-discovery tree could not be loaded.");
  }
}

/** Repoint the current-node cursor to a node in the retained rooted tree without a kernel move. */
export async function backtrackProofSession(
  store: ProofStore,
  sessionIdInput: unknown,
  requestInput: unknown,
): Promise<BacktrackProofSessionResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const request = safeParse(backtrackProofSessionSchema, requestInput);
  if (sessionId === undefined || request === undefined) {
    return repositoryFailure(
      "rejected",
      "backtrack-rejected",
      "The session ID or backtrack request is invalid.",
    );
  }
  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;
      if (session.currentNodeId !== request.expectedCurrentNodeId) {
        return repositoryFailure(
          "rejected",
          "serialized-stale-backtrack",
          "The current proof node changed before the backtrack request was applied.",
        );
      }
      const history = await loadProofHistoryInTransaction(transaction, session, environment);
      if (history.status !== "loaded") return history;
      const target = history.nodes.find((node) => node.id === request.targetNodeId);
      if (target === undefined) {
        return repositoryFailure(
          "rejected",
          "backtrack-rejected",
          "The requested node is not reachable from this session's root.",
        );
      }
      if (target.id === session.currentNodeId) {
        return { status: "committed" as const, session, node: target, replayed: true };
      }
      const repointed = await transaction.repointCurrentNode(
        session.id,
        session.currentNodeId,
        target.id,
      );
      if (!repointed) {
        return repositoryFailure(
          "rejected",
          "serialized-stale-backtrack",
          "The current proof node changed before the backtrack request was applied.",
        );
      }
      const updatedSession = freezeDetached({ ...session, currentNodeId: target.id });
      if (updatedSession === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-session-record",
          "The updated proof session could not be detached safely.",
        );
      }
      return {
        status: "committed" as const,
        session: updatedSession,
        node: target,
        replayed: false,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The proof session could not be backtracked atomically.");
  }
}

/**
 * Delete the latest move at the current leaf (design plan §16.2): the edge whose child is the
 * current node, that child, and, with `confirmDescendants`, its whole subtree. The cursor returns
 * to the parent. Deleted work leaves the live history; only an ID-only tombstone is retained.
 */
export async function deletePreviousMove(
  store: ProofStore,
  sessionIdInput: unknown,
  commandInput: unknown,
  trustedActorInput: unknown,
  options: DeletePreviousMoveOptions = {},
): Promise<DeletePreviousMoveResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const command = safeParse(deletePreviousMoveCommandSchema, commandInput);
  const trustedActor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || command === undefined || trustedActor === undefined) {
    return repositoryFailure(
      "rejected",
      "delete-rejected",
      "The session ID, delete-previous-move command, or trusted actor is invalid.",
    );
  }
  if (command.actor.id !== trustedActor.id || command.actor.kind !== trustedActor.kind) {
    return repositoryFailure(
      "rejected",
      "delete-rejected",
      "The command actor does not match the trusted actor.",
    );
  }
  const confirmDescendants = command.confirmDescendants ?? false;

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;

      const existingInput = await transaction.readDeletion(session.id, command.commandId);
      if (existingInput !== undefined) {
        const existing = safeParse(proofDeletionRecordSchema, existingInput);
        if (existing === undefined) {
          return repositoryFailure(
            "rejected",
            "invalid-deletion-record",
            "The stored deletion tombstone failed runtime validation.",
          );
        }
        if (
          existing.commandId !== command.commandId ||
          existing.actor.id !== command.actor.id ||
          existing.actor.kind !== command.actor.kind ||
          existing.expectedCurrentNodeId !== command.expectedCurrentNodeId ||
          existing.confirmDescendants !== confirmDescendants ||
          existing.reason !== command.reason
        ) {
          return repositoryFailure(
            "rejected",
            "delete-rejected",
            "The command ID is already recorded for a different command.",
          );
        }
        const deletion = freezeDetached(existing);
        return deletion === undefined
          ? repositoryFailure(
              "rejected",
              "invalid-deletion-record",
              "The stored deletion tombstone could not be detached safely.",
            )
          : {
              status: "committed" as const,
              receipt: deepFreeze(deletionReceipt(deletion)),
              deletion,
              replayed: true,
            };
      }
      if ((await transaction.readCommand(session.id, command.commandId)) !== undefined) {
        return repositoryFailure(
          "rejected",
          "delete-rejected",
          "The command ID is already recorded for a different command.",
        );
      }
      if (session.currentNodeId !== command.expectedCurrentNodeId) {
        return repositoryFailure(
          "rejected",
          "serialized-stale-delete",
          "The current proof node changed before the deletion was applied.",
        );
      }

      const history = await loadProofHistoryInTransaction(transaction, session, environment);
      if (history.status !== "loaded") return history;
      const planned = planPreviousMoveDeletion({
        rootNodeId: session.rootNodeId,
        currentNodeId: session.currentNodeId,
        edges: history.edges.map(({ edge }) => edge),
        confirmDescendants,
      });
      if (!planned.ok) {
        const diagnostic = planned.diagnostics[0];
        return repositoryFailure(
          "rejected",
          diagnostic.code === "descendants-require-confirmation"
            ? "delete-requires-confirmation"
            : diagnostic.code === "root-has-no-previous-move"
              ? "delete-rejected"
              : "invalid-proof-history",
          diagnostic.message,
        );
      }
      const { plan } = planned;
      const parentNodeId = plan.parentNodeId as ProofNode["id"];

      const repointed = await transaction.repointCurrentNode(
        session.id,
        session.currentNodeId,
        parentNodeId,
      );
      if (!repointed) {
        return repositoryFailure(
          "rejected",
          "serialized-stale-delete",
          "The current proof node changed before the deletion was applied.",
        );
      }
      const removed = await transaction.deleteProofRecords(session.id, {
        nodeIds: plan.deletedNodeIds as readonly ProofNode["id"][],
        edgeIds: plan.deletedEdgeIds as readonly ProofEdge["id"][],
        commandIds: plan.deletedCommandIds as readonly ApplyKernelCommand["commandId"][],
        chosenPreviewIds: plan.chosenPreviewIds as readonly MovePreviewId[],
      });
      if (
        !sameIdSet(removed.nodeIds, plan.deletedNodeIds) ||
        !sameIdSet(removed.edgeIds, plan.deletedEdgeIds) ||
        !sameIdSet(removed.commandIds, plan.deletedCommandIds) ||
        removed.eventIds.length !== plan.deletedEdgeIds.length
      ) {
        // Throwing rolls the whole deletion back.
        throw new Error("The store did not remove exactly the planned proof records.");
      }

      const deletion = safeParse(proofDeletionRecordSchema, {
        id: `deletion:${command.commandId}`,
        commandId: command.commandId,
        actor: command.actor,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
        expectedCurrentNodeId: command.expectedCurrentNodeId,
        confirmDescendants,
        parentNodeId,
        deletedNodeIds: plan.deletedNodeIds,
        deletedEdgeIds: plan.deletedEdgeIds,
        deletedEventIds: sortedIds(removed.eventIds),
        deletedCommandIds: plan.deletedCommandIds,
        deletedSuggestionSetIds: sortedIds(removed.suggestionSetIds),
        deletedPreviewIds: sortedIds(removed.previewIds),
        occurredAt: (options.now?.() ?? new Date()).toISOString(),
      });
      const detached = deletion === undefined ? undefined : freezeDetached(deletion);
      if (detached === undefined) {
        throw new Error("The deletion tombstone failed runtime validation.");
      }
      await transaction.insertDeletion(session.id, detached);
      return {
        status: "committed" as const,
        receipt: deepFreeze(deletionReceipt(detached)),
        deletion: detached,
        replayed: false,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The previous move could not be deleted atomically.");
  }
}

/** The interaction-event ID recording one backtracking-with-information command. */
export function backtrackEventId(commandId: ApplyKernelCommand["commandId"]): InteractionEventId {
  return `backtrack:${commandId}` as InteractionEventId;
}

/**
 * Where can a proposition from a descendant snapshot go (design plan §16.3)? Reads the retained
 * tree only: it lists the source's ancestors closest first, with each one's eligibility.
 */
export async function analyzeBacktrackWithInformation(
  store: ProofStore,
  sessionIdInput: unknown,
  requestInput: unknown,
): Promise<AnalyzeBacktrackResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const request = safeParse(backtrackAnalysisRequestSchema, requestInput);
  if (sessionId === undefined || request === undefined) {
    return repositoryFailure(
      "rejected",
      "backtrack-with-information-rejected",
      "The session ID or backtracking request is invalid.",
    );
  }
  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;
      const history = await loadProofHistoryInTransaction(transaction, session, environment);
      if (history.status !== "loaded") return history;
      const analyzed = analyzeBacktrack({
        rootNodeId: session.rootNodeId,
        nodes: history.nodes,
        edges: history.edges.map(({ edge }) => edge),
        operators: session.operators,
        request,
      });
      return analyzed.ok
        ? { status: "loaded" as const, analysis: analyzed.analysis }
        : backtrackFailure(analyzed.diagnostics[0]);
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The backtracking request could not be analyzed.");
  }
}

/**
 * Backtracking with information (design plan §16.3): create a new child of an ancestor by a
 * classical case split on `P`, close a case whose conclusion is its own case hypothesis, and move
 * the cursor there with the remaining case in focus. Each kernel step is an ordinary command
 * prepared by `prepareProofCommand` against its own parent; the original branch is untouched.
 * The command, its steps, and a `backtracked-with-information` event commit atomically, and a
 * retry with the same command ID replays the recorded result.
 */
export async function backtrackWithInformation(
  store: ProofStore,
  sessionIdInput: unknown,
  commandInput: unknown,
  trustedActorInput: unknown,
  options: BacktrackWithInformationOptions = {},
): Promise<BacktrackWithInformationResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const command = safeParse(backtrackWithInformationCommandSchema, commandInput);
  const trustedActor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || command === undefined || trustedActor === undefined) {
    return repositoryFailure(
      "rejected",
      "backtrack-with-information-rejected",
      "The session ID, backtracking command, or trusted actor is invalid.",
    );
  }
  if (command.actor.id !== trustedActor.id || command.actor.kind !== trustedActor.kind) {
    return repositoryFailure(
      "rejected",
      "backtrack-with-information-rejected",
      "The command actor does not match the trusted actor.",
    );
  }
  const commandId = command.commandId as ApplyKernelCommand["commandId"];
  const autoCloseId = backtrackAutoCloseCommandId(commandId) as ApplyKernelCommand["commandId"];
  const eventId = backtrackEventId(commandId);

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId, options.definitions);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;

      const existingInput = await transaction.readInteractionEvent(session.id, eventId);
      if (existingInput !== undefined) {
        const existing = parseInteractionEventRecord(existingInput, session, eventId);
        if (existing === undefined || existing.kind !== "backtracked-with-information") {
          return repositoryFailure(
            "rejected",
            "invalid-interaction-event-record",
            "The stored backtracking record failed runtime validation or identity checks.",
          );
        }
        return replayBacktrack(transaction, session, environment, command, existing);
      }
      for (const id of [commandId, autoCloseId]) {
        const deleted = await deletedCommandFailure(transaction, session.id, id);
        if (deleted !== undefined) return deleted;
      }
      for (const id of [commandId, autoCloseId]) {
        if ((await transaction.readCommand(session.id, id)) !== undefined) {
          return repositoryFailure(
            "rejected",
            "backtrack-with-information-conflict",
            "The command ID is already recorded for a different command.",
          );
        }
      }
      if (session.currentNodeId !== command.expectedCurrentNodeId) {
        return repositoryFailure(
          "rejected",
          "serialized-stale-command",
          "The current proof node changed before the backtracking command was applied.",
        );
      }

      const history = await loadProofHistoryInTransaction(transaction, session, environment);
      if (history.status !== "loaded") return history;
      const planned = planBacktrackWithInformation({
        rootNodeId: session.rootNodeId,
        nodes: history.nodes,
        edges: history.edges.map(({ edge }) => edge),
        operators: session.operators,
        command,
        recordIds: (id) => derivedMoveRecordIds(id as ApplyKernelCommand["commandId"]),
      });
      if (!planned.ok) return backtrackFailure(planned.diagnostics[0]);
      const { plan } = planned;

      // Prepare every step before writing anything, each against its own parent snapshot.
      let parent = history.nodes.find(({ id }) => id === plan.ancestorNodeId);
      const steps: PrepareProofCommandSuccess[] = [];
      for (const step of plan.commands) {
        if (parent === undefined) break;
        const prepared = prepareProofCommand(parent, step, {
          trustedActor,
          ...(environment.operators === undefined ? {} : { operators: environment.operators }),
          ...(environment.results === undefined ? {} : { results: environment.results }),
        });
        if (!prepared.ok) {
          return repositoryFailure(
            "rejected",
            "command-rejected",
            prepared.diagnostics[0]?.message ?? "A backtracking step was rejected.",
          );
        }
        steps.push(prepared);
        parent = prepared.prepared.node;
      }
      const caseSplitNode = steps[0]?.prepared.node;
      const finalNode = steps.at(-1)?.prepared.node;
      if (
        steps.length !== plan.commands.length ||
        caseSplitNode === undefined ||
        finalNode?.id !== plan.finalNodeId
      ) {
        return repositoryFailure(
          "rejected",
          "invalid-proof-history",
          "The backtracking plan does not start at a retained ancestor.",
        );
      }

      for (const step of steps) {
        await transaction.insertNode(session.id, step.prepared.node);
        await transaction.insertEdge(session.id, step.prepared.edge);
        await transaction.insertEvent(session.id, step.prepared.event);
        await transaction.insertCommand(session.id, step);
      }
      if (
        !(await transaction.repointCurrentNode(session.id, session.currentNodeId, finalNode.id))
      ) {
        throw new SerializedStaleCommandError();
      }
      const eligible = plan.analysis.ancestors.filter((ancestor) => ancestor.eligible);
      const event = await appendInteractionEvent(
        transaction,
        session.id,
        finalNode,
        trustedActor,
        options.now,
        {
          id: eventId,
          kind: "backtracked-with-information",
          commandId,
          sourceNodeId: plan.analysis.sourceNodeId,
          sourceTarget: plan.analysis.sourceTarget,
          proposition: plan.analysis.proposition,
          ...(command.ancestorNodeId === undefined
            ? {}
            : { requestedAncestorNodeId: command.ancestorNodeId }),
          ancestorNodeId: plan.ancestorNodeId,
          eligibleAncestorNodeIds: eligible.map(({ nodeId }) => nodeId),
          splitTarget: plan.splitTarget,
          caseSplitNodeId: caseSplitNode.id,
          ...(plan.autoClosedTarget === undefined
            ? {}
            : { autoClosedTarget: plan.autoClosedTarget }),
          focusTarget: plan.focusTarget,
        },
      );
      if (event === undefined || event.kind !== "backtracked-with-information") {
        // Throwing rolls the inserted steps back.
        throw new Error("The backtracking record failed runtime validation.");
      }
      const updatedSession = freezeDetached({ ...session, currentNodeId: finalNode.id });
      if (updatedSession === undefined) {
        throw new Error("The updated proof session could not be detached safely.");
      }
      return {
        status: "committed" as const,
        session: updatedSession,
        node: finalNode,
        receipts: steps.map(({ receipt }) => receipt),
        backtrack: event,
        replayed: false,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The backtracking command could not be applied atomically.");
  }
}

/** A retry of a recorded backtrack: the same request replays; anything else is a conflict. */
async function replayBacktrack(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  environment: ProtocolEnvironment,
  command: z.infer<typeof backtrackWithInformationCommandSchema>,
  existing: BacktrackedInteractionEvent,
): Promise<BacktrackWithInformationResult> {
  if (
    existing.commandId !== command.commandId ||
    existing.actor.id !== command.actor.id ||
    existing.actor.kind !== command.actor.kind ||
    existing.sourceNodeId !== command.sourceNodeId ||
    (command.sourceTarget !== undefined &&
      !jsonEquals(existing.sourceTarget, command.sourceTarget)) ||
    !jsonEquals(existing.proposition, command.proposition) ||
    existing.requestedAncestorNodeId !== command.ancestorNodeId
  ) {
    return repositoryFailure(
      "rejected",
      "backtrack-with-information-conflict",
      "The command ID is already recorded for a different backtracking command.",
    );
  }
  if (session.currentNodeId !== existing.nodeId) {
    return repositoryFailure(
      "rejected",
      "serialized-stale-command",
      "The recorded backtracking command was superseded by navigation or a later move.",
    );
  }
  const loadedNode = await loadNode(
    transaction,
    session,
    environment,
    existing.nodeId as ProofNode["id"],
    "current-node-not-found",
    "invalid-current-node",
  );
  if (!loadedNode.ok) return loadedNode.failure;
  const commandIds = [
    command.commandId,
    ...(existing.autoClosedTarget === undefined
      ? []
      : [backtrackAutoCloseCommandId(command.commandId)]),
  ] as ApplyKernelCommand["commandId"][];
  const receipts: ProofCommandReceipt[] = [];
  for (const id of commandIds) {
    const input = await transaction.readCommand(session.id, id);
    const recorded =
      input === undefined
        ? undefined
        : safeParse(createPrepareProofCommandSuccessSchema(environment), input);
    if (recorded === undefined || recorded.prepared.command.commandId !== id) {
      return repositoryFailure(
        "rejected",
        "invalid-command-record",
        "A recorded backtracking step failed runtime validation or identity checks.",
      );
    }
    receipts.push(recorded.receipt);
  }
  return {
    status: "committed" as const,
    session,
    node: loadedNode.node,
    receipts,
    backtrack: existing,
    replayed: true,
  };
}

function backtrackFailure(diagnostic: BacktrackDiagnostic): RepositoryFailure {
  return repositoryFailure(
    "rejected",
    diagnostic.code === "no-eligible-ancestor" || diagnostic.code === "ancestor-not-eligible"
      ? "backtrack-symbols-unavailable"
      : diagnostic.code === "invalid-history"
        ? "invalid-proof-history"
        : "backtrack-with-information-rejected",
    diagnostic.message,
  );
}

function sameIdSet(actual: readonly string[], expected: readonly string[]): boolean {
  const expectedSet = new Set(expected);
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((id) => expectedSet.has(id))
  );
}

function sortedIds(ids: readonly string[]): readonly string[] {
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** A command ID reserved by a deletion: either it issued one or its move was deleted. */
async function deletedCommandFailure(
  transaction: ProofStoreTransaction,
  sessionId: ProofSessionId,
  commandId: ApplyKernelCommand["commandId"],
): Promise<RepositoryFailure | undefined> {
  const input = await transaction.readDeletion(sessionId, commandId);
  if (input === undefined) return undefined;
  const deletion = safeParse(proofDeletionRecordSchema, input);
  if (deletion === undefined) {
    return repositoryFailure(
      "rejected",
      "invalid-deletion-record",
      "The stored deletion tombstone failed runtime validation.",
    );
  }
  return repositoryFailure(
    "rejected",
    "command-deleted",
    deletion.commandId === commandId
      ? "The command ID was used to delete a previous move."
      : "This command's move was deleted; issue a new command ID to apply it again.",
  );
}

/** Execute or replay one command while holding the session row lock. */
export async function executeProofCommand(
  store: ProofStore,
  sessionIdInput: unknown,
  commandInput: unknown,
  trustedActorInput: unknown,
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
): Promise<ExecuteProofCommandResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const trustedActor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || trustedActor === undefined) {
    return repositoryFailure(
      "rejected",
      "command-rejected",
      "The session ID or trusted actor is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const sessionInput = await transaction.lockSession(sessionId);
      if (sessionInput === undefined) {
        return repositoryFailure(
          "rejected",
          "session-not-found",
          "The proof session does not exist.",
        );
      }
      const session = safeParse(proofSessionSchema, sessionInput);
      if (session === undefined || session.id !== sessionId) {
        return repositoryFailure(
          "rejected",
          "invalid-session-record",
          "The stored proof session failed runtime validation or identity checks.",
        );
      }
      const environment = frozenEnvironment(session.operators, definitions);
      if (environment === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-session-record",
          "The stored operator environment could not be detached safely.",
        );
      }

      const commandId = commandIdFromUnknown(commandInput);
      const previousInput =
        commandId === undefined ? undefined : await transaction.readCommand(session.id, commandId);
      const previous =
        previousInput === undefined
          ? undefined
          : safeParse(createPrepareProofCommandSuccessSchema(environment), previousInput);
      if (
        previousInput !== undefined &&
        (previous === undefined || previous.prepared.command.commandId !== commandId)
      ) {
        return repositoryFailure(
          "rejected",
          "invalid-command-record",
          "The stored command result failed runtime validation or identity checks.",
        );
      }
      if (previous === undefined && commandId !== undefined) {
        const deleted = await deletedCommandFailure(transaction, session.id, commandId);
        if (deleted !== undefined) return deleted;
      }

      const suggestionSetId = suggestionSetIdFromUnknown(commandInput, "suggestionSetId");
      const suggestionSetInput =
        suggestionSetId === undefined
          ? undefined
          : await transaction.readSuggestionSet(session.id, suggestionSetId);
      if (suggestionSetId !== undefined && suggestionSetInput === undefined) {
        return repositoryFailure(
          "rejected",
          "suggestion-set-not-found",
          "The command references a suggestion set that does not exist in this session.",
        );
      }
      const suggestionSet =
        suggestionSetInput === undefined || suggestionSetId === undefined
          ? undefined
          : parseSuggestionSetRecord(suggestionSetInput, session, suggestionSetId);
      if (suggestionSetInput !== undefined && suggestionSet === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-suggestion-set-record",
          "The stored suggestion set failed runtime validation or identity checks.",
        );
      }
      const previewId = movePreviewIdFromUnknown(commandInput, "previewId");
      const previewInput =
        previewId === undefined ? undefined : await transaction.readPreview(session.id, previewId);
      if (previewId !== undefined && previewInput === undefined) {
        return repositoryFailure(
          "rejected",
          "preview-not-found",
          "The command references a move preview that does not exist in this session.",
        );
      }
      const preview =
        previewInput === undefined
          ? undefined
          : safeParse(createMovePreviewSchema(environment), previewInput);
      if (previewInput !== undefined && (preview === undefined || preview.id !== previewId)) {
        return repositoryFailure(
          "rejected",
          "invalid-preview-record",
          "The stored move preview failed runtime validation or identity checks.",
        );
      }

      const currentInput = await transaction.readNode(session.id, session.currentNodeId);
      if (currentInput === undefined) {
        return repositoryFailure(
          "rejected",
          "current-node-not-found",
          "The current proof node does not exist.",
        );
      }
      const currentNode = parseNodeRecord(
        currentInput,
        session,
        environment,
        session.currentNodeId,
      );
      if (currentNode === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-current-node",
          "The stored current proof node failed runtime validation or identity checks.",
        );
      }

      const prepared = prepareProofCommand(currentNode, commandInput, {
        trustedActor,
        ...(environment.operators === undefined ? {} : { operators: environment.operators }),
        ...(environment.results === undefined ? {} : { results: environment.results }),
        ...(previous === undefined ? {} : { previous }),
        ...(suggestionSet === undefined ? {} : { suggestionSet }),
        ...(preview === undefined ? {} : { preview }),
      });
      if (!prepared.ok) {
        const diagnostic = prepared.diagnostics[0];
        const serializedStale =
          diagnostic?.code === "stale-parent" ||
          (diagnostic?.code === "kernel-rejected" && diagnostic.message.includes("stale-state"));
        return repositoryFailure(
          "rejected",
          serializedStale ? "serialized-stale-command" : "command-rejected",
          diagnostic?.message ?? "The proof command was rejected.",
        );
      }
      if (previous !== undefined) {
        if (session.currentNodeId !== previous.prepared.node.id) {
          return repositoryFailure(
            "rejected",
            "serialized-stale-command",
            "The recorded command was superseded by navigation or a different branch.",
          );
        }
        return { status: "committed" as const, result: prepared, replayed: true };
      }

      await transaction.insertNode(session.id, prepared.prepared.node);
      await transaction.insertEdge(session.id, prepared.prepared.edge);
      await transaction.insertEvent(session.id, prepared.prepared.event);
      await transaction.insertCommand(session.id, prepared);
      const advanced = await transaction.advanceCurrentNode(
        session.id,
        currentNode.id,
        prepared.prepared.node.id,
      );
      if (!advanced) {
        throw new SerializedStaleCommandError();
      }
      return { status: "committed" as const, result: prepared, replayed: false };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The proof command transaction failed.");
  }
}

type DisplayedSuggestion = DisplayedSuggestionSet["suggestions"][number];
type ResolvedSelection = DisplayedSuggestionSet["selection"] extends infer Selection
  ? Selection extends { kind: "selection-query"; selections: readonly (infer Subject)[] }
    ? Subject extends { selection: infer Item }
      ? Item
      : never
    : Selection
  : never;

type MaterializedSuggestion =
  | Readonly<{
      ok: true;
      moveId: string;
      result: Extract<MaterializationResult, { ok: true }>;
      references: readonly DefinitionReference[];
    }>
  | Readonly<{
      ok: false;
      requiresInput: Pick<MoveRequiresInput, "menus" | "missingParameters" | "diagnostics">;
    }>
  | Readonly<{ ok: false; requiresInput?: undefined; failure: RepositoryFailure }>;

/**
 * Materialize one displayed suggestion through the moves package. A move suggestion uses its
 * matched selections as move slots; a result suggestion is applied with its retrieval evidence
 * (result, pattern direction, substitutions and the matched occurrence).
 */
function materializeSuggestion(
  node: ProofNode,
  suggestionSet: DisplayedSuggestionSet,
  suggestion: DisplayedSuggestion,
  environment: ProtocolEnvironment,
  commandId: ApplyKernelCommand["commandId"],
  menuChoices: MoveMenuChoices,
  definitions: DefinitionCatalog,
): MaterializedSuggestion {
  const idGenerator = commandIdGenerator(commandId);
  const rejected = (message: string): MaterializedSuggestion => ({
    ok: false,
    failure: repositoryFailure("rejected", "preview-rejected", message),
  });

  let moveId: string | undefined;
  let result: MaterializationResult;
  const references: DefinitionReference[] = [];
  if (suggestion.source === "move") {
    const move = definitions.moves.find((definition) => definition.id === suggestion.artifactId);
    if (move === undefined) {
      return rejected(
        "The displayed move is not available in the approved deterministic move catalog.",
      );
    }
    const selections: Record<string, MoveSelectionInput> = {};
    for (const match of suggestion.selectionMatches) {
      if (match.selectionSlotId === undefined) continue;
      const selection = resolvedSelectionById(suggestionSet, match.selectionId);
      if (selection === undefined || Object.hasOwn(selections, match.selectionSlotId)) {
        return rejected("The displayed move's selection evidence is inconsistent.");
      }
      selections[match.selectionSlotId] = moveSelectionInput(selection);
    }
    moveId = move.id;
    references.push({ kind: "move", id: move.id, hash: definitionHash(move) });
    result = materializeMoveOperation({
      state: node.state,
      move,
      selections: selections as MoveSelections,
      menuChoices,
      idGenerator,
      env: environment,
    });
  } else {
    const libraryResult = definitions
      .catalog(environment.operators ?? [])
      .results.find(({ id }) => id === suggestion.artifactId);
    const pattern = libraryResult?.patterns.find(({ id }) => id === suggestion.patternId);
    const match =
      suggestion.selectionMatches.find(({ patternId }) => patternId === suggestion.patternId) ??
      suggestion.selectionMatches[0];
    const selection =
      match === undefined ? undefined : resolvedSelectionById(suggestionSet, match.selectionId);
    if (libraryResult === undefined || pattern === undefined || selection === undefined) {
      return rejected("The displayed result is not available in the approved library catalog.");
    }
    // The matched occurrence is used only when the result is a premise-free equivalence: the
    // suggestion is then a rewrite of that occurrence rather than an application to the target.
    result = materializeResultApplication(
      {
        state: node.state,
        resultId: libraryResult.id,
        direction: pattern.direction,
        target: selection.anchor.target,
        substitutions: suggestion.substitutions,
        occurrence: moveSelectionInput(selection),
        menuChoices,
      },
      environment,
      idGenerator,
    );
    references.push({
      kind: "library-result",
      id: libraryResult.id,
      hash: definitionHash(libraryResult),
    });
    if (result.ok) {
      const kind = result.operation.kind;
      const move = definitions.moves.find(
        (definition) =>
          RESULT_APPLICATION_MOVE_IDS.includes(definition.id) &&
          definition.implementation.operationKind === kind,
      );
      moveId = move?.id;
      if (move !== undefined) {
        references.push({ kind: "move", id: move.id, hash: definitionHash(move) });
      }
    }
  }

  if (!result.ok) {
    const diagnostic = result.diagnostics[0];
    if (diagnostic.code === "requires-input") {
      const menus = safeParse(parameterMenusSchema, result.menus);
      if (menus === undefined) {
        return rejected("The generated parameter menus failed runtime validation.");
      }
      return {
        ok: false,
        requiresInput: {
          menus,
          missingParameters: [...result.missingParameters],
          diagnostics: [{ code: "requires-input", message: diagnostic.message }],
        },
      };
    }
    return rejected(diagnostic.message);
  }
  if (moveId === undefined || !suggestionAuthorizesMove(suggestion, moveId, result.operation)) {
    return rejected("The materialized operation is not authorized by the displayed suggestion.");
  }
  // Definition references are ordered by kind, then ID ("library-result" < "move").
  references.sort((left, right) =>
    left.kind === right.kind
      ? left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0
      : left.kind < right.kind
        ? -1
        : 1,
  );
  return { ok: true, moveId, result, references };
}

/**
 * The static-history record of the menus a materialization displayed and the item IDs chosen.
 * Moves whose only menus are automatic (generated IDs) and that received no choices record
 * nothing. Returns null when the menus fail the protocol schema.
 */
function recordedMenuSelection(
  menus: Extract<MaterializationResult, { ok: true }>["menus"],
  choices: MoveMenuChoices,
): MoveMenuSelection | undefined | null {
  if (Object.keys(choices).length === 0 && menus.every(({ automatic }) => automatic)) {
    return undefined;
  }
  return safeParse(moveMenuSelectionSchema, { menus, choices }) ?? null;
}

function moveSelectionInput(selection: ResolvedSelection): MoveSelectionInput {
  const anchor = {
    stateId: selection.anchor.stateId,
    target: selection.anchor.target,
    statement: selection.anchor.statement,
  };
  return selection.kind === "exact"
    ? { kind: "exact", anchor, path: [...selection.path] }
    : {
        kind: "associative",
        anchor,
        containerPath: [...selection.containerPath],
        startOperand: selection.startOperand,
        endOperand: selection.endOperand,
      };
}

function resolvedSelectionById(
  suggestionSet: DisplayedSuggestionSet,
  selectionId: string,
): ResolvedSelection | undefined {
  if (suggestionSet.selection.kind !== "selection-query") {
    return selectionId === "selection:primary"
      ? (suggestionSet.selection as ResolvedSelection)
      : undefined;
  }
  return suggestionSet.selection.selections.find(({ id }) => id === selectionId)?.selection as
    ResolvedSelection | undefined;
}

export function derivedMoveRecordIds(commandId: ApplyKernelCommand["commandId"]): Readonly<{
  previewId: MovePreviewId;
  resultStateId: ProofNode["state"]["id"];
  resultNodeId: ProofNode["id"];
  edgeId: ProofEdge["id"];
  eventId: TransitionEvent["id"];
}> {
  return {
    previewId: derivedPreviewId(commandId),
    resultStateId: derivedStateId(commandId),
    resultNodeId: `node:${commandId}` as ProofNode["id"],
    edgeId: `edge:${commandId}` as ProofEdge["id"],
    eventId: `event:${commandId}` as TransitionEvent["id"],
  };
}

function derivedPreviewId(commandId: ApplyKernelCommand["commandId"]): MovePreviewId {
  return `preview:${commandId}` as MovePreviewId;
}

function derivedStateId(commandId: ApplyKernelCommand["commandId"]): ProofNode["state"]["id"] {
  return `state:${commandId}` as ProofNode["state"]["id"];
}

function movePreviewRequestMatches(preview: MovePreview, request: unknown): boolean {
  const keys = ["id", "suggestionSetId", "chosenSuggestionId", "moveId", "operation"];
  if (!isDataRecord(request)) return false;
  if (request.menuSelection !== undefined) keys.push("menuSelection");
  if (request.definitions !== undefined) keys.push("definitions");
  return (
    isStrictDataRecord(request, keys) &&
    request.id === preview.id &&
    request.suggestionSetId === preview.suggestionSetId &&
    request.chosenSuggestionId === preview.chosenSuggestionId &&
    request.moveId === preview.moveId &&
    jsonEquals(request.operation, preview.operation) &&
    jsonEquals(request.menuSelection, preview.menuSelection) &&
    jsonEquals(request.definitions, preview.definitions)
  );
}

async function loadProofHistoryInTransaction(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  environment: ProtocolEnvironment,
): Promise<LoadProofHistoryResult> {
  const inputs = await transaction.listEdges(session.id);
  if (!Array.isArray(inputs)) {
    return repositoryFailure(
      "rejected",
      "invalid-edge-record",
      "The stored proof-edge collection is invalid.",
    );
  }
  const edges: ProofEdge[] = [];
  for (const input of inputs) {
    const edge = parseEdgeRecord(input, session, environment);
    if (edge === undefined) {
      return repositoryFailure(
        "rejected",
        "invalid-edge-record",
        "A stored proof edge failed runtime validation or relational identity checks.",
      );
    }
    edges.push(edge);
  }
  edges.sort((left, right) => left.id.localeCompare(right.id));
  if (
    new Set(edges.map(({ id }) => id)).size !== edges.length ||
    new Set(edges.map(({ childNodeId }) => childNodeId)).size !== edges.length ||
    edges.some(({ childNodeId }) => childNodeId === session.rootNodeId)
  ) {
    return repositoryFailure(
      "rejected",
      "invalid-proof-history",
      "The retained discovery history is not a rooted tree.",
    );
  }

  const byParent = new Map<string, ProofEdge[]>();
  for (const edge of edges) {
    const children = byParent.get(edge.parentNodeId) ?? [];
    children.push(edge);
    byParent.set(edge.parentNodeId, children);
  }
  byParent.forEach((children) => children.sort((left, right) => left.id.localeCompare(right.id)));
  const reachableNodeIds: string[] = [session.rootNodeId];
  const visitedNodes = new Set<string>(reachableNodeIds);
  const visitedEdges = new Set<string>();
  for (let index = 0; index < reachableNodeIds.length; index += 1) {
    const parent = reachableNodeIds[index];
    if (parent === undefined) continue;
    for (const edge of byParent.get(parent) ?? []) {
      if (visitedNodes.has(edge.childNodeId)) {
        return repositoryFailure(
          "rejected",
          "invalid-proof-history",
          "The retained discovery history contains a cycle or repeated child.",
        );
      }
      visitedEdges.add(edge.id);
      visitedNodes.add(edge.childNodeId);
      reachableNodeIds.push(edge.childNodeId);
    }
  }
  if (visitedEdges.size !== edges.length || !visitedNodes.has(session.currentNodeId)) {
    return repositoryFailure(
      "rejected",
      "invalid-proof-history",
      "The retained discovery history contains a disconnected edge or current node.",
    );
  }

  const nodes: ProofNode[] = [];
  for (const nodeId of reachableNodeIds) {
    const parsedNodeId = safeParse(proofNodeIdSchema, nodeId) as ProofNode["id"] | undefined;
    if (parsedNodeId === undefined) {
      return repositoryFailure(
        "rejected",
        "invalid-proof-history",
        "The retained discovery history contains an invalid node ID.",
      );
    }
    const loaded = await loadNode(
      transaction,
      session,
      environment,
      parsedNodeId,
      "current-node-not-found",
      "invalid-current-node",
    );
    if (!loaded.ok) return loaded.failure;
    nodes.push(loaded.node);
  }

  const historyEdges: ProofHistoryEdge[] = [];
  for (const edge of edges) {
    const parent = nodes.find(({ id }) => id === edge.parentNodeId);
    const child = nodes.find(({ id }) => id === edge.childNodeId);
    if (
      parent === undefined ||
      child === undefined ||
      edge.operation.expectedStateId !== parent.state.id ||
      edge.operation.resultStateId !== child.state.id
    ) {
      return repositoryFailure(
        "rejected",
        "invalid-proof-history",
        "A proof edge does not link its retained parent and child snapshots.",
      );
    }
    let name: string = edge.moveId ?? edge.operation.kind;
    if (edge.suggestionSetId !== undefined && edge.chosenSuggestionId !== undefined) {
      const loaded = await loadSuggestionSet(transaction, session, edge.suggestionSetId);
      if (!loaded.ok) return loaded.failure;
      const chosen = loaded.suggestionSet.suggestions.find(
        ({ id }) => id === edge.chosenSuggestionId,
      );
      if (
        chosen === undefined ||
        loaded.suggestionSet.nodeId !== edge.parentNodeId ||
        !suggestionSetMatchesNode(loaded.suggestionSet, parent, environment) ||
        !suggestionAuthorizesMove(chosen, edge.moveId, edge.operation)
      ) {
        return repositoryFailure(
          "rejected",
          "invalid-proof-history",
          "A proof edge does not match its retained chosen-suggestion evidence.",
        );
      }
      name = chosen.name;
    }
    historyEdges.push({ edge, name });
  }
  return { status: "loaded", session, nodes, edges: historyEdges };
}

function parseEdgeRecord(
  input: unknown,
  session: ProofSession,
  environment: ProtocolEnvironment,
): ProofEdge | undefined {
  if (
    !isStrictDataRecord(input, [
      "sessionId",
      "edgeId",
      "parentNodeId",
      "childNodeId",
      "commandId",
      "suggestionSetId",
      "chosenSuggestionId",
      "previewId",
      "edge",
    ])
  ) {
    return undefined;
  }
  const edge = safeParse(createProofEdgeSchema(environment), input.edge);
  if (
    edge === undefined ||
    safeParse(proofSessionIdSchema, input.sessionId) !== session.id ||
    input.edgeId !== edge.id ||
    input.parentNodeId !== edge.parentNodeId ||
    input.childNodeId !== edge.childNodeId ||
    input.commandId !== edge.commandId ||
    input.suggestionSetId !== (edge.suggestionSetId ?? null) ||
    input.chosenSuggestionId !== (edge.chosenSuggestionId ?? null) ||
    input.previewId !== (edge.previewId ?? null)
  ) {
    return undefined;
  }
  return freezeDetached(edge);
}

function commandIdFromUnknown(value: unknown): ApplyKernelCommand["commandId"] | undefined {
  try {
    if (!isDataRecord(value)) return undefined;
    return safeParse(commandIdSchema, value.commandId) as
      ApplyKernelCommand["commandId"] | undefined;
  } catch {
    return undefined;
  }
}

function suggestionSetIdFromUnknown(
  value: unknown,
  property: "id" | "suggestionSetId",
): SuggestionSetId | undefined {
  try {
    if (!isDataRecord(value)) return undefined;
    return safeParse(suggestionSetIdSchema, value[property]) as SuggestionSetId | undefined;
  } catch {
    return undefined;
  }
}

function movePreviewIdFromUnknown(
  value: unknown,
  property: "id" | "previewId",
): MovePreviewId | undefined {
  try {
    if (!isDataRecord(value)) return undefined;
    return safeParse(movePreviewIdSchema, value[property]) as MovePreviewId | undefined;
  } catch {
    return undefined;
  }
}

/** The session's operators and the approved results adapted to them, detached and frozen. */
function frozenEnvironment(
  operators: readonly OperatorDeclaration[],
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
): ProtocolEnvironment | undefined {
  try {
    createProofNodeSchema({ operators });
    const results = definitions.catalog(operators).kernelResults;
    if (results === undefined) return undefined;
    return deepFreeze({ operators: structuredClone(operators), results: structuredClone(results) });
  } catch {
    return undefined;
  }
}

type LoadedSession =
  | Readonly<{ ok: true; session: ProofSession; environment: ProtocolEnvironment }>
  | Readonly<{ ok: false; failure: RepositoryFailure }>;

async function loadSession(
  transaction: ProofStoreTransaction,
  expectedSessionId: ProofSessionId,
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
): Promise<LoadedSession> {
  const sessionInput = await transaction.lockSession(expectedSessionId);
  if (sessionInput === undefined) {
    return {
      ok: false,
      failure: repositoryFailure(
        "rejected",
        "session-not-found",
        "The proof session does not exist.",
      ),
    };
  }
  const parsed = safeParse(proofSessionSchema, sessionInput);
  if (parsed === undefined || parsed.id !== expectedSessionId) {
    return {
      ok: false,
      failure: repositoryFailure(
        "rejected",
        "invalid-session-record",
        "The stored proof session failed runtime validation or identity checks.",
      ),
    };
  }
  const environment = frozenEnvironment(parsed.operators, definitions);
  const session = freezeDetached(parsed);
  if (environment === undefined || session === undefined) {
    return {
      ok: false,
      failure: repositoryFailure(
        "rejected",
        "invalid-session-record",
        "The stored session or operator environment could not be detached safely.",
      ),
    };
  }
  return { ok: true, session, environment };
}

type LoadedNode =
  Readonly<{ ok: true; node: ProofNode }> | Readonly<{ ok: false; failure: RepositoryFailure }>;

async function loadNode(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  environment: ProtocolEnvironment,
  nodeId: ProofNode["id"],
  missingCode: RepositoryDiagnosticCode,
  invalidCode: RepositoryDiagnosticCode,
): Promise<LoadedNode> {
  const input = await transaction.readNode(session.id, nodeId);
  if (input === undefined) {
    return {
      ok: false,
      failure: repositoryFailure("rejected", missingCode, "The proof node does not exist."),
    };
  }
  const node = parseNodeRecord(input, session, environment, nodeId);
  if (node === undefined) {
    return {
      ok: false,
      failure: repositoryFailure(
        "rejected",
        invalidCode,
        "The stored proof node failed runtime validation or relational identity checks.",
      ),
    };
  }
  return { ok: true, node };
}

type LoadedSuggestionSet =
  | Readonly<{ ok: true; suggestionSet: DisplayedSuggestionSet }>
  | Readonly<{ ok: false; failure: RepositoryFailure }>;

async function loadSuggestionSet(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  suggestionSetId: SuggestionSetId,
): Promise<LoadedSuggestionSet> {
  const input = await transaction.readSuggestionSet(session.id, suggestionSetId);
  if (input === undefined) {
    return {
      ok: false,
      failure: repositoryFailure(
        "rejected",
        "suggestion-set-not-found",
        "The displayed suggestion set does not exist in this session.",
      ),
    };
  }
  const suggestionSet = parseSuggestionSetRecord(input, session, suggestionSetId);
  if (suggestionSet === undefined) {
    return {
      ok: false,
      failure: repositoryFailure(
        "rejected",
        "invalid-suggestion-set-record",
        "The stored suggestion set failed runtime validation or relational identity checks.",
      ),
    };
  }
  return { ok: true, suggestionSet };
}

function parseNodeRecord(
  input: unknown,
  session: ProofSession,
  environment: ProtocolEnvironment,
  expectedNodeId: ProofNode["id"],
): ProofNode | undefined {
  if (!isStrictDataRecord(input, ["sessionId", "nodeId", "stateId", "node"])) return undefined;
  const recordSessionId = safeParse(proofSessionIdSchema, input.sessionId);
  const recordNodeId = safeParse(proofNodeIdSchema, input.nodeId);
  const recordStateId = safeParse(stableStorageIdentifierSchema, input.stateId);
  const node = safeParse(createProofNodeSchema(environment), input.node);
  if (
    recordSessionId !== session.id ||
    recordNodeId !== expectedNodeId ||
    node === undefined ||
    node.id !== recordNodeId ||
    node.state.id !== recordStateId
  ) {
    return undefined;
  }
  return freezeDetached(node);
}

function parseSuggestionSetRecord(
  input: unknown,
  session: ProofSession,
  expectedSuggestionSetId: SuggestionSetId,
): DisplayedSuggestionSet | undefined {
  if (
    !isStrictDataRecord(input, [
      "sessionId",
      "suggestionSetId",
      "nodeId",
      "stateId",
      "suggestionSet",
    ])
  ) {
    return undefined;
  }
  const recordSessionId = safeParse(proofSessionIdSchema, input.sessionId);
  const recordSuggestionSetId = safeParse(suggestionSetIdSchema, input.suggestionSetId);
  const recordNodeId = safeParse(proofNodeIdSchema, input.nodeId);
  const recordStateId = safeParse(stableStorageIdentifierSchema, input.stateId);
  const suggestionSet = safeParse(displayedSuggestionSetSchema, input.suggestionSet);
  if (
    recordSessionId !== session.id ||
    recordSuggestionSetId !== expectedSuggestionSetId ||
    suggestionSet === undefined ||
    suggestionSet.id !== recordSuggestionSetId ||
    suggestionSet.nodeId !== recordNodeId ||
    suggestionSet.stateId !== recordStateId
  ) {
    return undefined;
  }
  return freezeDetached(suggestionSet);
}

function transactionFailure(error: unknown, fallbackMessage: string): RepositoryFailure {
  // Stores wrap callback failures in a rolled-back error; the stale-pointer cause stays meaningful.
  const staleCause =
    error instanceof ProofStoreTransactionError &&
    error.outcome === "rolled-back" &&
    error.cause instanceof SerializedStaleCommandError
      ? error.cause
      : undefined;
  if (staleCause !== undefined) {
    return repositoryFailure("rejected", "serialized-stale-command", staleCause.message);
  }
  if (error instanceof SerializedStaleCommandError) {
    return repositoryFailure("rejected", "serialized-stale-command", error.message);
  }
  if (error instanceof ProofStoreTransactionError && error.outcome === "commit-unknown") {
    return repositoryFailure("uncertain", "commit-unknown", error.message);
  }
  return repositoryFailure(
    "rejected",
    "storage-failure",
    error instanceof Error ? error.message : fallbackMessage,
  );
}

function freezeDetached<Value>(value: Value): Value | undefined {
  try {
    return deepFreeze(structuredClone(value) as Value);
  } catch {
    return undefined;
  }
}

function repositoryFailure<Status extends "rejected" | "uncertain">(
  status: Status,
  code: RepositoryDiagnosticCode,
  message: string,
): Readonly<{ status: Status; diagnostics: readonly [RepositoryDiagnostic] }> {
  return { status, diagnostics: [{ code, message }] };
}

function safeParse<Output>(schema: z.ZodType<Output>, value: unknown): Output | undefined {
  try {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function isDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.enumerable && "value" in descriptor,
  );
}

function isStrictDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (!isDataRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => typeof key === "string" && expectedKeys.includes(key))
  );
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index]))
    );
  }
  if (!isDataRecord(left) || !isDataRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonEquals(left[key], right[key]))
  );
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
