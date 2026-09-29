import { readSessionVisibility, setSessionVisibility } from "../../../../../server/proof-service";
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

/** The session's visibility, `private` unless explicitly shared (roadmap N36). */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  try {
    return proofApiSuccess(await readSessionVisibility(sessionId, { signal: request.signal }));
  } catch (error) {
    return proofServiceFailure(error);
  }
}

/**
 * Change the visibility with `{ "visibility": "private" | "shared" }`. There is no authentication
 * yet, so this is not access control: it decides only whether an export needs the private-export
 * acknowledgement.
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
  const visibility =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Readonly<Record<string, unknown>>).visibility
      : undefined;
  const { sessionId } = await context.params;
  try {
    return proofApiSuccess(
      await setSessionVisibility(sessionId, visibility, { signal: request.signal }),
    );
  } catch (error) {
    return proofServiceFailure(error);
  }
}
