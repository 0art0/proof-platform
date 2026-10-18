import { relayAiRoute } from "../relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/**
 * Ask the librarian for general library results for an approved background and its constants
 * (`docs/ai-agents-architecture.md` section 2); nothing is added to any library.
 */
export async function POST(request: Request): Promise<Response> {
  return relayAiRoute(request, { kind: "library" });
}
