import { relayAiRoute } from "../../../ai/relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

/** Commit a translated move; the worker re-derives it from the stored calls. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  return relayAiRoute(request, { kind: "proof-plan-apply", sessionId });
}
