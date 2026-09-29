import { inquiryRecordsQuerySchema, readInquiryRecords } from "../../../../../server/proof-service";
import { proofApiFailure, proofApiSuccess, proofServiceFailure } from "../../http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

const INTEGER_PARAMETERS = new Set(["after", "limit"]);

/** Stored inquiry records (roadmap N22, N34): `?nodeId=…&commandId=…&after=…&limit=…`. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const keys = [...searchParams.keys()];
  if (new Set(keys).size !== keys.length) {
    return proofApiFailure("invalid_request", "Each parameter appears at most once.", 400);
  }
  const query: Record<string, unknown> = {};
  for (const [key, value] of searchParams) {
    query[key] =
      INTEGER_PARAMETERS.has(key) && /^(0|[1-9][0-9]{0,9})$/.test(value) ? Number(value) : value;
  }
  const parsed = inquiryRecordsQuerySchema.safeParse(query);
  if (!parsed.success) {
    return proofApiFailure("invalid_request", "The inquiry-record query is invalid.", 400);
  }

  const { sessionId } = await context.params;
  try {
    return proofApiSuccess(
      await readInquiryRecords(sessionId, parsed.data, { signal: request.signal }),
    );
  } catch (error) {
    return proofServiceFailure(error);
  }
}
