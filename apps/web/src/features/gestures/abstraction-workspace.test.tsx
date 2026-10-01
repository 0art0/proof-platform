// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  type DisplayedSuggestionSet,
} from "@proof/protocol";
import {
  resolveProofSelection,
  type AnchoredProofSelection,
  type StatementAnchor,
} from "@proof/selections";
import { GestureTray } from "./gesture-ui";
import type { GestureBindings } from "./use-drag-gestures";
import { StoredProofWorkspace } from "../stored-proof-workspace/stored-proof-workspace";

/** N33: abstracting a selection changes retrieval only. */

type SelectionHandler = (selections: readonly AnchoredProofSelection[]) => void;
let selectOccurrences: SelectionHandler = () => undefined;

vi.mock("../proof-workspace", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    ProofWorkspace: function MockProofWorkspace({
      onSelectionChange,
    }: {
      onSelectionChange: SelectionHandler;
    }) {
      selectOccurrences = onSelectionChange;
      return <span data-testid="mock-workspace" />;
    },
  };
});

const node = createProofNodeSchema().parse({
  id: "node:test",
  state: {
    id: "state:test",
    goals: [
      {
        id: "goal:test",
        sequent: {
          context: {
            declarations: ["a", "b"].map((symbol) => ({
              id: `declaration:${symbol}`,
              symbol,
              sort: { kind: "named", id: "sort:natural" },
              role: "universal-parameter",
            })),
            hypotheses: [],
          },
          conclusion: { expression: ["Equal", "a", "b"] },
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

const goalAnchor = {
  stateId: node.state.id,
  target: { kind: "goal", id: "goal:test" },
  statement: { kind: "conclusion" },
} as StatementAnchor;
const exact = (path: readonly number[]): AnchoredProofSelection => ({
  kind: "exact",
  anchor: goalAnchor,
  path,
});

function resolved(selection: AnchoredProofSelection) {
  const outcome = resolveProofSelection(node.state, selection, { operators: [] });
  if (!outcome.ok) throw new Error("fixture selection must resolve");
  return outcome.selection;
}

const baseSuggestion = {
  source: "move",
  artifactId: "move:close-by-hypothesis",
  patternId: "pattern:close-by-hypothesis",
  name: "Close by hypothesis",
  substitutions: [],
  rank: [0],
  reasons: ["Displayed by retrieval."],
  unresolvedSelectionSlots: [],
  unresolvedParameters: [],
};

/** What the worker would return: an abstraction-backed set needs input, a concrete one applies. */
function setFor(selections: readonly Record<string, unknown>[]): DisplayedSuggestionSet {
  const abstraction = selections[0]?.abstraction;
  return displayedSuggestionSetSchema.parse({
    id: "suggestion-set:answer",
    nodeId: node.id,
    stateId: node.state.id,
    selection: {
      kind: "selection-query",
      stateId: node.state.id,
      selections: selections.map((selection, index) => ({
        id: `selection:request-${index + 1}`,
        selection: resolved(exact(selection.path as number[])),
        ...(selection.abstraction === undefined ? {} : { abstraction: selection.abstraction }),
      })),
    },
    suggestions: [
      {
        id: "suggestion:close",
        ...baseSuggestion,
        exactRepresentationMatch: abstraction === undefined,
        applicability: abstraction === undefined ? "applicable" : "requires-input",
        abstractionFit: abstraction === undefined ? "not-used" : "compatible",
        ...(abstraction === undefined ? {} : { unresolvedParameters: ["P"] }),
        selectionMatches: selections.map((_selection, index) => ({
          selectionId: `selection:request-${index + 1}`,
          patternId: baseSuggestion.patternId,
          selectionSlotId: "target",
        })),
      },
    ],
    variantGroups: [],
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = Readonly<{ url: string; body: Record<string, unknown> }>;
let calls: Call[] = [];

function serve() {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/history")) {
        return json({ ok: true, data: { session, nodes: [node], edges: [] } });
      }
      if (url.includes("/inquiry-records")) return json({ ok: true, data: { records: [] } });
      if (url.endsWith("/interaction-events")) {
        calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return json({ ok: true, data: {} }, 201);
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/suggestion-sets")) {
        const suggestionSet = setFor(body.selections as Record<string, unknown>[]);
        return json({
          ok: true,
          data: {
            suggestionSet,
            replayed: false,
            transitionClasses: [
              { suggestionId: "suggestion:close", transitionClass: "equivalence" },
            ],
          },
        });
      }
      if (url.endsWith("/move-previews")) {
        const commandId = String(body.commandId);
        const afterState = { ...node.state, id: `state:${commandId}`, goals: [] };
        return json(
          {
            ok: true,
            data: {
              replayed: false,
              preview: {
                id: `preview:${commandId}`,
                nodeId: node.id,
                stateId: node.state.id,
                suggestionSetId: "suggestion-set:answer",
                chosenSuggestionId: "suggestion:close",
                moveId: "move:close-by-hypothesis",
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
              },
            },
          },
          201,
        );
      }
      return json({ ok: false, error: { code: "unexpected", message: url } }, 500);
    }),
  );
}

const callsTo = (suffix: string) => calls.filter(({ url }) => url.endsWith(suffix));
const suggestionBodies = () =>
  callsTo("/suggestion-sets").map(
    ({ body }) => (body as { selections: Record<string, unknown>[] }).selections,
  );

const PROPOSITION_WILDCARD = {
  id: "wildcard:request-1",
  symbol: "_a1",
  role: "retrieval-wildcard",
  sort: { kind: "proposition" },
};

beforeEach(() => {
  calls = [];
  let uuid = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  );
  serve();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function selectGoal(path: readonly number[] = []) {
  render(<StoredProofWorkspace session={session} node={node} />);
  act(() => selectOccurrences([exact(path)]));
  await screen.findByText("Close by hypothesis");
}

describe("abstract selections in the stored workspace", () => {
  it("offers a keyboard-accessible toggle only once something is selected", async () => {
    render(<StoredProofWorkspace session={session} node={node} />);
    expect(screen.queryByRole("button", { name: "Abstract this selection" })).toBeNull();
    act(() => selectOccurrences([exact([])]));
    const toggle = await screen.findByRole("button", { name: "Abstract this selection" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle.tagName).toBe("BUTTON");
    expect(screen.getByTestId("abstraction-indicator")).toHaveTextContent("Concrete");
  });

  it("sends a sort-preserving abstraction, shows a text indicator and the abstraction badge", async () => {
    await selectGoal();
    expect(suggestionBodies()).toEqual([[{ kind: "exact", anchor: goalAnchor, path: [] }]]);

    fireEvent.click(screen.getByRole("button", { name: "Abstract this selection" }));
    await waitFor(() => expect(callsTo("/suggestion-sets")).toHaveLength(2));
    expect(suggestionBodies()[1]).toEqual([
      { kind: "exact", anchor: goalAnchor, path: [], abstraction: PROPOSITION_WILDCARD },
    ]);
    const toggle = screen.getByRole("button", { name: "Abstract this selection" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Not colour alone: the state is spelled out.
    expect(screen.getByTestId("abstraction-indicator")).toHaveTextContent(
      "Abstract (any proposition): searching for results that fit any proposition here, not just this exact one. Only the search changes",
    );
    const badge = await waitFor(() => {
      const found = document.querySelector('[data-badge="match"]');
      expect(found).toHaveAttribute("data-match", "abstraction");
      return found as HTMLElement;
    });
    expect(badge).toHaveTextContent("Abstraction");
  });

  it("gives a term selection an unsorted wildcard", async () => {
    await selectGoal([0]);
    fireEvent.click(screen.getByRole("button", { name: "Abstract this selection" }));
    await waitFor(() => expect(callsTo("/suggestion-sets")).toHaveLength(2));
    expect(suggestionBodies()[1]).toEqual([
      {
        kind: "exact",
        anchor: goalAnchor,
        path: [0],
        abstraction: { id: "wildcard:request-1", symbol: "_a1", role: "retrieval-wildcard" },
      },
    ]);
    expect(screen.getByTestId("abstraction-indicator")).toHaveTextContent("any term");
  });

  it("never previews or applies an abstract result; preview and apply use the concrete selection", async () => {
    await selectGoal();
    fireEvent.click(screen.getByRole("button", { name: "Abstract this selection" }));
    await waitFor(() => expect(callsTo("/suggestion-sets")).toHaveLength(2));
    const card = (await screen.findByText("Additional input required")).closest("li")!;
    expect(within(card).getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(callsTo("/move-previews")).toHaveLength(0);
    expect(callsTo("/commands")).toHaveLength(0);

    // Turning the abstraction off asks again with the unchanged concrete occurrence.
    fireEvent.click(screen.getByRole("button", { name: "Abstract this selection" }));
    await waitFor(() => expect(callsTo("/suggestion-sets")).toHaveLength(3));
    expect(suggestionBodies()[2]).toEqual([{ kind: "exact", anchor: goalAnchor, path: [] }]);
    await waitFor(() => expect(screen.queryByText("Additional input required")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    await screen.findByLabelText("Move preview");
    const [previewRequest] = callsTo("/move-previews");
    expect(Object.keys(previewRequest!.body).sort()).toEqual([
      "chosenSuggestionId",
      "commandId",
      "suggestionSetId",
    ]);
    expect(JSON.stringify(previewRequest!.body)).not.toMatch(/abstraction|wildcard/);
    expect(callsTo("/commands")).toHaveLength(0);
  });

  it("drops the abstract flag when the selection moves to another occurrence", async () => {
    await selectGoal();
    fireEvent.click(screen.getByRole("button", { name: "Abstract this selection" }));
    await waitFor(() => expect(callsTo("/suggestion-sets")).toHaveLength(2));

    act(() => selectOccurrences([exact([0])]));
    await waitFor(() => expect(callsTo("/suggestion-sets")).toHaveLength(3));
    expect(suggestionBodies()[2]).toEqual([{ kind: "exact", anchor: goalAnchor, path: [0] }]);
    expect(screen.getByRole("button", { name: "Abstract this selection" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("records the concrete occurrence, not the abstraction, in interaction events", async () => {
    await selectGoal();
    fireEvent.click(screen.getByRole("button", { name: "Abstract this selection" }));
    await waitFor(() => expect(callsTo("/suggestion-sets")).toHaveLength(2));
    expect(JSON.stringify(callsTo("/interaction-events").map(({ body }) => body))).not.toMatch(
      /abstraction|wildcard/,
    );
  });
});

describe("abstraction toggle guidance", () => {
  it("explains itself in plain language through a hint tied to the toggle", async () => {
    await selectGoal();
    const toggle = screen.getByRole("button", { name: "Abstract this selection" });
    const hint = screen.getByTestId("abstraction-hint");
    expect(hint).toHaveTextContent(
      "Abstract: search for results that fit any expression of this type, not just this exact one.",
    );
    expect(toggle.getAttribute("aria-describedby")).toContain(hint.id);
    expect(toggle).toHaveAccessibleDescription(/fit any expression of this type/);
    // No popups or dialogs: guidance is inline text only.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  const bindings = {
    enabled: true,
    carrying: undefined,
    state: { phase: "idle" },
    disabledReason: undefined,
  } as unknown as GestureBindings;

  it.each([
    ["a binder declaration", "binder", false, /a binder declaration names a variable/],
    ["a pending move", "proposition", true, /while a move is being applied/],
  ] as const)("says why the toggle is disabled for %s", (_label, role, disabled, reason) => {
    render(
      <GestureTray
        bindings={bindings}
        selections={[exact([])]}
        view="formal"
        abstraction={{ abstractKeys: [], roleOf: () => role, toggle: vi.fn(), disabled }}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Abstract this selection" });
    expect(toggle).toBeDisabled();
    expect(screen.getByTestId("abstraction-indicator")).toHaveTextContent(reason);
    expect(toggle).toHaveAccessibleDescription(reason);
  });
});
