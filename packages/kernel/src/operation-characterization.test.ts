/**
 * Characterization of the kernel operations: every case pins the exact outcome (transition class,
 * evidence, resulting targets) or the exact diagnostic code and message of one branch of
 * `applyTransition`, and every field of every operation pins the exact diagnostic of
 * `kernelOperationSchema`. The expectations record the current behaviour, so a refactoring of the
 * operation handlers or parsers must not change any of them.
 */
import { describe, expect, it } from "vitest";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
  type ExecutableProofState,
  type Goal,
  type Obligation,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  applyTransition,
  kernelOperationSchema,
  type KernelEnvironment,
  type KernelResult,
  type KernelTransitionResult,
} from "./index";

const real = { kind: "named", id: "sort:real" } as const;
const baseDeclarations = [
  ...["p", "q", "r"].map((symbol) => ({ symbol, sort: PROPOSITION_SORT })),
  ...["a", "b", "y"].map((symbol) => ({ symbol, sort: real })),
].map((declaration) => ({
  id: `decl:${declaration.symbol}`,
  ...declaration,
  role: "universal-parameter" as const,
}));

type Hypotheses = readonly (readonly [string, PlainMathJson])[];
type SequentSpec = Readonly<{
  conclusion: PlainMathJson;
  hypotheses?: Hypotheses;
  declarations?: readonly unknown[];
}>;

function sequentOf(spec: SequentSpec) {
  return {
    context: {
      declarations: spec.declarations ?? baseDeclarations,
      hypotheses: (spec.hypotheses ?? []).map(([id, expression]) => ({
        id,
        statement: { expression },
      })),
    },
    conclusion: { expression: spec.conclusion },
  };
}

/**
 * A state whose acted-on target is `goal:0` or, with `asObligation`, `obligation:0` (by default
 * with `suffices` provenance, next to a sibling goal and a later obligation).
 */
function stateOf(
  spec: SequentSpec,
  asObligation = false,
  provenance: unknown = { kind: "suffices" },
): ExecutableProofState {
  return executableProofStateSchema.parse(
    asObligation
      ? {
          id: "state:before",
          goals: [{ id: "goal:sibling", sequent: sequentOf({ conclusion: "r" }) }],
          obligations: [
            { id: "obligation:0", provenance, sequent: sequentOf(spec) },
            { id: "obligation:later", sequent: sequentOf({ conclusion: "q" }) },
          ],
        }
      : {
          id: "state:before",
          goals: [{ id: "goal:0", sequent: sequentOf(spec) }],
          obligations: [{ id: "obligation:existing", sequent: sequentOf({ conclusion: "q" }) }],
        },
  );
}

const baseOperation = (asObligation: boolean) => ({
  expectedStateId: "state:before",
  resultStateId: "state:after",
  target: asObligation
    ? { kind: "obligation", id: "obligation:0" }
    : { kind: "goal", id: "goal:0" },
});

function entryLine(label: string, entry: Goal | Obligation): string {
  const provenance =
    "provenance" in entry && entry.provenance !== undefined
      ? ` ${JSON.stringify(entry.provenance)}`
      : "";
  const { declarations, hypotheses } = entry.sequent.context;
  const extra = declarations
    .slice(baseDeclarations.length)
    .map((declaration) => `${declaration.id}:${declaration.symbol}:${declaration.role}`);
  const added = extra.length === 0 ? "" : ` +decls[${extra.join(" ")}]`;
  const facts = hypotheses.map(
    (hypothesis) => `${hypothesis.id}=${JSON.stringify(hypothesis.statement.expression)}`,
  );
  return `${label} ${entry.id}${provenance}${added} [${facts.join(" ")}] |- ${JSON.stringify(
    entry.sequent.conclusion.expression,
  )}`;
}

function summarize(result: KernelTransitionResult): string[] {
  if (!result.ok) {
    return result.diagnostics.map(
      (diagnostic) =>
        `FAIL ${diagnostic.code}: ${diagnostic.message}${
          diagnostic.path === undefined ? "" : ` @${diagnostic.path.join(".")}`
        }`,
    );
  }
  return [
    `OK ${result.transitionClass}/${result.evidence}${
      result.resultId === undefined ? "" : ` ${result.resultId}`
    }`,
    ...result.state.goals.map((goal) => entryLine("goal", goal)),
    ...result.state.obligations.map((obligation) => entryLine("obligation", obligation)),
    ...(result.state.assumptions ?? []).map(
      (assumption) =>
        `assumption ${assumption.id} ${JSON.stringify(assumption.statement.expression)} ${JSON.stringify(
          assumption.origin,
        )}`,
    ),
  ];
}

type Case = Readonly<{
  spec: SequentSpec;
  operation: Record<string, unknown>;
  asObligation?: boolean;
  provenance?: unknown;
  environment?: KernelEnvironment;
}>;

function runCases(cases: Readonly<Record<string, Case>>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(cases).map(
      ([name, { spec, operation, asObligation = false, provenance, environment }]) => [
        name,
        summarize(
          applyTransition(
            stateOf(spec, asObligation, provenance),
            { ...baseOperation(asObligation), ...operation },
            environment,
          ),
        ),
      ],
    ),
  );
}

const p = (id: string): readonly [string, PlainMathJson] => [id, "p"];

describe("closing operations", () => {
  it("pins every branch of the closers", () => {
    expect(
      runCases({
        "close-by-hypothesis ok": {
          spec: { conclusion: "p", hypotheses: [p("h:p")] },
          operation: { kind: "close-by-hypothesis", hypothesisId: "h:p" },
        },
        "close-by-hypothesis ok on obligation": {
          spec: { conclusion: "p", hypotheses: [p("h:p")] },
          operation: { kind: "close-by-hypothesis", hypothesisId: "h:p" },
          asObligation: true,
        },
        "close-by-hypothesis missing hypothesis": {
          spec: { conclusion: "p", hypotheses: [p("h:p")] },
          operation: { kind: "close-by-hypothesis", hypothesisId: "h:other" },
        },
        "close-by-hypothesis mismatch": {
          spec: { conclusion: "q", hypotheses: [p("h:p")] },
          operation: { kind: "close-by-hypothesis", hypothesisId: "h:p" },
        },
        "close-true ok": {
          spec: { conclusion: "True" },
          operation: { kind: "close-true" },
        },
        "close-true not truth": {
          spec: { conclusion: "p" },
          operation: { kind: "close-true" },
        },
        "close-false-hypothesis ok": {
          spec: { conclusion: "p", hypotheses: [["h:false", "False"]] },
          operation: { kind: "close-false-hypothesis", hypothesisId: "h:false" },
        },
        "close-false-hypothesis missing hypothesis": {
          spec: { conclusion: "p", hypotheses: [["h:false", "False"]] },
          operation: { kind: "close-false-hypothesis", hypothesisId: "h:other" },
        },
        "close-false-hypothesis not falsity": {
          spec: { conclusion: "p", hypotheses: [p("h:p")] },
          operation: { kind: "close-false-hypothesis", hypothesisId: "h:p" },
        },
        "close-reflexive-equality ok": {
          spec: { conclusion: ["Equal", "a", "a"] },
          operation: { kind: "close-reflexive-equality" },
        },
        "close-reflexive-equality distinct sides": {
          spec: { conclusion: ["Equal", "a", "b"] },
          operation: { kind: "close-reflexive-equality" },
        },
        "close-reflexive-equality not an equality": {
          spec: { conclusion: "p" },
          operation: { kind: "close-reflexive-equality" },
        },
        "close-by-contradiction ok": {
          spec: { conclusion: "r", hypotheses: [p("h:p"), ["h:not", ["Not", "p"]]] },
          operation: {
            kind: "close-by-contradiction",
            hypothesisId: "h:p",
            negationHypothesisId: "h:not",
          },
        },
        "close-by-contradiction missing positive": {
          spec: { conclusion: "r", hypotheses: [p("h:p"), ["h:not", ["Not", "p"]]] },
          operation: {
            kind: "close-by-contradiction",
            hypothesisId: "h:other",
            negationHypothesisId: "h:not",
          },
        },
        "close-by-contradiction missing negation": {
          spec: { conclusion: "r", hypotheses: [p("h:p"), ["h:not", ["Not", "p"]]] },
          operation: {
            kind: "close-by-contradiction",
            hypothesisId: "h:p",
            negationHypothesisId: "h:other",
          },
        },
        "close-by-contradiction not a negation": {
          spec: { conclusion: "r", hypotheses: [p("h:p"), ["h:q", "q"]] },
          operation: {
            kind: "close-by-contradiction",
            hypothesisId: "h:p",
            negationHypothesisId: "h:q",
          },
        },
        "close-by-contradiction wrong negation": {
          spec: { conclusion: "r", hypotheses: [p("h:p"), ["h:not", ["Not", "q"]]] },
          operation: {
            kind: "close-by-contradiction",
            hypothesisId: "h:p",
            negationHypothesisId: "h:not",
          },
        },
        "close-by-accepted-inference ok": {
          spec: { conclusion: "p" },
          operation: { kind: "close-by-accepted-inference", attestationId: "attestation:one" },
        },
        "close-by-accepted-inference ok on obligation": {
          spec: { conclusion: "p" },
          operation: { kind: "close-by-accepted-inference", attestationId: "attestation:one" },
          asObligation: true,
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "close-by-accepted-inference ok": [
          "OK equivalence/background-inference",
          "obligation obligation:existing [] |- "q"",
        ],
        "close-by-accepted-inference ok on obligation": [
          "OK equivalence/background-inference",
          "goal goal:sibling [] |- "r"",
          "obligation obligation:later [] |- "q"",
        ],
        "close-by-contradiction missing negation": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "close-by-contradiction missing positive": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "close-by-contradiction not a negation": [
          "FAIL rule-not-applicable: The negation hypothesis is not a unary negation.",
        ],
        "close-by-contradiction ok": [
          "OK equivalence/structural",
          "obligation obligation:existing [] |- "q"",
        ],
        "close-by-contradiction wrong negation": [
          "FAIL rule-not-applicable: The negation hypothesis does not negate the selected hypothesis up to renaming of bound symbols.",
        ],
        "close-by-hypothesis mismatch": [
          "FAIL rule-not-applicable: The selected hypothesis does not match the conclusion up to renaming of bound symbols.",
        ],
        "close-by-hypothesis missing hypothesis": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "close-by-hypothesis ok": [
          "OK equivalence/structural",
          "obligation obligation:existing [] |- "q"",
        ],
        "close-by-hypothesis ok on obligation": [
          "OK equivalence/structural",
          "goal goal:sibling [] |- "r"",
          "obligation obligation:later [] |- "q"",
        ],
        "close-false-hypothesis missing hypothesis": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "close-false-hypothesis not falsity": [
          "FAIL rule-not-applicable: The selected hypothesis is not falsity.",
        ],
        "close-false-hypothesis ok": [
          "OK equivalence/structural",
          "obligation obligation:existing [] |- "q"",
        ],
        "close-reflexive-equality distinct sides": [
          "FAIL rule-not-applicable: The target conclusion is not a binary equality between alpha-equivalent sides.",
        ],
        "close-reflexive-equality not an equality": [
          "FAIL rule-not-applicable: The target conclusion is not a binary equality between alpha-equivalent sides.",
        ],
        "close-reflexive-equality ok": [
          "OK equivalence/structural",
          "obligation obligation:existing [] |- "q"",
        ],
        "close-true not truth": [
          "FAIL rule-not-applicable: The target conclusion is not truth.",
        ],
        "close-true ok": [
          "OK equivalence/structural",
          "obligation obligation:existing [] |- "q"",
        ],
      }
    `);
  });
});

describe("propositional operations", () => {
  const conjunction: PlainMathJson = ["And", "p", "q", "r"];
  const disjunction: PlainMathJson = ["Or", "p", "q"];
  it("pins introduction and goal-splitting operations", () => {
    expect(
      runCases({
        "introduce-implication ok": {
          spec: { conclusion: ["Implies", "p", "q"], hypotheses: [p("h:p")] },
          operation: { kind: "introduce-implication", hypothesisId: "h:new" },
        },
        "introduce-implication not an implication": {
          spec: { conclusion: "p" },
          operation: { kind: "introduce-implication", hypothesisId: "h:new" },
        },
        "introduce-implication hypothesis collision": {
          spec: { conclusion: ["Implies", "p", "q"], hypotheses: [p("h:p")] },
          operation: { kind: "introduce-implication", hypothesisId: "h:p" },
        },
        "introduce-negation ok": {
          spec: { conclusion: ["Not", "p"] },
          operation: { kind: "introduce-negation", hypothesisId: "h:new" },
        },
        "introduce-negation ok on obligation": {
          spec: { conclusion: ["Not", "p"] },
          operation: { kind: "introduce-negation", hypothesisId: "h:new" },
          asObligation: true,
        },
        "introduce-negation not a negation": {
          spec: { conclusion: "p" },
          operation: { kind: "introduce-negation", hypothesisId: "h:new" },
        },
        "introduce-negation hypothesis collision": {
          spec: { conclusion: ["Not", "p"], hypotheses: [p("h:p")] },
          operation: { kind: "introduce-negation", hypothesisId: "h:p" },
        },
        "split-goal-conjunction ok": {
          spec: { conclusion: conjunction, hypotheses: [p("h:p")] },
          operation: { kind: "split-goal-conjunction", childIds: ["c:1", "c:2", "c:3"] },
        },
        "split-goal-conjunction ok on obligation keeps provenance": {
          spec: { conclusion: conjunction },
          operation: { kind: "split-goal-conjunction", childIds: ["c:1", "c:2", "c:3"] },
          asObligation: true,
          provenance: { kind: "case" },
        },
        "split-goal-conjunction on a suffices obligation creates required obligations": {
          spec: { conclusion: conjunction },
          operation: { kind: "split-goal-conjunction", childIds: ["c:1", "c:2", "c:3"] },
          asObligation: true,
        },
        "split-goal-conjunction not a conjunction": {
          spec: { conclusion: "p" },
          operation: { kind: "split-goal-conjunction", childIds: ["c:1", "c:2"] },
        },
        "split-goal-conjunction arity mismatch": {
          spec: { conclusion: conjunction },
          operation: { kind: "split-goal-conjunction", childIds: ["c:1", "c:2"] },
        },
        "split-goal-conjunction collides with a target": {
          spec: { conclusion: conjunction },
          operation: {
            kind: "split-goal-conjunction",
            childIds: ["c:1", "obligation:existing", "c:3"],
          },
        },
        "split-goal-conjunction repeated child": {
          spec: { conclusion: conjunction },
          operation: { kind: "split-goal-conjunction", childIds: ["c:1", "c:1", "c:3"] },
        },
        "choose-goal-disjunct ok": {
          spec: { conclusion: ["Or", "p", "q", "r"] },
          operation: { kind: "choose-goal-disjunct", disjunctIndex: 1 },
        },
        "choose-goal-disjunct ok on obligation": {
          spec: { conclusion: disjunction },
          operation: { kind: "choose-goal-disjunct", disjunctIndex: 0 },
          asObligation: true,
        },
        "choose-goal-disjunct not a disjunction": {
          spec: { conclusion: "p" },
          operation: { kind: "choose-goal-disjunct", disjunctIndex: 0 },
        },
        "choose-goal-disjunct index out of range": {
          spec: { conclusion: disjunction },
          operation: { kind: "choose-goal-disjunct", disjunctIndex: 2 },
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "choose-goal-disjunct index out of range": [
          "FAIL index-out-of-range: The selected disjunct index is outside the conclusion.",
        ],
        "choose-goal-disjunct not a disjunction": [
          "FAIL rule-not-applicable: The target is not a disjunction.",
        ],
        "choose-goal-disjunct ok": [
          "OK strengthening/structural",
          "goal goal:0 [] |- "q"",
          "obligation obligation:existing [] |- "q"",
        ],
        "choose-goal-disjunct ok on obligation": [
          "OK strengthening/structural",
          "goal goal:sibling [] |- "r"",
          "obligation obligation:0 {"kind":"suffices"} [] |- "p"",
          "obligation obligation:later [] |- "q"",
        ],
        "introduce-implication hypothesis collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:p.",
        ],
        "introduce-implication not an implication": [
          "FAIL rule-not-applicable: The target conclusion is not a binary implication.",
        ],
        "introduce-implication ok": [
          "OK equivalence/structural",
          "goal goal:0 [h:p="p" h:new="p"] |- "q"",
          "obligation obligation:existing [] |- "q"",
        ],
        "introduce-negation hypothesis collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:p.",
        ],
        "introduce-negation not a negation": [
          "FAIL rule-not-applicable: The target conclusion is not a unary negation.",
        ],
        "introduce-negation ok": [
          "OK equivalence/structural",
          "goal goal:0 [h:new="p"] |- "False"",
          "obligation obligation:existing [] |- "q"",
        ],
        "introduce-negation ok on obligation": [
          "OK equivalence/structural",
          "goal goal:sibling [] |- "r"",
          "obligation obligation:0 {"kind":"suffices"} [h:new="p"] |- "False"",
          "obligation obligation:later [] |- "q"",
        ],
        "split-goal-conjunction arity mismatch": [
          "FAIL arity-mismatch: The supplied IDs must correspond one-for-one with the logical operands.",
        ],
        "split-goal-conjunction collides with a target": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: obligation:existing.",
        ],
        "split-goal-conjunction not a conjunction": [
          "FAIL rule-not-applicable: The target is not a conjunction.",
        ],
        "split-goal-conjunction ok": [
          "OK equivalence/structural",
          "goal c:1 [h:p="p"] |- "p"",
          "goal c:2 [h:p="p"] |- "q"",
          "goal c:3 [h:p="p"] |- "r"",
          "obligation obligation:existing [] |- "q"",
        ],
        "split-goal-conjunction ok on obligation keeps provenance": [
          "OK equivalence/structural",
          "goal goal:sibling [] |- "r"",
          "obligation c:1 {"kind":"case"} [] |- "p"",
          "obligation c:2 {"kind":"case"} [] |- "q"",
          "obligation c:3 {"kind":"case"} [] |- "r"",
          "obligation obligation:later [] |- "q"",
        ],
        "split-goal-conjunction on a suffices obligation creates required obligations": [
          "FAIL invalid-result-state: A transition that creates required obligations cannot be an equivalence.",
        ],
        "split-goal-conjunction repeated child": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: c:1.",
        ],
      }
    `);
  });

  it("pins hypothesis-splitting operations", () => {
    const hypotheses: Hypotheses = [["h:and", conjunction], ["h:or", disjunction], p("h:p")];
    expect(
      runCases({
        "expand-hypothesis-conjunction ok": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "expand-hypothesis-conjunction",
            hypothesisId: "h:and",
            expandedHypothesisIds: ["e:1", "e:2", "e:3"],
          },
        },
        "expand-hypothesis-conjunction missing hypothesis": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "expand-hypothesis-conjunction",
            hypothesisId: "h:other",
            expandedHypothesisIds: ["e:1", "e:2", "e:3"],
          },
        },
        "expand-hypothesis-conjunction not a conjunction": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "expand-hypothesis-conjunction",
            hypothesisId: "h:or",
            expandedHypothesisIds: ["e:1", "e:2"],
          },
        },
        "expand-hypothesis-conjunction arity mismatch": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "expand-hypothesis-conjunction",
            hypothesisId: "h:and",
            expandedHypothesisIds: ["e:1", "e:2"],
          },
        },
        "expand-hypothesis-conjunction identifier collision": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "expand-hypothesis-conjunction",
            hypothesisId: "h:and",
            expandedHypothesisIds: ["e:1", "h:p", "e:3"],
          },
        },
        "split-hypothesis-disjunction ok": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-hypothesis-disjunction",
            hypothesisId: "h:or",
            childIds: ["c:1", "c:2"],
            branchHypothesisIds: ["b:1", "b:2"],
          },
        },
        "split-hypothesis-disjunction ok on obligation records case provenance": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-hypothesis-disjunction",
            hypothesisId: "h:or",
            childIds: ["c:1", "c:2"],
            branchHypothesisIds: ["b:1", "b:2"],
          },
          asObligation: true,
        },
        "split-hypothesis-disjunction missing hypothesis": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-hypothesis-disjunction",
            hypothesisId: "h:other",
            childIds: ["c:1", "c:2"],
            branchHypothesisIds: ["b:1", "b:2"],
          },
        },
        "split-hypothesis-disjunction not a disjunction": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-hypothesis-disjunction",
            hypothesisId: "h:and",
            childIds: ["c:1", "c:2", "c:3"],
            branchHypothesisIds: ["b:1", "b:2", "b:3"],
          },
        },
        "split-hypothesis-disjunction child arity mismatch": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-hypothesis-disjunction",
            hypothesisId: "h:or",
            childIds: ["c:1", "c:2", "c:3"],
            branchHypothesisIds: ["b:1", "b:2"],
          },
        },
        "split-hypothesis-disjunction branch arity mismatch": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-hypothesis-disjunction",
            hypothesisId: "h:or",
            childIds: ["c:1", "c:2"],
            branchHypothesisIds: ["b:1", "b:2", "b:3"],
          },
        },
        "split-hypothesis-disjunction child collision": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-hypothesis-disjunction",
            hypothesisId: "h:or",
            childIds: ["goal:0", "c:2"],
            branchHypothesisIds: ["b:1", "b:2"],
          },
        },
        "split-hypothesis-disjunction branch collision": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-hypothesis-disjunction",
            hypothesisId: "h:or",
            childIds: ["c:1", "c:2"],
            branchHypothesisIds: ["b:1", "h:p"],
          },
        },
        "split-hypothesis-disjunction child collision wins over branch collision": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-hypothesis-disjunction",
            hypothesisId: "h:or",
            childIds: ["goal:0", "c:2"],
            branchHypothesisIds: ["b:1", "h:p"],
          },
        },
        "drop-hypothesis ok": {
          spec: { conclusion: "r", hypotheses },
          operation: { kind: "drop-hypothesis", hypothesisId: "h:or" },
        },
        "drop-hypothesis missing hypothesis": {
          spec: { conclusion: "r", hypotheses },
          operation: { kind: "drop-hypothesis", hypothesisId: "h:other" },
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "drop-hypothesis missing hypothesis": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "drop-hypothesis ok": [
          "OK strengthening/structural",
          "goal goal:0 [h:and=["And","p","q","r"] h:p="p"] |- "r"",
          "obligation obligation:existing [] |- "q"",
        ],
        "expand-hypothesis-conjunction arity mismatch": [
          "FAIL arity-mismatch: The supplied IDs must correspond one-for-one with the logical operands.",
        ],
        "expand-hypothesis-conjunction identifier collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:p.",
        ],
        "expand-hypothesis-conjunction missing hypothesis": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "expand-hypothesis-conjunction not a conjunction": [
          "FAIL rule-not-applicable: The selected hypothesis is not a conjunction.",
        ],
        "expand-hypothesis-conjunction ok": [
          "OK equivalence/structural",
          "goal goal:0 [e:1="p" e:2="q" e:3="r" h:or=["Or","p","q"] h:p="p"] |- "r"",
          "obligation obligation:existing [] |- "q"",
        ],
        "split-hypothesis-disjunction branch arity mismatch": [
          "FAIL arity-mismatch: The supplied IDs must correspond one-for-one with the logical operands.",
        ],
        "split-hypothesis-disjunction branch collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:p.",
        ],
        "split-hypothesis-disjunction child arity mismatch": [
          "FAIL arity-mismatch: The supplied IDs must correspond one-for-one with the logical operands.",
        ],
        "split-hypothesis-disjunction child collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: goal:0.",
        ],
        "split-hypothesis-disjunction child collision wins over branch collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: goal:0.",
        ],
        "split-hypothesis-disjunction missing hypothesis": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "split-hypothesis-disjunction not a disjunction": [
          "FAIL rule-not-applicable: The selected hypothesis is not a disjunction.",
        ],
        "split-hypothesis-disjunction ok": [
          "OK equivalence/structural",
          "goal c:1 [h:and=["And","p","q","r"] b:1="p" h:p="p"] |- "r"",
          "goal c:2 [h:and=["And","p","q","r"] b:2="q" h:p="p"] |- "r"",
          "obligation obligation:existing [] |- "q"",
        ],
        "split-hypothesis-disjunction ok on obligation records case provenance": [
          "OK equivalence/structural",
          "goal goal:sibling [] |- "r"",
          "obligation c:1 {"kind":"case"} [h:and=["And","p","q","r"] b:1="p" h:p="p"] |- "r"",
          "obligation c:2 {"kind":"case"} [h:and=["And","p","q","r"] b:2="q" h:p="p"] |- "r"",
          "obligation obligation:later [] |- "q"",
        ],
      }
    `);
  });

  it("pins proposition-introducing operations", () => {
    const hypotheses: Hypotheses = [p("h:p")];
    expect(
      runCases({
        "split-classical-cases ok": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-classical-cases",
            proposition: "q",
            childIds: ["c:1", "c:2"],
            branchHypothesisIds: ["b:1", "b:2"],
          },
        },
        "split-classical-cases ok on obligation records case provenance": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-classical-cases",
            proposition: "q",
            childIds: ["c:1", "c:2"],
            branchHypothesisIds: ["b:1", "b:2"],
          },
          asObligation: true,
        },
        "split-classical-cases invalid proposition": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-classical-cases",
            proposition: "unknownSymbol",
            childIds: ["c:1", "c:2"],
            branchHypothesisIds: ["b:1", "b:2"],
          },
        },
        "split-classical-cases child collision": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-classical-cases",
            proposition: "q",
            childIds: ["c:1", "obligation:existing"],
            branchHypothesisIds: ["b:1", "b:2"],
          },
        },
        "split-classical-cases branch collision": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "split-classical-cases",
            proposition: "q",
            childIds: ["c:1", "c:2"],
            branchHypothesisIds: ["b:1", "h:p"],
          },
        },
        "assume-hypothesis ok": {
          spec: { conclusion: "r", hypotheses },
          operation: { kind: "assume-hypothesis", proposition: "q", hypothesisId: "h:new" },
        },
        "assume-hypothesis invalid proposition": {
          spec: { conclusion: "r", hypotheses },
          operation: {
            kind: "assume-hypothesis",
            proposition: ["Add", "a", "b"],
            hypothesisId: "h:new",
          },
        },
        "assume-hypothesis identifier collision": {
          spec: { conclusion: "r", hypotheses },
          operation: { kind: "assume-hypothesis", proposition: "q", hypothesisId: "h:p" },
        },
        "replace-goal ok": {
          spec: { conclusion: "r", hypotheses },
          operation: { kind: "replace-goal", proposition: ["Or", "p", "q"] },
        },
        "replace-goal invalid proposition": {
          spec: { conclusion: "r", hypotheses },
          operation: { kind: "replace-goal", proposition: "unknownSymbol" },
        },
        "replace-goal same conclusion": {
          spec: { conclusion: "r", hypotheses },
          operation: { kind: "replace-goal", proposition: "r" },
        },
        "suffices ok on goal appends the obligation": {
          spec: { conclusion: "r", hypotheses },
          operation: { kind: "suffices", proposition: "q", obligationId: "o:new" },
        },
        "suffices ok on obligation keeps it adjacent": {
          spec: { conclusion: "r", hypotheses },
          operation: { kind: "suffices", proposition: "q", obligationId: "o:new" },
          asObligation: true,
        },
        "suffices invalid proposition": {
          spec: { conclusion: "r", hypotheses },
          operation: { kind: "suffices", proposition: "unknownSymbol", obligationId: "o:new" },
        },
        "suffices identifier collision": {
          spec: { conclusion: "r", hypotheses },
          operation: { kind: "suffices", proposition: "q", obligationId: "obligation:existing" },
        },
        "apply-implication-hypothesis ok": {
          spec: { conclusion: "r", hypotheses: [["h:imp", ["Implies", "p", "q"]], p("h:p")] },
          operation: {
            kind: "apply-implication-hypothesis",
            implicationHypothesisId: "h:imp",
            antecedentHypothesisId: "h:p",
            resultHypothesisId: "h:new",
          },
        },
        "apply-implication-hypothesis missing implication": {
          spec: { conclusion: "r", hypotheses: [["h:imp", ["Implies", "p", "q"]], p("h:p")] },
          operation: {
            kind: "apply-implication-hypothesis",
            implicationHypothesisId: "h:other",
            antecedentHypothesisId: "h:p",
            resultHypothesisId: "h:new",
          },
        },
        "apply-implication-hypothesis missing antecedent": {
          spec: { conclusion: "r", hypotheses: [["h:imp", ["Implies", "p", "q"]], p("h:p")] },
          operation: {
            kind: "apply-implication-hypothesis",
            implicationHypothesisId: "h:imp",
            antecedentHypothesisId: "h:other",
            resultHypothesisId: "h:new",
          },
        },
        "apply-implication-hypothesis not an implication": {
          spec: { conclusion: "r", hypotheses: [["h:imp", ["Implies", "p", "q"]], p("h:p")] },
          operation: {
            kind: "apply-implication-hypothesis",
            implicationHypothesisId: "h:p",
            antecedentHypothesisId: "h:p",
            resultHypothesisId: "h:new",
          },
        },
        "apply-implication-hypothesis antecedent mismatch": {
          spec: { conclusion: "r", hypotheses: [["h:imp", ["Implies", "q", "r"]], p("h:p")] },
          operation: {
            kind: "apply-implication-hypothesis",
            implicationHypothesisId: "h:imp",
            antecedentHypothesisId: "h:p",
            resultHypothesisId: "h:new",
          },
        },
        "apply-implication-hypothesis identifier collision": {
          spec: { conclusion: "r", hypotheses: [["h:imp", ["Implies", "p", "q"]], p("h:p")] },
          operation: {
            kind: "apply-implication-hypothesis",
            implicationHypothesisId: "h:imp",
            antecedentHypothesisId: "h:p",
            resultHypothesisId: "h:p",
          },
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "apply-implication-hypothesis antecedent mismatch": [
          "FAIL rule-not-applicable: The antecedent hypothesis does not exactly match the implication antecedent.",
        ],
        "apply-implication-hypothesis identifier collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:p.",
        ],
        "apply-implication-hypothesis missing antecedent": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "apply-implication-hypothesis missing implication": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "apply-implication-hypothesis not an implication": [
          "FAIL rule-not-applicable: The selected hypothesis is not a binary implication.",
        ],
        "apply-implication-hypothesis ok": [
          "OK equivalence/structural",
          "goal goal:0 [h:imp=["Implies","p","q"] h:p="p" h:new="q"] |- "r"",
          "obligation obligation:existing [] |- "q"",
        ],
        "assume-hypothesis identifier collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:p.",
        ],
        "assume-hypothesis invalid proposition": [
          "FAIL invalid-proposition: The assumed hypothesis is not a well-scoped, well-sorted proposition in the target's local context.",
        ],
        "assume-hypothesis ok": [
          "OK weakening/structural",
          "goal goal:0 [h:p="p" h:new="q"] |- "r"",
          "obligation obligation:existing [] |- "q"",
        ],
        "replace-goal invalid proposition": [
          "FAIL invalid-proposition: The replacement conclusion is not a well-scoped, well-sorted proposition in the target's local context.",
        ],
        "replace-goal ok": [
          "OK weakening/structural",
          "goal goal:0 [h:p="p"] |- ["Or","p","q"]",
          "obligation obligation:existing [] |- "q"",
        ],
        "replace-goal same conclusion": [
          "FAIL rule-not-applicable: The replacement conclusion is the current conclusion.",
        ],
        "split-classical-cases branch collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:p.",
        ],
        "split-classical-cases child collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: obligation:existing.",
        ],
        "split-classical-cases invalid proposition": [
          "FAIL invalid-proposition: The case-split proposition is not a well-scoped, well-sorted proposition in the target's local context.",
        ],
        "split-classical-cases ok": [
          "OK equivalence/structural",
          "goal c:1 [h:p="p" b:1="q"] |- "r"",
          "goal c:2 [h:p="p" b:2=["Not","q"]] |- "r"",
          "obligation obligation:existing [] |- "q"",
        ],
        "split-classical-cases ok on obligation records case provenance": [
          "OK equivalence/structural",
          "goal goal:sibling [] |- "r"",
          "obligation c:1 {"kind":"case"} [h:p="p" b:1="q"] |- "r"",
          "obligation c:2 {"kind":"case"} [h:p="p" b:2=["Not","q"]] |- "r"",
          "obligation obligation:later [] |- "q"",
        ],
        "suffices identifier collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: obligation:existing.",
        ],
        "suffices invalid proposition": [
          "FAIL invalid-proposition: The sufficient proposition is not a well-scoped, well-sorted proposition in the target's local context.",
        ],
        "suffices ok on goal appends the obligation": [
          "OK strengthening/structural",
          "goal goal:0 [h:p="p"] |- "q"",
          "obligation obligation:existing [] |- "q"",
          "obligation o:new {"kind":"suffices"} [h:p="p"] |- ["Implies","q","r"]",
        ],
        "suffices ok on obligation keeps it adjacent": [
          "OK strengthening/structural",
          "goal goal:sibling [] |- "r"",
          "obligation obligation:0 {"kind":"suffices"} [h:p="p"] |- "q"",
          "obligation o:new {"kind":"suffices"} [h:p="p"] |- ["Implies","q","r"]",
          "obligation obligation:later [] |- "q"",
        ],
      }
    `);
  });
});

describe("quantifier operations", () => {
  const witnessDeclarations = (role: string) => [
    ...baseDeclarations,
    { id: "decl:x", symbol: "x", sort: real, role },
  ];
  const universal: PlainMathJson = ["ForAll", "x", ["Equal", "x", "x"]];
  const typedUniversal: PlainMathJson = [
    "ForAll",
    ["Element", "x", "RealNumbers"],
    ["Less", "x", ["Add", "x", 1]],
  ];
  const existential: PlainMathJson = ["Exists", "x", ["Less", "a", "x"]];
  const typedExistential: PlainMathJson = [
    "Exists",
    ["Element", "x", "RealNumbers"],
    ["Less", "a", "x"],
  ];
  const typedIds = { parameterDeclarationId: "decl:new", membershipHypothesisId: "h:member" };

  it("pins introduce-universal", () => {
    expect(
      runCases({
        "untyped ok": {
          spec: { conclusion: universal, declarations: witnessDeclarations("universal-parameter") },
          operation: { kind: "introduce-universal" },
        },
        "untyped ok on obligation": {
          spec: { conclusion: universal, declarations: witnessDeclarations("universal-parameter") },
          operation: { kind: "introduce-universal" },
          asObligation: true,
        },
        "not a universal": {
          spec: { conclusion: "p" },
          operation: { kind: "introduce-universal" },
        },
        "untyped with a witness declaration": {
          spec: { conclusion: universal, declarations: witnessDeclarations("local-witness") },
          operation: { kind: "introduce-universal" },
        },
        "untyped parameter occurs in a hypothesis": {
          spec: {
            conclusion: universal,
            hypotheses: [["h:x", ["Less", "x", "a"]]],
            declarations: witnessDeclarations("universal-parameter"),
          },
          operation: { kind: "introduce-universal" },
        },
        "typed ok": {
          spec: { conclusion: typedUniversal },
          operation: { kind: "introduce-universal", ...typedIds },
        },
        "typed renames a taken name": {
          spec: { conclusion: ["ForAll", ["Element", "a", "RealNumbers"], ["Less", "a", "b"]] },
          operation: { kind: "introduce-universal", ...typedIds },
        },
        "typed without IDs": {
          spec: { conclusion: typedUniversal },
          operation: { kind: "introduce-universal" },
        },
        "typed without a membership ID": {
          spec: { conclusion: typedUniversal },
          operation: { kind: "introduce-universal", parameterDeclarationId: "decl:new" },
        },
        "typed declaration collision": {
          spec: { conclusion: typedUniversal },
          operation: { kind: "introduce-universal", ...typedIds, parameterDeclarationId: "decl:a" },
        },
        "typed hypothesis collision": {
          spec: { conclusion: typedUniversal, hypotheses: [p("h:member")] },
          operation: { kind: "introduce-universal", ...typedIds },
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "not a universal": [
          "FAIL rule-not-applicable: The target conclusion is not a universal statement.",
        ],
        "typed declaration collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: decl:a.",
        ],
        "typed hypothesis collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:member.",
        ],
        "typed ok": [
          "OK equivalence/structural",
          "goal goal:0 +decls[decl:new:x:universal-parameter] [h:member=["Element","x","RealNumbers"]] |- ["Less","x",["Add","x",1]]",
          "obligation obligation:existing [] |- "q"",
        ],
        "typed renames a taken name": [
          "OK equivalence/structural",
          "goal goal:0 +decls[decl:new:a_1:universal-parameter] [h:member=["Element","a_1","RealNumbers"]] |- ["Less","a_1","b"]",
          "obligation obligation:existing [] |- "q"",
        ],
        "typed without IDs": [
          "FAIL arity-mismatch: Introducing a typed universal needs a parameter declaration ID and a membership hypothesis ID.",
        ],
        "typed without a membership ID": [
          "FAIL arity-mismatch: Introducing a typed universal needs a parameter declaration ID and a membership hypothesis ID.",
        ],
        "untyped ok": [
          "OK equivalence/structural",
          "goal goal:0 +decls[decl:x:x:universal-parameter] [] |- ["Equal","x","x"]",
          "obligation obligation:existing [] |- "q"",
        ],
        "untyped ok on obligation": [
          "OK equivalence/structural",
          "goal goal:sibling [] |- "r"",
          "obligation obligation:0 {"kind":"suffices"} +decls[decl:x:x:universal-parameter] [] |- ["Equal","x","x"]",
          "obligation obligation:later [] |- "q"",
        ],
        "untyped parameter occurs in a hypothesis": [
          "FAIL rule-not-applicable: The universal parameter occurs freely in a local hypothesis or construction.",
        ],
        "untyped with a witness declaration": [
          "FAIL rule-not-applicable: The bound symbol requires a universal-parameter declaration in the local context.",
        ],
      }
    `);
  });

  it("pins instantiate-universal-hypothesis and choose-existential-witness", () => {
    const instantiate = { kind: "instantiate-universal-hypothesis", resultHypothesisId: "h:new" };
    const typedFacts: Hypotheses = [["h:all", typedUniversal]];
    expect(
      runCases({
        "instantiate untyped ok": {
          spec: {
            conclusion: "p",
            hypotheses: [["h:all", universal]],
            declarations: witnessDeclarations("universal-parameter"),
          },
          operation: { ...instantiate, hypothesisId: "h:all", term: "a" },
        },
        "instantiate missing hypothesis": {
          spec: { conclusion: "p", hypotheses: typedFacts },
          operation: { ...instantiate, hypothesisId: "h:other", term: "a" },
        },
        "instantiate not universal": {
          spec: { conclusion: "p", hypotheses: [p("h:p")] },
          operation: { ...instantiate, hypothesisId: "h:p", term: "a" },
        },
        "instantiate identifier collision": {
          spec: { conclusion: "p", hypotheses: typedFacts },
          operation: {
            ...instantiate,
            hypothesisId: "h:all",
            term: "a",
            resultHypothesisId: "h:all",
          },
        },
        "instantiate whose result fails state validation": {
          spec: {
            conclusion: "p",
            hypotheses: [["h:all", ["ForAll", "x", ["ForAll", "y", ["Less", "x", "y"]]]]],
            declarations: witnessDeclarations("universal-parameter"),
          },
          operation: { ...instantiate, hypothesisId: "h:all", term: "y" },
        },
        "instantiate typed discharged by a hypothesis": {
          spec: {
            conclusion: "p",
            hypotheses: [...typedFacts, ["h:member", ["Element", "a", "RealNumbers"]]],
          },
          operation: { ...instantiate, hypothesisId: "h:all", term: "a" },
        },
        "instantiate typed makes an obligation on a goal": {
          spec: { conclusion: "p", hypotheses: typedFacts },
          operation: {
            ...instantiate,
            hypothesisId: "h:all",
            term: "a",
            membershipObligationId: "o:member",
          },
        },
        "instantiate typed makes an obligation next to an obligation": {
          spec: { conclusion: "p", hypotheses: typedFacts },
          operation: {
            ...instantiate,
            hypothesisId: "h:all",
            term: "a",
            membershipObligationId: "o:member",
          },
          asObligation: true,
        },
        "instantiate typed without an obligation ID": {
          spec: { conclusion: "p", hypotheses: typedFacts },
          operation: { ...instantiate, hypothesisId: "h:all", term: "a" },
        },
        "instantiate typed obligation collision": {
          spec: { conclusion: "p", hypotheses: typedFacts },
          operation: {
            ...instantiate,
            hypothesisId: "h:all",
            term: "a",
            membershipObligationId: "obligation:existing",
          },
        },
        "witness untyped ok": {
          spec: {
            conclusion: existential,
            declarations: witnessDeclarations("universal-parameter"),
          },
          operation: { kind: "choose-existential-witness", witness: "b" },
        },
        "witness typed ok": {
          spec: { conclusion: typedExistential },
          operation: { kind: "choose-existential-witness", witness: ["Add", "a", 1] },
        },
        "witness not existential": {
          spec: { conclusion: "p" },
          operation: { kind: "choose-existential-witness", witness: "a" },
        },
        "witness whose result fails state validation": {
          spec: {
            conclusion: ["Exists", "x", ["Exists", "y", ["Less", "x", "y"]]],
            declarations: witnessDeclarations("universal-parameter"),
          },
          operation: { kind: "choose-existential-witness", witness: "y" },
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "instantiate identifier collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:all.",
        ],
        "instantiate missing hypothesis": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "instantiate not universal": [
          "FAIL rule-not-applicable: The selected hypothesis is not universal.",
        ],
        "instantiate typed discharged by a hypothesis": [
          "OK equivalence/structural",
          "goal goal:0 [h:all=["ForAll",["Element","x","RealNumbers"],["Less","x",["Add","x",1]]] h:member=["Element","a","RealNumbers"] h:new=["Less","a",["Add","a",1]]] |- "p"",
          "obligation obligation:existing [] |- "q"",
        ],
        "instantiate typed makes an obligation next to an obligation": [
          "OK strengthening/structural",
          "goal goal:sibling [] |- "r"",
          "obligation obligation:0 {"kind":"suffices"} [h:all=["ForAll",["Element","x","RealNumbers"],["Less","x",["Add","x",1]]] h:new=["Less","a",["Add","a",1]]] |- "p"",
          "obligation o:member {"kind":"binder-membership","hypothesisId":"h:all"} [h:all=["ForAll",["Element","x","RealNumbers"],["Less","x",["Add","x",1]]]] |- ["Element","a","RealNumbers"]",
          "obligation obligation:later [] |- "q"",
        ],
        "instantiate typed makes an obligation on a goal": [
          "OK strengthening/structural",
          "goal goal:0 [h:all=["ForAll",["Element","x","RealNumbers"],["Less","x",["Add","x",1]]] h:new=["Less","a",["Add","a",1]]] |- "p"",
          "obligation obligation:existing [] |- "q"",
          "obligation o:member {"kind":"binder-membership","hypothesisId":"h:all"} [h:all=["ForAll",["Element","x","RealNumbers"],["Less","x",["Add","x",1]]]] |- ["Element","a","RealNumbers"]",
        ],
        "instantiate typed obligation collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: obligation:existing.",
        ],
        "instantiate typed without an obligation ID": [
          "FAIL arity-mismatch: Instantiating a typed universal at an unproven member needs a membership obligation ID.",
        ],
        "instantiate untyped ok": [
          "OK equivalence/structural",
          "goal goal:0 +decls[decl:x:x:universal-parameter] [h:all=["ForAll","x",["Equal","x","x"]] h:new=["Equal","a","a"]] |- "p"",
          "obligation obligation:existing [] |- "q"",
        ],
        "instantiate whose result fails state validation": [
          "FAIL invalid-result-state: The resulting proof state failed executable-state validation. @goals.0.sequent.context.hypotheses.1.statement.expression",
        ],
        "witness not existential": [
          "FAIL rule-not-applicable: The target conclusion is not existential.",
        ],
        "witness typed ok": [
          "OK strengthening/structural",
          "goal goal:0 [] |- ["And",["Element",["Add","a",1],"RealNumbers"],["Less","a",["Add","a",1]]]",
          "obligation obligation:existing [] |- "q"",
        ],
        "witness untyped ok": [
          "OK strengthening/structural",
          "goal goal:0 +decls[decl:x:x:universal-parameter] [] |- ["Less","a","b"]",
          "obligation obligation:existing [] |- "q"",
        ],
        "witness whose result fails state validation": [
          "FAIL invalid-result-state: The resulting proof state failed executable-state validation. @goals.0.sequent.conclusion.expression",
        ],
      }
    `);
  });

  it("pins unpack-existential-hypothesis", () => {
    const unpack = { kind: "unpack-existential-hypothesis", resultHypothesisId: "h:body" };
    const typedIdsForUnpack = {
      witnessDeclarationId: "decl:w",
      membershipHypothesisId: "h:member",
    };
    expect(
      runCases({
        "untyped ok": {
          spec: {
            conclusion: "p",
            hypotheses: [["h:ex", existential]],
            declarations: witnessDeclarations("local-witness"),
          },
          operation: { ...unpack, hypothesisId: "h:ex" },
        },
        "missing hypothesis": {
          spec: { conclusion: "p", hypotheses: [["h:ex", typedExistential]] },
          operation: { ...unpack, hypothesisId: "h:other" },
        },
        "not existential": {
          spec: { conclusion: "p", hypotheses: [p("h:p")] },
          operation: { ...unpack, hypothesisId: "h:p" },
        },
        "untyped with a parameter declaration": {
          spec: {
            conclusion: "p",
            hypotheses: [["h:ex", existential]],
            declarations: witnessDeclarations("universal-parameter"),
          },
          operation: { ...unpack, hypothesisId: "h:ex" },
        },
        "untyped witness not fresh": {
          spec: {
            conclusion: ["Less", "x", "a"],
            hypotheses: [["h:ex", existential]],
            declarations: witnessDeclarations("local-witness"),
          },
          operation: { ...unpack, hypothesisId: "h:ex" },
        },
        "untyped identifier collision": {
          spec: {
            conclusion: "p",
            hypotheses: [["h:ex", existential]],
            declarations: witnessDeclarations("local-witness"),
          },
          operation: { ...unpack, hypothesisId: "h:ex", resultHypothesisId: "h:ex" },
        },
        "typed ok": {
          spec: { conclusion: "p", hypotheses: [["h:ex", typedExistential]] },
          operation: { ...unpack, hypothesisId: "h:ex", ...typedIdsForUnpack },
        },
        "typed ok on obligation": {
          spec: { conclusion: "p", hypotheses: [["h:ex", typedExistential]] },
          operation: { ...unpack, hypothesisId: "h:ex", ...typedIdsForUnpack },
          asObligation: true,
        },
        "typed without IDs": {
          spec: { conclusion: "p", hypotheses: [["h:ex", typedExistential]] },
          operation: { ...unpack, hypothesisId: "h:ex" },
        },
        "typed declaration collision": {
          spec: { conclusion: "p", hypotheses: [["h:ex", typedExistential]] },
          operation: {
            ...unpack,
            hypothesisId: "h:ex",
            ...typedIdsForUnpack,
            witnessDeclarationId: "decl:a",
          },
        },
        "typed membership collision": {
          spec: { conclusion: "p", hypotheses: [["h:ex", typedExistential]] },
          operation: {
            ...unpack,
            hypothesisId: "h:ex",
            ...typedIdsForUnpack,
            membershipHypothesisId: "h:ex",
          },
        },
        "typed result collision": {
          spec: { conclusion: "p", hypotheses: [["h:ex", typedExistential]] },
          operation: {
            ...unpack,
            hypothesisId: "h:ex",
            ...typedIdsForUnpack,
            resultHypothesisId: "h:member",
          },
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "missing hypothesis": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "not existential": [
          "FAIL rule-not-applicable: The selected hypothesis is not existential.",
        ],
        "typed declaration collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: decl:a.",
        ],
        "typed membership collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:ex.",
        ],
        "typed ok": [
          "OK equivalence/structural",
          "goal goal:0 +decls[decl:w:x:local-witness] [h:member=["Element","x","RealNumbers"] h:body=["Less","a","x"]] |- "p"",
          "obligation obligation:existing [] |- "q"",
        ],
        "typed ok on obligation": [
          "OK equivalence/structural",
          "goal goal:sibling [] |- "r"",
          "obligation obligation:0 {"kind":"suffices"} +decls[decl:w:x:local-witness] [h:member=["Element","x","RealNumbers"] h:body=["Less","a","x"]] |- "p"",
          "obligation obligation:later [] |- "q"",
        ],
        "typed result collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:member.",
        ],
        "typed without IDs": [
          "FAIL arity-mismatch: Unpacking a typed existential needs a witness declaration ID and a membership hypothesis ID.",
        ],
        "untyped identifier collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:ex.",
        ],
        "untyped ok": [
          "OK equivalence/structural",
          "goal goal:0 +decls[decl:x:x:local-witness] [h:body=["Less","a","x"]] |- "p"",
          "obligation obligation:existing [] |- "q"",
        ],
        "untyped with a parameter declaration": [
          "FAIL rule-not-applicable: The bound symbol requires a local-witness declaration in the local context.",
        ],
        "untyped witness not fresh": [
          "FAIL rule-not-applicable: The existential witness is not fresh for the rest of the contextual sequent.",
        ],
      }
    `);
  });
});

describe("library result operations", () => {
  const prop = (symbol: string) => ({ symbol, sort: PROPOSITION_SORT });
  const modusPonens = {
    id: "result:modus-ponens",
    parameters: [prop("p"), prop("q")],
    premises: [{ expression: ["Implies", "p", "q"] }, { expression: "p" }],
    conclusion: { expression: "q" },
    directions: ["backward", "forward"],
  } as unknown as KernelResult;
  const forwardOnly = {
    id: "result:forward-only",
    parameters: [prop("p")],
    premises: [{ expression: "p" }],
    conclusion: { expression: ["Or", "p", "p"] },
    directions: ["forward"],
  } as unknown as KernelResult;
  const environment: KernelEnvironment = { results: [modusPonens, forwardOnly] };
  const both = { p: "p", q: "q" };
  const backward = { kind: "apply-result-backward", resultId: "result:modus-ponens" };
  const forward = {
    kind: "apply-result-forward",
    resultId: "result:modus-ponens",
    instantiation: both,
    resultHypothesisId: "h:new",
  };
  const facts: Hypotheses = [["h:imp", ["Implies", "p", "q"]], p("h:p")];

  it("pins apply-result-backward", () => {
    expect(
      runCases({
        "ok on a goal": {
          spec: { conclusion: "q", hypotheses: facts },
          operation: { ...backward, instantiation: both, premiseTargetIds: ["t:1", "t:2"] },
          environment,
        },
        "ok on an obligation records premise provenance": {
          spec: { conclusion: "q", hypotheses: facts },
          operation: { ...backward, instantiation: both, premiseTargetIds: ["t:1", "t:2"] },
          asObligation: true,
          environment,
        },
        "result not found": {
          spec: { conclusion: "q" },
          operation: {
            ...backward,
            resultId: "result:none",
            instantiation: both,
            premiseTargetIds: [],
          },
          environment,
        },
        "direction not permitted": {
          spec: { conclusion: ["Or", "p", "p"] },
          operation: {
            ...backward,
            resultId: "result:forward-only",
            instantiation: { p: "p" },
            premiseTargetIds: ["t:1"],
          },
          environment,
        },
        "missing instantiation": {
          spec: { conclusion: "q" },
          operation: { ...backward, instantiation: { q: "q" }, premiseTargetIds: ["t:1", "t:2"] },
          environment,
        },
        "conclusion mismatch": {
          spec: { conclusion: "r" },
          operation: { ...backward, instantiation: both, premiseTargetIds: ["t:1", "t:2"] },
          environment,
        },
        "premise target arity mismatch": {
          spec: { conclusion: "q" },
          operation: { ...backward, instantiation: both, premiseTargetIds: ["t:1"] },
          environment,
        },
        "premise target collision": {
          spec: { conclusion: "q" },
          operation: { ...backward, instantiation: both, premiseTargetIds: ["t:1", "goal:0"] },
          environment,
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "conclusion mismatch": [
          "FAIL conclusion-mismatch: The instantiated result conclusion does not match the target conclusion up to renaming of bound symbols.",
        ],
        "direction not permitted": [
          "FAIL direction-not-permitted: The result result:forward-only is not approved for backward application.",
        ],
        "missing instantiation": [
          "FAIL missing-instantiation: The instantiation does not supply a term for parameter p.",
        ],
        "ok on a goal": [
          "OK strengthening/library-result result:modus-ponens",
          "goal t:1 [h:imp=["Implies","p","q"] h:p="p"] |- ["Implies","p","q"]",
          "goal t:2 [h:imp=["Implies","p","q"] h:p="p"] |- "p"",
          "obligation obligation:existing [] |- "q"",
        ],
        "ok on an obligation records premise provenance": [
          "OK strengthening/library-result result:modus-ponens",
          "goal goal:sibling [] |- "r"",
          "obligation t:1 {"kind":"premise-of-result","resultId":"result:modus-ponens"} [h:imp=["Implies","p","q"] h:p="p"] |- ["Implies","p","q"]",
          "obligation t:2 {"kind":"premise-of-result","resultId":"result:modus-ponens"} [h:imp=["Implies","p","q"] h:p="p"] |- "p"",
          "obligation obligation:later [] |- "q"",
        ],
        "premise target arity mismatch": [
          "FAIL arity-mismatch: The supplied premise target IDs must correspond one-for-one with the result premises.",
        ],
        "premise target collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: goal:0.",
        ],
        "result not found": [
          "FAIL result-not-found: No result result:none is in the environment.",
        ],
      }
    `);
  });

  it("pins apply-result-forward", () => {
    expect(
      runCases({
        "ok with every premise matched": {
          spec: { conclusion: "r", hypotheses: facts },
          operation: {
            ...forward,
            premiseHypothesisIds: ["h:imp", "h:p"],
            obligationIds: [],
          },
          environment,
        },
        "ok with unmet premises on a goal": {
          spec: { conclusion: "r", hypotheses: facts },
          operation: { ...forward, premiseHypothesisIds: ["h:imp", null], obligationIds: ["o:1"] },
          environment,
        },
        "ok with unmet premises on an obligation": {
          spec: { conclusion: "r", hypotheses: facts },
          operation: {
            ...forward,
            premiseHypothesisIds: [null, null],
            obligationIds: ["o:1", "o:2"],
          },
          asObligation: true,
          environment,
        },
        "result not found": {
          spec: { conclusion: "r" },
          operation: {
            ...forward,
            resultId: "result:none",
            premiseHypothesisIds: [],
            obligationIds: [],
          },
          environment,
        },
        "missing instantiation": {
          spec: { conclusion: "r", hypotheses: facts },
          operation: {
            ...forward,
            instantiation: { p: "p" },
            premiseHypothesisIds: ["h:imp", "h:p"],
            obligationIds: [],
          },
          environment,
        },
        "premise list arity mismatch": {
          spec: { conclusion: "r", hypotheses: facts },
          operation: { ...forward, premiseHypothesisIds: ["h:imp"], obligationIds: [] },
          environment,
        },
        "missing hypothesis": {
          spec: { conclusion: "r", hypotheses: facts },
          operation: {
            ...forward,
            premiseHypothesisIds: ["h:other", "h:p"],
            obligationIds: [],
          },
          environment,
        },
        "premise mismatch": {
          spec: { conclusion: "r", hypotheses: facts },
          operation: { ...forward, premiseHypothesisIds: ["h:p", "h:p"], obligationIds: [] },
          environment,
        },
        "obligation arity mismatch": {
          spec: { conclusion: "r", hypotheses: facts },
          operation: {
            ...forward,
            premiseHypothesisIds: ["h:imp", null],
            obligationIds: ["o:1", "o:2"],
          },
          environment,
        },
        "obligation collision": {
          spec: { conclusion: "r", hypotheses: facts },
          operation: {
            ...forward,
            premiseHypothesisIds: ["h:imp", null],
            obligationIds: ["obligation:existing"],
          },
          environment,
        },
        "result hypothesis collision": {
          spec: { conclusion: "r", hypotheses: facts },
          operation: {
            ...forward,
            resultHypothesisId: "h:p",
            premiseHypothesisIds: ["h:imp", "h:p"],
            obligationIds: [],
          },
          environment,
        },
        "obligation collision wins over hypothesis collision": {
          spec: { conclusion: "r", hypotheses: facts },
          operation: {
            ...forward,
            resultHypothesisId: "h:p",
            premiseHypothesisIds: ["h:imp", null],
            obligationIds: ["obligation:existing"],
          },
          environment,
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "missing hypothesis": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "missing instantiation": [
          "FAIL missing-instantiation: The instantiation does not supply a term for parameter q.",
        ],
        "obligation arity mismatch": [
          "FAIL arity-mismatch: The supplied obligation IDs must correspond one-for-one with the unmatched premises.",
        ],
        "obligation collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: obligation:existing.",
        ],
        "obligation collision wins over hypothesis collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: obligation:existing.",
        ],
        "ok with every premise matched": [
          "OK equivalence/library-result result:modus-ponens",
          "goal goal:0 [h:imp=["Implies","p","q"] h:p="p" h:new="q"] |- "r"",
          "obligation obligation:existing [] |- "q"",
        ],
        "ok with unmet premises on a goal": [
          "OK strengthening/library-result result:modus-ponens",
          "goal goal:0 [h:imp=["Implies","p","q"] h:p="p" h:new="q"] |- "r"",
          "obligation obligation:existing [] |- "q"",
          "obligation o:1 {"kind":"premise-of-result","resultId":"result:modus-ponens"} [h:imp=["Implies","p","q"] h:p="p"] |- "p"",
        ],
        "ok with unmet premises on an obligation": [
          "OK strengthening/library-result result:modus-ponens",
          "goal goal:sibling [] |- "r"",
          "obligation obligation:0 {"kind":"suffices"} [h:imp=["Implies","p","q"] h:p="p" h:new="q"] |- "r"",
          "obligation o:1 {"kind":"premise-of-result","resultId":"result:modus-ponens"} [h:imp=["Implies","p","q"] h:p="p"] |- ["Implies","p","q"]",
          "obligation o:2 {"kind":"premise-of-result","resultId":"result:modus-ponens"} [h:imp=["Implies","p","q"] h:p="p"] |- "p"",
          "obligation obligation:later [] |- "q"",
        ],
        "premise list arity mismatch": [
          "FAIL arity-mismatch: The premise hypothesis list must have one entry per result premise.",
        ],
        "premise mismatch": [
          "FAIL premise-mismatch: Hypothesis h:p does not match result premise 0 up to renaming of bound symbols.",
        ],
        "result hypothesis collision": [
          "FAIL identifier-collision: The supplied statement ID is not fresh: h:p.",
        ],
        "result not found": [
          "FAIL result-not-found: No result result:none is in the environment.",
        ],
      }
    `);
  });
});

describe("rewrite operations", () => {
  const equality: Hypotheses = [["h:eq", ["Equal", "a", "b"]]];
  const equivalence: Hypotheses = [["h:iff", ["Equivalent", "p", "q"]]];
  const implication: Hypotheses = [["h:imp", ["Implies", "p", "q"]]];
  const hypothesisSource = (hypothesisId: string) => ({ kind: "hypothesis", hypothesisId });
  const conclusion = { kind: "conclusion" };

  it("pins the rewrite diagnostics", () => {
    expect(
      runCases({
        "equality ok on the conclusion": {
          spec: { conclusion: ["Less", "a", "y"], hypotheses: equality },
          operation: {
            kind: "rewrite-with-equality",
            equalityHypothesisId: "h:eq",
            statement: conclusion,
            path: [0],
            direction: "forward",
          },
        },
        "equality ok backward on a hypothesis": {
          spec: { conclusion: "p", hypotheses: [...equality, ["h:lt", ["Less", "b", "y"]]] },
          operation: {
            kind: "rewrite-with-equality",
            equalityHypothesisId: "h:eq",
            statement: { kind: "hypothesis", id: "h:lt" },
            path: [0],
            direction: "backward",
          },
        },
        "equality missing source": {
          spec: { conclusion: ["Less", "a", "y"], hypotheses: equality },
          operation: {
            kind: "rewrite-with-equality",
            equalityHypothesisId: "h:other",
            statement: conclusion,
            path: [0],
            direction: "forward",
          },
        },
        "equality source is not an equality": {
          spec: { conclusion: ["Less", "a", "y"], hypotheses: [p("h:p")] },
          operation: {
            kind: "rewrite-with-equality",
            equalityHypothesisId: "h:p",
            statement: conclusion,
            path: [0],
            direction: "forward",
          },
        },
        "equality source rewrites itself": {
          spec: { conclusion: "p", hypotheses: equality },
          operation: {
            kind: "rewrite-with-equality",
            equalityHypothesisId: "h:eq",
            statement: { kind: "hypothesis", id: "h:eq" },
            path: [0],
            direction: "forward",
          },
        },
        "equality target hypothesis missing": {
          spec: { conclusion: "p", hypotheses: equality },
          operation: {
            kind: "rewrite-with-equality",
            equalityHypothesisId: "h:eq",
            statement: { kind: "hypothesis", id: "h:other" },
            path: [0],
            direction: "forward",
          },
        },
        "equality without a distinct replacement": {
          spec: { conclusion: ["Less", "a", "y"], hypotheses: [["h:eq", ["Equal", "a", "a"]]] },
          operation: {
            kind: "rewrite-with-equality",
            equalityHypothesisId: "h:eq",
            statement: conclusion,
            path: [0],
            direction: "forward",
          },
        },
        "equality invalid path": {
          spec: { conclusion: ["Less", "a", "y"], hypotheses: equality },
          operation: {
            kind: "rewrite-with-equality",
            equalityHypothesisId: "h:eq",
            statement: conclusion,
            path: [5],
            direction: "forward",
          },
        },
        "equality occurrence mismatch": {
          spec: { conclusion: ["Less", "y", "a"], hypotheses: equality },
          operation: {
            kind: "rewrite-with-equality",
            equalityHypothesisId: "h:eq",
            statement: conclusion,
            path: [0],
            direction: "forward",
          },
        },
        "equivalence ok": {
          spec: { conclusion: ["Or", "p", "r"], hypotheses: equivalence },
          operation: {
            kind: "rewrite-with-equivalence",
            statement: conclusion,
            path: [0],
            source: hypothesisSource("h:iff"),
            direction: "forward",
          },
        },
        "equivalence occurrence not a proposition": {
          spec: { conclusion: ["Less", "a", "y"], hypotheses: equivalence },
          operation: {
            kind: "rewrite-with-equivalence",
            statement: conclusion,
            path: [0],
            source: hypothesisSource("h:iff"),
            direction: "forward",
          },
        },
        "equivalence source is not an equivalence": {
          spec: { conclusion: ["Or", "p", "r"], hypotheses: implication },
          operation: {
            kind: "rewrite-with-equivalence",
            statement: conclusion,
            path: [0],
            source: hypothesisSource("h:imp"),
            direction: "forward",
          },
        },
        "equivalence result not found": {
          spec: { conclusion: ["Or", "p", "r"] },
          operation: {
            kind: "rewrite-with-equivalence",
            statement: conclusion,
            path: [0],
            source: { kind: "result", resultId: "result:none", instantiation: {} },
            direction: "forward",
          },
        },
        "implication ok at a positive position": {
          spec: { conclusion: ["Or", "q", "r"], hypotheses: implication },
          operation: {
            kind: "rewrite-with-implication",
            statement: conclusion,
            path: [0],
            source: hypothesisSource("h:imp"),
          },
        },
        "implication ok at a negative position": {
          spec: { conclusion: "r", hypotheses: [...implication, ["h:or", ["Or", "p", "r"]]] },
          operation: {
            kind: "rewrite-with-implication",
            statement: { kind: "hypothesis", id: "h:or" },
            path: [0],
            source: hypothesisSource("h:imp"),
          },
        },
        "implication at a mixed position": {
          spec: { conclusion: ["Equivalent", "q", "r"], hypotheses: implication },
          operation: {
            kind: "rewrite-with-implication",
            statement: conclusion,
            path: [0],
            source: hypothesisSource("h:imp"),
          },
        },
        "implication occurrence mismatch": {
          spec: { conclusion: ["Or", "r", "r"], hypotheses: implication },
          operation: {
            kind: "rewrite-with-implication",
            statement: conclusion,
            path: [0],
            source: hypothesisSource("h:imp"),
          },
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "equality invalid path": [
          "FAIL invalid-path: The rewrite path or lens does not address an occurrence.",
        ],
        "equality missing source": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "equality occurrence mismatch": [
          "FAIL rule-not-applicable: The selected occurrence does not match the equality side.",
        ],
        "equality ok backward on a hypothesis": [
          "OK equivalence/structural",
          "goal goal:0 [h:eq=["Equal","a","b"] h:lt=["Less","a","y"]] |- "p"",
          "obligation obligation:existing [] |- "q"",
        ],
        "equality ok on the conclusion": [
          "OK equivalence/structural",
          "goal goal:0 [h:eq=["Equal","a","b"]] |- ["Less","b","y"]",
          "obligation obligation:existing [] |- "q"",
        ],
        "equality source is not an equality": [
          "FAIL rule-not-applicable: The rewrite source is not a binary equality.",
        ],
        "equality source rewrites itself": [
          "FAIL rule-not-applicable: A rewrite source cannot consume itself as its own target.",
        ],
        "equality target hypothesis missing": [
          "FAIL hypothesis-not-found: The hypothesis does not exist in the target's local context.",
        ],
        "equality without a distinct replacement": [
          "FAIL rule-not-applicable: The equality does not provide a distinct replacement.",
        ],
        "equivalence occurrence not a proposition": [
          "FAIL invalid-path: The rewrite occurrence is not in a proposition position.",
        ],
        "equivalence ok": [
          "OK equivalence/structural",
          "goal goal:0 [h:iff=["Equivalent","p","q"]] |- ["Or","q","r"]",
          "obligation obligation:existing [] |- "q"",
        ],
        "equivalence result not found": [
          "FAIL result-not-found: No result result:none is in the environment.",
        ],
        "equivalence source is not an equivalence": [
          "FAIL rule-not-applicable: The rewrite source is not a binary equivalence.",
        ],
        "implication at a mixed position": [
          "FAIL polarity-not-permitted: An implication cannot rewrite at a mixed position; only positive and negative positions are monotone.",
        ],
        "implication occurrence mismatch": [
          "FAIL rule-not-applicable: The selected occurrence does not match the implication side.",
        ],
        "implication ok at a negative position": [
          "OK strengthening/structural",
          "goal goal:0 [h:imp=["Implies","p","q"] h:or=["Or","q","r"]] |- "r"",
          "obligation obligation:existing [] |- "q"",
        ],
        "implication ok at a positive position": [
          "OK strengthening/structural",
          "goal goal:0 [h:imp=["Implies","p","q"]] |- ["Or","p","r"]",
          "obligation obligation:existing [] |- "q"",
        ],
      }
    `);
  });
});

type Fields = Readonly<Record<string, unknown>>;

/** A valid example of every non-construction operation, with every optional field present. */
const VALID_OPERATIONS: Readonly<Record<string, Fields>> = {
  "close-by-hypothesis": { hypothesisId: "h:a" },
  "close-true": {},
  "close-false-hypothesis": { hypothesisId: "h:a" },
  "close-reflexive-equality": {},
  "close-by-contradiction": { hypothesisId: "h:a", negationHypothesisId: "h:b" },
  "close-by-accepted-inference": { attestationId: "attestation:a" },
  "introduce-implication": { hypothesisId: "h:a" },
  "introduce-negation": { hypothesisId: "h:a" },
  "split-goal-conjunction": { childIds: ["c:1", "c:2"] },
  "choose-goal-disjunct": { disjunctIndex: 1 },
  "expand-hypothesis-conjunction": { hypothesisId: "h:a", expandedHypothesisIds: ["e:1", "e:2"] },
  "split-hypothesis-disjunction": {
    hypothesisId: "h:a",
    childIds: ["c:1", "c:2"],
    branchHypothesisIds: ["b:1", "b:2"],
  },
  "split-classical-cases": {
    proposition: "p",
    childIds: ["c:1", "c:2"],
    branchHypothesisIds: ["b:1", "b:2"],
  },
  "assume-hypothesis": { proposition: "p", hypothesisId: "h:a" },
  "replace-goal": { proposition: "p" },
  suffices: { proposition: "p", obligationId: "o:a" },
  "drop-hypothesis": { hypothesisId: "h:a" },
  "apply-implication-hypothesis": {
    implicationHypothesisId: "h:i",
    antecedentHypothesisId: "h:a",
    resultHypothesisId: "h:r",
  },
  "introduce-universal": { parameterDeclarationId: "decl:p", membershipHypothesisId: "h:m" },
  "instantiate-universal-hypothesis": {
    hypothesisId: "h:a",
    term: "a",
    resultHypothesisId: "h:r",
    membershipObligationId: "o:m",
  },
  "choose-existential-witness": { witness: "a" },
  "unpack-existential-hypothesis": {
    hypothesisId: "h:a",
    resultHypothesisId: "h:r",
    witnessDeclarationId: "decl:w",
    membershipHypothesisId: "h:m",
  },
  "rewrite-with-equality": {
    equalityHypothesisId: "h:e",
    statement: { kind: "conclusion" },
    path: [0, 1],
    lens: { startOperand: 0, endOperand: 2 },
    direction: "forward",
  },
  "rewrite-with-equivalence": {
    statement: { kind: "hypothesis", id: "h:a" },
    path: [0, 1],
    lens: { startOperand: 0, endOperand: 2 },
    source: { kind: "hypothesis", hypothesisId: "h:e" },
    direction: "backward",
  },
  "rewrite-with-implication": {
    statement: { kind: "conclusion" },
    path: [0, 1],
    lens: { startOperand: 0, endOperand: 2 },
    source: { kind: "result", resultId: "result:a", instantiation: { a: "b" } },
  },
  "apply-result-backward": {
    resultId: "result:a",
    instantiation: { a: "b" },
    premiseTargetIds: ["t:1"],
  },
  "apply-result-forward": {
    resultId: "result:a",
    instantiation: { a: "b" },
    premiseHypothesisIds: ["h:a", null],
    resultHypothesisId: "h:r",
    obligationIds: ["o:1"],
  },
  "mark-sorry": { assumptionId: "assumption:a", sorryId: "sorry:a" },
  "close-by-assumption": { assumptionId: "assumption:a", instantiation: { a: "b" } },
};

const BASE_FIELDS: Fields = {
  expectedStateId: "state:before",
  resultStateId: "state:after",
  target: { kind: "goal", id: "goal:0" },
};

/** An invalid value for every field name; `disjunctIndex` and expressions need a non-obvious one. */
function invalidValue(field: string): unknown {
  if (field === "disjunctIndex") return -1;
  if (["term", "witness", "proposition"].includes(field)) return { fn: 7 };
  return 7;
}

/** A copy of the array with an empty slot at `index`. */
function withHole<Item>(items: readonly Item[], index: number): Item[] {
  const copy = [...items];
  delete copy[index];
  return copy;
}

function parsePath(operation: Fields): string {
  const result = kernelOperationSchema.safeParse(operation);
  return result.success ? "valid" : `@${(result.error.issues[0]?.path ?? []).join(".")}`;
}

function parseIssue(operation: Fields): string {
  const result = kernelOperationSchema.safeParse(operation);
  if (result.success) return "valid";
  const issue = result.error.issues[0];
  return `@${(issue?.path ?? []).join(".")} ${issue?.message}`;
}

describe("kernelOperationSchema", () => {
  it("accepts the valid example of every operation unchanged", () => {
    for (const [kind, fields] of Object.entries(VALID_OPERATIONS)) {
      const operation = { kind, ...BASE_FIELDS, ...fields };
      expect(kernelOperationSchema.safeParse(operation)).toEqual({
        success: true,
        data: operation,
      });
    }
  });

  it("pins the diagnostic of every invalid field", () => {
    const issues = Object.fromEntries(
      Object.entries(VALID_OPERATIONS).map(([kind, fields]) => {
        const valid = { kind, ...BASE_FIELDS, ...fields };
        return [
          kind,
          Object.fromEntries(
            Object.keys(valid)
              .filter((field) => field !== "kind")
              .map((field) => [field, parseIssue({ ...valid, [field]: invalidValue(field) })]),
          ),
        ];
      }),
    );
    expect(issues).toMatchInlineSnapshot(`
      {
        "apply-implication-hypothesis": {
          "antecedentHypothesisId": "@antecedentHypothesisId The statement ID is invalid.",
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "implicationHypothesisId": "@implicationHypothesisId The statement ID is invalid.",
          "resultHypothesisId": "@resultHypothesisId The statement ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "apply-result-backward": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "instantiation": "@instantiation An instantiation must map parameter symbols to plain MathJSON terms.",
          "premiseTargetIds": "@premiseTargetIds An ID list must contain stable, dense IDs.",
          "resultId": "@resultId The result ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "apply-result-forward": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "instantiation": "@instantiation An instantiation must map parameter symbols to plain MathJSON terms.",
          "obligationIds": "@obligationIds An ID list must contain stable, dense IDs.",
          "premiseHypothesisIds": "@premiseHypothesisIds Premise hypothesis entries must be stable IDs or null.",
          "resultHypothesisId": "@resultHypothesisId The statement ID is invalid.",
          "resultId": "@resultId The result ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "assume-hypothesis": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "hypothesisId": "@hypothesisId The statement ID is invalid.",
          "proposition": "@proposition An expression must be serializable plain MathJSON.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "choose-existential-witness": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
          "witness": "@witness An expression must be serializable plain MathJSON.",
        },
        "choose-goal-disjunct": {
          "disjunctIndex": "@disjunctIndex A disjunct index must be a nonnegative integer.",
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "close-by-accepted-inference": {
          "attestationId": "@attestationId The attestation ID is invalid.",
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "close-by-assumption": {
          "assumptionId": "@assumptionId The assumption ID is invalid.",
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "instantiation": "@instantiation An instantiation must map parameter symbols to plain MathJSON terms.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "close-by-contradiction": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "hypothesisId": "@hypothesisId The statement ID is invalid.",
          "negationHypothesisId": "@negationHypothesisId The statement ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "close-by-hypothesis": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "hypothesisId": "@hypothesisId The statement ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "close-false-hypothesis": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "hypothesisId": "@hypothesisId The statement ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "close-reflexive-equality": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "close-true": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "drop-hypothesis": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "hypothesisId": "@hypothesisId The statement ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "expand-hypothesis-conjunction": {
          "expandedHypothesisIds": "@expandedHypothesisIds An ID list requires at least two stable, dense IDs.",
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "hypothesisId": "@hypothesisId The statement ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "instantiate-universal-hypothesis": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "hypothesisId": "@hypothesisId The statement ID is invalid.",
          "membershipObligationId": "@ Runtime schema validation could not inspect the value safely.",
          "resultHypothesisId": "@resultHypothesisId The statement ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
          "term": "@term An expression must be serializable plain MathJSON.",
        },
        "introduce-implication": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "hypothesisId": "@hypothesisId The statement ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "introduce-negation": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "hypothesisId": "@hypothesisId The statement ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "introduce-universal": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "membershipHypothesisId": "@ Runtime schema validation could not inspect the value safely.",
          "parameterDeclarationId": "@ Runtime schema validation could not inspect the value safely.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "mark-sorry": {
          "assumptionId": "@assumptionId The assumption ID is invalid.",
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "sorryId": "@sorryId The sorry ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "replace-goal": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "proposition": "@proposition An expression must be serializable plain MathJSON.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "rewrite-with-equality": {
          "direction": "@direction A rewrite direction must be forward or backward.",
          "equalityHypothesisId": "@equalityHypothesisId The statement ID is invalid.",
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "lens": "@lens A rewrite lens must contain exactly startOperand and endOperand covering at least two operands.",
          "path": "@path A rewrite path must be a dense list of operand indices.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "statement": "@statement The rewrite statement target is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "rewrite-with-equivalence": {
          "direction": "@direction A rewrite direction must be forward or backward.",
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "lens": "@lens A rewrite lens must contain exactly startOperand and endOperand covering at least two operands.",
          "path": "@path A rewrite path must be a dense list of operand indices.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "source": "@source A rewrite source must be a hypothesis ID or a result ID with an instantiation.",
          "statement": "@statement The rewrite statement target is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "rewrite-with-implication": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "lens": "@lens A rewrite lens must contain exactly startOperand and endOperand covering at least two operands.",
          "path": "@path A rewrite path must be a dense list of operand indices.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "source": "@source A rewrite source must be a hypothesis ID or a result ID with an instantiation.",
          "statement": "@statement The rewrite statement target is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "split-classical-cases": {
          "branchHypothesisIds": "@branchHypothesisIds An ID list requires at least two stable, dense IDs.",
          "childIds": "@childIds An ID list requires at least two stable, dense IDs.",
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "proposition": "@proposition An expression must be serializable plain MathJSON.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "split-goal-conjunction": {
          "childIds": "@childIds An ID list requires at least two stable, dense IDs.",
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "split-hypothesis-disjunction": {
          "branchHypothesisIds": "@branchHypothesisIds An ID list requires at least two stable, dense IDs.",
          "childIds": "@childIds An ID list requires at least two stable, dense IDs.",
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "hypothesisId": "@hypothesisId The statement ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "suffices": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "obligationId": "@obligationId The statement ID is invalid.",
          "proposition": "@proposition An expression must be serializable plain MathJSON.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
        },
        "unpack-existential-hypothesis": {
          "expectedStateId": "@expectedStateId The expected state ID is invalid.",
          "hypothesisId": "@hypothesisId The statement ID is invalid.",
          "membershipHypothesisId": "@ Runtime schema validation could not inspect the value safely.",
          "resultHypothesisId": "@resultHypothesisId The statement ID is invalid.",
          "resultStateId": "@resultStateId The result state ID is invalid.",
          "target": "@target A transition target must be a strict goal or obligation target.",
          "witnessDeclarationId": "@ Runtime schema validation could not inspect the value safely.",
        },
      }
    `);
  });

  it("pins which of two invalid fields is reported first", () => {
    const firstOfPair = Object.fromEntries(
      Object.entries(VALID_OPERATIONS).map(([kind, fields]) => {
        const valid = { kind, ...BASE_FIELDS, ...fields };
        const names = Object.keys(valid).filter((field) => field !== "kind");
        const pairs: string[] = [];
        for (const [index, first] of names.entries()) {
          for (const second of names.slice(index + 1)) {
            const reported = parsePath({
              ...valid,
              [first]: invalidValue(first),
              [second]: invalidValue(second),
            });
            pairs.push(`${first}+${second} -> ${reported}`);
          }
        }
        return [kind, pairs];
      }),
    );
    expect(firstOfPair).toMatchInlineSnapshot(`
      {
        "apply-implication-hypothesis": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+implicationHypothesisId -> @expectedStateId",
          "expectedStateId+antecedentHypothesisId -> @expectedStateId",
          "expectedStateId+resultHypothesisId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+implicationHypothesisId -> @resultStateId",
          "resultStateId+antecedentHypothesisId -> @resultStateId",
          "resultStateId+resultHypothesisId -> @resultStateId",
          "target+implicationHypothesisId -> @target",
          "target+antecedentHypothesisId -> @target",
          "target+resultHypothesisId -> @target",
          "implicationHypothesisId+antecedentHypothesisId -> @implicationHypothesisId",
          "implicationHypothesisId+resultHypothesisId -> @implicationHypothesisId",
          "antecedentHypothesisId+resultHypothesisId -> @antecedentHypothesisId",
        ],
        "apply-result-backward": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+resultId -> @expectedStateId",
          "expectedStateId+instantiation -> @expectedStateId",
          "expectedStateId+premiseTargetIds -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+resultId -> @resultStateId",
          "resultStateId+instantiation -> @resultStateId",
          "resultStateId+premiseTargetIds -> @resultStateId",
          "target+resultId -> @target",
          "target+instantiation -> @target",
          "target+premiseTargetIds -> @target",
          "resultId+instantiation -> @resultId",
          "resultId+premiseTargetIds -> @resultId",
          "instantiation+premiseTargetIds -> @instantiation",
        ],
        "apply-result-forward": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+resultId -> @expectedStateId",
          "expectedStateId+instantiation -> @expectedStateId",
          "expectedStateId+premiseHypothesisIds -> @expectedStateId",
          "expectedStateId+resultHypothesisId -> @expectedStateId",
          "expectedStateId+obligationIds -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+resultId -> @resultStateId",
          "resultStateId+instantiation -> @resultStateId",
          "resultStateId+premiseHypothesisIds -> @resultStateId",
          "resultStateId+resultHypothesisId -> @resultStateId",
          "resultStateId+obligationIds -> @resultStateId",
          "target+resultId -> @target",
          "target+instantiation -> @target",
          "target+premiseHypothesisIds -> @target",
          "target+resultHypothesisId -> @target",
          "target+obligationIds -> @target",
          "resultId+instantiation -> @resultId",
          "resultId+premiseHypothesisIds -> @resultId",
          "resultId+resultHypothesisId -> @resultHypothesisId",
          "resultId+obligationIds -> @resultId",
          "instantiation+premiseHypothesisIds -> @instantiation",
          "instantiation+resultHypothesisId -> @resultHypothesisId",
          "instantiation+obligationIds -> @instantiation",
          "premiseHypothesisIds+resultHypothesisId -> @resultHypothesisId",
          "premiseHypothesisIds+obligationIds -> @obligationIds",
          "resultHypothesisId+obligationIds -> @resultHypothesisId",
        ],
        "assume-hypothesis": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+proposition -> @expectedStateId",
          "expectedStateId+hypothesisId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+proposition -> @resultStateId",
          "resultStateId+hypothesisId -> @resultStateId",
          "target+proposition -> @target",
          "target+hypothesisId -> @target",
          "proposition+hypothesisId -> @hypothesisId",
        ],
        "choose-existential-witness": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+witness -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+witness -> @resultStateId",
          "target+witness -> @target",
        ],
        "choose-goal-disjunct": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+disjunctIndex -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+disjunctIndex -> @resultStateId",
          "target+disjunctIndex -> @target",
        ],
        "close-by-accepted-inference": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+attestationId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+attestationId -> @resultStateId",
          "target+attestationId -> @target",
        ],
        "close-by-assumption": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+assumptionId -> @expectedStateId",
          "expectedStateId+instantiation -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+assumptionId -> @resultStateId",
          "resultStateId+instantiation -> @resultStateId",
          "target+assumptionId -> @target",
          "target+instantiation -> @target",
          "assumptionId+instantiation -> @assumptionId",
        ],
        "close-by-contradiction": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+hypothesisId -> @expectedStateId",
          "expectedStateId+negationHypothesisId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+hypothesisId -> @resultStateId",
          "resultStateId+negationHypothesisId -> @resultStateId",
          "target+hypothesisId -> @target",
          "target+negationHypothesisId -> @target",
          "hypothesisId+negationHypothesisId -> @hypothesisId",
        ],
        "close-by-hypothesis": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+hypothesisId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+hypothesisId -> @resultStateId",
          "target+hypothesisId -> @target",
        ],
        "close-false-hypothesis": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+hypothesisId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+hypothesisId -> @resultStateId",
          "target+hypothesisId -> @target",
        ],
        "close-reflexive-equality": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
        ],
        "close-true": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
        ],
        "drop-hypothesis": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+hypothesisId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+hypothesisId -> @resultStateId",
          "target+hypothesisId -> @target",
        ],
        "expand-hypothesis-conjunction": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+hypothesisId -> @expectedStateId",
          "expectedStateId+expandedHypothesisIds -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+hypothesisId -> @resultStateId",
          "resultStateId+expandedHypothesisIds -> @resultStateId",
          "target+hypothesisId -> @target",
          "target+expandedHypothesisIds -> @target",
          "hypothesisId+expandedHypothesisIds -> @hypothesisId",
        ],
        "instantiate-universal-hypothesis": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+hypothesisId -> @expectedStateId",
          "expectedStateId+term -> @expectedStateId",
          "expectedStateId+resultHypothesisId -> @expectedStateId",
          "expectedStateId+membershipObligationId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+hypothesisId -> @resultStateId",
          "resultStateId+term -> @resultStateId",
          "resultStateId+resultHypothesisId -> @resultStateId",
          "resultStateId+membershipObligationId -> @resultStateId",
          "target+hypothesisId -> @target",
          "target+term -> @target",
          "target+resultHypothesisId -> @target",
          "target+membershipObligationId -> @target",
          "hypothesisId+term -> @hypothesisId",
          "hypothesisId+resultHypothesisId -> @hypothesisId",
          "hypothesisId+membershipObligationId -> @hypothesisId",
          "term+resultHypothesisId -> @resultHypothesisId",
          "term+membershipObligationId -> @term",
          "resultHypothesisId+membershipObligationId -> @resultHypothesisId",
        ],
        "introduce-implication": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+hypothesisId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+hypothesisId -> @resultStateId",
          "target+hypothesisId -> @target",
        ],
        "introduce-negation": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+hypothesisId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+hypothesisId -> @resultStateId",
          "target+hypothesisId -> @target",
        ],
        "introduce-universal": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+parameterDeclarationId -> @expectedStateId",
          "expectedStateId+membershipHypothesisId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+parameterDeclarationId -> @resultStateId",
          "resultStateId+membershipHypothesisId -> @resultStateId",
          "target+parameterDeclarationId -> @target",
          "target+membershipHypothesisId -> @target",
          "parameterDeclarationId+membershipHypothesisId -> @",
        ],
        "mark-sorry": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+assumptionId -> @expectedStateId",
          "expectedStateId+sorryId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+assumptionId -> @resultStateId",
          "resultStateId+sorryId -> @resultStateId",
          "target+assumptionId -> @target",
          "target+sorryId -> @target",
          "assumptionId+sorryId -> @assumptionId",
        ],
        "replace-goal": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+proposition -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+proposition -> @resultStateId",
          "target+proposition -> @target",
        ],
        "rewrite-with-equality": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+equalityHypothesisId -> @expectedStateId",
          "expectedStateId+statement -> @expectedStateId",
          "expectedStateId+path -> @expectedStateId",
          "expectedStateId+lens -> @expectedStateId",
          "expectedStateId+direction -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+equalityHypothesisId -> @resultStateId",
          "resultStateId+statement -> @resultStateId",
          "resultStateId+path -> @resultStateId",
          "resultStateId+lens -> @resultStateId",
          "resultStateId+direction -> @resultStateId",
          "target+equalityHypothesisId -> @target",
          "target+statement -> @target",
          "target+path -> @target",
          "target+lens -> @target",
          "target+direction -> @target",
          "equalityHypothesisId+statement -> @equalityHypothesisId",
          "equalityHypothesisId+path -> @equalityHypothesisId",
          "equalityHypothesisId+lens -> @equalityHypothesisId",
          "equalityHypothesisId+direction -> @equalityHypothesisId",
          "statement+path -> @path",
          "statement+lens -> @statement",
          "statement+direction -> @direction",
          "path+lens -> @path",
          "path+direction -> @path",
          "lens+direction -> @direction",
        ],
        "rewrite-with-equivalence": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+statement -> @expectedStateId",
          "expectedStateId+path -> @expectedStateId",
          "expectedStateId+lens -> @expectedStateId",
          "expectedStateId+source -> @expectedStateId",
          "expectedStateId+direction -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+statement -> @resultStateId",
          "resultStateId+path -> @resultStateId",
          "resultStateId+lens -> @resultStateId",
          "resultStateId+source -> @resultStateId",
          "resultStateId+direction -> @resultStateId",
          "target+statement -> @target",
          "target+path -> @target",
          "target+lens -> @target",
          "target+source -> @target",
          "target+direction -> @target",
          "statement+path -> @path",
          "statement+lens -> @statement",
          "statement+source -> @statement",
          "statement+direction -> @direction",
          "path+lens -> @path",
          "path+source -> @path",
          "path+direction -> @path",
          "lens+source -> @lens",
          "lens+direction -> @direction",
          "source+direction -> @direction",
        ],
        "rewrite-with-implication": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+statement -> @expectedStateId",
          "expectedStateId+path -> @expectedStateId",
          "expectedStateId+lens -> @expectedStateId",
          "expectedStateId+source -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+statement -> @resultStateId",
          "resultStateId+path -> @resultStateId",
          "resultStateId+lens -> @resultStateId",
          "resultStateId+source -> @resultStateId",
          "target+statement -> @target",
          "target+path -> @target",
          "target+lens -> @target",
          "target+source -> @target",
          "statement+path -> @path",
          "statement+lens -> @statement",
          "statement+source -> @statement",
          "path+lens -> @path",
          "path+source -> @path",
          "lens+source -> @lens",
        ],
        "split-classical-cases": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+proposition -> @expectedStateId",
          "expectedStateId+childIds -> @expectedStateId",
          "expectedStateId+branchHypothesisIds -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+proposition -> @resultStateId",
          "resultStateId+childIds -> @resultStateId",
          "resultStateId+branchHypothesisIds -> @resultStateId",
          "target+proposition -> @target",
          "target+childIds -> @target",
          "target+branchHypothesisIds -> @target",
          "proposition+childIds -> @childIds",
          "proposition+branchHypothesisIds -> @branchHypothesisIds",
          "childIds+branchHypothesisIds -> @childIds",
        ],
        "split-goal-conjunction": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+childIds -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+childIds -> @resultStateId",
          "target+childIds -> @target",
        ],
        "split-hypothesis-disjunction": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+hypothesisId -> @expectedStateId",
          "expectedStateId+childIds -> @expectedStateId",
          "expectedStateId+branchHypothesisIds -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+hypothesisId -> @resultStateId",
          "resultStateId+childIds -> @resultStateId",
          "resultStateId+branchHypothesisIds -> @resultStateId",
          "target+hypothesisId -> @target",
          "target+childIds -> @target",
          "target+branchHypothesisIds -> @target",
          "hypothesisId+childIds -> @hypothesisId",
          "hypothesisId+branchHypothesisIds -> @hypothesisId",
          "childIds+branchHypothesisIds -> @childIds",
        ],
        "suffices": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+proposition -> @expectedStateId",
          "expectedStateId+obligationId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+proposition -> @resultStateId",
          "resultStateId+obligationId -> @resultStateId",
          "target+proposition -> @target",
          "target+obligationId -> @target",
          "proposition+obligationId -> @obligationId",
        ],
        "unpack-existential-hypothesis": [
          "expectedStateId+resultStateId -> @expectedStateId",
          "expectedStateId+target -> @expectedStateId",
          "expectedStateId+hypothesisId -> @expectedStateId",
          "expectedStateId+resultHypothesisId -> @expectedStateId",
          "expectedStateId+witnessDeclarationId -> @expectedStateId",
          "expectedStateId+membershipHypothesisId -> @expectedStateId",
          "resultStateId+target -> @resultStateId",
          "resultStateId+hypothesisId -> @resultStateId",
          "resultStateId+resultHypothesisId -> @resultStateId",
          "resultStateId+witnessDeclarationId -> @resultStateId",
          "resultStateId+membershipHypothesisId -> @resultStateId",
          "target+hypothesisId -> @target",
          "target+resultHypothesisId -> @target",
          "target+witnessDeclarationId -> @target",
          "target+membershipHypothesisId -> @target",
          "hypothesisId+resultHypothesisId -> @hypothesisId",
          "hypothesisId+witnessDeclarationId -> @hypothesisId",
          "hypothesisId+membershipHypothesisId -> @hypothesisId",
          "resultHypothesisId+witnessDeclarationId -> @resultHypothesisId",
          "resultHypothesisId+membershipHypothesisId -> @resultHypothesisId",
          "witnessDeclarationId+membershipHypothesisId -> @",
        ],
      }
    `);
  });

  it("pins the envelope diagnostics", () => {
    const valid = { kind: "close-by-hypothesis", ...BASE_FIELDS, hypothesisId: "h:a" };
    const sorry = { kind: "mark-sorry", ...BASE_FIELDS, assumptionId: "assumption:a" };
    const rewrite = {
      kind: "rewrite-with-implication",
      ...BASE_FIELDS,
      statement: { kind: "conclusion" },
      path: [],
      source: { kind: "hypothesis", hypothesisId: "h:e" },
    };
    const classical = {
      kind: "split-classical-cases",
      ...BASE_FIELDS,
      proposition: "p",
      childIds: ["c:1", "c:2"],
      branchHypothesisIds: ["b:1", "b:2"],
    };
    const { hypothesisId: _unused, ...withoutHypothesis } = valid;
    void _unused;
    expect({
      notAnObject: parseIssue(7 as unknown as Fields),
      array: parseIssue([] as unknown as Fields),
      nullValue: parseIssue(null as unknown as Fields),
      noKind: parseIssue(BASE_FIELDS),
      numericKind: parseIssue({ ...valid, kind: 7 }),
      unknownKind: parseIssue({ ...valid, kind: "close-everything" }),
      inheritedKind: parseIssue({ ...valid, kind: "toString" }),
      missingField: parseIssue(withoutHypothesis),
      unknownField: parseIssue({ ...valid, extra: 1 }),
      lensOnNonRewrite: parseIssue({ ...valid, lens: { startOperand: 0, endOperand: 2 } }),
      sorryIdOnNonSorry: parseIssue({ ...valid, sorryId: "sorry:a" }),
      sorryIdOptional: parseIssue(sorry),
      lensOptional: parseIssue(rewrite),
      lensInvalid: parseIssue({ ...rewrite, lens: { startOperand: 0, endOperand: 1 } }),
      sorryIdInvalid: parseIssue({ ...sorry, sorryId: "" }),
      classicalThreeChildren: parseIssue({ ...classical, childIds: ["c:1", "c:2", "c:3"] }),
      classicalThreeBranches: parseIssue({
        ...classical,
        branchHypothesisIds: ["b:1", "b:2", "b:3"],
      }),
      shortIdList: parseIssue({ ...classical, childIds: ["c:1"] }),
      sparseIdList: parseIssue({ ...classical, childIds: withHole(["c:1", "c:2"], 0) }),
      fractionalDisjunct: parseIssue({
        kind: "choose-goal-disjunct",
        ...BASE_FIELDS,
        disjunctIndex: 0.5,
      }),
      sparsePath: parseIssue({ ...rewrite, path: withHole([0, 1], 0) }),
      negativePath: parseIssue({ ...rewrite, path: [-1] }),
      invalidStatement: parseIssue({ ...rewrite, statement: { kind: "hypothesis" } }),
      invalidSource: parseIssue({ ...rewrite, source: { kind: "hypothesis" } }),
      invalidExpectedState: parseIssue({ ...valid, expectedStateId: "" }),
      invalidTarget: parseIssue({ ...valid, target: { kind: "state", id: "goal:0" } }),
    }).toMatchInlineSnapshot(`
      {
        "array": "@ A kernel operation must be a strict discriminated object.",
        "classicalThreeBranches": "@ A classical case split requires exactly two IDs in each list.",
        "classicalThreeChildren": "@ A classical case split requires exactly two IDs in each list.",
        "fractionalDisjunct": "@disjunctIndex A disjunct index must be a nonnegative integer.",
        "inheritedKind": "@kind The kernel operation kind is unknown.",
        "invalidExpectedState": "@expectedStateId The expected state ID is invalid.",
        "invalidSource": "@source A rewrite source must be a hypothesis ID or a result ID with an instantiation.",
        "invalidStatement": "@statement The rewrite statement target is invalid.",
        "invalidTarget": "@target A transition target kind must be goal or obligation.",
        "lensInvalid": "@lens A rewrite lens must contain exactly startOperand and endOperand covering at least two operands.",
        "lensOnNonRewrite": "@ The kernel operation contains missing or unknown fields.",
        "lensOptional": "valid",
        "missingField": "@ The kernel operation contains missing or unknown fields.",
        "negativePath": "@path A rewrite path must be a dense list of operand indices.",
        "noKind": "@ A kernel operation must be a strict discriminated object.",
        "notAnObject": "@ A kernel operation must be a strict discriminated object.",
        "nullValue": "@ A kernel operation must be a strict discriminated object.",
        "numericKind": "@ A kernel operation must be a strict discriminated object.",
        "shortIdList": "@childIds An ID list requires at least two stable, dense IDs.",
        "sorryIdInvalid": "@sorryId The sorry ID is invalid.",
        "sorryIdOnNonSorry": "@ The kernel operation contains missing or unknown fields.",
        "sorryIdOptional": "valid",
        "sparseIdList": "@childIds An ID list requires at least two stable, dense IDs.",
        "sparsePath": "@path A rewrite path must be a dense list of operand indices.",
        "unknownField": "@ The kernel operation contains missing or unknown fields.",
        "unknownKind": "@kind The kernel operation kind is unknown.",
      }
    `);
  });

  it("pins the generic diagnostic of an invalid optional binder ID", () => {
    const typed = [
      ["introduce-universal", "parameterDeclarationId"],
      ["introduce-universal", "membershipHypothesisId"],
      ["instantiate-universal-hypothesis", "membershipObligationId"],
      ["unpack-existential-hypothesis", "witnessDeclarationId"],
      ["unpack-existential-hypothesis", "membershipHypothesisId"],
    ] as const;
    expect(
      Object.fromEntries(
        typed.map(([kind, field]) => [
          `${kind} ${field}`,
          parseIssue({ kind, ...BASE_FIELDS, ...VALID_OPERATIONS[kind], [field]: 7 }),
        ]),
      ),
    ).toMatchInlineSnapshot(`
      {
        "instantiate-universal-hypothesis membershipObligationId": "@ Runtime schema validation could not inspect the value safely.",
        "introduce-universal membershipHypothesisId": "@ Runtime schema validation could not inspect the value safely.",
        "introduce-universal parameterDeclarationId": "@ Runtime schema validation could not inspect the value safely.",
        "unpack-existential-hypothesis membershipHypothesisId": "@ Runtime schema validation could not inspect the value safely.",
        "unpack-existential-hypothesis witnessDeclarationId": "@ Runtime schema validation could not inspect the value safely.",
      }
    `);
  });
});
