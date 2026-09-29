import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readSessionLibrary, readSessionLibraryEvents } from ".";

const SESSION_ID = "session:test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const artifact = {
  id: "result:test",
  kind: "result",
  name: "Test",
  description: "A test result.",
  layer: "global",
  renderings: { latex: "p", naturalLanguage: "p" },
  classification: { domains: ["logic"], level: "foundational" },
  provenance: { kind: "curated", source: "test" },
  approval: { status: "approved", reviewerId: "reviewer:test" },
  related: [],
  priority: 1,
  statement: { expression: "p" },
  premises: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("library reads", () => {
  it("reads the library and events from the worker paths", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          sessionId: SESSION_ID,
          readOnly: false,
          entries: [{ source: "approved-catalog", artifact }],
          variantFamilies: [],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sessionId: SESSION_ID, readOnly: false, events: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const library = await readSessionLibrary(SESSION_ID);
    expect(library.entries[0]?.artifact.id).toBe("result:test");
    await expect(readSessionLibraryEvents(SESSION_ID)).resolves.toMatchObject({ events: [] });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toMatch(/\/proof-sessions\/session%3Atest\/library$/);
    expect(urls[1]).toMatch(/\/proof-sessions\/session%3Atest\/library\/events$/);
  });

  it("rejects a malformed response, a wrong session, and maps 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          sessionId: SESSION_ID,
          readOnly: false,
          entries: [{ source: "approved-catalog", artifact: { ...artifact, kind: "bogus" } }],
          variantFamilies: [],
        }),
      ),
    );
    await expect(readSessionLibrary(SESSION_ID)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ sessionId: "session:other", readOnly: false, events: [] }),
        ),
    );
    await expect(readSessionLibraryEvents(SESSION_ID)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            diagnostics: [
              { code: "session-not-found", message: "The proof session does not exist." },
            ],
          },
          404,
        ),
      ),
    );
    await expect(readSessionLibrary(SESSION_ID)).rejects.toMatchObject({
      code: "session-not-found",
      status: 404,
    });
    await expect(readSessionLibrary("bad id")).rejects.toMatchObject({ code: "invalid_request" });
  });
});
