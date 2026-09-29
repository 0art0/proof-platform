import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readSessionLibrary: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, readSessionLibrary: mocks.readSessionLibrary };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { GET } from "./route";

const context = { params: Promise.resolve({ sessionId: "session:test" }) };

afterEach(() => mocks.readSessionLibrary.mockReset());

describe("GET /api/proof-sessions/:sessionId/library", () => {
  it("returns the library with no-store and forwards cancellation", async () => {
    const library = {
      sessionId: "session:test",
      readOnly: false,
      entries: [],
      variantFamilies: [],
    };
    const request = new Request("http://proof.test/api/proof-sessions/session%3Atest/library");
    mocks.readSessionLibrary.mockResolvedValue(library);

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({ ok: true, data: library });
    expect(mocks.readSessionLibrary).toHaveBeenCalledExactlyOnceWith("session:test", {
      signal: request.signal,
    });
  });

  it("preserves an unknown-session failure", async () => {
    mocks.readSessionLibrary.mockRejectedValue(
      new ProofServiceError("session-not-found", "The proof session does not exist.", 404),
    );
    const response = await GET(
      new Request("http://proof.test/api/proof-sessions/session%3Atest/library"),
      context,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "session-not-found" },
    });
  });
});
