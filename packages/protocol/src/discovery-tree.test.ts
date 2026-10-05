import { describe, expect, it } from "vitest";
import { applyTransition, kernelOperationSchema } from "@proof/kernel";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  analyzeDiscoveryTree,
  commandIdSchema,
  proofEdgeIdSchema,
  proofNodeIdSchema,
  prunedProof,
  type DiscoveryTreeAnalysis,
  type DiscoveryTreeEdge,
  type DiscoveryTreeInput,
  type ProofNode,
} from "./index";

const declarations = ["p", "q"].map((symbol, index) => ({
  id: `declaration:${index}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
}));

type GoalSpec = Readonly<{
  id: string;
  conclusion: PlainMathJson;
  hypotheses?: readonly (readonly [string, PlainMathJson])[];
}>;

function rootNode(goals: readonly GoalSpec[]): ProofNode {
  return {
    id: proofNodeIdSchema.parse("node:root"),
    state: executableProofStateSchema.parse({
      id: "state:root",
      goals: goals.map((goal) => ({
        id: goal.id,
        sequent: {
          context: {
            declarations,
            hypotheses: (goal.hypotheses ?? []).map(([id, expression]) => ({
              id,
              statement: { expression },
            })),
          },
          conclusion: { expression: goal.conclusion },
        },
      })),
      obligations: [],
    }),
  };
}

class Tree {
  readonly nodes: ProofNode[];
  readonly edges: DiscoveryTreeEdge[] = [];

  constructor(root: ProofNode) {
    this.nodes = [root];
  }

  node(id: string): ProofNode {
    const found = this.nodes.find((node) => node.id === id);
    if (found === undefined) throw new Error(`missing ${id}`);
    return found;
  }

  /** Apply a real kernel transition and record the resulting node and edge. */
  apply(
    parentId: string,
    childId: string,
    operation: Record<string, unknown>,
    extra: Readonly<{ sequence?: number }> = {},
  ): this {
    const parent = this.node(parentId);
    const parsed = kernelOperationSchema.parse({
      ...operation,
      expectedStateId: parent.state.id,
      resultStateId: `state:${childId}`,
    });
    const result = applyTransition(parent.state, parsed);
    if (!result.ok) throw new Error(result.diagnostics[0]?.message);
    return this.record(parent, childId, result.state, parsed, result.transitionClass, extra);
  }

  record(
    parent: ProofNode,
    childId: string,
    state: ExecutableProofState,
    operation: DiscoveryTreeEdge["operation"],
    transitionClass: DiscoveryTreeEdge["transitionClass"],
    extra: Partial<Pick<DiscoveryTreeEdge, "sequence" | "evidence">> = {},
  ): this {
    const node: ProofNode = { id: proofNodeIdSchema.parse(childId), state };
    this.nodes.push(node);
    this.edges.push({
      id: proofEdgeIdSchema.parse(`edge:${childId}`),
      commandId: commandIdSchema.parse(`command:${childId}`),
      parentNodeId: parent.id,
      childNodeId: node.id,
      operation,
      transitionClass,
      ...extra,
    });
    return this;
  }

  input(): DiscoveryTreeInput {
    return { nodes: this.nodes, edges: this.edges, rootId: proofNodeIdSchema.parse("node:root") };
  }
}

function analyze(input: DiscoveryTreeInput): DiscoveryTreeAnalysis {
  const result = analyzeDiscoveryTree(input);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  return result;
}

const goal = (id: string) => ({ kind: "goal", id });

function linearTree(): Tree {
  return new Tree(rootNode([{ id: "goal:main", conclusion: ["Implies", "p", "p"] }]))
    .apply("node:root", "node:intro", {
      kind: "introduce-implication",
      target: goal("goal:main"),
      hypothesisId: "hyp:p",
    })
    .apply("node:intro", "node:done", {
      kind: "close-by-hypothesis",
      target: goal("goal:main"),
      hypothesisId: "hyp:p",
    });
}

/** Proves q from p ⇒ q and ¬p ⇒ q by a classical case split on p. */
function caseSplitTree(options: Readonly<{ closeNo?: boolean; unusedStep?: boolean }> = {}) {
  const tree = new Tree(
    rootNode([
      {
        id: "goal:main",
        conclusion: "q",
        hypotheses: [
          ["hyp:h", ["Implies", "p", "q"]],
          ["hyp:g", ["Implies", ["Not", "p"], "q"]],
        ],
      },
    ]),
  ).apply("node:root", "node:split", {
    kind: "split-classical-cases",
    target: goal("goal:main"),
    proposition: "p",
    childIds: ["goal:yes", "goal:no"],
    branchHypothesisIds: ["hyp:yes", "hyp:no"],
  });
  let last = "node:split";
  if (options.unusedStep === true) {
    tree.apply(last, "node:unused", {
      kind: "apply-implication-hypothesis",
      target: goal("goal:yes"),
      implicationHypothesisId: "hyp:h",
      antecedentHypothesisId: "hyp:yes",
      resultHypothesisId: "hyp:unused",
    });
    last = "node:unused";
  }
  tree
    .apply(last, "node:yes-q", {
      kind: "apply-implication-hypothesis",
      target: goal("goal:yes"),
      implicationHypothesisId: "hyp:h",
      antecedentHypothesisId: "hyp:yes",
      resultHypothesisId: "hyp:q-yes",
    })
    .apply("node:yes-q", "node:yes-done", {
      kind: "close-by-hypothesis",
      target: goal("goal:yes"),
      hypothesisId: "hyp:q-yes",
    });
  if (options.closeNo !== false) {
    tree
      .apply("node:yes-done", "node:no-q", {
        kind: "apply-implication-hypothesis",
        target: goal("goal:no"),
        implicationHypothesisId: "hyp:g",
        antecedentHypothesisId: "hyp:no",
        resultHypothesisId: "hyp:q-no",
      })
      .apply("node:no-q", "node:no-done", {
        kind: "close-by-hypothesis",
        target: goal("goal:no"),
        hypothesisId: "hyp:q-no",
      });
  }
  return tree;
}

describe("analyzeDiscoveryTree", () => {
  it("solves a linear proof and marks every route target closed", () => {
    const analysis = analyze(linearTree().input());
    expect(analysis.solved).toBe(true);
    expect(analysis.route.nodeIds).toEqual(["node:root", "node:intro", "node:done"]);
    expect(analysis.route.steps.map((step) => step.edgeId)).toEqual([
      "edge:node:intro",
      "edge:node:done",
    ]);
    expect(analysis.evidenceSummary.structural.count).toBe(2);
    expect(analysis.openTargets).toEqual([]);
    expect(analysis.solvedRelativeTo).toEqual({ backgroundInferences: [], sorries: [] });
    expect(analysis.route.targetStatus[0]).toEqual({
      nodeId: "node:root",
      targets: [
        { target: goal("goal:main"), status: "closed", handledByEdgeId: "edge:node:intro" },
      ],
    });
    expect(analysis.route.targetStatus[2]?.targets).toEqual([]);
    expect(Object.isFrozen(analysis)).toBe(true);
    expect(Object.isFrozen(analysis.route.steps[0]?.operation)).toBe(true);
  });

  it("reports construction operations by their kernel class, with structural evidence", () => {
    const tree = new Tree(rootNode([{ id: "goal:main", conclusion: ["Exists", "p", "p"] }]))
      .apply("node:root", "node:intro", {
        kind: "introduce-placeholder",
        target: goal("goal:main"),
        taskId: "task:p",
        symbol: "ph",
        displayName: "p",
        origin: { kind: "existential-goal" },
        dependencies: [],
        allowedTasks: [],
      })
      .apply("node:intro", "node:candidate", {
        kind: "add-candidate",
        target: goal("goal:main"),
        taskId: "task:p",
        candidateId: "candidate:true",
        value: "True",
        attemptId: "attempt:1",
      })
      .apply("node:candidate", "node:resolved", {
        kind: "resolve-placeholder",
        target: goal("goal:main"),
        taskId: "task:p",
        candidateId: "candidate:true",
        obligationIds: [],
        attemptId: "attempt:2",
      })
      .apply("node:resolved", "node:done", { kind: "close-true", target: goal("goal:main") });
    const analysis = analyze(tree.input());
    expect(
      analysis.route?.steps.map(({ operation, transitionClass, evidence }) => [
        operation.kind,
        transitionClass,
        evidence,
      ]),
    ).toEqual([
      ["introduce-placeholder", "equivalence", "structural"],
      ["add-candidate", "equivalence", "structural"],
      ["resolve-placeholder", "strengthening", "structural"],
      ["close-true", "equivalence", "structural"],
    ]);
    expect(analysis.solved).toBe(true);
  });

  it("accepts the worker's history-edge records", () => {
    const tree = linearTree();
    const analysis = analyze({
      ...tree.input(),
      edges: tree.edges.map((edge) => ({ edge, name: "move" })),
    });
    expect(analysis.solved).toBe(true);
  });

  it("solves a case split only when both branches close", () => {
    const analysis = analyze(caseSplitTree().input());
    expect(analysis.solved).toBe(true);
    expect(analysis.route.steps[0]?.createdTargets).toEqual([goal("goal:yes"), goal("goal:no")]);
    expect(analysis.route.targetStatus[1]?.targets.map((entry) => entry.status)).toEqual([
      "closed",
      "closed",
    ]);
  });

  it("reports the open case of a partially closed case split", () => {
    const analysis = analyze(caseSplitTree({ closeNo: false }).input());
    expect(analysis.solved).toBe(false);
    expect(analysis.route.leafNodeId).toBe("node:yes-done");
    expect(analysis.openTargets).toEqual([goal("goal:no")]);
    const [root, split] = analysis.route.targetStatus;
    expect(root?.targets).toEqual([
      { target: goal("goal:main"), status: "open", handledByEdgeId: "edge:node:split" },
    ]);
    expect(split?.targets).toEqual([
      { target: goal("goal:yes"), status: "closed", handledByEdgeId: "edge:node:yes-q" },
      { target: goal("goal:no"), status: "open" },
    ]);
    const pruned = prunedProof(analysis);
    expect(pruned.ok).toBe(false);
  });

  it("never counts a weakening edge, even on the only complete path", () => {
    const tree = new Tree(rootNode([{ id: "goal:main", conclusion: "p" }]))
      .apply("node:root", "node:assumed", {
        kind: "assume-hypothesis",
        target: goal("goal:main"),
        proposition: "p",
        hypothesisId: "hyp:p",
      })
      .apply("node:assumed", "node:done", {
        kind: "close-by-hypothesis",
        target: goal("goal:main"),
        hypothesisId: "hyp:p",
      });
    expect(tree.edges[0]?.transitionClass).toBe("weakening");
    const analysis = analyze(tree.input());
    expect(analysis.solved).toBe(false);
    expect(analysis.route.nodeIds).toEqual(["node:root"]);
    expect(analysis.openTargets).toEqual([goal("goal:main")]);
  });

  it("chooses the earliest-completed of two alternative routes deterministically", () => {
    const build = (sequences: readonly [number, number, number, number] | undefined) => {
      const at = (index: number) =>
        sequences === undefined ? {} : { sequence: sequences[index] as number };
      return new Tree(rootNode([{ id: "goal:main", conclusion: ["Implies", "p", "p"] }]))
        .apply(
          "node:root",
          "node:a1",
          { kind: "introduce-implication", target: goal("goal:main"), hypothesisId: "hyp:a" },
          at(0),
        )
        .apply(
          "node:a1",
          "node:a2",
          { kind: "close-by-hypothesis", target: goal("goal:main"), hypothesisId: "hyp:a" },
          at(3),
        )
        .apply(
          "node:root",
          "node:b1",
          { kind: "introduce-implication", target: goal("goal:main"), hypothesisId: "hyp:b" },
          at(1),
        )
        .apply(
          "node:b1",
          "node:b2",
          { kind: "close-by-hypothesis", target: goal("goal:main"), hypothesisId: "hyp:b" },
          at(2),
        );
    };
    const sequenced = build([1, 4, 2, 3]).input();
    expect(analyze(sequenced).route.leafNodeId).toBe("node:b2");
    const reversed = { ...sequenced, edges: [...sequenced.edges].reverse() };
    expect(analyze(reversed)).toEqual(analyze(sequenced));
    // Without event sequence the final edge ID decides.
    expect(analyze(build(undefined).input()).route.leafNodeId).toBe("node:a2");
  });

  it("reports background inferences and sorry assumptions the route relies on", () => {
    const tree = new Tree(rootNode([{ id: "goal:main", conclusion: ["And", "p", "q"] }]))
      .apply("node:root", "node:split", {
        kind: "split-goal-conjunction",
        target: goal("goal:main"),
        childIds: ["goal:p", "goal:q"],
      })
      .apply("node:split", "node:attested", {
        kind: "close-by-accepted-inference",
        target: goal("goal:p"),
        attestationId: "attestation:check",
      });
    const parent = tree.node("node:attested");
    const assumption = {
      id: "assumption:q",
      declarations: [
        {
          id: "declaration:r",
          symbol: "r",
          sort: PROPOSITION_SORT,
          role: "universal-parameter" as const,
        },
      ],
      statement: { expression: ["ForAll", "r", ["Or", "r", ["Not", "r"]]] },
      origin: { kind: "sorry" as const, sourceTarget: goal("goal:q"), sorryId: "sorry:q" },
    };
    const sorryState = executableProofStateSchema.parse({
      id: "state:node:sorry",
      goals: [],
      obligations: [],
      assumptions: [assumption],
    });
    tree.record(
      parent,
      "node:sorry",
      sorryState,
      kernelOperationSchema.parse({
        kind: "close-by-accepted-inference",
        target: goal("goal:q"),
        attestationId: "attestation:sorry-placeholder",
        expectedStateId: parent.state.id,
        resultStateId: sorryState.id,
      }),
      "equivalence",
    );
    const analysis = analyze(tree.input());
    expect(analysis.solved).toBe(true);
    expect(analysis.evidenceSummary.sorry).toEqual({ count: 1, edgeIds: ["edge:node:sorry"] });
    expect(analysis.evidenceSummary["background-inference"].edgeIds).toEqual([
      "edge:node:attested",
    ]);
    expect(analysis.solvedRelativeTo).toEqual({
      backgroundInferences: [
        {
          edgeId: "edge:node:attested",
          target: goal("goal:p"),
          attestationId: "attestation:check",
        },
      ],
      sorries: [
        { edgeId: "edge:node:sorry", target: goal("goal:q"), assumptionIds: ["assumption:q"] },
      ],
    });
    expect(analysis.assumptions.map((entry) => entry.id)).toEqual(["assumption:q"]);
    const pruned = prunedProof(analysis);
    expect(pruned.ok && pruned.proof.assumptions.map((entry) => entry.id)).toEqual([
      "assumption:q",
    ]);
  });

  it("rejects malformed trees", () => {
    const tree = linearTree();
    expect(
      analyzeDiscoveryTree({ ...tree.input(), rootId: proofNodeIdSchema.parse("node:missing") }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "root-not-found" }] });
    const [first, second] = tree.edges;
    const duplicateParent = { ...second!, id: proofEdgeIdSchema.parse("edge:again") };
    expect(
      analyzeDiscoveryTree({ ...tree.input(), edges: [first!, second!, duplicateParent] }),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "not-a-tree" }],
    });
    const relinked = { ...second!, childNodeId: proofNodeIdSchema.parse("node:intro") };
    expect(analyzeDiscoveryTree({ ...tree.input(), edges: [relinked] })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "snapshot-mismatch" }],
    });
    expect(analyzeDiscoveryTree({ ...tree.input(), edges: [first!, first!] })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "duplicate-edge" }],
    });
  });
});

describe("prunedProof", () => {
  it("removes an unused forward-derived hypothesis step but keeps a used one", () => {
    const analysis = analyze(caseSplitTree({ unusedStep: true }).input());
    expect(analysis.solved).toBe(true);
    expect(analysis.route.steps[1]?.addedHypothesisIds).toEqual(["hyp:unused"]);
    const pruned = prunedProof(analysis);
    if (!pruned.ok) throw new Error("expected a pruned proof");
    expect(pruned.proof.removedSteps).toEqual([
      { edgeId: "edge:node:unused", unusedHypothesisIds: ["hyp:unused"] },
    ]);
    expect(pruned.proof.steps.map((step) => step.edgeId)).toEqual([
      "edge:node:split",
      "edge:node:yes-q",
      "edge:node:yes-done",
      "edge:node:no-q",
      "edge:node:no-done",
    ]);
    expect(pruned.proof.evidenceSummary.structural.count).toBe(5);
    expect(Object.isFrozen(pruned.proof.steps)).toBe(true);
  });

  it("keeps every step of a route without unused forward steps", () => {
    const analysis = analyze(caseSplitTree().input());
    const pruned = prunedProof(analysis);
    expect(pruned.ok && pruned.proof.steps.length).toBe(5);
    expect(pruned.ok && pruned.proof.removedSteps).toEqual([]);
  });
});
