import { messagesQuerySchema } from "../../../../lib/orchestrator-contract";
import { readOrchestratorMessages } from "../../../../server/orchestrator-gateway";
import {
  gatewayFailure,
  gatewaySuccess,
  invalidRequest,
} from "../../../../server/orchestrator-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const rawQuery = Object.fromEntries(searchParams.entries());
  const query = messagesQuerySchema.safeParse(rawQuery);
  if (!query.success) {
    return invalidRequest("Message filters must use a valid message ID and a limit from 1 to 100.");
  }

  try {
    const options =
      query.data.messageId === undefined
        ? { limit: query.data.limit }
        : { messageId: query.data.messageId, limit: query.data.limit };
    return gatewaySuccess(await readOrchestratorMessages(options));
  } catch (error) {
    return gatewayFailure(error);
  }
}
