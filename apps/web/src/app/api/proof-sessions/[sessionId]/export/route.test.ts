import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exportProofArtifact: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, exportProofArtifact: mocks.exportProofArtifact };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { GET } from "./route";

const context = { params: Promise.resolve({ sessionId: "session:test" }) };
const artifact = { artifactVersion: 1, kind: "proof-artifact", sessionId: "session:test" };

function request(): Request {
  return new Request("http://proof.test/api/proof-sessions/session%3Atest/export");
}

afterEach(() => mocks.exportProofArtifact.mockReset());

describe("GET /api/proof-sessions/:sessionId/export", () => {
  it("returns the artifact itself as a JSON attachment", async () => {
    mocks.exportProofArtifact.mockResolvedValue({ ok: true, status: 200, body: artifact });
    const incoming = request();
    const response = await GET(incoming, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="session-test.proof-artifact.json"',
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(artifact);
    expect(mocks.exportProofArtifact).toHaveBeenCalledExactlyOnceWith("session:test", {
      signal: incoming.signal,
      confirmPrivateExport: false,
    });
  });

  it("forwards the private-export acknowledgement only for exactly true", async () => {
    mocks.exportProofArtifact.mockResolvedValue({ ok: true, status: 200, body: artifact });
    const base = "http://proof.test/api/proof-sessions/session%3Atest/export";
    for (const [query, confirmed] of [
      ["?confirmPrivateExport=true", true],
      ["?confirmPrivateExport=1", false],
      ["?confirmPrivateExport=false", false],
    ] as const) {
      mocks.exportProofArtifact.mockClear();
      await GET(new Request(`${base}${query}`), context);
      expect(mocks.exportProofArtifact.mock.calls[0]?.[1]).toMatchObject({
        confirmPrivateExport: confirmed,
      });
    }
  });

  it("relays an unconfirmed private export as a 403 without an attachment", async () => {
    const details = {
      diagnostics: [{ code: "private-export-unconfirmed", message: "Private session." }],
    };
    mocks.exportProofArtifact.mockResolvedValue({
      ok: false,
      status: 403,
      code: "private-export-unconfirmed",
      message: "Private session.",
      body: details,
    });
    const response = await GET(request(), context);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "private-export-unconfirmed" },
    });
  });

  it("relays worker diagnostics without an attachment", async () => {
    const details = { diagnostics: [{ code: "session-not-found", message: "No session." }] };
    mocks.exportProofArtifact.mockResolvedValue({
      ok: false,
      status: 404,
      code: "session-not-found",
      message: "No session.",
      body: details,
    });
    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "session-not-found", message: "No session." },
      details,
    });
  });

  it("maps adapter errors", async () => {
    mocks.exportProofArtifact.mockRejectedValue(
      new ProofServiceError("invalid_upstream_response", "Invalid.", 502),
    );
    expect((await GET(request(), context)).status).toBe(502);
    mocks.exportProofArtifact.mockRejectedValue(new Error("offline"));
    expect((await GET(request(), context)).status).toBe(503);
  });
});
