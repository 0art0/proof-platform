// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  type DisplayedSuggestionSet,
} from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import { proofStateIdSchema } from "@proof/mathjson-model";
import { StoredProofWorkspace } from "./stored-proof-workspace";

vi.mock("../proof-workspace", () => ({
  ProofWorkspace: ({
    onSelectionChange,
  }: {
    onSelectionChange: (selections: readonly AnchoredProofSelection[]) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onSelectionChange([exactSelection([0])])}>
        Select first
      </button>
      <button
        type="button"
        onClick={() => onSelectionChange([exactSelection([1]), exactSelection([2])])}
      >
        Select pair
      </button>
      <button type="button" onClick={() => onSelectionChange([staleSelection()])}>
        Select stale
      </button>
      <button type="button" onClick={() => onSelectionChange([malformedAssociativeSelection()])}>
        Select malformed
      </button>
      <button type="button" onClick={() => onSelectionChange([])}>
        Clear
      </button>
    </div>
  ),
}));

const node = createProofNodeSchema().parse({
  id: "node:test",
  state: {
    id: "state:test",
    goals: [
      {
        id: "goal:test",
        sequent: {
          context: {
            declarations: ["p", "q"].map((symbol) => ({
              id: `declaration:${symbol}`,
              symbol,
              sort: { kind: "proposition" },
              role: "universal-parameter",
            })),
            hypotheses: [],
          },
          conclusion: { expression: ["And", "p", "p", "q"] },
        },
      },
    ],
    obligations: [],
  },
});

const session = {
  id: "session:test",
  rootNodeId: node.id,
  currentNodeId: node.id,
  operators: [],
} as const;
let uuid = 0;

beforeEach(() => {
  uuid = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function anchor(stateId: AnchoredProofSelection["anchor"]["stateId"] = node.state.id) {
  return {
    stateId,
    target: { kind: "goal", id: node.state.goals[0]!.id },
    statement: { kind: "conclusion" },
  } as const;
}

function exactSelection(path: readonly number[]): AnchoredProofSelection {
  return { kind: "exact", anchor: anchor(), path };
}

function staleSelection(): AnchoredProofSelection {
  return { kind: "exact", anchor: anchor(proofStateIdSchema.parse("state:old")), path: [0] };
}

function malformedAssociativeSelection(): AnchoredProofSelection {
  return {
    kind: "associative",
    anchor: anchor(),
    containerPath: [],
    startOperand: 0,
    endOperand: 1,
  };
}

function suggestionSet(id: string, name: string, artifactId: string): DisplayedSuggestionSet {
  return displayedSuggestionSetSchema.parse({
    id,
    nodeId: node.id,
    stateId: node.state.id,
    selection: {
      kind: "exact",
      anchor: anchor(),
      path: [0],
      fragment: "p",
      declarations: node.state.goals[0]?.sequent.context.declarations ?? [],
      position: { polarity: "positive", role: "proposition" },
    },
    suggestions: [
      {
        id: `suggestion:${artifactId}`,
        source: "result",
        artifactId,
        patternId: `pattern:${artifactId}`,
        name,
        exactRepresentationMatch: true,
        substitutions: [],
        rank: [0],
        reasons: [`Reason for ${name}`, `Second reason for ${name}`],
        selectionMatches: [
          { selectionId: "selection:primary", patternId: `pattern:${artifactId}` },
        ],
        unresolvedSelectionSlots: [],
        unresolvedParameters: [],
        applicability: "applicable",
        abstractionFit: "not-used",
      },
    ],
    variantGroups: [],
  });
}

function moveSuggestionSet(
  id: string,
  applicability: "applicable" | "requires-input" = "applicable",
): DisplayedSuggestionSet {
  return displayedSuggestionSetSchema.parse({
    ...suggestionSet(id, "Split goal conjunction", "result:placeholder"),
    suggestions: [
      {
        id: "suggestion:split-goal",
        source: "move",
        artifactId: "move:split-goal-conjunction",
        patternId: "move-pattern:split-goal-conjunction",
        name: "Split goal conjunction",
        exactRepresentationMatch: true,
        substitutions: [],
        rank: [0],
        reasons: ["The selected goal is a conjunction.", "The target slot is fully matched."],
        selectionMatches: [
          {
            selectionId: "selection:primary",
            patternId: "move-pattern:split-goal-conjunction",
            selectionSlotId: "target",
          },
        ],
        unresolvedSelectionSlots: [],
        unresolvedParameters: applicability === "applicable" ? [] : ["choice"],
        applicability,
        abstractionFit: "not-used",
      },
    ],
  });
}

function previewFor(commandId: string) {
  const afterState = { ...node.state, id: `state:${commandId}`, goals: [] };
  return {
    id: `preview:${commandId}`,
    nodeId: node.id,
    stateId: node.state.id,
    suggestionSetId: "suggestion-set:move",
    chosenSuggestionId: "suggestion:split-goal",
    moveId: "move:split-goal-conjunction",
    operation: {
      kind: "close-true",
      expectedStateId: node.state.id,
      resultStateId: afterState.id,
      target: { kind: "goal", id: "goal:test" },
    },
    transitionClass: "equivalence",
    beforeState: node.state,
    afterState,
    delta: {
      goals: { added: [], removed: ["goal:test"], updated: [] },
      obligations: { added: [], removed: [], updated: [] },
    },
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function historyResponse(
  historyNode = node,
  historySession: typeof session | Readonly<Record<string, unknown>> = session,
): Response {
  return jsonResponse({
    ok: true,
    data: { session: historySession, nodes: [historyNode], edges: [] },
  });
}

function mockWithHistory(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
) {
  return vi.fn<typeof fetch>(async (input, init) =>
    String(input).endsWith("/history") ? historyResponse() : handler(input, init),
  );
}

describe("StoredProofWorkspace", () => {
  it("rejects malformed anchors and marks stale anchors without making a request", async () => {
    const fetchMock = mockWithHistory(() => Promise.reject(new Error("Unexpected request")));
    vi.stubGlobal("fetch", fetchMock);
    render(<StoredProofWorkspace session={session} node={node} />);

    fireEvent.click(screen.getByRole("button", { name: "Select malformed" }));
    expect(screen.getByRole("status")).toHaveTextContent("could not be encoded safely");

    fireEvent.click(screen.getByRole("button", { name: "Select stale" }));
    expect(screen.getByRole("status")).toHaveTextContent("Stale selection");
    expect(
      fetchMock.mock.calls.filter((call) => !String(call[0]).endsWith("/history")),
    ).toHaveLength(0);
  });

  it("retains server order and reasons without client-side reranking", async () => {
    const set = suggestionSet("suggestion-set:ordered", "Server first", "result:first");
    const second = {
      ...set.suggestions[0],
      id: "suggestion:second",
      artifactId: "result:second",
      patternId: "pattern:second",
      name: "Server second",
      rank: [-1],
      reasons: ["Server-supplied second reason"],
      selectionMatches: [{ selectionId: "selection:primary", patternId: "pattern:second" }],
    };
    const ordered = displayedSuggestionSetSchema.parse({
      ...set,
      suggestions: [set.suggestions[0], second],
    });
    vi.stubGlobal(
      "fetch",
      mockWithHistory(async () =>
        jsonResponse({
          ok: true,
          data: { suggestionSet: ordered, replayed: false, transitionClasses: [] },
        }),
      ),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));

    const list = await screen.findByTestId("suggestion-list");
    expect([...list.querySelectorAll("h3")].map(({ textContent }) => textContent)).toEqual([
      "Server first",
      "Server second",
    ]);
    expect(screen.getByText("Server-supplied second reason")).toBeVisible();
  });

  it("shows a stale state when the service rejects an outdated snapshot anchor", async () => {
    vi.stubGlobal(
      "fetch",
      mockWithHistory(async () =>
        jsonResponse(
          {
            ok: false,
            error: {
              code: "suggestion-set-rejected",
              message: "Selection state state:test does not match proof state state:next.",
            },
          },
          400,
        ),
      ),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Stale selection"));
  });

  it("ignores a delayed superseded success that arrives after the newer response", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let suggestionCalls = 0;
    const fetchMock = mockWithHistory(() =>
      suggestionCalls++ === 0 ? first.promise : second.promise,
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<StoredProofWorkspace session={session} node={node} />);

    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    fireEvent.click(screen.getByRole("button", { name: "Select pair" }));
    const suggestionRequests = fetchMock.mock.calls.filter(
      (call) => !String(call[0]).endsWith("/history"),
    );
    const secondRequest = JSON.parse(String(suggestionRequests[1]?.[1]?.body)) as { id: string };
    second.resolve(
      jsonResponse({
        ok: true,
        data: {
          suggestionSet: suggestionSet(secondRequest.id, "New response", "result:new"),
          replayed: false,
          transitionClasses: [],
        },
      }),
    );
    await screen.findByText("New response");

    const firstRequest = JSON.parse(String(suggestionRequests[0]?.[1]?.body)) as { id: string };
    await act(async () => {
      first.resolve(
        jsonResponse({
          ok: true,
          data: {
            suggestionSet: suggestionSet(firstRequest.id, "Old response", "result:old"),
            replayed: false,
            transitionClasses: [],
          },
        }),
      );
      await first.promise;
    });
    expect(screen.getByText("New response")).toBeVisible();
    expect(screen.queryByText("Old response")).not.toBeInTheDocument();
  });

  it("ignores late failures and clears a pending menu when the snapshot changes", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      mockWithHistory(() => pending.promise),
    );
    const { rerender } = render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading suggestions");

    const nextNode = createProofNodeSchema().parse({
      ...node,
      id: "node:next",
      state: { ...node.state, id: "state:next" },
    });
    rerender(
      <StoredProofWorkspace session={{ ...session, currentNodeId: nextNode.id }} node={nextNode} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Select one or more");

    await act(async () => {
      pending.resolve(
        jsonResponse(
          { ok: false, error: { code: "suggestion-set-rejected", message: "Late rejection" } },
          400,
        ),
      );
      await pending.promise;
    });
    await waitFor(() => expect(screen.getByRole("status")).not.toHaveTextContent("Late rejection"));
  });

  it("renders provenance, matches, applicability, and transition class as an actionable card", async () => {
    const applicable = moveSuggestionSet("suggestion-set:move");
    vi.stubGlobal(
      "fetch",
      mockWithHistory(() =>
        jsonResponse({
          ok: true,
          data: {
            suggestionSet: applicable,
            replayed: false,
            transitionClasses: [
              { suggestionId: "suggestion:split-goal", transitionClass: "equivalence" },
            ],
          },
        }),
      ),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));

    const card = await screen.findByText("Split goal conjunction");
    const container = card.closest("[data-suggestion-id]");
    expect(container).toHaveAttribute("data-applicability", "applicable");
    expect(screen.getByText("The selected goal is a conjunction.")).toBeVisible();
    expect(screen.getByText("The target slot is fully matched.")).toBeVisible();
    expect(screen.getByText("selection:primary → target")).toBeVisible();
    expect(screen.getByText("equivalence")).toBeVisible();
  });

  it("makes requires-input suggestions visibly non-actionable and names the missing input", async () => {
    const requiresInput = moveSuggestionSet("suggestion-set:move", "requires-input");
    vi.stubGlobal(
      "fetch",
      mockWithHistory(() =>
        jsonResponse({
          ok: true,
          data: {
            suggestionSet: requiresInput,
            replayed: false,
            transitionClasses: [
              { suggestionId: "suggestion:split-goal", transitionClass: "equivalence" },
            ],
          },
        }),
      ),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    const card = (await screen.findByText("Split goal conjunction")).closest("li")!;
    expect(within(card).getByText("Additional input required")).toBeVisible();
    expect(within(card).getByText("choice")).toBeVisible();
    expect(within(card).getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("previews without advancing, then applies and clears transient evidence", async () => {
    const applicable = moveSuggestionSet("suggestion-set:move");
    const fetchMock = mockWithHistory((_input, init) => {
      const body = JSON.parse(String(init?.body)) as { commandId: string };
      if (String(_input).endsWith("/move-previews")) {
        return jsonResponse(
          { ok: true, data: { preview: previewFor(body.commandId), replayed: false } },
          201,
        );
      }
      if (String(_input).endsWith("/commands")) {
        const preview = previewFor(body.commandId);
        const nextNode = { id: `node:${body.commandId}`, state: preview.afterState };
        return jsonResponse(
          {
            ok: true,
            data: {
              session: { ...session, currentNodeId: nextNode.id },
              node: nextNode,
              receipt: {
                commandId: body.commandId,
                nodeId: nextNode.id,
                edgeId: `edge:${body.commandId}`,
                eventId: `event:${body.commandId}`,
                resultStateId: preview.afterState.id,
                transitionClass: "equivalence",
              },
              replayed: false,
            },
          },
          201,
        );
      }
      return jsonResponse({
        ok: true,
        data: {
          suggestionSet: applicable,
          replayed: false,
          transitionClasses: [
            { suggestionId: "suggestion:split-goal", transitionClass: "equivalence" },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    const card = (await screen.findByText("Split goal conjunction")).closest("li")!;

    fireEvent.click(within(card).getByRole("button", { name: "Preview" }));
    await within(card).findByLabelText("Move preview");
    expect(screen.getByText(`Current node ${node.id}`)).toBeVisible();
    expect(within(card).getByText("Goals").nextSibling).toHaveTextContent("+0 −1 ~0");

    fireEvent.click(within(card).getByRole("button", { name: "Apply" }));
    await screen.findByText(/advanced to node:command:web/);
    expect(screen.queryByTestId("suggestion-list")).not.toBeInTheDocument();
    const previewRequest = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith("/move-previews"),
    );
    const commandRequest = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith("/commands"),
    );
    expect(JSON.parse(String(previewRequest?.[1]?.body)).commandId).toBe(
      JSON.parse(String(commandRequest?.[1]?.body)).commandId,
    );
  });

  it("keeps the displayed node intact when apply is rejected", async () => {
    const applicable = moveSuggestionSet("suggestion-set:move");
    const commandBodies: Array<{ commandId: string }> = [];
    vi.stubGlobal(
      "fetch",
      mockWithHistory((input, init) => {
        if (String(input).endsWith("/move-previews")) {
          const body = JSON.parse(String(init?.body)) as { commandId: string };
          return jsonResponse(
            { ok: true, data: { preview: previewFor(body.commandId), replayed: false } },
            201,
          );
        }
        if (String(input).endsWith("/commands")) {
          commandBodies.push(JSON.parse(String(init?.body)) as { commandId: string });
          return jsonResponse(
            {
              ok: false,
              error: { code: "serialized-stale-command", message: "The parent is stale." },
            },
            400,
          );
        }
        return jsonResponse({
          ok: true,
          data: {
            suggestionSet: applicable,
            replayed: false,
            transitionClasses: [
              { suggestionId: "suggestion:split-goal", transitionClass: "equivalence" },
            ],
          },
        });
      }),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    const card = (await screen.findByText("Split goal conjunction")).closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: "Preview" }));
    await within(card).findByLabelText("Move preview");
    fireEvent.click(within(card).getByRole("button", { name: "Apply" }));

    await screen.findByText("Apply rejected: The parent is stale.");
    expect(screen.getByText(`Current node ${node.id}`)).toBeVisible();
    expect(within(card).getByLabelText("Move preview")).toBeVisible();
    expect(within(card).getByRole("button", { name: "Apply" })).toBeEnabled();

    fireEvent.click(within(card).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(commandBodies).toHaveLength(2));
    expect(commandBodies[1]?.commandId).toBe(commandBodies[0]?.commandId);
  });

  it("backtracks to a retained ancestor and replaces the rendered current snapshot", async () => {
    const child = createProofNodeSchema().parse({
      ...node,
      id: "node:child",
      state: { ...node.state, id: "state:child" },
    });
    const childSession = { ...session, currentNodeId: child.id };
    const edge = {
      id: "edge:child",
      commandId: "command:child",
      parentNodeId: node.id,
      childNodeId: child.id,
      moveId: "move:split-goal-conjunction",
      operation: {
        kind: "close-true",
        expectedStateId: node.state.id,
        resultStateId: child.state.id,
        target: { kind: "goal", id: "goal:test" },
      },
      transitionClass: "equivalence",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        if (String(input).endsWith("/history")) {
          return jsonResponse({
            ok: true,
            data: {
              session: childSession,
              nodes: [node, child],
              edges: [{ edge, name: "Split goal conjunction" }],
            },
          });
        }
        if (String(input).endsWith("/backtrack")) {
          return jsonResponse({
            ok: true,
            data: { session, node, replayed: false },
          });
        }
        throw new Error("Unexpected request");
      }),
    );
    render(<StoredProofWorkspace session={childSession} node={child} />);

    const rootButton = await screen.findByRole("button", { name: /Root.*node:test/ });
    fireEvent.click(rootButton);

    await screen.findByText("Backtracked to node:test.");
    expect(screen.getByText("Current node node:test")).toBeVisible();
  });
});
