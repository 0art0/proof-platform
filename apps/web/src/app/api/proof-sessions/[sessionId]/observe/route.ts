import { observeQuerySchema } from "@proof/protocol";
import { observeProofSession } from "../../../../../server/proof-service";
import { proofApiFailure, proofProtocolAnswer, proofServiceFailure } from "../../http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

const INTEGER_PARAMETERS = new Set(["afterEvent", "afterInquiry"]);

/** Observe a session (roadmap N25): `?view=full|summary|delta&sinceNode=…&afterEvent=…`. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const query: Record<string, unknown> = {};
  const keys = [...new URL(request.url).searchParams.keys()];
  if (new Set(keys).size !== keys.length) {
    return proofApiFailure("invalid_request", "Each observe parameter appears at most once.", 400);
  }
  for (const [key, value] of new URL(request.url).searchParams) {
    query[key] =
      INTEGER_PARAMETERS.has(key) && /^(0|[1-9][0-9]{0,9})$/.test(value) ? Number(value) : value;
  }
  const parsed = observeQuerySchema.safeParse(query);
  if (!parsed.success) {
    return proofApiFailure("invalid_request", "The observe query is invalid.", 400);
  }

  const { sessionId } = await context.params;
  try {
    return proofProtocolAnswer(
      await observeProofSession(sessionId, parsed.data, { signal: request.signal }),
    );
  } catch (error) {
    return proofServiceFailure(error);
  }
}
