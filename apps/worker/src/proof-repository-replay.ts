// Semantic replay: previewing and committing a recorded proof onto a session.

import {
  actorSchema,
  createPrepareProofCommandSuccessSchema,
  createMovePreviewSchema,
  type Actor,
  type ApplyKernelCommand,
  type PrepareProofCommandSuccess,
  type ProofCommandReceipt,
  type ProofEdge,
  type ProofNode,
  type ProtocolEnvironment,
  MAX_REPLAY_STEPS,
  deriveMacroStep,
  deriveOperationStep,
  deriveSemanticStep,
  planSemanticReplay,
  semanticReplayCommandSchema,
  semanticReplayPreviewRequestSchema,
  semanticReplayReportSchema,
  semanticReplayStepCommandId,
  semanticReplayStepRecordSchema,
  type SemanticReplayCommand,
  type SemanticReplayPreviewRequest,
  type SemanticReplayReport,
  type SemanticReplaySourceStep,
  type SemanticReplayStepRecord,
  type SemanticStep,
} from "@proof/protocol";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "./approved-catalog";
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
  isDataRecord,
  jsonEquals,
  freezeDetached,
  transactionFailure,
} from "./proof-repository-core";
import {
  loadSession,
  loadNode,
  loadSuggestionSet,
  loadProofHistoryInTransaction,
  deletedCommandFailure,
  sequenceCommands,
  derivedMoveRecordIds,
} from "./proof-repository-records";
import { MAX_INTERACTION_EVENTS_PER_READ } from "./proof-repository-interaction";

export type SemanticReplayPreviewResult =
  | Readonly<{
      status: "loaded";
      report: SemanticReplayReport;
      /** The node the last replayed step would create, or the target node. */
      finalNode: ProofNode;
    }>
  | RepositoryFailure;

export type SemanticReplayCommitResult =
  | Readonly<{
      status: "committed";
      session: ProofSession;
      /** The node the cursor moved to: the last replayed step's node. */
      node: ProofNode;
      /** One receipt per replayed step, in order. */
      receipts: readonly ProofCommandReceipt[];
      report: SemanticReplayReport;
      replayed: boolean;
    }>
  /** A step failed to re-match; nothing was recorded. */
  | Readonly<{ status: "replay-failed"; report: SemanticReplayReport }>
  | RepositoryFailure;

export type SemanticReplayOptions = Readonly<{
  definitions?: DefinitionCatalog;
  now?: () => Date;
}>;

/** The command ID a preview uses for its predicted records when the caller names none. */
const PREVIEW_COMMAND_ID = "replay-preview" as ApplyKernelCommand["commandId"];

/**
 * Semantic replay dry run (design plan §16.4): re-match the steps on the path from
 * `source.fromNodeId` to `source.toNodeId` onto the target node and report what would happen.
 * Nothing is written.
 */
export async function previewSemanticReplay(
  store: ProofStore,
  sessionIdInput: unknown,
  requestInput: unknown,
  trustedActorInput: unknown,
  options: SemanticReplayOptions = {},
): Promise<SemanticReplayPreviewResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const request = safeParse(semanticReplayPreviewRequestSchema, requestInput);
  const trustedActor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || request === undefined || trustedActor === undefined) {
    return repositoryFailure(
      "rejected",
      "replay-rejected",
      "The session ID, replay request, or trusted actor is invalid.",
    );
  }
  const definitions = options.definitions ?? APPROVED_DEFINITIONS;
  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId, definitions);
      if (!loadedSession.ok) return loadedSession.failure;
      const planned = await planReplayInTransaction(
        transaction,
        loadedSession.session,
        loadedSession.environment,
        definitions,
        request,
        (request.commandId as ApplyKernelCommand["commandId"] | undefined) ?? PREVIEW_COMMAND_ID,
        trustedActor,
      );
      if (!planned.ok) return planned.failure;
      return {
        status: "loaded" as const,
        report: planned.result.report,
        finalNode: planned.result.finalNode,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The replay could not be previewed.");
  }
}

/**
 * Semantic replay (design plan §16.4): replay the steps on the source path onto the target node,
 * creating fresh nodes through ordinary validated commands (each prepared by
 * `prepareProofCommand` against its own parent), record each step's plan and report, and move
 * the cursor to the last new node. A step that fails to re-match records nothing and returns the
 * report. A retry with the same command ID replays the recorded result.
 */
export async function commitSemanticReplay(
  store: ProofStore,
  sessionIdInput: unknown,
  commandInput: unknown,
  trustedActorInput: unknown,
  options: SemanticReplayOptions = {},
): Promise<SemanticReplayCommitResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const command = safeParse(semanticReplayCommandSchema, commandInput);
  const trustedActor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || command === undefined || trustedActor === undefined) {
    return repositoryFailure(
      "rejected",
      "replay-rejected",
      "The session ID, replay command, or trusted actor is invalid.",
    );
  }
  if (command.actor.id !== trustedActor.id || command.actor.kind !== trustedActor.kind) {
    return repositoryFailure(
      "rejected",
      "replay-rejected",
      "The command actor does not match the trusted actor.",
    );
  }
  const definitions = options.definitions ?? APPROVED_DEFINITIONS;
  const commandId = command.commandId as ApplyKernelCommand["commandId"];
  const request: Omit<SemanticReplayCommand, "commandId"> = {
    actor: command.actor,
    expectedCurrentNodeId: command.expectedCurrentNodeId,
    source: command.source,
    ...(command.targetNodeId === undefined ? {} : { targetNodeId: command.targetNodeId }),
    ...(command.focus === undefined ? {} : { focus: command.focus }),
    ...(command.overrides === undefined ? {} : { overrides: command.overrides }),
  };

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId, definitions);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;

      const firstStepId = semanticReplayStepCommandId(
        commandId,
        1,
      ) as ApplyKernelCommand["commandId"];
      const existingInput = await transaction.readReplayStep(session.id, firstStepId);
      if (existingInput !== undefined) {
        return replaySemanticReplay(transaction, session, environment, commandId, request);
      }
      for (const id of [commandId, firstStepId]) {
        const deleted = await deletedCommandFailure(transaction, session.id, id);
        if (deleted !== undefined) return deleted;
        if ((await transaction.readCommand(session.id, id)) !== undefined) {
          return repositoryFailure(
            "rejected",
            "replay-conflict",
            "The command ID is already recorded for a different command.",
          );
        }
      }
      if (session.currentNodeId !== command.expectedCurrentNodeId) {
        return repositoryFailure(
          "rejected",
          "serialized-stale-command",
          "The current proof node changed before the replay was applied.",
        );
      }

      const planned = await planReplayInTransaction(
        transaction,
        session,
        environment,
        definitions,
        command,
        commandId,
        trustedActor,
      );
      if (!planned.ok) return planned.failure;
      const { result, targetNodeId } = planned;
      if (!result.report.complete) {
        return { status: "replay-failed" as const, report: result.report };
      }
      // A macro step applies several commands; the last one carries the step's command ID.
      const allCommands = result.replayed.flatMap((step) => [...step.preceding, step.prepared]);
      for (const command of allCommands) {
        const stepCommandId = command.prepared.command.commandId;
        const deleted = await deletedCommandFailure(transaction, session.id, stepCommandId);
        if (deleted !== undefined) return deleted;
        if ((await transaction.readCommand(session.id, stepCommandId)) !== undefined) {
          return repositoryFailure(
            "rejected",
            "replay-conflict",
            "A replayed step's command ID is already recorded.",
          );
        }
      }

      const recordedAt = (options.now?.() ?? new Date()).toISOString();
      const sequencedReplay = await sequenceCommands(
        transaction,
        session.id,
        environment,
        allCommands,
      );
      let offset = 0;
      for (const step of result.replayed) {
        const size = step.preceding.length + 1;
        const sequencedStep = sequencedReplay.slice(offset, offset + size);
        offset += size;
        for (const sequenced of sequencedStep) {
          const { prepared } = sequenced;
          await transaction.insertNode(session.id, prepared.node);
          await transaction.insertEdge(session.id, prepared.edge);
          await transaction.insertEvent(session.id, prepared.event);
          await transaction.insertCommand(session.id, sequenced);
        }
        const { prepared } = sequencedStep.at(-1) as PrepareProofCommandSuccess;
        const record = safeParse(semanticReplayStepRecordSchema, {
          commandId: prepared.command.commandId,
          replayCommandId: commandId,
          index: step.index,
          count: result.replayed.length,
          nodeId: prepared.node.id,
          sourceEdgeId: step.sourceEdgeId,
          request,
          targetNodeId,
          plan: step.plan,
          report: step.report,
          recordedAt,
        });
        const detached = record === undefined ? undefined : freezeDetached(record);
        if (detached === undefined) {
          // Throwing rolls every inserted step back.
          throw new Error("The replayed-step record failed runtime validation.");
        }
        await transaction.insertReplayStep(session.id, detached);
      }
      const finalNode = result.finalNode;
      if (
        !(await transaction.repointCurrentNode(session.id, session.currentNodeId, finalNode.id))
      ) {
        throw new SerializedStaleCommandError();
      }
      const updatedSession = freezeDetached({ ...session, currentNodeId: finalNode.id });
      if (updatedSession === undefined) {
        throw new Error("The updated proof session could not be detached safely.");
      }
      return {
        status: "committed" as const,
        session: updatedSession,
        node: finalNode,
        receipts: sequencedReplay.map(({ receipt }) => receipt),
        report: result.report,
        replayed: false,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The replay could not be applied atomically.");
  }
}

type PlannedReplay =
  | Readonly<{
      ok: true;
      result: Extract<ReturnType<typeof planSemanticReplay>, { ok: true }>;
      targetNodeId: ProofNode["id"];
    }>
  | Readonly<{ ok: false; failure: RepositoryFailure }>;

/** Read the source steps' plans from stored records and re-match them onto the target. */
async function planReplayInTransaction(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  environment: ProtocolEnvironment,
  definitions: DefinitionCatalog,
  request: SemanticReplayPreviewRequest,
  commandId: ApplyKernelCommand["commandId"],
  actor: Actor,
): Promise<PlannedReplay> {
  const rejected = (message: string): PlannedReplay => ({
    ok: false,
    failure: repositoryFailure("rejected", "replay-rejected", message),
  });
  const history = await loadProofHistoryInTransaction(transaction, session, environment);
  if (history.status !== "loaded") return { ok: false, failure: history };
  const nodes = new Map(history.nodes.map((node) => [node.id as string, node]));
  const parentEdge = new Map(history.edges.map(({ edge }) => [edge.childNodeId as string, edge]));

  const path: ProofEdge[] = [];
  let cursor: string = request.source.toNodeId;
  while (cursor !== request.source.fromNodeId) {
    const edge = parentEdge.get(cursor);
    if (edge === undefined || path.length >= MAX_REPLAY_STEPS) {
      return rejected(
        edge === undefined
          ? "The source start is not an ancestor of the source end in the retained tree."
          : `A replay carries at most ${MAX_REPLAY_STEPS} steps.`,
      );
    }
    path.unshift(edge);
    cursor = edge.parentNodeId;
  }
  if (path.length === 0) return rejected("The source path contains no step to replay.");
  const targetNodeId = request.targetNodeId ?? session.currentNodeId;
  const target = nodes.get(targetNodeId);
  if (target === undefined) {
    return rejected("The target node is not in the retained tree.");
  }

  const steps: SemanticReplaySourceStep[] = [];
  let backtrackCommands: ReadonlySet<string> | undefined;
  for (let position = 0; position < path.length; position += 1) {
    const edge = path[position] as ProofEdge;
    const parent = nodes.get(edge.parentNodeId);
    const child = nodes.get(edge.childNodeId);
    if (parent === undefined || child === undefined) {
      return {
        ok: false,
        failure: repositoryFailure(
          "rejected",
          "invalid-proof-history",
          "A source step's snapshots are missing.",
        ),
      };
    }
    // One macro application is one replay step (N45): its edges share a macro link.
    if (edge.macro !== undefined && edge.macro.stepIndex === 1) {
      const application = path.slice(position, position + edge.macro.stepCount);
      const last = nodes.get(application.at(-1)?.childNodeId ?? "");
      const macroStep =
        last === undefined || application.length !== edge.macro.stepCount
          ? undefined
          : await deriveMacroInTransaction(
              transaction,
              session,
              environment,
              application,
              parent,
              last,
            );
      if (macroStep !== undefined) {
        steps.push({ sourceEdgeId: edge.id, step: macroStep });
        position += application.length - 1;
        continue;
      }
    }
    if (edge.suggestionSetId !== undefined) {
      const loaded = await loadSuggestionSet(transaction, session, edge.suggestionSetId);
      if (!loaded.ok) return { ok: false, failure: loaded.failure };
      const derived = deriveSemanticStep({
        parent,
        child,
        edge,
        suggestionSet: loaded.suggestionSet,
        operators: session.operators,
      });
      steps.push(
        derived.ok
          ? { sourceEdgeId: edge.id, step: derived.step }
          : { sourceEdgeId: edge.id, unavailable: derived.diagnostics[0].message },
      );
      continue;
    }
    const recordInput = await transaction.readReplayStep(session.id, edge.commandId);
    if (recordInput !== undefined) {
      const record = safeParse(semanticReplayStepRecordSchema, recordInput);
      if (record === undefined || record.commandId !== edge.commandId) {
        return {
          ok: false,
          failure: repositoryFailure(
            "rejected",
            "invalid-replay-record",
            "A stored replayed-step record failed runtime validation or identity checks.",
          ),
        };
      }
      steps.push({ sourceEdgeId: edge.id, step: record.plan });
      continue;
    }
    // No displayed suggestion: a backtracking step or a raw operation, planned from its operation.
    if (backtrackCommands === undefined) {
      backtrackCommands = await backtrackCommandIds(transaction, session);
    }
    const derivedOperation = deriveOperationStep({
      parent,
      child,
      edge,
      origin:
        edge.moveId === undefined &&
        (backtrackCommands.has(edge.commandId) ||
          (edge.commandId.endsWith(":auto-close") &&
            backtrackCommands.has(edge.commandId.slice(0, -":auto-close".length))))
          ? "backtrack"
          : "raw-operation",
      operators: session.operators,
    });
    steps.push(
      derivedOperation.ok
        ? { sourceEdgeId: edge.id, step: derivedOperation.step }
        : { sourceEdgeId: edge.id, unavailable: derivedOperation.diagnostics[0].message },
    );
  }

  const result = planSemanticReplay({
    steps,
    target,
    focus: request.focus,
    overrides: request.overrides,
    commandId,
    actor,
    recordIds: (id) => derivedMoveRecordIds(id as ApplyKernelCommand["commandId"]),
    operators: session.operators,
    ...(environment.results === undefined ? {} : { results: environment.results }),
    moves: definitions.moves,
    ...(definitions.macros === undefined ? {} : { macros: definitions.macros }),
  });
  if (!result.ok) return rejected(result.diagnostics[0].message);
  return { ok: true, result, targetNodeId: target.id };
}

/**
 * The plan of one stored macro application, from its stored preview and the suggestion set it was
 * applied from. Undefined when either is gone: the application's steps are then replayed one by
 * one as raw operations.
 */
async function deriveMacroInTransaction(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  environment: ProtocolEnvironment,
  application: readonly ProofEdge[],
  parent: ProofNode,
  child: ProofNode,
): Promise<SemanticStep | undefined> {
  const previewId = application[0]?.macro?.previewId;
  if (previewId === undefined) return undefined;
  const previewInput = await transaction.readPreview(session.id, previewId);
  const preview =
    previewInput === undefined
      ? undefined
      : safeParse(createMovePreviewSchema(environment), previewInput);
  if (preview === undefined || preview.id !== previewId) return undefined;
  const loaded = await loadSuggestionSet(transaction, session, preview.suggestionSetId);
  if (!loaded.ok) return undefined;
  const derived = deriveMacroStep({
    parent,
    child,
    edges: application,
    preview,
    suggestionSet: loaded.suggestionSet,
    operators: session.operators,
  });
  return derived.ok ? derived.step : undefined;
}

/** The command IDs of the session's backtracking-with-information commands. */
async function backtrackCommandIds(
  transaction: ProofStoreTransaction,
  session: ProofSession,
): Promise<ReadonlySet<string>> {
  const commands = new Set<string>();
  let afterSequence = 0;
  for (let page = 0; page < 1000; page += 1) {
    const rows = await transaction.listInteractionEvents(session.id, {
      afterSequence,
      limit: MAX_INTERACTION_EVENTS_PER_READ,
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      if (!isDataRecord(row)) continue;
      if (typeof row.sequence === "number" && row.sequence > afterSequence) {
        afterSequence = row.sequence;
      }
      const event = row.event;
      if (
        isDataRecord(event) &&
        event.kind === "backtracked-with-information" &&
        typeof event.commandId === "string"
      ) {
        commands.add(event.commandId);
      }
    }
    if (rows.length < MAX_INTERACTION_EVENTS_PER_READ) break;
  }
  return commands;
}

/** A retry of a recorded replay: the same request replays; anything else is a conflict. */
async function replaySemanticReplay(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  environment: ProtocolEnvironment,
  commandId: ApplyKernelCommand["commandId"],
  request: Omit<SemanticReplayCommand, "commandId">,
): Promise<SemanticReplayCommitResult> {
  const invalid = repositoryFailure(
    "rejected",
    "invalid-replay-record",
    "A recorded replayed step failed runtime validation or identity checks.",
  );
  const records: SemanticReplayStepRecord[] = [];
  const receipts: ProofCommandReceipt[] = [];
  for (let index = 1; index <= (records[0]?.count ?? 1); index += 1) {
    const stepId = semanticReplayStepCommandId(commandId, index) as ApplyKernelCommand["commandId"];
    const input = await transaction.readReplayStep(session.id, stepId);
    if (input === undefined) {
      const deleted = await deletedCommandFailure(transaction, session.id, stepId);
      return deleted ?? invalid;
    }
    const record = safeParse(semanticReplayStepRecordSchema, input);
    if (
      record === undefined ||
      record.commandId !== stepId ||
      record.replayCommandId !== commandId ||
      (records[0] !== undefined && record.count !== records[0].count)
    ) {
      return invalid;
    }
    if (!jsonEquals(record.request, request)) {
      return repositoryFailure(
        "rejected",
        "replay-conflict",
        "The command ID is already recorded for a different replay.",
      );
    }
    // A macro step recorded every command it applied; the last one is the step's own.
    for (const commandId of record.report.commandIds ?? [stepId]) {
      const commandInput = await transaction.readCommand(session.id, commandId);
      const recorded =
        commandInput === undefined
          ? undefined
          : safeParse(createPrepareProofCommandSuccessSchema(environment), commandInput);
      if (recorded === undefined || recorded.prepared.command.commandId !== commandId) {
        return invalid;
      }
      receipts.push(recorded.receipt);
    }
    records.push(record);
  }
  const last = records.at(-1);
  if (last === undefined) return invalid;
  if (session.currentNodeId !== last.nodeId) {
    return repositoryFailure(
      "rejected",
      "serialized-stale-command",
      "The recorded replay was superseded by navigation or a later move.",
    );
  }
  const loadedNode = await loadNode(
    transaction,
    session,
    environment,
    last.nodeId as ProofNode["id"],
    "current-node-not-found",
    "invalid-current-node",
  );
  if (!loadedNode.ok) return loadedNode.failure;
  const substitutions: SemanticReplayReport["substitutions"] = [];
  for (const record of records) {
    for (const substitution of record.report.substitutions) substitutions.push(substitution);
  }
  const report = safeParse(semanticReplayReportSchema, {
    targetNodeId: last.targetNodeId,
    complete: true,
    steps: records.map(({ report: step }) => step),
    substitutions,
    finalNodeId: last.nodeId,
  });
  if (report === undefined) return invalid;
  return {
    status: "committed" as const,
    session,
    node: loadedNode.node,
    receipts,
    report,
    replayed: true,
  };
}
