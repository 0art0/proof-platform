// Reading and validating stored records (sessions, nodes, suggestion sets, edges, history), plus
// the record-level helpers the writing modules share: tombstone checks, transition sequencing and
// command-derived record IDs.

import {
  constantActivationSchema,
  effectiveOperators,
  commandIdSchema,
  createProofEdgeSchema,
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  assignTransitionSequence,
  movePreviewIdSchema,
  proofDeletionRecordSchema,
  proofNodeIdSchema,
  suggestionAuthorizesMove,
  suggestionSetMatchesNode,
  suggestionSetIdSchema,
  type ApplyKernelCommand,
  type ConstantActivation,
  type DisplayedSuggestionSet,
  type MovePreviewId,
  type PrepareProofCommandSuccess,
  type ProofEdge,
  type ProofNode,
  type ProtocolEnvironment,
  type SuggestionSetId,
  type TransitionEvent,
} from "@proof/protocol";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "./approved-catalog";
import {
  stableStorageIdentifierSchema,
  proofSessionIdSchema,
  type ProofSessionId,
  type OperatorDeclaration,
  type ProofSession,
  proofSessionSchema,
  type ProofStoreTransaction,
} from "./proof-repository-store";
import {
  type RepositoryDiagnosticCode,
  type RepositoryFailure,
  repositoryFailure,
  safeParse,
  isDataRecord,
  isStrictDataRecord,
  deepFreeze,
  freezeDetached,
} from "./proof-repository-core";

export type ProofHistoryEdge = Readonly<{ edge: ProofEdge; name: string }>;

export type LoadProofHistoryResult =
  | Readonly<{
      status: "loaded";
      session: ProofSession;
      nodes: readonly ProofNode[];
      edges: readonly ProofHistoryEdge[];
    }>
  | RepositoryFailure;

/**
 * Stamp prepared commands, in order, with the session's next transition sequence numbers (one more
 * than the highest sequence the session retains). Called in the storing transaction under the
 * session lock, immediately before the records are inserted.
 */
export async function sequenceCommands(
  transaction: ProofStoreTransaction,
  sessionId: ProofSessionId,
  environment: ProtocolEnvironment,
  prepared: readonly PrepareProofCommandSuccess[],
): Promise<readonly PrepareProofCommandSuccess[]> {
  const last = await transaction.lastTransitionSequence(sessionId);
  if (!Number.isSafeInteger(last) || last < 0) {
    throw new Error("The stored transition sequence is invalid.");
  }
  return prepared.map((command, index) =>
    assignTransitionSequence(command, last + index + 1, environment),
  );
}

/** A command ID reserved by a deletion: either it issued one or its move was deleted. */
export async function deletedCommandFailure(
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

export function derivedPreviewId(commandId: ApplyKernelCommand["commandId"]): MovePreviewId {
  return `preview:${commandId}` as MovePreviewId;
}

function derivedStateId(commandId: ApplyKernelCommand["commandId"]): ProofNode["state"]["id"] {
  return `state:${commandId}` as ProofNode["state"]["id"];
}

export async function loadProofHistoryInTransaction(
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

export function parseEdgeRecord(
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

export function commandIdFromUnknown(value: unknown): ApplyKernelCommand["commandId"] | undefined {
  try {
    if (!isDataRecord(value)) return undefined;
    return safeParse(commandIdSchema, value.commandId) as
      ApplyKernelCommand["commandId"] | undefined;
  } catch {
    return undefined;
  }
}

export function suggestionSetIdFromUnknown(
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

export function movePreviewIdFromUnknown(
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
export function frozenEnvironment(
  operators: readonly OperatorDeclaration[],
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
): ProtocolEnvironment | undefined {
  try {
    createProofNodeSchema({ operators });
    const results = definitions.catalog(operators).kernelResults;
    if (results === undefined) return undefined;
    const authored = definitions.moves.filter(({ id }) => id.startsWith("authored:"));
    return deepFreeze({
      operators: structuredClone(operators),
      results: structuredClone(results),
      ...(authored.length === 0 ? {} : { moves: structuredClone(authored) }),
    });
  } catch {
    return undefined;
  }
}

type SessionRecord =
  | Readonly<{
      ok: true;
      /** The session with its effective operators: the setup operators plus activated constants. */
      session: ProofSession;
      /** The operators stored on the session row. */
      setupOperators: readonly OperatorDeclaration[];
      /** The constants committed steps activated, in activation order. */
      activations: readonly ConstantActivation[];
    }>
  | Readonly<{ ok: false; failure: RepositoryFailure }>;

/**
 * Lock and read a session with its constant activations (migration 0018). A session's
 * `operators` here are its effective operators: the setup operators stored on its row followed by
 * the declarations of its activated constants, in activation order. Every reader of a session
 * goes through this, so nothing validates or executes against the setup operators alone.
 */
export async function readSessionRecord(
  transaction: ProofStoreTransaction,
  expectedSessionId: ProofSessionId,
): Promise<SessionRecord> {
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
  const activations = parseActivations(await transaction.listConstantActivations(parsed.id));
  const effective =
    activations === undefined ? undefined : effectiveOperators(parsed.operators, activations);
  if (activations === undefined || effective === undefined || !effective.ok) {
    return {
      ok: false,
      failure: repositoryFailure(
        "rejected",
        "invalid-session-record",
        "The stored constant activations failed runtime validation.",
      ),
    };
  }
  return {
    ok: true,
    session: { ...parsed, operators: effective.operators },
    setupOperators: parsed.operators,
    activations,
  };
}

function parseActivations(inputs: readonly unknown[]): readonly ConstantActivation[] | undefined {
  if (!Array.isArray(inputs)) return undefined;
  const activations: ConstantActivation[] = [];
  for (const input of inputs) {
    const activation = safeParse(constantActivationSchema, input);
    if (activation === undefined) return undefined;
    activations.push(activation);
  }
  return activations;
}

type LoadedSession =
  | Readonly<{
      ok: true;
      /** The session with its effective operators. */
      session: ProofSession;
      /** The effective operators and the approved results valid in them. */
      environment: ProtocolEnvironment;
      setupOperators: readonly OperatorDeclaration[];
      activations: readonly ConstantActivation[];
    }>
  | Readonly<{ ok: false; failure: RepositoryFailure }>;

export async function loadSession(
  transaction: ProofStoreTransaction,
  expectedSessionId: ProofSessionId,
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
): Promise<LoadedSession> {
  const record = await readSessionRecord(transaction, expectedSessionId);
  if (!record.ok) return record;
  const environment = frozenEnvironment(record.session.operators, definitions);
  const session = freezeDetached(record.session);
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
  return {
    ok: true,
    session,
    environment,
    setupOperators: record.setupOperators,
    activations: record.activations,
  };
}

type LoadedNode =
  Readonly<{ ok: true; node: ProofNode }> | Readonly<{ ok: false; failure: RepositoryFailure }>;

export async function loadNode(
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

export async function loadSuggestionSet(
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

export function parseNodeRecord(
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

export function parseSuggestionSetRecord(
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
