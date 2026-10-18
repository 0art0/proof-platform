import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ relayAiRequest: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, relayAiRequest: mocks.relayAiRequest };
});

import { POST as background } from "./background/route";
import { POST as decisions } from "./background/decisions/route";
import { POST as formalize } from "./formalize/route";
import { POST as shortlist } from "../proof-sessions/[sessionId]/ai-shortlist/route";
import { POST as execute } from "../proof-sessions/[sessionId]/ai-execute/route";
import { POST as executeApply } from "../proof-sessions/[sessionId]/ai-execute/apply/route";

const ORIGIN = "http://proof.test";

function request(value: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/ai/background`, {
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

afterEach(() => mocks.relayAiRequest.mockReset());

describe("AI relay routes", () => {
  it("relays each route to its worker endpoint", async () => {
    const body = { status: "proposed" };
    mocks.relayAiRequest.mockResolvedValue({ ok: true, status: 200, body });
    const context = { params: Promise.resolve({ sessionId: "session:a" }) };
    for (const response of [
      await background(request({ id: "x" })),
      await decisions(request({ id: "x" })),
      await formalize(request({ id: "x" })),
      await shortlist(request({ id: "x" }), context),
      await execute(request({ id: "x" }), context),
      await executeApply(request({ callId: "x" }), context),
    ]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, data: body });
    }
    expect(mocks.relayAiRequest.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      { kind: "background" },
      { kind: "background-decisions" },
      { kind: "formalize" },
      { kind: "shortlist", sessionId: "session:a" },
      { kind: "execute", sessionId: "session:a" },
      { kind: "execute-apply", sessionId: "session:a" },
    ]);
  });

  it("keeps a rate-limited move-instruction answer", async () => {
    mocks.relayAiRequest.mockResolvedValue({
      ok: false,
      status: 429,
      code: "ai-rate-limited",
      message: "Retry later.",
      body: { status: "rate-limited" },
    });
    const context = { params: Promise.resolve({ sessionId: "session:a" }) };
    expect((await execute(request({ id: "x" }), context)).status).toBe(429);
  });

  it("keeps a rate-limited answer and its diagnostics", async () => {
    const body = {
      status: "rate-limited",
      diagnostics: [{ code: "ai-rate-limited", message: "Retry later." }],
    };
    mocks.relayAiRequest.mockResolvedValue({
      ok: false,
      status: 429,
      code: "ai-rate-limited",
      message: "Retry later.",
      body,
    });
    const response = await background(request({ id: "x" }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "ai-rate-limited", message: "Retry later." },
      details: body,
    });
  });

  it("refuses cross-origin requests and non-object bodies without contacting the worker", async () => {
    expect((await background(request({}, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await background(request([1, 2]))).status).toBe(400);
    expect(mocks.relayAiRequest).not.toHaveBeenCalled();
  });
});
