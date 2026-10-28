// Multi-step execution: macro previews and proposal plans.

import {
  actorSchema,
  createPrepareProofCommandSuccessSchema,
  createMovePreviewSchema,
  prepareProofCommand,
  type ApplyKernelCommand,
  type ConstantActivation,
  type MovePreviewId,
  type PrepareProofCommandSuccess,
  type ProposalLink,
  type ProofNode,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { sequenceConstants, type StepConstants } from "./session-constants";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "./approved-catalog";
import {
  proofSessionIdSchema,
  type ProofSessionId,
  type OperatorDeclaration,
  type ProofStore,
} from "./proof-repository-store";
import {
  SerializedStaleCommandError,
  type RepositoryFailure,
  repositoryFailure,
  safeParse,
  jsonEquals,
  transactionFailure,
} from "./proof-repository-core";
import {
  loadSession,
  parseNodeRecord,
  frozenEnvironment,
  deletedCommandFailure,
  sequenceCommands,
  derivedMoveRecordIds,
} from "./proof-repository-records";
import { type StepOptions, recordActivations } from "./proof-repository-commands";

/** The command ID of one step of a macro application. */
export function macroStepCommandId(
  commandId: ApplyKernelCommand["commandId"],
  index: number,
): ApplyKernelCommand["commandId"] {
  return `${commandId}:macro:${index}` as ApplyKernelCommand["commandId"];
}

export type ExecuteMacroResult =
  | Readonly<{
      status: "committed";
      /** One prepared result per step, in order; the last holds the node the cursor is at. */
      results: readonly PrepareProofCommandSuccess[];
      replayed: boolean;
      /** Library constants the steps activated, in the same transaction (absent when none). */
      activations?: readonly ConstantActivation[];
    }>
  | RepositoryFailure;

/**
 * Apply a stored macro preview (roadmap N35) as a sequence of ordinary validated commands in ONE
 * transaction. Step `i` is `apply-kernel-operation` command `<commandId>:macro:<i>`, prepared by
 * `prepareProofCommand` against the node step `i-1` created, so every step creates a fresh
 * node, edge, event and command record. The edges carry the macro link (macro move ID, preview ID
 * and step index). Any failing step records nothing. A retry with the same command ID replays the
 * recorded steps; a cursor that moved on is a stale-command conflict.
 */
export async function executeMacroPreview(
  store: ProofStore,
  sessionIdInput: unknown,
  input: Readonly<{ commandId: ApplyKernelCommand["commandId"]; previewId: MovePreviewId }>,
  trustedActorInput: unknown,
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
  options: StepOptions = {},
): Promise<ExecuteMacroResult> {
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
      const loadedSession = await loadSession(transaction, sessionId, definitions);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment, activations } = loadedSession;
      const previewInput = await transaction.readPreview(session.id, input.previewId);
      if (previewInput === undefined) {
        return repositoryFailure(
          "rejected",
          "preview-not-found",
          "The command references a move preview that does not exist in this session.",
        );
      }
      const preview = safeParse(createMovePreviewSchema(environment), previewInput);
      if (preview === undefined || preview.id !== input.previewId || preview.macro === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-preview-record",
          "The stored preview is not a valid macro preview.",
        );
      }
      const { steps } = preview.macro;
      const stepCommandId = (index: number) => macroStepCommandId(input.commandId, index);
      const scopes = stepScopes(
        definitions,
        session.operators,
        steps.map(({ operation }) => operation),
        environment,
      );
      if (scopes === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-session-record",
          "The operator environment of the macro's steps could not be detached safely.",
        );
      }
      const contextFor = (index: number) => ({
        trustedActor,
        ...scopes.environments[index],
      });
      const commandFor = (index: number, parentNodeId: ProofNode["id"]) => {
        const step = steps[index];
        const id = stepCommandId(index + 1);
        const ids = derivedMoveRecordIds(id);
        return {
          commandId: id,
          kind: "apply-kernel-operation",
          actor: trustedActor,
          parentNodeId,
          resultNodeId: ids.resultNodeId,
          edgeId: ids.edgeId,
          eventId: ids.eventId,
          moveId: step?.moveId,
          operation: step?.operation,
          macro: {
            moveId: preview.moveId,
            previewId: preview.id,
            stepIndex: index + 1,
            stepCount: steps.length,
            stepId: step?.id,
          },
        };
      };

      const firstId = stepCommandId(1);
      if ((await transaction.readCommand(session.id, firstId)) !== undefined) {
        // A retry: every recorded step must reproduce, and the cursor must still be at the end.
        const results: PrepareProofCommandSuccess[] = [];
        let parent: ProofNode["id"] = preview.nodeId;
        for (const [index] of steps.entries()) {
          const recordedInput = await transaction.readCommand(session.id, stepCommandId(index + 1));
          const recorded =
            recordedInput === undefined
              ? undefined
              : safeParse(createPrepareProofCommandSuccessSchema(environment), recordedInput);
          if (recorded === undefined) {
            return repositoryFailure(
              "rejected",
              "invalid-command-record",
              "A recorded macro step failed runtime validation or is missing.",
            );
          }
          const replayed = prepareProofCommand(
            recorded.prepared.parent,
            commandFor(index, parent),
            { ...contextFor(index), previous: recorded },
          );
          if (!replayed.ok) {
            return repositoryFailure(
              "rejected",
              "command-rejected",
              `Macro step ${index + 1} of ${steps.length} conflicts with the recorded application: ${replayed.diagnostics[0].message}`,
            );
          }
          results.push(replayed);
          parent = replayed.prepared.node.id;
        }
        if (session.currentNodeId !== results.at(-1)?.prepared.node.id) {
          return repositoryFailure(
            "rejected",
            "serialized-stale-command",
            "The recorded macro application was superseded by navigation or a later move.",
          );
        }
        return { status: "committed" as const, results, replayed: true };
      }

      for (const id of [input.commandId, firstId]) {
        const deleted = await deletedCommandFailure(transaction, session.id, id);
        if (deleted !== undefined) return deleted;
      }
      if (session.currentNodeId !== preview.nodeId) {
        return repositoryFailure(
          "rejected",
          "serialized-stale-command",
          "The current proof node changed before the macro was applied.",
        );
      }
      const currentInput = await transaction.readNode(session.id, session.currentNodeId);
      const currentNode =
        currentInput === undefined
          ? undefined
          : parseNodeRecord(currentInput, session, environment, session.currentNodeId);
      if (currentNode === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-current-node",
          "The stored current proof node is missing or failed validation.",
        );
      }
      const results: PrepareProofCommandSuccess[] = [];
      let node = currentNode;
      for (const [index] of steps.entries()) {
        if ((await transaction.readCommand(session.id, stepCommandId(index + 1))) !== undefined) {
          return repositoryFailure(
            "rejected",
            "command-rejected",
            "A macro step's command ID is already recorded.",
          );
        }
        const prepared = prepareProofCommand(node, commandFor(index, node.id), contextFor(index));
        if (!prepared.ok) {
          return repositoryFailure(
            "rejected",
            "macro-step-failed",
            `Macro step ${index + 1} of ${steps.length} was rejected: ${prepared.diagnostics[0].message}`,
          );
        }
        results.push(prepared);
        node = prepared.prepared.node;
      }
      if (!jsonEquals(node.state, preview.afterState)) {
        return repositoryFailure(
          "rejected",
          "command-rejected",
          "The macro's final state differs from its stored preview.",
        );
      }
      const sequencedResults = await sequenceCommands(
        transaction,
        session.id,
        scopes.final,
        results,
      );
      const activated = await recordActivations(
        transaction,
        session.id,
        activations.length,
        sequencedResults.map((prepared, index) => ({ step: scopes.perStep[index], prepared })),
        options.now,
      );
      for (const result of sequencedResults) {
        await transaction.insertNode(session.id, result.prepared.node);
        await transaction.insertEdge(session.id, result.prepared.edge);
        await transaction.insertEvent(session.id, result.prepared.event);
        await transaction.insertCommand(session.id, result);
      }
      if (!(await transaction.repointCurrentNode(session.id, currentNode.id, node.id))) {
        throw new SerializedStaleCommandError();
      }
      return {
        status: "committed" as const,
        results: sequencedResults,
        replayed: false,
        ...(activated.length === 0 ? {} : { activations: activated }),
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The macro could not be applied atomically.");
  }
}

/** The command ID of one step (1-based) of a confirmed move-executor plan. */
export function proposalStepCommandId(
  prefix: string,
  index: number,
): ApplyKernelCommand["commandId"] {
  return `${prefix}:step:${index}` as ApplyKernelCommand["commandId"];
}

/**
 * Whether every step of a confirmed move-executor plan is still a recorded command of the session,
 * each naming the stored call as its proposal. A plan that was only previewed, a plan of another
 * session, and a plan whose moves were deleted since all answer false.
 */
export async function proposalPlanApplied(
  store: ProofStore,
  sessionIdInput: unknown,
  input: Readonly<{ commandIdPrefix: string; callId: string; stepCount: number }>,
): Promise<boolean> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  if (sessionId === undefined || input.stepCount < 1 || input.stepCount > 16) return false;
  try {
    return await store.transaction(async (transaction) => {
      for (let index = 1; index <= input.stepCount; index += 1) {
        const record = (await transaction.readCommand(
          sessionId,
          proposalStepCommandId(input.commandIdPrefix, index),
        )) as { prepared?: { command?: { proposal?: Record<string, unknown> } } } | undefined;
        const proposal = record?.prepared?.command?.proposal;
        if (
          proposal?.["callId"] !== input.callId ||
          proposal["role"] !== "move-executor" ||
          proposal["stepIndex"] !== index ||
          proposal["stepCount"] !== input.stepCount
        ) {
          return false;
        }
      }
      return true;
    });
  } catch {
    return false;
  }
}

export type ExecuteProposalPlanInput = Readonly<{
  /** The step command IDs are `<prefix>:step:<i>`; a retry with the same prefix replays. */
  commandIdPrefix: string;
  /** The node the plan was previewed at, which must still be the session's current node. */
  expectedCurrentNodeId: ProofNode["id"];
  /** Concrete kernel operations, chained from that node's state. */
  operations: readonly unknown[];
  proposal: Readonly<Pick<ProposalLink, "source" | "callId">>;
}>;

/**
 * Commit a confirmed move-executor plan (architecture §5) as a sequence of ordinary raw
 * `apply-kernel-operation` commands in ONE transaction, the way a macro's steps are committed. Step
 * `i` is command `<prefix>:step:<i>`, prepared by `prepareProofCommand` against the node step
 * `i-1` created, so the kernel validates every step on its own and each step creates a fresh
 * node, edge, event and command record. Every command carries the proposal link naming the stored
 * LLM call. A failing step records nothing. A retry with the same prefix replays the recorded
 * steps; a cursor that moved on is a stale-command conflict.
 */
export async function executeProposalPlan(
  store: ProofStore,
  sessionIdInput: unknown,
  input: ExecuteProposalPlanInput,
  trustedActorInput: unknown,
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
  options: StepOptions = {},
): Promise<ExecuteMacroResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const trustedActor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || trustedActor === undefined) {
    return repositoryFailure(
      "rejected",
      "command-rejected",
      "The session ID or trusted actor is invalid.",
    );
  }
  const stepCount = input.operations.length;
  if (stepCount < 1 || stepCount > 16) {
    return repositoryFailure(
      "rejected",
      "command-rejected",
      "A confirmed plan has between 1 and 16 steps.",
    );
  }
  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId, definitions);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment, activations } = loadedSession;
      const stepCommandId = (index: number) => proposalStepCommandId(input.commandIdPrefix, index);
      const scopes = stepScopes(definitions, session.operators, input.operations, environment);
      if (scopes === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-session-record",
          "The operator environment of the plan's steps could not be detached safely.",
        );
      }
      const contextFor = (index: number) => ({
        trustedActor,
        ...scopes.environments[index],
      });
      const commandFor = (index: number, parentNodeId: ProofNode["id"]) => {
        const id = stepCommandId(index + 1);
        const ids = derivedMoveRecordIds(id);
        return {
          commandId: id,
          kind: "apply-kernel-operation",
          actor: trustedActor,
          parentNodeId,
          resultNodeId: ids.resultNodeId,
          edgeId: ids.edgeId,
          eventId: ids.eventId,
          operation: input.operations[index],
          proposal: {
            source: input.proposal.source,
            role: "move-executor",
            callId: input.proposal.callId,
            stepIndex: index + 1,
            stepCount,
          },
        };
      };

      const firstId = stepCommandId(1);
      if ((await transaction.readCommand(session.id, firstId)) !== undefined) {
        // A retry: every recorded step must reproduce, and the cursor must still be at the end.
        const results: PrepareProofCommandSuccess[] = [];
        let parent: ProofNode["id"] = input.expectedCurrentNodeId;
        for (let index = 0; index < stepCount; index += 1) {
          const recordedInput = await transaction.readCommand(session.id, stepCommandId(index + 1));
          const recorded =
            recordedInput === undefined
              ? undefined
              : safeParse(createPrepareProofCommandSuccessSchema(environment), recordedInput);
          if (recorded === undefined) {
            return repositoryFailure(
              "rejected",
              "invalid-command-record",
              "A recorded plan step failed runtime validation or is missing.",
            );
          }
          const replayed = prepareProofCommand(
            recorded.prepared.parent,
            commandFor(index, parent),
            { ...contextFor(index), previous: recorded },
          );
          if (!replayed.ok) {
            return repositoryFailure(
              "rejected",
              "command-rejected",
              `Step ${index + 1} of ${stepCount} conflicts with the recorded application: ${replayed.diagnostics[0].message}`,
            );
          }
          results.push(replayed);
          parent = replayed.prepared.node.id;
        }
        if (session.currentNodeId !== results.at(-1)?.prepared.node.id) {
          return repositoryFailure(
            "rejected",
            "serialized-stale-command",
            "The recorded plan was superseded by navigation or a later move.",
          );
        }
        return { status: "committed" as const, results, replayed: true };
      }

      for (const id of [input.commandIdPrefix as ApplyKernelCommand["commandId"], firstId]) {
        const deleted = await deletedCommandFailure(transaction, session.id, id);
        if (deleted !== undefined) return deleted;
      }
      if (session.currentNodeId !== input.expectedCurrentNodeId) {
        return repositoryFailure(
          "rejected",
          "serialized-stale-command",
          "The current proof node changed before the plan was applied.",
        );
      }
      const currentInput = await transaction.readNode(session.id, session.currentNodeId);
      const currentNode =
        currentInput === undefined
          ? undefined
          : parseNodeRecord(currentInput, session, environment, session.currentNodeId);
      if (currentNode === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-current-node",
          "The stored current proof node is missing or failed validation.",
        );
      }
      const results: PrepareProofCommandSuccess[] = [];
      let node = currentNode;
      for (let index = 0; index < stepCount; index += 1) {
        if ((await transaction.readCommand(session.id, stepCommandId(index + 1))) !== undefined) {
          return repositoryFailure(
            "rejected",
            "command-rejected",
            "A plan step's command ID is already recorded.",
          );
        }
        const prepared = prepareProofCommand(node, commandFor(index, node.id), contextFor(index));
        if (!prepared.ok) {
          return repositoryFailure(
            "rejected",
            "plan-step-failed",
            `Step ${index + 1} of ${stepCount} was rejected: ${prepared.diagnostics[0].message}`,
          );
        }
        results.push(prepared);
        node = prepared.prepared.node;
      }
      const sequencedResults = await sequenceCommands(
        transaction,
        session.id,
        scopes.final,
        results,
      );
      const activated = await recordActivations(
        transaction,
        session.id,
        activations.length,
        sequencedResults.map((prepared, index) => ({ step: scopes.perStep[index], prepared })),
        options.now,
      );
      for (const result of sequencedResults) {
        await transaction.insertNode(session.id, result.prepared.node);
        await transaction.insertEdge(session.id, result.prepared.edge);
        await transaction.insertEvent(session.id, result.prepared.event);
        await transaction.insertCommand(session.id, result);
      }
      if (!(await transaction.repointCurrentNode(session.id, currentNode.id, node.id))) {
        throw new SerializedStaleCommandError();
      }
      return {
        status: "committed" as const,
        results: sequencedResults,
        replayed: false,
        ...(activated.length === 0 ? {} : { activations: activated }),
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The plan could not be applied atomically.");
  }
}

/**
 * The environment each step of a sequence of operations runs in: the effective operators plus the
 * constants activated by that step and the ones before it. `final` is the environment after the
 * last step. `undefined` when an environment cannot be built.
 */
function stepScopes(
  definitions: DefinitionCatalog,
  operators: readonly OperatorDeclaration[],
  operations: readonly unknown[],
  base: ProtocolEnvironment,
):
  | Readonly<{
      environments: readonly Readonly<{
        operators?: ProtocolEnvironment["operators"];
        results?: ProtocolEnvironment["results"];
        moves?: ProtocolEnvironment["moves"];
      }>[];
      perStep: readonly (StepConstants | undefined)[];
      final: ProtocolEnvironment;
    }>
  | undefined {
  const sequence = sequenceConstants(definitions, operators, operations);
  const cache = new Map<string, ProtocolEnvironment | undefined>();
  const environmentFor = (stepOperators: readonly OperatorDeclaration[]) => {
    if (stepOperators === operators) return base;
    const key = JSON.stringify(stepOperators);
    if (!cache.has(key)) cache.set(key, frozenEnvironment(stepOperators, definitions));
    return cache.get(key);
  };
  const environments: ProtocolEnvironment[] = [];
  for (const stepOperators of sequence.stepOperators) {
    const environment = environmentFor(stepOperators);
    if (environment === undefined) return undefined;
    environments.push(environment);
  }
  const final = environmentFor(sequence.operators);
  return final === undefined ? undefined : { environments, perStep: sequence.perStep, final };
}
