import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readInquiryRecords: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, readInquiryRecords: mocks.readInquiryRecords };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { GET } from "./route";

const context = { params: Promise.resolve({ sessionId: "session:test" }) };

function request(query: string): Request {
  return new Request(`http://proof.test/api/proof-sessions/session%3Atest/inquiry-records${query}`);
}

afterEach(() => mocks.readInquiryRecords.mockReset());

describe("GET /api/proof-sessions/:sessionId/inquiry-records", () => {
  it("forwards the parsed query and cancellation, and returns the records with no-store", async () => {
    mocks.readInquiryRecords.mockResolvedValue({ records: [] });
    const incoming = request("?nodeId=node%3Aroot&commandId=command%3Aa&after=7&limit=500");
    const response = await GET(incoming, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { records: [] } });
    expect(mocks.readInquiryRecords).toHaveBeenCalledExactlyOnceWith(
      "session:test",
      { nodeId: "node:root", commandId: "command:a", after: 7, limit: 500 },
      { signal: incoming.signal },
    );
  });

  it("forwards an empty query", async () => {
    mocks.readInquiryRecords.mockResolvedValue({ records: [] });
    await GET(request(""), context);
    expect(mocks.readInquiryRecords.mock.calls[0]?.[1]).toEqual({});
  });

  it.each([
    ["unknown parameter", "?debug=1"],
    ["repeated parameter", "?after=1&after=2"],
    ["negative sequence", "?after=-1"],
    ["non-numeric limit", "?limit=many"],
    ["limit above the page maximum", "?limit=501"],
    ["invalid identifier", "?nodeId=%20"],
  ])("rejects %s before calling the adapter", async (_label, query) => {
    const response = await GET(request(query), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(mocks.readInquiryRecords).not.toHaveBeenCalled();
  });

  it("relays service failures", async () => {
    mocks.readInquiryRecords.mockRejectedValue(
      new ProofServiceError("session-not-found", "No such session.", 404),
    );
    const response = await GET(request(""), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "session-not-found" },
    });
  });
});
