import { relayAiRequest } from "../../../../../../server/proof-service";
import { proofProtocolAnswer, proofServiceFailure } from "../../../http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string; callId: string }>>;
}>;

/** Read a stored proof plan back, or learn that it is still being written. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId, callId } = await context.params;
  try {
    return proofProtocolAnswer(
      await relayAiRequest(
        { kind: "proof-plan-read", sessionId, callId },
        {},
        { signal: request.signal },
      ),
    );
  } catch (error) {
    return proofServiceFailure(error);
  }
}
