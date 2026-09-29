import { protocolCommandEnvelopeSchema } from "@proof/protocol";
import { submitProtocolCommand } from "../../../../../server/proof-service";
import {
  proofApiFailure,
  proofProtocolAnswer,
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

/** One command envelope (roadmap N25), relayed to the worker's single command service. */
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
  const parsed = protocolCommandEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return proofApiFailure("invalid_request", "The command envelope is invalid.", 400);
  }

  const { sessionId } = await context.params;
  try {
    return proofProtocolAnswer(
      await submitProtocolCommand(sessionId, parsed.data, { signal: request.signal }),
    );
  } catch (error) {
    return proofServiceFailure(error);
  }
}
