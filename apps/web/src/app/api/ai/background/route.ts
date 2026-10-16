import { relayAiRoute } from "../relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/**
 * Ask for a background and the constants a problem needs, or for a revision of an earlier
 * proposal (`docs/ai-agents-architecture.md` section 1); nothing is accepted.
 */
export async function POST(request: Request): Promise<Response> {
  return relayAiRoute(request, { kind: "background" });
}
