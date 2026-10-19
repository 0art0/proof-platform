import { relayAiRoute } from "../../relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/** Record which of a stored library proposal's admitted results the user kept (IDs only). */
export async function POST(request: Request): Promise<Response> {
  return relayAiRoute(request, { kind: "library-decisions" });
}
