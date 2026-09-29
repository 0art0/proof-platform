import { PrunedProofViewer } from "../../../../features/discovery-viewer";
import { loadStoredArtifact } from "../../../../features/discovery-viewer/load-artifact";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** The pruned proof of one stored proof session (roadmap N28); reads the stored artifact. */
export default async function SessionProofPage({
  params,
}: Readonly<{ params: Promise<{ sessionId: string }> }>) {
  const { sessionId } = await params;
  const artifact = await loadStoredArtifact(sessionId);
  return (
    <main>
      <PrunedProofViewer artifact={artifact} />
    </main>
  );
}
