import { relayAiRoute } from "../../../ai/relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

/** Ask the planner for a structured proof; a slow plan answers 202 and is read back by its ID. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  return relayAiRoute(request, { kind: "proof-plan", sessionId });
}
