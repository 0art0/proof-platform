import { recordInteractionEventRequestSchema } from "@proof/protocol";
import { recordStoredInteractionEvent } from "../../../../../server/proof-service";
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
  const parsed = recordInteractionEventRequestSchema.safeParse(body);
  if (!parsed.success) {
    return proofApiFailure("invalid_request", "The interaction event is invalid.", 400);
  }

  const { sessionId } = await context.params;
  try {
    const result = await recordStoredInteractionEvent(sessionId, parsed.data, {
      signal: request.signal,
    });
    return proofApiSuccess(result, result.replayed ? 200 : 201);
  } catch (error) {
    return proofServiceFailure(error);
  }
}
