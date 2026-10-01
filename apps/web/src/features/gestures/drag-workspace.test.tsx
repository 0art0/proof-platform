// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useEffect, useRef } from "react";
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
import { StoredProofWorkspace } from "../stored-proof-workspace/stored-proof-workspace";
import type { DragSource } from "./drag-state";
import type { GestureBindings, SelectionRequest } from "./use-drag-gestures";

vi.mock("../proof-workspace", () => ({
  ProofWorkspace: function MockProofWorkspace({
    onSelectionChange,
    gestures,
    selectionRequest,
  }: {
    onSelectionChange: (selections: readonly AnchoredProofSelection[]) => void;
    gestures: GestureBindings;
    selectionRequest?: SelectionRequest;
  }) {
    // Like the real workspace: a new request makes exactly those selections active.
    const handled = useRef(selectionRequest?.id);
    useEffect(() => {
      if (selectionRequest === undefined || selectionRequest.id === handled.current) return;
      handled.current = selectionRequest.id;
      onSelectionChange(selectionRequest.selections);
    }, [onSelectionChange, selectionRequest]);
    const pick = (source: DragSource) => () => gestures.pickUp(source, "pointer");
    return (
      <div>
        <span data-testid="gestures-enabled">{String(gestures.enabled)}</span>
        <button type="button" onClick={pick(hypothesisSource())}>
          Pick up hypothesis
        </button>
        <button type="button" onClick={pick(termSource())}>
          Pick up term
        </button>
        <button type="button" onClick={pick(resultSource)}>
          Pick up result
        </button>
        <button
          type="button"
          onClick={() => gestures.dropOn(goalAnchor(), exact(goalAnchor(), []))}
        >
          Drop on goal
        </button>
        <button
          type="button"
          onClick={() => gestures.dropOn(hypothesisAnchor, exact(hypothesisAnchor, []))}
        >
          Drop on hypothesis
        </button>
        <button
          type="button"
          onClick={() => gestures.dropOn(goalAnchor(), exact(goalAnchor(), [1]))}
        >
          Drop on goal slot
        </button>
        <button type="button" onClick={() => onSelectionChange([exact(goalAnchor(), [])])}>
          Select goal
        </button>
      </div>
    );
  },
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
            hypotheses: [{ id: "hypothesis:h1", statement: { expression: ["And", "p", "q"] } }],
          },
          conclusion: { expression: ["And", "q", "p"] },
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

const hypothesisAnchor: StatementAnchor = {
  stateId: node.state.id,
  target: { kind: "goal", id: "goal:test" },
  statement: { kind: "hypothesis", id: "hypothesis:h1" },
} as StatementAnchor;
const goalAnchor = (): StatementAnchor =>
  ({
    stateId: node.state.id,
    target: { kind: "goal", id: "goal:test" },
    statement: { kind: "conclusion" },
  }) as StatementAnchor;
const exact = (anchor: StatementAnchor, path: readonly number[]): AnchoredProofSelection => ({
  kind: "exact",
  anchor,
  path,
});
const hypothesisSource = (): DragSource => ({
  kind: "hypothesis",
  selection: exact(hypothesisAnchor, []),
  label: "hypothesis 1",
});
const termSource = (): DragSource => ({
  kind: "term",
  selection: exact(goalAnchor(), [0]),
  label: "the term q",
});
const resultSource: DragSource = {
  kind: "result",
  artifactId: "result:lemma",
  label: "Lemma",
};

function resolved(selection: AnchoredProofSelection) {
  const outcome = resolveProofSelection(node.state, selection, { operators: [] });
  if (!outcome.ok) throw new Error("fixture selection must resolve");
  return outcome.selection;
}

type Slot = string | undefined;

/** A displayed set answering a query over `selections`, with one suggestion assigning `slots`. */
function displayed(
  selections: readonly AnchoredProofSelection[],
  suggestions: readonly Readonly<{
    artifactId: string;
    source?: "move" | "result";
    slots: readonly Slot[];
  }>[],
): DisplayedSuggestionSet {
  const first = selections[0]!;
  return displayedSuggestionSetSchema.parse({
    id: "suggestion-set:move",
    nodeId: node.id,
    stateId: node.state.id,
    selection:
      selections.length === 1 && suggestions.every(({ source }) => source === "result")
        ? resolved(first)
        : {
            kind: "selection-query",
            stateId: node.state.id,
            selections: selections.map((selection, index) => ({
              id: `selection:request-${index + 1}`,
              selection: resolved(selection),
            })),
          },
    suggestions: suggestions.map(({ artifactId, source = "move", slots }, index) => ({
      id: index === 0 ? "suggestion:split-goal" : `suggestion:other-${index}`,
      source,
      artifactId,
      patternId: `pattern:${artifactId}`,
      name: `Name of ${artifactId}`,
      exactRepresentationMatch: true,
      substitutions: [],
      rank: [index],
      reasons: ["Displayed by retrieval."],
      selectionMatches: slots.map((selectionSlotId, position) => ({
        selectionId:
          source === "result" ? "selection:primary" : `selection:request-${position + 1}`,
        patternId: `pattern:${artifactId}`,
        ...(selectionSlotId === undefined ? {} : { selectionSlotId }),
      })),
      unresolvedSelectionSlots: [],
      unresolvedParameters: [],
      applicability: "applicable",
      abstractionFit: "not-used",
    })),
    variantGroups: [],
  });
}

function previewFor(commandId: string, artifactId: string) {
  const afterState = { ...node.state, id: `state:${commandId}`, goals: [] };
  return {
    id: `preview:${commandId}`,
    nodeId: node.id,
    stateId: node.state.id,
    suggestionSetId: "suggestion-set:move",
    chosenSuggestionId: "suggestion:split-goal",
    moveId: artifactId,
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = Readonly<{ url: string; body: Record<string, unknown> }>;
let calls: Call[] = [];

/** A service whose suggestion endpoint answers with `set`; previews and commands succeed. */
function serve(set: () => DisplayedSuggestionSet | Promise<DisplayedSuggestionSet>) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/history")) {
        return json({ ok: true, data: { session, nodes: [node], edges: [] } });
      }
      if (url.includes("/inquiry-records")) return json({ ok: true, data: { records: [] } });
      if (url.endsWith("/interaction-events")) return json({ ok: true, data: {} }, 201);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/suggestion-sets")) {
        const suggestionSet = await set();
        const transitionClasses = suggestionSet.suggestions
          .filter(({ source }) => source === "move")
          .map(({ id }) => ({ suggestionId: id, transitionClass: "equivalence" }));
        return json({ ok: true, data: { suggestionSet, replayed: false, transitionClasses } });
      }
      const commandId = String(body.commandId);
      const preview = previewFor(commandId, "move:x");
      if (url.endsWith("/move-previews")) {
        return json({ ok: true, data: { preview, replayed: false } }, 201);
      }
      const nextNode = { id: `node:${commandId}`, state: preview.afterState };
      return json(
        {
          ok: true,
          data: {
            session: { ...session, currentNodeId: nextNode.id },
            node: nextNode,
            receipt: {
              commandId,
              nodeId: nextNode.id,
              edgeId: `edge:${commandId}`,
              eventId: `event:${commandId}`,
              resultStateId: preview.afterState.id,
              transitionClass: "equivalence",
            },
            replayed: false,
          },
        },
        201,
      );
    }),
  );
}

const callsTo = (suffix: string) => calls.filter(({ url }) => url.endsWith(suffix));
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  calls = [];
  let uuid = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("drag gestures in the stored workspace", () => {
  it("previews a hypothesis dropped on a goal through the suggestion flow and commits only on Apply", async () => {
    const pair = [exact(hypothesisAnchor, []), exact(goalAnchor(), [])];
    serve(() =>
      displayed(pair, [{ artifactId: "move:close-by-hypothesis", slots: ["fact", "target"] }]),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    click("Pick up hypothesis");
    expect(screen.getByTestId("carrying")).toHaveTextContent("Carrying hypothesis: hypothesis 1");
    click("Drop on goal");

    // The drop asks the suggestion service about the pair, naming occurrences and not mathematics.
    const preview = await screen.findByLabelText("Move preview");
    expect(callsTo("/suggestion-sets")).toHaveLength(1);
    const { selections } = callsTo("/suggestion-sets")[0]!.body as {
      selections: Array<Record<string, unknown>>;
    };
    expect(selections).toEqual([
      { kind: "exact", anchor: hypothesisAnchor, path: [] },
      { kind: "exact", anchor: goalAnchor(), path: [] },
    ]);
    expect(JSON.stringify(callsTo("/suggestion-sets")[0]!.body)).not.toMatch(/expression|latex/);
    expect(screen.getByTestId("drag-outcome")).toHaveTextContent(
      "Use hypothesis (hypothesis onto goal): previewing Name of move:close-by-hypothesis.",
    );

    // Previewing changed nothing; only Apply commits.
    expect(callsTo("/move-previews")).toHaveLength(1);
    expect(callsTo("/commands")).toHaveLength(0);
    fireEvent.click(
      within(preview.closest("li")!).getByRole("button", { name: "Apply this step" }),
    );
    await screen.findByText(/advanced to node:command:web/);
    expect(callsTo("/commands")).toHaveLength(1);
  });

  it("previews a result dropped on an expression as a one-selection query", async () => {
    const slot = exact(goalAnchor(), [1]);
    serve(() =>
      displayed([slot], [{ artifactId: "result:lemma", source: "result", slots: [undefined] }]),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    click("Pick up result");
    click("Drop on goal slot");

    await screen.findByLabelText("Move preview");
    const body = callsTo("/suggestion-sets")[0]!.body as { selections: unknown[] };
    expect(body.selections).toEqual([{ kind: "exact", anchor: goalAnchor(), path: [1] }]);
    expect(screen.getByTestId("drag-outcome")).toHaveTextContent("Apply result (result onto");
    expect(callsTo("/commands")).toHaveLength(0);
  });

  it("previews a term dropped on a binder as an instantiation", async () => {
    const pair = [exact(goalAnchor(), [0]), exact(goalAnchor(), [1])];
    serve(() =>
      displayed(pair, [
        { artifactId: "move:instantiate-universal-hypothesis", slots: ["term", "universal"] },
      ]),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    click("Pick up term");
    click("Drop on goal slot");

    await screen.findByLabelText("Move preview");
    expect(screen.getByTestId("drag-outcome")).toHaveTextContent("Instantiate (term onto slot)");
    expect(callsTo("/commands")).toHaveLength(0);
  });

  it("says no move applies and changes nothing when no displayed suggestion fits the drop", async () => {
    const pair = [exact(hypothesisAnchor, []), exact(goalAnchor(), [])];
    // The only displayed suggestion assigns the hypothesis to the target slot: not what was dropped.
    serve(() => displayed(pair, [{ artifactId: "move:odd", slots: ["target", "fact"] }]));
    render(<StoredProofWorkspace session={session} node={node} />);
    click("Pick up hypothesis");
    click("Drop on goal");

    await waitFor(() =>
      expect(screen.getByTestId("drag-outcome")).toHaveTextContent("No move applies here"),
    );
    expect(screen.getByTestId("drag-outcome")).toHaveAttribute("data-outcome", "no-move");
    expect(screen.queryByLabelText("Move preview")).not.toBeInTheDocument();
    expect(callsTo("/move-previews")).toHaveLength(0);
    expect(callsTo("/commands")).toHaveLength(0);
  });

  it("refuses an unsupported drop without asking the service anything", () => {
    serve(() => {
      throw new Error("no request expected");
    });
    render(<StoredProofWorkspace session={session} node={node} />);
    click("Pick up hypothesis");
    click("Drop on hypothesis");
    expect(screen.getByTestId("drag-outcome")).toHaveTextContent(
      "No move applies here: a hypothesis can only be dropped on a goal",
    );
    expect(calls).toHaveLength(0);
  });

  it("offers a keyboard alternative: pick up, select a target, drop on selection", async () => {
    const pair = [exact(hypothesisAnchor, []), exact(goalAnchor(), [])];
    serve(() =>
      displayed(pair, [{ artifactId: "move:close-by-hypothesis", slots: ["fact", "target"] }]),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    const dropOnSelection = screen.getByRole("button", { name: "Drop on selection" });
    expect(dropOnSelection).toBeDisabled();

    click("Pick up hypothesis");
    expect(dropOnSelection).toBeDisabled();
    click("Select goal");
    await waitFor(() => expect(callsTo("/suggestion-sets")).toHaveLength(1));
    // Selecting a target is an ordinary selection: it requests suggestions for it alone.
    expect(callsTo("/suggestion-sets")[0]!.body.selections).toHaveLength(1);
    await waitFor(() => expect(dropOnSelection).toBeEnabled());

    fireEvent.click(dropOnSelection);
    await screen.findByLabelText("Move preview");
    expect(callsTo("/suggestion-sets")).toHaveLength(2);
    expect(callsTo("/suggestion-sets")[1]!.body.selections).toHaveLength(2);
    expect(callsTo("/commands")).toHaveLength(0);
  });

  it("puts a carried item down with Escape", () => {
    serve(() => {
      throw new Error("no request expected");
    });
    render(<StoredProofWorkspace session={session} node={node} />);
    click("Pick up hypothesis");
    expect(screen.getByTestId("carrying")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("carrying")).not.toBeInTheDocument();
    expect(screen.getByTestId("drag-outcome")).toHaveTextContent("Drag cancelled.");
    expect(calls).toHaveLength(0);
  });

  it("abandons a pending drop when the selection changes before suggestions arrive", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const pair = [exact(hypothesisAnchor, []), exact(goalAnchor(), [])];
    serve(async () => {
      await gate;
      return displayed(pair, [
        { artifactId: "move:close-by-hypothesis", slots: ["fact", "target"] },
      ]);
    });
    render(<StoredProofWorkspace session={session} node={node} />);
    click("Pick up hypothesis");
    click("Drop on goal");
    await waitFor(() => expect(callsTo("/suggestion-sets")).toHaveLength(1));
    click("Select goal");
    expect(screen.getByTestId("drag-outcome")).toHaveTextContent("Drop cancelled");
    await act(async () => {
      release();
      await gate;
    });
    expect(callsTo("/move-previews")).toHaveLength(0);
  });

  it("disables drags and the keyboard alternative in a read-only session, saying why", () => {
    serve(() => {
      throw new Error("no request expected");
    });
    render(<StoredProofWorkspace session={{ ...session, readOnly: true }} node={node} />);
    expect(screen.getByTestId("gestures-enabled")).toHaveTextContent("false");
    expect(screen.getByTestId("gesture-help")).toHaveTextContent(
      "This session is read-only (imported artifact)",
    );
    click("Pick up hypothesis");
    click("Select goal");
    expect(screen.queryByTestId("carrying")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Drop on selection" })).toBeDisabled();
    click("Drop on goal");
    expect(screen.queryByTestId("drag-outcome")).not.toBeInTheDocument();
  });
});
