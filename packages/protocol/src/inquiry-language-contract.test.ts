import type { InquiryRecordView } from "@proof/language";
import { describe, expect, it } from "vitest";
import type { InquiryRecord } from ".";

/**
 * `@proof/language` renders inquiry records through `InquiryRecordView`, a structural mirror of
 * `InquiryRecord` that keeps the language package independent of the protocol. This compile-time
 * assertion makes typecheck fail when the protocol's records drift from that mirror.
 */
type Assignable<From, To> = [From] extends [To] ? true : false;

const storedRecordsAreRenderable: Assignable<InquiryRecord, InquiryRecordView> = true;

describe("inquiry records and the language mirror", () => {
  it("keeps every stored inquiry record assignable to the rendered view", () => {
    expect(storedRecordsAreRenderable).toBe(true);
  });
});
