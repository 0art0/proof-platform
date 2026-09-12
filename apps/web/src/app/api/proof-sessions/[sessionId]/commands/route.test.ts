import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeStoredProofCommand: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, executeStoredProofCommand: mocks.executeStoredProofCommand };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { POST } from "./route";

const ORIGIN = "http://proof.test";
const choice = {
  commandId: "command:test",
  suggestionSetId: "suggestion-set:test",
  chosenSuggestionId: "suggestion:test",
};
const context = { params: Promise.resolve({ sessionId: "session:test" }) };

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/proof-sessions/session%3Atest/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => mocks.executeStoredProofCommand.mockReset());

describe("POST /api/proof-sessions/:sessionId/commands", () => {
  it("forwards only a validated choice and maps new/replayed command status", async () => {
    const result = {
      session: { id: "session:test", currentNodeId: "node:after" },
      node: { id: "node:after" },
      receipt: { commandId: choice.commandId },
      replayed: false,
    };
    const incoming = request(choice);
    mocks.executeStoredProofCommand.mockResolvedValue(result);

    const response = await POST(incoming, context);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, data: result });
    expect(mocks.executeStoredProofCommand).toHaveBeenCalledExactlyOnceWith(
      "session:test",
      choice,
      { signal: incoming.signal },
    );

    mocks.executeStoredProofCommand.mockResolvedValue({ ...result, replayed: true });
    expect((await POST(request(choice), context)).status).toBe(200);
  });

  it.each([
    ["an extra actor", { ...choice, actor: { id: "actor:forged", kind: "human" } }, {}],
    ["a cross-origin request", choice, { origin: "https://hostile.test" }],
    ["a cross-site request", choice, { "sec-fetch-site": "cross-site" }],
  ])("rejects %s before calling the adapter", async (_label, body, headers) => {
    const response = await POST(request(body, headers), context);
    expect([400, 403]).toContain(response.status);
    expect(mocks.executeStoredProofCommand).not.toHaveBeenCalled();
  });

  it("preserves a serialized stale-command conflict", async () => {
    mocks.executeStoredProofCommand.mockRejectedValue(
      new ProofServiceError("serialized-stale-command", "The parent is no longer current.", 409),
    );
    const response = await POST(request(choice), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "serialized-stale-command" },
    });
  });
});
