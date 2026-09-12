import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readProofHistory: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, readProofHistory: mocks.readProofHistory };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { GET } from "./route";

const context = { params: Promise.resolve({ sessionId: "session:test" }) };

afterEach(() => mocks.readProofHistory.mockReset());

describe("GET /api/proof-sessions/:sessionId/history", () => {
  it("returns the retained tree with no-store and forwards cancellation", async () => {
    const history = {
      session: { id: "session:test", rootNodeId: "node:root", currentNodeId: "node:root" },
      nodes: [{ id: "node:root" }],
      edges: [],
    };
    const request = new Request("http://proof.test/api/proof-sessions/session%3Atest/history");
    mocks.readProofHistory.mockResolvedValue(history);

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({ ok: true, data: history });
    expect(mocks.readProofHistory).toHaveBeenCalledExactlyOnceWith("session:test", {
      signal: request.signal,
    });
  });

  it("preserves a validated history failure", async () => {
    mocks.readProofHistory.mockRejectedValue(
      new ProofServiceError("invalid-proof-history", "The stored tree is invalid.", 502),
    );
    const response = await GET(
      new Request("http://proof.test/api/proof-sessions/session%3Atest/history"),
      context,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "invalid-proof-history" },
    });
  });
});
