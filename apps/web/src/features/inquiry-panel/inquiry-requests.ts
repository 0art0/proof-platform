import { inquiryRecordListSchema, type InquiryRecord } from "@proof/protocol";
import { z } from "zod";

const PAGE_SIZE = 500;
/** A bound on paging, so a misbehaving service cannot loop the browser. */
const MAX_PAGES = 40;

const pageResponseSchema = z
  .object({ ok: z.literal(true), data: z.object({ records: inquiryRecordListSchema }).strict() })
  .strict();

export type InquiryRecordsResult =
  | Readonly<{ ok: true; records: readonly InquiryRecord[] }>
  | Readonly<{ ok: false; message: string }>;

/** Read every stored inquiry record of the session, page by page, in sequence order. */
export async function fetchInquiryRecords(
  sessionId: string,
  signal?: AbortSignal,
): Promise<InquiryRecordsResult> {
  const records: InquiryRecord[] = [];
  let after = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let body: unknown;
    let status: number;
    try {
      const response = await fetch(
        `/api/proof-sessions/${encodeURIComponent(sessionId)}/inquiry-records?after=${after}&limit=${PAGE_SIZE}`,
        { cache: "no-store", ...(signal === undefined ? {} : { signal }) },
      );
      status = response.status;
      body = await response.json();
    } catch {
      return { ok: false, message: "The proof service could not be reached." };
    }
    const parsed = pageResponseSchema.safeParse(body);
    if (!parsed.success) {
      const failure = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .safeParse(body);
      return {
        ok: false,
        message: failure.success
          ? `${failure.data.error.message || "The request was refused."} (${failure.data.error.code})`
          : `The proof service returned an invalid response (status ${status}).`,
      };
    }
    const batch = parsed.data.data.records;
    records.push(...batch);
    if (batch.length < PAGE_SIZE) return { ok: true, records };
    after = batch[batch.length - 1]!.sequence;
  }
  return { ok: false, message: "The inquiry history is too long to load." };
}
