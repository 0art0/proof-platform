import { gatewayFailure, gatewaySuccess } from "../../../../server/orchestrator-http";
import { readOrchestratorStatus } from "../../../../server/orchestrator-gateway";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  try {
    return gatewaySuccess(await readOrchestratorStatus());
  } catch (error) {
    return gatewayFailure(error);
  }
}
