import { relayAiRoute } from "../../relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/** Record the user's acceptance or rejection of a stored background proposal. */
export async function POST(request: Request): Promise<Response> {
  return relayAiRoute(request, { kind: "background-decisions" });
}
