import { previewLemmaRequestSchema } from "../../../../../../features/conditional-lemma/api-contract";
import { previewConditionalLemma } from "../../../../../../server/proof-service";
import {
  proofApiFailure,
  proofApiSuccess,
  proofServiceFailure,
  readBoundedJson,
  RequestBodyError,
  validateSameOriginJsonRequest,
} from "../../../http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 4 * 1024;

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

/** Preview the lemma a closed target would become; nothing is recorded (roadmap N44). */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const rejected = validateSameOriginJsonRequest(request);
  if (rejected !== undefined) return rejected;

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return proofApiFailure("invalid_request", error.message, error.status);
    }
    return proofApiFailure("invalid_request", "The JSON request body is invalid.", 400);
  }
  const parsed = previewLemmaRequestSchema.safeParse(body);
  if (!parsed.success) {
    return proofApiFailure("invalid_request", "Send { nodeId, target } as a JSON object.", 400);
  }

  const { sessionId } = await context.params;
  try {
    return proofApiSuccess(
      await previewConditionalLemma(sessionId, parsed.data, { signal: request.signal }),
    );
  } catch (error) {
    return proofServiceFailure(error);
  }
}
