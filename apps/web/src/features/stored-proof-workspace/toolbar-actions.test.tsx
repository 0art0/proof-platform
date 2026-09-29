// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProofNodeSchema,
  type ProofEdge,
  type ProofNode,
  type ProtocolCommandEnvelope,
} from "@proof/protocol";
import { createPresentation } from "@proof/language";
import { proofStateIdSchema, statementIdSchema } from "@proof/mathjson-model";
import type { AnchoredProofSelection } from "@proof/selections";
import {
  ToolbarActionBar,
  type RunToolbarCommand,
  type ToolbarActionBarProps,
} from "./toolbar-action-bar";
import {
  defaultReplayStart,
  deletionImpact,
  replaySteps,
  selectedProposition,
  type HistoryEdge,
} from "./toolbar-actions";
import { WorkspaceToolbar, exportFileName, exportHref } from "./workspace-toolbar";
import type { ProtocolCommandOutcome } from "./toolbar-requests";

const declaration = (symbol: string) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: { kind: "proposition" },
  role: "universal-parameter",
});

/** A node whose one goal `goal:main` has `q` to prove from `p`, plus `r` from `withR` on. */
function makeNode(id: string, withR: boolean): ProofNode {
  return createProofNodeSchema().parse({
    id,
    state: {
      id: id.replace("node:", "state:"),
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: (withR ? ["p", "q", "r"] : ["p", "q"]).map(declaration),
              hypotheses: [
                { id: "hypothesis:p", statement: { expression: "p" } },
                ...(withR
                  ? [{ id: "hypothesis:r", statement: { expression: ["Or", "r", "q"] } }]
                  : []),
              ],
            },
            conclusion: { expression: ["And", "q", "p"] },
          },
        },
      ],
      obligations: [],
    },
  });
}

const root = makeNode("node:root", false);
const nodeA = makeNode("node:a", true);
const nodeB = makeNode("node:b", true);
const nodeC = makeNode("node:c", true);
const sibling = makeNode("node:sibling", false);
const nodes = [root, nodeA, nodeB, nodeC, sibling];

/** Only the fields the toolbar reads; the stored edges are validated where they are loaded. */
function edge(parent: string, child: string, name: string): HistoryEdge {
  return {
    name,
    edge: {
      id: `edge:${child.replace("node:", "")}`,
      commandId: `command:${child.replace("node:", "")}`,
      parentNodeId: parent,
      childNodeId: child,
      operation: { target: { kind: "goal", id: "goal:main" } },
      transitionClass: "equivalence",
    } as unknown as ProofEdge,
  };
}

const edges = [
  edge("node:root", "node:a", "Introduce r"),
  edge("node:a", "node:b", "Step two"),
  edge("node:b", "node:c", "Step three"),
  edge("node:root", "node:sibling", "Sibling move"),
];

function selection(
  node: ProofNode,
  statement: AnchoredProofSelection["anchor"]["statement"],
  path: number[],
): AnchoredProofSelection {
  return {
    kind: "exact",
    anchor: {
      stateId: node.state.id,
      target: { kind: "goal", id: node.state.goals[0]!.id },
      statement,
    },
    path,
  };
}

const hypothesisR = { kind: "hypothesis", id: statementIdSchema.parse("hypothesis:r") } as const;
const conclusion = { kind: "conclusion" } as const;

const presentation = createPresentation({ operators: [] });

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
});

const committed = (envelope: ProtocolCommandEnvelope): ProtocolCommandOutcome => ({
  ok: true,
  response: {
    commandId: envelope.commandId,
    kind: envelope.command.kind,
    actor: envelope.actor,
    replayed: false,
    cursor: { nodeId: "node:next", stateId: "state:next", eventSequence: 0, inquirySequence: 0 },
    aliases: {
      nodeId: "node:next",
      stateId: "state:next",
      goals: [],
      obligations: [],
      hypotheses: [],
    },
    delta: {
      from: { nodeId: "node:c", stateId: "state:c" },
      to: { nodeId: "node:next", stateId: "state:next" },
      goals: { added: [], removed: [], updated: [] },
      obligations: { added: [], removed: [], updated: [] },
      assumptionsAdded: [],
      assumptionsRemoved: [],
    },
    result: {},
  } as never,
});

function renderBar(overrides: Partial<ToolbarActionBarProps> = {}) {
  const runCommand = vi.fn<RunToolbarCommand>(async (_action, envelope) => committed(envelope));
  const props: ToolbarActionBarProps = {
    node: nodeC,
    rootNodeId: root.id,
    operators: [],
    selections: [],
    history: { kind: "ready", nodes, edges },
    mutationPending: false,
    presentation,
    view: "formal",
    runCommand,
    ...overrides,
  };
  const view = render(<ToolbarActionBar {...props} />);
  return { runCommand, props, ...view };
}

function lastEnvelope(runCommand: ReturnType<typeof renderBar>["runCommand"]) {
  const call = runCommand.mock.calls.at(-1);
  expect(call).toBeDefined();
  return JSON.parse(JSON.stringify(call![1])) as Record<string, unknown>;
}

describe("toolbar action helpers", () => {
  it("names a selected proposition by occurrence and explains unfit selections", () => {
    expect(selectedProposition(nodeC, [], [])).toEqual({
      ok: false,
      reason: "Select an occurrence in a goal or obligation first.",
    });
    const stale = {
      ...selection(nodeC, conclusion, []),
      anchor: {
        ...selection(nodeC, conclusion, []).anchor,
        stateId: proofStateIdSchema.parse("state:old"),
      },
    } as AnchoredProofSelection;
    expect(selectedProposition(nodeC, [stale], [])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("older proof-state snapshot"),
    });
    expect(
      selectedProposition(
        nodeC,
        [selection(nodeC, conclusion, [0]), selection(nodeC, conclusion, [1])],
        [],
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("exactly one") });
    const range: AnchoredProofSelection = {
      kind: "associative",
      anchor: selection(nodeC, conclusion, []).anchor,
      containerPath: [],
      startOperand: 0,
      endOperand: 2,
    };
    expect(selectedProposition(nodeC, [range], [])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not a range"),
    });

    const chosen = selectedProposition(nodeC, [selection(nodeC, hypothesisR, [0])], []);
    expect(chosen).toMatchObject({
      ok: true,
      value: {
        target: { kind: "goal", id: "goal:main" },
        occurrence: {
          nodeId: "node:c",
          target: { kind: "goal", id: "goal:main" },
          statement: "hypothesis:r",
          path: [0],
        },
        expression: "r",
      },
    });
  });

  it("counts the nodes a deletion removes from the stored tree", () => {
    expect(deletionImpact(root.id, root.id, edges)).toEqual({ kind: "root" });
    expect(deletionImpact(root.id, "node:c", edges)).toMatchObject({
      kind: "ready",
      moveName: "Step three",
      parentNodeId: "node:b",
      deletedNodeCount: 1,
      descendantCount: 0,
    });
    expect(deletionImpact(root.id, "node:a", edges)).toMatchObject({
      kind: "ready",
      parentNodeId: "node:root",
      deletedNodeCount: 3,
      descendantCount: 2,
    });
    expect(deletionImpact(root.id, "node:missing", edges)).toMatchObject({ kind: "unavailable" });
  });

  it("lists the steps of a replay source and defaults to a sibling branch's own steps", () => {
    expect(defaultReplayStart(edges, "node:sibling", "node:c")).toBe("node:root");
    expect(defaultReplayStart(edges, "node:a", "node:sibling")).toBe("node:root");
    expect(
      replaySteps(edges, { fromNodeId: "node:root", toNodeId: "node:c" })?.map(({ name }) => name),
    ).toEqual(["Introduce r", "Step two", "Step three"]);
    expect(
      replaySteps(edges, { fromNodeId: "node:a", toNodeId: "node:c" })?.map(({ name }) => name),
    ).toEqual(["Step two", "Step three"]);
    expect(replaySteps(edges, { fromNodeId: "node:sibling", toNodeId: "node:c" })).toBeUndefined();
  });
});

describe("ToolbarActionBar", () => {
  it("keeps every action visible and says why an unfit one is disabled", () => {
    renderBar({ node: root, history: { kind: "ready", nodes, edges } });
    const button = (name: string) => screen.getByRole("button", { name });
    expect(button("Delete previous move…")).toBeDisabled();
    expect(button("Delete previous move…")).toHaveAccessibleDescription(
      "The root node has no previous move.",
    );
    expect(button("Backtrack with information…")).toHaveAccessibleDescription(
      "The root node has no ancestor to backtrack to.",
    );
    expect(button("Mark sorry")).toHaveAccessibleDescription(
      "Select an occurrence in a goal or obligation first.",
    );
    expect(button("Case split on selection")).toBeDisabled();
    expect(button("Replay a sequence here…")).toBeEnabled();
  });

  it("waits for the stored history before offering history-based actions", () => {
    renderBar({ history: { kind: "loading" } });
    for (const name of [
      "Delete previous move…",
      "Backtrack with information…",
      "Replay a sequence here…",
    ]) {
      expect(screen.getByRole("button", { name })).toHaveAccessibleDescription(
        "The stored history is still loading.",
      );
    }
  });

  it("refuses a case split on a term with a reason", () => {
    const termNode = createProofNodeSchema().parse({
      id: "node:term",
      state: {
        id: "state:term",
        goals: [
          {
            id: "goal:main",
            sequent: {
              context: {
                declarations: [
                  {
                    id: "declaration:x",
                    symbol: "x",
                    sort: { kind: "named", id: "sort:real" },
                    role: "universal-parameter",
                  },
                ],
                hypotheses: [],
              },
              conclusion: { expression: ["Greater", "x", 0] },
            },
          },
        ],
        obligations: [],
      },
    });
    renderBar({ node: termNode, selections: [selection(termNode, conclusion, [0])] });
    expect(
      screen.getByRole("button", { name: "Case split on selection" }),
    ).toHaveAccessibleDescription("The selection is a term, not a proposition.");
    expect(screen.getByRole("button", { name: "Mark sorry" })).toBeEnabled();
  });

  it("marks the selected target sorry through one command envelope", async () => {
    const { runCommand } = renderBar({ selections: [selection(nodeC, conclusion, [1])] });
    fireEvent.click(screen.getByRole("button", { name: "Mark sorry" }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    expect(runCommand.mock.calls[0]![0]).toBe("Mark sorry");
    expect(lastEnvelope(runCommand)).toEqual({
      commandId: "command:web-sorry-00000000-0000-4000-8000-000000000001",
      actor: { id: "actor:web", kind: "human" },
      basis: { nodeId: "node:c" },
      command: { kind: "sorry", target: { kind: "goal", id: "goal:main" } },
    });
  });

  it("case-splits on the selected proposition by occurrence, never by typed mathematics", async () => {
    const { runCommand } = renderBar({ selections: [selection(nodeC, hypothesisR, [0])] });
    fireEvent.click(screen.getByRole("button", { name: "Case split on selection" }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    const envelope = lastEnvelope(runCommand);
    expect(envelope).toMatchObject({
      actor: { id: "actor:web", kind: "human" },
      basis: { nodeId: "node:c" },
      command: {
        kind: "case-split",
        target: { kind: "goal", id: "goal:main" },
        proposition: {
          occurrence: {
            nodeId: "node:c",
            target: { kind: "goal", id: "goal:main" },
            statement: "hypothesis:r",
            path: [0],
          },
        },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain('"expression"');
  });

  it("deletes a leaf move after the dialog, without a descendant confirmation", async () => {
    const { runCommand } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Delete previous move…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete previous move" });
    expect(within(dialog).getByTestId("deletion-impact")).toHaveTextContent(
      "Nodes removed1 nodeDescendant nodes0 descendant nodes",
    );
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete move" }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    expect(lastEnvelope(runCommand)).toMatchObject({
      basis: { nodeId: "node:c" },
      command: { kind: "delete-previous-move" },
    });
    expect(lastEnvelope(runCommand).command).not.toHaveProperty("confirmDescendants");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("requires explicit confirmation before deleting a move with descendants", async () => {
    const { runCommand } = renderBar({ node: nodeA });
    fireEvent.click(screen.getByRole("button", { name: "Delete previous move…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete previous move" });
    expect(within(dialog).getByTestId("deletion-impact")).toHaveTextContent("3 nodes");
    expect(within(dialog).getByTestId("deletion-impact")).toHaveTextContent("2 descendant nodes");
    const remove = within(dialog).getByRole("button", { name: "Delete move" });
    expect(remove).toBeDisabled();
    const confirm = within(dialog).getByRole("checkbox", {
      name: "Also delete the 2 descendant nodes below the current node",
    });
    expect(confirm).toHaveFocus();
    fireEvent.click(remove);
    expect(runCommand).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    fireEvent.click(remove);
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    expect(lastEnvelope(runCommand)).toMatchObject({
      basis: { nodeId: "node:a" },
      command: { kind: "delete-previous-move", confirmDescendants: true },
    });
  });

  it("asks for confirmation when the service reports descendants the view had not loaded", async () => {
    const { runCommand } = renderBar();
    runCommand.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "delete-requires-confirmation",
      message: "Deleting this move also deletes 1 descendant node.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete previous move…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete previous move" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete move" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Delete previous move rejected (delete-requires-confirmation): Deleting this move also deletes 1 descendant node.",
    );
    const confirm = within(dialog).getByRole("checkbox");
    expect(within(dialog).getByRole("button", { name: "Delete move" })).toBeDisabled();
    fireEvent.click(confirm);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete move" }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(2));
    expect(lastEnvelope(runCommand)).toMatchObject({
      command: { kind: "delete-previous-move", confirmDescendants: true },
    });
  });

  it("offers eligible ancestors for backtracking, closest first and preselected", async () => {
    const { runCommand } = renderBar({ selections: [selection(nodeC, hypothesisR, [0])] });
    fireEvent.click(screen.getByRole("button", { name: "Backtrack with information…" }));
    const dialog = screen.getByRole("dialog", { name: "Backtrack with information" });
    expect(within(dialog).getByText("Free symbols: r")).toBeVisible();
    const options = within(dialog).getAllByRole("radio");
    expect(options.map((option) => (option as HTMLInputElement).value)).toEqual([
      "node:b",
      "node:a",
      "node:root",
    ]);
    expect(options[0]).toBeChecked();
    expect(options[0]).toHaveFocus();
    expect(options[2]).toBeDisabled();
    expect(dialog.querySelector('[data-ancestor-node-id="node:root"]')).toHaveTextContent(
      "Unavailable symbols: r",
    );

    fireEvent.click(options[1]!);
    fireEvent.click(within(dialog).getByRole("button", { name: "Split on P here" }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    const envelope = lastEnvelope(runCommand);
    expect(envelope).toMatchObject({
      basis: { nodeId: "node:c" },
      command: {
        kind: "backtrack-with-information",
        sourceNodeId: "node:c",
        sourceTarget: { kind: "goal", id: "goal:main" },
        proposition: {
          occurrence: { nodeId: "node:c", statement: "hypothesis:r", path: [0] },
        },
        ancestorNodeId: "node:a",
      },
    });
    expect(JSON.stringify(envelope)).not.toContain('"expression"');
  });

  it("shows a refused backtrack in the dialog and keeps it open", async () => {
    const { runCommand } = renderBar({ selections: [selection(nodeC, hypothesisR, [0])] });
    runCommand.mockResolvedValueOnce({
      ok: false,
      status: 422,
      code: "backtrack-with-information-rejected",
      message: "The symbol r is unavailable at node:a.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Backtrack with information…" }));
    const dialog = screen.getByRole("dialog", { name: "Backtrack with information" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Split on P here" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Backtrack with information rejected (backtrack-with-information-rejected): The symbol r is unavailable at node:a.",
    );
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("closes a dialog on Escape without letting Escape clear the selection", () => {
    const clearSelection = vi.fn((event: KeyboardEvent) => {
      if (!event.defaultPrevented) throw new Error("Escape reached the workspace");
    });
    document.addEventListener("keydown", clearSelection);
    renderBar();
    const opener = screen.getByRole("button", { name: "Delete previous move…" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(clearSelection).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
    document.removeEventListener("keydown", clearSelection);
  });

  it("reviews the replayed steps before committing, then offers repairs for a failed step", async () => {
    const { runCommand } = renderBar({ node: nodeC });
    fireEvent.click(screen.getByRole("button", { name: "Replay a sequence here…" }));
    const dialog = screen.getByRole("dialog", { name: "Replay a sequence here" });
    expect(within(dialog).getByLabelText("Replay the path ending at")).toHaveValue("node:sibling");
    expect(within(dialog).getByLabelText("Starting after")).toHaveValue("node:root");
    const steps = within(dialog).getByRole("region", { name: "Steps to replay" });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Sibling move · equivalence"]);
    expect(runCommand).not.toHaveBeenCalled();

    const report = {
      targetNodeId: "node:c",
      complete: false,
      steps: [
        {
          index: 1,
          sourceEdgeId: "edge:sibling",
          status: "failed",
          selections: [],
          substitutions: [],
          resultSubstitutions: [],
          parameters: [],
          obligations: [],
          alternatives: [],
          diagnostic: {
            code: "no-matching-selection",
            message: "No occurrence matches the target slot.",
          },
        },
      ],
      substitutions: [],
      firstFailure: {
        index: 1,
        diagnostic: {
          code: "no-matching-selection",
          message: "No occurrence matches the target slot.",
        },
        repairs: [
          {
            slotId: "target",
            candidates: [
              {
                id: "candidate:one",
                target: { kind: "goal", id: "goal:main" },
                statement: { role: "conclusion" },
                occurrence: { kind: "exact", path: [] },
                fragment: ["And", "q", "p"],
                match: "shape",
              },
            ],
          },
        ],
      },
      finalNodeId: "node:c",
    };
    runCommand.mockResolvedValueOnce({
      ok: false,
      status: 422,
      code: "replay-failed",
      message: "No occurrence matches the target slot.",
      replayReport: report as never,
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Replay 1 step here" }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    const first = lastEnvelope(runCommand);
    expect(first).toMatchObject({
      basis: { nodeId: "node:c" },
      command: {
        kind: "replay",
        source: { fromNodeId: "node:root", toNodeId: "node:sibling" },
        targetNodeId: "node:c",
      },
    });
    expect(first.command).not.toHaveProperty("overrides");

    const reportView = await within(dialog).findByRole("region", { name: "Replay report" });
    expect(reportView).toHaveTextContent(
      "First failure: step 1 — No occurrence matches the target slot.",
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Replay rejected (replay-failed)");
    expect(within(steps).getByText(/failed/)).toBeVisible();
    const retry = within(dialog).getByRole("button", {
      name: "Replay again with the chosen repairs",
    });
    expect(retry).toBeDisabled();
    fireEvent.click(
      within(reportView).getByRole("radio", { name: /And\(q, p\) in goal goal:main/ }),
    );
    fireEvent.click(retry);
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(2));
    const second = lastEnvelope(runCommand);
    // The retry reuses the command ID the repair candidates were named under.
    expect(second.commandId).toBe(first.commandId);
    expect(second.command).toMatchObject({
      overrides: [{ stepIndex: 1, slotId: "target", candidateId: "candidate:one" }],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("changes the replay source and its steps together", () => {
    renderBar({ node: sibling });
    fireEvent.click(screen.getByRole("button", { name: "Replay a sequence here…" }));
    const dialog = screen.getByRole("dialog", { name: "Replay a sequence here" });
    fireEvent.change(within(dialog).getByLabelText("Replay the path ending at"), {
      target: { value: "node:c" },
    });
    expect(within(dialog).getByLabelText("Starting after")).toHaveValue("node:root");
    fireEvent.change(within(dialog).getByLabelText("Starting after"), {
      target: { value: "node:a" },
    });
    const steps = within(dialog).getByRole("region", { name: "Steps to replay" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
    expect(within(dialog).getByRole("button", { name: "Replay 2 steps here" })).toBeEnabled();
  });
});

describe("WorkspaceToolbar export and tree", () => {
  it("links the export download and shows the tree viewer as not yet available", () => {
    render(
      <WorkspaceToolbar
        view="formal"
        onViewChange={() => undefined}
        sessionId="session:test"
        node={root}
      />,
    );
    const link = screen.getByRole("link", { name: "Export proof" });
    expect(link).toHaveAttribute("href", "/api/proof-sessions/session%3Atest/export");
    expect(link).toHaveAttribute("download", "session-test.proof.json");
    expect(exportHref("session:a b")).toBe("/api/proof-sessions/session%3Aa%20b/export");
    expect(exportFileName("session:x/y")).toBe("session-x-y.proof.json");
    const tree = screen.getByRole("button", { name: "Open full discovery tree" });
    expect(tree).toBeDisabled();
    expect(tree).toHaveAccessibleDescription(/not available yet/);
  });
});
