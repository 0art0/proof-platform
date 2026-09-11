import { afterEach, describe, expect, it, vi } from "vitest";
import { displayedSuggestionSetSchema, proofNodeSchema } from "@proof/protocol";

vi.mock("server-only", () => ({}));

import {
  createStoredSuggestionSet,
  ProofServiceError,
  readCurrentProofSession,
  readStoredSuggestionSet,
} from ".";

const SESSION_ID = "session:test";
const NODE_ID = "node:test";
const STATE_ID = "state:test";

const node = proofNodeSchema.parse({
  id: NODE_ID,
  state: {
    id: STATE_ID,
    goals: [
      {
        id: "goal:test",
        sequent: {
          context: {
            declarations: [
              {
                id: "declaration:p",
                symbol: "p",
                sort: { kind: "proposition" },
                role: "universal-parameter",
              },
              {
                id: "declaration:q",
                symbol: "q",
                sort: { kind: "proposition" },
                role: "universal-parameter",
              },
            ],
            hypotheses: [],
          },
          conclusion: { expression: ["And", "p", "q"] },
        },
      },
    ],
    obligations: [],
  },
});

const anchor = {
  stateId: STATE_ID,
  target: { kind: "goal", id: "goal:test" },
  statement: { kind: "conclusion" },
} as const;

const exactDescriptor = { kind: "exact", anchor, path: [] } as const;

const suggestionSet = displayedSuggestionSetSchema.parse({
  id: "suggestion-set:test",
  nodeId: NODE_ID,
  stateId: STATE_ID,
  selection: {
    kind: "exact",
    anchor,
    path: [],
    fragment: ["And", "p", "q"],
    declarations: [],
    position: { polarity: "positive", role: "proposition" },
  },
  suggestions: [],
  variantGroups: [],
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sessionEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: {
      id: SESSION_ID,
      rootNodeId: NODE_ID,
      currentNodeId: NODE_ID,
      operators: [],
      ...overrides,
    },
    node,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PROOF_HTTP_ORIGIN;
});

describe("proof-service adapter", () => {
  it("loads a runtime-validated session with no-store and forwards cancellation", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionEnvelope()));
    vi.stubGlobal("fetch", fetchMock);
    process.env.PROOF_HTTP_ORIGIN = "http://proof-worker.test";

    await expect(
      readCurrentProofSession(SESSION_ID, { signal: controller.signal }),
    ).resolves.toEqual({ session: sessionEnvelopeSession(), node });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      new URL("http://proof-worker.test/proof-sessions/session%3Atest"),
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json" },
      }),
    );
  });

  it.each([
    ["mismatched session", sessionEnvelope({ id: "session:other" })],
    ["mismatched current node", sessionEnvelope({ currentNodeId: "node:other" })],
    ["invalid node", { ...sessionEnvelope(), node: { id: NODE_ID } }],
    ["extra success field", { ...sessionEnvelope(), untrusted: true }],
  ])("rejects a %s success envelope", async (_label, envelope) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(envelope)));

    await expect(readCurrentProofSession(SESSION_ID)).rejects.toMatchObject({
      code: "invalid_upstream_response",
      status: 502,
    });
  });

  it("accepts only a strict, validated worker failure envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            diagnostics: [
              { code: "session-not-found", message: "The proof session does not exist." },
            ],
          },
          404,
        ),
      ),
    );

    await expect(readCurrentProofSession(SESSION_ID)).rejects.toMatchObject({
      code: "session-not-found",
      message: "The proof session does not exist.",
      status: 404,
    });
  });

  it.each([
    ["unknown diagnostic", { diagnostics: [{ code: "invented", message: "No." }] }],
    ["extra diagnostic field", { diagnostics: [{ code: "not-found", message: "No.", x: 1 }] }],
    [
      "multiple diagnostics",
      {
        diagnostics: [
          { code: "not-found", message: "No." },
          { code: "not-found", message: "Still no." },
        ],
      },
    ],
    ["success at failure status", sessionEnvelope()],
  ])("rejects a malformed worker failure: %s", async (_label, envelope) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(envelope, 404)));

    await expect(readCurrentProofSession(SESSION_ID)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("proxies only the exact descriptor and verifies the complete returned identity", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ suggestionSet, replayed: false }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createStoredSuggestionSet(SESSION_ID, {
        id: suggestionSet.id,
        selections: [exactDescriptor],
      }),
    ).resolves.toEqual({ suggestionSet, replayed: false });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      id: suggestionSet.id,
      selections: [exactDescriptor],
    });
    expect(init).toMatchObject({ method: "POST", cache: "no-store" });
  });

  it("rejects resolved fields and unsupported descriptor kinds before contacting the worker", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const selection of [
      { ...exactDescriptor, fragment: ["And", "p", "q"] },
      { kind: "fallback", anchor, path: [], reason: "ambiguous" },
      {
        kind: "selection-query",
        selections: [{ id: "selection:one", selection: exactDescriptor }],
      },
    ]) {
      await expect(
        createStoredSuggestionSet(SESSION_ID, {
          id: "suggestion-set:invalid",
          selections: [selection],
        }),
      ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies a strict associative lens without adding client-resolved data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          diagnostics: [{ code: "suggestion-set-rejected", message: "Rejected for this test." }],
        },
        400,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const lens = {
      kind: "associative",
      anchor,
      containerPath: [],
      startOperand: 0,
      endOperand: 2,
      displayRange: [2, 7],
    } as const;

    await expect(
      createStoredSuggestionSet(SESSION_ID, {
        id: "suggestion-set:lens",
        selections: [lens],
      }),
    ).rejects.toMatchObject({ code: "suggestion-set-rejected" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      id: "suggestion-set:lens",
      selections: [lens],
    });
  });

  it("requires multiselection subjects to retain the worker's stable positional identities", async () => {
    const secondDescriptor = { ...exactDescriptor, path: [1] } as const;
    const firstResolved = suggestionSet.selection;
    if (firstResolved.kind === "selection-query") throw new Error("Expected an exact fixture.");
    const secondResolved = { ...firstResolved, path: [1], fragment: "q" };
    const multiselectionSet = displayedSuggestionSetSchema.parse({
      ...suggestionSet,
      id: "suggestion-set:multi",
      selection: {
        kind: "selection-query",
        stateId: STATE_ID,
        selections: [
          { id: "selection:request-1", selection: firstResolved },
          { id: "selection:request-2", selection: secondResolved },
        ],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ suggestionSet: multiselectionSet, replayed: false }, 201),
        ),
    );

    await expect(
      createStoredSuggestionSet(SESSION_ID, {
        id: multiselectionSet.id,
        selections: [exactDescriptor, secondDescriptor],
      }),
    ).resolves.toEqual({ suggestionSet: multiselectionSet, replayed: false });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            suggestionSet: {
              ...multiselectionSet,
              selection: {
                ...multiselectionSet.selection,
                selections: [
                  { id: "selection:request-2", selection: firstResolved },
                  { id: "selection:request-1", selection: secondResolved },
                ],
              },
            },
            replayed: false,
          },
          201,
        ),
      ),
    );
    await expect(
      createStoredSuggestionSet(SESSION_ID, {
        id: multiselectionSet.id,
        selections: [exactDescriptor, secondDescriptor],
      }),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });

  it.each([
    ["suggestion-set ID", { ...suggestionSet, id: "suggestion-set:other" }],
    ["state identity", { ...suggestionSet, stateId: "state:other" }],
    [
      "occurrence identity",
      { ...suggestionSet, selection: { ...suggestionSet.selection, path: [0] } },
    ],
  ])("rejects a returned set with mismatched %s", async (_label, returnedSet) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ suggestionSet: returnedSet, replayed: false }, 201)),
    );

    await expect(
      createStoredSuggestionSet(SESSION_ID, {
        id: suggestionSet.id,
        selections: [exactDescriptor],
      }),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });

  it("requires POST status and replay identity to agree", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ suggestionSet, replayed: false }, 200)),
    );

    await expect(
      createStoredSuggestionSet(SESSION_ID, {
        id: suggestionSet.id,
        selections: [exactDescriptor],
      }),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });

  it("reads back only the exact requested persisted suggestion-set ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ suggestionSet: { ...suggestionSet, id: "suggestion-set:other" } }),
        ),
    );

    await expect(readStoredSuggestionSet(SESSION_ID, suggestionSet.id)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("returns a valid persisted suggestion set without reranking or rewriting it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ suggestionSet })));

    await expect(readStoredSuggestionSet(SESSION_ID, suggestionSet.id)).resolves.toEqual({
      suggestionSet,
    });
  });

  it("rejects non-JSON, malformed JSON, oversized, and unreachable upstream responses", async () => {
    const responses = [
      new Response("plain text", { status: 200, headers: { "content-type": "text/plain" } }),
      new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "3000000" },
      }),
    ];
    for (const response of responses) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(readCurrentProofSession(SESSION_ID)).rejects.toMatchObject({
        code: "invalid_upstream_response",
      });
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("connection refused")));
    await expect(readCurrentProofSession(SESSION_ID)).rejects.toEqual(
      new ProofServiceError("service_unavailable", "The proof service could not be reached.", 503),
    );
  });
});

function sessionEnvelopeSession() {
  return {
    id: SESSION_ID,
    rootNodeId: NODE_ID,
    currentNodeId: NODE_ID,
    operators: [],
  };
}
