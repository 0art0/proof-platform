import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { alphaEquivalent } from "@proof/kernel";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  HAND_AUTHORED_MOVES,
  commandIdGenerator,
  materializeMoveOperation,
  type MoveSelectionInput,
} from "@proof/moves";
import { createRetrievalIndex, type RetrievalIndex } from "@proof/retrieval";
import {
  actorSchema,
  deriveMacroStep,
  deriveOperationStep,
  deriveSemanticStep,
  planSemanticReplay,
  prepareDisplayedSuggestionSet,
  prepareProofCommand,
  proofNodeIdSchema,
  semanticOperationStepSchema,
  semanticReplayReportSchema,
  semanticStepSchema,
  type DisplayedSuggestionSet,
  type ProofEdge,
  type ProofNode,
  type SemanticReplayInput,
  type SemanticReplaySourceStep,
  type SemanticStep,
} from "./index";

const human = actorSchema.parse({ id: "actor:human", kind: "human" });

function retrievalIndex(): RetrievalIndex {
  const created = createRetrievalIndex({
    results: [],
    moves: HAND_AUTHORED_MOVES,
    variantFamilies: [],
  });
  if (!created.ok) throw new Error(created.diagnostics[0].message);
  return created.index;
}
const INDEX = retrievalIndex();

const recordIds = (commandId: string) => ({
  resultNodeId: `node:${commandId}`,
  edgeId: `edge:${commandId}`,
  eventId: `event:${commandId}`,
  resultStateId: `state:${commandId}`,
});

function rootNode(
  nodeId: string,
  goalId: string,
  symbols: readonly string[],
  conclusion: PlainMathJson,
  hypotheses: readonly Readonly<{ id: string; expression: PlainMathJson }>[] = [],
): ProofNode {
  return {
    id: proofNodeIdSchema.parse(nodeId),
    state: executableProofStateSchema.parse({
      id: `state:${nodeId}`,
      goals: [
        {
          id: goalId,
          sequent: {
            context: {
              declarations: symbols.map((symbol) => ({
                id: `declaration:${symbol}`,
                symbol,
                sort: PROPOSITION_SORT,
                role: "universal-parameter",
              })),
              hypotheses: hypotheses.map(({ id, expression }) => ({
                id,
                statement: { expression },
              })),
            },
            conclusion: { expression: conclusion },
          },
        },
      ],
      obligations: [],
    }),
  };
}

type SlotRef = Readonly<{ target: string; statement?: string; path?: readonly number[] }>;

/**
 * A source branch built like the worker builds one: a displayed suggestion set, a chosen move
 * suggestion, menu choices, and a command validated by `prepareProofCommand` with that evidence.
 */
class Branch {
  readonly nodes: ProofNode[];
  readonly edges: ProofEdge[] = [];
  readonly sets = new Map<string, DisplayedSuggestionSet>();

  constructor(root: ProofNode) {
    this.nodes = [root];
  }

  get leaf(): ProofNode {
    return this.nodes.at(-1) as ProofNode;
  }

  apply(
    commandId: string,
    moveId: string,
    slots: readonly SlotRef[],
    choose: Readonly<Record<string, (value: unknown) => boolean>> = {},
  ): this {
    const parent = this.leaf;
    const anchors = slots.map((slot) => ({
      kind: "exact" as const,
      anchor: {
        stateId: parent.state.id,
        target: { kind: "goal" as const, id: slot.target },
        statement:
          slot.statement === undefined
            ? { kind: "conclusion" as const }
            : { kind: "hypothesis" as const, id: slot.statement },
      },
      path: [...(slot.path ?? [])],
    }));
    const selection =
      anchors.length === 1
        ? anchors[0]
        : {
            kind: "selection-query",
            selections: anchors.map((item, index) => ({
              id: `selection:${index + 1}`,
              selection: item,
            })),
          };
    const prepared = prepareDisplayedSuggestionSet(INDEX, parent, {
      id: `set:${commandId}`,
      selection,
      options: { limit: 100 },
    });
    if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
    const set = prepared.suggestionSet;
    const chosen = set.suggestions.find(({ artifactId }) => artifactId === moveId);
    if (chosen === undefined) {
      throw new Error(
        `${moveId} not suggested: ${set.suggestions.map((item) => item.artifactId).join(", ")}`,
      );
    }
    const move = HAND_AUTHORED_MOVES.find(({ id }) => id === moveId);
    if (move === undefined) throw new Error(`unknown ${moveId}`);
    const selections: Record<string, MoveSelectionInput> = {};
    for (const match of chosen.selectionMatches) {
      const resolved =
        set.selection.kind === "selection-query"
          ? set.selection.selections.find(({ id }) => id === match.selectionId)?.selection
          : set.selection;
      if (
        resolved === undefined ||
        resolved.kind !== "exact" ||
        match.selectionSlotId === undefined
      ) {
        throw new Error("unexpected selection");
      }
      selections[match.selectionSlotId] = {
        kind: "exact",
        anchor: resolved.anchor,
        path: resolved.path,
      };
    }
    const choices: Record<string, string> = {};
    let materialized = materializeMoveOperation({
      state: parent.state,
      move,
      selections,
      menuChoices: choices,
      idGenerator: commandIdGenerator(commandId),
    });
    while (!materialized.ok && materialized.diagnostics[0].code === "requires-input") {
      for (const parameterId of materialized.missingParameters) {
        const item = materialized.menus
          .find((menu) => menu.parameterId === parameterId)
          ?.items.find(({ value }) => choose[parameterId]?.(value) ?? false);
        if (item === undefined) throw new Error(`no choice for ${parameterId}`);
        choices[parameterId] = item.id;
      }
      materialized = materializeMoveOperation({
        state: parent.state,
        move,
        selections,
        menuChoices: choices,
        idGenerator: commandIdGenerator(commandId),
      });
    }
    if (!materialized.ok) throw new Error(materialized.diagnostics[0].message);
    const menuSelection =
      Object.keys(choices).length === 0 && materialized.menus.every(({ automatic }) => automatic)
        ? undefined
        : { menus: materialized.menus, choices };
    const ids = recordIds(commandId);
    const result = prepareProofCommand(
      parent,
      {
        commandId,
        kind: "apply-kernel-operation",
        actor: human,
        parentNodeId: parent.id,
        resultNodeId: ids.resultNodeId,
        edgeId: ids.edgeId,
        eventId: ids.eventId,
        moveId,
        suggestionSetId: set.id,
        chosenSuggestionId: chosen.id,
        operation: materialized.operation,
        ...(menuSelection === undefined ? {} : { menuSelection }),
      },
      { trustedActor: human, suggestionSet: set },
    );
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    this.nodes.push(result.prepared.node);
    this.edges.push(result.prepared.edge);
    this.sets.set(set.id, set);
    return this;
  }

  steps(): SemanticReplaySourceStep[] {
    return this.edges.map((edge) => {
      const derived = deriveSemanticStep({
        parent: this.nodes.find(({ id }) => id === edge.parentNodeId) as ProofNode,
        child: this.nodes.find(({ id }) => id === edge.childNodeId) as ProofNode,
        edge,
        ...(edge.suggestionSetId === undefined
          ? {}
          : { suggestionSet: this.sets.get(edge.suggestionSetId) as DisplayedSuggestionSet }),
      });
      if (!derived.ok) throw new Error(derived.diagnostics[0].message);
      return { sourceEdgeId: edge.id, step: derived.step };
    });
  }
}

const SWAP = ["Implies", ["And", "p", "q"], ["And", "q", "p"]] as const;

/** (p ∧ q) ⇒ (q ∧ p): introduce, expand, split, and close the first conjunct. */
function swapBranch(): Branch {
  return new Branch(
    rootNode("node:source", "goal:main", ["p", "q"], SWAP as unknown as PlainMathJson),
  )
    .apply("c1", "move:introduce-implication", [{ target: "goal:main" }])
    .apply("c2", "move:expand-hypothesis-conjunction", [
      { target: "goal:main", statement: "statement:c1:hypothesis:1" },
    ])
    .apply("c3", "move:split-goal-conjunction", [{ target: "goal:main" }])
    .apply("c4", "move:close-by-hypothesis", [
      { target: "statement:c3:child:1" },
      { target: "statement:c3:child:1", statement: "statement:c2:expanded-hypothesis:2" },
    ]);
}

function replayInput(
  steps: readonly SemanticReplaySourceStep[],
  target: ProofNode,
  overrides: Partial<SemanticReplayInput> = {},
): SemanticReplayInput {
  return {
    steps,
    target,
    commandId: "replay",
    actor: human,
    recordIds,
    moves: HAND_AUTHORED_MOVES,
    ...overrides,
  };
}

function rename(expression: PlainMathJson, names: Readonly<Record<string, string>>): PlainMathJson {
  if (typeof expression === "string") return names[expression] ?? expression;
  if (Array.isArray(expression)) {
    return expression.map((item) =>
      rename(item as PlainMathJson, names),
    ) as unknown as PlainMathJson;
  }
  return expression;
}

describe("deriveSemanticStep", () => {
  it("describes selections by statement role and fragment, and parameters by menu origin", () => {
    const branch = new Branch(
      rootNode("node:source", "goal:main", ["p", "q"], ["Or", "q", ["And", "p", "q"]]),
    ).apply("c1", "move:choose-goal-disjunct", [{ target: "goal:main" }], {
      disjunctIndex: (value) =>
        JSON.stringify(value) === JSON.stringify({ kind: "index", index: 1 }),
    });
    const [source] = branch.steps();
    expect(source?.step).toMatchObject({
      moveId: "move:choose-goal-disjunct",
      source: "move",
      selections: [
        {
          slotId: "target",
          target: { kind: "goal", id: "goal:main" },
          statement: { role: "conclusion" },
          occurrence: { kind: "exact", path: [] },
          fragment: ["Or", "q", ["And", "p", "q"]],
          variables: [
            { symbol: "p", sort: PROPOSITION_SORT },
            { symbol: "q", sort: PROPOSITION_SORT },
          ],
        },
      ],
      parameters: [
        {
          parameterId: "disjunctIndex",
          origin: { kind: "subterm-of", statement: { kind: "conclusion" }, path: [1] },
          value: { kind: "index", index: 1 },
        },
      ],
      transitionClass: "strengthening",
      obligations: [],
    });
    expect(semanticStepSchema.safeParse(source?.step).success).toBe(true);
    expect(Object.isFrozen(source?.step)).toBe(true);
  });

  it("refuses a step that was not applied from a displayed suggestion", () => {
    const branch = swapBranch();
    const edge = branch.edges[0] as ProofEdge;
    const bare = { ...edge };
    delete bare.suggestionSetId;
    delete bare.chosenSuggestionId;
    expect(
      deriveSemanticStep({
        parent: branch.nodes[0] as ProofNode,
        child: branch.nodes[1] as ProofNode,
        edge: bare,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "step-not-replayable" }] });
  });
});

describe("planSemanticReplay", () => {
  it("replays a sequence exactly onto an identical state with fresh records", () => {
    const branch = swapBranch();
    const target = rootNode(
      "node:target",
      "goal:main",
      ["p", "q"],
      SWAP as unknown as PlainMathJson,
    );
    const result = planSemanticReplay(replayInput(branch.steps(), target));
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(semanticReplayReportSchema.safeParse(result.report).success).toBe(true);
    expect(result.report).toMatchObject({ complete: true, substitutions: [] });
    expect(result.report.steps.map(({ status }) => status)).toEqual([
      "exact",
      "exact",
      "exact",
      "exact",
    ]);
    expect(result.replayed.map(({ prepared }) => prepared.receipt.commandId)).toEqual([
      "replay:replay:1",
      "replay:replay:2",
      "replay:replay:3",
      "replay:replay:4",
    ]);
    // Same goals as the source branch; every record is fresh.
    expect(
      result.finalNode.state.goals.map(({ sequent }) => sequent.conclusion.expression),
    ).toEqual(branch.leaf.state.goals.map(({ sequent }) => sequent.conclusion.expression));
    expect(result.finalNode.id).toBe("node:replay:replay:4");
    expect(
      result.replayed.every(({ prepared }) => prepared.prepared.edge.suggestionSetId === undefined),
    ).toBe(true);
  });

  it("adapts to an alpha-renamed state with changed substitutions and carried identities", () => {
    const branch = swapBranch();
    const target = rootNode(
      "node:target",
      "goal:other",
      ["a", "b"],
      rename(SWAP as unknown as PlainMathJson, { p: "a", q: "b" }),
    );
    const result = planSemanticReplay(replayInput(branch.steps(), target));
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report.complete).toBe(true);
    expect(result.report.substitutions).toEqual([
      { symbol: "p", expression: "a" },
      { symbol: "q", expression: "b" },
    ]);
    expect(result.report.steps.map(({ status }) => status)).toEqual([
      "adapted",
      "exact",
      "exact",
      "exact",
    ]);
    expect(result.report.steps[0]?.substitutions).toEqual([
      { symbol: "p", expression: "a" },
      { symbol: "q", expression: "b" },
    ]);
    // The first conjunct `b` is closed by the expanded hypothesis `b`; `a` remains.
    expect(
      result.finalNode.state.goals.map(({ sequent }) => sequent.conclusion.expression),
    ).toEqual(["a"]);
    // Each recorded plan is in the replayed branch's terms and can itself be replayed.
    expect(result.replayed[0]?.plan.selections[0]).toMatchObject({
      target: { kind: "goal", id: "goal:other" },
      fragment: ["Implies", ["And", "a", "b"], ["And", "b", "a"]],
      variables: [
        { symbol: "a", sort: PROPOSITION_SORT },
        { symbol: "b", sort: PROPOSITION_SORT },
      ],
    });
  });

  it("is invariant under alpha-renaming of the target's symbols and identities", () => {
    const branch = swapBranch();
    const steps = branch.steps();
    const names = fc
      .stringMatching(/^[a-z][a-z0-9]{0,5}$/)
      .filter((name) => !["p", "q", "e", "i"].includes(name));
    fc.assert(
      fc.property(
        fc.uniqueArray(names, { minLength: 2, maxLength: 2 }),
        fc.stringMatching(/^goal:[a-z]{1,8}$/),
        fc.boolean(),
        ([first, second], goalId, shuffle) => {
          const names = { p: first as string, q: second as string };
          const symbols = shuffle ? [names.q, names.p] : [names.p, names.q];
          const target = rootNode(
            "node:target",
            goalId,
            symbols,
            rename(SWAP as unknown as PlainMathJson, names),
          );
          const result = planSemanticReplay(replayInput(steps, target));
          if (!result.ok || !result.report.complete) return false;
          const expected = branch.leaf.state.goals.map(({ sequent }) =>
            rename(sequent.conclusion.expression, names),
          );
          const actual = result.finalNode.state.goals.map(
            ({ sequent }) => sequent.conclusion.expression,
          );
          return (
            actual.length === expected.length &&
            actual.every((expression, index) =>
              alphaEquivalent(expression, expected[index] as PlainMathJson),
            ) &&
            result.report.substitutions.every(
              ({ symbol, expression }) => expression === names[symbol as "p" | "q"],
            )
          );
        },
      ),
      { numRuns: 40 },
    );
  });

  it("adapts to a perturbed state with extra context and a renamed hypothesis", () => {
    const branch = swapBranch();
    const target = rootNode(
      "node:target",
      "goal:other",
      ["r", "a", "b"],
      ["Implies", ["And", "a", ["Or", "r", "b"]], ["And", ["Or", "r", "b"], "a"]],
      [{ id: "hypothesis:extra", expression: ["Or", "r", "r"] }],
    );
    const result = planSemanticReplay(replayInput(branch.steps(), target));
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report.complete).toBe(true);
    expect(result.report.substitutions).toEqual([
      { symbol: "p", expression: "a" },
      { symbol: "q", expression: ["Or", "r", "b"] },
    ]);
    expect(
      result.finalNode.state.goals.map(({ sequent }) => sequent.conclusion.expression),
    ).toEqual(["a"]);
  });

  it("reports the first failing step with candidate repairs and replays nothing after it", () => {
    const branch = swapBranch();
    // The conclusion is no longer a swap: `(a ∧ b) ⇒ (a ∧ b)`.
    const target = rootNode(
      "node:target",
      "goal:other",
      ["a", "b"],
      ["Implies", ["And", "a", "b"], ["And", "a", "b"]],
    );
    const result = planSemanticReplay(replayInput(branch.steps(), target));
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(semanticReplayReportSchema.safeParse(result.report).success).toBe(true);
    expect(result.report).toMatchObject({
      complete: false,
      finalNodeId: "node:target",
      firstFailure: {
        index: 1,
        diagnostic: { code: "no-matching-selection" },
        repairs: [
          {
            slotId: "target",
            candidates: [
              {
                id: "goal:goal:other/conclusion/exact:",
                match: "shape",
                fragment: ["Implies", ["And", "a", "b"], ["And", "a", "b"]],
              },
            ],
          },
        ],
      },
    });
    expect(result.report.steps.map(({ status }) => status)).toEqual([
      "failed",
      "not-attempted",
      "not-attempted",
      "not-attempted",
    ]);
    expect(result.replayed).toEqual([]);

    // Forcing the listed repair replays the introduction without binding anything. The
    // expansion then binds p ↦ a and q ↦ b, so the swapped conjunction `q ∧ p` conflicts with
    // the target's `a ∧ b`: step 3 fails and lists that occurrence as a repair.
    const introduction = {
      stepIndex: 1,
      slotId: "target",
      candidateId: "goal:goal:other/conclusion/exact:",
    };
    const repaired = planSemanticReplay(
      replayInput(branch.steps(), target, { overrides: [introduction] }),
    );
    if (!repaired.ok) throw new Error(repaired.diagnostics[0].message);
    expect(repaired.report.steps.map(({ status }) => status)).toEqual([
      "adapted",
      "adapted",
      "failed",
      "not-attempted",
    ]);
    expect(repaired.report.steps[1]?.substitutions).toEqual([
      { symbol: "p", expression: "a" },
      { symbol: "q", expression: "b" },
    ]);
    expect(repaired.report.firstFailure).toMatchObject({
      index: 3,
      diagnostic: { code: "no-matching-selection" },
      repairs: [
        {
          slotId: "target",
          candidates: [{ id: "goal:goal:other/conclusion/exact:", match: "conflict" }],
        },
      ],
    });
    expect(repaired.report.finalNodeId).toBe("node:replay:replay:2");

    // Forcing that repair too splits `a ∧ b`. The closing step's target `q` corresponds to `b`,
    // which is now the second case, so it is re-matched there.
    const completed = planSemanticReplay(
      replayInput(branch.steps(), target, {
        overrides: [
          introduction,
          { stepIndex: 3, slotId: "target", candidateId: "goal:goal:other/conclusion/exact:" },
        ],
      }),
    );
    if (!completed.ok) throw new Error(completed.diagnostics[0].message);
    expect(completed.report.complete).toBe(true);
    expect(completed.report.steps[3]?.selections[0]?.candidate).toMatchObject({
      target: { kind: "goal", id: "statement:replay:replay:3:child:2" },
      match: "identical",
    });
    expect(
      completed.finalNode.state.goals.map(({ sequent }) => sequent.conclusion.expression),
    ).toEqual(["a"]);
  });

  it("rejects an override that names no listed candidate", () => {
    const branch = swapBranch();
    const target = rootNode(
      "node:target",
      "goal:main",
      ["p", "q"],
      SWAP as unknown as PlainMathJson,
    );
    const result = planSemanticReplay(
      replayInput(branch.steps(), target, {
        overrides: [
          {
            stepIndex: 2,
            slotId: "conjunction",
            candidateId: "goal:goal:main/hypothesis:missing/exact:",
          },
        ],
      }),
    );
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report.firstFailure).toMatchObject({
      index: 2,
      diagnostic: { code: "invalid-override" },
    });
    expect(result.replayed).toHaveLength(1);
  });

  it("fails a step with no plan without attempting later ones", () => {
    const branch = swapBranch();
    const steps = branch.steps();
    const target = rootNode(
      "node:target",
      "goal:main",
      ["p", "q"],
      SWAP as unknown as PlainMathJson,
    );
    const result = planSemanticReplay(
      replayInput(
        [
          steps[0] as SemanticReplaySourceStep,
          { sourceEdgeId: "edge:kernel", unavailable: "No selections." },
        ],
        target,
      ),
    );
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report).toMatchObject({
      complete: false,
      finalNodeId: "node:replay:replay:1",
      firstFailure: {
        index: 2,
        diagnostic: { code: "step-not-replayable", message: "No selections." },
      },
    });
  });

  it("chooses menu parameters again by value under the correspondence, or by origin", () => {
    const disjunct = new Branch(
      rootNode("node:source", "goal:main", ["p", "q"], ["Or", "q", ["And", "p", "q"]]),
    ).apply("c1", "move:choose-goal-disjunct", [{ target: "goal:main" }], {
      disjunctIndex: (value) =>
        JSON.stringify(value) === JSON.stringify({ kind: "index", index: 1 }),
    });
    const renamed = planSemanticReplay(
      replayInput(
        disjunct.steps(),
        rootNode("node:target", "goal:x", ["a", "b"], ["Or", "b", ["And", "a", "b"]]),
      ),
    );
    if (!renamed.ok) throw new Error(renamed.diagnostics[0].message);
    expect(renamed.report.complete).toBe(true);
    expect(renamed.finalNode.state.goals[0]?.sequent.conclusion.expression).toEqual([
      "And",
      "a",
      "b",
    ]);
    expect(renamed.report.steps[0]?.parameters).toEqual([]);

    // The case proposition `p` is the subterm at [0]; under p ↦ ¬a the same value is `¬a`.
    const bySubterm = new Branch(
      rootNode("node:source", "goal:main", ["p", "q"], ["Implies", "p", "q"]),
    ).apply("c1", "move:split-classical-cases", [{ target: "goal:main" }], {
      proposition: (value) =>
        JSON.stringify(value) === JSON.stringify({ kind: "proposition", expression: "p" }),
    });
    const byValue = planSemanticReplay(
      replayInput(
        bySubterm.steps(),
        rootNode("node:target", "goal:x", ["a", "b"], ["Implies", ["Not", "a"], "b"]),
      ),
    );
    if (!byValue.ok) throw new Error(byValue.diagnostics[0].message);
    expect(byValue.report.complete).toBe(true);
    expect(byValue.report.steps[0]).toMatchObject({
      status: "adapted",
      substitutions: [
        { symbol: "p", expression: ["Not", "a"] },
        { symbol: "q", expression: "b" },
      ],
      parameters: [
        {
          parameterId: "proposition",
          match: "value",
          from: { kind: "proposition", expression: "p" },
          to: { kind: "proposition", expression: ["Not", "a"] },
        },
      ],
    });

    // The case proposition was the unselected hypothesis `r`: nothing maps r, so the item from
    // the corresponding hypothesis is chosen, and r ↦ s is learned from it.
    const byHypothesis = new Branch(
      rootNode("node:source", "goal:main", ["q", "r"], "q", [
        { id: "hypothesis:h", expression: "r" },
      ]),
    ).apply("c1", "move:split-classical-cases", [{ target: "goal:main" }], {
      proposition: (value) =>
        JSON.stringify(value) === JSON.stringify({ kind: "proposition", expression: "r" }),
    });
    const byOrigin = planSemanticReplay(
      replayInput(
        byHypothesis.steps(),
        rootNode("node:target", "goal:x", ["b", "s"], "b", [
          { id: "hypothesis:h", expression: "s" },
        ]),
      ),
    );
    if (!byOrigin.ok) throw new Error(byOrigin.diagnostics[0].message);
    expect(byOrigin.report.complete).toBe(true);
    expect(byOrigin.report.steps[0]).toMatchObject({
      status: "adapted",
      substitutions: [
        { symbol: "q", expression: "b" },
        { symbol: "r", expression: "s" },
      ],
      parameters: [
        {
          parameterId: "proposition",
          match: "origin",
          from: { kind: "proposition", expression: "r" },
          to: { kind: "proposition", expression: "s" },
        },
      ],
    });
  });
});

// --------------------------------------------------------------------------------------------
// N45: steps applied without a displayed suggestion
// --------------------------------------------------------------------------------------------

/** A branch of raw kernel operations: no suggestion, no preview, optionally a move ID. */
class RawBranch {
  readonly nodes: ProofNode[];
  readonly edges: ProofEdge[] = [];
  readonly origins = new Map<string, "backtrack" | "raw-operation">();

  constructor(root: ProofNode) {
    this.nodes = [root];
  }

  get leaf(): ProofNode {
    return this.nodes.at(-1) as ProofNode;
  }

  apply(
    commandId: string,
    operation: Record<string, unknown>,
    options: { moveId?: string; origin?: "backtrack" | "raw-operation" } = {},
  ): this {
    const parent = this.leaf;
    const ids = recordIds(commandId);
    const result = prepareProofCommand(
      parent,
      {
        commandId,
        kind: "apply-kernel-operation",
        actor: human,
        parentNodeId: parent.id,
        resultNodeId: ids.resultNodeId,
        edgeId: ids.edgeId,
        eventId: ids.eventId,
        ...(options.moveId === undefined ? {} : { moveId: options.moveId }),
        operation: {
          ...operation,
          expectedStateId: parent.state.id,
          resultStateId: ids.resultStateId,
        },
      },
      { trustedActor: human },
    );
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    this.nodes.push(result.prepared.node);
    this.edges.push(result.prepared.edge);
    this.origins.set(result.prepared.edge.id, options.origin ?? "raw-operation");
    return this;
  }

  steps(): SemanticReplaySourceStep[] {
    return this.edges.map((edge) => {
      const derived = deriveOperationStep({
        parent: this.nodes.find(({ id }) => id === edge.parentNodeId) as ProofNode,
        child: this.nodes.find(({ id }) => id === edge.childNodeId) as ProofNode,
        edge,
        origin: this.origins.get(edge.id) as "backtrack" | "raw-operation",
      });
      if (!derived.ok) throw new Error(derived.diagnostics[0].message);
      return { sourceEdgeId: edge.id, step: derived.step };
    });
  }
}

const goalTarget = (id: string) => ({ kind: "goal", id });

/** A case split on the goal's own conclusion (the backtracking shape), then its auto-close. */
function backtrackBranch(conclusion: PlainMathJson, symbols: readonly string[]): RawBranch {
  return new RawBranch(rootNode("node:source", "goal:main", symbols, conclusion))
    .apply(
      "b1",
      {
        kind: "split-classical-cases",
        target: goalTarget("goal:main"),
        proposition: conclusion,
        childIds: ["statement:b1:case:1", "statement:b1:case:2"],
        branchHypothesisIds: ["statement:b1:hypothesis:1", "statement:b1:hypothesis:2"],
      },
      { origin: "backtrack" },
    )
    .apply(
      "b1:auto-close",
      {
        kind: "close-by-hypothesis",
        target: goalTarget("statement:b1:case:1"),
        hypothesisId: "statement:b1:hypothesis:1",
      },
      { origin: "backtrack" },
    );
}

/** (p ∧ q) ⇒ (q ∧ p) by raw operations: introduce, expand, split, close the first conjunct. */
function rawSwapBranch(): RawBranch {
  return new RawBranch(
    rootNode("node:source", "goal:main", ["p", "q"], SWAP as unknown as PlainMathJson),
  )
    .apply("r1", {
      kind: "introduce-implication",
      target: goalTarget("goal:main"),
      hypothesisId: "statement:r1:hypothesis",
    })
    .apply("r2", {
      kind: "expand-hypothesis-conjunction",
      target: goalTarget("goal:main"),
      hypothesisId: "statement:r1:hypothesis",
      expandedHypothesisIds: ["statement:r2:left", "statement:r2:right"],
    })
    .apply("r3", {
      kind: "split-goal-conjunction",
      target: goalTarget("goal:main"),
      childIds: ["statement:r3:first", "statement:r3:second"],
    })
    .apply("r4", {
      kind: "close-by-hypothesis",
      target: goalTarget("statement:r3:first"),
      hypothesisId: "statement:r2:right",
    });
}

const IMPLIES_QP = ["Implies", "q", "p"] as unknown as PlainMathJson;

describe("deriveOperationStep", () => {
  it("describes a backtracking split and auto-close by the target pattern and named hypotheses", () => {
    const steps = backtrackBranch(IMPLIES_QP, ["p", "q"]).steps();
    const [split, close] = steps.map(({ step }) => step);
    expect(semanticOperationStepSchema.safeParse(split).success).toBe(true);
    expect(split).toMatchObject({
      source: "operation",
      origin: "backtrack",
      transitionClass: "equivalence",
      referenced: [],
      selections: [
        {
          slotId: "target",
          target: { kind: "goal", id: "goal:main" },
          statement: { role: "conclusion" },
          occurrence: { kind: "exact", path: [] },
          fragment: IMPLIES_QP,
          variables: [
            { symbol: "p", sort: PROPOSITION_SORT },
            { symbol: "q", sort: PROPOSITION_SORT },
          ],
        },
      ],
    });
    // "Close the case whose goal is the case hypothesis": the target and the hypothesis agree.
    expect(close).toMatchObject({
      origin: "backtrack",
      referenced: ["statement:b1:hypothesis:1"],
      selections: [
        { slotId: "target", target: { kind: "goal", id: "statement:b1:case:1" } },
        {
          slotId: "ref:1",
          statement: { role: "hypothesis", id: "statement:b1:hypothesis:1" },
          fragment: IMPLIES_QP,
        },
      ],
    });
    expect(Object.isFrozen(split)).toBe(true);
  });

  it("names the hypotheses and the rewritten occurrence of a raw operation", () => {
    const [, expand] = rawSwapBranch().steps();
    expect(expand?.step).toMatchObject({
      source: "operation",
      origin: "raw-operation",
      referenced: ["statement:r1:hypothesis"],
      selections: [
        { slotId: "target", statement: { role: "conclusion" } },
        { slotId: "ref:1", statement: { role: "hypothesis", id: "statement:r1:hypothesis" } },
      ],
    });
    const branch = new RawBranch(
      rootNode(
        "node:source",
        "goal:main",
        ["p", "q"],
        ["Or", "p", "q"] as unknown as PlainMathJson,
        [{ id: "statement:equivalence", expression: ["Equivalent", "p", "q"] as never }],
      ),
    ).apply("rw", {
      kind: "rewrite-with-equivalence",
      target: goalTarget("goal:main"),
      statement: { kind: "conclusion" },
      path: [0],
      source: { kind: "hypothesis", hypothesisId: "statement:equivalence" },
      direction: "forward",
    });
    expect(branch.steps()[0]?.step).toMatchObject({
      referenced: ["statement:equivalence"],
      selections: [
        { slotId: "target", occurrence: { kind: "exact", path: [0] }, fragment: "p" },
        { slotId: "ref:1", statement: { role: "hypothesis", id: "statement:equivalence" } },
      ],
    });
  });

  it("refuses snapshots that do not belong to the edge, and an unknown target", () => {
    const branch = rawSwapBranch();
    const edge = branch.edges[0] as ProofEdge;
    expect(
      deriveOperationStep({
        parent: branch.nodes[1] as ProofNode,
        child: branch.nodes[2] as ProofNode,
        edge,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "step-not-replayable" }] });
    const bare = rootNode("node:other", "goal:other", ["p"], "p");
    expect(
      deriveOperationStep({
        parent: bare,
        child: bare,
        edge: { ...edge, parentNodeId: bare.id, childNodeId: bare.id },
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "step-not-replayable" }] });
  });
});

describe("deriveMacroStep", () => {
  it("refuses edges that are not one complete, consecutive macro application", () => {
    const branch = swapBranch();
    const edges = branch.edges.slice(0, 2);
    const set = branch.sets.get(edges[0]?.suggestionSetId as string) as DisplayedSuggestionSet;
    const result = deriveMacroStep({
      parent: branch.nodes[0] as ProofNode,
      child: branch.nodes[2] as ProofNode,
      edges,
      preview: {
        id: "preview:none",
        suggestionSetId: set.id,
        chosenSuggestionId: edges[0]?.chosenSuggestionId as string,
      },
      suggestionSet: set,
    });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "step-not-replayable" }] });
    expect(
      deriveMacroStep({
        parent: branch.nodes[0] as ProofNode,
        child: branch.nodes[1] as ProofNode,
        edges: branch.edges.slice(0, 1),
        preview: { id: "preview:none", suggestionSetId: set.id, chosenSuggestionId: "x" },
        suggestionSet: set,
      }),
    ).toMatchObject({ ok: false });
  });

  it("accepts a macro field only on a move step", () => {
    const [first] = swapBranch().steps();
    const plan = first?.step as SemanticStep;
    const withMacro = {
      ...plan,
      macro: {
        steps: [
          { id: "step-one", moveId: plan.moveId, operation: plan.operation },
          { id: "step-two", moveId: plan.moveId, operation: plan.operation },
        ],
      },
    };
    expect(semanticStepSchema.safeParse(withMacro).success).toBe(true);
    expect(semanticStepSchema.safeParse({ ...withMacro, source: "result" }).success).toBe(false);
  });
});

describe("planSemanticReplay over steps without a suggestion", () => {
  const rawTarget = (
    goalId: string,
    names: Readonly<Record<string, string>>,
    extra: string[] = [],
  ) =>
    rootNode(
      "node:target",
      goalId,
      [...Object.values(names), ...extra],
      rename(SWAP as unknown as PlainMathJson, names),
    );

  it("replays a backtracking split and auto-close exactly, as backtracking steps", () => {
    const branch = backtrackBranch(IMPLIES_QP, ["p", "q"]);
    const target = rootNode("node:target", "goal:main", ["p", "q"], IMPLIES_QP);
    const result = planSemanticReplay(replayInput(branch.steps(), target));
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(semanticReplayReportSchema.safeParse(result.report).success).toBe(true);
    expect(result.report).toMatchObject({ complete: true, substitutions: [] });
    expect(result.report.steps.map(({ status, source }) => [status, source])).toEqual([
      ["exact", "backtrack"],
      ["exact", "backtrack"],
    ]);
    expect(result.replayed.map(({ prepared }) => prepared.receipt.commandId)).toEqual([
      "replay:replay:1",
      "replay:replay:2",
    ]);
    // The case assuming the proposition is closed; the other case remains, assuming its negation.
    const [open, ...rest] = result.finalNode.state.goals;
    expect(rest).toEqual([]);
    expect(open?.sequent.context.hypotheses.map(({ statement }) => statement.expression)).toEqual([
      ["Not", IMPLIES_QP],
    ]);
    expect(result.report.steps[1]?.selections.map(({ slotId }) => slotId)).toEqual([
      "target",
      "ref:1",
    ]);
    // The plans are recorded in the replayed branch's terms and stay operation plans.
    expect(result.replayed.every(({ plan }) => plan.source === "operation")).toBe(true);
  });

  it("re-matches the split proposition on a renamed target and reports the adaptation", () => {
    const branch = backtrackBranch(IMPLIES_QP, ["p", "q"]);
    const target = rootNode("node:target", "goal:other", ["a", "b"], [
      "Implies",
      "b",
      "a",
    ] as never);
    const result = planSemanticReplay(replayInput(branch.steps(), target));
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report.complete).toBe(true);
    expect(result.report.substitutions).toEqual([
      { symbol: "q", expression: "b" },
      { symbol: "p", expression: "a" },
    ]);
    expect(result.report.steps.map(({ status }) => status)).toEqual(["adapted", "exact"]);
    const split = result.replayed[0]?.prepared.prepared.edge.operation;
    expect(split).toMatchObject({
      kind: "split-classical-cases",
      proposition: ["Implies", "b", "a"],
      target: { kind: "goal", id: "goal:other" },
    });
    expect(
      result.finalNode.state.goals[0]?.sequent.context.hypotheses.map(
        ({ statement }) => statement.expression,
      ),
    ).toEqual([["Not", ["Implies", "b", "a"]]]);
  });

  it("fails a backtracking step whose target no longer matches, with repair candidates", () => {
    const branch = backtrackBranch(IMPLIES_QP, ["p", "q"]);
    const target = rootNode("node:target", "goal:main", ["p", "q"], ["Or", "p", "q"] as never);
    const result = planSemanticReplay(replayInput(branch.steps(), target));
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report).toMatchObject({
      complete: false,
      firstFailure: { index: 1, diagnostic: { code: "no-matching-selection" } },
    });
    expect(result.report.steps.map(({ status, source }) => [status, source])).toEqual([
      ["failed", "backtrack"],
      ["not-attempted", "backtrack"],
    ]);
    expect(result.replayed).toEqual([]);
  });

  it("replays raw kernel operations as raw operations, mapping hypotheses and generating ids", () => {
    const branch = rawSwapBranch();
    const target = rawTarget("goal:other", { p: "a", q: "b" });
    const result = planSemanticReplay(replayInput(branch.steps(), target));
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report.complete).toBe(true);
    expect(result.report.steps.map(({ status, source }) => [status, source])).toEqual([
      ["adapted", "raw-operation"],
      ["exact", "raw-operation"],
      ["exact", "raw-operation"],
      ["exact", "raw-operation"],
    ]);
    expect(
      result.finalNode.state.goals.map(({ sequent }) => sequent.conclusion.expression),
    ).toEqual(["a"]);
    // Every generated identifier is fresh and derived from the replayed command.
    const expand = result.replayed[1]?.prepared.prepared.edge.operation;
    expect(expand).toMatchObject({
      kind: "expand-hypothesis-conjunction",
      hypothesisId: expect.stringContaining("replay:replay:1"),
      expandedHypothesisIds: [
        expect.stringContaining("replay:replay:2"),
        expect.stringContaining("replay:replay:2"),
      ],
    });
    expect(
      result.replayed.every(({ prepared }) => prepared.prepared.edge.suggestionSetId === undefined),
    ).toBe(true);
  });

  it("is invariant under symbol and goal renaming for backtrack and raw steps", () => {
    const backtrack = backtrackBranch(IMPLIES_QP, ["p", "q"]);
    const raw = rawSwapBranch();
    const backtrackSteps = backtrack.steps();
    const rawSteps = raw.steps();
    const names = fc
      .stringMatching(/^[a-z][a-z0-9]{0,5}$/)
      .filter((name) => !["p", "q", "e", "i"].includes(name));
    fc.assert(
      fc.property(
        fc.uniqueArray(names, { minLength: 2, maxLength: 2 }),
        fc.stringMatching(/^goal:[a-z]{1,8}$/),
        fc.boolean(),
        ([first, second], goalId, shuffle) => {
          const mapping = { p: first as string, q: second as string };
          const symbols = shuffle ? [mapping.q, mapping.p] : [mapping.p, mapping.q];
          const agrees = (
            result: ReturnType<typeof planSemanticReplay>,
            leaf: ProofNode,
          ): boolean => {
            if (!result.ok || !result.report.complete) return false;
            const expected = leaf.state.goals.map(({ sequent }) =>
              rename(sequent.conclusion.expression, mapping),
            );
            const actual = result.finalNode.state.goals.map(
              ({ sequent }) => sequent.conclusion.expression,
            );
            return (
              actual.length === expected.length &&
              actual.every((expression, index) =>
                alphaEquivalent(expression, expected[index] as PlainMathJson),
              ) &&
              result.report.substitutions.every(
                ({ symbol, expression }) => expression === mapping[symbol as "p" | "q"],
              )
            );
          };
          const backtracked = planSemanticReplay(
            replayInput(
              backtrackSteps,
              rootNode("node:target", goalId, symbols, rename(IMPLIES_QP, mapping)),
            ),
          );
          const rawResult = planSemanticReplay(
            replayInput(
              rawSteps,
              rootNode(
                "node:target",
                goalId,
                symbols,
                rename(SWAP as unknown as PlainMathJson, mapping),
              ),
            ),
          );
          return agrees(backtracked, backtrack.leaf) && agrees(rawResult, raw.leaf);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("replays rewrite operations at the re-matched occurrence", () => {
    const hypotheses = [{ id: "statement:equivalence", expression: ["Equivalent", "p", "q"] }];
    const branch = new RawBranch(
      rootNode(
        "node:source",
        "goal:main",
        ["p", "q", "r"],
        ["Or", "r", "p"] as unknown as PlainMathJson,
        hypotheses as never,
      ),
    ).apply("rw", {
      kind: "rewrite-with-equivalence",
      target: goalTarget("goal:main"),
      statement: { kind: "conclusion" },
      path: [1],
      source: { kind: "hypothesis", hypothesisId: "statement:equivalence" },
      direction: "forward",
    });
    const target = rootNode(
      "node:target",
      "goal:renamed",
      ["a", "b", "c"],
      ["Or", "c", "a"] as unknown as PlainMathJson,
      [{ id: "statement:renamed", expression: ["Equivalent", "a", "b"] }] as never,
    );
    const result = planSemanticReplay(replayInput(branch.steps(), target));
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report.complete).toBe(true);
    expect(result.finalNode.state.goals[0]?.sequent.conclusion.expression).toEqual([
      "Or",
      "c",
      "b",
    ]);
    expect(result.replayed[0]?.prepared.prepared.edge.operation).toMatchObject({
      path: [1],
      source: { kind: "hypothesis", hypothesisId: "statement:renamed" },
    });
  });

  it("applies the approved macro again as one step, or fails naming the missing macro", () => {
    const branch = swapBranch();
    const [first] = branch.steps();
    const plan = first?.step as SemanticStep;
    // A macro plan whose template is absent from the catalog fails with a repair hint.
    const macroPlan = semanticStepSchema.parse({
      ...plan,
      moveId: "authored:missing-macro",
      macro: {
        steps: [
          { id: "step-one", moveId: plan.moveId, operation: plan.operation },
          { id: "step-two", moveId: plan.moveId, operation: plan.operation },
        ],
      },
    });
    const target = rootNode(
      "node:target",
      "goal:main",
      ["p", "q"],
      SWAP as unknown as PlainMathJson,
    );
    const result = planSemanticReplay(
      replayInput([{ sourceEdgeId: "edge:c1", step: macroPlan }], target),
    );
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report).toMatchObject({
      complete: false,
      firstFailure: {
        index: 1,
        diagnostic: {
          code: "move-unavailable",
          message: expect.stringContaining("not approved in this session"),
        },
      },
    });
    expect(result.report.steps[0]?.source).toBe("macro");
  });
});

describe("planSemanticReplay over typed-binder operations (N46)", () => {
  const real = { kind: "named", id: "sort:real" };
  const typedRoot = (nodeId: string, goalId: string): ProofNode => ({
    id: proofNodeIdSchema.parse(nodeId),
    state: executableProofStateSchema.parse({
      id: `state:${nodeId}`,
      goals: [
        {
          id: goalId,
          sequent: {
            context: {
              declarations: [
                { id: "declaration:a", symbol: "a", sort: real, role: "universal-parameter" },
              ],
              hypotheses: [],
            },
            conclusion: {
              expression: [
                "ForAll",
                ["Element", "x", "RealNumbers"],
                ["Less", "x", ["Add", "x", 1]],
              ],
            },
          },
        },
      ],
      obligations: [],
    }),
  });

  it("generates fresh declaration and membership identifiers and carries them to later steps", () => {
    const branch = new RawBranch(typedRoot("node:source", "goal:main"))
      .apply("t1", {
        kind: "introduce-universal",
        target: goalTarget("goal:main"),
        parameterDeclarationId: "statement:t1:parameter",
        membershipHypothesisId: "statement:t1:membership",
      })
      .apply("t2", {
        kind: "drop-hypothesis",
        target: goalTarget("goal:main"),
        hypothesisId: "statement:t1:membership",
      });
    const result = planSemanticReplay(
      replayInput(branch.steps(), typedRoot("node:target", "goal:other")),
    );
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report.complete).toBe(true);
    const [introduce, drop] = result.replayed.map(
      ({ prepared }) => prepared.prepared.edge.operation,
    );
    expect(introduce).toMatchObject({
      kind: "introduce-universal",
      target: { id: "goal:other" },
      parameterDeclarationId: expect.stringContaining("replay:replay:1"),
      membershipHypothesisId: expect.stringContaining("replay:replay:1"),
    });
    // The later step names the membership hypothesis the replayed step created.
    expect(drop).toMatchObject({
      kind: "drop-hypothesis",
      hypothesisId: (introduce as { membershipHypothesisId: string }).membershipHypothesisId,
    });
    expect(result.finalNode.state.goals[0]?.sequent.context.hypotheses).toEqual([]);
  });
});

describe("planSemanticReplay over construction operations (N42)", () => {
  const real = { kind: "named", id: "sort:real" };
  const context = {
    declarations: [
      { id: "declaration:eps", symbol: "eps", sort: real, role: "universal-parameter" },
      { id: "declaration:delta", symbol: "delta", sort: real, role: "universal-parameter" },
    ],
    hypotheses: [{ id: "hypothesis:eps", statement: { expression: ["Greater", "eps", 0] } }],
  };
  const existential = [
    "Exists",
    "delta",
    ["And", ["Greater", "delta", 0], ["Less", "delta", "eps"]],
  ];
  const goalWith = (id: string) => ({
    id,
    sequent: { context, conclusion: { expression: existential } },
  });
  const source = (): ProofNode => ({
    id: proofNodeIdSchema.parse("node:source"),
    state: executableProofStateSchema.parse({
      id: "state:node:source",
      goals: [goalWith("goal:main")],
      obligations: [],
    }),
  });

  function constructionBranch(): RawBranch {
    return new RawBranch(source())
      .apply("k1", {
        kind: "introduce-placeholder",
        target: goalTarget("goal:main"),
        taskId: "task:delta",
        symbol: "m",
        displayName: "delta",
        origin: { kind: "existential-goal" },
        dependencies: ["eps"],
        allowedTasks: [],
      })
      .apply("k2", {
        kind: "add-candidate",
        target: goalTarget("goal:main"),
        taskId: "task:delta",
        candidateId: "candidate:eps",
        value: "eps",
        attemptId: "attempt:k2",
      })
      .apply("k3", {
        kind: "resolve-placeholder",
        target: goalTarget("goal:main"),
        taskId: "task:delta",
        candidateId: "candidate:eps",
        obligationIds: [],
        attemptId: "attempt:k3",
      });
  }

  /** The session after the first step already ran: its task and symbol are taken. */
  function crowdedTarget(branch: RawBranch): ProofNode {
    const afterIntroduction = branch.nodes[1] as ProofNode;
    return {
      id: proofNodeIdSchema.parse("node:target"),
      state: executableProofStateSchema.parse({
        ...afterIntroduction.state,
        id: "state:node:target",
        goals: [...afterIntroduction.state.goals, goalWith("goal:again")],
      }),
    };
  }

  it("replays into a session that already holds the recorded task and placeholder symbol", () => {
    const branch = constructionBranch();
    const result = planSemanticReplay(replayInput(branch.steps(), crowdedTarget(branch)));
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report.complete).toBe(true);
    const [introduce, candidate, resolve] = result.replayed.map(
      ({ prepared }) => prepared.prepared.edge.operation,
    );
    // The symbol is generated like an identifier, so the taken `m` is not reused.
    expect(introduce).toMatchObject({
      kind: "introduce-placeholder",
      target: { id: "goal:again" },
      symbol: expect.stringMatching(/^placeholder_[0-9a-f]{12}$/),
      taskId: expect.stringContaining("replay:replay:1"),
      dependencies: ["eps"],
    });
    const { taskId, symbol } = introduce as { taskId: string; symbol: string };
    expect(symbol).not.toBe("m");
    // Later steps follow the placeholder: the same fresh task, matched through the fresh symbol.
    expect(candidate).toMatchObject({ kind: "add-candidate", taskId, value: "eps" });
    expect(resolve).toMatchObject({ kind: "resolve-placeholder", taskId });
    const final = result.finalNode.state;
    expect(final.constructions?.map(({ status }) => status)).toEqual(["unresolved", "resolved"]);
    expect(
      final.goals.find(({ id }) => id === "goal:again")?.sequent.conclusion.expression,
    ).toEqual(["And", ["Greater", "eps", 0], ["Less", "eps", "eps"]]);
  });

  it("replays onto a renamed variable the construction depends on", () => {
    const branch = constructionBranch();
    const renamed = executableProofStateSchema.parse({
      id: "state:node:renamed",
      goals: [
        {
          id: "goal:other",
          sequent: {
            context: {
              declarations: [
                { id: "declaration:a", symbol: "a", sort: real, role: "universal-parameter" },
                { id: "declaration:d", symbol: "delta", sort: real, role: "universal-parameter" },
              ],
              hypotheses: [{ id: "hypothesis:a", statement: { expression: ["Greater", "a", 0] } }],
            },
            conclusion: {
              expression: [
                "Exists",
                "delta",
                ["And", ["Greater", "delta", 0], ["Less", "delta", "a"]],
              ],
            },
          },
        },
      ],
      obligations: [],
    });
    const result = planSemanticReplay(
      replayInput(branch.steps(), { id: proofNodeIdSchema.parse("node:renamed"), state: renamed }),
    );
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(result.report.complete).toBe(true);
    expect(result.replayed[0]?.prepared.prepared.edge.operation).toMatchObject({
      dependencies: ["a"],
    });
    expect(result.finalNode.state.goals[0]?.sequent.conclusion.expression).toEqual([
      "And",
      ["Greater", "a", 0],
      ["Less", "a", "a"],
    ]);
  });
});
