import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ backtrackProofSession: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, backtrackProofSession: mocks.backtrackProofSession };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { POST } from "./route";

const ORIGIN = "http://proof.test";
const body = { expectedCurrentNodeId: "node:after", targetNodeId: "node:root" };
const context = { params: Promise.resolve({ sessionId: "session:test" }) };

function request(value: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/proof-sessions/session%3Atest/backtrack`, {
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

afterEach(() => mocks.backtrackProofSession.mockReset());

describe("POST /api/proof-sessions/:sessionId/backtrack", () => {
  it("forwards the expected pointer and target and always returns 200", async () => {
    const result = {
      session: { id: "session:test", currentNodeId: "node:root" },
      node: { id: "node:root" },
      replayed: false,
    };
    const incoming = request(body);
    mocks.backtrackProofSession.mockResolvedValue(result);

    const response = await POST(incoming, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: result });
    expect(mocks.backtrackProofSession).toHaveBeenCalledExactlyOnceWith("session:test", body, {
      signal: incoming.signal,
    });
  });

  it.each([
    ["extra authority", { ...body, force: true }, {}],
    ["invalid target", { ...body, targetNodeId: "not a stable ID" }, {}],
    ["cross-origin", body, { origin: "https://hostile.test" }],
    ["non-JSON", body, { "content-type": "text/plain" }],
  ])("rejects %s before calling the adapter", async (_label, value, headers) => {
    const response = await POST(request(value, headers), context);
    expect([400, 403, 415]).toContain(response.status);
    expect(mocks.backtrackProofSession).not.toHaveBeenCalled();
  });

  it("preserves a stale expected-pointer conflict", async () => {
    mocks.backtrackProofSession.mockRejectedValue(
      new ProofServiceError(
        "serialized-stale-backtrack",
        "The expected current node is stale.",
        409,
      ),
    );
    const response = await POST(request(body), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "serialized-stale-backtrack" },
    });
  });
});
