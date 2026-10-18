import { relayAiRoute } from "../../../ai/relay";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

/** Preview a step described in words; the kernel checks it and nothing is committed. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  return relayAiRoute(request, { kind: "execute", sessionId });
}
