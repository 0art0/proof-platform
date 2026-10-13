import { relayAiRoute } from "../relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/** Ask for a topic and vocabulary manifest proposal (design plan §4.2); nothing is approved. */
export async function POST(request: Request): Promise<Response> {
  return relayAiRoute(request, { kind: "topics" });
}
