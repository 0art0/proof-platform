import { backtrackAnalysisRequestSchema } from "@proof/protocol";
import { analyzeBacktrackProofSession } from "../../../../../server/proof-service";
import {
  proofApiFailure,
  proofApiSuccess,
  proofServiceFailure,
  readBoundedJson,
  RequestBodyError,
  validateSameOriginJsonRequest,
} from "../../http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

/** Dry run of backtracking with information (N20): analysis only, nothing is written. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
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
  const parsed = backtrackAnalysisRequestSchema.safeParse(body);
  if (!parsed.success) {
    return proofApiFailure("invalid_request", "The backtrack analysis request is invalid.", 400);
  }

  const { sessionId } = await context.params;
  try {
    return proofApiSuccess(
      await analyzeBacktrackProofSession(sessionId, parsed.data, { signal: request.signal }),
    );
  } catch (error) {
    return proofServiceFailure(error);
  }
}
