import { afterEach, describe, expect, it, vi } from "vitest";
import {
  displayedSuggestionSetSchema,
  movePreviewSchema,
  proofEdgeSchema,
  proofNodeSchema,
} from "@proof/protocol";

vi.mock("server-only", () => ({}));

import {
  backtrackProofSession,
  createStoredMovePreview,
  createStoredSuggestionSet,
  executeStoredProofCommand,
  ProofServiceError,
  readCurrentProofSession,
  readProofHistory,
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

const moveSuggestionSet = displayedSuggestionSetSchema.parse({
  ...suggestionSet,
  suggestions: [
    {
      id: "suggestion:move",
      source: "move",
      artifactId: "move:split-goal-conjunction",
      patternId: "pattern:split-goal-conjunction",
      name: "Split conjunction goal",
      exactRepresentationMatch: true,
      substitutions: [],
      rank: [0],
      reasons: ["The selected goal is a conjunction."],
      selectionMatches: [
        {
          selectionId: "selection:primary",
          patternId: "pattern:split-goal-conjunction",
          selectionSlotId: "slot:goal",
        },
      ],
      unresolvedSelectionSlots: [],
      unresolvedParameters: [],
      applicability: "applicable",
      abstractionFit: "not-used",
    },
  ],
});

const choice = {
  commandId: "command:test",
  suggestionSetId: suggestionSet.id,
  chosenSuggestionId: "suggestion:test",
} as const;

const preview = movePreviewSchema.parse({
  id: "preview:test",
  nodeId: NODE_ID,
  stateId: STATE_ID,
  suggestionSetId: choice.suggestionSetId,
  chosenSuggestionId: choice.chosenSuggestionId,
  moveId: "move:close-true",
  operation: {
    kind: "close-true",
    expectedStateId: STATE_ID,
    resultStateId: "state:after",
    target: { kind: "goal", id: "goal:test" },
  },
  transitionClass: "equivalence",
  beforeState: node.state,
  afterState: { id: "state:after", goals: [], obligations: [] },
  delta: {
    goals: { added: [], removed: ["goal:test"], updated: [] },
    obligations: { added: [], removed: [], updated: [] },
  },
});

const appliedNode = proofNodeSchema.parse({ id: "node:after", state: preview.afterState });
const receipt = {
  commandId: choice.commandId,
  nodeId: appliedNode.id,
  edgeId: "edge:test",
  eventId: "event:test",
  resultStateId: appliedNode.state.id,
  transitionClass: "equivalence" as const,
};
const historyEdge = proofEdgeSchema.parse({
  id: receipt.edgeId,
  commandId: choice.commandId,
  parentNodeId: node.id,
  childNodeId: appliedNode.id,
  moveId: preview.moveId,
  suggestionSetId: choice.suggestionSetId,
  chosenSuggestionId: choice.chosenSuggestionId,
  previewId: preview.id,
  operation: preview.operation,
  transitionClass: preview.transitionClass,
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
      .mockResolvedValue(
        jsonResponse({ suggestionSet, replayed: false, transitionClasses: [] }, 201),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createStoredSuggestionSet(SESSION_ID, {
        id: suggestionSet.id,
        selections: [exactDescriptor],
      }),
    ).resolves.toEqual({ suggestionSet, replayed: false, transitionClasses: [] });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      id: suggestionSet.id,
      selections: [exactDescriptor],
    });
    expect(init).toMatchObject({ method: "POST", cache: "no-store" });
  });

  it("accepts transition classifications only for every move in persisted order", async () => {
    const classification = {
      suggestionId: moveSuggestionSet.suggestions[0]!.id,
      transitionClass: "equivalence" as const,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            suggestionSet: moveSuggestionSet,
            replayed: false,
            transitionClasses: [classification],
          },
          201,
        ),
      ),
    );

    await expect(
      createStoredSuggestionSet(SESSION_ID, {
        id: moveSuggestionSet.id,
        selections: [exactDescriptor],
      }),
    ).resolves.toMatchObject({ transitionClasses: [classification] });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            suggestionSet: moveSuggestionSet,
            replayed: false,
            transitionClasses: [{ ...classification, suggestionId: "suggestion:other" }],
          },
          201,
        ),
      ),
    );
    await expect(
      createStoredSuggestionSet(SESSION_ID, {
        id: moveSuggestionSet.id,
        selections: [exactDescriptor],
      }),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
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
          jsonResponse(
            { suggestionSet: multiselectionSet, replayed: false, transitionClasses: [] },
            201,
          ),
        ),
    );

    await expect(
      createStoredSuggestionSet(SESSION_ID, {
        id: multiselectionSet.id,
        selections: [exactDescriptor, secondDescriptor],
      }),
    ).resolves.toEqual({
      suggestionSet: multiselectionSet,
      replayed: false,
      transitionClasses: [],
    });

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
            transitionClasses: [],
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
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ suggestionSet: returnedSet, replayed: false, transitionClasses: [] }, 201),
        ),
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
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ suggestionSet, replayed: false, transitionClasses: [] }, 200),
        ),
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
      vi.fn().mockResolvedValue(
        jsonResponse({
          suggestionSet: { ...suggestionSet, id: "suggestion-set:other" },
          transitionClasses: [],
        }),
      ),
    );

    await expect(readStoredSuggestionSet(SESSION_ID, suggestionSet.id)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("returns a valid persisted suggestion set without reranking or rewriting it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ suggestionSet, transitionClasses: [] })),
    );

    await expect(readStoredSuggestionSet(SESSION_ID, suggestionSet.id)).resolves.toEqual({
      suggestionSet,
      transitionClasses: [],
    });
  });

  it("previews exactly one displayed choice and requires status/idempotency agreement", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(sessionEnvelope()))
      .mockResolvedValueOnce(jsonResponse({ preview, replayed: false }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createStoredMovePreview(SESSION_ID, choice)).resolves.toEqual({
      preview,
      replayed: false,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("http://127.0.0.1:8787/proof-sessions/session%3Atest/move-previews"),
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        body: JSON.stringify(choice),
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(sessionEnvelope()))
        .mockResolvedValueOnce(jsonResponse({ preview, replayed: false }, 200)),
    );
    await expect(createStoredMovePreview(SESSION_ID, choice)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("rejects a preview that does not identify the exact chosen suggestion", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(sessionEnvelope()))
        .mockResolvedValueOnce(
          jsonResponse(
            {
              preview: { ...preview, chosenSuggestionId: "suggestion:other" },
              replayed: false,
            },
            201,
          ),
        ),
    );

    await expect(createStoredMovePreview(SESSION_ID, choice)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("executes an exact choice and validates the returned receipt and current node", async () => {
    const responseBody = {
      session: sessionEnvelopeSession({ currentNodeId: appliedNode.id }),
      node: appliedNode,
      receipt,
      replayed: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(responseBody, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeStoredProofCommand(SESSION_ID, choice)).resolves.toEqual(responseBody);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify(choice) });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { ...responseBody, receipt: { ...receipt, commandId: "command:other" } },
            201,
          ),
        ),
    );
    await expect(executeStoredProofCommand(SESSION_ID, choice)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("reads only a complete rooted discovery tree with retained edge names", async () => {
    const history = {
      session: sessionEnvelopeSession({ currentNodeId: appliedNode.id }),
      nodes: [node, appliedNode],
      edges: [{ edge: historyEdge, name: "Close true goal" }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(history)));

    await expect(readProofHistory(SESSION_ID)).resolves.toEqual(history);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...history,
          nodes: [...history.nodes, { ...node, id: "node:orphan" }],
        }),
      ),
    );
    await expect(readProofHistory(SESSION_ID)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("backtracks with an expected pointer and validates the returned target snapshot", async () => {
    const request = { expectedCurrentNodeId: appliedNode.id, targetNodeId: node.id };
    const responseBody = {
      session: sessionEnvelopeSession(),
      node,
      replayed: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(responseBody));
    vi.stubGlobal("fetch", fetchMock);

    await expect(backtrackProofSession(SESSION_ID, request)).resolves.toEqual(responseBody);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify(request) });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...responseBody,
          session: sessionEnvelopeSession({ currentNodeId: appliedNode.id }),
        }),
      ),
    );
    await expect(backtrackProofSession(SESSION_ID, request)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("rejects malformed mutation DTOs before contacting the worker", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createStoredMovePreview(SESSION_ID, { ...choice, operation: preview.operation }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      executeStoredProofCommand(SESSION_ID, { ...choice, commandId: "not a stable ID" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      backtrackProofSession(SESSION_ID, {
        expectedCurrentNodeId: appliedNode.id,
        targetNodeId: "not a stable ID",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
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

function sessionEnvelopeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    rootNodeId: NODE_ID,
    currentNodeId: NODE_ID,
    operators: [],
    ...overrides,
  };
}
