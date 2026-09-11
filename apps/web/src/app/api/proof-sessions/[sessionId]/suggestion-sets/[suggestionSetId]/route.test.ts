import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readStoredSuggestionSet: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, readStoredSuggestionSet: mocks.readStoredSuggestionSet };
});

import { ProofServiceError } from "../../../../../../server/proof-service";
import { GET } from "./route";

afterEach(() => mocks.readStoredSuggestionSet.mockReset());

describe("GET /api/proof-sessions/:sessionId/suggestion-sets/:suggestionSetId", () => {
  it("returns the separately read persisted set without transforming its order", async () => {
    const request = new Request(
      "http://proof.test/api/proof-sessions/session%3Atest/suggestion-sets/suggestion-set%3Atest",
    );
    const suggestionSet = {
      id: "suggestion-set:test",
      suggestions: [
        { id: "suggestion:first", reasons: ["first reason"] },
        { id: "suggestion:second", reasons: ["second reason"] },
      ],
    };
    mocks.readStoredSuggestionSet.mockResolvedValue({ suggestionSet });

    const response = await GET(request, {
      params: Promise.resolve({
        sessionId: "session:test",
        suggestionSetId: "suggestion-set:test",
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({ ok: true, data: { suggestionSet } });
    expect(mocks.readStoredSuggestionSet).toHaveBeenCalledExactlyOnceWith(
      "session:test",
      "suggestion-set:test",
      { signal: request.signal },
    );
  });

  it("maps a validated not-found envelope without inventing suggestion data", async () => {
    mocks.readStoredSuggestionSet.mockRejectedValue(
      new ProofServiceError("suggestion-set-not-found", "The suggestion set does not exist.", 404),
    );

    const response = await GET(
      new Request("http://proof.test/api/proof-sessions/session%3Atest/suggestion-sets/missing"),
      {
        params: Promise.resolve({
          sessionId: "session:test",
          suggestionSetId: "suggestion-set:missing",
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "suggestion-set-not-found",
        message: "The suggestion set does not exist.",
      },
    });
  });
});
