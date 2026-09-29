import { deleteProofSession, readCurrentProofSession } from "../../../../server/proof-service";
import { proofApiSuccess, proofServiceFailure, validateSameOriginRequest } from "../http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  try {
    return proofApiSuccess(await readCurrentProofSession(sessionId, { signal: request.signal }));
  } catch (error) {
    return proofServiceFailure(error);
  }
}

/**
 * Hard-delete a session and every dependent row (roadmap N36): `{ ok: true, data: { deleted } }`,
 * or 404 when it does not exist. Allowed for an imported read-only session. There is no
 * authentication yet, so this is guarded only by the same-origin check.
 */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const rejected = validateSameOriginRequest(request);
  if (rejected !== undefined) return rejected;
  const { sessionId } = await context.params;
  try {
    return proofApiSuccess(await deleteProofSession(sessionId, { signal: request.signal }));
  } catch (error) {
    return proofServiceFailure(error);
  }
}
