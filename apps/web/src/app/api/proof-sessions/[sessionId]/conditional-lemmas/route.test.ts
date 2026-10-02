import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readConditionalLemmas: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, readConditionalLemmas: mocks.readConditionalLemmas };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { GET } from "./route";

const context = { params: Promise.resolve({ sessionId: "session:test" }) };

afterEach(() => mocks.readConditionalLemmas.mockReset());

describe("GET /api/proof-sessions/:sessionId/conditional-lemmas", () => {
  it("returns the candidates with no-store and forwards cancellation", async () => {
    const candidates = { sessionId: "session:test", readOnly: false, candidates: [] };
    const request = new Request(
      "http://proof.test/api/proof-sessions/session%3Atest/conditional-lemmas",
    );
    mocks.readConditionalLemmas.mockResolvedValue(candidates);

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({ ok: true, data: candidates });
    expect(mocks.readConditionalLemmas).toHaveBeenCalledExactlyOnceWith("session:test", {
      signal: request.signal,
    });
  });

  it("preserves an unknown-session failure", async () => {
    mocks.readConditionalLemmas.mockRejectedValue(
      new ProofServiceError("session-not-found", "The proof session does not exist.", 404),
    );
    const response = await GET(
      new Request("http://proof.test/api/proof-sessions/session%3Atest/conditional-lemmas"),
      context,
    );
    expect(response.status).toBe(404);
  });
});
