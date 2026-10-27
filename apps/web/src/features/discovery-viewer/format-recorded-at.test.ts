import { describe, expect, it } from "vitest";
import { formatRecordedAt } from "./format-recorded-at";

describe("formatRecordedAt", () => {
  it("writes a stored ISO timestamp in UTC for reading", () => {
    expect(formatRecordedAt("2026-09-29T12:00:00.000Z")).toBe("29 Sep 2026, 12:00:00 UTC");
    expect(formatRecordedAt("2026-01-05T03:04:05+02:00")).toBe("5 Jan 2026, 01:04:05 UTC");
  });

  it("leaves a value that is not a date as it was stored", () => {
    expect(formatRecordedAt("not a date")).toBe("not a date");
  });
});
