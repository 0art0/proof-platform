import { notFound } from "next/navigation";
import { MoveAuthoring } from "../../../../features/move-authoring";
import {
  ProofServiceError,
  readAiCapabilities,
  readCurrentProofSession,
} from "../../../../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Move authoring for one stored proof session (roadmap N35). `?proposal=<call ID>` opens a model's
 * proposal from "Save as reusable move" in the form.
 */
export default async function SessionMovesPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ sessionId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { sessionId } = await params;
  const query = (await searchParams) ?? {};
  const proposal = Array.isArray(query["proposal"]) ? query["proposal"][0] : query["proposal"];
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
  const capabilities = await readAiCapabilities();
  return (
    <main>
      <MoveAuthoring
        session={{
          id: loaded.session.id,
          operators: loaded.session.operators,
          readOnly: loaded.session.readOnly,
        }}
        proposalId={proposal === "" ? undefined : proposal}
        canRevise={capabilities["move-author"]}
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
