import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createStoredMovePreview: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, createStoredMovePreview: mocks.createStoredMovePreview };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { POST } from "./route";

const ORIGIN = "http://proof.test";
const choice = {
  commandId: "command:test",
  suggestionSetId: "suggestion-set:test",
  chosenSuggestionId: "suggestion:test",
};
const context = { params: Promise.resolve({ sessionId: "session:test" }) };

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/proof-sessions/session%3Atest/move-previews`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => mocks.createStoredMovePreview.mockReset());

describe("POST /api/proof-sessions/:sessionId/move-previews", () => {
  it("forwards only the exact choice DTO and preserves preview idempotency status", async () => {
    const incoming = request(choice);
    mocks.createStoredMovePreview.mockResolvedValue({
      preview: { id: "preview:test" },
      replayed: false,
    });

    const response = await POST(incoming, context);

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({
      ok: true,
      data: { preview: { id: "preview:test" }, replayed: false },
    });
    expect(mocks.createStoredMovePreview).toHaveBeenCalledExactlyOnceWith("session:test", choice, {
      signal: incoming.signal,
    });

    mocks.createStoredMovePreview.mockResolvedValue({
      preview: { id: "preview:test" },
      replayed: true,
    });
    expect((await POST(request(choice), context)).status).toBe(200);
  });

  it.each([
    ["extra command materialization", { ...choice, operation: { kind: "close-true" } }, 400, {}],
    ["malformed JSON", "{", 400, {}],
    ["cross-origin request", choice, 403, { origin: "https://hostile.test" }],
    ["non-JSON request", choice, 415, { "content-type": "text/plain" }],
  ])("rejects %s before calling the adapter", async (_label, body, status, headers) => {
    const response = await POST(request(body, headers), context);
    expect(response.status).toBe(status);
    expect(mocks.createStoredMovePreview).not.toHaveBeenCalled();
  });

  it("preserves a validated preview rejection", async () => {
    mocks.createStoredMovePreview.mockRejectedValue(
      new ProofServiceError("preview-rejected", "The choice is stale.", 400),
    );
    const response = await POST(request(choice), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "preview-rejected", message: "The choice is stale." },
    });
  });
});
