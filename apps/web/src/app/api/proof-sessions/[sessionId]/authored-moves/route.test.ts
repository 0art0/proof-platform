import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readAuthoredMoves: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, readAuthoredMoves: mocks.readAuthoredMoves };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { GET } from "./route";

const context = { params: Promise.resolve({ sessionId: "session:test" }) };
const url = "http://proof.test/api/proof-sessions/session%3Atest/authored-moves";

afterEach(() => mocks.readAuthoredMoves.mockReset());

describe("GET /api/proof-sessions/:sessionId/authored-moves", () => {
  it("returns the authored moves with no-store and forwards cancellation", async () => {
    const moves = { sessionId: "session:test", moves: [] };
    const request = new Request(url);
    mocks.readAuthoredMoves.mockResolvedValue(moves);

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({ ok: true, data: moves });
    expect(mocks.readAuthoredMoves).toHaveBeenCalledExactlyOnceWith("session:test", {
      signal: request.signal,
    });
  });

  it("preserves an unknown-session failure", async () => {
    mocks.readAuthoredMoves.mockRejectedValue(
      new ProofServiceError("session-not-found", "The proof session does not exist.", 404),
    );
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "session-not-found" },
    });
  });
});
