import { describe, expect, it } from "vitest";
import { applyTransition, kernelOperationSchema } from "@proof/kernel";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  analyzeBacktrack,
  backtrackAnalysisSchema,
  planBacktrackWithInformation,
  proofNodeIdSchema,
  type BacktrackEdge,
  type BacktrackPlan,
  type ProofNode,
} from "./index";

const declarations = ["p", "q", "r", "s"].map((symbol, index) => ({
  id: `declaration:${index}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
}));

class Tree {
  readonly nodes: ProofNode[];
  readonly edges: (BacktrackEdge & Readonly<{ id: string }>)[] = [];

  constructor(conclusion: PlainMathJson) {
    this.nodes = [
      {
        id: proofNodeIdSchema.parse("node:root"),
        state: executableProofStateSchema.parse({
          id: "state:root",
          goals: [
            {
              id: "goal:main",
              sequent: {
                context: { declarations, hypotheses: [] },
                conclusion: { expression: conclusion },
              },
            },
          ],
          obligations: [],
        }),
      },
    ];
  }

  node(id: string): ProofNode {
    const found = this.nodes.find((node) => node.id === id);
    if (found === undefined) throw new Error(`missing ${id}`);
    return found;
  }

  apply(parentId: string, childId: string, operation: Record<string, unknown>): this {
    const parent = this.node(parentId);
    const parsed = kernelOperationSchema.parse({
      ...operation,
      expectedStateId: parent.state.id,
      resultStateId: `state:${childId}`,
    });
    const result = applyTransition(parent.state, parsed);
    if (!result.ok) throw new Error(result.diagnostics[0]?.message);
    this.nodes.push({ id: proofNodeIdSchema.parse(childId), state: result.state });
    this.edges.push({
      id: `edge:${childId}`,
      parentNodeId: parent.id,
      childNodeId: childId,
      operation: parsed,
    });
    return this;
  }

  input() {
    return { rootNodeId: "node:root", nodes: this.nodes, edges: this.edges };
  }
}

const goal = (id: string) => ({ kind: "goal", id }) as const;

/**
 * root ⊢ q ⇒ ∀p. (p ⇒ r)
 *   → node:intro-q   q ⊢ ∀p. (p ⇒ r)      (p only bound)
 *   → node:intro-p   q ⊢ p ⇒ r            (p introduced)
 *   → node:intro-hp  q, p ⊢ r
 */
function introductionChain(): Tree {
  return new Tree(["Implies", "q", ["ForAll", "p", ["Implies", "p", "r"]]])
    .apply("node:root", "node:intro-q", {
      kind: "introduce-implication",
      target: goal("goal:main"),
      hypothesisId: "hyp:q",
    })
    .apply("node:intro-q", "node:intro-p", {
      kind: "introduce-universal",
      target: goal("goal:main"),
    })
    .apply("node:intro-p", "node:intro-hp", {
      kind: "introduce-implication",
      target: goal("goal:main"),
      hypothesisId: "hyp:p",
    });
}

const recordIds = (commandId: string) => ({
  resultNodeId: `node:${commandId}`,
  edgeId: `edge:${commandId}`,
  eventId: `event:${commandId}`,
  resultStateId: `state:${commandId}`,
});

function command(overrides: Readonly<Record<string, unknown>>) {
  return {
    commandId: "command:backtrack",
    actor: { id: "actor:human", kind: "human" },
    expectedCurrentNodeId: "node:intro-hp",
    sourceNodeId: "node:intro-hp",
    ...overrides,
  };
}

function plan(tree: Tree, overrides: Readonly<Record<string, unknown>>): BacktrackPlan {
  const result = planBacktrackWithInformation({
    ...tree.input(),
    command: command(overrides),
    recordIds,
  });
  if (!result.ok) throw new Error(result.diagnostics[0].message);
  return result.plan;
}

/** Apply the planned commands with the real kernel, starting at the chosen ancestor. */
function execute(tree: Tree, planned: BacktrackPlan): ExecutableProofState {
  let state = tree.node(planned.ancestorNodeId).state;
  for (const step of planned.commands) {
    expect(step.parentNodeId).toBe(
      step === planned.commands[0] ? planned.ancestorNodeId : planned.commands[0]?.resultNodeId,
    );
    const result = applyTransition(state, step.operation);
    if (!result.ok) throw new Error(result.diagnostics[0]?.message);
    expect(result.transitionClass).toBe("equivalence");
    state = result.state;
  }
  return state;
}

describe("analyzeBacktrack", () => {
  it("lists ancestors closest first, with the source target's lineage and availability", () => {
    const result = analyzeBacktrack({
      ...introductionChain().input(),
      request: { sourceNodeId: "node:intro-hp", proposition: ["And", "p", "r"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { analysis } = result;
    expect(backtrackAnalysisSchema.parse(analysis)).toEqual(analysis);
    expect(Object.isFrozen(analysis) && Object.isFrozen(analysis.ancestors)).toBe(true);
    expect(analysis).toMatchObject({
      sourceTarget: goal("goal:main"),
      freeSymbols: ["p", "r"],
      operators: ["And"],
      declarations: [{ symbol: "p" }, { symbol: "r" }],
      closestEligibleAncestorNodeId: "node:intro-p",
    });
    expect(
      analysis.ancestors.map(({ nodeId, distance, eligible, unavailableSymbols }) => [
        nodeId,
        distance,
        eligible,
        unavailableSymbols,
      ]),
    ).toEqual([
      ["node:intro-p", 1, true, []],
      ["node:intro-q", 2, false, ["p"]],
      ["node:root", 3, false, ["p"]],
    ]);
  });

  it("traces a target created by an edge back to the target the edge acted on", () => {
    const tree = new Tree(["And", "q", ["And", "r", "s"]]).apply("node:root", "node:split", {
      kind: "split-goal-conjunction",
      target: goal("goal:main"),
      childIds: ["goal:left", "goal:right"],
    });
    const result = analyzeBacktrack({
      ...tree.input(),
      request: { sourceNodeId: "node:split", sourceTarget: goal("goal:right"), proposition: "s" },
    });
    expect(result).toMatchObject({
      ok: true,
      analysis: {
        sourceTarget: goal("goal:right"),
        ancestors: [{ nodeId: "node:root", target: goal("goal:main"), eligible: true }],
      },
    });
  });

  it("rejects invalid sources and propositions", () => {
    const tree = introductionChain();
    const codes = [
      { sourceNodeId: "node:missing", proposition: "r" },
      { sourceNodeId: "node:root", proposition: "r" },
      { sourceNodeId: "node:intro-hp", sourceTarget: goal("goal:other"), proposition: "r" },
      { sourceNodeId: "node:intro-hp", proposition: ["And", "r", "z"] },
      { sourceNodeId: "node:intro-hp", proposition: ["Add", "r", "r"] },
      { sourceNodeId: "node:intro-hp" },
    ].map((request) => {
      const result = analyzeBacktrack({ ...tree.input(), request });
      return result.ok ? "ok" : result.diagnostics[0].code;
    });
    expect(codes).toEqual([
      "source-not-in-tree",
      "source-is-root",
      "source-target-not-found",
      "invalid-proposition",
      "invalid-proposition",
      "invalid-input",
    ]);
  });

  it("rejects a proposition naming a symbol that is only bound at the source", () => {
    const result = analyzeBacktrack({
      ...introductionChain().input(),
      request: { sourceNodeId: "node:intro-q", proposition: "p" },
    });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-proposition" }] });
  });
});

describe("planBacktrackWithInformation", () => {
  it("splits at the closest eligible ancestor and focuses the P case when no case closes", () => {
    const tree = introductionChain();
    const planned = plan(tree, { proposition: "s" });
    expect(planned).toMatchObject({
      ancestorNodeId: "node:intro-p",
      splitTarget: goal("goal:main"),
      focusTarget: goal("statement:command:backtrack:child:1"),
      finalNodeId: "node:command:backtrack",
    });
    expect(planned.autoClosedTarget).toBeUndefined();
    expect(planned.commands).toHaveLength(1);
    expect(planned.commands[0]).toMatchObject({
      commandId: "command:backtrack",
      parentNodeId: "node:intro-p",
      resultNodeId: "node:command:backtrack",
      operation: {
        kind: "split-classical-cases",
        proposition: "s",
        expectedStateId: "state:node:intro-p",
      },
    });
    const state = execute(tree, planned);
    expect(state.goals.map(({ id }) => id)).toEqual([
      "statement:command:backtrack:child:1",
      "statement:command:backtrack:child:2",
    ]);
    expect(state.goals[0]?.sequent.context.hypotheses.at(-1)?.statement.expression).toBe("s");
  });

  it("uses a chosen eligible ancestor instead of the closest one", () => {
    const tree = introductionChain();
    const planned = plan(tree, { proposition: "r", ancestorNodeId: "node:root" });
    expect(planned.ancestorNodeId).toBe("node:root");
    expect(planned.analysis.closestEligibleAncestorNodeId).toBe("node:intro-p");
    expect(planned.commands[0]?.operation.expectedStateId).toBe("state:root");
    execute(tree, planned);
  });

  it("rejects an ancestor where a free symbol is unavailable, and when no ancestor has it", () => {
    const tree = introductionChain();
    const chosen = planBacktrackWithInformation({
      ...tree.input(),
      command: command({ proposition: ["Or", "p", "q"], ancestorNodeId: "node:root" }),
      recordIds,
    });
    expect(chosen).toMatchObject({
      ok: false,
      diagnostics: [{ code: "ancestor-not-eligible" }],
      analysis: { closestEligibleAncestorNodeId: "node:intro-p" },
    });
    expect(chosen.diagnostics[0]?.message).toContain("p");

    const none = planBacktrackWithInformation({
      ...tree.input(),
      command: command({ sourceNodeId: "node:intro-p", proposition: "p" }),
      recordIds,
    });
    expect(none).toMatchObject({ ok: false, diagnostics: [{ code: "no-eligible-ancestor" }] });
    expect(none.diagnostics[0]?.message).toContain("p");

    const offPath = planBacktrackWithInformation({
      ...tree.input(),
      command: command({ proposition: "r", ancestorNodeId: "node:intro-hp" }),
      recordIds,
    });
    expect(offPath).toMatchObject({ ok: false, diagnostics: [{ code: "ancestor-not-on-path" }] });
  });

  it("auto-closes the P case when the ancestor's goal is P itself and focuses Not P", () => {
    const tree = introductionChain();
    const planned = plan(tree, { proposition: ["Implies", "p", "r"] });
    expect(planned).toMatchObject({
      ancestorNodeId: "node:intro-p",
      autoClosedTarget: goal("statement:command:backtrack:child:1"),
      focusTarget: goal("statement:command:backtrack:child:2"),
      finalNodeId: "node:command:backtrack:auto-close",
    });
    expect(planned.commands[1]).toMatchObject({
      commandId: "command:backtrack:auto-close",
      parentNodeId: "node:command:backtrack",
      operation: {
        kind: "close-by-hypothesis",
        target: goal("statement:command:backtrack:child:1"),
        hypothesisId: "statement:command:backtrack:branch-hypothesis:1",
      },
    });
    const state = execute(tree, planned);
    expect(state.goals.map(({ id }) => id)).toEqual(["statement:command:backtrack:child:2"]);
    expect(state.goals[0]?.sequent.context.hypotheses.at(-1)?.statement.expression).toEqual([
      "Not",
      ["Implies", "p", "r"],
    ]);
  });

  it("auto-closes up to alpha-equivalence", () => {
    const tree = introductionChain();
    const planned = plan(tree, {
      sourceNodeId: "node:intro-p",
      proposition: ["ForAll", "s", ["Implies", "s", "r"]],
    });
    expect(planned).toMatchObject({
      ancestorNodeId: "node:intro-q",
      autoClosedTarget: goal("statement:command:backtrack:child:1"),
    });
    expect(execute(tree, planned).goals).toHaveLength(1);
  });

  it("auto-closes the Not P case when the ancestor's goal is Not P and focuses P", () => {
    const tree = new Tree(["Not", "s"]).apply("node:root", "node:intro", {
      kind: "introduce-negation",
      target: goal("goal:main"),
      hypothesisId: "hyp:s",
    });
    const planned = plan(tree, { sourceNodeId: "node:intro", proposition: "s" });
    expect(planned).toMatchObject({
      ancestorNodeId: "node:root",
      autoClosedTarget: goal("statement:command:backtrack:child:2"),
      focusTarget: goal("statement:command:backtrack:child:1"),
    });
    expect(execute(tree, planned).goals.map(({ id }) => id)).toEqual([
      "statement:command:backtrack:child:1",
    ]);
  });
});
