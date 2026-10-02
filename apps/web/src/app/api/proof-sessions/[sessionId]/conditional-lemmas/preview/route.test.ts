import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ previewConditionalLemma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, previewConditionalLemma: mocks.previewConditionalLemma };
});

import { ProofServiceError } from "../../../../../../server/proof-service";
import { POST } from "./route";

const ORIGIN = "http://proof.test";
const body = { nodeId: "node:root", target: { kind: "goal", id: "goal:main" } };
const context = { params: Promise.resolve({ sessionId: "session:test" }) };

function request(value: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/proof-sessions/session%3Atest/conditional-lemmas/preview`, {
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

afterEach(() => mocks.previewConditionalLemma.mockReset());

describe("POST /api/proof-sessions/:sessionId/conditional-lemmas/preview", () => {
  it("forwards the node and target and relays the preview", async () => {
    const preview = {
      sessionId: "session:test",
      preview: { status: "refused", code: "lemma-not-closed", message: "Still open." },
    };
    const incoming = request(body);
    mocks.previewConditionalLemma.mockResolvedValue(preview);

    const response = await POST(incoming, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: preview });
    expect(mocks.previewConditionalLemma).toHaveBeenCalledExactlyOnceWith("session:test", body, {
      signal: incoming.signal,
    });
  });

  it.each([
    ["extra authority", { ...body, lemma: { renderings: { latex: "x" } } }, {}],
    ["a missing target", { nodeId: "node:root" }, {}],
    ["a bad target kind", { ...body, target: { kind: "node", id: "x" } }, {}],
    ["cross-origin", body, { origin: "https://hostile.test" }],
    ["non-JSON", body, { "content-type": "text/plain" }],
  ])("rejects %s before calling the adapter", async (_label, value, headers) => {
    const response = await POST(request(value, headers), context);
    expect([400, 403, 415]).toContain(response.status);
    expect(mocks.previewConditionalLemma).not.toHaveBeenCalled();
  });

  it("preserves a worker failure", async () => {
    mocks.previewConditionalLemma.mockRejectedValue(
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
