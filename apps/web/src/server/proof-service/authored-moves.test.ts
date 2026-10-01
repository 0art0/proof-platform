import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readAuthoredMoves, submitProtocolCommand, validateAuthoredMoveTemplate } from ".";

const SESSION_ID = "session:test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

afterEach(() => vi.unstubAllGlobals());

const revision = {
  draftArtifactId: "authored:demo.draft.command:a",
  revision: 1,
  authorId: "actor:web",
  status: "draft",
  definitionDigest: `sha256:${"a".repeat(64)}`,
  template: { id: "authored:demo" },
};

describe("authored-move reads", () => {
  it("reads the session's authored moves from the worker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        sessionId: SESSION_ID,
        moves: [
          { moveId: "authored:demo", name: "Demo", revisions: [revision], retrievable: false },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const moves = await readAuthoredMoves(SESSION_ID);

    expect(moves.moves[0]?.revisions[0]?.status).toBe("draft");
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /\/proof-sessions\/session%3Atest\/authored-moves$/,
    );
  });

  it("rejects a malformed response and a response for another session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          sessionId: SESSION_ID,
          moves: [
            { moveId: "authored:demo", name: "Demo", revisions: [{ ...revision, status: "x" }] },
          ],
        }),
      ),
    );
    await expect(readAuthoredMoves(SESSION_ID)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ sessionId: "session:other", moves: [] })),
    );
    await expect(readAuthoredMoves(SESSION_ID)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("maps an unknown session to a not-found failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { diagnostics: [{ code: "session-not-found", message: "No such session." }] },
            404,
          ),
        ),
    );
    await expect(readAuthoredMoves(SESSION_ID)).rejects.toMatchObject({
      code: "session-not-found",
      status: 404,
    });
  });
});

describe("template validation", () => {
  const template = { id: "authored:demo", name: "Demo" };

  it("posts the template and returns the report or the diagnostics", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          sessionId: SESSION_ID,
          ok: true,
          report: {
            transitionClass: "equivalence",
            stepCount: 1,
            retrievable: true,
            examples: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          sessionId: SESSION_ID,
          ok: false,
          diagnostics: [
            { code: "missing-example", message: "Needs examples.", path: ["examples"] },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateAuthoredMoveTemplate(SESSION_ID, { template })).resolves.toMatchObject({
      ok: true,
      report: { retrievable: true },
    });
    await expect(validateAuthoredMoveTemplate(SESSION_ID, { template })).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: "missing-example" }],
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(url)).toMatch(/\/authored-moves\/validate$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ template });
  });

  it("rejects a request that is not a template before calling the worker", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(validateAuthoredMoveTemplate(SESSION_ID, { template: [] })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a refused authoring command", () => {
  const envelope = {
    commandId: "command:web-review-move-1",
    actor: { id: "actor:web", kind: "human" },
    command: {
      kind: "review-move-draft",
      draftArtifactId: "authored:demo.draft.1",
      decision: "approved",
      notes: "",
      payloadSource: "reviewed-authoring",
    },
  };

  it("relays the template validation diagnostics that come with the refusal", async () => {
    const body = {
      diagnostics: [
        { code: "move-validation-failed", message: "The template does not pass validation." },
      ],
      validation: [{ code: "missing-example", message: "Needs examples.", path: ["examples"] }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body, 422)));

    const answer = await submitProtocolCommand(SESSION_ID, envelope);

    expect(answer).toMatchObject({ ok: false, status: 422, code: "move-validation-failed", body });
  });
});
