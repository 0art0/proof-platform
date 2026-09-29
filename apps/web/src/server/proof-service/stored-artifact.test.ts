import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fixtureArtifact,
  fixtureArtifactJson,
} from "../../features/discovery-viewer/fixture.testing";

vi.mock("server-only", () => ({}));

import { ProofServiceError, readStoredProofArtifact } from ".";

function stubWorker(body: unknown, status: number) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  process.env.PROOF_HTTP_ORIGIN = "http://proof-worker.test";
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PROOF_HTTP_ORIGIN;
});

describe("readStoredProofArtifact", () => {
  it("reads only the stored export and returns the parsed artifact", async () => {
    const fetchMock = stubWorker(fixtureArtifactJson, 200);
    const artifact = await readStoredProofArtifact(fixtureArtifact.sessionId);
    expect(artifact.final.solved).toBe(true);
    expect(artifact.tree.nodes).toHaveLength(fixtureArtifact.tree.nodes.length);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://proof-worker.test/proof-sessions/session%3Aartifact-source/export",
    );
  });

  it("reports an unknown session as not found", async () => {
    stubWorker({ diagnostics: [{ code: "session-not-found", message: "No session." }] }, 404);
    await expect(readStoredProofArtifact("session:missing")).rejects.toMatchObject({
      status: 404,
      code: "invalid_request",
    });
  });

  it("rejects an invalid identifier before any request", async () => {
    const fetchMock = stubWorker({}, 200);
    await expect(readStoredProofArtifact(42)).rejects.toBeInstanceOf(ProofServiceError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
