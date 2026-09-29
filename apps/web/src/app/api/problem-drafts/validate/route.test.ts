import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ validateProblemDraftRequest: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, validateProblemDraftRequest: mocks.validateProblemDraftRequest };
});

import { POST } from "./route";

const ORIGIN = "http://proof.test";
const draft = { problem: { title: "t", statement: "s" } };

function request(value: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/problem-drafts/validate`, {
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

afterEach(() => mocks.validateProblemDraftRequest.mockReset());

describe("POST /api/problem-drafts/validate", () => {
  it("relays a review", async () => {
    const body = { ok: true, review: { digest: "sha256:x" } };
    mocks.validateProblemDraftRequest.mockResolvedValue({ ok: true, status: 200, body });
    const incoming = request({ draft });
    const response = await POST(incoming);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: body });
    expect(mocks.validateProblemDraftRequest).toHaveBeenCalledExactlyOnceWith(
      { draft },
      { signal: incoming.signal },
    );
  });

  it("relays every draft diagnostic with a 422", async () => {
    const diagnostics = [
      { code: "undeclared-symbol", message: "Goal 1 uses x.", path: ["goals", 0, "latex"] },
      { code: "reserved-symbol", message: "And is built in.", path: ["declarations", 0] },
    ];
    mocks.validateProblemDraftRequest.mockResolvedValue({
      ok: false,
      status: 422,
      code: "invalid-draft",
      message: "Goal 1 uses x.",
      body: { diagnostics },
    });
    const response = await POST(request({ draft }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "invalid-draft", message: "Goal 1 uses x." },
      details: { diagnostics },
    });
  });

  it.each([
    ["no draft", {}, {}],
    ["extra fields", { draft, sessionId: "session:x" }, {}],
    ["cross-origin", { draft }, { origin: "https://hostile.test" }],
    ["non-JSON", { draft }, { "content-type": "text/plain" }],
  ])("rejects %s before calling the adapter", async (_label, value, headers) => {
    const response = await POST(request(value, headers));
    expect([400, 403, 415]).toContain(response.status);
    expect(mocks.validateProblemDraftRequest).not.toHaveBeenCalled();
  });
});
