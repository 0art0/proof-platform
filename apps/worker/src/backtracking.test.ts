import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROPOSITION_SORT } from "@proof/mathjson-model";
import { actorSchema, commandIdSchema, createProofNodeSchema } from "@proof/protocol";
import {
  analyzeBacktrackWithInformation,
  backtrackEventId,
  backtrackProofSession,
  backtrackWithInformation,
  deletePreviousMove,
  derivedMoveRecordIds,
  executeProofCommand,
  initializeProofSession,
  listInteractionEvents,
  loadProofHistory,
} from "./proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore, key } from "./memory-proof-store.testing";

/**
 * N20 acceptance (design plan §16.3): ancestor choice, unavailable-symbol rejection, and the
 * auto-close case, through the validated command path with the original branch left intact.
 */

const human = actorSchema.parse({ kind: "human", id: "actor:human" });
const SESSION = "session:backtrack";
const FIXED_TIME = new Date("2026-09-27T12:00:00.000Z");
const ids = (commandId: string) => derivedMoveRecordIds(commandIdSchema.parse(commandId));

const declarations = ["p", "q", "r", "s"].map((symbol, index) => ({
  id: `declaration:${index}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
}));

async function apply(
  store: MemoryProofStore,
  commandId: string,
  parent: string,
  operation: Readonly<Record<string, unknown>>,
): Promise<void> {
  const parentIds = parent === "root" ? undefined : ids(parent);
  const own = ids(commandId);
  const result = await executeProofCommand(
    store,
    SESSION,
    {
      commandId,
      kind: "apply-kernel-operation",
      actor: human,
      parentNodeId: parentIds?.resultNodeId ?? "node:root",
      resultNodeId: own.resultNodeId,
      edgeId: own.edgeId,
      eventId: own.eventId,
      operation: {
        ...operation,
        expectedStateId: parentIds?.resultStateId ?? "state:root",
        resultStateId: own.resultStateId,
      },
    },
    human,
  );
  expect(result).toMatchObject({ status: "committed" });
}

/**
 * root ⊢ q ⇒ ∀p. (p ⇒ r)
 *   → intro-q    q ⊢ ∀p. (p ⇒ r)      (p only bound)
 *   → intro-p    q ⊢ p ⇒ r            (p introduced)
 *   → intro-hp   q, p ⊢ r             (the cursor)
 */
async function introductionChain(): Promise<MemoryProofStore> {
  const store = new MemoryProofStore();
  const root = createProofNodeSchema().parse({
    id: "node:root",
    state: {
      id: "state:root",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: { declarations, hypotheses: [] },
            conclusion: {
              expression: ["Implies", "q", ["ForAll", "p", ["Implies", "p", "r"]]],
            },
          },
        },
      ],
      obligations: [],
    },
  });
  expect(await initializeProofSession(store, { sessionId: SESSION, rootNode: root })).toMatchObject(
    { status: "committed" },
  );
  const main = { kind: "goal", id: "goal:main" };
  await apply(store, "command:intro-q", "root", {
    kind: "introduce-implication",
    target: main,
    hypothesisId: "hyp:q",
  });
  await apply(store, "command:intro-p", "command:intro-q", {
    kind: "introduce-universal",
    target: main,
  });
  await apply(store, "command:intro-hp", "command:intro-p", {
    kind: "introduce-implication",
    target: main,
    hypothesisId: "hyp:p",
  });
  return store;
}

const CURSOR = ids("command:intro-hp").resultNodeId;

function backtrackCommand(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    commandId: "command:backtrack",
    actor: human,
    expectedCurrentNodeId: CURSOR,
    sourceNodeId: CURSOR,
    proposition: "s",
    ...overrides,
  };
}

function snapshot(store: MemoryProofStore): string {
  return JSON.stringify(
    [
      store.sessions,
      store.nodes,
      store.edges,
      store.events,
      store.commands,
      store.deletions,
      store.interactionEvents,
    ].map((table) => [...table.entries()]),
  );
}

/** The original branch's rows, which backtracking must never change. */
function originalBranch(store: MemoryProofStore): string {
  const commands = ["command:intro-q", "command:intro-p", "command:intro-hp"];
  return JSON.stringify([
    store.nodes.get(key(SESSION, "node:root")),
    ...commands.flatMap((commandId) => {
      const own = ids(commandId);
      return [
        store.nodes.get(key(SESSION, own.resultNodeId)),
        store.edges.get(key(SESSION, own.edgeId)),
        store.events.get(key(SESSION, own.eventId)),
        store.commands.get(key(SESSION, commandId)),
      ];
    }),
  ]);
}

describe("analyzeBacktrackWithInformation", () => {
  it("lists every ancestor closest first without changing anything", async () => {
    const store = await introductionChain();
    const before = snapshot(store);
    const analyzed = await analyzeBacktrackWithInformation(store, SESSION, {
      sourceNodeId: CURSOR,
      proposition: ["And", "p", "r"],
    });
    expect(analyzed).toMatchObject({
      status: "loaded",
      analysis: {
        freeSymbols: ["p", "r"],
        closestEligibleAncestorNodeId: ids("command:intro-p").resultNodeId,
        ancestors: [
          { nodeId: ids("command:intro-p").resultNodeId, eligible: true },
          { nodeId: ids("command:intro-q").resultNodeId, eligible: false },
          { nodeId: "node:root", eligible: false, unavailableSymbols: ["p"] },
        ],
      },
    });
    expect(snapshot(store)).toBe(before);
  });
});

describe("backtrackWithInformation", () => {
  it("creates a case split under the closest eligible ancestor and leaves the branch intact", async () => {
    const store = await introductionChain();
    const branch = originalBranch(store);
    const result = await backtrackWithInformation(store, SESSION, backtrackCommand(), human, {
      now: () => FIXED_TIME,
    });
    expect(result).toMatchObject({ status: "committed", replayed: false });
    if (result.status !== "committed") return;

    const split = ids("command:backtrack");
    const ancestor = ids("command:intro-p").resultNodeId;
    expect(result.receipts).toEqual([
      {
        commandId: "command:backtrack",
        nodeId: split.resultNodeId,
        edgeId: split.edgeId,
        eventId: split.eventId,
        resultStateId: split.resultStateId,
        transitionClass: "equivalence",
        evidence: "structural",
        sequence: expect.any(Number),
      },
    ]);
    expect(result.session.currentNodeId).toBe(split.resultNodeId);
    expect(result.node.state.goals.map(({ id }) => id)).toEqual([
      "statement:command:backtrack:child:1",
      "statement:command:backtrack:child:2",
    ]);
    expect(result.backtrack).toMatchObject({
      id: backtrackEventId(commandIdSchema.parse("command:backtrack")),
      kind: "backtracked-with-information",
      nodeId: split.resultNodeId,
      sourceNodeId: CURSOR,
      proposition: "s",
      ancestorNodeId: ancestor,
      eligibleAncestorNodeIds: [ancestor, ids("command:intro-q").resultNodeId, "node:root"],
      splitTarget: { kind: "goal", id: "goal:main" },
      caseSplitNodeId: split.resultNodeId,
      focusTarget: { kind: "goal", id: "statement:command:backtrack:child:1" },
      recordedAt: FIXED_TIME.toISOString(),
    });
    expect(result.backtrack.autoClosedTarget).toBeUndefined();
    expect(result.backtrack.requestedAncestorNodeId).toBeUndefined();

    expect(originalBranch(store)).toBe(branch);
    const history = await loadProofHistory(store, SESSION);
    expect(history.status).toBe("loaded");
    if (history.status !== "loaded") return;
    expect(history.nodes).toHaveLength(5);
    expect(history.edges.find(({ edge }) => edge.id === split.edgeId)?.edge).toMatchObject({
      parentNodeId: ancestor,
      childNodeId: split.resultNodeId,
      operation: { kind: "split-classical-cases", proposition: "s" },
      transitionClass: "equivalence",
    });
    // The original leaf is still reachable, and the cursor can return to it.
    expect(
      await backtrackProofSession(store, SESSION, {
        expectedCurrentNodeId: split.resultNodeId,
        targetNodeId: CURSOR,
      }),
    ).toMatchObject({ status: "committed" });
  });

  it("honors a chosen eligible ancestor", async () => {
    const store = await introductionChain();
    const result = await backtrackWithInformation(
      store,
      SESSION,
      backtrackCommand({ proposition: "r", ancestorNodeId: "node:root" }),
      human,
    );
    expect(result).toMatchObject({
      status: "committed",
      backtrack: {
        requestedAncestorNodeId: "node:root",
        ancestorNodeId: "node:root",
        eligibleAncestorNodeIds: [
          ids("command:intro-p").resultNodeId,
          ids("command:intro-q").resultNodeId,
          "node:root",
        ],
      },
    });
    expect(store.edges.get(key(SESSION, ids("command:backtrack").edgeId))).toMatchObject({
      parentNodeId: "node:root",
    });
  });

  it("rejects unavailable symbols without writing anything", async () => {
    const store = await introductionChain();
    const before = snapshot(store);
    const chosen = await backtrackWithInformation(
      store,
      SESSION,
      backtrackCommand({ proposition: ["Or", "p", "s"], ancestorNodeId: "node:root" }),
      human,
    );
    expect(chosen).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "backtrack-symbols-unavailable" }],
    });
    const none = await backtrackWithInformation(
      store,
      SESSION,
      backtrackCommand({ sourceNodeId: ids("command:intro-p").resultNodeId, proposition: "p" }),
      human,
    );
    expect(none).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "backtrack-symbols-unavailable" }],
    });
    const undeclared = await backtrackWithInformation(
      store,
      SESSION,
      backtrackCommand({ proposition: ["And", "s", "t"] }),
      human,
    );
    expect(undeclared).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "backtrack-with-information-rejected" }],
    });
    expect(snapshot(store)).toBe(before);
  });

  it("auto-closes the case whose goal is P and focuses the remaining case", async () => {
    const store = await introductionChain();
    const branch = originalBranch(store);
    const result = await backtrackWithInformation(
      store,
      SESSION,
      backtrackCommand({ proposition: ["Implies", "p", "r"] }),
      human,
    );
    expect(result).toMatchObject({ status: "committed" });
    if (result.status !== "committed") return;
    const split = ids("command:backtrack");
    const close = ids("command:backtrack:auto-close");
    expect(result.receipts.map(({ commandId, nodeId }) => [commandId, nodeId])).toEqual([
      ["command:backtrack", split.resultNodeId],
      ["command:backtrack:auto-close", close.resultNodeId],
    ]);
    expect(store.edges.get(key(SESSION, close.edgeId))).toMatchObject({
      parentNodeId: split.resultNodeId,
      operation: {
        kind: "close-by-hypothesis",
        target: { kind: "goal", id: "statement:command:backtrack:child:1" },
        hypothesisId: "statement:command:backtrack:branch-hypothesis:1",
      },
      transitionClass: "equivalence",
    });
    expect(result.session.currentNodeId).toBe(close.resultNodeId);
    expect(result.node.state.goals.map(({ id }) => id)).toEqual([
      "statement:command:backtrack:child:2",
    ]);
    expect(result.backtrack).toMatchObject({
      nodeId: close.resultNodeId,
      caseSplitNodeId: split.resultNodeId,
      autoClosedTarget: { kind: "goal", id: "statement:command:backtrack:child:1" },
      focusTarget: { kind: "goal", id: "statement:command:backtrack:child:2" },
    });
    expect(originalBranch(store)).toBe(branch);
  });

  it("replays a retry, rejects a conflicting reuse, and rejects a stale cursor", async () => {
    const store = await introductionChain();
    const first = await backtrackWithInformation(store, SESSION, backtrackCommand(), human);
    expect(first).toMatchObject({ status: "committed", replayed: false });
    const after = snapshot(store);

    const retry = await backtrackWithInformation(store, SESSION, backtrackCommand(), human);
    expect(retry).toMatchObject({ status: "committed", replayed: true });
    if (first.status === "committed" && retry.status === "committed") {
      expect(retry.receipts).toEqual(first.receipts);
      expect(retry.backtrack).toEqual(first.backtrack);
      expect(retry.node).toEqual(first.node);
    }
    expect(
      await backtrackWithInformation(store, SESSION, backtrackCommand({ proposition: "r" }), human),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "backtrack-with-information-conflict" }],
    });
    expect(
      await backtrackWithInformation(
        store,
        SESSION,
        backtrackCommand({ commandId: "command:intro-p" }),
        human,
      ),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "backtrack-with-information-conflict" }],
    });
    expect(
      await backtrackWithInformation(
        store,
        SESSION,
        backtrackCommand({ commandId: "command:other" }),
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "serialized-stale-command" }] });
    expect(
      await backtrackWithInformation(
        store,
        SESSION,
        backtrackCommand({ commandId: "command:other" }),
        actorSchema.parse({ kind: "agent", id: "actor:agent" }),
      ),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "backtrack-with-information-rejected" }],
    });
    expect(snapshot(store)).toBe(after);
  });

  it("is removed by deleting its moves, and a retry then reports the deletion", async () => {
    const store = await introductionChain();
    const result = await backtrackWithInformation(
      store,
      SESSION,
      backtrackCommand({ proposition: ["Implies", "p", "r"] }),
      human,
    );
    expect(result).toMatchObject({ status: "committed" });
    const close = ids("command:backtrack:auto-close");
    expect(
      await deletePreviousMove(
        store,
        SESSION,
        { commandId: "command:delete", actor: human, expectedCurrentNodeId: close.resultNodeId },
        human,
      ),
    ).toMatchObject({ status: "committed" });
    expect(await listInteractionEvents(store, SESSION)).toMatchObject({
      status: "loaded",
      events: [],
    });
    expect(
      await backtrackWithInformation(
        store,
        SESSION,
        backtrackCommand({
          proposition: ["Implies", "p", "r"],
          expectedCurrentNodeId: ids("command:backtrack").resultNodeId,
        }),
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "command-deleted" }] });
  });
});

describe("migration 0008", () => {
  it("re-creates the kind check with every earlier kind plus the backtracking kind", () => {
    const sql = (name: string) =>
      readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    const kinds = (text: string) => [...text.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
    const widened = sql("0008_backtrack_interaction_event.sql");
    expect(widened).toContain("DROP CONSTRAINT proof_interaction_events_kind_check");
    expect(kinds(widened)).toEqual([
      ...kinds(sql("0007_interaction_events.sql").split("kind IN (")[1]?.split(")")[0] ?? ""),
      "backtracked-with-information",
    ]);
  });
});
