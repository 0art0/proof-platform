import { describe, expect, it } from "vitest";
import { CORE_LOGIC_RESULTS, libraryResultSchema } from "@proof/library";
import { PROPOSITION_SORT } from "@proof/mathjson-model";
import { HAND_AUTHORED_MOVES } from "@proof/moves";
import {
  actorSchema,
  commandIdSchema,
  createProofNodeSchema,
  type DisplayedSuggestionSet,
  type InquiryRecord,
  type ProofNode,
} from "@proof/protocol";
import { createRetrievalIndex, type RetrievalIndex } from "@proof/retrieval";
import { adaptApprovedCatalog, type DefinitionCatalog } from "./approved-catalog";
import {
  executeTryResultCommand,
  extractConditionalLemma,
  investigateHypothesis,
} from "./inquiry-methods";
import { listInquiryRecords } from "./inquiry-repository";
import { listLibrary } from "./library-repository";
import { MemoryLibraryStore } from "./memory-library-store";
import {
  derivedMoveRecordIds,
  executeProofCommand,
  initializeProofSession,
  loadCurrentProofSession,
  loadProofHistory,
  materializeMoveChoice,
  recordDisplayedSuggestionSet,
  recordMovePreview,
} from "./proof-repository";

/**
 * N24 acceptance (refinement §3.4, §6): "Try this theorem" records an attempt with its
 * missing-premise objectives atomically with the transition, failed premise matches become
 * obstructions naming the stored unmet condition, "Investigate this hypothesis" records a
 * Determine question by identity, and conditional-lemma extraction goes through N12.
 */

const human = actorSchema.parse({ kind: "human", id: "actor:human" });
const SESSION = "session:methods";
const NOW = () => new Date("2026-09-28T12:00:00.000Z");
const MAIN = { kind: "goal", id: "goal:main" } as const;

const proposition = (symbol: string) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
});

/** Backward conjunction introduction with two premises and one descriptive side condition. */
const conjunctionIntroduction = libraryResultSchema.parse({
  kind: "result",
  id: "result:test-conjunction-introduction",
  name: "Conjunction introduction",
  description: "Both conjuncts establish the conjunction.",
  renderings: { latex: String.raw`p,\ q\vdash p\land q`, naturalLanguage: "p and q give p and q." },
  classification: { domains: ["logic"], level: "foundational" },
  provenance: { kind: "curated", source: "unit test" },
  approval: { status: "approved", reviewerId: "reviewer:test" },
  layer: "global",
  related: [],
  priority: 1,
  parameters: [proposition("p"), proposition("q")],
  statement: { expression: ["And", "p", "q"] },
  premises: [{ expression: "p" }, { expression: "q" }],
  sideConditions: [{ id: "side-condition:test-decidable", description: "p and q are decidable" }],
  applicationDirections: ["backward"],
  patterns: [
    {
      id: "pattern:test-conjunction-introduction",
      expression: ["And", "p", "q"],
      direction: "backward",
      requirement: { section: "goal", polarity: "any", role: "proposition" },
    },
  ],
});

const DEFINITIONS: DefinitionCatalog = {
  moves: HAND_AUTHORED_MOVES,
  catalog: (operators) =>
    adaptApprovedCatalog(operators, [...CORE_LOGIC_RESULTS, conjunctionIntroduction]),
};

function retrievalIndex(): RetrievalIndex {
  const catalog = DEFINITIONS.catalog([]);
  const created = createRetrievalIndex(
    { results: catalog.results, moves: DEFINITIONS.moves, variantFamilies: [] },
    { operators: [] },
  );
  if (!created.ok) throw new Error(created.diagnostics[0].message);
  return created.index;
}
const INDEX = retrievalIndex();

const background = {
  level: "undergraduate",
  summary: "Elementary logic.",
  assumptions: [],
  domains: ["logic"],
  maximumLevel: "undergraduate",
} as const;

async function session(): Promise<MemoryLibraryStore> {
  const store = new MemoryLibraryStore();
  const root = createProofNodeSchema().parse({
    id: "node:root",
    state: {
      id: "state:root",
      goals: [
        {
          id: MAIN.id,
          sequent: {
            context: {
              declarations: [proposition("p"), proposition("q")],
              hypotheses: [{ id: "hyp:p", statement: { expression: "p" } }],
            },
            conclusion: { expression: ["And", "p", "q"] },
          },
        },
      ],
      obligations: [],
    },
  });
  expect(
    await initializeProofSession(store, {
      sessionId: SESSION,
      rootNode: root,
      metadata: {
        problem: { title: "Conjunction", statement: "Show p and q." },
        background,
        libraryLayerIds: ["layer:global"],
      },
    }),
  ).toMatchObject({ status: "committed" });
  return store;
}

type Slot = Readonly<{ target: string; statement?: string }>;

/** Display suggestions for the slots and prepare the command applying `artifactId`. */
async function prepareChoice(
  store: MemoryLibraryStore,
  commandId: string,
  artifactId: string,
  slots: readonly Slot[],
) {
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
  const chosen = set.suggestions.find((suggestion) => suggestion.artifactId === artifactId);
  if (chosen === undefined) throw new Error(`${artifactId} was not displayed`);
  const materialized = await materializeMoveChoice(
    store,
    SESSION,
    { commandId, suggestionSetId: set.id, chosenSuggestionId: chosen.id },
    DEFINITIONS,
  );
  if (materialized.status !== "materialized") throw new Error(JSON.stringify(materialized));
  const preview = await recordMovePreview(store, SESSION, materialized.request, {
    definitions: DEFINITIONS,
  });
  if (preview.status !== "committed") throw new Error(JSON.stringify(preview));
  const own = derivedMoveRecordIds(commandIdSchema.parse(commandId));
  return {
    set,
    chosen,
    command: {
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
      ...(preview.preview.menuSelection === undefined
        ? {}
        : { menuSelection: preview.preview.menuSelection }),
    },
  };
}

async function tryTheorem(store: MemoryLibraryStore) {
  const { command, chosen } = await prepareChoice(
    store,
    "command:try",
    conjunctionIntroduction.id,
    [{ target: MAIN.id }],
  );
  const tried = await executeTryResultCommand(store, SESSION, command, human, {
    definitions: DEFINITIONS,
    now: NOW,
  });
  if (tried.status !== "committed") throw new Error(JSON.stringify(tried));
  return { tried, command, chosen };
}

function byId(records: readonly InquiryRecord[]): ReadonlyMap<string, InquiryRecord> {
  return new Map(records.map((record) => [record.id as string, record]));
}

async function allRecords(store: MemoryLibraryStore): Promise<readonly InquiryRecord[]> {
  const listed = await listInquiryRecords(store, SESSION, { limit: 500 });
  if (listed.status !== "loaded") throw new Error(JSON.stringify(listed));
  return listed.records;
}

describe("Try this theorem", () => {
  it("records the attempt, missing-premise objectives and obstructions with the transition", async () => {
    const store = await session();
    const { tried, chosen } = await tryTheorem(store);
    expect(chosen.predictedObligations).toEqual([
      { kind: "premise", index: 1, description: "premise 2", applicationPremiseIndex: 1 },
      { kind: "side-condition", index: 0, description: "p and q are decidable" },
    ]);
    const { node, edge } = tried.result.prepared;
    expect(edge.operation.kind).toBe("apply-result-backward");
    const premiseTargets =
      edge.operation.kind === "apply-result-backward" ? edge.operation.premiseTargetIds : [];
    expect(premiseTargets).toHaveLength(2);

    const records = byId(tried.records);
    const id = (suffix: string) => `command:try:try-result:${suffix}`;
    expect(tried.records.every(({ commandId }) => commandId === "command:try:try-result")).toBe(
      true,
    );
    expect(tried.records.every(({ nodeId }) => nodeId === "node:root")).toBe(true);
    expect(records.get(id("attempt"))).toMatchObject({
      method: { kind: "library-result", resultId: conjunctionIntroduction.id },
      objectiveId: id("objective"),
    });
    premiseTargets.forEach((targetId, index) => {
      expect(records.get(id(`premise-${index + 1}:objective`))).toMatchObject({
        necessity: "required",
        focus: { nodeId: node.id, target: { kind: "goal", id: targetId } },
        parentAttemptId: id("attempt"),
      });
    });
    expect(records.get(id("condition:premise-2:observation"))).toMatchObject({
      diagnostic: {
        code: "unmet-condition",
        detail: `Premise 2 of ${conjunctionIntroduction.id} is not available as a hypothesis; the application made it goal ${premiseTargets[1]}.`,
      },
    });
    expect(records.get(id("condition:premise-2:addresses"))).toMatchObject({
      from: [id("premise-2:objective")],
      to: id("condition:premise-2:obstruction"),
    });
    expect(records.get(id("condition:side-condition-1:obstruction"))).toMatchObject({
      attemptId: id("attempt"),
    });
    expect(await allRecords(store)).toEqual(tried.records);
  });

  it("replays identically when retried", async () => {
    const store = await session();
    const { tried, command } = await tryTheorem(store);
    const retried = await executeTryResultCommand(store, SESSION, command, human, {
      definitions: DEFINITIONS,
      now: () => new Date("2026-09-29T00:00:00.000Z"),
    });
    expect(retried).toMatchObject({ status: "committed", replayed: true });
    if (retried.status === "committed") expect(retried.records).toEqual(tried.records);
    expect(await allRecords(store)).toEqual(tried.records);
  });

  it("rolls back the transition when the choice is not a result application", async () => {
    const store = await session();
    const { command } = await prepareChoice(store, "command:split", "move:split-goal-conjunction", [
      { target: MAIN.id },
    ]);
    const before = await loadProofHistory(store, SESSION);
    const tried = await executeTryResultCommand(store, SESSION, command, human, {
      definitions: DEFINITIONS,
    });
    expect(tried).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "inquiry-command-rejected" }],
    });
    expect(await loadProofHistory(store, SESSION)).toEqual(before);
    expect(await allRecords(store)).toEqual([]);
    // The same command still applies as an ordinary move.
    expect(await executeProofCommand(store, SESSION, command, human, DEFINITIONS)).toMatchObject({
      status: "committed",
      replayed: false,
    });
  });
});

describe("Investigate this hypothesis", () => {
  it("records a Determine question by identity that tests the attempt's Establish question", async () => {
    const store = await session();
    await tryTheorem(store);
    const request = {
      commandId: "command:hyp",
      nodeId: "node:root",
      target: MAIN,
      hypothesisId: "hyp:p",
    };
    const recorded = await investigateHypothesis(store, SESSION, request, human, {
      definitions: DEFINITIONS,
      now: NOW,
    });
    if (recorded.status !== "committed") throw new Error(JSON.stringify(recorded));
    expect(recorded.records.map(({ kind }) => kind)).toEqual([
      "question",
      "objective",
      "relationship",
    ]);
    expect(recorded.records[0]).toMatchObject({
      question: {
        form: "determine",
        proposition: {
          kind: "target",
          nodeId: "node:root",
          target: MAIN,
          withoutHypotheses: ["hyp:p"],
        },
      },
    });
    expect(recorded.records[2]).toMatchObject({
      relation: "tests",
      to: "command:try:try-result:question",
      reason: { provenance: "method-encoded" },
    });
    const retried = await investigateHypothesis(store, SESSION, request, human, {
      definitions: DEFINITIONS,
      now: () => new Date("2026-09-29T00:00:00.000Z"),
    });
    expect(retried).toMatchObject({ status: "committed", replayed: true });
    expect(
      await investigateHypothesis(
        store,
        SESSION,
        { ...request, commandId: "command:hyp-missing", hypothesisId: "hyp:none" },
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "inquiry-command-rejected" }] });
  });
});

describe("Extract a conditional lemma", () => {
  function lemmaRequest(nodeId: string, targetId: string, suffix: string) {
    return {
      commandId: `command:lemma-${suffix}`,
      additionEventId: `addition:lemma-${suffix}`,
      occurredAt: "2026-09-28T12:00:00.000Z",
      nodeId,
      target: { kind: "goal", id: targetId },
      name: "p from p",
    };
  }

  it("adds a closed target to the derived layer as a draft and records the observation", async () => {
    const store = await session();
    const { tried } = await tryTheorem(store);
    const child: ProofNode = tried.result.prepared.node;
    const [first] = child.state.goals;
    if (first === undefined) throw new Error("premise goal");
    const { command } = await prepareChoice(store, "command:close", "move:close-by-hypothesis", [
      { target: first.id },
      { target: first.id, statement: "hyp:p" },
    ]);
    expect(await executeProofCommand(store, SESSION, command, human, DEFINITIONS)).toMatchObject({
      status: "committed",
    });

    const request = lemmaRequest(child.id, first.id, "premise");
    const extracted = await extractConditionalLemma(store, store, SESSION, request, human, {
      definitions: DEFINITIONS,
      now: NOW,
    });
    if (extracted.status !== "committed") throw new Error(JSON.stringify(extracted));
    expect(extracted.lemma).toMatchObject({
      id: "result:lemma.command:lemma-premise",
      name: "p from p",
      layer: "derived",
      approval: { status: "draft" },
      provenance: { kind: "derived", sessionId: SESSION, proofNodeId: child.id },
      premises: [{ expression: "p" }],
      statement: { expression: "p" },
    });
    expect(extracted.event).toMatchObject({ admission: { decision: "admitted" } });
    expect(extracted.records).toEqual([
      expect.objectContaining({
        kind: "observation",
        references: [{ kind: "target", nodeId: child.id, target: { kind: "goal", id: first.id } }],
        note: expect.stringContaining("Conditional lemma result:lemma.command:lemma-premise"),
      }),
    ]);
    const listed = await listLibrary(store, { sessionId: SESSION, layers: ["derived"] });
    expect(listed).toMatchObject({
      status: "found",
      artifacts: [{ id: "result:lemma.command:lemma-premise" }],
    });

    const retried = await extractConditionalLemma(store, store, SESSION, request, human, {
      definitions: DEFINITIONS,
    });
    expect(retried).toMatchObject({ status: "committed", replayed: true });
  });

  it("refuses a target that is not established below its node", async () => {
    const store = await session();
    await tryTheorem(store);
    expect(
      await extractConditionalLemma(
        store,
        store,
        SESSION,
        lemmaRequest("node:root", MAIN.id, "main"),
        human,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "lemma-not-closed" }] });
    expect(await listLibrary(store, { sessionId: SESSION, layers: ["derived"] })).toMatchObject({
      status: "found",
      artifacts: [],
    });
  });
});
