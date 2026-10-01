// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeBacktrack,
  createProofNodeSchema,
  type ProofEdge,
  type ProofNode,
  type ProtocolCommandEnvelope,
  type SemanticReplayReport,
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
  READ_ONLY_REASON,
  defaultReplayStart,
  deletionImpact,
  replaySteps,
  selectedProposition,
  type HistoryEdge,
} from "./toolbar-actions";
import { exportFileName, exportHref } from "./export-action";
import { WorkspaceToolbar } from "./workspace-toolbar";
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
  vi.unstubAllGlobals();
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

type PreviewBody = Readonly<{
  commandId?: string;
  source: { fromNodeId: string; toNodeId: string };
  targetNodeId?: string;
  overrides?: readonly unknown[];
}>;

const json = (body: unknown) => new Response(JSON.stringify(body));

/** A complete replay report with one exact step per source edge. */
function completeReport(stepCount: number): SemanticReplayReport {
  return {
    targetNodeId: "node:c",
    complete: true,
    steps: Array.from({ length: stepCount }, (_, index) => ({
      index: index + 1,
      sourceEdgeId: `edge:step-${index + 1}`,
      status: "exact",
      selections: [],
      substitutions: [],
      resultSubstitutions: [],
      parameters: [],
      obligations: [],
      alternatives: [],
    })),
    substitutions: [],
    finalNodeId: "node:c",
  } as unknown as SemanticReplayReport;
}

/**
 * Stub the two dry-run proxies. The analysis is the protocol's own over the fixture tree, as the
 * worker would compute it; previews come from `preview` (a complete one-step report by default).
 */
function stubDryRuns(preview: (body: PreviewBody) => unknown = () => completeReport(1)) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.endsWith("/backtrack-analysis")) {
      const analyzed = analyzeBacktrack({
        rootNodeId: root.id,
        nodes,
        edges: edges.map(({ edge }) => edge),
        operators: [],
        request: body,
      });
      return analyzed.ok
        ? json({ ok: true, data: { analysis: analyzed.analysis } })
        : json({
            ok: false,
            error: {
              code: "backtrack-with-information-rejected",
              message: analyzed.diagnostics[0].message,
            },
          });
    }
    if (url.endsWith("/replay-preview")) {
      const report = preview(body as unknown as PreviewBody);
      return report instanceof Response ? report : json({ ok: true, data: { report } });
    }
    throw new Error(`Unexpected request to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const previewBodies = (fetchMock: ReturnType<typeof stubDryRuns>): PreviewBody[] =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/replay-preview"))
    .map(([, init]) => JSON.parse(String(init?.body)) as PreviewBody);

function renderBar(overrides: Partial<ToolbarActionBarProps> = {}) {
  const runCommand = vi.fn<RunToolbarCommand>(async (_action, envelope) => committed(envelope));
  const props: ToolbarActionBarProps = {
    sessionId: "session:test",
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
    expect(button("Mark as sorry (assume)")).toHaveAccessibleDescription(
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
    expect(screen.getByRole("button", { name: "Mark as sorry (assume)" })).toBeEnabled();
  });

  it("marks the selected target sorry through one command envelope", async () => {
    const { runCommand } = renderBar({ selections: [selection(nodeC, conclusion, [1])] });
    fireEvent.click(screen.getByRole("button", { name: "Mark as sorry (assume)" }));
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
    const fetchMock = stubDryRuns();
    const { runCommand } = renderBar({ selections: [selection(nodeC, hypothesisR, [0])] });
    fireEvent.click(screen.getByRole("button", { name: "Backtrack with information…" }));
    const dialog = screen.getByRole("dialog", { name: "Backtrack with information" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Asking the proof service");
    // Plain words: no bare "P", and the selected statement is named as such.
    expect(dialog).toHaveTextContent("the selected statement is true, or it is false");
    expect(dialog).not.toHaveTextContent(/\bP\b/);
    expect(within(dialog).getByTestId("backtrack-proposition")).toHaveTextContent(
      "Selected statement:",
    );
    expect(await within(dialog).findByText("Symbols it mentions: r")).toBeVisible();
    // The analysis is the worker's: one dry-run request for this proposition, no local analysis.
    const analysisCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/session%3Atest/backtrack-analysis"),
    );
    expect(analysisCalls).toHaveLength(1);
    expect(JSON.parse(String(analysisCalls[0]?.[1]?.body))).toMatchObject({
      sourceNodeId: "node:c",
      sourceTarget: { kind: "goal", id: "goal:main" },
      proposition: "r",
    });
    const options = within(dialog).getAllByRole("radio");
    expect(options.map((option) => (option as HTMLInputElement).value)).toEqual([
      "node:b",
      "node:a",
      "node:root",
    ]);
    expect(options[0]).toBeChecked();
    await waitFor(() => expect(options[0]).toHaveFocus());
    expect(options[2]).toBeDisabled();
    expect(dialog.querySelector('[data-ancestor-node-id="node:root"]')).toHaveTextContent(
      "Not yet declared here: r",
    );

    fireEvent.click(options[1]!);
    fireEvent.click(within(dialog).getByRole("button", { name: "Split here" }));
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
    stubDryRuns();
    const { runCommand } = renderBar({ selections: [selection(nodeC, hypothesisR, [0])] });
    runCommand.mockResolvedValueOnce({
      ok: false,
      status: 422,
      code: "backtrack-with-information-rejected",
      message: "The symbol r is unavailable at node:a.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Backtrack with information…" }));
    const dialog = screen.getByRole("dialog", { name: "Backtrack with information" });
    await within(dialog).findAllByRole("radio");
    fireEvent.click(within(dialog).getByRole("button", { name: "Split here" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Backtrack with information rejected (backtrack-with-information-rejected): The symbol r is unavailable at node:a.",
    );
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("says so when the proof service refuses the backtrack analysis", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ok: false,
          error: {
            code: "backtrack-with-information-rejected",
            message: "The source target is not a goal or obligation of the source node.",
          },
        }),
      ),
    );
    renderBar({ selections: [selection(nodeC, hypothesisR, [0])] });
    fireEvent.click(screen.getByRole("button", { name: "Backtrack with information…" }));
    const dialog = screen.getByRole("dialog", { name: "Backtrack with information" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Backtracking is unavailable: The source target is not a goal or obligation of the source node. (backtrack-with-information-rejected)",
    );
    expect(within(dialog).getByRole("button", { name: "Split here" })).toBeDisabled();
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

  it("previews the replay before anything is committed, then commits under the same command", async () => {
    const fetchMock = stubDryRuns();
    const { runCommand } = renderBar({ node: nodeC });
    fireEvent.click(screen.getByRole("button", { name: "Replay a sequence here…" }));
    const dialog = screen.getByRole("dialog", { name: "Replay a sequence here" });
    expect(within(dialog).getByLabelText("Replay the path ending at")).toHaveValue("node:sibling");
    expect(within(dialog).getByLabelText("Starting after")).toHaveValue("node:root");
    const commit = within(dialog).getByRole("button", { name: "Replay 1 step here" });
    // Nothing can be committed until the dry run has answered.
    expect(commit).toBeDisabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Previewing the replay");
    const report = await within(dialog).findByRole("region", { name: "Replay report" });
    expect(report).toHaveTextContent("1 exact, 0 adapted; every step matches here.");
    expect(commit).toBeEnabled();
    expect(runCommand).not.toHaveBeenCalled();

    const previews = previewBodies(fetchMock);
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      source: { fromNodeId: "node:root", toNodeId: "node:sibling" },
      targetNodeId: "node:c",
    });
    const steps = within(dialog).getByRole("region", { name: "Steps to replay" });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Sibling move · equivalence · matched exactly"]);

    fireEvent.click(commit);
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    const envelope = lastEnvelope(runCommand);
    expect(envelope).toMatchObject({
      basis: { nodeId: "node:c" },
      command: {
        kind: "replay",
        source: { fromNodeId: "node:root", toNodeId: "node:sibling" },
        targetNodeId: "node:c",
      },
    });
    // The commit carries the command ID the preview was computed under.
    expect(envelope.commandId).toBe(previews[0]?.commandId);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers repair candidates from the preview and commits them as overrides of the same command", async () => {
    const failed = {
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
    const fetchMock = stubDryRuns((body) =>
      body.overrides === undefined ? failed : completeReport(1),
    );
    const { runCommand } = renderBar({ node: nodeC });
    fireEvent.click(screen.getByRole("button", { name: "Replay a sequence here…" }));
    const dialog = screen.getByRole("dialog", { name: "Replay a sequence here" });

    const reportView = await within(dialog).findByRole("region", { name: "Replay report" });
    expect(reportView).toHaveTextContent(
      "First failure: step 1 — No occurrence matches the target slot.",
    );
    const steps = within(dialog).getByRole("region", { name: "Steps to replay" });
    expect(within(steps).getByText(/failed/)).toBeVisible();
    // A failed preview cannot be committed, and committing was never attempted.
    expect(within(dialog).getByRole("button", { name: "Replay 1 step here" })).toBeDisabled();
    expect(runCommand).not.toHaveBeenCalled();

    const again = within(dialog).getByRole("button", { name: "Preview with the chosen repairs" });
    expect(again).toBeDisabled();
    fireEvent.click(
      within(reportView).getByRole("radio", { name: /And\(q, p\) in goal goal:main/ }),
    );
    fireEvent.click(again);
    await waitFor(() => expect(previewBodies(fetchMock)).toHaveLength(2));
    const [first, second] = previewBodies(fetchMock);
    // The repaired preview keeps the command ID the candidates were named under.
    expect(second?.commandId).toBe(first?.commandId);
    expect(second?.overrides).toEqual([
      { stepIndex: 1, slotId: "target", candidateId: "candidate:one" },
    ]);

    const commit = within(dialog).getByRole("button", { name: "Replay 1 step here" });
    await waitFor(() => expect(commit).toBeEnabled());
    expect(runCommand).not.toHaveBeenCalled();
    fireEvent.click(commit);
    await waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    const envelope = lastEnvelope(runCommand);
    expect(envelope.commandId).toBe(first?.commandId);
    expect(envelope.command).toMatchObject({
      overrides: [{ stepIndex: 1, slotId: "target", candidateId: "candidate:one" }],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("replaces the preview with the worker's report when the commit finds a step that no longer matches", async () => {
    stubDryRuns();
    const { runCommand } = renderBar({ node: nodeC });
    const stale = {
      ...completeReport(1),
      complete: false,
      steps: [
        {
          ...completeReport(1).steps[0],
          status: "failed",
          diagnostic: { code: "command-rejected", message: "The state changed." },
        },
      ],
      firstFailure: {
        index: 1,
        diagnostic: { code: "command-rejected", message: "The state changed." },
        repairs: [],
      },
    };
    runCommand.mockResolvedValueOnce({
      ok: false,
      status: 422,
      code: "replay-failed",
      message: "The state changed.",
      replayReport: stale as never,
    });
    fireEvent.click(screen.getByRole("button", { name: "Replay a sequence here…" }));
    const dialog = screen.getByRole("dialog", { name: "Replay a sequence here" });
    const commit = within(dialog).getByRole("button", { name: "Replay 1 step here" });
    await waitFor(() => expect(commit).toBeEnabled());
    fireEvent.click(commit);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Replay rejected (replay-failed): The state changed.",
    );
    expect(within(dialog).getByRole("region", { name: "Replay report" })).toHaveTextContent(
      "First failure: step 1 — The state changed.",
    );
    expect(commit).toBeDisabled();
  });

  it("reports a replay preview the proof service could not compute", async () => {
    stubDryRuns(() =>
      json({
        ok: false,
        error: { code: "replay-rejected", message: "The source path is unknown." },
      }),
    );
    renderBar({ node: nodeC });
    fireEvent.click(screen.getByRole("button", { name: "Replay a sequence here…" }));
    const dialog = screen.getByRole("dialog", { name: "Replay a sequence here" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The replay could not be previewed: The source path is unknown. (replay-rejected)",
    );
    expect(within(dialog).getByRole("button", { name: "Replay 1 step here" })).toBeDisabled();
  });

  it("changes the replay source and its steps together, previewing each source", async () => {
    const fetchMock = stubDryRuns((body) =>
      completeReport(body.source.fromNodeId === "node:a" ? 2 : 3),
    );
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
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Replay 2 steps here" })).toBeEnabled(),
    );
    const last = previewBodies(fetchMock).at(-1);
    expect(last).toMatchObject({ source: { fromNodeId: "node:a", toNodeId: "node:c" } });
  });
});

describe("a read-only imported session", () => {
  it("disables every mutating action with the read-only reason", () => {
    renderBar({
      readOnly: true,
      selections: [selection(nodeC, conclusion, [1])],
    });
    for (const name of [
      "Delete previous move…",
      "Backtrack with information…",
      "Replay a sequence here…",
      "Mark as sorry (assume)",
      "Case split on selection",
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button, name).toBeDisabled();
      expect(button, name).toHaveAccessibleDescription(READ_ONLY_REASON);
    }
    expect(READ_ONLY_REASON).toBe("This session is read-only (imported artifact)");
  });

  it("leaves the actions alone for a writable session", () => {
    renderBar({ readOnly: false, selections: [selection(nodeC, conclusion, [1])] });
    expect(screen.getByRole("button", { name: "Mark as sorry (assume)" })).toBeEnabled();
  });
});

describe("WorkspaceToolbar export and tree", () => {
  it("offers the export action and links the tree viewer", () => {
    render(
      <WorkspaceToolbar
        view="formal"
        onViewChange={() => undefined}
        sessionId="session:test"
        node={root}
      />,
    );
    expect(screen.getByRole("button", { name: "Export proof" })).toBeEnabled();
    expect(exportHref("session:a b")).toBe("/api/proof-sessions/session%3Aa%20b/export");
    expect(exportHref("session:a b", true)).toBe(
      "/api/proof-sessions/session%3Aa%20b/export?confirmPrivateExport=true",
    );
    expect(exportFileName("session:x/y")).toBe("session-x-y.proof.json");
    const tree = screen.getByRole("link", { name: "Open full discovery tree" });
    expect(tree).toHaveAttribute("href", "/sessions/session%3Atest/tree");
  });
});

describe("toolbar guidance", () => {
  it("shows a disabled action's reason as a tooltip and keeps it visible for a writable session", () => {
    renderBar({ node: root, history: { kind: "ready", nodes, edges } });
    const del = screen.getByRole("button", { name: "Delete previous move…" });
    expect(del.closest("span")).toHaveAttribute("title", "The root node has no previous move.");
    expect(screen.getByText("The root node has no previous move.")).toBeVisible();
    expect(screen.queryByTestId("toolbar-read-only-note")).toBeNull();
  });

  it("describes an available action in plain words", () => {
    renderBar({ selections: [selection(nodeC, conclusion, [1])] });
    expect(
      screen.getByRole("button", { name: "Mark as sorry (assume)" }),
    ).toHaveAccessibleDescription(
      "Assume the selected claim without proving it; it stays flagged as a sorry.",
    );
  });

  it("states a read-only session once, not once per action", () => {
    renderBar({ readOnly: true, selections: [selection(nodeC, conclusion, [1])] });
    expect(screen.getByTestId("toolbar-read-only-note")).toBeVisible();
    const reasons = screen.getAllByText(READ_ONLY_REASON);
    expect(reasons).toHaveLength(5);
    for (const reason of reasons) expect(reason).toHaveClass("visually-hidden");
  });
});
