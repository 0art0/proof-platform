import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readSessionVisibility: vi.fn(), setSessionVisibility: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    readSessionVisibility: mocks.readSessionVisibility,
    setSessionVisibility: mocks.setSessionVisibility,
  };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { GET, PATCH } from "./route";

afterEach(() => {
  mocks.readSessionVisibility.mockReset();
  mocks.setSessionVisibility.mockReset();
});

const url = "http://proof.test/api/proof-sessions/session%3Atest/visibility";
const context = { params: Promise.resolve({ sessionId: "session:test" }) };
const sameOriginJson = {
  origin: "http://proof.test",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

function patch(body: unknown, headers: Record<string, string> = sameOriginJson): Request {
  return new Request(url, {
    method: "PATCH",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/proof-sessions/:sessionId/visibility", () => {
  it("returns the visibility in a no-store envelope", async () => {
    mocks.readSessionVisibility.mockResolvedValue({
      sessionId: "session:test",
      visibility: "private",
    });
    const request = new Request(url);
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({
      ok: true,
      data: { sessionId: "session:test", visibility: "private" },
    });
    expect(mocks.readSessionVisibility).toHaveBeenCalledExactlyOnceWith("session:test", {
      signal: request.signal,
    });
  });

  it("maps a missing session", async () => {
    mocks.readSessionVisibility.mockRejectedValue(
      new ProofServiceError("session-not-found", "The session was not found.", 404),
    );
    expect((await GET(new Request(url), context)).status).toBe(404);
  });
});

describe("PATCH /api/proof-sessions/:sessionId/visibility", () => {
  it("sets the visibility from a same-origin JSON request", async () => {
    mocks.setSessionVisibility.mockResolvedValue({
      sessionId: "session:test",
      visibility: "shared",
    });
    const request = patch({ visibility: "shared" });
    const response = await PATCH(request, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { sessionId: "session:test", visibility: "shared" },
    });
    expect(mocks.setSessionVisibility).toHaveBeenCalledExactlyOnceWith("session:test", "shared", {
      signal: request.signal,
    });
  });

  it("refuses cross-origin and non-JSON requests without calling the worker", async () => {
    const foreign = await PATCH(
      patch(
        { visibility: "shared" },
        {
          origin: "http://evil.test",
          "sec-fetch-site": "cross-site",
          "content-type": "application/json",
        },
      ),
      context,
    );
    expect(foreign.status).toBe(403);
    const text = await PATCH(
      patch("x", {
        origin: "http://proof.test",
        "sec-fetch-site": "same-origin",
        "content-type": "text/plain",
      }),
      context,
    );
    expect(text.status).toBe(415);
    expect(mocks.setSessionVisibility).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies and relays the adapter's validation error", async () => {
    expect((await PATCH(patch("{not json"), context)).status).toBe(400);
    mocks.setSessionVisibility.mockRejectedValue(
      new ProofServiceError(
        "invalid_request",
        'The visibility must be "private" or "shared".',
        400,
      ),
    );
    const response = await PATCH(patch({ visibility: "public" }), context);
    expect(response.status).toBe(400);
    expect(mocks.setSessionVisibility).toHaveBeenCalledWith(
      "session:test",
      "public",
      expect.anything(),
    );
  });
});
