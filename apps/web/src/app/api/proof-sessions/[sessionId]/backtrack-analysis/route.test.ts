import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ analyzeBacktrackProofSession: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, analyzeBacktrackProofSession: mocks.analyzeBacktrackProofSession };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { POST } from "./route";

const ORIGIN = "http://proof.test";
const body = {
  sourceNodeId: "node:after",
  sourceTarget: { kind: "goal", id: "goal:main" },
  proposition: ["Not", "p"],
};
const context = { params: Promise.resolve({ sessionId: "session:test" }) };

function request(value: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/proof-sessions/session%3Atest/backtrack-analysis`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
    body: JSON.stringify(value),
  });
}

afterEach(() => mocks.analyzeBacktrackProofSession.mockReset());

describe("POST /api/proof-sessions/:sessionId/backtrack-analysis", () => {
  it("forwards the dry-run request and relays the analysis", async () => {
    const result = { analysis: { sourceNodeId: "node:after" } };
    const incoming = request(body);
    mocks.analyzeBacktrackProofSession.mockResolvedValue(result);

    const response = await POST(incoming, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: result });
    expect(mocks.analyzeBacktrackProofSession).toHaveBeenCalledExactlyOnceWith(
      "session:test",
      body,
      { signal: incoming.signal },
    );
  });

  it.each([
    ["extra authority", { ...body, actor: { id: "actor:x", kind: "human" } }, {}],
    ["missing proposition", { sourceNodeId: "node:after" }, {}],
    ["cross-origin", body, { origin: "https://hostile.test" }],
    ["non-JSON", body, { "content-type": "text/plain" }],
  ])("rejects %s before calling the adapter", async (_label, value, headers) => {
    const response = await POST(request(value, headers), context);
    expect([400, 403, 415]).toContain(response.status);
    expect(mocks.analyzeBacktrackProofSession).not.toHaveBeenCalled();
  });

  it("preserves an upstream refusal", async () => {
    mocks.analyzeBacktrackProofSession.mockRejectedValue(
      new ProofServiceError("backtrack-rejected", "The root node has no ancestor.", 422),
    );
    const response = await POST(request(body), context);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "backtrack-rejected" },
    });
  });
});
