import { relayAiRoute } from "../relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/** Ask for a draft setup (design plan §4.4); the user still checks and approves it. */
export async function POST(request: Request): Promise<Response> {
  return relayAiRoute(request, { kind: "formalize" });
}
