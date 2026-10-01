import { notFound } from "next/navigation";
import { MoveAuthoring } from "../../../../features/move-authoring";
import { ProofServiceError, readCurrentProofSession } from "../../../../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Move authoring without AI (roadmap N35) for one stored proof session. */
export default async function SessionMovesPage({
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
  return (
    <main>
      <MoveAuthoring
        session={{
          id: loaded.session.id,
          operators: loaded.session.operators,
          readOnly: loaded.session.readOnly,
        }}
      />
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
