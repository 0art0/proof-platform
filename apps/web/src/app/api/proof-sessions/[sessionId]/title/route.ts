import { setSessionTitle } from "../../../../../server/proof-service";
import {
  proofApiFailure,
  proofApiSuccess,
  proofServiceFailure,
  readBoundedJson,
  RequestBodyError,
  validateSameOriginJsonRequest,
} from "../../http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

/**
 * Rename the session with `{ "title": string | null }`; `null` or an empty title restores the
 * approved problem title. Not a proof write: the proof state and the approved setup are unchanged.
 */
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const rejected = validateSameOriginJsonRequest(request);
  if (rejected !== undefined) return rejected;
  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return proofApiFailure("invalid_request", error.message, error.status);
    }
    return proofApiFailure("invalid_request", "The request body is invalid.", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body) || !("title" in body)) {
    return proofApiFailure("invalid_request", 'The body must be { "title": string | null }.', 400);
  }
  const { sessionId } = await context.params;
  try {
    return proofApiSuccess(
      await setSessionTitle(sessionId, (body as Readonly<Record<string, unknown>>).title, {
        signal: request.signal,
      }),
    );
  } catch (error) {
    return proofServiceFailure(error);
  }
}
