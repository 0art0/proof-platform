import { submitIntentRequestSchema } from "../../../../lib/orchestrator-contract";
import { submitOrchestratorIntent } from "../../../../server/orchestrator-gateway";
import {
  gatewayFailure,
  gatewaySuccess,
  invalidRequest,
  validateLocalJsonMutation,
} from "../../../../server/orchestrator-http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejected = validateLocalJsonMutation(request);
  if (rejected) return rejected;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest("Submit a JSON object containing a development intent.");
  }

  const intent = submitIntentRequestSchema.safeParse(body);
  if (!intent.success) {
    return invalidRequest("Intent must contain 1 to 12,000 characters and no extra fields.");
  }

  try {
    return gatewaySuccess(await submitOrchestratorIntent(intent.data.message), 202);
  } catch (error) {
    return gatewayFailure(error);
  }
}
