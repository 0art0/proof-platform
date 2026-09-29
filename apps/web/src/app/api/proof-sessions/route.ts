import { problemApprovalRequestSchema } from "@proof/protocol";
import { createProblemSession } from "../../../server/proof-service";
import {
  proofApiFailure,
  proofProtocolAnswer,
  proofServiceFailure,
  readBoundedJson,
  RequestBodyError,
  validateSameOriginJsonRequest,
} from "./http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/**
 * Approve a reviewed problem draft (roadmap N26). The worker re-validates the draft, checks the
 * reviewed digest, and only then creates the session and its root node.
 */
export async function POST(request: Request): Promise<Response> {
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
  const parsed = problemApprovalRequestSchema.safeParse(body);
  if (!parsed.success) {
    return proofApiFailure("invalid_request", "The approval request is invalid.", 400);
  }

  try {
    return proofProtocolAnswer(await createProblemSession(parsed.data, { signal: request.signal }));
  } catch (error) {
    return proofServiceFailure(error);
  }
}
