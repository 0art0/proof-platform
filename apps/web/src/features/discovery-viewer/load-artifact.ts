import "server-only";

import { notFound } from "next/navigation";
import type { ProofArtifact } from "@proof/protocol";
import { ProofServiceError, readStoredProofArtifact } from "../../server/proof-service";

/** Load the stored artifact of a session for a static viewer route; unknown sessions are 404. */
export async function loadStoredArtifact(rawSessionId: string): Promise<ProofArtifact> {
  try {
    return await readStoredProofArtifact(decodedSegment(rawSessionId));
  } catch (error) {
    if (
      error instanceof ProofServiceError &&
      (error.status === 404 || error.code === "invalid_request")
    ) {
      notFound();
    }
    throw error;
  }
}

/** Session IDs never contain `%`, so decoding an already decoded segment is harmless. */
function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
