import { validateTemplateRequestSchema } from "../../../../../../features/move-authoring/api-contract";
import { validateAuthoredMoveTemplate } from "../../../../../../server/proof-service";
import {
  proofApiFailure,
  proofApiSuccess,
  proofServiceFailure,
  readBoundedJson,
  RequestBodyError,
  validateSameOriginJsonRequest,
} from "../../../http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/** A template with its example states is larger than an ordinary command; the worker allows this. */
const MAX_TEMPLATE_BYTES = 256 * 1024;

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

/** Dry-run a move template's validation (examples run through the kernel); nothing is recorded. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const rejected = validateSameOriginJsonRequest(request);
  if (rejected !== undefined) return rejected;

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_TEMPLATE_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return proofApiFailure("invalid_request", error.message, error.status);
    }
    return proofApiFailure("invalid_request", "The JSON request body is invalid.", 400);
  }
  const parsed = validateTemplateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return proofApiFailure("invalid_request", "Send { template } as a JSON object.", 400);
  }

  const { sessionId } = await context.params;
  try {
    return proofApiSuccess(
      await validateAuthoredMoveTemplate(sessionId, parsed.data, { signal: request.signal }),
    );
  } catch (error) {
    return proofServiceFailure(error);
  }
}
