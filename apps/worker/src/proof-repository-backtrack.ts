// Backtracking a session and deleting its previous move.

import {
  actorSchema,
  analyzeBacktrack,
  backtrackAnalysisRequestSchema,
  backtrackAutoCloseCommandId,
  backtrackWithInformationCommandSchema,
  createPrepareProofCommandSuccessSchema,
  deletePreviousMoveCommandSchema,
  deletionReceipt,
  planBacktrackWithInformation,
  planPreviousMoveDeletion,
  prepareProofCommand,
  proofDeletionRecordSchema,
  proofNodeIdSchema,
  type ApplyKernelCommand,
  type BacktrackAnalysis,
  type BacktrackDiagnostic,
  type DeletePreviousMoveReceipt,
  type InteractionEvent,
  type InteractionEventId,
  type MovePreviewId,
  type PrepareProofCommandSuccess,
  type ProofCommandReceipt,
  type ProofEdge,
  type ProofDeletionRecord,
  type ProofNode,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { z } from "zod";
import type { DefinitionCatalog } from "./approved-catalog";
import {
  proofSessionIdSchema,
  type ProofSessionId,
  type ProofSession,
  type ProofStoreTransaction,
  type ProofStore,
} from "./proof-repository-store";
import {
  SerializedStaleCommandError,
  type RepositoryFailure,
  repositoryFailure,
  safeParse,
  jsonEquals,
  deepFreeze,
  freezeDetached,
  transactionFailure,
} from "./proof-repository-core";
import {
  loadSession,
  loadNode,
  loadProofHistoryInTransaction,
  deletedCommandFailure,
  sequenceCommands,
  derivedMoveRecordIds,
} from "./proof-repository-records";
import {
  appendInteractionEvent,
  parseInteractionEventRecord,
} from "./proof-repository-interaction";

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

export const backtrackProofSessionSchema = z
  .object({
    expectedCurrentNodeId: proofNodeIdSchema,
    targetNodeId: proofNodeIdSchema,
  })
  .strict();

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
        ...(plan.macroSteps === undefined ? {} : { macroSteps: plan.macroSteps }),
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
          ...(environment.moves === undefined ? {} : { moves: environment.moves }),
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

      const sequencedSteps = await sequenceCommands(transaction, session.id, environment, steps);
      for (const step of sequencedSteps) {
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
        receipts: sequencedSteps.map(({ receipt }) => receipt),
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
