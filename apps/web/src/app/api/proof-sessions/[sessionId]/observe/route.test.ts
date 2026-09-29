import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ observeProofSession: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, observeProofSession: mocks.observeProofSession };
});

import { GET } from "./route";

const context = { params: Promise.resolve({ sessionId: "session:test" }) };

function request(query: string): Request {
  return new Request(`http://proof.test/api/proof-sessions/session%3Atest/observe${query}`);
}

afterEach(() => mocks.observeProofSession.mockReset());

describe("GET /api/proof-sessions/:sessionId/observe", () => {
  it("forwards a parsed delta query", async () => {
    const body = { view: "delta", relation: "same" };
    mocks.observeProofSession.mockResolvedValue({ ok: true, status: 200, body });
    const incoming = request("?view=delta&sinceNode=node%3Aroot&afterEvent=3&afterInquiry=0");
    const response = await GET(incoming, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: body });
    expect(mocks.observeProofSession).toHaveBeenCalledExactlyOnceWith(
      "session:test",
      { view: "delta", sinceNode: "node:root", afterEvent: 3, afterInquiry: 0 },
      { signal: incoming.signal },
    );
  });

  it("defaults to the full view", async () => {
    mocks.observeProofSession.mockResolvedValue({ ok: true, status: 200, body: { view: "full" } });
    await GET(request(""), context);
    expect(mocks.observeProofSession.mock.calls[0]?.[1]).toEqual({ view: "full" });
  });

  it.each([
    ["unknown view", "?view=everything"],
    ["delta without cursor", "?view=delta"],
    ["negative sequence", "?view=delta&sinceNode=node%3Aa&afterEvent=-1"],
    ["repeated parameter", "?view=full&view=summary"],
    ["unknown parameter", "?view=full&debug=1"],
  ])("rejects %s before calling the adapter", async (_label, query) => {
    const response = await GET(request(query), context);
    expect(response.status).toBe(400);
    expect(mocks.observeProofSession).not.toHaveBeenCalled();
  });

  it("relays worker diagnostics", async () => {
    mocks.observeProofSession.mockResolvedValue({
      ok: false,
      status: 404,
      code: "unknown-reference",
      message: "The node is not in the tree.",
      body: {
        diagnostics: [{ code: "unknown-reference", message: "The node is not in the tree." }],
      },
    });
    const response = await GET(request("?view=delta&sinceNode=node%3Agone"), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "unknown-reference" },
    });
  });
});
