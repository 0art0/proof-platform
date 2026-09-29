import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ submitProtocolCommand: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, submitProtocolCommand: mocks.submitProtocolCommand };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { POST } from "./route";

const ORIGIN = "http://proof.test";
const envelope = {
  commandId: "command:1",
  actor: { id: "actor:agent", kind: "agent" },
  basis: { nodeId: "node:root" },
  command: { kind: "sorry", target: "g1" },
};
const context = { params: Promise.resolve({ sessionId: "session:test" }) };

function request(value: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/proof-sessions/session%3Atest/protocol-commands`, {
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

afterEach(() => mocks.submitProtocolCommand.mockReset());

describe("POST /api/proof-sessions/:sessionId/protocol-commands", () => {
  it("relays an agent envelope and keeps the worker's status", async () => {
    const answer = { ok: true, status: 201, body: { commandId: "command:1", replayed: false } };
    mocks.submitProtocolCommand.mockResolvedValue(answer);
    const incoming = request(envelope);

    const response = await POST(incoming, context);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, data: answer.body });
    expect(mocks.submitProtocolCommand).toHaveBeenCalledExactlyOnceWith("session:test", envelope, {
      signal: incoming.signal,
    });
  });

  it("relays structured failures such as requires-input menus", async () => {
    const details = { status: "requires-input", menus: [] };
    mocks.submitProtocolCommand.mockResolvedValue({
      ok: false,
      status: 422,
      code: "requires-input",
      message: "Choose a menu item.",
      body: details,
    });
    const response = await POST(request(envelope), context);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "requires-input", message: "Choose a menu item." },
      details,
    });
  });

  it.each([
    ["extra authority", { ...envelope, trusted: true }, {}],
    ["unknown actor kind", { ...envelope, actor: { id: "actor:x", kind: "robot" } }, {}],
    ["unknown command", { ...envelope, command: { kind: "write-row" } }, {}],
    ["cross-origin", envelope, { origin: "https://hostile.test" }],
    ["non-JSON", envelope, { "content-type": "text/plain" }],
  ])("rejects %s before calling the adapter", async (_label, value, headers) => {
    const response = await POST(request(value, headers), context);
    expect([400, 403, 415]).toContain(response.status);
    expect(mocks.submitProtocolCommand).not.toHaveBeenCalled();
  });

  it("maps an unreachable worker to 503", async () => {
    mocks.submitProtocolCommand.mockRejectedValue(
      new ProofServiceError("service_unavailable", "The proof service could not be reached.", 503),
    );
    const response = await POST(request(envelope), context);
    expect(response.status).toBe(503);
  });
});
