import { afterEach, describe, expect, it, vi } from "vitest";
import { proofNodeSchema } from "@proof/protocol";

vi.mock("server-only", () => ({}));

import { ProofServiceError, createProblemSession, validateProblemDraftRequest } from ".";

const node = proofNodeSchema.parse({
  id: "node:root",
  state: {
    id: "state:root",
    goals: [
      {
        id: "goal:1",
        sequent: {
          context: { declarations: [], hypotheses: [] },
          conclusion: { expression: "True" },
        },
      },
    ],
    obligations: [],
  },
});
const metadata = {
  problem: { title: "t", statement: "s" },
  background: { level: "school", summary: "Logic.", assumptions: [] },
  libraryLayerIds: [],
};
const approval = {
  sessionId: "session:new",
  draft: {},
  reviewedDigest: `sha256:${"c".repeat(64)}`,
};
const session = {
  id: "session:new",
  rootNodeId: "node:root",
  currentNodeId: "node:root",
  operators: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PROOF_HTTP_ORIGIN;
});

function stubWorker(body: unknown, status: number) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body, status));
  vi.stubGlobal("fetch", fetchMock);
  process.env.PROOF_HTTP_ORIGIN = "http://proof-worker.test";
  return fetchMock;
}

describe("createProblemSession", () => {
  it("posts the approval and checks the created root", async () => {
    const fetchMock = stubWorker({ session, node, metadata, replayed: false }, 201);
    const answer = await createProblemSession(approval);
    expect(answer).toMatchObject({ ok: true, status: 201, body: { session, node } });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://proof-worker.test/proof-sessions");
    expect(JSON.parse(String(init.body))).toEqual(approval);
  });

  it("rejects a created session that is not the requested one", async () => {
    stubWorker(
      { session: { ...session, id: "session:other" }, node, metadata, replayed: false },
      201,
    );
    await expect(createProblemSession(approval)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("rejects a replay flag that contradicts the status", async () => {
    stubWorker({ session, node, metadata, replayed: true }, 201);
    await expect(createProblemSession(approval)).rejects.toBeInstanceOf(ProofServiceError);
  });

  it("returns conflicts and draft diagnostics instead of throwing", async () => {
    stubWorker({ diagnostics: [{ code: "review-stale", message: "Review again." }] }, 409);
    expect(await createProblemSession(approval)).toMatchObject({
      ok: false,
      status: 409,
      code: "review-stale",
    });
    const diagnostics = [{ code: "undeclared-symbol", message: "x", path: ["goals", 0, "latex"] }];
    stubWorker({ diagnostics }, 422);
    expect(await createProblemSession(approval)).toMatchObject({
      ok: false,
      status: 422,
      body: { diagnostics },
    });
  });

  it("refuses an invalid request before calling the worker", async () => {
    const fetchMock = stubWorker({}, 201);
    await expect(createProblemSession({ sessionId: "session:new" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("validateProblemDraftRequest", () => {
  it("returns every diagnostic of a rejected draft", async () => {
    const diagnostics = [
      { code: "reserved-symbol", message: "And is built in.", path: ["declarations", 0, "symbol"] },
      { code: "latex-parse-failed", message: "Goal 1: bad.", path: ["goals", 0, "latex"] },
    ];
    stubWorker({ ok: false, diagnostics }, 422);
    expect(await validateProblemDraftRequest({ draft: {} })).toEqual({
      ok: false,
      status: 422,
      code: "invalid-draft",
      message: "And is built in.",
      body: { diagnostics },
    });
  });

  it("rejects a malformed review", async () => {
    stubWorker({ ok: true, review: { digest: "nope" } }, 200);
    await expect(validateProblemDraftRequest({ draft: {} })).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });
});
