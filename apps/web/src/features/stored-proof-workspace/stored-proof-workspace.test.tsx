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

    fireEvent.click(within(card).getByRole("button", { name: "Choose inputs" }));
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
