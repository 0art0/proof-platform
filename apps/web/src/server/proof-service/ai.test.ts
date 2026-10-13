import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { NO_AI_CAPABILITIES, ProofServiceError, readAiCapabilities, relayAiRequest } from ".";

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

describe("readAiCapabilities", () => {
  it("reads the configured roles and ignores unknown ones", async () => {
    stubWorker(
      {
        roles: {
          "topic-extractor": true,
          "proof-state-formalizer": false,
          "move-shortlister": true,
          attestor: true,
        },
      },
      200,
    );
    expect(await readAiCapabilities()).toEqual({
      "topic-extractor": true,
      "proof-state-formalizer": false,
      "move-shortlister": true,
    });
  });

  it("treats an unreachable or malformed worker as having no AI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    process.env.PROOF_HTTP_ORIGIN = "http://proof-worker.test";
    expect(await readAiCapabilities()).toEqual(NO_AI_CAPABILITIES);
    stubWorker({ roles: "all" }, 200);
    expect(await readAiCapabilities()).toEqual(NO_AI_CAPABILITIES);
  });
});

describe("relayAiRequest", () => {
  it("posts to the worker endpoint and relays a proposal", async () => {
    const fetchMock = stubWorker({ status: "proposed", callId: "llm-call:x" }, 200);
    const answer = await relayAiRequest({ kind: "shortlist", sessionId: "session:a" }, { id: 1 });
    expect(answer).toEqual({
      ok: true,
      status: 200,
      body: { status: "proposed", callId: "llm-call:x" },
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://proof-worker.test/proof-sessions/session%3Aa/ai/shortlist");
    expect(init.body).toBe(JSON.stringify({ id: 1 }));
  });

  it.each([
    [422, 422],
    [429, 429],
    [409, 409],
    [503, 503],
    [500, 502],
  ])("maps a worker %s to %s with its first diagnostic", async (status, expected) => {
    const body = { status: "x", diagnostics: [{ code: "some-code", message: "Some message." }] };
    stubWorker(body, status);
    expect(await relayAiRequest({ kind: "topics" }, {})).toEqual({
      ok: false,
      status: expected,
      code: "some-code",
      message: "Some message.",
      body,
    });
  });

  it("refuses non-object requests and failures without diagnostics", async () => {
    await expect(relayAiRequest({ kind: "formalize" }, [])).rejects.toBeInstanceOf(
      ProofServiceError,
    );
    stubWorker({ status: "x" }, 500);
    await expect(relayAiRequest({ kind: "formalize" }, {})).rejects.toBeInstanceOf(
      ProofServiceError,
    );
  });
});
