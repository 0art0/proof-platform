import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readCurrentProofSession: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, readCurrentProofSession: mocks.readCurrentProofSession };
});

import { ProofServiceError } from "../../../../server/proof-service";
import { GET } from "./route";

afterEach(() => mocks.readCurrentProofSession.mockReset());

describe("GET /api/proof-sessions/:sessionId", () => {
  it("returns a no-store session envelope and forwards cancellation", async () => {
    const request = new Request("http://proof.test/api/proof-sessions/session%3Atest");
    mocks.readCurrentProofSession.mockResolvedValue({
      session: { id: "session:test", currentNodeId: "node:test", operators: [] },
      node: { id: "node:test", state: { id: "state:test", goals: [], obligations: [] } },
    });

    const response = await GET(request, {
      params: Promise.resolve({ sessionId: "session:test" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { session: { id: "session:test" }, node: { id: "node:test" } },
    });
    expect(mocks.readCurrentProofSession).toHaveBeenCalledExactlyOnceWith("session:test", {
      signal: request.signal,
    });
  });

  it("preserves a validated worker failure code", async () => {
    mocks.readCurrentProofSession.mockRejectedValue(
      new ProofServiceError("session-not-found", "The session was not found.", 404),
    );

    const response = await GET(
      new Request("http://proof.test/api/proof-sessions/session%3Amissing"),
      { params: Promise.resolve({ sessionId: "session:missing" }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "session-not-found", message: "The session was not found." },
    });
  });
});
