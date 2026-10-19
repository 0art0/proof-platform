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

  it("names the approved background by decision, and refuses any declaration of its own", async () => {
    const reference = { constructionId: "construction:web-1", decisionId: "background-decision-1" };
    const fetchMock = stubWorker({ session, node, metadata, replayed: false }, 201);
    await createProblemSession({ ...approval, approvedBackground: reference });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ ...approval, approvedBackground: reference });

    for (const approvedBackground of [
      { ...reference, operators: [] },
      { constructionId: "construction:web-1" },
      "background-decision-1",
    ]) {
      await expect(createProblemSession({ ...approval, approvedBackground })).rejects.toMatchObject(
        { code: "invalid_request" },
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names the approved library by decision, and refuses any artifact of its own", async () => {
    const reference = { constructionId: "construction:web-1", decisionId: "library-decision-1" };
    const fetchMock = stubWorker({ session, node, metadata, replayed: false }, 201);
    await createProblemSession({ ...approval, approvedLibrary: reference });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ ...approval, approvedLibrary: reference });

    for (const approvedLibrary of [
      { ...reference, results: [] },
      { ...reference, artifacts: [{ id: "result:library-x" }] },
      { constructionId: "construction:web-1" },
      "library-decision-1",
    ]) {
      await expect(createProblemSession({ ...approval, approvedLibrary })).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("relays an incomplete library recording as the worker's status", async () => {
    stubWorker(
      {
        diagnostics: [
          {
            code: "initial-library-incomplete",
            message: "The session exists, but its library is incomplete. Approve again.",
          },
        ],
      },
      503,
    );
    expect(
      await createProblemSession({
        ...approval,
        approvedLibrary: { constructionId: "construction:web-1", decisionId: "library-1" },
      }),
    ).toMatchObject({ ok: false, status: 503, code: "initial-library-incomplete" });
  });

  it("relays an unknown or rejected approved background as the worker's status", async () => {
    stubWorker(
      { diagnostics: [{ code: "decision-not-found", message: "No such decision." }] },
      404,
    );
    expect(
      await createProblemSession({
        ...approval,
        approvedBackground: { constructionId: "construction:web-1", decisionId: "decision:x" },
      }),
    ).toMatchObject({ ok: false, status: 404, code: "decision-not-found" });
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

  it("names the approved background by decision, and refuses any declaration of its own", async () => {
    const reference = { constructionId: "construction:web-1", decisionId: "background-decision-1" };
    const fetchMock = stubWorker(
      { ok: false, diagnostics: [{ code: "invalid-draft", message: "m", path: [] }] },
      422,
    );
    await validateProblemDraftRequest({ draft: {}, approvedBackground: reference });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://proof-worker.test/problem-drafts/validate");
    expect(JSON.parse(String(init.body))).toEqual({ draft: {}, approvedBackground: reference });

    await expect(
      validateProblemDraftRequest({
        draft: {},
        approvedBackground: { ...reference, constants: [{ symbol: "Coprime" }] },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names the approved library by decision, and relays the review with its initial library", async () => {
    const reference = { constructionId: "construction:web-1", decisionId: "library-decision-1" };
    const review = {
      rootNode: node,
      operators: [],
      metadata,
      activePackIds: [],
      initialLibrary: {
        results: [
          {
            id: "result:library-x",
            name: "X",
            description: "A general result.",
            statement: ["Equal", "a", "a"],
            premises: [],
          },
        ],
        variantCount: 0,
        addedOperatorSymbols: [],
      },
      digest: `sha256:${"d".repeat(64)}`,
    };
    const fetchMock = stubWorker({ ok: true, review }, 200);
    const answer = await validateProblemDraftRequest({ draft: {}, approvedLibrary: reference });
    expect(answer).toMatchObject({ ok: true, status: 200, body: { ok: true, review } });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ draft: {}, approvedLibrary: reference });

    await expect(
      validateProblemDraftRequest({
        draft: {},
        approvedLibrary: { ...reference, results: [{ id: "result:library-x" }] },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("relays the library diagnostics of a draft the approved library does not fit", async () => {
    const diagnostics = [
      {
        code: "approved-library-invalid",
        message: "The approved result X is not valid with this setup's operators.",
        path: ["approvedLibrary"],
      },
    ];
    stubWorker({ ok: false, diagnostics }, 422);
    expect(
      await validateProblemDraftRequest({
        draft: {},
        approvedLibrary: { constructionId: "construction:web-1", decisionId: "library-decision-1" },
      }),
    ).toMatchObject({ ok: false, status: 422, code: "invalid-draft", body: { diagnostics } });
  });
});
