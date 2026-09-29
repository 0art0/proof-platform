import { readSessionLibraryEvents } from "../../../../../../server/proof-service";
import { proofApiSuccess, proofServiceFailure } from "../../../http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

/** The session's library addition events, admitted and rejected (roadmap N32). */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  try {
    return proofApiSuccess(await readSessionLibraryEvents(sessionId, { signal: request.signal }));
  } catch (error) {
    return proofServiceFailure(error);
  }
}
