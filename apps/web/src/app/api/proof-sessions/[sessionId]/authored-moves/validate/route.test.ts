import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ validateAuthoredMoveTemplate: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, validateAuthoredMoveTemplate: mocks.validateAuthoredMoveTemplate };
});

import { ProofServiceError } from "../../../../../../server/proof-service";
import { POST } from "./route";

const ORIGIN = "http://proof.test";
const body = { template: { id: "authored:demo", name: "Demo" } };
const context = { params: Promise.resolve({ sessionId: "session:test" }) };

function request(value: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/proof-sessions/session%3Atest/authored-moves/validate`, {
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

afterEach(() => mocks.validateAuthoredMoveTemplate.mockReset());

describe("POST /api/proof-sessions/:sessionId/authored-moves/validate", () => {
  it("forwards the template and relays the validation without recording anything", async () => {
    const validation = {
      sessionId: "session:test",
      ok: false,
      diagnostics: [{ code: "missing-example", message: "Needs examples.", path: ["examples"] }],
    };
    const incoming = request(body);
    mocks.validateAuthoredMoveTemplate.mockResolvedValue(validation);

    const response = await POST(incoming, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: validation });
    expect(mocks.validateAuthoredMoveTemplate).toHaveBeenCalledExactlyOnceWith(
      "session:test",
      body,
      { signal: incoming.signal },
    );
  });

  it.each([
    ["extra authority", { ...body, actor: { id: "actor:x", kind: "human" } }, {}],
    ["missing template", {}, {}],
    ["a non-object template", { template: [1] }, {}],
    ["cross-origin", body, { origin: "https://hostile.test" }],
    ["non-JSON", body, { "content-type": "text/plain" }],
  ])("rejects %s before calling the adapter", async (_label, value, headers) => {
    const response = await POST(request(value, headers), context);
    expect([400, 403, 415]).toContain(response.status);
    expect(mocks.validateAuthoredMoveTemplate).not.toHaveBeenCalled();
  });

  it("accepts a body larger than an ordinary command but refuses an oversized one", async () => {
    mocks.validateAuthoredMoveTemplate.mockResolvedValue({ sessionId: "session:test", ok: true });
    const large = { template: { filler: "x".repeat(100 * 1024) } };
    expect((await POST(request(large), context)).status).toBe(200);
    const huge = { template: { filler: "x".repeat(300 * 1024) } };
    expect((await POST(request(huge), context)).status).toBe(413);
  });

  it("preserves an upstream refusal", async () => {
    mocks.validateAuthoredMoveTemplate.mockRejectedValue(
      new ProofServiceError("session-not-found", "The proof session does not exist.", 404),
    );
    const response = await POST(request(body), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "session-not-found" },
    });
  });
});
