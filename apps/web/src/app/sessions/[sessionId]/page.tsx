import { notFound } from "next/navigation";
import { StoredProofWorkspace } from "../../../features/stored-proof-workspace";
import {
  ProofServiceError,
  readCurrentProofSession,
  readProofSessionMetadata,
} from "../../../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** One stored proof session in the workspace. */
export default async function SessionPage({
  params,
}: Readonly<{ params: Promise<{ sessionId: string }> }>) {
  const { sessionId } = await params;
  let loaded;
  try {
    loaded = await readCurrentProofSession(decodedSegment(sessionId));
  } catch (error) {
    if (
      error instanceof ProofServiceError &&
      (error.status === 404 || error.code === "invalid_request")
    ) {
      notFound();
    }
    throw error;
  }
  const metadata = await readProofSessionMetadata(loaded.session.id);
  const session =
    metadata === undefined
      ? loaded.session
      : {
          ...loaded.session,
          title: metadata.problem.title,
          statement: metadata.problem.statement,
          background: metadata.background.summary,
        };
  return (
    <main>
      <StoredProofWorkspace session={session} node={loaded.node} />
    </main>
  );
}

/** Session IDs never contain `%`, so decoding an already decoded segment is harmless. */
function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
