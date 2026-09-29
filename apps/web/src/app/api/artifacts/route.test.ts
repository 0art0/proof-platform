import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ uploadProofArtifact: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, uploadProofArtifact: mocks.uploadProofArtifact };
});

import { ProofServiceError } from "../../../server/proof-service";
import { POST } from "./route";

const ORIGIN = "http://proof.test";
const artifact = { artifactVersion: 1, kind: "proof-artifact", sessionId: "session:source" };

function request(body: string, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/artifacts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
    body,
  });
}

afterEach(() => mocks.uploadProofArtifact.mockReset());

describe("POST /api/artifacts", () => {
  it("relays an upload and keeps the worker's created status", async () => {
    const created = {
      sessionId: "session:artifact:abc",
      digest: `sha256:${"a".repeat(64)}`,
      sourceSessionId: "session:source",
      readOnly: true,
      replayed: false,
    };
    mocks.uploadProofArtifact.mockResolvedValue({ ok: true, status: 201, body: created });
    const incoming = request(JSON.stringify(artifact));
    const response = await POST(incoming);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, data: created });
    expect(mocks.uploadProofArtifact).toHaveBeenCalledExactlyOnceWith(artifact, {
      signal: incoming.signal,
    });
  });

  it("accepts artifacts larger than the 64 KiB command limit", async () => {
    mocks.uploadProofArtifact.mockResolvedValue({ ok: true, status: 200, body: {} });
    const large = { ...artifact, padding: "x".repeat(200 * 1024) };
    expect((await POST(request(JSON.stringify(large)))).status).toBe(200);
  });

  it("relays revalidation diagnostics intact", async () => {
    const details = {
      diagnostics: [
        {
          code: "transition-not-reproduced",
          message: "Edge 1 differs.",
          path: ["tree", "edges", 1],
        },
      ],
    };
    mocks.uploadProofArtifact.mockResolvedValue({
      ok: false,
      status: 422,
      code: "transition-not-reproduced",
      message: "Edge 1 differs.",
      body: details,
    });
    const response = await POST(request(JSON.stringify(artifact)));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "transition-not-reproduced", message: "Edge 1 differs." },
      details,
    });
  });

  it.each([
    ["malformed JSON", "{", {}],
    ["a JSON array", "[]", {}],
    ["cross-origin", JSON.stringify(artifact), { origin: "https://hostile.test" }],
    ["cross-site fetch", JSON.stringify(artifact), { "sec-fetch-site": "cross-site" }],
    ["non-JSON", JSON.stringify(artifact), { "content-type": "text/plain" }],
  ])("rejects %s before calling the adapter", async (_label, body, headers) => {
    const response = await POST(request(body, headers));
    expect([400, 403, 415]).toContain(response.status);
    expect(mocks.uploadProofArtifact).not.toHaveBeenCalled();
  });

  it("maps an unreachable worker to 503", async () => {
    mocks.uploadProofArtifact.mockRejectedValue(
      new ProofServiceError("service_unavailable", "The proof service could not be reached.", 503),
    );
    expect((await POST(request(JSON.stringify(artifact)))).status).toBe(503);
  });
});
