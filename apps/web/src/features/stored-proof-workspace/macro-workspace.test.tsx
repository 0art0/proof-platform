// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  type ProofNode,
} from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import { StoredProofWorkspace } from "./stored-proof-workspace";

/** Multi-step macros in the workspace (roadmap N35): cards, per-step preview, history, deletion. */

vi.mock("../proof-workspace", () => ({
  ProofWorkspace: ({
    node,
    onSelectionChange,
  }: {
    node: ProofNode;
    onSelectionChange: (selections: readonly AnchoredProofSelection[]) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onSelectionChange([
          {
            kind: "exact",
            anchor: {
              stateId: node.state.id,
              target: { kind: "goal", id: node.state.goals[0]!.id },
              statement: { kind: "conclusion" },
            },
            path: [],
          },
        ])
      }
    >
      Select goal
    </button>
  ),
}));

const MACRO_ID = "authored:intro-twice";

function makeNode(id: string, goals: number): ProofNode {
  return createProofNodeSchema().parse({
    id,
    state: {
      id: id.replace("node:", "state:"),
      goals: Array.from({ length: goals }, () => ({
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
            ],
            hypotheses: [],
          },
          conclusion: { expression: "p" },
        },
      })),
      obligations: [],
    },
  });
}

const root = makeNode("node:root", 1);
const middle = makeNode("node:middle", 1);
const last = makeNode("node:last", 0);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function operation(from: ProofNode, to: ProofNode) {
  return {
    kind: "close-true",
    expectedStateId: from.state.id,
    resultStateId: to.state.id,
    target: { kind: "goal", id: "goal:test" },
  };
}

function macroEdge(from: ProofNode, to: ProofNode, stepIndex: number) {
  return {
    id: `edge:${to.id.replace("node:", "")}`,
    commandId: `command:apply:macro:${stepIndex}`,
    parentNodeId: from.id,
    childNodeId: to.id,
    moveId: "move:introduce-implication",
    operation: operation(from, to),
    transitionClass: "equivalence",
    macro: {
      moveId: MACRO_ID,
      previewId: "preview:macro",
      stepIndex,
      stepCount: 2,
      stepId: `step-${stepIndex}`,
    },
  };
}

const authoredMoves = {
  ok: true,
  data: {
    sessionId: "session:test",
    moves: [
      {
        moveId: MACRO_ID,
        name: "Introduce two implications",
        retrievable: true,
        revisions: [
          {
            draftArtifactId: "artifact:draft",
            revision: 1,
            authorId: "actor:human-1",
            status: "approved",
            definitionDigest: "digest",
            template: { plan: { kind: "deterministic-plan", steps: [{}, {}] } },
          },
        ],
      },
    ],
  },
};

function sessionAt(current: ProofNode) {
  return { id: "session:test", rootNodeId: root.id, currentNodeId: current.id, operators: [] };
}

function macroSuggestionSet() {
  return displayedSuggestionSetSchema.parse({
    id: "suggestion-set:macro",
    nodeId: root.id,
    stateId: root.state.id,
    selection: {
      kind: "exact",
      anchor: {
        stateId: root.state.id,
        target: { kind: "goal", id: "goal:test" },
        statement: { kind: "conclusion" },
      },
      path: [],
      fragment: "p",
      declarations: root.state.goals[0]?.sequent.context.declarations ?? [],
      position: { polarity: "positive", role: "proposition" },
    },
    suggestions: [
      {
        id: "suggestion:macro",
        source: "move",
        artifactId: MACRO_ID,
        patternId: "move-pattern:intro-twice",
        name: "Introduce two implications",
        exactRepresentationMatch: true,
        substitutions: [],
        rank: [0],
        reasons: ["The goal has two nested antecedents."],
        selectionMatches: [
          {
            selectionId: "selection:primary",
            patternId: "move-pattern:intro-twice",
            selectionSlotId: "target",
          },
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

function macroPreview(commandId: string) {
  return {
    id: `preview:${commandId}`,
    nodeId: root.id,
    stateId: root.state.id,
    suggestionSetId: "suggestion-set:macro",
    chosenSuggestionId: "suggestion:macro",
    moveId: MACRO_ID,
    operation: operation(root, middle),
    transitionClass: "equivalence",
    beforeState: root.state,
    afterState: last.state,
    delta: {
      goals: { added: [], removed: ["goal:test"], updated: [] },
      obligations: { added: [], removed: [], updated: [] },
    },
    macro: {
      steps: [
        {
          index: 1,
          id: "step-1",
          moveId: "move:introduce-implication",
          operation: operation(root, middle),
          transitionClass: "equivalence",
          delta: {
            goals: { added: [], removed: [], updated: ["goal:test"] },
            obligations: { added: [], removed: [], updated: [] },
          },
        },
        {
          index: 2,
          id: "step-2",
          moveId: "move:introduce-implication",
          operation: operation(middle, last),
          transitionClass: "equivalence",
          delta: {
            goals: { added: [], removed: ["goal:test"], updated: [] },
            obligations: { added: [], removed: [], updated: [] },
          },
        },
      ],
    },
  };
}

type Handler = (url: string, init: RequestInit | undefined) => Response | undefined;

function stubFetch(handler: Handler = () => undefined, current: ProofNode = root) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = handler(url, init);
    if (custom !== undefined) return custom;
    if (url.endsWith("/history")) {
      return json({
        ok: true,
        data: {
          session: sessionAt(current),
          nodes: current === last ? [root, middle, last] : [root],
          edges:
            current === last
              ? [
                  { edge: macroEdge(root, middle, 1), name: "move:introduce-implication" },
                  { edge: macroEdge(middle, last, 2), name: "move:introduce-implication" },
                ]
              : [],
        },
      });
    }
    if (url.endsWith("/authored-moves")) return json(authoredMoves);
    if (url.includes("/inquiry-records")) return json({ ok: true, data: { records: [] } });
    if (url.endsWith("/interaction-events")) return json({ ok: true, data: {} }, 201);
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function showMacroCard() {
  fireEvent.click(screen.getByRole("button", { name: "Select goal" }));
  return (await screen.findByRole("heading", { name: "Introduce two implications" })).closest(
    "li",
  ) as HTMLElement;
}

const suggestionResponse = () =>
  json({
    ok: true,
    data: {
      suggestionSet: macroSuggestionSet(),
      replayed: false,
      transitionClasses: [{ suggestionId: "suggestion:macro", transitionClass: "equivalence" }],
    },
  });

describe("multi-step macros in the workspace", () => {
  it("labels a macro suggestion an N-step move with its composed class, then previews each step", async () => {
    let applied = 0;
    stubFetch((url, init) => {
      if (url.endsWith("/suggestion-sets")) return suggestionResponse();
      if (url.endsWith("/move-previews")) {
        const body = JSON.parse(String(init?.body)) as { commandId: string };
        return json(
          { ok: true, data: { preview: macroPreview(body.commandId), replayed: false } },
          201,
        );
      }
      if (url.endsWith("/commands")) {
        applied += 1;
        return undefined;
      }
      return undefined;
    });
    render(<StoredProofWorkspace session={sessionAt(root)} node={root} />);
    const card = await showMacroCard();

    // Before any preview the step count comes from the approved template.
    await waitFor(() => expect(within(card).getByText("2-step move")).toBeVisible());
    expect(card).toHaveTextContent("Applies 2 steps in a row; as a whole it is an equivalence.");

    fireEvent.click(within(card).getByRole("button", { name: "Preview changes" }));
    const steps = await within(card).findByRole("list", { name: "Steps of this move" });
    const items = within(steps).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Step 1 of 2: Introduce implication");
    expect(items[1]).toHaveTextContent("Step 2 of 2: Introduce implication");
    // The first step is open; later steps stay collapsed until asked for.
    expect(items[0]!.querySelector("details")).toHaveProperty("open", true);
    expect(items[1]!.querySelector("details")).toHaveProperty("open", false);
    expect(within(items[0]!).getByTestId("macro-step-difference")).toHaveTextContent(
      "goals: 1 changed; no obligations changes.",
    );
    expect(within(items[1]!).getByTestId("macro-step-difference")).toHaveTextContent(
      "goals: 1 closed",
    );
    expect(applied).toBe(0);
  });

  it("reports an applied macro by name, step count and composed class, not by a raw ID", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/suggestion-sets")) return suggestionResponse();
      const body = JSON.parse(String(init?.body ?? "{}")) as { commandId: string };
      if (url.endsWith("/move-previews")) {
        return json(
          { ok: true, data: { preview: macroPreview(body.commandId), replayed: false } },
          201,
        );
      }
      if (url.endsWith("/commands")) {
        return json(
          {
            ok: true,
            data: {
              session: sessionAt(last),
              node: last,
              // The receipt is that of the macro's last step.
              receipt: {
                commandId: `${body.commandId}:macro:2`,
                nodeId: last.id,
                edgeId: `edge:${body.commandId}:macro:2`,
                eventId: `event:${body.commandId}:macro:2`,
                resultStateId: last.state.id,
                transitionClass: "equivalence",
              },
              replayed: false,
            },
          },
          201,
        );
      }
      return undefined;
    });
    render(<StoredProofWorkspace session={sessionAt(root)} node={root} />);
    const card = await showMacroCard();
    fireEvent.click(within(card).getByRole("button", { name: "Preview changes" }));
    await within(card).findByRole("list", { name: "Steps of this move" });
    fireEvent.click(within(card).getByRole("button", { name: "Apply this step" }));
    expect(
      await screen.findByText(
        "Applied “Introduce two implications” (2 steps in a row); advanced to node:last (equivalence).",
      ),
    ).toBeVisible();
  });

  it("says which step failed and that nothing changed when the proof service refuses a step", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/suggestion-sets")) return suggestionResponse();
      if (url.endsWith("/move-previews")) {
        const body = JSON.parse(String(init?.body)) as { commandId: string };
        return json(
          { ok: true, data: { preview: macroPreview(body.commandId), replayed: false } },
          201,
        );
      }
      if (url.endsWith("/commands")) {
        return json(
          {
            ok: false,
            error: {
              code: "macro-step-failed",
              message: "Macro step 2 of 2 was rejected: the pattern no longer matches.",
            },
          },
          422,
        );
      }
      return undefined;
    });
    render(<StoredProofWorkspace session={sessionAt(root)} node={root} />);
    const card = await showMacroCard();
    fireEvent.click(within(card).getByRole("button", { name: "Preview changes" }));
    await within(card).findByRole("list", { name: "Steps of this move" });
    fireEvent.click(within(card).getByRole("button", { name: "Apply this step" }));
    const notice = await screen.findByText(/Apply rejected/);
    expect(notice).toHaveTextContent(
      "This multi-step move stopped at step 2 of 2: the pattern no longer matches. None of its steps were applied, so the proof is unchanged.",
    );
  });

  it("groups the steps of an applied macro in the history under one labelled application", async () => {
    stubFetch(undefined, last);
    render(<StoredProofWorkspace session={sessionAt(last)} node={last} />);
    const history = screen.getByRole("region", { name: "Proof-discovery tree" });
    const header = await within(history).findByText("Macro: Introduce two implications");
    expect(header.closest("li")).toHaveAttribute("data-macro-application", "preview:macro");
    expect(header.closest("li")).toHaveTextContent("2 steps applied as one move");
    await waitFor(() => {
      const buttons = within(history).getAllByRole("button");
      expect(buttons[1]).toHaveTextContent(
        "Macro Introduce two implications, step 1 of 2 · Introduce implication · equivalence",
      );
      expect(buttons[2]).toHaveTextContent(
        "Macro Introduce two implications, step 2 of 2 · Introduce implication · equivalence",
      );
    });
    // The branch breadcrumb names the macro's steps in words too.
    const branch = screen.getByRole("navigation", { name: "Current branch" });
    expect(
      within(branch)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Root",
      "Introduce implication (step 1 of 2)",
      "Introduce implication (step 2 of 2)",
    ]);
    // Only the first step carries the group header.
    expect(history.querySelectorAll("[data-macro-application]")).toHaveLength(1);
  });

  it("tells the user that deleting the last step of a macro removes the whole application", async () => {
    stubFetch(undefined, last);
    render(<StoredProofWorkspace session={sessionAt(last)} node={last} />);
    await within(screen.getByRole("region", { name: "Proof-discovery tree" })).findByText(
      "Macro: Introduce two implications",
    );
    fireEvent.click(screen.getByText("More proof actions"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete previous move…" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("delete-macro-note")).toHaveTextContent(
      "last step of the macro “Introduce two implications”, which was applied as 2 steps in a row. Deleting it removes the whole macro application, all 2 steps, and returns to node node:root",
    );
    // The earlier macro step is not a descendant: no extra confirmation is asked for.
    expect(within(dialog).getByTestId("deletion-impact")).toHaveTextContent("2 nodes");
    expect(within(dialog).getByTestId("deletion-impact")).toHaveTextContent("0 descendant nodes");
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });
});
