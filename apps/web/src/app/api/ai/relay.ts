import { relayAiRequest, type AiEndpoint } from "../../../server/proof-service";
import {
  proofApiFailure,
  proofProtocolAnswer,
  proofServiceFailure,
  readBoundedJson,
  RequestBodyError,
  validateSameOriginJsonRequest,
} from "../proof-sessions/http";

/**
 * Relay a same-origin AI request to the worker. The worker owns validation, evidence and the cost
 * guard; this boundary only bounds the body and keeps the answer's status, including 429.
 */
export async function relayAiRoute(request: Request, endpoint: AiEndpoint): Promise<Response> {
  const rejected = validateSameOriginJsonRequest(request);
  if (rejected !== undefined) return rejected;

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return proofApiFailure("invalid_request", error.message, error.status);
    }
    return proofApiFailure("invalid_request", "The JSON request body is invalid.", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return proofApiFailure("invalid_request", "The AI request must be a JSON object.", 400);
  }

  try {
    return proofProtocolAnswer(await relayAiRequest(endpoint, body, { signal: request.signal }));
  } catch (error) {
    return proofServiceFailure(error);
  }
}
