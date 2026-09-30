import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  deleteProofSession,
  exportProofArtifact,
  readSessionVisibility,
  setSessionVisibility,
} from ".";

function stubWorker(response: Response) {
  const fetchMock = vi.fn().mockImplementation(async () => response.clone());
  vi.stubGlobal("fetch", fetchMock);
  process.env.PROOF_HTTP_ORIGIN = "http://proof-worker.test";
  return fetchMock;
}

const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PROOF_HTTP_ORIGIN;
});

describe("deleteProofSession", () => {
  it("sends DELETE and accepts the worker's 204", async () => {
    const fetchMock = stubWorker(new Response(null, { status: 204 }));
    expect(await deleteProofSession("session:test")).toEqual({ deleted: true });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://proof-worker.test/proof-sessions/session%3Atest");
    expect(init.method).toBe("DELETE");
  });

  it("maps a missing session to 404 and rejects invalid IDs before any request", async () => {
    stubWorker(
      jsonResponse(
        {
          diagnostics: [
            { code: "session-not-found", message: "The proof session does not exist." },
          ],
        },
        404,
      ),
    );
    await expect(deleteProofSession("session:test")).rejects.toMatchObject({
      code: "session-not-found",
      status: 404,
    });
    const fetchMock = stubWorker(new Response(null, { status: 204 }));
    await expect(deleteProofSession("bad id")).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("session visibility", () => {
  it("reads and sets the visibility and checks the answered session", async () => {
    const view = { sessionId: "session:test", visibility: "shared" };
    const fetchMock = stubWorker(jsonResponse(view, 200));
    expect(await setSessionVisibility("session:test", "shared")).toEqual(view);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://proof-worker.test/proof-sessions/session%3Atest/visibility");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ visibility: "shared" }));

    stubWorker(jsonResponse({ sessionId: "session:test", visibility: "private" }, 200));
    expect(await readSessionVisibility("session:test")).toEqual({
      sessionId: "session:test",
      visibility: "private",
    });
    stubWorker(jsonResponse({ sessionId: "session:other", visibility: "private" }, 200));
    await expect(readSessionVisibility("session:test")).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
    await expect(setSessionVisibility("session:test", "public")).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("exportProofArtifact and the private-export acknowledgement", () => {
  const refusal = {
    diagnostics: [{ code: "private-export-unconfirmed", message: "This session is private." }],
  };

  it("adds the acknowledgement query only when asked, and relays the 403 refusal", async () => {
    const fetchMock = stubWorker(jsonResponse(refusal, 403));
    expect(await exportProofArtifact("session:test")).toEqual({
      ok: false,
      status: 403,
      code: "private-export-unconfirmed",
      message: "This session is private.",
      body: refusal,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://proof-worker.test/proof-sessions/session%3Atest/export",
    );

    await exportProofArtifact("session:test", { confirmPrivateExport: true });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "http://proof-worker.test/proof-sessions/session%3Atest/export?confirmPrivateExport=true",
    );
  });
});
