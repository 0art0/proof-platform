import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createStoredSuggestionSet: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, createStoredSuggestionSet: mocks.createStoredSuggestionSet };
});

import { ProofServiceError } from "../../../../../server/proof-service";
import { POST } from "./route";

const ORIGIN = "http://proof.test";
const descriptor = {
  kind: "exact",
  anchor: {
    stateId: "state:test",
    target: { kind: "goal", id: "goal:test" },
    statement: { kind: "conclusion" },
  },
  path: [0],
} as const;

function request(body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${ORIGIN}/api/proof-sessions/session%3Atest/suggestion-sets`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ sessionId: "session:test" }) };

afterEach(() => mocks.createStoredSuggestionSet.mockReset());

describe("POST /api/proof-sessions/:sessionId/suggestion-sets", () => {
  it("passes only a validated descriptor request and the abort signal to the adapter", async () => {
    const body = { id: "suggestion-set:test", selections: [descriptor] };
    const incoming = request(body);
    mocks.createStoredSuggestionSet.mockResolvedValue({
      suggestionSet: { id: "suggestion-set:test" },
      replayed: false,
      transitionClasses: [],
    });

    const response = await POST(incoming, context);

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        suggestionSet: { id: "suggestion-set:test" },
        replayed: false,
        transitionClasses: [],
      },
    });
    expect(mocks.createStoredSuggestionSet).toHaveBeenCalledExactlyOnceWith("session:test", body, {
      signal: incoming.signal,
    });
  });

  it("passes a well-formed per-selection abstraction through unchanged", async () => {
    const abstraction = {
      id: "wildcard:request-1",
      symbol: "_a1",
      role: "retrieval-wildcard",
      sort: { kind: "proposition" },
    };
    const body = { id: "suggestion-set:test", selections: [{ ...descriptor, abstraction }] };
    mocks.createStoredSuggestionSet.mockResolvedValue({
      suggestionSet: { id: "suggestion-set:test" },
      replayed: false,
      transitionClasses: [],
    });
    const incoming = request(body);
    const response = await POST(incoming, context);
    expect(response.status).toBe(201);
    expect(mocks.createStoredSuggestionSet).toHaveBeenCalledExactlyOnceWith("session:test", body, {
      signal: incoming.signal,
    });
  });

  it.each([
    ["a malformed role", { id: "wildcard:x", symbol: "_a", role: "universal" }],
    ["extra fields", { id: "wildcard:x", symbol: "_a", role: "retrieval-wildcard", extra: 1 }],
    ["a malformed id", { id: "not an id", symbol: "_a", role: "retrieval-wildcard" }],
  ])("rejects an abstraction with %s without reaching the worker", async (_label, abstraction) => {
    const response = await POST(
      request({ id: "suggestion-set:test", selections: [{ ...descriptor, abstraction }] }),
      context,
    );
    expect(response.status).toBe(400);
    expect(mocks.createStoredSuggestionSet).not.toHaveBeenCalled();
  });

  it("returns 200 when the worker replays identical persisted evidence", async () => {
    mocks.createStoredSuggestionSet.mockResolvedValue({
      suggestionSet: { id: "suggestion-set:test" },
      replayed: true,
      transitionClasses: [],
    });

    const response = await POST(
      request({ id: "suggestion-set:test", selections: [descriptor] }),
      context,
    );
    expect(response.status).toBe(200);
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "resolved exact data",
      { id: "suggestion-set:test", selections: [{ ...descriptor, fragment: "p" }] },
    ],
    [
      "fallback selection",
      {
        id: "suggestion-set:test",
        selections: [
          { kind: "fallback", anchor: descriptor.anchor, path: [0], reason: "ambiguous" },
        ],
      },
    ],
    [
      "malformed anchor identity",
      {
        id: "suggestion-set:test",
        selections: [
          { ...descriptor, anchor: { ...descriptor.anchor, stateId: "not a stable ID" } },
        ],
      },
    ],
    [
      "malformed associative range",
      {
        id: "suggestion-set:test",
        selections: [
          {
            kind: "associative",
            anchor: descriptor.anchor,
            containerPath: [],
            startOperand: 0,
            endOperand: 1,
          },
        ],
      },
    ],
    [
      "reversed display range",
      {
        id: "suggestion-set:test",
        selections: [
          {
            kind: "associative",
            anchor: descriptor.anchor,
            containerPath: [],
            startOperand: 0,
            endOperand: 2,
            displayRange: [7, 2],
          },
        ],
      },
    ],
  ])("rejects %s without reaching the worker", async (_label, body) => {
    const response = await POST(request(body), context);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(mocks.createStoredSuggestionSet).not.toHaveBeenCalled();
  });

  it.each([
    ["cross-origin", { origin: "https://hostile.test" }, 403],
    ["cross-site", { "sec-fetch-site": "cross-site" }, 403],
    ["non-JSON", { "content-type": "text/plain" }, 415],
  ])("rejects a %s browser request", async (_label, headers, expectedStatus) => {
    const response = await POST(
      request({ id: "suggestion-set:test", selections: [descriptor] }, headers),
      context,
    );

    expect(response.status).toBe(expectedStatus);
    expect(mocks.createStoredSuggestionSet).not.toHaveBeenCalled();
  });

  it("surfaces stale-anchor rejection as a distinct validated failure", async () => {
    mocks.createStoredSuggestionSet.mockRejectedValue(
      new ProofServiceError(
        "suggestion-set-rejected",
        "The selection anchor refers to a stale proof-state snapshot.",
        400,
      ),
    );

    const response = await POST(
      request({ id: "suggestion-set:stale", selections: [descriptor] }),
      context,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "suggestion-set-rejected",
        message: "The selection anchor refers to a stale proof-state snapshot.",
      },
    });
  });
});
