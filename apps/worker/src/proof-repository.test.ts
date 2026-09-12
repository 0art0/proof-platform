import { describe, expect, it } from "vitest";
import { CORE_LOGIC_RESULTS } from "@proof/library";
import { HAND_AUTHORED_MOVES } from "@proof/moves";
import {
  actorSchema,
  commandIdSchema,
  createProofNodeSchema,
  type DisplayedSuggestionSet,
  type MovePreview,
  type PrepareProofCommandSuccess,
  type ProofEdge,
  type ProofNode,
  type ProtocolEnvironment,
  type TransitionEvent,
} from "@proof/protocol";
import { createRetrievalIndex, type RetrievalIndex } from "@proof/retrieval";
import {
  backtrackProofSession,
  derivedMoveRecordIds,
  ProofStoreTransactionError,
  executeProofCommand,
  initializeProofSession,
  loadProofHistory,
  loadCurrentProofSession,
  materializeMoveChoice,
  readDisplayedSuggestionSet,
  recordDisplayedSuggestionSet,
  recordMovePreview,
  type ProofSession,
  type ProofStore,
  type ProofStoreTransaction,
} from "./proof-repository";

const human = actorSchema.parse({ kind: "human", id: "actor:human" });

function rawNode(
  conclusion: unknown = "True",
  options: Readonly<{
    id?: string;
    stateId?: string;
    operators?: NonNullable<ProtocolEnvironment["operators"]>;
  }> = {},
): ProofNode {
  return createProofNodeSchema({
    ...(options.operators === undefined ? {} : { operators: options.operators }),
  }).parse({
    id: options.id ?? "node:root",
    state: {
      id: options.stateId ?? "state:root",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: { declarations: [], hypotheses: [] },
            conclusion: { expression: conclusion },
          },
        },
      ],
      obligations: [],
    },
  });
}

function command(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    commandId: "command:one",
    kind: "apply-kernel-operation",
    actor: human,
    parentNodeId: "node:root",
    resultNodeId: "node:child",
    edgeId: "edge:one",
    eventId: "event:one",
    operation: {
      kind: "close-true",
      expectedStateId: "state:root",
      resultStateId: "state:child",
      target: { kind: "goal", id: "goal:main" },
    },
    ...overrides,
  };
}

type FailurePoint =
  | "insertSession"
  | "insertNode"
  | "insertSuggestionSet"
  | "insertPreview"
  | "insertEdge"
  | "insertEvent"
  | "insertCommand"
  | "advance";

class MemoryProofStore implements ProofStore {
  sessions = new Map<string, ProofSession>();
  nodes = new Map<string, ProofNode>();
  suggestionSets = new Map<string, DisplayedSuggestionSet>();
  previews = new Map<string, MovePreview>();
  edges = new Map<string, ProofEdge>();
  events = new Map<string, TransitionEvent>();
  commands = new Map<string, PrepareProofCommandSuccess>();
  failAt: FailurePoint | undefined;
  nodeRecordOverride: unknown | undefined;
  suggestionSetRecordOverride: unknown | undefined;
  log: string[] = [];
  private queue: Promise<void> = Promise.resolve();

  async transaction<Result>(
    work: (transaction: ProofStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    const previous = this.queue;
    let release: (() => void) | undefined;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const staged = {
      sessions: cloneMap(this.sessions),
      nodes: cloneMap(this.nodes),
      suggestionSets: cloneMap(this.suggestionSets),
      previews: cloneMap(this.previews),
      edges: cloneMap(this.edges),
      events: cloneMap(this.events),
      commands: cloneMap(this.commands),
    };
    const fail = (point: FailurePoint): void => {
      if (this.failAt === point) throw new Error(`forced ${point} failure`);
    };
    const transaction: ProofStoreTransaction = {
      lockSession: async (sessionId) => {
        this.log.push("lockSession");
        return staged.sessions.get(sessionId);
      },
      readNode: async (sessionId, nodeId) => {
        this.log.push("readNode");
        if (this.nodeRecordOverride !== undefined) return this.nodeRecordOverride;
        const node = staged.nodes.get(key(sessionId, nodeId));
        return node === undefined
          ? undefined
          : { sessionId, nodeId: node.id, stateId: node.state.id, node };
      },
      readCommand: async (sessionId, commandId) => {
        this.log.push("readCommand");
        return staged.commands.get(key(sessionId, commandId));
      },
      readSuggestionSet: async (sessionId, suggestionSetId) => {
        this.log.push("readSuggestionSet");
        if (this.suggestionSetRecordOverride !== undefined) {
          return this.suggestionSetRecordOverride;
        }
        const suggestionSet = staged.suggestionSets.get(key(sessionId, suggestionSetId));
        return suggestionSet === undefined
          ? undefined
          : {
              sessionId,
              suggestionSetId: suggestionSet.id,
              nodeId: suggestionSet.nodeId,
              stateId: suggestionSet.stateId,
              suggestionSet,
            };
      },
      readPreview: async (sessionId, previewId) => {
        this.log.push("readPreview");
        return staged.previews.get(key(sessionId, previewId));
      },
      listEdges: async (sessionId) =>
        [...staged.edges.values()]
          .filter((edge) => staged.nodes.has(key(sessionId, edge.parentNodeId)))
          .map((edge) => ({
            sessionId,
            edgeId: edge.id,
            parentNodeId: edge.parentNodeId,
            childNodeId: edge.childNodeId,
            commandId: edge.commandId,
            suggestionSetId: edge.suggestionSetId ?? null,
            chosenSuggestionId: edge.chosenSuggestionId ?? null,
            previewId: edge.previewId ?? null,
            edge,
          })),
      insertSession: async (session) => {
        fail("insertSession");
        staged.sessions.set(session.id, structuredClone(session));
      },
      insertNode: async (sessionId, node) => {
        fail("insertNode");
        staged.nodes.set(key(sessionId, node.id), structuredClone(node));
      },
      insertSuggestionSet: async (sessionId, suggestionSet) => {
        fail("insertSuggestionSet");
        staged.suggestionSets.set(key(sessionId, suggestionSet.id), structuredClone(suggestionSet));
      },
      insertPreview: async (sessionId, preview) => {
        fail("insertPreview");
        staged.previews.set(key(sessionId, preview.id), structuredClone(preview));
      },
      insertEdge: async (sessionId, edge) => {
        fail("insertEdge");
        staged.edges.set(key(sessionId, edge.id), structuredClone(edge));
      },
      insertEvent: async (sessionId, event) => {
        fail("insertEvent");
        staged.events.set(key(sessionId, event.id), structuredClone(event));
      },
      insertCommand: async (sessionId, result) => {
        fail("insertCommand");
        staged.commands.set(
          key(sessionId, result.prepared.command.commandId),
          structuredClone(result),
        );
      },
      advanceCurrentNode: async (sessionId, expectedNodeId, nextNodeId) => {
        this.log.push("advanceCurrentNode");
        if (this.failAt === "advance") return false;
        const session = staged.sessions.get(sessionId);
        if (session === undefined || session.currentNodeId !== expectedNodeId) return false;
        staged.sessions.set(sessionId, { ...session, currentNodeId: nextNodeId });
        return true;
      },
      repointCurrentNode: async (sessionId, expectedNodeId, targetNodeId) => {
        const session = staged.sessions.get(sessionId);
        if (session === undefined || session.currentNodeId !== expectedNodeId) return false;
        staged.sessions.set(sessionId, { ...session, currentNodeId: targetNodeId });
        return true;
      },
    };

    try {
      const result = await work(transaction);
      this.sessions = staged.sessions;
      this.nodes = staged.nodes;
      this.suggestionSets = staged.suggestionSets;
      this.previews = staged.previews;
      this.edges = staged.edges;
      this.events = staged.events;
      this.commands = staged.commands;
      return result;
    } finally {
      release?.();
    }
  }
}

function cloneMap<Value>(source: ReadonlyMap<string, Value>): Map<string, Value> {
  return new Map([...source].map(([entryKey, value]) => [entryKey, structuredClone(value)]));
}

function key(sessionId: string, recordId: string): string {
  return `${sessionId}\u0000${recordId}`;
}

function retrievalIndex(): RetrievalIndex {
  const created = createRetrievalIndex({
    results: CORE_LOGIC_RESULTS,
    moves: HAND_AUTHORED_MOVES,
    variantFamilies: [],
  });
  if (!created.ok) throw new Error(created.diagnostics[0].message);
  return created.index;
}

function suggestionRequest() {
  return {
    id: "suggestion-set:one",
    selection: {
      kind: "exact",
      anchor: {
        stateId: "state:root",
        target: { kind: "goal", id: "goal:main" },
        statement: { kind: "conclusion" },
      },
      path: [],
    },
    options: { limit: 100 },
  };
}

async function initializedStore(root: ProofNode = rawNode()): Promise<MemoryProofStore> {
  const store = new MemoryProofStore();
  const result = await initializeProofSession(store, {
    sessionId: "session:one",
    rootNode: root,
  });
  expect(result).toMatchObject({ status: "committed" });
  return store;
}

describe("proof repository workflow", () => {
  it("materializes generated IDs and preserves two children after backtracking", async () => {
    const root = createProofNodeSchema().parse({
      id: "node:root",
      state: {
        id: "state:root",
        goals: [
          {
            id: "goal:main",
            sequent: {
              context: {
                declarations: [
                  {
                    id: "declaration:p",
                    symbol: "p",
                    sort: { kind: "proposition" },
                    role: "universal-parameter",
                  },
                  {
                    id: "declaration:q",
                    symbol: "q",
                    sort: { kind: "proposition" },
                    role: "universal-parameter",
                  },
                ],
                hypotheses: [
                  {
                    id: "hypothesis:conjunction",
                    statement: { expression: ["And", "p", "q"] },
                  },
                ],
              },
              conclusion: { expression: ["And", "p", "q"] },
            },
          },
        ],
        obligations: [],
      },
    });
    const store = await initializedStore(root);
    const targetSelection = {
      kind: "exact" as const,
      anchor: {
        stateId: "state:root",
        target: { kind: "goal" as const, id: "goal:main" },
        statement: { kind: "conclusion" as const },
      },
      path: [],
    };
    const firstSuggestions = await recordDisplayedSuggestionSet(
      store,
      retrievalIndex(),
      "session:one",
      { id: "suggestion-set:first", selection: targetSelection, options: { limit: 100 } },
    );
    if (firstSuggestions.status !== "committed") {
      throw new Error(firstSuggestions.diagnostics[0].message);
    }
    const split = firstSuggestions.suggestionSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:split-goal-conjunction",
    );
    expect(split).toMatchObject({ applicability: "applicable", unresolvedParameters: [] });
    if (split === undefined) throw new Error("Expected the split move.");

    const firstCommandId = commandIdSchema.parse("command:first");
    const firstChoice = {
      commandId: firstCommandId,
      suggestionSetId: firstSuggestions.suggestionSet.id,
      chosenSuggestionId: split.id,
    };
    const firstMaterialized = await materializeMoveChoice(store, "session:one", firstChoice);
    expect(firstMaterialized).toMatchObject({
      status: "materialized",
      request: {
        operation: {
          kind: "split-goal-conjunction",
          childIds: ["statement:command:first:child:1", "statement:command:first:child:2"],
        },
      },
    });
    if (firstMaterialized.status !== "materialized") return;
    const firstPreview = await recordMovePreview(store, "session:one", firstMaterialized.request);
    if (firstPreview.status !== "committed") return;
    const firstIds = derivedMoveRecordIds(firstCommandId);
    const firstApplied = await executeProofCommand(
      store,
      "session:one",
      {
        commandId: firstChoice.commandId,
        kind: "apply-kernel-operation",
        actor: human,
        parentNodeId: firstPreview.preview.nodeId,
        resultNodeId: firstIds.resultNodeId,
        edgeId: firstIds.edgeId,
        eventId: firstIds.eventId,
        moveId: firstPreview.preview.moveId,
        suggestionSetId: firstPreview.preview.suggestionSetId,
        chosenSuggestionId: firstPreview.preview.chosenSuggestionId,
        previewId: firstPreview.preview.id,
        operation: firstPreview.preview.operation,
      },
      human,
    );
    expect(firstApplied).toMatchObject({ status: "committed", replayed: false });

    expect(
      await backtrackProofSession(store, "session:one", {
        expectedCurrentNodeId: firstIds.resultNodeId,
        targetNodeId: "node:root",
      }),
    ).toMatchObject({ status: "committed", session: { currentNodeId: "node:root" } });

    const secondSuggestions = await recordDisplayedSuggestionSet(
      store,
      retrievalIndex(),
      "session:one",
      {
        id: "suggestion-set:second",
        selection: {
          kind: "selection-query",
          selections: [
            { id: "selection:target", selection: targetSelection },
            {
              id: "selection:hypothesis",
              selection: {
                ...targetSelection,
                anchor: {
                  ...targetSelection.anchor,
                  statement: { kind: "hypothesis", id: "hypothesis:conjunction" },
                },
              },
            },
          ],
        },
        options: { limit: 100 },
      },
    );
    if (secondSuggestions.status !== "committed") return;
    const expand = secondSuggestions.suggestionSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:expand-hypothesis-conjunction",
    );
    expect(expand).toMatchObject({ applicability: "applicable", unresolvedParameters: [] });
    if (expand === undefined) return;
    const secondCommandId = commandIdSchema.parse("command:second");
    const secondChoice = {
      commandId: secondCommandId,
      suggestionSetId: secondSuggestions.suggestionSet.id,
      chosenSuggestionId: expand.id,
    };
    const secondMaterialized = await materializeMoveChoice(store, "session:one", secondChoice);
    if (secondMaterialized.status !== "materialized") return;
    const secondPreview = await recordMovePreview(store, "session:one", secondMaterialized.request);
    if (secondPreview.status !== "committed") return;
    const secondIds = derivedMoveRecordIds(secondCommandId);
    expect(
      await executeProofCommand(
        store,
        "session:one",
        {
          commandId: secondChoice.commandId,
          kind: "apply-kernel-operation",
          actor: human,
          parentNodeId: secondPreview.preview.nodeId,
          resultNodeId: secondIds.resultNodeId,
          edgeId: secondIds.edgeId,
          eventId: secondIds.eventId,
          moveId: secondPreview.preview.moveId,
          suggestionSetId: secondPreview.preview.suggestionSetId,
          chosenSuggestionId: secondPreview.preview.chosenSuggestionId,
          previewId: secondPreview.preview.id,
          operation: secondPreview.preview.operation,
        },
        human,
      ),
    ).toMatchObject({ status: "committed", replayed: false });

    const siblings = [...store.edges.values()].filter(
      ({ parentNodeId }) => parentNodeId === "node:root",
    );
    expect(siblings.map(({ childNodeId }) => childNodeId).sort()).toEqual(
      [firstIds.resultNodeId, secondIds.resultNodeId].sort(),
    );
    expect(new Set(siblings.map(({ childNodeId }) => childNodeId)).size).toBe(2);
    expect(await loadProofHistory(store, "session:one")).toMatchObject({
      status: "loaded",
      session: { currentNodeId: secondIds.resultNodeId },
      nodes: [{ id: "node:root" }, {}, {}],
      edges: [
        { edge: { parentNodeId: "node:root" }, name: expect.any(String) },
        { edge: { parentNodeId: "node:root" }, name: expect.any(String) },
      ],
    });
  });

  it("persists once and deterministically revalidates an identical replay", async () => {
    const store = await initializedStore();
    const baseIndex = retrievalIndex();
    let queryCount = 0;
    const countingIndex: RetrievalIndex = {
      resultCount: baseIndex.resultCount,
      moveCount: baseIndex.moveCount,
      patternCount: baseIndex.patternCount,
      query(...args) {
        queryCount += 1;
        return baseIndex.query(...args);
      },
    };

    const first = await recordDisplayedSuggestionSet(
      store,
      countingIndex,
      "session:one",
      suggestionRequest(),
    );
    expect(first).toMatchObject({
      status: "committed",
      replayed: false,
      suggestionSet: {
        id: "suggestion-set:one",
        nodeId: "node:root",
        stateId: "state:root",
      },
    });
    expect(queryCount).toBe(1);
    const storedBeforeReplay = structuredClone(
      store.suggestionSets.get(key("session:one", "suggestion-set:one")),
    );

    const replay = await recordDisplayedSuggestionSet(
      store,
      countingIndex,
      "session:one",
      suggestionRequest(),
    );
    expect(replay).toMatchObject({ status: "committed", replayed: true });
    expect(queryCount).toBe(2);
    expect(store.suggestionSets.get(key("session:one", "suggestion-set:one"))).toEqual(
      storedBeforeReplay,
    );
  });

  it("persists a snapshot-anchored virtual selection without flattening its lens", async () => {
    const store = await initializedStore(rawNode(["And", "True", "False", "True"]));
    const result = await recordDisplayedSuggestionSet(store, retrievalIndex(), "session:one", {
      id: "suggestion-set:virtual",
      selection: {
        kind: "associative",
        anchor: {
          stateId: "state:root",
          target: { kind: "goal", id: "goal:main" },
          statement: { kind: "conclusion" },
        },
        containerPath: [],
        startOperand: 1,
        endOperand: 3,
        displayRange: [3, 9],
      },
      options: { limit: 100 },
    });

    expect(result).toMatchObject({
      status: "committed",
      suggestionSet: {
        selection: {
          kind: "associative",
          fragment: ["And", "False", "True"],
          coveredOperandPaths: [[1], [2]],
          displayRange: [3, 9],
        },
      },
    });
  });

  it("loads one detached current session and preserves independent sequent contexts", async () => {
    const node = createProofNodeSchema().parse({
      id: "node:root",
      state: {
        id: "state:root",
        goals: [
          {
            id: "goal:main",
            sequent: {
              context: {
                declarations: [
                  {
                    id: "declaration:goal-p",
                    symbol: "p",
                    sort: { kind: "proposition" },
                    role: "universal-parameter",
                  },
                ],
                hypotheses: [{ id: "hypothesis:goal-p", statement: { expression: "p" } }],
              },
              conclusion: { expression: "p" },
            },
          },
        ],
        obligations: [
          {
            id: "obligation:main",
            sequent: {
              context: {
                declarations: [
                  {
                    id: "declaration:obligation-q",
                    symbol: "q",
                    sort: { kind: "proposition" },
                    role: "universal-parameter",
                  },
                ],
                hypotheses: [{ id: "hypothesis:obligation-q", statement: { expression: "q" } }],
              },
              conclusion: { expression: "q" },
            },
          },
        ],
      },
    });
    const store = await initializedStore(node);
    const loaded = await loadCurrentProofSession(store, "session:one");

    expect(loaded).toMatchObject({
      status: "loaded",
      session: { id: "session:one", currentNodeId: "node:root" },
      node: {
        state: {
          goals: [{ sequent: { context: { declarations: [{ symbol: "p" }] } } }],
          obligations: [{ sequent: { context: { declarations: [{ symbol: "q" }] } } }],
        },
      },
    });
    if (loaded.status === "loaded") {
      expect(loaded.node.state.goals[0]?.sequent.context).not.toBe(
        loaded.node.state.obligations[0]?.sequent.context,
      );
      expect(Object.isFrozen(loaded.session)).toBe(true);
      expect(Object.isFrozen(loaded.node.state.goals[0]?.sequent.context)).toBe(true);
    }
  });

  it("checks redundant node and suggestion-set row identities", async () => {
    const store = await initializedStore();
    store.nodeRecordOverride = {
      sessionId: "session:other",
      nodeId: "node:root",
      stateId: "state:root",
      node: rawNode(),
    };
    expect(await loadCurrentProofSession(store, "session:one")).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-current-node" }],
    });

    store.nodeRecordOverride = undefined;
    const recorded = await recordDisplayedSuggestionSet(
      store,
      retrievalIndex(),
      "session:one",
      suggestionRequest(),
    );
    if (recorded.status !== "committed") throw new Error(recorded.diagnostics[0].message);
    store.suggestionSetRecordOverride = {
      sessionId: "session:one",
      suggestionSetId: "suggestion-set:one",
      nodeId: "node:root",
      stateId: "state:other",
      suggestionSet: store.suggestionSets.get(key("session:one", "suggestion-set:one")),
    };
    expect(
      await readDisplayedSuggestionSet(store, "session:one", "suggestion-set:one"),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-suggestion-set-record" }],
    });
  });

  it("reads persisted suggestions from their historical node after the session advances", async () => {
    const store = await initializedStore();
    const recorded = await recordDisplayedSuggestionSet(
      store,
      retrievalIndex(),
      "session:one",
      suggestionRequest(),
    );
    if (recorded.status !== "committed") throw new Error(recorded.diagnostics[0].message);
    expect(await executeProofCommand(store, "session:one", command(), human)).toMatchObject({
      status: "committed",
    });

    const read = await readDisplayedSuggestionSet(store, "session:one", "suggestion-set:one");
    expect(read).toEqual({ status: "loaded", suggestionSet: recorded.suggestionSet });
  });

  it("rejects a stale or conflicting request that reuses a suggestion-set ID", async () => {
    const store = await initializedStore(rawNode(["And", "True", "True"]));
    const request = {
      ...suggestionRequest(),
      selection: { ...suggestionRequest().selection, path: [0] },
    };
    expect(
      await recordDisplayedSuggestionSet(store, retrievalIndex(), "session:one", request),
    ).toMatchObject({ status: "committed", replayed: false });

    expect(
      await recordDisplayedSuggestionSet(store, retrievalIndex(), "session:one", {
        ...request,
        selection: { ...request.selection, path: [1] },
      }),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "suggestion-set-rejected" }],
    });
    expect(
      await recordDisplayedSuggestionSet(store, retrievalIndex(), "session:one", {
        ...request,
        selection: {
          ...request.selection,
          anchor: { ...request.selection.anchor, stateId: "state:stale" },
        },
      }),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "suggestion-set-rejected" }],
    });
  });

  it("persists and revalidates multiselection abstraction evidence without rewriting it", async () => {
    const root = createProofNodeSchema().parse({
      id: "node:root",
      state: {
        id: "state:root",
        goals: [
          {
            id: "goal:main",
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
                hypotheses: [{ id: "hypothesis:p", statement: { expression: "p" } }],
              },
              conclusion: { expression: "p" },
            },
          },
        ],
        obligations: [],
      },
    });
    const store = await initializedStore(root);
    const baseIndex = retrievalIndex();
    let queryCount = 0;
    const countingIndex: RetrievalIndex = {
      resultCount: baseIndex.resultCount,
      moveCount: baseIndex.moveCount,
      patternCount: baseIndex.patternCount,
      query(...args) {
        queryCount += 1;
        return baseIndex.query(...args);
      },
    };
    const targetSelection = {
      kind: "exact",
      anchor: {
        stateId: "state:root",
        target: { kind: "goal", id: "goal:main" },
        statement: { kind: "conclusion" },
      },
      path: [],
    };
    const request = {
      id: "suggestion-set:multiple",
      selection: {
        kind: "selection-query",
        selections: [
          {
            id: "selection:target",
            selection: targetSelection,
            abstraction: {
              id: "wildcard:target",
              symbol: "_target",
              role: "retrieval-wildcard",
              sort: { kind: "proposition" },
            },
          },
          {
            id: "selection:fact",
            selection: {
              ...targetSelection,
              anchor: {
                ...targetSelection.anchor,
                statement: { kind: "hypothesis", id: "hypothesis:p" },
              },
            },
          },
        ],
      },
      options: { limit: 100 },
    };

    const first = await recordDisplayedSuggestionSet(store, countingIndex, "session:one", request);
    expect(first).toMatchObject({
      status: "committed",
      replayed: false,
      suggestionSet: {
        selection: {
          kind: "selection-query",
          selections: [
            {
              id: "selection:target",
              selection: { fragment: "p" },
              abstraction: { id: "wildcard:target" },
            },
            { id: "selection:fact", selection: { fragment: "p" } },
          ],
        },
        suggestions: [
          {
            artifactId: "move:close-by-hypothesis",
            abstractionFit: "compatible",
            selectionMatches: [
              { selectionId: "selection:fact", selectionSlotId: "fact" },
              { selectionId: "selection:target", selectionSlotId: "target" },
            ],
          },
        ],
      },
    });
    expect(queryCount).toBe(1);
    const stored = structuredClone(
      store.suggestionSets.get(key("session:one", "suggestion-set:multiple")),
    );

    const replay = await recordDisplayedSuggestionSet(store, countingIndex, "session:one", request);
    expect(replay).toMatchObject({ status: "committed", replayed: true });
    expect(queryCount).toBe(2);
    expect(store.suggestionSets.get(key("session:one", "suggestion-set:multiple"))).toEqual(stored);
  });

  it("executes and replays a command linked to its persisted displayed move", async () => {
    const store = await initializedStore();
    const recorded = await recordDisplayedSuggestionSet(
      store,
      retrievalIndex(),
      "session:one",
      suggestionRequest(),
    );
    if (recorded.status !== "committed") throw new Error(recorded.diagnostics[0].message);
    const chosen = recorded.suggestionSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:close-true",
    );
    if (chosen === undefined) throw new Error("Expected close-true to be displayed.");
    const linkedCommand = command({
      moveId: "move:close-true",
      suggestionSetId: recorded.suggestionSet.id,
      chosenSuggestionId: chosen.id,
    });

    const first = await executeProofCommand(store, "session:one", linkedCommand, human);
    expect(first).toMatchObject({
      status: "committed",
      replayed: false,
      result: {
        prepared: {
          edge: {
            suggestionSetId: "suggestion-set:one",
            chosenSuggestionId: chosen.id,
          },
          event: {
            suggestionSetId: "suggestion-set:one",
            chosenSuggestionId: chosen.id,
          },
        },
      },
    });
    expect(await executeProofCommand(store, "session:one", linkedCommand, human)).toMatchObject({
      status: "committed",
      replayed: true,
    });
  });

  it("persists, replays, and executes an exact move preview", async () => {
    const store = await initializedStore();
    const suggestions = await recordDisplayedSuggestionSet(
      store,
      retrievalIndex(),
      "session:one",
      suggestionRequest(),
    );
    if (suggestions.status !== "committed") {
      throw new Error(suggestions.diagnostics[0].message);
    }
    const chosen = suggestions.suggestionSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:close-true",
    );
    if (chosen === undefined) throw new Error("Expected close-true to be displayed.");
    const request = {
      id: "preview:one",
      suggestionSetId: suggestions.suggestionSet.id,
      chosenSuggestionId: chosen.id,
      moveId: "move:close-true",
      operation: command().operation,
    };

    const preview = await recordMovePreview(store, "session:one", request);
    expect(preview).toMatchObject({
      status: "committed",
      replayed: false,
      preview: {
        id: "preview:one",
        beforeState: { id: "state:root" },
        afterState: { id: "state:child", goals: [] },
      },
    });
    expect(await recordMovePreview(store, "session:one", request)).toMatchObject({
      status: "committed",
      replayed: true,
    });
    expect(store.previews.size).toBe(1);

    const linkedCommand = command({
      moveId: "move:close-true",
      suggestionSetId: suggestions.suggestionSet.id,
      chosenSuggestionId: chosen.id,
      previewId: "preview:one",
    });
    expect(await executeProofCommand(store, "session:one", linkedCommand, human)).toMatchObject({
      status: "committed",
      result: {
        prepared: {
          edge: { previewId: "preview:one" },
          event: { previewId: "preview:one" },
        },
      },
    });
  });

  it("rejects missing previews and rolls back preview persistence failures", async () => {
    const missingStore = await initializedStore();
    expect(
      await executeProofCommand(
        missingStore,
        "session:one",
        command({
          moveId: "move:close-true",
          suggestionSetId: "suggestion-set:missing",
          chosenSuggestionId: "suggestion:missing",
          previewId: "preview:missing",
        }),
        human,
      ),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "suggestion-set-not-found" }],
    });

    const store = await initializedStore();
    const suggestions = await recordDisplayedSuggestionSet(
      store,
      retrievalIndex(),
      "session:one",
      suggestionRequest(),
    );
    if (suggestions.status !== "committed") {
      throw new Error(suggestions.diagnostics[0].message);
    }
    const chosen = suggestions.suggestionSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:close-true",
    );
    if (chosen === undefined) throw new Error("Expected close-true to be displayed.");
    expect(
      await executeProofCommand(
        store,
        "session:one",
        command({
          moveId: "move:close-true",
          suggestionSetId: suggestions.suggestionSet.id,
          chosenSuggestionId: chosen.id,
          previewId: "preview:missing",
        }),
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "preview-not-found" }] });

    store.failAt = "insertPreview";
    expect(
      await recordMovePreview(store, "session:one", {
        id: "preview:one",
        suggestionSetId: suggestions.suggestionSet.id,
        chosenSuggestionId: chosen.id,
        moveId: "move:close-true",
        operation: command().operation,
      }),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "storage-failure" }] });
    expect(store.previews.size).toBe(0);
  });

  it("rejects absent and corrupt suggestion records before command execution", async () => {
    const missingStore = await initializedStore();
    expect(
      await executeProofCommand(
        missingStore,
        "session:one",
        command({
          moveId: "move:close-true",
          suggestionSetId: "suggestion-set:missing",
          chosenSuggestionId: "suggestion:missing",
        }),
        human,
      ),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "suggestion-set-not-found" }],
    });

    const corruptStore = await initializedStore();
    const recorded = await recordDisplayedSuggestionSet(
      corruptStore,
      retrievalIndex(),
      "session:one",
      suggestionRequest(),
    );
    if (recorded.status !== "committed") throw new Error(recorded.diagnostics[0].message);
    const chosen = recorded.suggestionSet.suggestions[0];
    if (chosen === undefined) throw new Error("Expected a displayed suggestion.");
    corruptStore.suggestionSets.set(key("session:one", recorded.suggestionSet.id), {
      ...recorded.suggestionSet,
      nodeId: "node:wrong",
    } as DisplayedSuggestionSet);
    expect(
      await executeProofCommand(
        corruptStore,
        "session:one",
        command({
          moveId: "move:close-true",
          suggestionSetId: recorded.suggestionSet.id,
          chosenSuggestionId: chosen.id,
        }),
        human,
      ),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "command-rejected" }],
    });
  });

  it("rolls back a failed suggestion-set insert", async () => {
    const store = await initializedStore();
    store.failAt = "insertSuggestionSet";
    expect(
      await recordDisplayedSuggestionSet(
        store,
        retrievalIndex(),
        "session:one",
        suggestionRequest(),
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "storage-failure" }] });
    expect(store.suggestionSets.size).toBe(0);
  });

  it("initializes a detached root and frozen operator environment atomically", async () => {
    const source = { sym: "True", comment: "original" };
    const root = rawNode(source);
    const store = new MemoryProofStore();
    const result = await initializeProofSession(store, {
      sessionId: "session:one",
      rootNode: root,
      operators: [],
    });

    expect(result).toMatchObject({
      status: "committed",
      session: { rootNodeId: "node:root", currentNodeId: "node:root", operators: [] },
    });
    source.comment = "mutated";
    expect(
      store.nodes.get(key("session:one", "node:root"))?.state.goals[0]?.sequent.conclusion,
    ).toEqual({ expression: { sym: "True", comment: "original" } });
    if (result.status === "committed") {
      expect(Object.isFrozen(result.node)).toBe(true);
      expect(Object.isFrozen(result.session.operators)).toBe(true);
    }
  });

  it("commits once and replays an identical command without duplicate records", async () => {
    const store = await initializedStore();
    const first = await executeProofCommand(store, "session:one", command(), human);
    expect(first).toMatchObject({ status: "committed", replayed: false });
    const sizes = [store.nodes.size, store.edges.size, store.events.size, store.commands.size];

    const retry = await executeProofCommand(store, "session:one", command(), human);
    expect(retry).toMatchObject({ status: "committed", replayed: true });
    expect([store.nodes.size, store.edges.size, store.events.size, store.commands.size]).toEqual(
      sizes,
    );
    expect(store.log.indexOf("lockSession")).toBeLessThan(store.log.indexOf("readCommand"));
  });

  it("rejects an idempotent command replay after navigation supersedes its result node", async () => {
    const store = await initializedStore();
    expect(await executeProofCommand(store, "session:one", command(), human)).toMatchObject({
      status: "committed",
      replayed: false,
    });
    expect(
      await backtrackProofSession(store, "session:one", {
        expectedCurrentNodeId: "node:child",
        targetNodeId: "node:root",
      }),
    ).toMatchObject({ status: "committed", replayed: false });

    expect(await executeProofCommand(store, "session:one", command(), human)).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "serialized-stale-command" }],
    });
    expect(store.sessions.get("session:one")?.currentNodeId).toBe("node:root");
  });

  it("rejects history whose edge state identities do not link its retained snapshots", async () => {
    const store = await initializedStore();
    expect(await executeProofCommand(store, "session:one", command(), human)).toMatchObject({
      status: "committed",
    });
    const edge = store.edges.get(key("session:one", "edge:one"));
    if (edge === undefined) throw new Error("Expected the committed edge.");
    store.edges.set(key("session:one", edge.id), {
      ...edge,
      operation: {
        ...edge.operation,
        resultStateId: "state:unrelated" as ProofNode["state"]["id"],
      },
    });

    expect(await loadProofHistory(store, "session:one")).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-proof-history" }],
    });
  });

  it("commits validated move provenance and rejects a mismatched move atomically", async () => {
    const store = await initializedStore();
    const moveCommand = command({ moveId: "move:close-true" });
    const committed = await executeProofCommand(store, "session:one", moveCommand, human);
    expect(committed).toMatchObject({
      status: "committed",
      replayed: false,
      result: {
        prepared: {
          command: { moveId: "move:close-true" },
          edge: { moveId: "move:close-true" },
          event: { moveId: "move:close-true" },
        },
      },
    });

    const rejectedStore = await initializedStore();
    expect(
      await executeProofCommand(
        rejectedStore,
        "session:one",
        command({ moveId: "move:introduce-negation" }),
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "command-rejected" }] });
    expect(rejectedStore.nodes.size).toBe(1);
    expect(rejectedStore.commands.size).toBe(0);
  });

  it("rejects changed commands reusing an ID and actor mismatches without writes", async () => {
    const store = await initializedStore();
    expect(await executeProofCommand(store, "session:one", command(), human)).toMatchObject({
      status: "committed",
    });
    const sizes = [store.nodes.size, store.edges.size, store.events.size, store.commands.size];

    expect(
      await executeProofCommand(store, "session:one", command({ edgeId: "edge:changed" }), human),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "command-rejected" }] });
    expect(
      await executeProofCommand(store, "session:one", command({ commandId: "command:two" }), {
        kind: "agent",
        id: "actor:other",
      }),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "command-rejected" }] });
    expect([store.nodes.size, store.edges.size, store.events.size, store.commands.size]).toEqual(
      sizes,
    );
  });

  it("serializes two commands from one parent so only the first commits", async () => {
    const store = await initializedStore();
    const first = command();
    const second = command({
      commandId: "command:two",
      resultNodeId: "node:second",
      edgeId: "edge:two",
      eventId: "event:two",
      operation: {
        kind: "close-true",
        expectedStateId: "state:root",
        resultStateId: "state:second",
        target: { kind: "goal", id: "goal:main" },
      },
    });
    const results = await Promise.all([
      executeProofCommand(store, "session:one", first, human),
      executeProofCommand(store, "session:one", second, human),
    ]);

    expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
    expect(results).toContainEqual(
      expect.objectContaining({
        status: "rejected",
        diagnostics: [expect.objectContaining({ code: "serialized-stale-command" })],
      }),
    );
    expect(store.commands.size).toBe(1);
  });

  it.each(["insertNode", "insertEdge", "insertEvent", "insertCommand", "advance"] as const)(
    "rolls back every staged record when %s fails",
    async (failurePoint) => {
      const store = await initializedStore();
      store.failAt = failurePoint;
      const result = await executeProofCommand(store, "session:one", command(), human);

      expect(result).toMatchObject({
        status: "rejected",
        diagnostics: [
          {
            code: failurePoint === "advance" ? "serialized-stale-command" : "storage-failure",
          },
        ],
      });
      expect(store.nodes.size).toBe(1);
      expect(store.edges.size).toBe(0);
      expect(store.events.size).toBe(0);
      expect(store.commands.size).toBe(0);
      expect(store.sessions.get("session:one")?.currentNodeId).toBe("node:root");
    },
  );

  it("rolls back initialization and distinguishes an unknown commit outcome", async () => {
    const store = new MemoryProofStore();
    store.failAt = "insertNode";
    expect(
      await initializeProofSession(store, { sessionId: "session:one", rootNode: rawNode() }),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "storage-failure" }] });
    expect(store.sessions.size).toBe(0);

    const uncertain: ProofStore = {
      transaction: async () => {
        throw new ProofStoreTransactionError("commit-unknown", "commit uncertain");
      },
    };
    expect(
      await initializeProofSession(uncertain, {
        sessionId: "session:one",
        rootNode: rawNode(),
      }),
    ).toMatchObject({ status: "uncertain", diagnostics: [{ code: "commit-unknown" }] });
  });

  it("rejects malformed stored JSON, identity mismatches, and cross-session lookups", async () => {
    const store = await initializedStore();
    store.nodes.set(key("session:one", "node:root"), {
      ...rawNode(),
      state: { ...rawNode().state, goals: "corrupt" },
    } as unknown as ProofNode);
    expect(await executeProofCommand(store, "session:one", command(), human)).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-current-node" }],
    });

    const isolated = await initializedStore();
    const session = isolated.sessions.get("session:one")!;
    isolated.sessions.set("session:one", {
      ...session,
      currentNodeId: "node:foreign" as ProofNode["id"],
    });
    isolated.nodes.set(key("session:two", "node:foreign"), rawNode("True", { id: "node:foreign" }));
    expect(await executeProofCommand(isolated, "session:one", command(), human)).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "current-node-not-found" }],
    });

    const mismatchedSession = await initializedStore();
    const storedSession = mismatchedSession.sessions.get("session:one")!;
    mismatchedSession.sessions.set("session:one", {
      ...storedSession,
      id: "session:other" as ProofSession["id"],
    });
    expect(
      await executeProofCommand(mismatchedSession, "session:one", command(), human),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-session-record" }],
    });

    const mismatchedNode = await initializedStore();
    mismatchedNode.nodes.set(
      key("session:one", "node:root"),
      rawNode("True", { id: "node:other" }),
    );
    expect(
      await executeProofCommand(mismatchedNode, "session:one", command(), human),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-current-node" }],
    });
  });

  it("rejects a stored command result whose embedded identity differs from its lookup key", async () => {
    const source = await initializedStore();
    const committed = await executeProofCommand(source, "session:one", command(), human);
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") return;

    const target = await initializedStore();
    target.commands.set(
      key("session:one", "command:one"),
      structuredClone({
        ...committed.result,
        prepared: {
          ...committed.result.prepared,
          command: {
            ...committed.result.prepared.command,
            commandId: "command:other",
          },
        },
      }) as PrepareProofCommandSuccess,
    );

    expect(await executeProofCommand(target, "session:one", command(), human)).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-command-record" }],
    });
  });

  it("reloads a frozen custom operator environment for execution and retry", async () => {
    const operator = {
      id: "operator:predicate",
      symbol: "Predicate",
      signature: { parameters: [], result: { kind: "proposition" } },
    } as unknown as NonNullable<ProtocolEnvironment["operators"]>[number];
    const expression = ["Predicate"] as const;
    const customRoot = createProofNodeSchema({ operators: [operator] }).parse({
      id: "node:root",
      state: {
        id: "state:root",
        goals: [
          {
            id: "goal:main",
            sequent: {
              context: {
                declarations: [],
                hypotheses: [{ id: "hypothesis:fact", statement: { expression } }],
              },
              conclusion: { expression },
            },
          },
        ],
        obligations: [],
      },
    });
    const store = new MemoryProofStore();
    expect(
      await initializeProofSession(store, {
        sessionId: "session:one",
        rootNode: customRoot,
        operators: [operator],
      }),
    ).toMatchObject({ status: "committed" });
    const customCommand = command({
      operation: {
        kind: "close-by-hypothesis",
        expectedStateId: "state:root",
        resultStateId: "state:child",
        target: { kind: "goal", id: "goal:main" },
        hypothesisId: "hypothesis:fact",
      },
    });

    expect(await executeProofCommand(store, "session:one", customCommand, human)).toMatchObject({
      status: "committed",
      replayed: false,
    });
    expect(await executeProofCommand(store, "session:one", customCommand, human)).toMatchObject({
      status: "committed",
      replayed: true,
    });
  });
});
