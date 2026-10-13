import { relayAiRoute } from "../../relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/** Record the user's approval or rejection of a stored topic proposal. */
export async function POST(request: Request): Promise<Response> {
  return relayAiRoute(request, { kind: "topic-decisions" });
}
