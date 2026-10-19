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
    view,
  }: {
    onSelectionChange: (selections: readonly AnchoredProofSelection[]) => void;
    view?: string;
  }) => (
    <div>
      <span data-testid="workspace-view">{view}</span>
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
/** Interaction-event bodies the workspace posted, in posting order. */
let postedInteractions: Array<Record<string, unknown>> = [];

beforeEach(() => {
  uuid = 0;
  postedInteractions = [];
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

/** Reads the workspace makes on its own (history, the inquiry panel's records), not commands. */
function isBackgroundRead(url: string): boolean {
  return url.endsWith("/history") || url.includes("/inquiry-records");
}

function mockWithHistory(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith("/history")) return historyResponse();
    if (String(input).includes("/inquiry-records")) {
      return jsonResponse({ ok: true, data: { records: [] } });
    }
    if (String(input).endsWith("/interaction-events")) {
      postedInteractions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ ok: true, data: {} }, 201);
    }
    return handler(input, init);
  });
}

/** The interaction events posted so far, without their random client IDs. */
function postedKinds(): Array<Record<string, unknown>> {
  return postedInteractions.map((event) => {
    expect(event.id).toMatch(/^interaction:web-/);
    const copy: Record<string, unknown> = { ...event };
    delete copy.id;
    return copy;
  });
}

describe("StoredProofWorkspace", () => {
  it("rejects malformed anchors and marks stale anchors without making a request", async () => {
    const fetchMock = mockWithHistory(() => Promise.reject(new Error("Unexpected request")));
    vi.stubGlobal("fetch", fetchMock);
    render(<StoredProofWorkspace session={session} node={node} />);

    fireEvent.click(screen.getByRole("button", { name: "Select malformed" }));
    expect(screen.getByRole("status")).toHaveTextContent("could not be encoded safely");

    fireEvent.click(screen.getByRole("button", { name: "Select stale" }));
    expect(screen.getByRole("status")).toHaveTextContent("selection is out of date");
    expect(fetchMock.mock.calls.filter((call) => !isBackgroundRead(String(call[0])))).toHaveLength(
      0,
    );
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

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("selection is out of date"),
    );
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
      (call) => !isBackgroundRead(String(call[0])),
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
    expect(screen.getByRole("status")).toHaveTextContent("Finding suggestions");

    const nextNode = createProofNodeSchema().parse({
      ...node,
      id: "node:next",
      state: { ...node.state, id: "state:next" },
    });
    rerender(
      <StoredProofWorkspace session={{ ...session, currentNodeId: nextNode.id }} node={nextNode} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Select a statement or expression");

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
    const explanation = screen
      .getByText("Why this was suggested")
      .closest("details") as HTMLDetailsElement;
    explanation.open = true;
    fireEvent(explanation, new Event("toggle"));
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
    expect(within(card).getByText("Choose from the current context to continue")).toBeVisible();
    expect(within(card).getByText(/Choose the missing value from the options/)).toBeVisible();
    expect(within(card).getByRole("button", { name: "Preview changes" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Apply this step" })).toBeDisabled();
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

    fireEvent.click(within(card).getByRole("button", { name: "Preview changes" }));
    await within(card).findByLabelText("Move preview");
    expect(screen.getByText(`Current node ${node.id}`)).toBeVisible();
    expect(within(card).getByText("Goals").nextSibling).toHaveTextContent("+0 −1 ~0");

    fireEvent.click(within(card).getByRole("button", { name: "Apply this step" }));
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
    fireEvent.click(within(card).getByRole("button", { name: "Preview changes" }));
    await within(card).findByLabelText("Move preview");
    fireEvent.click(within(card).getByRole("button", { name: "Apply this step" }));

    await screen.findByText("Apply rejected: The parent is stale.");
    expect(screen.getByText(`Current node ${node.id}`)).toBeVisible();
    expect(within(card).getByLabelText("Move preview")).toBeVisible();
    expect(within(card).getByRole("button", { name: "Apply this step" })).toBeEnabled();

    fireEvent.click(within(card).getByRole("button", { name: "Apply this step" }));
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

    const branch = screen.getByRole("navigation", { name: "Current branch" });
    await waitFor(() =>
      expect(
        within(branch)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(["Root", "Split goal conjunction"]),
    );
    expect(screen.getByRole("heading", { level: 1, name: "session:test" })).toBeVisible();
    expect(screen.getByTestId("snapshot-status")).toHaveTextContent("Open: 1 goal, 0 obligations");

    const rootButton = await screen.findByRole("button", { name: /Root.*node:test/ });
    fireEvent.click(rootButton);

    await screen.findByText("Backtracked to node:test.");
    expect(screen.getByText("Current node node:test")).toBeVisible();

    // The new snapshot's workspace reports its empty selection when it mounts; that must not
    // discard the backtrack notice.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("Backtracked to node:test.")).toBeVisible();
  });

  it("passes the selected statement view to the workspace and read-only history", async () => {
    vi.stubGlobal(
      "fetch",
      mockWithHistory(() => Promise.reject(new Error("Unexpected request"))),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    expect(screen.getByTestId("workspace-view")).toHaveTextContent("formal");
    fireEvent.click(screen.getByRole("button", { name: "Natural language" }));
    expect(screen.getByTestId("workspace-view")).toHaveTextContent("natural-language");
    const history = screen.getByRole("region", { name: "Proof-discovery tree" });
    await waitFor(() => expect(within(history).getByText(/Goal:/)).toHaveTextContent("and"));
  });

  it("reports selection, suggestion, preview and rejection interactions in order", async () => {
    const applicable = moveSuggestionSet("suggestion-set:move");
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
    fireEvent.click(within(card).getByRole("button", { name: "Preview changes" }));
    await within(card).findByLabelText("Move preview");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(postedInteractions).toHaveLength(7));
    const requested = postedInteractions[1]?.suggestionSetId;
    const preview = postedInteractions[3];
    expect(postedKinds()).toEqual([
      {
        kind: "selection-changed",
        nodeId: node.id,
        selections: [{ kind: "exact", anchor: anchor(), path: [0] }],
      },
      { kind: "suggestions-requested", nodeId: node.id, suggestionSetId: requested },
      {
        kind: "suggestions-displayed",
        nodeId: node.id,
        suggestionSetId: "suggestion-set:move",
        suggestionIds: ["suggestion:split-goal"],
      },
      {
        kind: "preview-requested",
        nodeId: node.id,
        suggestionSetId: "suggestion-set:move",
        chosenSuggestionId: "suggestion:split-goal",
        commandId: preview?.commandId,
      },
      {
        kind: "preview-rejected",
        nodeId: node.id,
        previewId: `preview:${String(preview?.commandId)}`,
        reason: "selection-changed",
      },
      { kind: "selection-changed", nodeId: node.id, selections: [] },
      {
        kind: "interaction-ended-without-action",
        nodeId: node.id,
        suggestionSetId: "suggestion-set:move",
        reason: "selection-cleared",
      },
    ]);
  });

  it("reports an expanded input menu", async () => {
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
    const details = within(card).getByText("Why input is needed").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));

    await waitFor(() =>
      expect(postedKinds()).toContainEqual({
        kind: "menu-expanded",
        nodeId: node.id,
        suggestionSetId: "suggestion-set:move",
        suggestionId: "suggestion:split-goal",
      }),
    );
    expect(
      within(details as HTMLElement).getByText(/menu offers choices from the current proof state/),
    ).toBeVisible();
  });

  it("shows the regenerated preview when apply finds stale definitions, then applies it", async () => {
    const applicable = moveSuggestionSet("suggestion-set:move");
    let applies = 0;
    let previews = 0;
    vi.stubGlobal(
      "fetch",
      mockWithHistory((input, init) => {
        const body = JSON.parse(String(init?.body)) as { commandId: string };
        if (String(input).endsWith("/move-previews")) {
          previews += 1;
          return jsonResponse(
            { ok: true, data: { preview: previewFor(body.commandId), replayed: previews > 1 } },
            previews > 1 ? 200 : 201,
          );
        }
        if (String(input).endsWith("/commands")) {
          applies += 1;
          if (applies === 1) {
            return jsonResponse(
              {
                ok: false,
                error: {
                  code: "preview-regenerated",
                  message: "The approved definitions behind the preview changed.",
                },
              },
              409,
            );
          }
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
      }),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    const card = (await screen.findByText("Split goal conjunction")).closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: "Preview changes" }));
    await within(card).findByLabelText("Move preview");
    fireEvent.click(within(card).getByRole("button", { name: "Apply this step" }));

    await screen.findByText(/Apply paused: The approved definitions behind the preview changed/);
    expect(previews).toBe(2);
    expect(screen.getByText(`Current node ${node.id}`)).toBeVisible();
    expect(within(card).getByLabelText("Move preview")).toBeVisible();

    fireEvent.click(within(card).getByRole("button", { name: "Apply this step" }));
    await screen.findByText(/advanced to node:command:web/);
    expect(applies).toBe(2);
  });

  it("round-trips a parameter menu: returned menus, chosen item IDs, preview, and apply", async () => {
    const requiresInput = moveSuggestionSet("suggestion-set:move", "requires-input");
    const menu = {
      parameterId: "choice",
      label: "Conjunct",
      automatic: false,
      items: [
        {
          id: "menu-item:00000000000000b1",
          label: { kind: "math", expression: "p" },
          value: { kind: "index", index: 0 },
          origin: { kind: "conclusion" },
        },
        {
          id: "menu-item:00000000000000b2",
          label: { kind: "math", expression: "q" },
          value: { kind: "index", index: 1 },
          origin: { kind: "conclusion" },
        },
      ],
    };
    const previewBodies: Array<Record<string, unknown>> = [];
    const menuBodies: Array<Record<string, unknown>> = [];
    const commandBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      mockWithHistory((input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (url.endsWith("/move-previews")) {
          previewBodies.push(body);
          if (body.menuChoices === undefined) {
            return jsonResponse(
              {
                ok: false,
                error: { code: "requires-input", message: "Choose a conjunct." },
              },
              422,
            );
          }
          const preview = {
            ...previewFor(String(body.commandId)),
            menuSelection: { menus: [menu], choices: body.menuChoices },
          };
          return jsonResponse({ ok: true, data: { preview, replayed: false } }, 201);
        }
        if (url.endsWith("/protocol-commands")) {
          menuBodies.push(body);
          return jsonResponse(
            {
              ok: false,
              error: { code: "requires-input", message: "Choose a conjunct." },
              details: {
                status: "requires-input",
                commandId: body.commandId,
                suggestionSetId: "suggestion-set:move",
                chosenSuggestionId: "suggestion:split-goal",
                menus: [
                  {
                    ...menu,
                    items: menu.items.map((item, index) => ({ ...item, alias: `m${index + 1}` })),
                  },
                ],
                missingParameters: ["choice"],
                diagnostics: [{ code: "requires-input", message: "Choose a conjunct." }],
              },
            },
            422,
          );
        }
        if (url.endsWith("/commands")) {
          commandBodies.push(body);
          const preview = previewFor(String(body.commandId));
          const nextNode = { id: `node:${String(body.commandId)}`, state: preview.afterState };
          return jsonResponse(
            {
              ok: true,
              data: {
                session: { ...session, currentNodeId: nextNode.id },
                node: nextNode,
                receipt: {
                  commandId: body.commandId,
                  nodeId: nextNode.id,
                  edgeId: `edge:${String(body.commandId)}`,
                  eventId: `event:${String(body.commandId)}`,
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
            suggestionSet: requiresInput,
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
    expect(within(card).getByRole("button", { name: "Preview changes" })).toBeDisabled();

    fireEvent.click(within(card).getByRole("button", { name: "Fill in missing values" }));
    const form = await within(card).findByRole("form", {
      name: "Parameter menus for Split goal conjunction",
    });
    expect(menuBodies).toEqual([
      {
        commandId: previewBodies[0]?.commandId,
        actor: { id: "actor:web", kind: "human" },
        basis: { nodeId: node.id, suggestionSetId: "suggestion-set:move" },
        command: {
          kind: "preview",
          suggestion: "suggestion:split-goal",
          suggestionSetId: "suggestion-set:move",
        },
      },
    ]);
    const radios = within(form).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("value"))).toEqual([
      "menu-item:00000000000000b1",
      "menu-item:00000000000000b2",
    ]);
    fireEvent.click(radios[1]!);
    fireEvent.click(within(form).getByRole("button", { name: "Preview with these inputs" }));

    const preview = await within(card).findByLabelText("Move preview");
    expect(previewBodies).toHaveLength(2);
    expect(previewBodies[1]?.menuChoices).toEqual({ choice: "menu-item:00000000000000b2" });
    expect(previewBodies[1]?.commandId).not.toBe(previewBodies[0]?.commandId);
    expect(within(preview).getByLabelText("Chosen inputs")).toHaveTextContent("Conjunct:");
    expect(within(card).queryByRole("form")).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Apply this step" }));
    await screen.findByText(/advanced to node:command:web/);
    expect(commandBodies).toEqual([
      {
        commandId: previewBodies[1]?.commandId,
        suggestionSetId: "suggestion-set:move",
        chosenSuggestionId: "suggestion:split-goal",
        menuChoices: { choice: "menu-item:00000000000000b2" },
      },
    ]);
    await waitFor(() =>
      expect(postedKinds()).toContainEqual({
        kind: "menu-expanded",
        nodeId: node.id,
        suggestionSetId: "suggestion-set:move",
        suggestionId: "suggestion:split-goal",
        parameterId: "choice",
      }),
    );
  });
});

describe("StoredProofWorkspace AI ranking", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  function twoSuggestions(id: string): DisplayedSuggestionSet {
    const set = suggestionSet(id, "First idea", "result:first");
    const second = {
      ...set.suggestions[0],
      id: "suggestion:second",
      artifactId: "result:second",
      patternId: "pattern:second",
      name: "Second idea",
      selectionMatches: [{ selectionId: "selection:primary", patternId: "pattern:second" }],
    };
    return displayedSuggestionSetSchema.parse({
      ...set,
      suggestions: [set.suggestions[0], second],
    });
  }

  function aiFetch(set: DisplayedSuggestionSet, shortlistAnswer: () => Response) {
    const shortlistBodies: Array<Record<string, unknown>> = [];
    const fetchMock = mockWithHistory(async (input, init) => {
      if (String(input).endsWith("/ai-shortlist")) {
        shortlistBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return shortlistAnswer();
      }
      return jsonResponse({
        ok: true,
        data: { suggestionSet: set, replayed: false, transitionClasses: [] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return shortlistBodies;
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("ranks a displayed list automatically once, with the automatic trigger", async () => {
    const set = twoSuggestions("suggestion-set:auto");
    const bodies = aiFetch(set, () =>
      jsonResponse({
        ok: true,
        data: {
          status: "shortlisted",
          provenance: "minimal-context-llm",
          suggestionSetId: set.id,
          nodeId: node.id,
          choices: [{ suggestionId: "suggestion:second", rationale: "Fits best." }],
          fallbackCandidateIds: [],
          diagnostics: [],
        },
      }),
    );
    render(<StoredProofWorkspace session={session} node={node} aiShortlist />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));

    const picks = await screen.findByRole("list", { name: "AI picks" }, { timeout: 4_000 });
    expect(picks).toHaveTextContent("Second idea — Fits best.");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      trigger: "automatic",
      expectedCurrentNodeId: node.id,
      suggestionSetId: set.id,
      candidateIds: ["suggestion:result:first", "suggestion:second"],
    });
  });

  it("falls back silently to the list on a rate limit and leaves the next-step buttons unwired", async () => {
    const set = twoSuggestions("suggestion-set:limited");
    const bodies = aiFetch(set, () =>
      jsonResponse({ ok: false, error: { code: "ai-rate-limited", message: "Retry later." } }, 429),
    );
    render(<StoredProofWorkspace session={session} node={node} aiShortlist />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    await screen.findByTestId("suggestion-list");
    await waitFor(() => expect(bodies).toHaveLength(1), { timeout: 4_000 });
    await wait(50);
    expect(screen.queryByText(/No AI ranking:/)).toBeNull();
    expect(screen.getByTestId("suggestion-list").children).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Describe a move" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Find more results" })).toBeNull();
  });

  it("makes no AI request, and shows no AI control, when the shortlister is not configured", async () => {
    const set = twoSuggestions("suggestion-set:off");
    const bodies = aiFetch(set, () => jsonResponse({ ok: false }, 500));
    render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    await screen.findByTestId("suggestion-list");
    await wait(900);
    expect(bodies).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "AI ranking" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("makes no AI request for a read-only session", async () => {
    const set = twoSuggestions("suggestion-set:read-only");
    const bodies = aiFetch(set, () => jsonResponse({ ok: false }, 500));
    render(
      <StoredProofWorkspace session={{ ...session, readOnly: true }} node={node} aiShortlist />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    await screen.findByTestId("suggestion-list");
    await wait(900);
    expect(bodies).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "AI ranking" })).toBeNull();
  });
});

describe("StoredProofWorkspace move instructions", () => {
  const afterNode = createProofNodeSchema().parse({
    id: "node:after-instruction",
    state: { id: "state:after-instruction", goals: [], obligations: [] },
  });

  const previewAnswer = {
    ok: true,
    data: {
      status: "previewed",
      provenance: { kind: "user-proposal", role: "move-executor" },
      callId: "llm-call:execute-00000000-0000-4000-8000-000000000001",
      replayed: false,
      nodeId: node.id,
      explanation: "Close the goal.",
      transitionClass: "equivalence",
      evidence: "structural",
      steps: [
        {
          index: 1,
          operation: { kind: "close-true" },
          transitionClass: "equivalence",
          evidence: "structural",
        },
      ],
      preview: {
        transitionClass: "equivalence",
        evidence: "structural",
        beforeState: node.state,
        afterState: afterNode.state,
        delta: {
          goals: { added: [], removed: ["goal:test"], updated: [] },
          obligations: { added: [], removed: [], updated: [] },
        },
      },
      diagnostics: [],
    },
  };

  /** Two displayed suggestions, so the shortlister has something to rank. */
  function twoMoves(id: string): DisplayedSuggestionSet {
    const set = suggestionSet(id, "First idea", "result:first");
    const first = set.suggestions[0]!;
    return displayedSuggestionSetSchema.parse({
      ...set,
      suggestions: [
        first,
        {
          ...first,
          id: "suggestion:second",
          artifactId: "result:second",
          patternId: "pattern:second",
          name: "Second idea",
          selectionMatches: [{ selectionId: "selection:primary", patternId: "pattern:second" }],
        },
      ],
    });
  }

  function instructionFetch(onRequest: (url: string, body: unknown) => Response | undefined) {
    const calls: Array<{ url: string; body: unknown }> = [];
    let moved = false;
    const fetchMock = mockWithHistory(async (input, init) => {
      const url = String(input);
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ url, body });
      const answer = onRequest(url, body);
      if (answer !== undefined) {
        moved = moved || url.endsWith("/ai-execute/apply");
        return answer;
      }
      if (url.endsWith("/api/proof-sessions/session%3Atest")) {
        const current = moved ? afterNode : node;
        return jsonResponse({
          ok: true,
          data: { session: { ...session, currentNodeId: current.id }, node: current },
        });
      }
      return jsonResponse({ ok: false, error: { code: "unexpected", message: url } }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls, fetchMock };
  }

  it("marks a step a model proposed in the history, with where it came from", async () => {
    const edge = {
      id: "edge:ai-1",
      commandId: "command:ai-1",
      parentNodeId: node.id,
      childNodeId: afterNode.id,
      operation: {
        kind: "close-true",
        expectedStateId: node.state.id,
        resultStateId: afterNode.state.id,
        target: { kind: "goal", id: "goal:test" },
      },
      transitionClass: "equivalence",
      proposal: {
        source: "user-proposal",
        role: "move-executor",
        callId: "llm-call:execute-1",
        stepIndex: 1,
        stepCount: 2,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) =>
        String(input).endsWith("/history")
          ? jsonResponse({
              ok: true,
              data: {
                session,
                nodes: [node, afterNode],
                edges: [{ edge, name: "close-true" }],
              },
            })
          : jsonResponse({ ok: true, data: { records: [] } }),
      ),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    expect(await screen.findByText(/AI step 1 of 2 from your description/)).toBeVisible();
  });

  it("shows the box beside the proof, disabled with a reason when the model is not configured", () => {
    render(<StoredProofWorkspace session={session} node={node} />);
    const panel = screen.getByRole("region", { name: "Move instructions" });
    expect(within(panel).getByRole("textbox", { name: "Describe a step" })).toBeDisabled();
    const preview = within(panel).getByRole("button", { name: "Preview" });
    expect(preview).toBeDisabled();
    expect(preview).toHaveAccessibleDescription(/no AI provider is configured/);
  });

  it("is disabled with the read-only reason in an imported session", () => {
    render(
      <StoredProofWorkspace session={{ ...session, readOnly: true }} node={node} aiExecutor />,
    );
    const panel = screen.getByRole("region", { name: "Move instructions" });
    expect(within(panel).getByRole("button", { name: "Preview" })).toHaveAccessibleDescription(
      /read-only/,
    );
  });

  it("previews a described step for the selection, applies it, and moves to the new proof state", async () => {
    const { calls, fetchMock } = instructionFetch((url) =>
      url.endsWith("/ai-execute")
        ? jsonResponse(previewAnswer)
        : url.endsWith("/ai-execute/apply")
          ? jsonResponse(
              {
                ok: true,
                data: {
                  status: "applied",
                  callId: previewAnswer.data.callId,
                  replayed: false,
                  nodeId: afterNode.id,
                  transitionClass: "equivalence",
                  steps: [{ index: 1 }],
                },
              },
              201,
            )
          : undefined,
    );
    render(<StoredProofWorkspace session={session} node={node} aiExecutor />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    const panel = screen.getByRole("region", { name: "Move instructions" });
    fireEvent.change(within(panel).getByRole("textbox", { name: "Describe a step" }), {
      target: { value: "close it" },
    });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Preview" }));
    });

    const previewCall = calls.find(({ url }) => url.endsWith("/ai-execute"));
    expect(previewCall?.body).toMatchObject({
      expectedCurrentNodeId: node.id,
      instruction: "close it",
      source: "user-instruction",
      target: { kind: "goal", id: "goal:test" },
      selections: [{ kind: "exact", path: [0] }],
    });
    expect(screen.getByRole("region", { name: "Proposed steps" })).toBeVisible();
    // Nothing is applied by a preview.
    expect(calls.some(({ url }) => url.endsWith("/ai-execute/apply"))).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    const applyCall = calls.find(({ url }) => url.endsWith("/ai-execute/apply"));
    expect(applyCall?.body).toEqual({
      callId: previewAnswer.data.callId,
      expectedCurrentNodeId: node.id,
    });
    expect(await screen.findByText(/Applied 1 step from your description/)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Proposed steps" })).toBeNull();
    // The history is read again for the new current node.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/history")).length,
    ).toBeGreaterThan(1);
  });

  it("wires 'Describe a move' on the none-relevant notice to the description box", async () => {
    const twoCandidates = twoMoves("suggestion-set:none-relevant");
    vi.stubGlobal(
      "fetch",
      mockWithHistory(async (input) =>
        String(input).endsWith("/ai-shortlist")
          ? jsonResponse({
              ok: true,
              data: {
                status: "none-relevant",
                suggestionSetId: twoCandidates.id,
                reason: "Nothing fits.",
              },
            })
          : jsonResponse({
              ok: true,
              data: { suggestionSet: twoCandidates, replayed: false, transitionClasses: [] },
            }),
      ),
    );
    window.localStorage.clear();
    render(<StoredProofWorkspace session={session} node={node} aiShortlist aiExecutor />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ask AI to rank these" }));
    const describe = await screen.findByRole("button", { name: "Describe a move" });
    fireEvent.click(describe);
    expect(screen.getByRole("textbox", { name: "Describe a step" })).toHaveFocus();
    // Without a configured librarian the button is there, disabled, and says why.
    const findMore = screen.getByRole("button", { name: "Find more results" });
    expect(findMore).toBeDisabled();
    expect(findMore).toHaveAccessibleDescription(/library assistant is not set up/);
  });

  it("offers 'Describe a move' only when the box can take a description", async () => {
    const twoCandidates = twoMoves("suggestion-set:none-relevant-off");
    vi.stubGlobal(
      "fetch",
      mockWithHistory(async (input) =>
        String(input).endsWith("/ai-shortlist")
          ? jsonResponse({
              ok: true,
              data: {
                status: "none-relevant",
                suggestionSetId: twoCandidates.id,
                reason: "Nothing fits.",
              },
            })
          : jsonResponse({
              ok: true,
              data: { suggestionSet: twoCandidates, replayed: false, transitionClasses: [] },
            }),
      ),
    );
    window.localStorage.clear();
    render(<StoredProofWorkspace session={session} node={node} aiShortlist />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ask AI to rank these" }));
    await screen.findByText(/None of these suggestions look relevant/);
    expect(screen.queryByRole("button", { name: "Describe a move" })).toBeNull();
  });
});

describe("StoredProofWorkspace library top-ups", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  const emptySet = (id: string) =>
    displayedSuggestionSetSchema.parse({
      ...suggestionSet(id, "Unused", "result:unused"),
      suggestions: [],
    });

  function twoCandidates(id: string): DisplayedSuggestionSet {
    const set = suggestionSet(id, "First idea", "result:first");
    const first = set.suggestions[0]!;
    return displayedSuggestionSetSchema.parse({
      ...set,
      suggestions: [
        first,
        {
          ...first,
          id: "suggestion:second",
          artifactId: "result:second",
          patternId: "pattern:second",
          name: "Second idea",
          selectionMatches: [{ selectionId: "selection:primary", patternId: "pattern:second" }],
        },
      ],
    });
  }

  const TOPPED_UP = {
    ok: true,
    data: {
      status: "topped-up",
      requestKind: "no-relevant-results",
      addedCount: 2,
      added: [
        { id: "result:one", name: "One" },
        { id: "result:two", name: "Two" },
      ],
      rejected: [],
    },
  };
  const ACTIVATION = {
    symbol: "Gcd",
    edgeId: "edge:1",
    nodeId: "node:1",
    resultId: "result:library-gcd",
    sequence: 1,
    topUp: null,
  };

  type TopUpCall = { url: string; body: Record<string, unknown> | undefined };
  function topUpFetch(options: {
    sets: () => DisplayedSuggestionSet;
    topUp?: () => Response | Promise<Response>;
    activated?: readonly unknown[];
    shortlist?: Response;
  }) {
    const calls: TopUpCall[] = [];
    vi.stubGlobal(
      "fetch",
      mockWithHistory(async (input, init) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ url, body });
        if (url.endsWith("/library/constants")) {
          return jsonResponse({
            ok: true,
            data: {
              sessionId: session.id,
              readOnly: false,
              active: [],
              dormant: [],
              activated: options.activated ?? [],
            },
          });
        }
        if (url.endsWith("/ai-library-top-up")) {
          return options.topUp?.() ?? jsonResponse(TOPPED_UP);
        }
        if (url.endsWith("/ai-shortlist") && options.shortlist !== undefined) {
          return options.shortlist;
        }
        return jsonResponse({
          ok: true,
          data: { suggestionSet: options.sets(), replayed: false, transitionClasses: [] },
        });
      }),
    );
    return calls;
  }
  const topUps = (calls: readonly TopUpCall[]) =>
    calls.filter(({ url }) => url.endsWith("/ai-library-top-up"));
  const suggestionRequests = (calls: readonly TopUpCall[]) =>
    calls.filter(({ url }) => url.endsWith("/suggestion-sets"));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  it("finds more results from the empty suggestions state with the current selection", async () => {
    let release: (response: Response) => void = () => undefined;
    const calls = topUpFetch({
      sets: () => emptySet("suggestion-set:empty"),
      topUp: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    render(<StoredProofWorkspace session={session} node={node} aiLibrarian />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    const find = await screen.findByRole("button", { name: "Find more results" });
    expect(find).toBeEnabled();
    fireEvent.click(find);

    expect(await screen.findByText("Looking for more results…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Find more results" })).toBeDisabled();
    expect(topUps(calls)).toHaveLength(1);
    expect(topUps(calls)[0]?.body).toEqual({
      id: expect.stringMatching(/^llm-call:find-more-/),
      kind: "no-relevant-results",
      expectedCurrentNodeId: node.id,
      selections: [{ kind: "exact", anchor: anchor(), path: [0] }],
    });

    release(jsonResponse(TOPPED_UP));
    expect(
      await screen.findByText(
        "Added 2 results to the library. Ask for suggestions again to use them.",
      ),
    ).toBeVisible();

    // Asking again requests suggestions for the same selection, now from the enlarged library.
    const before = suggestionRequests(calls).length;
    fireEvent.click(screen.getByRole("button", { name: "Ask for suggestions again" }));
    await waitFor(() => expect(suggestionRequests(calls)).toHaveLength(before + 1));
  });

  it("finds more results from the shortlister's none-relevant notice", async () => {
    const set = twoCandidates("suggestion-set:none-relevant-more");
    const calls = topUpFetch({
      sets: () => set,
      shortlist: jsonResponse({
        ok: true,
        data: { status: "none-relevant", suggestionSetId: set.id, reason: "Nothing fits." },
      }),
    });
    render(<StoredProofWorkspace session={session} node={node} aiShortlist aiLibrarian />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ask AI to rank these" }));
    fireEvent.click(await screen.findByRole("button", { name: "Find more results" }));
    expect(await screen.findByText(/Added 2 results to the library/)).toBeVisible();
    expect(topUps(calls)[0]?.body).toMatchObject({ kind: "no-relevant-results" });
  });

  it("explains why the button is disabled, and sends nothing, without a librarian or when read-only", async () => {
    const calls = topUpFetch({ sets: () => emptySet("suggestion-set:disabled") });
    const unconfigured = render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    const find = await screen.findByRole("button", { name: "Find more results" });
    expect(find).toBeDisabled();
    expect(find).toHaveAccessibleDescription(/library assistant is not set up/);
    fireEvent.click(find);
    unconfigured.unmount();

    render(
      <StoredProofWorkspace session={{ ...session, readOnly: true }} node={node} aiLibrarian />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    const readOnly = await screen.findByRole("button", { name: "Find more results" });
    expect(readOnly).toBeDisabled();
    expect(readOnly).toHaveAccessibleDescription(/read-only/);
    await settle();
    expect(topUps(calls)).toHaveLength(0);
    expect(calls.some(({ url }) => url.endsWith("/library/constants"))).toBe(false);
  });

  it("reports a rate limit and a refusal in place, and lets the user try again", async () => {
    let attempt = 0;
    const calls = topUpFetch({
      sets: () => emptySet("suggestion-set:retry"),
      topUp: () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse({ ok: false, error: { code: "ai-rate-limited", message: "Later." } }, 429)
          : jsonResponse({
              ok: true,
              data: { status: "declined", result: { reason: "The library already covers this." } },
            });
      },
    });
    render(<StoredProofWorkspace session={session} node={node} aiLibrarian />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    fireEvent.click(await screen.findByRole("button", { name: "Find more results" }));
    expect(
      await screen.findByText("Too many AI requests right now. Wait a minute and try again."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Find more results" }));
    expect(
      await screen.findByText("No new results were added: the library already covers this."),
    ).toBeVisible();
    expect(topUps(calls)).toHaveLength(2);
    // The two requests are separate recorded calls.
    expect(topUps(calls)[0]?.body?.["id"]).not.toBe(topUps(calls)[1]?.body?.["id"]);
  });

  it("asks once for a newly activated constant, automatically, and says nothing about a failure", async () => {
    const calls = topUpFetch({
      sets: () => emptySet("suggestion-set:auto-top-up"),
      activated: [
        ACTIVATION,
        { ...ACTIVATION, symbol: "Lcm", topUp: { callId: "llm-call:earlier" } },
      ],
      topUp: () =>
        jsonResponse({ ok: false, error: { code: "ai-rate-limited", message: "Later." } }, 429),
    });
    render(<StoredProofWorkspace session={session} node={node} aiLibrarian />);
    await waitFor(() => expect(topUps(calls)).toHaveLength(1));
    expect(topUps(calls)[0]?.body).toMatchObject({ kind: "new-constants", constants: ["Gcd"] });
    await settle();
    // The failure is silent: no notice, and the page is otherwise as it was.
    expect(screen.queryByTestId("library-top-up-status")).toBeNull();
    expect(screen.queryByText(/Too many AI requests/)).toBeNull();
  });

  it("notes briefly what an automatic top-up added", async () => {
    topUpFetch({
      sets: () => emptySet("suggestion-set:auto-note"),
      activated: [ACTIVATION],
      topUp: () =>
        jsonResponse({ ok: true, data: { ...TOPPED_UP.data, requestKind: "new-constants" } }),
    });
    render(<StoredProofWorkspace session={session} node={node} aiLibrarian />);
    expect(
      await screen.findByText("The library now has 2 results about Gcd, added automatically."),
    ).toBeVisible();
  });

  it("makes no automatic request when the librarian is not configured or the session is read-only", async () => {
    const calls = topUpFetch({
      sets: () => emptySet("suggestion-set:no-auto"),
      activated: [ACTIVATION],
    });
    const plain = render(<StoredProofWorkspace session={session} node={node} />);
    await settle();
    plain.unmount();
    render(
      <StoredProofWorkspace session={{ ...session, readOnly: true }} node={node} aiLibrarian />,
    );
    await settle();
    expect(topUps(calls)).toHaveLength(0);
    expect(calls.some(({ url }) => url.endsWith("/library/constants"))).toBe(false);
  });
});
