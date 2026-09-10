import {
  actorSchema,
  commandIdSchema,
  createPrepareProofCommandSuccessSchema,
  createMovePreviewSchema,
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  prepareDisplayedSuggestionSet,
  prepareMovePreview,
  prepareProofCommand,
  movePreviewIdSchema,
  proofNodeIdSchema,
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

export type RecordMovePreviewResult =
  | Readonly<{
      status: "committed";
      preview: MovePreview;
      replayed: boolean;
    }>
  | RepositoryFailure;

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

/** Run retrieval once and atomically retain the exact ordered evidence that was displayed. */
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

      const existingInput = await transaction.readSuggestionSet(session.id, suggestionSetId);
      if (existingInput !== undefined) {
        const existing = safeParse(displayedSuggestionSetSchema, existingInput);
        if (existing === undefined || existing.id !== suggestionSetId) {
          return repositoryFailure(
            "rejected",
            "invalid-suggestion-set-record",
            "The stored suggestion set failed runtime validation or identity checks.",
          );
        }
        const detached = freezeDetached(existing);
        return detached === undefined
          ? repositoryFailure(
              "rejected",
              "invalid-suggestion-set-record",
              "The stored suggestion set could not be detached safely.",
            )
          : { status: "committed" as const, suggestionSet: detached, replayed: true };
      }

      const currentInput = await transaction.readNode(session.id, session.currentNodeId);
      if (currentInput === undefined) {
        return repositoryFailure(
          "rejected",
          "current-node-not-found",
          "The current proof node does not exist.",
        );
      }
      const currentNode = safeParse(createProofNodeSchema(environment), currentInput);
      if (currentNode === undefined || currentNode.id !== session.currentNodeId) {
        return repositoryFailure(
          "rejected",
          "invalid-current-node",
          "The stored current proof node failed runtime validation or identity checks.",
        );
      }

      const prepared = prepareDisplayedSuggestionSet(index, currentNode, requestInput, environment);
      if (!prepared.ok) {
        return repositoryFailure(
          "rejected",
          "suggestion-set-rejected",
          prepared.diagnostics[0]?.message ?? "The suggestion request was rejected.",
        );
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
        if (existing === undefined || existing.id !== previewId) {
          return repositoryFailure(
            "rejected",
            "invalid-preview-record",
            "The stored move preview failed runtime validation or identity checks.",
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
      const suggestionSet = safeParse(displayedSuggestionSetSchema, suggestionSetInput);
      if (suggestionSet === undefined || suggestionSet.id !== suggestionSetId) {
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
      const currentNode = safeParse(createProofNodeSchema(environment), currentInput);
      if (currentNode === undefined || currentNode.id !== session.currentNodeId) {
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
        suggestionSetInput === undefined
          ? undefined
          : safeParse(displayedSuggestionSetSchema, suggestionSetInput);
      if (
        suggestionSetInput !== undefined &&
        (suggestionSet === undefined || suggestionSet.id !== suggestionSetId)
      ) {
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
      const currentNode = safeParse(createProofNodeSchema(environment), currentInput);
      if (currentNode === undefined || currentNode.id !== session.currentNodeId) {
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

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
