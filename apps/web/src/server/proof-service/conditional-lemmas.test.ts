import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { previewConditionalLemma, readConditionalLemmas } from ".";

const SESSION_ID = "session:test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const ready = {
  status: "ready",
  nodeId: "node:root",
  target: { kind: "goal", id: "goal:main" },
  name: "Lemma: p",
  statement: { latex: "p \\implies p", naturalLanguage: "if $p$ then $p$" },
  conclusion: { latex: "p", naturalLanguage: "$p$" },
  premises: [{ id: "hyp:p", latex: "p", naturalLanguage: "$p$" }],
  unusedHypotheses: [{ id: "hyp:q", latex: "q", naturalLanguage: "$q$" }],
  conservative: [],
  parameters: ["p"],
  establishingSteps: 1,
  backgroundInferences: 0,
  existing: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("conditional-lemma reads", () => {
  it("reads the candidates and previews from the worker paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          sessionId: SESSION_ID,
          readOnly: false,
          candidates: [
            {
              nodeId: "node:root",
              target: { kind: "goal", id: "goal:main" },
              goal: { latex: "p", naturalLanguage: "$p$" },
              preview: ready,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sessionId: SESSION_ID, preview: ready }));
    vi.stubGlobal("fetch", fetchMock);

    const candidates = await readConditionalLemmas(SESSION_ID);
    expect(candidates.candidates[0]?.preview.status).toBe("ready");
    const request = { nodeId: "node:root", target: { kind: "goal", id: "goal:main" } };
    await expect(previewConditionalLemma(SESSION_ID, request)).resolves.toMatchObject({
      preview: { status: "ready" },
    });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(String(calls[0]?.[0])).toMatch(/\/proof-sessions\/session%3Atest\/conditional-lemmas$/);
    expect(String(calls[1]?.[0])).toMatch(/\/conditional-lemmas\/preview$/);
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual(request);
  });

  it("rejects a malformed response, a wrong session, and a bad request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          sessionId: SESSION_ID,
          preview: { status: "refused", code: "not-a-code", message: "x" },
        }),
      ),
    );
    await expect(
      previewConditionalLemma(SESSION_ID, {
        nodeId: "node:root",
        target: { kind: "goal", id: "goal:main" },
      }),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ sessionId: "session:other", readOnly: false, candidates: [] }),
        ),
    );
    await expect(readConditionalLemmas(SESSION_ID)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
    await expect(previewConditionalLemma(SESSION_ID, { nodeId: "n" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});
