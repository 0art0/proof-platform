import { relayAiRoute } from "../../../ai/relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

/**
 * Ask the librarian for more results during a proof. The worker admits what its gate admits as
 * ordinary library additions; nothing here can change proof state.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  return relayAiRoute(request, { kind: "library-top-up", sessionId });
}
