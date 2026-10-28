// Session lifecycle: creating a session and loading its current state or its history.

import { createProofNodeSchema, proofSessionMetadataSchema, type ProofNode } from "@proof/protocol";
import { z } from "zod";
import {
  proofSessionIdSchema,
  type ProofSessionId,
  operatorEnvironmentSchema,
  type ProofSession,
  type ProofStore,
} from "./proof-repository-store";
import {
  type RepositoryFailure,
  repositoryFailure,
  safeParse,
  deepFreeze,
  freezeDetached,
  transactionFailure,
} from "./proof-repository-core";
import {
  loadSession,
  loadNode,
  frozenEnvironment,
  loadProofHistoryInTransaction,
  type LoadProofHistoryResult,
} from "./proof-repository-records";

export type InitializeProofSessionResult =
  Readonly<{ status: "committed"; session: ProofSession; node: ProofNode }> | RepositoryFailure;

export type LoadCurrentProofSessionResult =
  Readonly<{ status: "loaded"; session: ProofSession; node: ProofNode }> | RepositoryFailure;

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
