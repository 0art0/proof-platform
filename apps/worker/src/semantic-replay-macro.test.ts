import { describe, expect, it } from "vitest";
import { authoredMacroDefinition, authoredMoveTemplateSchema } from "@proof/moves/authoring";
import { PROPOSITION_SORT } from "@proof/mathjson-model";
import {
  actorSchema,
  createProofNodeSchema,
  semanticReplayStepRecordSchema,
  type ProofNode,
} from "@proof/protocol";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "./approved-catalog";
import { MACRO_ID, macroTemplate } from "./macro-move.testing";
import { InspectableMemoryProofStore as MemoryProofStore, key } from "./memory-proof-store.testing";
import {
  commitSemanticReplay,
  initializeProofSession,
  previewSemanticReplay,
} from "./proof-repository";
import { applyMoveChoice, recordSuggestions } from "./proof-http/shared";

/**
 * N45 acceptance: a branch containing a macro application replays as ONE step, re-applying the
 * approved macro onto a renamed target; the macro must be approved in the session's catalog.
 */

const human = actorSchema.parse({ kind: "human", id: "actor:human" });
const SESSION = "session:replay-macro";
const FIXED_TIME = new Date("2026-10-02T12:00:00.000Z");

function macroCatalog(): DefinitionCatalog {
  const parsed = authoredMoveTemplateSchema.parse(macroTemplate());
  const macro = authoredMacroDefinition(
    parsed,
    { status: "approved", reviewerId: "reviewer:test" },
    "test",
  );
  if (macro === undefined) throw new Error("The macro does not project.");
  return Object.freeze({
    moves: APPROVED_DEFINITIONS.moves,
    macros: [{ move: macro.definition, template: macro.template }],
    catalog: APPROVED_DEFINITIONS.catalog,
  });
}

const goal = (id: string, names: readonly [string, string, string]) => ({
  id,
  sequent: {
    context: {
      declarations: names.map((symbol) => ({
        id: `declaration:${id}:${symbol}`,
        symbol,
        sort: PROPOSITION_SORT,
        role: "universal-parameter",
      })),
      hypotheses: [],
    },
    conclusion: { expression: ["Implies", names[0], ["Implies", names[1], names[2]]] },
  },
});

/** A session whose two goals both have the macro's shape, the second under other names. */
async function macroSession(definitions: DefinitionCatalog) {
  const store = new MemoryProofStore();
  const rootNode = createProofNodeSchema().parse({
    id: "node:root",
    state: {
      id: "state:root",
      goals: [goal("goal:main", ["p", "q", "r"]), goal("goal:other", ["u", "v", "w"])],
      obligations: [],
    },
  });
  await initializeProofSession(store, { sessionId: SESSION, rootNode });
  const context = { store, definitions, now: undefined, library: undefined };
  const recorded = await recordSuggestions(context, SESSION, "suggestion-set:macro" as never, [
    {
      kind: "exact",
      anchor: {
        stateId: "state:root",
        target: { kind: "goal", id: "goal:main" },
        statement: { kind: "conclusion" },
      },
      path: [],
    } as never,
  ]);
  if (recorded.status !== "recorded") throw new Error(JSON.stringify(recorded));
  const offered = recorded.suggestionSet.suggestions.find(
    ({ artifactId }) => artifactId === MACRO_ID,
  );
  if (offered === undefined) throw new Error("The macro was not offered.");
  const applied = await applyMoveChoice(
    context,
    SESSION,
    {
      commandId: "command:macro",
      suggestionSetId: recorded.suggestionSet.id,
      chosenSuggestionId: offered.id,
    } as never,
    undefined,
    human as never,
  );
  if (applied.status !== "applied") throw new Error(JSON.stringify(applied));
  return { store, applied: applied.node as ProofNode };
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

const conclusions = (node: ProofNode) =>
  node.state.goals.map(({ sequent }) => sequent.conclusion.expression);

describe("replaying a macro application (N45)", () => {
  it("re-applies the approved macro as one step onto a renamed goal", async () => {
    const definitions = macroCatalog();
    const { store, applied } = await macroSession(definitions);
    // The macro ran on `goal:main`; its two edges carry one macro link.
    expect([...store.edges.values()].filter(({ macro }) => macro !== undefined)).toHaveLength(2);
    const request = { source: { fromNodeId: "node:root", toNodeId: applied.id } };

    const before = snapshot(store);
    const previewed = await previewSemanticReplay(store, SESSION, request, human, { definitions });
    expect(snapshot(store)).toBe(before);
    expect(previewed).toMatchObject({ status: "loaded", report: { complete: true } });
    if (previewed.status !== "loaded") return;
    // Two stored edges, one replay step.
    expect(previewed.report.steps).toHaveLength(1);
    expect(previewed.report.steps[0]).toMatchObject({
      source: "macro",
      status: "adapted",
      moveId: MACRO_ID,
      transitionClass: "equivalence",
      sourceEdgeId: expect.stringContaining("macro:1"),
    });
    expect(previewed.report.steps[0]?.commandIds).toHaveLength(2);
    expect(previewed.report.substitutions).toEqual([
      { symbol: "p", expression: "u" },
      { symbol: "q", expression: "v" },
      { symbol: "r", expression: "w" },
    ]);
    expect(conclusions(previewed.finalNode)).toEqual(["r", "w"]);

    const committed = await commitSemanticReplay(
      store,
      SESSION,
      {
        commandId: "command:replay-macro",
        actor: human,
        expectedCurrentNodeId: applied.id,
        ...request,
      },
      human,
      { definitions, now: () => FIXED_TIME },
    );
    expect(committed).toMatchObject({ status: "committed", replayed: false });
    if (committed.status !== "committed") return;
    expect(conclusions(committed.node)).toEqual(["r", "w"]);
    // Both hypotheses of the second goal were introduced, in order.
    expect(
      committed.node.state.goals[1]?.sequent.context.hypotheses.map(
        ({ statement }) => statement.expression,
      ),
    ).toEqual(["u", "v"]);

    // Ordinary validated commands: one per macro step, fresh evidence and consecutive sequences.
    expect(committed.receipts.map(({ commandId }) => commandId)).toEqual([
      "command:replay-macro:replay:1:macro:1",
      "command:replay-macro:replay:1",
    ]);
    const edges = committed.receipts.map(({ commandId }) =>
      [...store.edges.values()].find((edge) => edge.commandId === commandId),
    );
    expect(edges.map((edge) => edge?.moveId)).toEqual([
      "move:introduce-implication",
      "move:introduce-implication",
    ]);
    expect(edges.map((edge) => edge?.suggestionSetId)).toEqual([undefined, undefined]);
    expect(edges.map((edge) => edge?.sequence)).toEqual([
      edges[0]?.sequence as number satisfies number,
      (edges[0]?.sequence as number) + 1,
    ]);
    const record = store.replaySteps.get(key(SESSION, "command:replay-macro:replay:1"));
    expect(semanticReplayStepRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toMatchObject({
      count: 1,
      report: {
        source: "macro",
        commandIds: ["command:replay-macro:replay:1:macro:1", "command:replay-macro:replay:1"],
      },
    });

    // A retry replays both recorded commands.
    const retried = await commitSemanticReplay(
      store,
      SESSION,
      {
        commandId: "command:replay-macro",
        actor: human,
        expectedCurrentNodeId: applied.id,
        ...request,
      },
      human,
      { definitions },
    );
    expect(retried).toMatchObject({ status: "committed", replayed: true });
    if (retried.status === "committed") {
      expect(retried.receipts).toEqual(committed.receipts);
      expect(retried.report.steps).toEqual(committed.report.steps);
    }

    // The replayed application can itself be replayed, command by command, as raw operations.
    const again = await previewSemanticReplay(
      store,
      SESSION,
      {
        source: { fromNodeId: applied.id, toNodeId: committed.node.id },
        targetNodeId: "node:root",
      },
      human,
      { definitions },
    );
    expect(again).toMatchObject({ status: "loaded", report: { complete: true } });
    if (again.status === "loaded") {
      expect(again.report.steps.map(({ source }) => source)).toEqual([
        "raw-operation",
        "raw-operation",
      ]);
    }
  });

  it("fails the step, naming the macro and how to repair, when it is not approved", async () => {
    const definitions = macroCatalog();
    const { store, applied } = await macroSession(definitions);
    const request = { source: { fromNodeId: "node:root", toNodeId: applied.id } };
    const before = snapshot(store);
    // The target session's catalog does not approve the macro.
    const previewed = await previewSemanticReplay(store, SESSION, request, human);
    expect(snapshot(store)).toBe(before);
    expect(previewed).toMatchObject({
      status: "loaded",
      report: {
        complete: false,
        firstFailure: {
          index: 1,
          diagnostic: {
            code: "move-unavailable",
            message: expect.stringMatching(new RegExp(`${MACRO_ID}.*not approved.*Approve`)),
          },
        },
      },
    });
    if (previewed.status === "loaded") {
      expect(previewed.report.steps[0]).toMatchObject({ source: "macro", status: "failed" });
    }
    expect(
      await commitSemanticReplay(
        store,
        SESSION,
        {
          commandId: "command:replay-macro",
          actor: human,
          expectedCurrentNodeId: applied.id,
          ...request,
        },
        human,
      ),
    ).toMatchObject({ status: "replay-failed", report: { complete: false } });
    expect(snapshot(store)).toBe(before);
  });

  it("replays a path that starts inside a macro application as raw operations", async () => {
    const definitions = macroCatalog();
    const { store, applied } = await macroSession(definitions);
    const middle = [...store.edges.values()].find(
      ({ macro }) => macro?.stepIndex === 1,
    )?.childNodeId;
    const previewed = await previewSemanticReplay(
      store,
      SESSION,
      { source: { fromNodeId: middle as string, toNodeId: applied.id } },
      human,
      { definitions },
    );
    expect(previewed).toMatchObject({ status: "loaded" });
    if (previewed.status !== "loaded") return;
    expect(previewed.report.steps.map(({ source }) => source)).toEqual(["raw-operation"]);
  });
});
