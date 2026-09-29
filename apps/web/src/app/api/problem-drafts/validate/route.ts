import { problemDraftValidationRequestSchema } from "@proof/protocol";
import { validateProblemDraftRequest } from "../../../../server/proof-service";
import {
  proofApiFailure,
  proofProtocolAnswer,
  proofServiceFailure,
  readBoundedJson,
  RequestBodyError,
  validateSameOriginJsonRequest,
} from "../../proof-sessions/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/** Validate a problem draft into a review (roadmap N26); nothing is stored. */
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
  const parsed = problemDraftValidationRequestSchema.safeParse(body);
  if (!parsed.success) {
    return proofApiFailure("invalid_request", "The request must be { draft }.", 400);
  }

  try {
    return proofProtocolAnswer(
      await validateProblemDraftRequest(parsed.data, { signal: request.signal }),
    );
  } catch (error) {
    return proofServiceFailure(error);
  }
}
