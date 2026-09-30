/**
 * Session privacy and deletion (design plan §19.3, roadmap N36), over the proof store.
 *
 * There is no authentication system yet, so nothing here is access control: a session's
 * `visibility` (default `private`) gates only what the worker can enforce without identity.
 * Deleting a session hard-deletes it and every dependent row; it is allowed on a read-only
 * (imported) session, and it removes the artifact-import record, the only server-side trace of an
 * export.
 */
import {
  proofSessionIdSchema,
  proofSessionSchema,
  repositoryFailure,
  safeParse,
  sessionVisibility,
  type ProofSessionId,
  type ProofStore,
  type RepositoryFailure,
  type SessionVisibility,
} from "./proof-repository";

export type ReadVisibilityResult =
  | Readonly<{ status: "read"; sessionId: ProofSessionId; visibility: SessionVisibility }>
  | RepositoryFailure;

export type SetVisibilityResult = ReadVisibilityResult;

export type DeleteSessionResult =
  Readonly<{ status: "deleted"; sessionId: ProofSessionId }> | RepositoryFailure;

const notFound = () =>
  repositoryFailure("rejected", "session-not-found", "The proof session does not exist.");

/** The session's visibility; `private` unless it was explicitly shared. */
export async function readSessionVisibility(
  store: ProofStore,
  sessionIdInput: unknown,
): Promise<ReadVisibilityResult> {
  const sessionId = parseSessionId(sessionIdInput);
  if (sessionId === undefined) return notFound();
  try {
    return await store.transaction(async (transaction): Promise<ReadVisibilityResult> => {
      const record = await transaction.lockSession(sessionId);
      if (record === undefined) return notFound();
      const session = safeParse(proofSessionSchema, record);
      if (session === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-session-record",
          "The stored session record is invalid.",
        );
      }
      return { status: "read", sessionId, visibility: sessionVisibility(session) };
    });
  } catch {
    return storageFailure();
  }
}

/** Change the visibility of an existing session; setting the current value is a no-op success. */
export async function setSessionVisibility(
  store: ProofStore,
  sessionIdInput: unknown,
  visibility: SessionVisibility,
): Promise<SetVisibilityResult> {
  const sessionId = parseSessionId(sessionIdInput);
  if (sessionId === undefined) return notFound();
  try {
    return await store.transaction(async (transaction): Promise<SetVisibilityResult> => {
      if ((await transaction.lockSession(sessionId)) === undefined) return notFound();
      if (!(await transaction.setSessionVisibility(sessionId, visibility))) return notFound();
      return { status: "read", sessionId, visibility };
    });
  } catch {
    return storageFailure();
  }
}

/** Hard-delete the session and all of its rows in one transaction; 404 when it is absent. */
export async function deleteProofSession(
  store: ProofStore,
  sessionIdInput: unknown,
): Promise<DeleteSessionResult> {
  const sessionId = parseSessionId(sessionIdInput);
  if (sessionId === undefined) return notFound();
  try {
    return await store.transaction(async (transaction): Promise<DeleteSessionResult> => {
      if (!(await transaction.deleteSession(sessionId))) return notFound();
      return { status: "deleted", sessionId };
    });
  } catch (error: unknown) {
    const outcome =
      typeof error === "object" && error !== null
        ? (error as { outcome?: unknown }).outcome
        : undefined;
    return outcome === "commit-unknown"
      ? repositoryFailure(
          "uncertain",
          "commit-unknown",
          "The deletion could not be confirmed; repeat it.",
        )
      : storageFailure();
  }
}

function parseSessionId(input: unknown): ProofSessionId | undefined {
  return safeParse(proofSessionIdSchema, input) as ProofSessionId | undefined;
}

function storageFailure(): RepositoryFailure {
  return repositoryFailure(
    "rejected",
    "storage-failure",
    "The proof store could not complete the request.",
  );
}
