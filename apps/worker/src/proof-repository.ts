import {
  actorSchema,
  commandIdSchema,
  createPrepareProofCommandSuccessSchema,
  createMovePreviewSchema,
  createProofEdgeSchema,
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  prepareDisplayedSuggestionSet,
  prepareMovePreview,
  prepareProofCommand,
  movePreviewIdSchema,
  kernelOperationAdapterSchema,
  proofNodeIdSchema,
  suggestionIdSchema,
  suggestionSetMatchesNode,
  suggestionSetIdSchema,
  type ApplyKernelCommand,
  type DisplayedSuggestionSet,
  type MovePreview,
  type MovePreviewId,
  type PrepareProofCommandSuccess,
  type ProofEdge,
  type ProofNode,
  type ProtocolEnvironment,
  type SuggestionSetId,
  type TransitionEvent,
} from "@proof/protocol";
import { HAND_AUTHORED_MOVES, type MoveDefinition } from "@proof/moves";
import type { RetrievalIndex } from "@proof/retrieval";
import { z } from "zod";

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
}>;

export const proofSessionSchema: z.ZodType<ProofSession> = z
  .object({
    id: proofSessionIdSchema,
    rootNodeId: proofNodeIdSchema,
    currentNodeId: proofNodeIdSchema,
    operators: operatorEnvironmentSchema,
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
}

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
  | "serialized-stale-command"
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
    }>
  | RepositoryFailure;

export type MaterializeMoveChoiceResult =
  Readonly<{ status: "materialized"; request: MaterializedMovePreviewRequest }> | RepositoryFailure;

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

export const moveChoiceSchema = z
  .object({
    commandId: commandIdSchema,
    suggestionSetId: suggestionSetIdSchema,
    chosenSuggestionId: suggestionIdSchema,
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
}>;

const initializeInputSchema = z
  .object({
    sessionId: proofSessionIdSchema,
    rootNode: z.unknown(),
    operators: operatorEnvironmentSchema.optional(),
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
 * Resolve a persisted applicable move choice to its trusted primitive request.
 * IDs and operation parameters that require no user judgment are derived from the command ID.
 */
export async function materializeMoveChoice(
  store: ProofStore,
  sessionIdInput: unknown,
  choiceInput: unknown,
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
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;
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
      if (chosen.source !== "move" || chosen.applicability !== "applicable") {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          chosen.source !== "move"
            ? "Only displayed move suggestions can be previewed as kernel operations."
            : "This move still requires user input and cannot be previewed yet.",
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

      const move = HAND_AUTHORED_MOVES.find((definition) => definition.id === chosen.artifactId);
      if (move === undefined) {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          "The displayed move is not available in the approved deterministic move catalog.",
        );
      }
      const operation = materializeKernelOperation(
        loadedParentNode.node,
        suggestionSet,
        chosen,
        move,
        choice.commandId,
      );
      if (operation === undefined) {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          "The persisted choice could not be converted to a complete trusted kernel operation.",
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
      const request: MaterializedMovePreviewRequest = {
        id: previewId,
        suggestionSetId: suggestionSet.id,
        chosenSuggestionId,
        moveId: move.id,
        operation,
      };
      if (existingInput !== undefined) {
        const existing = safeParse(createMovePreviewSchema(environment), existingInput);
        if (existing === undefined || !movePreviewRequestMatches(existing, request)) {
          return repositoryFailure(
            "rejected",
            "preview-rejected",
            "The command ID is already linked to different or invalid move-preview evidence.",
          );
        }
      }
      return {
        status: "materialized" as const,
        request,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The move choice could not be materialized.");
  }
}

/** Persist one concrete move preview without advancing the proof session. */
export async function recordMovePreview(
  store: ProofStore,
  sessionIdInput: unknown,
  requestInput: unknown,
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
      const environment = frozenEnvironment(session.operators);
      if (environment === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-session-record",
          "The stored operator environment could not be detached safely.",
        );
      }

      const existingInput = await transaction.readPreview(session.id, previewId);
      if (existingInput !== undefined) {
        const existing = safeParse(createMovePreviewSchema(environment), existingInput);
        if (
          existing === undefined ||
          existing.id !== previewId ||
          !movePreviewRequestMatches(existing, requestInput)
        ) {
          return repositoryFailure(
            "rejected",
            "invalid-preview-record",
            "The stored move preview failed validation or the preview ID was reused for a different request.",
          );
        }
        const detached = freezeDetached(existing);
        return detached === undefined
          ? repositoryFailure(
              "rejected",
              "invalid-preview-record",
              "The stored move preview could not be detached safely.",
            )
          : { status: "committed" as const, preview: detached, replayed: true };
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

      const prepared = prepareMovePreview(currentNode, suggestionSet, requestInput, environment);
      if (!prepared.ok) {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          prepared.diagnostics[0]?.message ?? "The move preview was rejected.",
        );
      }
      await transaction.insertPreview(session.id, prepared.preview);
      return { status: "committed" as const, preview: prepared.preview, replayed: false };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The move-preview transaction failed.");
  }
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

/** Execute or replay one command while holding the session row lock. */
export async function executeProofCommand(
  store: ProofStore,
  sessionIdInput: unknown,
  commandInput: unknown,
  trustedActorInput: unknown,
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
      const environment = frozenEnvironment(session.operators);
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

function materializeKernelOperation(
  node: ProofNode,
  suggestionSet: DisplayedSuggestionSet,
  suggestion: DisplayedSuggestion,
  move: MoveDefinition,
  commandId: ApplyKernelCommand["commandId"],
): MovePreview["operation"] | undefined {
  const selectionsBySlot = new Map<string, ResolvedSelection>();
  for (const match of suggestion.selectionMatches) {
    if (match.selectionSlotId === undefined) continue;
    const selection = resolvedSelectionById(suggestionSet, match.selectionId);
    if (selection === undefined || selectionsBySlot.has(match.selectionSlotId)) return undefined;
    selectionsBySlot.set(match.selectionSlotId, selection);
  }
  const targetSelection = selectionsBySlot.get("target");
  if (targetSelection === undefined) return undefined;
  const common = {
    expectedStateId: node.state.id,
    resultStateId: derivedStateId(commandId),
    target: targetSelection.anchor.target,
  };
  const hypothesisId = (slotId: string): string | undefined => {
    const statement = selectionsBySlot.get(slotId)?.anchor.statement;
    return statement?.kind === "hypothesis" ? statement.id : undefined;
  };
  const operandCount = (slotId: string): number | undefined =>
    mathJsonOperandCount(selectionsBySlot.get(slotId)?.fragment);
  const generatedIds = (label: string, count: number): readonly string[] =>
    Array.from(
      { length: count },
      (_unused, index) => `statement:${commandId}:${label}:${index + 1}`,
    );

  let candidate: unknown;
  switch (move.implementation.operationKind) {
    case "close-by-hypothesis": {
      const factId = hypothesisId("fact");
      if (factId === undefined) return undefined;
      candidate = { ...common, kind: "close-by-hypothesis", hypothesisId: factId };
      break;
    }
    case "close-true":
      candidate = { ...common, kind: "close-true" };
      break;
    case "close-false-hypothesis": {
      const falseId = hypothesisId("false");
      if (falseId === undefined) return undefined;
      candidate = { ...common, kind: "close-false-hypothesis", hypothesisId: falseId };
      break;
    }
    case "introduce-implication":
      candidate = {
        ...common,
        kind: "introduce-implication",
        hypothesisId: generatedIds("hypothesis", 1)[0],
      };
      break;
    case "introduce-negation":
      candidate = {
        ...common,
        kind: "introduce-negation",
        hypothesisId: generatedIds("hypothesis", 1)[0],
      };
      break;
    case "split-goal-conjunction": {
      const count = mathJsonOperandCount(selectedStatementExpression(node, targetSelection));
      if (count === undefined) return undefined;
      candidate = {
        ...common,
        kind: "split-goal-conjunction",
        childIds: generatedIds("child", count),
      };
      break;
    }
    case "expand-hypothesis-conjunction": {
      const sourceId = hypothesisId("conjunction");
      const count = operandCount("conjunction");
      if (sourceId === undefined || count === undefined) return undefined;
      candidate = {
        ...common,
        kind: "expand-hypothesis-conjunction",
        hypothesisId: sourceId,
        expandedHypothesisIds: generatedIds("expanded-hypothesis", count),
      };
      break;
    }
    case "split-hypothesis-disjunction": {
      const sourceId = hypothesisId("disjunction");
      const count = operandCount("disjunction");
      if (sourceId === undefined || count === undefined) return undefined;
      candidate = {
        ...common,
        kind: "split-hypothesis-disjunction",
        hypothesisId: sourceId,
        childIds: generatedIds("child", count),
        branchHypothesisIds: generatedIds("branch-hypothesis", count),
      };
      break;
    }
    case "apply-implication-hypothesis": {
      const implicationId = hypothesisId("implication");
      const antecedentId = hypothesisId("antecedent");
      if (implicationId === undefined || antecedentId === undefined) return undefined;
      candidate = {
        ...common,
        kind: "apply-implication-hypothesis",
        implicationHypothesisId: implicationId,
        antecedentHypothesisId: antecedentId,
        resultHypothesisId: generatedIds("result-hypothesis", 1)[0],
      };
      break;
    }
    case "introduce-universal":
      candidate = { ...common, kind: "introduce-universal" };
      break;
    case "unpack-existential-hypothesis": {
      const sourceId = hypothesisId("existential");
      if (sourceId === undefined) return undefined;
      candidate = {
        ...common,
        kind: "unpack-existential-hypothesis",
        hypothesisId: sourceId,
        resultHypothesisId: generatedIds("result-hypothesis", 1)[0],
      };
      break;
    }
    case "choose-goal-disjunct":
    case "instantiate-universal-hypothesis":
    case "choose-existential-witness":
    case "rewrite-with-equality":
      return undefined;
  }
  return safeParse(kernelOperationAdapterSchema, candidate);
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

function mathJsonOperandCount(value: unknown): number | undefined {
  const fn = Array.isArray(value)
    ? value
    : isDataRecord(value) && Array.isArray(value.fn)
      ? value.fn
      : undefined;
  return fn !== undefined && fn.length >= 3 ? fn.length - 1 : undefined;
}

function selectedStatementExpression(
  node: ProofNode,
  selection: ResolvedSelection,
): unknown | undefined {
  const target =
    selection.anchor.target.kind === "goal"
      ? node.state.goals.find(({ id }) => id === selection.anchor.target.id)
      : node.state.obligations.find(({ id }) => id === selection.anchor.target.id);
  if (target === undefined) return undefined;
  const statement = selection.anchor.statement;
  if (statement.kind === "conclusion") {
    return target.sequent.conclusion.expression;
  }
  return target.sequent.context.hypotheses.find(({ id }) => id === statement.id)?.statement
    .expression;
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
  return (
    isStrictDataRecord(request, [
      "id",
      "suggestionSetId",
      "chosenSuggestionId",
      "moveId",
      "operation",
    ]) &&
    request.id === preview.id &&
    request.suggestionSetId === preview.suggestionSetId &&
    request.chosenSuggestionId === preview.chosenSuggestionId &&
    request.moveId === preview.moveId &&
    jsonEquals(request.operation, preview.operation)
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
        (edge.moveId !== undefined && chosen.artifactId !== edge.moveId)
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

function frozenEnvironment(
  operators: readonly OperatorDeclaration[],
): ProtocolEnvironment | undefined {
  try {
    createProofNodeSchema({ operators });
    return deepFreeze({ operators: structuredClone(operators) });
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
  const environment = frozenEnvironment(parsed.operators);
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
