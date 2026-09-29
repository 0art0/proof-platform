import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createProblemSession: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, createProblemSession: mocks.createProblemSession };
});

import { ProofServiceError } from "../../../server/proof-service";
import { POST } from "./route";

const ORIGIN = "http://proof.test";
const approval = {
  sessionId: "session:new",
  draft: { problem: { title: "t", statement: "s" } },
  reviewedDigest: `sha256:${"a".repeat(64)}`,
};

function request(value: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/proof-sessions`, {
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

afterEach(() => mocks.createProblemSession.mockReset());

describe("POST /api/proof-sessions", () => {
  it("relays an approval and keeps the worker's created status", async () => {
    const body = { session: { id: "session:new" }, replayed: false };
    mocks.createProblemSession.mockResolvedValue({ ok: true, status: 201, body });
    const incoming = request(approval);
    const response = await POST(incoming);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, data: body });
    expect(mocks.createProblemSession).toHaveBeenCalledExactlyOnceWith(approval, {
      signal: incoming.signal,
    });
  });

  it("relays draft diagnostics and stale reviews intact", async () => {
    const details = { diagnostics: [{ code: "review-stale", message: "Review again." }] };
    mocks.createProblemSession.mockResolvedValue({
      ok: false,
      status: 409,
      code: "review-stale",
      message: "Review again.",
      body: details,
    });
    const response = await POST(request(approval));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "review-stale", message: "Review again." },
      details,
    });
  });

  it.each([
    ["a missing digest", { sessionId: "session:new", draft: {} }, {}],
    ["extra authority", { ...approval, actor: "admin" }, {}],
    ["cross-origin", approval, { origin: "https://hostile.test" }],
    ["cross-site fetch", approval, { "sec-fetch-site": "cross-site" }],
    ["non-JSON", approval, { "content-type": "text/plain" }],
  ])("rejects %s before calling the adapter", async (_label, value, headers) => {
    const response = await POST(request(value, headers));
    expect([400, 403, 415]).toContain(response.status);
    expect(mocks.createProblemSession).not.toHaveBeenCalled();
  });

  it("maps an unreachable worker to 503", async () => {
    mocks.createProblemSession.mockRejectedValue(
      new ProofServiceError("service_unavailable", "The proof service could not be reached.", 503),
    );
    expect((await POST(request(approval))).status).toBe(503);
  });
});
