import { relayAiRoute } from "../../../ai/relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

/** Rank already displayed suggestions; the deterministic list stays authoritative. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  return relayAiRoute(request, { kind: "shortlist", sessionId });
}
