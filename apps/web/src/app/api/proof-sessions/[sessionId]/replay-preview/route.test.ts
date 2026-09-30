import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ previewSemanticReplayProofSession: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, previewSemanticReplayProofSession: mocks.previewSemanticReplayProofSession };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { POST } from "./route";

const ORIGIN = "http://proof.test";
const body = {
  commandId: "command:replay-1",
  source: { fromNodeId: "node:a", toNodeId: "node:b" },
  targetNodeId: "node:c",
  overrides: [{ stepIndex: 1, slotId: "target", candidateId: "candidate:1" }],
};
const context = { params: Promise.resolve({ sessionId: "session:test" }) };

function request(value: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/proof-sessions/session%3Atest/replay-preview`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
    body: JSON.stringify(value),
  });
}

afterEach(() => mocks.previewSemanticReplayProofSession.mockReset());

describe("POST /api/proof-sessions/:sessionId/replay-preview", () => {
  it("forwards the dry-run request, including the commit's command ID, and relays the report", async () => {
    const result = { report: { complete: true } };
    const incoming = request(body);
    mocks.previewSemanticReplayProofSession.mockResolvedValue(result);

    const response = await POST(incoming, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: result });
    expect(mocks.previewSemanticReplayProofSession).toHaveBeenCalledExactlyOnceWith(
      "session:test",
      body,
      { signal: incoming.signal },
    );
  });

  it.each([
    ["extra authority", { ...body, actor: { id: "actor:x", kind: "human" } }, {}],
    ["missing source", { commandId: "command:replay-1" }, {}],
    ["cross-origin", body, { origin: "https://hostile.test" }],
    ["non-JSON", body, { "content-type": "text/plain" }],
  ])("rejects %s before calling the adapter", async (_label, value, headers) => {
    const response = await POST(request(value, headers), context);
    expect([400, 403, 415]).toContain(response.status);
    expect(mocks.previewSemanticReplayProofSession).not.toHaveBeenCalled();
  });

  it("preserves an upstream refusal", async () => {
    mocks.previewSemanticReplayProofSession.mockRejectedValue(
      new ProofServiceError("replay-rejected", "The source path is not in the tree.", 422),
    );
    const response = await POST(request(body), context);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "replay-rejected" } });
  });
});
