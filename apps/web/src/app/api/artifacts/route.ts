import { MAX_ARTIFACT_BYTES, uploadProofArtifact } from "../../../server/proof-service";
import {
  proofApiFailure,
  proofProtocolAnswer,
  proofServiceFailure,
  readBoundedJson,
  RequestBodyError,
  validateSameOriginJsonRequest,
} from "../proof-sessions/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/**
 * Upload a proof artifact (roadmap N27). The body is the artifact JSON; the worker revalidates it
 * completely and creates a read-only session: 201 `{ sessionId, digest, … }`, 200 for an
 * identical earlier upload, 422 with the diagnostics of the first failed check.
 */
export async function POST(request: Request): Promise<Response> {
  const rejected = validateSameOriginJsonRequest(request);
  if (rejected !== undefined) return rejected;

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_ARTIFACT_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return proofApiFailure("invalid_request", error.message, error.status);
    }
    return proofApiFailure("invalid_request", "The artifact body is invalid.", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return proofApiFailure("invalid_request", "A proof artifact must be a JSON object.", 400);
  }

  try {
    return proofProtocolAnswer(await uploadProofArtifact(body, { signal: request.signal }));
  } catch (error) {
    return proofServiceFailure(error);
  }
}
