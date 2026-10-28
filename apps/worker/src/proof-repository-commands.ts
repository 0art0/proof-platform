// Executing one proof command through the validated command service.

import {
  actorSchema,
  constantActivationSchema,
  createPrepareProofCommandSuccessSchema,
  createMovePreviewSchema,
  prepareProofCommand,
  type Actor,
  type ConstantActivation,
  type PrepareProofCommandSuccess,
} from "@proof/protocol";
import { extendOperators, stepConstants, type StepConstants } from "./session-constants";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "./approved-catalog";
import {
  proofSessionIdSchema,
  type ProofSessionId,
  type ProofStoreTransaction,
  type ProofStore,
} from "./proof-repository-store";
import {
  SerializedStaleCommandError,
  type RepositoryFailure,
  repositoryFailure,
  safeParse,
  isDataRecord,
  transactionFailure,
} from "./proof-repository-core";
import {
  readSessionRecord,
  parseNodeRecord,
  parseSuggestionSetRecord,
  frozenEnvironment,
  commandIdFromUnknown,
  suggestionSetIdFromUnknown,
  movePreviewIdFromUnknown,
  deletedCommandFailure,
  sequenceCommands,
} from "./proof-repository-records";

export type ExecuteProofCommandResult =
  | Readonly<{
      status: "committed";
      result: PrepareProofCommandSuccess;
      replayed: boolean;
      /** Library constants this command activated, in the same transaction (absent when none). */
      activations?: readonly ConstantActivation[];
    }>
  | RepositoryFailure;

/** Execute or replay one command while holding the session row lock. */
export async function executeProofCommand(
  store: ProofStore,
  sessionIdInput: unknown,
  commandInput: unknown,
  trustedActorInput: unknown,
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
  options: StepOptions = {},
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
    return await store.transaction((transaction) =>
      executeProofCommandWithin(
        transaction,
        sessionId,
        commandInput,
        trustedActor,
        definitions,
        options,
      ),
    );
  } catch (error: unknown) {
    return transactionFailure(error, "The proof command transaction failed.");
  }
}

/**
 * Execute or replay one command inside the caller's transaction, taking the session row lock. A
 * rejection writes nothing; the caller's transaction commits or rolls back what it holds.
 */
export async function executeProofCommandWithin(
  transaction: ProofStoreTransaction,
  sessionId: ProofSessionId,
  commandInput: unknown,
  trustedActor: Actor,
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
  options: StepOptions = {},
): Promise<ExecuteProofCommandResult> {
  const record = await readSessionRecord(transaction, sessionId);
  if (!record.ok) return record.failure;
  const { session, activations } = record;
  // A step that applies a library result using a constant the session has not activated is
  // validated in the operators extended with it; the activation is recorded below, in this
  // transaction and before the step, only if the step is accepted.
  const step = stepConstants(
    definitions,
    session.operators,
    isDataRecord(commandInput) ? commandInput.operation : undefined,
  );
  const environment = frozenEnvironment(
    step === undefined ? session.operators : extendOperators(session.operators, step.constants),
    definitions,
  );
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
  const currentNode = parseNodeRecord(currentInput, session, environment, session.currentNodeId);
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
    ...(environment.moves === undefined ? {} : { moves: environment.moves }),
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

  const [sequenced] = await sequenceCommands(transaction, session.id, environment, [prepared]);
  if (sequenced === undefined) throw new Error("The command could not be sequenced.");
  const activated = await recordActivations(
    transaction,
    session.id,
    activations.length,
    [{ step, prepared: sequenced }],
    options.now,
  );
  await transaction.insertNode(session.id, sequenced.prepared.node);
  await transaction.insertEdge(session.id, sequenced.prepared.edge);
  await transaction.insertEvent(session.id, sequenced.prepared.event);
  await transaction.insertCommand(session.id, sequenced);
  const advanced = await transaction.advanceCurrentNode(
    session.id,
    currentNode.id,
    sequenced.prepared.node.id,
  );
  if (!advanced) {
    throw new SerializedStaleCommandError();
  }
  return {
    status: "committed" as const,
    result: sequenced,
    replayed: false,
    ...(activated.length === 0 ? {} : { activations: activated }),
  };
}

/** Options of the steps that commit commands (the clock records when constants activate). */
export type StepOptions = Readonly<{ now?: (() => Date) | undefined }>;

/**
 * Append the constant activations of committed steps, in the order of the steps. Called in the
 * storing transaction, under the session lock, after the steps are prepared and sequenced and
 * before their rows are inserted: a rejected step never reaches it, and an activation never exists
 * without the step that caused it. Each record names the step by command, edge and node IDs and
 * by transition sequence, and the library result it applied.
 */
export async function recordActivations(
  transaction: ProofStoreTransaction,
  sessionId: ProofSessionId,
  existing: number,
  entries: readonly Readonly<{
    step: StepConstants | undefined;
    prepared: PrepareProofCommandSuccess;
  }>[],
  now: (() => Date) | undefined,
): Promise<readonly ConstantActivation[]> {
  const activatedAt = (now?.() ?? new Date()).toISOString();
  const recorded: ConstantActivation[] = [];
  for (const { step, prepared } of entries) {
    if (step === undefined) continue;
    const transitionSequence = prepared.prepared.edge.sequence;
    if (transitionSequence === undefined) {
      throw new Error("A step that activates constants must be sequenced.");
    }
    for (const declaration of step.constants) {
      const activation = safeParse(constantActivationSchema, {
        sequence: existing + recorded.length + 1,
        symbol: declaration.symbol,
        declaration,
        commandId: prepared.prepared.command.commandId,
        edgeId: prepared.prepared.edge.id,
        nodeId: prepared.prepared.node.id,
        resultId: step.resultId,
        transitionSequence,
        activatedAt,
      });
      if (activation === undefined) {
        // Throwing rolls the transaction back: nothing of the step is recorded.
        throw new Error("The constant activation failed runtime validation.");
      }
      await transaction.insertConstantActivation(sessionId, activation);
      recorded.push(activation);
    }
  }
  return recorded;
}
