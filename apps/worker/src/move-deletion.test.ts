import { describe, expect, it } from "vitest";
import { CORE_LOGIC_RESULTS } from "@proof/library";
import { HAND_AUTHORED_MOVES } from "@proof/moves";
import { actorSchema, commandIdSchema, createProofNodeSchema } from "@proof/protocol";
import { createRetrievalIndex, type RetrievalIndex } from "@proof/retrieval";
import {
  backtrackProofSession,
  deletePreviousMove,
  derivedMoveRecordIds,
  executeProofCommand,
  initializeProofSession,
  loadProofHistory,
  materializeMoveChoice,
  proofSessionIdSchema,
  recordDisplayedSuggestionSet,
  recordMovePreview,
} from "./proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore, key } from "./memory-proof-store.testing";

const human = actorSchema.parse({ kind: "human", id: "actor:human" });
const SESSION = "session:one";
const FIXED_TIME = new Date("2026-09-26T12:00:00.000Z");

function retrievalIndex(): RetrievalIndex {
  const created = createRetrievalIndex({
    results: CORE_LOGIC_RESULTS,
    moves: HAND_AUTHORED_MOVES,
    variantFamilies: [],
  });
  if (!created.ok) throw new Error(created.diagnostics[0].message);
  return created.index;
}

const node = (commandId: string) => derivedMoveRecordIds(commandIdSchema.parse(commandId));

/** Display suggestions at the current node, then materialize, preview, and apply one move. */
async function applyMove(
  store: MemoryProofStore,
  commandId: string,
  stateId: string,
  goalId: string,
  moveId: string,
): Promise<ReturnType<typeof applyCommand>> {
  const suggestions = await recordDisplayedSuggestionSet(store, retrievalIndex(), SESSION, {
    id: `suggestion-set:${commandId}`,
    selection: {
      kind: "exact",
      anchor: { stateId, target: { kind: "goal", id: goalId }, statement: { kind: "conclusion" } },
      path: [],
    },
    options: { limit: 100 },
  });
  if (suggestions.status !== "committed") throw new Error(suggestions.diagnostics[0].message);
  const chosen = suggestions.suggestionSet.suggestions.find(
    ({ artifactId }) => artifactId === moveId,
  );
  if (chosen === undefined) throw new Error(`Expected ${moveId} to be displayed.`);
  return applyCommand(store, {
    commandId: commandIdSchema.parse(commandId),
    suggestionSetId: suggestions.suggestionSet.id,
    chosenSuggestionId: chosen.id,
  });
}

async function applyCommand(
  store: MemoryProofStore,
  choice: Readonly<{ commandId: string; suggestionSetId: string; chosenSuggestionId: string }>,
) {
  const materialized = await materializeMoveChoice(store, SESSION, choice);
  if (materialized.status !== "materialized") return materialized;
  const preview = await recordMovePreview(store, SESSION, materialized.request);
  if (preview.status !== "committed") return preview;
  const ids = node(choice.commandId);
  return executeProofCommand(
    store,
    SESSION,
    {
      commandId: choice.commandId,
      kind: "apply-kernel-operation",
      actor: human,
      parentNodeId: preview.preview.nodeId,
      resultNodeId: ids.resultNodeId,
      edgeId: ids.edgeId,
      eventId: ids.eventId,
      moveId: preview.preview.moveId,
      suggestionSetId: preview.preview.suggestionSetId,
      chosenSuggestionId: preview.preview.chosenSuggestionId,
      previewId: preview.preview.id,
      operation: preview.preview.operation,
    },
    human,
  );
}

async function backtrack(store: MemoryProofStore, from: string, to: string): Promise<void> {
  expect(
    await backtrackProofSession(store, SESSION, {
      expectedCurrentNodeId: from,
      targetNodeId: to,
    }),
  ).toMatchObject({ status: "committed" });
}

/**
 * root --a(split)--> A --b(close left)--> B --d(close right)--> D
 *                     \--c(close right)--> C
 * The cursor ends at D, and one extra suggestion set is displayed at D.
 */
async function branchingStore(): Promise<MemoryProofStore> {
  const store = new MemoryProofStore();
  const root = createProofNodeSchema().parse({
    id: "node:root",
    state: {
      id: "state:root",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: { declarations: [], hypotheses: [] },
            conclusion: { expression: ["And", "True", ["And", "True", "True"]] },
          },
        },
      ],
      obligations: [],
    },
  });
  expect(await initializeProofSession(store, { sessionId: SESSION, rootNode: root })).toMatchObject(
    { status: "committed" },
  );
  const left = "statement:command:a:child:1";
  const right = "statement:command:a:child:2";
  expect(
    await applyMove(store, "command:a", "state:root", "goal:main", "move:split-goal-conjunction"),
  ).toMatchObject({ status: "committed" });
  expect(
    await applyMove(store, "command:b", "state:command:a", left, "move:close-true"),
  ).toMatchObject({ status: "committed" });
  await backtrack(store, node("command:b").resultNodeId, node("command:a").resultNodeId);
  expect(
    await applyMove(store, "command:c", "state:command:a", right, "move:split-goal-conjunction"),
  ).toMatchObject({ status: "committed" });
  await backtrack(store, node("command:c").resultNodeId, node("command:b").resultNodeId);
  expect(
    await applyMove(store, "command:d", "state:command:b", right, "move:split-goal-conjunction"),
  ).toMatchObject({ status: "committed" });
  expect(
    await recordDisplayedSuggestionSet(store, retrievalIndex(), SESSION, {
      id: "suggestion-set:at-d",
      selection: {
        kind: "exact",
        anchor: {
          stateId: "state:command:d",
          target: { kind: "goal", id: "statement:command:d:child:1" },
          statement: { kind: "conclusion" },
        },
        path: [],
      },
      options: { limit: 10 },
    }),
  ).toMatchObject({ status: "committed" });
  return store;
}

function deleteCommand(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    commandId: "command:delete",
    actor: human,
    expectedCurrentNodeId: node("command:d").resultNodeId,
    ...overrides,
  };
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
    ].map((table) => [...table.entries()]),
  );
}

describe("deletePreviousMove", () => {
  it("deletes a leaf move, its interaction records, and returns the cursor to the parent", async () => {
    const store = await branchingStore();
    const d = node("command:d");
    const b = node("command:b");

    const deleted = await deletePreviousMove(
      store,
      SESSION,
      deleteCommand({ reason: "Clicked the wrong move." }),
      human,
      { now: () => FIXED_TIME },
    );
    expect(deleted).toMatchObject({
      status: "committed",
      replayed: false,
      receipt: {
        deletedNodeIds: [d.resultNodeId],
        deletedEdgeIds: [d.edgeId],
        currentNodeId: b.resultNodeId,
      },
    });
    if (deleted.status !== "committed") return;
    expect(Object.isFrozen(deleted.receipt)).toBe(true);
    expect(deleted.deletion).toMatchObject({
      deletedEventIds: [d.eventId],
      deletedCommandIds: ["command:d"],
      deletedPreviewIds: [d.previewId],
      deletedSuggestionSetIds: ["suggestion-set:at-d"],
      occurredAt: FIXED_TIME.toISOString(),
    });

    expect(store.sessions.get(SESSION)?.currentNodeId).toBe(b.resultNodeId);
    expect(store.nodes.has(key(SESSION, d.resultNodeId))).toBe(false);
    expect(store.edges.has(key(SESSION, d.edgeId))).toBe(false);
    expect(store.events.has(key(SESSION, d.eventId))).toBe(false);
    expect(store.commands.has(key(SESSION, "command:d"))).toBe(false);
    expect(store.previews.has(key(SESSION, d.previewId))).toBe(false);
    expect(store.suggestionSets.has(key(SESSION, "suggestion-set:at-d"))).toBe(false);
    // The menu displayed at the surviving parent stays exactly as displayed.
    expect(store.suggestionSets.has(key(SESSION, "suggestion-set:command:d"))).toBe(true);

    const history = await loadProofHistory(store, SESSION);
    expect(history.status).toBe("loaded");
    if (history.status !== "loaded") return;
    expect(history.session.currentNodeId).toBe(b.resultNodeId);
    expect(history.nodes.map(({ id }) => id)).not.toContain(d.resultNodeId);
    expect(history.edges.map(({ edge }) => edge.id)).not.toContain(d.edgeId);
    expect(history.nodes).toHaveLength(4);
  });

  it("keeps an ID-only tombstone without any deleted snapshot", async () => {
    const store = await branchingStore();
    await deletePreviousMove(store, SESSION, deleteCommand(), human);
    const tombstones = [...store.deletions.values()];
    expect(tombstones).toHaveLength(1);
    const tombstone = tombstones[0];
    expect(tombstone).toMatchObject({
      id: "deletion:command:delete",
      commandId: "command:delete",
      actor: human,
      parentNodeId: node("command:b").resultNodeId,
    });
    expect(Object.keys(tombstone ?? {}).sort()).toEqual(
      [
        "actor",
        "commandId",
        "confirmDescendants",
        "deletedCommandIds",
        "deletedEdgeIds",
        "deletedEventIds",
        "deletedNodeIds",
        "deletedPreviewIds",
        "deletedSuggestionSetIds",
        "expectedCurrentNodeId",
        "id",
        "occurredAt",
        "parentNodeId",
      ].sort(),
    );
    const serialized = JSON.stringify(tombstone);
    for (const fragment of ['"goals"', '"state"', '"True"', '"operation"', '"suggestions"']) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it("rejects deletion at the root", async () => {
    const store = await branchingStore();
    await backtrack(store, node("command:d").resultNodeId, "node:root");
    const before = snapshot(store);
    expect(
      await deletePreviousMove(
        store,
        SESSION,
        deleteCommand({ expectedCurrentNodeId: "node:root" }),
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "delete-rejected" }] });
    expect(snapshot(store)).toBe(before);
  });

  it("requires confirmation, reporting the descendant count, before deleting a subtree", async () => {
    const store = await branchingStore();
    const a = node("command:a");
    await backtrack(store, node("command:d").resultNodeId, a.resultNodeId);
    const before = snapshot(store);
    const refused = await deletePreviousMove(
      store,
      SESSION,
      deleteCommand({ expectedCurrentNodeId: a.resultNodeId }),
      human,
    );
    expect(refused).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "delete-requires-confirmation" }],
    });
    if (refused.status === "committed") return;
    expect(refused.diagnostics[0].message).toContain("3 descendant nodes");
    expect(snapshot(store)).toBe(before);
  });

  it("deletes the confirmed subtree, including every node-anchored record", async () => {
    const store = await branchingStore();
    const a = node("command:a");
    await backtrack(store, node("command:d").resultNodeId, a.resultNodeId);
    const deleted = await deletePreviousMove(
      store,
      SESSION,
      deleteCommand({ expectedCurrentNodeId: a.resultNodeId, confirmDescendants: true }),
      human,
    );
    expect(deleted).toMatchObject({
      status: "committed",
      receipt: {
        deletedNodeIds: ["a", "b", "c", "d"].map((name) => node(`command:${name}`).resultNodeId),
        deletedEdgeIds: ["a", "b", "c", "d"].map((name) => node(`command:${name}`).edgeId),
        currentNodeId: "node:root",
      },
      deletion: {
        confirmDescendants: true,
        deletedCommandIds: ["command:a", "command:b", "command:c", "command:d"],
        deletedPreviewIds: ["a", "b", "c", "d"].map((name) => node(`command:${name}`).previewId),
        deletedSuggestionSetIds: [
          "suggestion-set:at-d",
          "suggestion-set:command:b",
          "suggestion-set:command:c",
          "suggestion-set:command:d",
        ],
      },
    });
    expect(store.nodes.size).toBe(1);
    expect(store.edges.size).toBe(0);
    expect(store.events.size).toBe(0);
    expect(store.commands.size).toBe(0);
    expect(store.previews.size).toBe(0);
    expect([...store.suggestionSets.values()].map(({ id }) => id)).toEqual([
      "suggestion-set:command:a",
    ]);
    expect(await loadProofHistory(store, SESSION)).toMatchObject({
      status: "loaded",
      session: { currentNodeId: "node:root" },
      nodes: [{ id: "node:root" }],
      edges: [],
    });
  });

  it("replays an identical retry with the same receipt and rejects a changed reuse", async () => {
    const store = await branchingStore();
    const first = await deletePreviousMove(store, SESSION, deleteCommand(), human);
    expect(first).toMatchObject({ status: "committed", replayed: false });
    const afterFirst = snapshot(store);

    const retry = await deletePreviousMove(store, SESSION, deleteCommand(), human);
    expect(retry).toMatchObject({ status: "committed", replayed: true });
    if (first.status !== "committed" || retry.status !== "committed") return;
    expect(retry.receipt).toEqual(first.receipt);
    expect(snapshot(store)).toBe(afterFirst);

    expect(
      await deletePreviousMove(store, SESSION, deleteCommand({ reason: "Different." }), human),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "delete-rejected" }] });
    expect(snapshot(store)).toBe(afterFirst);
  });

  it("rejects a stale expected current node without writes", async () => {
    const store = await branchingStore();
    const before = snapshot(store);
    expect(
      await deletePreviousMove(
        store,
        SESSION,
        deleteCommand({ expectedCurrentNodeId: node("command:b").resultNodeId }),
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "serialized-stale-delete" }] });
    expect(snapshot(store)).toBe(before);
  });

  it("rejects actor mismatches and command IDs already used by an apply command", async () => {
    const store = await branchingStore();
    const agent = actorSchema.parse({ kind: "agent", id: "actor:agent" });
    expect(await deletePreviousMove(store, SESSION, deleteCommand(), agent)).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "delete-rejected" }],
    });
    expect(
      await deletePreviousMove(store, SESSION, deleteCommand({ commandId: "command:b" }), human),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "delete-rejected" }] });
    expect(store.deletions.size).toBe(0);
  });

  it("never replays or re-materializes a deleted command, but accepts a new command ID", async () => {
    const store = await branchingStore();
    const d = node("command:d");
    const deletedChoice = {
      commandId: "command:d",
      suggestionSetId: "suggestion-set:command:d",
      chosenSuggestionId: [...store.edges.values()].find(({ id }) => id === d.edgeId)
        ?.chosenSuggestionId,
    };
    expect(await deletePreviousMove(store, SESSION, deleteCommand(), human)).toMatchObject({
      status: "committed",
    });
    const afterDelete = snapshot(store);

    expect(await materializeMoveChoice(store, SESSION, deletedChoice)).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "command-deleted" }],
    });
    const retriedCommand = {
      commandId: "command:d",
      kind: "apply-kernel-operation",
      actor: human,
      parentNodeId: node("command:b").resultNodeId,
      resultNodeId: d.resultNodeId,
      edgeId: d.edgeId,
      eventId: d.eventId,
      operation: {
        kind: "split-goal-conjunction",
        expectedStateId: "state:command:b",
        resultStateId: "state:command:d",
        target: { kind: "goal", id: "statement:command:a:child:2" },
        childIds: ["statement:command:d:child:1", "statement:command:d:child:2"],
      },
    };
    expect(await executeProofCommand(store, SESSION, retriedCommand, human)).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "command-deleted" }],
    });
    expect(
      await executeProofCommand(
        store,
        SESSION,
        { ...retriedCommand, commandId: "command:delete" },
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "command-deleted" }] });
    expect(snapshot(store)).toBe(afterDelete);

    const reapplied = await applyCommand(store, {
      ...deletedChoice,
      commandId: "command:d-again",
      chosenSuggestionId: deletedChoice.chosenSuggestionId ?? "",
    });
    expect(reapplied).toMatchObject({ status: "committed", replayed: false });
    expect(store.sessions.get(SESSION)?.currentNodeId).toBe(node("command:d-again").resultNodeId);
  });

  it("deletes successive moves, keeping one tombstone per deletion", async () => {
    const store = await branchingStore();
    expect(await deletePreviousMove(store, SESSION, deleteCommand(), human)).toMatchObject({
      status: "committed",
    });
    expect(
      await deletePreviousMove(
        store,
        SESSION,
        deleteCommand({
          commandId: "command:delete-b",
          expectedCurrentNodeId: node("command:b").resultNodeId,
        }),
        human,
      ),
    ).toMatchObject({
      status: "committed",
      receipt: { currentNodeId: node("command:a").resultNodeId },
    });
    expect(store.deletions.size).toBe(2);
    expect(await loadProofHistory(store, SESSION)).toMatchObject({
      status: "loaded",
      nodes: [{ id: "node:root" }, {}, {}],
    });
  });
});

describe("MemoryProofStore deletion constraints", () => {
  const sessionId = proofSessionIdSchema.parse(SESSION);

  it("rejects deleting a node that retained rows still reference", async () => {
    const store = await branchingStore();
    const before = snapshot(store);
    await expect(
      store.transaction(async (transaction) =>
        transaction.deleteProofRecords(sessionId, {
          nodeIds: [node("command:b").resultNodeId],
          edgeIds: [],
          commandIds: [],
          chosenPreviewIds: [],
        }),
      ),
    ).rejects.toMatchObject({
      outcome: "rolled-back",
      cause: { name: "MemoryProofStoreConstraintError" },
    });
    expect(snapshot(store)).toBe(before);
  });

  it("checks deferred command references and the current-node pointer at commit", async () => {
    const store = await branchingStore();
    const d = node("command:d");
    await expect(
      store.transaction(async (transaction) =>
        transaction.deleteProofRecords(sessionId, {
          nodeIds: [],
          edgeIds: [],
          commandIds: [commandIdSchema.parse("command:d")],
          chosenPreviewIds: [],
        }),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining("referenced") } });
    await expect(
      store.transaction(async (transaction) =>
        transaction.deleteProofRecords(sessionId, {
          nodeIds: [d.resultNodeId],
          edgeIds: [d.edgeId],
          commandIds: [commandIdSchema.parse("command:d")],
          chosenPreviewIds: [d.previewId],
        }),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining("proof_sessions_current_node_fk") },
    });
    expect(store.nodes.has(key(SESSION, d.resultNodeId))).toBe(true);
  });
});
