import { describe, expect, it } from "vitest";
import { PROPOSITION_SORT, type PlainMathJson } from "@proof/mathjson-model";
import {
  actorSchema,
  commandIdSchema,
  createProofNodeSchema,
  semanticReplayStepRecordSchema,
  type DisplayedSuggestionSet,
  type ProofNode,
} from "@proof/protocol";
import { createRetrievalIndex, type RetrievalIndex } from "@proof/retrieval";
import { APPROVED_DEFINITIONS } from "./approved-catalog";
import {
  backtrackWithInformation,
  commitSemanticReplay,
  deletePreviousMove,
  derivedMoveRecordIds,
  executeProofCommand,
  initializeProofSession,
  loadCurrentProofSession,
  materializeMoveChoice,
  previewSemanticReplay,
  recordDisplayedSuggestionSet,
  recordMovePreview,
} from "./proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore, key } from "./memory-proof-store.testing";

/**
 * N21 acceptance (design plan §16.4): recorded steps are replayed onto another node by
 * re-matching their semantic plans; the commit creates fresh nodes through ordinary validated
 * commands, and a failing step records nothing.
 */

const human = actorSchema.parse({ kind: "human", id: "actor:human" });
const SESSION = "session:replay";
const FIXED_TIME = new Date("2026-09-27T12:00:00.000Z");
const ids = (commandId: string) => derivedMoveRecordIds(commandIdSchema.parse(commandId));

function retrievalIndex(): RetrievalIndex {
  const catalog = APPROVED_DEFINITIONS.catalog([]);
  const created = createRetrievalIndex(
    {
      results: catalog.results,
      moves: APPROVED_DEFINITIONS.moves,
      variantFamilies: catalog.variantFamilies,
    },
    { operators: [] },
  );
  if (!created.ok) throw new Error(created.diagnostics[0].message);
  return created.index;
}
const INDEX = retrievalIndex();

const swap = (left: string, right: string): PlainMathJson => [
  "Implies",
  ["And", left, right],
  ["And", right, left],
];

async function session(
  goals: readonly Readonly<{ id: string; conclusion: PlainMathJson }>[],
): Promise<MemoryProofStore> {
  const store = new MemoryProofStore();
  const root = createProofNodeSchema().parse({
    id: "node:root",
    state: {
      id: "state:root",
      goals: goals.map(({ id, conclusion }) => ({
        id,
        sequent: {
          context: {
            declarations: ["p", "q", "r", "s", "u", "v"].map((symbol) => ({
              id: `declaration:${symbol}`,
              symbol,
              sort: PROPOSITION_SORT,
              role: "universal-parameter",
            })),
            hypotheses: [],
          },
          conclusion: { expression: conclusion },
        },
      })),
      obligations: [],
    },
  });
  expect(await initializeProofSession(store, { sessionId: SESSION, rootNode: root })).toMatchObject(
    { status: "committed" },
  );
  return store;
}

type Slot = Readonly<{ target: string; statement?: string }>;

/** Apply a displayed move suggestion the way the HTTP command route does. */
async function applyMove(
  store: MemoryProofStore,
  commandId: string,
  moveId: string,
  slots: readonly Slot[],
): Promise<ProofNode> {
  const current = await loadCurrentProofSession(store, SESSION);
  if (current.status !== "loaded") throw new Error("session");
  const anchors = slots.map((slot) => ({
    kind: "exact",
    anchor: {
      stateId: current.node.state.id,
      target: { kind: "goal", id: slot.target },
      statement:
        slot.statement === undefined
          ? { kind: "conclusion" }
          : { kind: "hypothesis", id: slot.statement },
    },
    path: [],
  }));
  const recorded = await recordDisplayedSuggestionSet(store, INDEX, SESSION, {
    id: `set:${commandId}`,
    selection:
      anchors.length === 1
        ? anchors[0]
        : {
            kind: "selection-query",
            selections: anchors.map((selection, index) => ({
              id: `selection:${index + 1}`,
              selection,
            })),
          },
    options: { limit: 100 },
  });
  if (recorded.status !== "committed") throw new Error(JSON.stringify(recorded));
  const set: DisplayedSuggestionSet = recorded.suggestionSet;
  const chosen = set.suggestions.find(({ artifactId }) => artifactId === moveId);
  if (chosen === undefined) throw new Error(`${moveId} was not displayed`);
  const materialized = await materializeMoveChoice(store, SESSION, {
    commandId,
    suggestionSetId: set.id,
    chosenSuggestionId: chosen.id,
  });
  if (materialized.status !== "materialized") throw new Error(JSON.stringify(materialized));
  const preview = await recordMovePreview(store, SESSION, materialized.request);
  if (preview.status !== "committed") throw new Error(JSON.stringify(preview));
  const own = ids(commandId);
  const executed = await executeProofCommand(
    store,
    SESSION,
    {
      commandId,
      kind: "apply-kernel-operation",
      actor: human,
      parentNodeId: preview.preview.nodeId,
      resultNodeId: own.resultNodeId,
      edgeId: own.edgeId,
      eventId: own.eventId,
      moveId: preview.preview.moveId,
      suggestionSetId: preview.preview.suggestionSetId,
      chosenSuggestionId: preview.preview.chosenSuggestionId,
      previewId: preview.preview.id,
      operation: preview.preview.operation,
    },
    human,
  );
  if (executed.status !== "committed") throw new Error(JSON.stringify(executed));
  return executed.result.prepared.node;
}

/** (p ∧ q) ⇒ (q ∧ p) on `goal`: introduce, expand, split, close the first conjunct. */
async function swapProof(store: MemoryProofStore, goal: string, prefix: string): Promise<void> {
  await applyMove(store, `${prefix}:1`, "move:introduce-implication", [{ target: goal }]);
  await applyMove(store, `${prefix}:2`, "move:expand-hypothesis-conjunction", [
    { target: goal, statement: `statement:${prefix}:1:hypothesis:1` },
  ]);
  await applyMove(store, `${prefix}:3`, "move:split-goal-conjunction", [{ target: goal }]);
  await applyMove(store, `${prefix}:4`, "move:close-by-hypothesis", [
    { target: `statement:${prefix}:3:child:1` },
    {
      target: `statement:${prefix}:3:child:1`,
      statement: `statement:${prefix}:2:expanded-hypothesis:2`,
    },
  ]);
}

function snapshot(store: MemoryProofStore): string {
  return JSON.stringify(
    [
      store.sessions,
      store.nodes,
      store.suggestionSets,
      store.previews,
      store.edges,
      store.events,
      store.commands,
      store.deletions,
      store.interactionEvents,
      store.replaySteps,
    ].map((table) => [...table.entries()]),
  );
}

const SOURCE = { fromNodeId: "node:root", toNodeId: ids("main:4").resultNodeId };

function command(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    commandId: "command:replay",
    actor: human,
    expectedCurrentNodeId: ids("main:4").resultNodeId,
    source: SOURCE,
    ...overrides,
  };
}

function conclusions(node: ProofNode): unknown[] {
  return node.state.goals.map(({ sequent }) => sequent.conclusion.expression);
}

describe("previewSemanticReplay", () => {
  it("reports the adapted sequence onto an alpha-renamed goal without writing", async () => {
    const store = await session([
      { id: "goal:main", conclusion: swap("p", "q") },
      { id: "goal:second", conclusion: swap("r", "s") },
    ]);
    await swapProof(store, "goal:main", "main");
    const before = snapshot(store);
    const previewed = await previewSemanticReplay(
      store,
      SESSION,
      { source: SOURCE, commandId: "command:replay" },
      human,
    );
    expect(snapshot(store)).toBe(before);
    expect(previewed).toMatchObject({
      status: "loaded",
      report: {
        complete: true,
        targetNodeId: ids("main:4").resultNodeId,
        substitutions: [
          { symbol: "p", expression: "r" },
          { symbol: "q", expression: "s" },
        ],
        finalNodeId: "node:command:replay:replay:4",
      },
    });
    if (previewed.status !== "loaded") return;
    expect(
      previewed.report.steps.map(({ status, sourceEdgeId }) => [status, sourceEdgeId]),
    ).toEqual([
      ["adapted", ids("main:1").edgeId],
      ["exact", ids("main:2").edgeId],
      ["exact", ids("main:3").edgeId],
      ["exact", ids("main:4").edgeId],
    ]);
    // `goal:main`'s remaining case `p` stays; `goal:second` now has its remaining case `r`.
    expect(conclusions(previewed.finalNode)).toEqual(["p", "r"]);
  });

  it("rejects a source path that does not descend from its start", async () => {
    const store = await session([{ id: "goal:main", conclusion: swap("p", "q") }]);
    await swapProof(store, "goal:main", "main");
    expect(
      await previewSemanticReplay(
        store,
        SESSION,
        { source: { fromNodeId: ids("main:2").resultNodeId, toNodeId: "node:root" } },
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "replay-rejected" }] });
  });
});

describe("commitSemanticReplay", () => {
  it("creates fresh nodes through validated commands and records each step's plan", async () => {
    const store = await session([
      { id: "goal:main", conclusion: swap("p", "q") },
      { id: "goal:second", conclusion: swap("r", "s") },
      { id: "goal:third", conclusion: swap("u", "v") },
    ]);
    await swapProof(store, "goal:main", "main");
    const sourceRows = JSON.stringify(
      [...store.edges.entries()].concat([...store.commands.entries()] as never[]),
    );
    const committed = await commitSemanticReplay(store, SESSION, command(), human, {
      now: () => FIXED_TIME,
    });
    expect(committed).toMatchObject({
      status: "committed",
      replayed: false,
      session: { currentNodeId: "node:command:replay:replay:4" },
      node: { id: "node:command:replay:replay:4" },
      report: { complete: true },
    });
    if (committed.status !== "committed") return;
    expect(committed.receipts.map(({ commandId }) => commandId)).toEqual([
      "command:replay:replay:1",
      "command:replay:replay:2",
      "command:replay:replay:3",
      "command:replay:replay:4",
    ]);
    expect(conclusions(committed.node)).toEqual(["p", "r", swap("u", "v")]);

    // Ordinary command rows: the edge carries its move but no displayed suggestion.
    const edge = store.edges.get(key(SESSION, "edge:command:replay:replay:1"));
    expect(edge).toMatchObject({
      moveId: "move:introduce-implication",
      parentNodeId: ids("main:4").resultNodeId,
      transitionClass: "equivalence",
    });
    expect(edge?.suggestionSetId).toBeUndefined();
    const record = store.replaySteps.get(key(SESSION, "command:replay:replay:1"));
    expect(semanticReplayStepRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({
      replayCommandId: "command:replay",
      index: 1,
      count: 4,
      nodeId: "node:command:replay:replay:1",
      sourceEdgeId: ids("main:1").edgeId,
      targetNodeId: ids("main:4").resultNodeId,
      plan: { selections: [{ target: { id: "goal:second" }, fragment: swap("r", "s") }] },
      recordedAt: FIXED_TIME.toISOString(),
    });
    // The source branch is untouched.
    expect(
      JSON.stringify(
        [...store.edges.entries()]
          .filter(([, row]) => !row.commandId.startsWith("command:replay"))
          .concat(
            [...store.commands.entries()].filter(
              ([recordKey]) => !recordKey.includes("command:replay"),
            ) as never[],
          ),
      ),
    ).toBe(sourceRows);

    // A retry replays; a different request under the same ID conflicts.
    const retried = await commitSemanticReplay(store, SESSION, command(), human);
    expect(retried).toMatchObject({ status: "committed", replayed: true });
    if (retried.status === "committed") {
      expect(retried.receipts).toEqual(committed.receipts);
      expect(retried.report.steps).toEqual(committed.report.steps);
    }
    expect(
      await commitSemanticReplay(
        store,
        SESSION,
        command({ targetNodeId: ids("main:3").resultNodeId }),
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "replay-conflict" }] });

    // The replayed branch has recorded plans, so it can itself be replayed: onto `goal:third`.
    const again = await commitSemanticReplay(
      store,
      SESSION,
      {
        commandId: "command:again",
        actor: human,
        expectedCurrentNodeId: "node:command:replay:replay:4",
        source: {
          fromNodeId: ids("main:4").resultNodeId,
          toNodeId: "node:command:replay:replay:4",
        },
      },
      human,
    );
    expect(again).toMatchObject({
      status: "committed",
      report: {
        complete: true,
        substitutions: [
          { symbol: "r", expression: "u" },
          { symbol: "s", expression: "v" },
        ],
      },
    });
    if (again.status === "committed") expect(conclusions(again.node)).toEqual(["p", "r", "u"]);
  });

  it("records nothing when a step fails and returns the report with repairs", async () => {
    const store = await session([
      { id: "goal:main", conclusion: swap("p", "q") },
      { id: "goal:other", conclusion: ["Implies", ["And", "r", "s"], ["And", "r", "s"]] },
    ]);
    await swapProof(store, "goal:main", "main");
    const before = snapshot(store);
    const failed = await commitSemanticReplay(store, SESSION, command(), human);
    expect(failed).toMatchObject({
      status: "replay-failed",
      report: {
        complete: false,
        firstFailure: {
          index: 1,
          diagnostic: { code: "no-matching-selection" },
          repairs: [
            {
              slotId: "target",
              candidates: [{ id: "goal:goal:other/conclusion/exact:", match: "shape" }],
            },
          ],
        },
      },
    });
    expect(snapshot(store)).toBe(before);
  });

  it("rejects a stale cursor and a deleted replayed step", async () => {
    const store = await session([
      { id: "goal:main", conclusion: swap("p", "q") },
      { id: "goal:second", conclusion: swap("r", "s") },
    ]);
    await swapProof(store, "goal:main", "main");
    expect(
      await commitSemanticReplay(
        store,
        SESSION,
        command({ expectedCurrentNodeId: "node:root" }),
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "serialized-stale-command" }] });

    expect(await commitSemanticReplay(store, SESSION, command(), human)).toMatchObject({
      status: "committed",
    });
    // Deleting the last replayed step removes its record with it.
    expect(
      await deletePreviousMove(
        store,
        SESSION,
        {
          commandId: "command:delete",
          actor: human,
          expectedCurrentNodeId: "node:command:replay:replay:4",
        },
        human,
      ),
    ).toMatchObject({ status: "committed" });
    expect(store.replaySteps.has(key(SESSION, "command:replay:replay:4"))).toBe(false);
    expect(store.replaySteps.has(key(SESSION, "command:replay:replay:3"))).toBe(true);
    expect(await commitSemanticReplay(store, SESSION, command(), human)).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "command-deleted" }],
    });
  });

  it("reattaches the original branch under the focused case after backtracking (§16.3 step 5)", async () => {
    const store = await session([{ id: "goal:main", conclusion: swap("p", "q") }]);
    await swapProof(store, "goal:main", "main");
    const backtracked = await backtrackWithInformation(
      store,
      SESSION,
      {
        commandId: "command:backtrack",
        actor: human,
        expectedCurrentNodeId: ids("main:4").resultNodeId,
        sourceNodeId: ids("main:4").resultNodeId,
        proposition: "r",
        ancestorNodeId: "node:root",
      },
      human,
    );
    expect(backtracked).toMatchObject({ status: "committed" });
    if (backtracked.status !== "committed") return;
    const focus = backtracked.backtrack.focusTarget;

    const replayed = await commitSemanticReplay(
      store,
      SESSION,
      command({ expectedCurrentNodeId: backtracked.node.id, source: SOURCE, focus }),
      human,
    );
    expect(replayed).toMatchObject({ status: "committed", report: { complete: true } });
    if (replayed.status !== "committed") return;
    expect(replayed.report.steps[0]?.selections[0]?.candidate.target).toEqual(focus);
    // The focused case (assuming r) is worked exactly like the original; the ¬r case is open.
    const goals = replayed.node.state.goals;
    expect(goals.map(({ sequent }) => sequent.conclusion.expression)).toEqual([
      "p",
      swap("p", "q"),
    ]);
    expect(goals[0]?.sequent.context.hypotheses[0]?.statement.expression).toBe("r");

    // The case split has no displayed selections (N45): it replays from its operation, as a
    // backtracking step.
    const overSplit = await previewSemanticReplay(
      store,
      SESSION,
      { source: { fromNodeId: "node:root", toNodeId: backtracked.node.id } },
      human,
    );
    expect(overSplit).toMatchObject({
      status: "loaded",
      report: { complete: true, steps: [{ index: 1, source: "backtrack" }] },
    });
  });
});

describe("replaying backtracking steps (N45)", () => {
  it("replays a split and its auto-close onto a renamed goal, previewing without writing", async () => {
    const store = await session([
      { id: "goal:main", conclusion: swap("p", "q") },
      { id: "goal:second", conclusion: swap("r", "s") },
    ]);
    await swapProof(store, "goal:main", "main");
    // Split the root goal on its own conclusion: the positive case is closed by its hypothesis.
    const backtracked = await backtrackWithInformation(
      store,
      SESSION,
      {
        commandId: "command:bt",
        actor: human,
        expectedCurrentNodeId: ids("main:4").resultNodeId,
        sourceNodeId: ids("main:4").resultNodeId,
        proposition: swap("p", "q"),
        ancestorNodeId: "node:root",
      },
      human,
    );
    expect(backtracked).toMatchObject({ status: "committed" });
    if (backtracked.status !== "committed") return;
    expect(backtracked.backtrack.autoClosedTarget).toBeDefined();
    const source = { fromNodeId: "node:root", toNodeId: backtracked.node.id };
    // Replay onto the branch before the backtracking: only `goal:second` still has the shape.
    const request = { source, targetNodeId: ids("main:4").resultNodeId };

    const before = snapshot(store);
    const previewed = await previewSemanticReplay(store, SESSION, request, human);
    expect(snapshot(store)).toBe(before);
    expect(previewed).toMatchObject({
      status: "loaded",
      report: {
        complete: true,
        substitutions: [
          { symbol: "p", expression: "r" },
          { symbol: "q", expression: "s" },
        ],
      },
    });
    if (previewed.status !== "loaded") return;
    expect(previewed.report.steps.map(({ source: kind, status }) => [kind, status])).toEqual([
      ["backtrack", "adapted"],
      ["backtrack", "exact"],
    ]);

    const committed = await commitSemanticReplay(
      store,
      SESSION,
      {
        commandId: "command:replay-bt",
        actor: human,
        expectedCurrentNodeId: backtracked.node.id,
        ...request,
      },
      human,
      { now: () => FIXED_TIME },
    );
    expect(committed).toMatchObject({ status: "committed", replayed: false });
    if (committed.status !== "committed") return;
    // The second goal's positive case is closed; its negative case remains, assuming ¬P.
    expect(conclusions(committed.node)).toEqual(["p", swap("r", "s")]);
    expect(
      committed.node.state.goals[1]?.sequent.context.hypotheses.map(
        ({ statement }) => statement.expression,
      ),
    ).toEqual([["Not", swap("r", "s")]]);

    // Ordinary validated commands: no move, no suggestion, evidence and a fresh sequence.
    const edges = committed.receipts.map(({ commandId }) => {
      const command = store.commands.get(key(SESSION, commandId));
      return store.edges.get(
        key(SESSION, (command as { prepared: { edge: { id: string } } }).prepared.edge.id),
      );
    });
    expect(edges.map((edge) => edge?.moveId)).toEqual([undefined, undefined]);
    expect(edges.map((edge) => edge?.suggestionSetId)).toEqual([undefined, undefined]);
    const sequences = edges.map((edge) => edge?.sequence);
    expect(sequences.every((sequence) => typeof sequence === "number")).toBe(true);
    expect(sequences[1]).toBe((sequences[0] as number) + 1);
    expect(store.replaySteps.get(key(SESSION, "command:replay-bt:replay:1"))).toMatchObject({
      plan: { source: "operation", origin: "backtrack" },
      report: { source: "backtrack" },
    });

    // A retry replays the recorded commits.
    const retried = await commitSemanticReplay(
      store,
      SESSION,
      {
        commandId: "command:replay-bt",
        actor: human,
        expectedCurrentNodeId: backtracked.node.id,
        ...request,
      },
      human,
    );
    expect(retried).toMatchObject({ status: "committed", replayed: true });
    if (retried.status === "committed") expect(retried.receipts).toEqual(committed.receipts);
  });
});
