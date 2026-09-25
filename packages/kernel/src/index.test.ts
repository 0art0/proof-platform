import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
  operatorDeclarationsSchema,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { applyTransition, kernelOperationSchema } from "./index";

const declarations = ["p", "q", "r"].map((symbol, index) => ({
  id: `declaration:${index}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
}));

function sequent(
  conclusion: PlainMathJson,
  hypotheses: readonly Readonly<{ id: string; expression: PlainMathJson }>[] = [],
  localDeclarations: readonly unknown[] = declarations,
) {
  return {
    context: {
      declarations: localDeclarations,
      hypotheses: hypotheses.map(({ id, expression }) => ({ id, statement: { expression } })),
    },
    conclusion: { expression: conclusion },
  };
}

function state(
  goalExpressions: readonly PlainMathJson[],
  obligationExpressions: readonly PlainMathJson[] = [],
): ExecutableProofState {
  return executableProofStateSchema.parse({
    id: "state:before",
    goals: goalExpressions.map((expression, index) => ({
      id: `goal:${index}`,
      sequent: sequent(expression),
    })),
    obligations: obligationExpressions.map((expression, index) => ({
      id: `obligation:${index}`,
      sequent: sequent(expression),
    })),
  });
}

const target = { kind: "goal" as const, id: "goal:0" };
const base = {
  expectedStateId: "state:before",
  resultStateId: "state:after",
  target,
};

describe("propositional kernel transitions", () => {
  it("closes a target only with a matching hypothesis in its local context", () => {
    const input = executableProofStateSchema.parse({
      ...state(["p"], ["q"]),
      goals: [{ id: "goal:0", sequent: sequent("p", [{ id: "hypothesis:p", expression: "p" }]) }],
    });
    const result = applyTransition(input, {
      ...base,
      kind: "close-by-hypothesis",
      hypothesisId: "hypothesis:p",
    });

    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: { id: "state:after", goals: [], obligations: [{ id: "obligation:0" }] },
    });
    expect(input.goals).toHaveLength(1);

    const otherContext = executableProofStateSchema.parse({
      id: "state:before",
      goals: [
        { id: "goal:0", sequent: sequent("p") },
        {
          id: "goal:1",
          sequent: sequent("q", [{ id: "hypothesis:p", expression: "p" }]),
        },
      ],
      obligations: [],
    });
    const rejected = applyTransition(otherContext, {
      ...base,
      kind: "close-by-hypothesis",
      hypothesisId: "hypothesis:p",
    });
    expect(rejected).toMatchObject({
      ok: false,
      diagnostics: [{ code: "hypothesis-not-found" }],
    });
    expect(rejected.state).toBe(otherContext);
  });

  it("closes truth and closes from an explicit false hypothesis", () => {
    for (const truth of ["True", { sym: "True", comment: "retain source form" }] as const) {
      const result = applyTransition(state([truth]), { ...base, kind: "close-true" });
      expect(result).toMatchObject({
        ok: true,
        transitionClass: "equivalence",
        state: { goals: [] },
      });
    }

    const input = executableProofStateSchema.parse({
      ...state(["p"]),
      goals: [
        {
          id: "goal:0",
          sequent: sequent("p", [
            { id: "hypothesis:false", expression: { sym: "False", comment: "given" } },
          ]),
        },
      ],
    });
    expect(
      applyTransition(input, {
        ...base,
        kind: "close-false-hypothesis",
        hypothesisId: "hypothesis:false",
      }),
    ).toMatchObject({ ok: true, transitionClass: "equivalence", state: { goals: [] } });
  });

  it("introduces a binary implication while preserving wrapper operand metadata", () => {
    const antecedent = { sym: "p", comment: "antecedent source" } as const;
    const input = state([{ fn: ["Implies", antecedent, "q"], comment: "outer wrapper" }]);
    const result = applyTransition(input, {
      ...base,
      kind: "introduce-implication",
      hypothesisId: "hypothesis:introduced",
    });

    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [
          {
            id: "goal:0",
            sequent: {
              context: {
                hypotheses: [
                  { id: "hypothesis:introduced", statement: { expression: antecedent } },
                ],
              },
              conclusion: { expression: "q" },
            },
          },
        ],
      },
    });
  });

  it("introduces negation as a local contradiction goal", () => {
    const result = applyTransition(state([["Not", "p"]]), {
      ...base,
      kind: "introduce-negation",
      hypothesisId: "hypothesis:negated",
    });

    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [
          {
            id: "goal:0",
            sequent: {
              context: {
                hypotheses: [{ id: "hypothesis:negated", statement: { expression: "p" } }],
              },
              conclusion: { expression: "False" },
            },
          },
        ],
      },
    });
  });

  it("splits variadic goal conjunctions into independent contextual sequents", () => {
    const input = executableProofStateSchema.parse({
      id: "state:before",
      goals: [
        {
          id: "goal:0",
          sequent: sequent(
            ["And", "p", "q", { sym: "r", comment: "third" }],
            [{ id: "hypothesis:shared", expression: "p" }],
          ),
        },
        { id: "goal:sibling", sequent: sequent("q") },
      ],
      obligations: [{ id: "obligation:0", sequent: sequent("r") }],
    });
    const result = applyTransition(input, {
      ...base,
      kind: "split-goal-conjunction",
      childIds: ["goal:p", "goal:q", "goal:r"],
    });
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [
          { id: "goal:p", sequent: { conclusion: { expression: "p" } } },
          { id: "goal:q", sequent: { conclusion: { expression: "q" } } },
          {
            id: "goal:r",
            sequent: { conclusion: { expression: { sym: "r", comment: "third" } } },
          },
          { id: "goal:sibling" },
        ],
        obligations: [{ id: "obligation:0" }],
      },
    });
    if (!result.ok) throw new Error("Expected a successful split.");
    expect(result.state.goals[0]?.sequent.context).not.toBe(result.state.goals[1]?.sequent.context);
  });

  it("chooses one goal disjunct as an explicitly strengthening transition", () => {
    const input = state([["Or", "p", "q", "r"]]);
    const result = applyTransition(input, {
      ...base,
      kind: "choose-goal-disjunct",
      disjunctIndex: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      state: {
        goals: [{ id: "goal:0", sequent: { conclusion: { expression: "q" } } }],
      },
    });
  });

  it("expands a variadic conjunction hypothesis in place", () => {
    const input = executableProofStateSchema.parse({
      ...state(["r"]),
      goals: [
        {
          id: "goal:0",
          sequent: sequent("r", [
            { id: "hypothesis:before", expression: "p" },
            { id: "hypothesis:and", expression: { fn: ["And", "p", "q", "r"] } },
            { id: "hypothesis:after", expression: "q" },
          ]),
        },
      ],
    });
    const result = applyTransition(input, {
      ...base,
      kind: "expand-hypothesis-conjunction",
      hypothesisId: "hypothesis:and",
      expandedHypothesisIds: ["hypothesis:p", "hypothesis:q", "hypothesis:r"],
    });
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [
          {
            id: "goal:0",
            sequent: {
              context: {
                hypotheses: [
                  { id: "hypothesis:before" },
                  { id: "hypothesis:p", statement: { expression: "p" } },
                  { id: "hypothesis:q", statement: { expression: "q" } },
                  { id: "hypothesis:r", statement: { expression: "r" } },
                  { id: "hypothesis:after" },
                ],
              },
            },
          },
        ],
      },
    });
  });

  it("splits a disjunction hypothesis into all independent cases", () => {
    const input = executableProofStateSchema.parse({
      id: "state:before",
      goals: [
        {
          id: "goal:0",
          sequent: sequent("r", [{ id: "hypothesis:or", expression: ["Or", "p", "q", "r"] }]),
        },
      ],
      obligations: [{ id: "obligation:0", sequent: sequent("p") }],
    });
    const result = applyTransition(input, {
      ...base,
      kind: "split-hypothesis-disjunction",
      hypothesisId: "hypothesis:or",
      childIds: ["case:p", "case:q", "case:r"],
      branchHypothesisIds: ["case-hypothesis:p", "case-hypothesis:q", "case-hypothesis:r"],
    });
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [
          {
            id: "case:p",
            sequent: { context: { hypotheses: [{ statement: { expression: "p" } }] } },
          },
          {
            id: "case:q",
            sequent: { context: { hypotheses: [{ statement: { expression: "q" } }] } },
          },
          {
            id: "case:r",
            sequent: { context: { hypotheses: [{ statement: { expression: "r" } }] } },
          },
        ],
        obligations: [{ id: "obligation:0" }],
      },
    });
    if (!result.ok) throw new Error("Expected successful case splitting.");
    expect(result.state.goals[0]?.sequent.context).not.toBe(result.state.goals[1]?.sequent.context);
  });

  it("adds an implication consequent only when its exact antecedent is available locally", () => {
    const input = executableProofStateSchema.parse({
      ...state(["r"]),
      goals: [
        {
          id: "goal:0",
          sequent: sequent("r", [
            { id: "hypothesis:implication", expression: ["Implies", "p", "q"] },
            { id: "hypothesis:antecedent", expression: "p" },
          ]),
        },
      ],
    });
    const operation = {
      ...base,
      kind: "apply-implication-hypothesis",
      implicationHypothesisId: "hypothesis:implication",
      antecedentHypothesisId: "hypothesis:antecedent",
      resultHypothesisId: "hypothesis:consequent",
    };

    expect(applyTransition(input, operation)).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [
          {
            sequent: {
              context: {
                hypotheses: [
                  {},
                  {},
                  { id: "hypothesis:consequent", statement: { expression: "q" } },
                ],
              },
            },
          },
        ],
      },
    });

    const wrongAntecedent = executableProofStateSchema.parse({
      ...input,
      goals: [
        {
          id: "goal:0",
          sequent: sequent("r", [
            { id: "hypothesis:implication", expression: ["Implies", "p", "q"] },
            { id: "hypothesis:antecedent", expression: "q" },
          ]),
        },
      ],
    });
    expect(applyTransition(wrongAntecedent, operation)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "rule-not-applicable" }],
    });
  });

  it("applies the same rules to obligations without moving them into goals", () => {
    const input = state(["p"], [["Or", "q", "r"]]);
    const result = applyTransition(input, {
      ...base,
      target: { kind: "obligation", id: "obligation:0" },
      kind: "choose-goal-disjunct",
      disjunctIndex: 0,
    });
    expect(result).toMatchObject({
      ok: true,
      state: {
        goals: [{ id: "goal:0" }],
        obligations: [{ id: "obligation:0", sequent: { conclusion: { expression: "q" } } }],
      },
    });
  });

  it("does not consider a state solved while an obligation remains", () => {
    const result = applyTransition(state(["True"], ["p"]), {
      ...base,
      kind: "close-true",
    });
    expect(result).toMatchObject({
      ok: true,
      state: { goals: [], obligations: [{ id: "obligation:0" }] },
    });
  });
});

describe("quantifier and equality kernel transitions", () => {
  it("closes exact binary reflexive equalities in either target collection", () => {
    const operand: PlainMathJson = {
      fn: ["Not", "p"],
      comment: "preserve exact source form",
    };
    const equality: PlainMathJson = {
      fn: ["Equal", operand, structuredClone(operand)],
      comment: "outer",
    };
    const input = state([equality, "q"], [equality, "r"]);

    const closedGoal = applyTransition(input, {
      ...base,
      kind: "close-reflexive-equality",
    });
    expect(closedGoal).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [{ id: "goal:1" }],
        obligations: [{ id: "obligation:0" }, { id: "obligation:1" }],
      },
    });
    expect(input.goals).toHaveLength(2);

    const closedObligation = applyTransition(input, {
      ...base,
      target: { kind: "obligation", id: "obligation:0" },
      kind: "close-reflexive-equality",
    });
    expect(closedObligation).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [{ id: "goal:0" }, { id: "goal:1" }],
        obligations: [{ id: "obligation:1" }],
      },
    });
  });

  it("does not close non-reflexive or merely symbol-equivalent equalities", () => {
    for (const equality of [
      ["Equal", "p", "q"],
      ["Equal", "p", { sym: "p" }],
      ["Equal", { sym: "p", comment: "left" }, { sym: "p", comment: "right" }],
      ["Equal", "p", "p", "p"],
    ] as const) {
      const input = state([equality]);
      const result = applyTransition(input, { ...base, kind: "close-reflexive-equality" });
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [{ code: "rule-not-applicable" }],
      });
      expect(result.state).toBe(input);
    }
  });

  it("introduces a universal goal only for a parameter independent of local assumptions", () => {
    const input = state([["ForAll", "p", ["Implies", "p", "p"]]]);
    expect(applyTransition(input, { ...base, kind: "introduce-universal" })).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [{ sequent: { conclusion: { expression: ["Implies", "p", "p"] } } }],
      },
    });

    const dependent = executableProofStateSchema.parse({
      ...input,
      goals: [
        {
          id: "goal:0",
          sequent: sequent(
            ["ForAll", "p", ["Implies", "p", "p"]],
            [{ id: "hypothesis:p", expression: "p" }],
          ),
        },
      ],
    });
    expect(applyTransition(dependent, { ...base, kind: "introduce-universal" })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "rule-not-applicable" }],
    });
  });

  it("instantiates a universal hypothesis through capture-safe substitution", () => {
    const input = executableProofStateSchema.parse({
      ...state(["r"]),
      goals: [
        {
          id: "goal:0",
          sequent: sequent("r", [
            {
              id: "hypothesis:universal",
              expression: ["ForAll", "p", ["Or", "p", "r"]],
            },
          ]),
        },
      ],
    });
    const result = applyTransition(input, {
      ...base,
      kind: "instantiate-universal-hypothesis",
      hypothesisId: "hypothesis:universal",
      term: { sym: "q", comment: "chosen instance" },
      resultHypothesisId: "hypothesis:instance",
    });

    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [
          {
            sequent: {
              context: {
                hypotheses: [
                  {},
                  {
                    id: "hypothesis:instance",
                    statement: {
                      expression: ["Or", { sym: "q", comment: "chosen instance" }, "r"],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    });
  });

  it("chooses an existential witness as strengthening and unpacks a fresh witness equivalently", () => {
    const chosen = applyTransition(state([["Exists", "p", ["And", "p", "q"]]]), {
      ...base,
      kind: "choose-existential-witness",
      witness: "q",
    });
    expect(chosen).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      state: { goals: [{ sequent: { conclusion: { expression: ["And", "q", "q"] } } }] },
    });

    const witnessDeclarations = declarations.map((declaration) =>
      declaration.symbol === "p" ? { ...declaration, role: "local-witness" as const } : declaration,
    );
    const input = executableProofStateSchema.parse({
      ...state(["q"]),
      goals: [
        {
          id: "goal:0",
          sequent: sequent(
            "q",
            [
              {
                id: "hypothesis:existential",
                expression: ["Exists", "p", ["And", "p", "q"]],
              },
            ],
            witnessDeclarations,
          ),
        },
      ],
    });
    const operation = {
      ...base,
      kind: "unpack-existential-hypothesis",
      hypothesisId: "hypothesis:existential",
      resultHypothesisId: "hypothesis:witness",
    };
    expect(applyTransition(input, operation)).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [
          {
            sequent: {
              context: {
                hypotheses: [
                  {
                    id: "hypothesis:witness",
                    statement: { expression: ["And", "p", "q"] },
                  },
                ],
              },
            },
          },
        ],
      },
    });

    const nonFresh = executableProofStateSchema.parse({
      ...input,
      goals: [
        {
          id: "goal:0",
          sequent: sequent(
            "p",
            [
              {
                id: "hypothesis:existential",
                expression: ["Exists", "p", ["And", "p", "q"]],
              },
            ],
            witnessDeclarations,
          ),
        },
      ],
    });
    expect(applyTransition(nonFresh, operation)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "rule-not-applicable" }],
    });
  });

  it("rewrites exactly one occurrence with a local equality and preserves wrappers", () => {
    const input = executableProofStateSchema.parse({
      ...state([["Implies", "p", "r"]]),
      goals: [
        {
          id: "goal:0",
          sequent: sequent({ fn: ["Implies", "p", "r"], comment: "outer" }, [
            { id: "hypothesis:equality", expression: ["Equal", "p", "q"] },
          ]),
        },
      ],
    });
    const operation = {
      ...base,
      kind: "rewrite-with-equality",
      equalityHypothesisId: "hypothesis:equality",
      statement: { kind: "conclusion" },
      path: [0],
      direction: "forward",
    };
    expect(applyTransition(input, operation)).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [
          {
            sequent: {
              conclusion: { expression: { fn: ["Implies", "q", "r"], comment: "outer" } },
            },
          },
        ],
      },
    });
  });

  it("rejects equality rewrites that target binders, miss the source, or capture symbols", () => {
    const input = executableProofStateSchema.parse({
      ...state([["ForAll", "p", ["Implies", "q", "p"]]]),
      goals: [
        {
          id: "goal:0",
          sequent: sequent(
            ["ForAll", "p", ["Implies", "q", "p"]],
            [{ id: "hypothesis:equality", expression: ["Equal", "q", "p"] }],
          ),
        },
      ],
    });
    const rewrite = (path: readonly number[]) => ({
      ...base,
      kind: "rewrite-with-equality",
      equalityHypothesisId: "hypothesis:equality",
      statement: { kind: "conclusion" },
      path,
      direction: "forward",
    });

    expect(applyTransition(input, rewrite([1, 0]))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "rule-not-applicable" }],
    });
    expect(applyTransition(input, rewrite([0]))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-path" }],
    });
    expect(applyTransition(input, rewrite([1, 1]))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "rule-not-applicable" }],
    });
  });
});

describe("classical case splits and assumed hypotheses", () => {
  it("splits a goal into independent P and not-P branches while preserving local context", () => {
    const proposition = { fn: ["Or", "p", "q"], comment: "case proposition" };
    const conclusion = { sym: "r", comment: "unchanged conclusion" } as const;
    const existing = { sym: "p", comment: "existing hypothesis" } as const;
    const input = deepFreeze(
      executableProofStateSchema.parse({
        id: "state:before",
        goals: [
          {
            id: "goal:0",
            sequent: sequent(conclusion, [{ id: "hypothesis:existing", expression: existing }]),
          },
          { id: "goal:sibling", sequent: sequent("q") },
        ],
        obligations: [{ id: "obligation:bystander", sequent: sequent("p") }],
      }),
    );
    const result = applyTransition(input, {
      ...base,
      kind: "split-classical-cases",
      proposition,
      childIds: ["case:positive", "case:negative"],
      branchHypothesisIds: ["hypothesis:positive", "hypothesis:negative"],
    });

    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [
          {
            id: "case:positive",
            sequent: {
              context: {
                declarations,
                hypotheses: [
                  { id: "hypothesis:existing", statement: { expression: existing } },
                  { id: "hypothesis:positive", statement: { expression: proposition } },
                ],
              },
              conclusion: { expression: conclusion },
            },
          },
          {
            id: "case:negative",
            sequent: {
              context: {
                declarations,
                hypotheses: [
                  { id: "hypothesis:existing", statement: { expression: existing } },
                  {
                    id: "hypothesis:negative",
                    statement: { expression: ["Not", proposition] },
                  },
                ],
              },
              conclusion: { expression: conclusion },
            },
          },
          { id: "goal:sibling" },
        ],
        obligations: [{ id: "obligation:bystander" }],
      },
    });
    if (!result.ok) throw new Error("Expected a successful classical case split.");
    const positive = result.state.goals[0];
    const negative = result.state.goals[1];
    if (positive === undefined || negative === undefined) throw new Error("Expected two branches.");
    expect(positive.sequent.context).not.toBe(negative.sequent.context);
    expect(positive.sequent.context.declarations).not.toBe(negative.sequent.context.declarations);
    expect(positive.sequent.context.hypotheses).not.toBe(negative.sequent.context.hypotheses);
    expect(positive.sequent.conclusion.expression).not.toBe(negative.sequent.conclusion.expression);
    const positiveExpression = positive.sequent.context.hypotheses[1]?.statement.expression;
    const negativeExpression = negative.sequent.context.hypotheses[1]?.statement.expression;
    if (!Array.isArray(negativeExpression)) throw new Error("Expected the negative case.");
    expect(positiveExpression).not.toBe(proposition);
    expect(negativeExpression[1]).not.toBe(positiveExpression);
    expect(result.state.goals[2]).toEqual(input.goals[1]);
    expect(result.state.obligations[0]).toEqual(input.obligations[0]);
    proposition.comment = "mutated after transition";
    expect(positive.sequent.context.hypotheses[1]?.statement.expression).toMatchObject({
      comment: "case proposition",
    });
  });

  it("splits an obligation in place without moving its branches into goals", () => {
    const input = state(["p"], ["r", "q"]);
    const result = applyTransition(input, {
      ...base,
      target: { kind: "obligation", id: "obligation:0" },
      kind: "split-classical-cases",
      proposition: "q",
      childIds: ["obligation:q", "obligation:not-q"],
      branchHypothesisIds: ["hypothesis:q", "hypothesis:not-q"],
    });

    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [{ id: "goal:0" }],
        obligations: [
          {
            id: "obligation:q",
            sequent: {
              context: {
                hypotheses: [{ id: "hypothesis:q", statement: { expression: "q" } }],
              },
              conclusion: { expression: "r" },
            },
          },
          {
            id: "obligation:not-q",
            sequent: {
              context: {
                hypotheses: [{ id: "hypothesis:not-q", statement: { expression: ["Not", "q"] } }],
              },
              conclusion: { expression: "r" },
            },
          },
          { id: "obligation:1" },
        ],
      },
    });
  });

  it("assumes a detached target-local hypothesis as weakening in either collection", () => {
    const proposition = { fn: ["Implies", "p", "q"], comment: "assumed" };
    const input = deepFreeze(
      executableProofStateSchema.parse({
        id: "state:before",
        goals: [
          {
            id: "goal:0",
            sequent: sequent("r", [{ id: "hypothesis:existing", expression: "p" }]),
          },
          { id: "goal:sibling", sequent: sequent("q") },
        ],
        obligations: [{ id: "obligation:0", sequent: sequent("p") }],
      }),
    );
    const addedToGoal = applyTransition(input, {
      ...base,
      kind: "assume-hypothesis",
      proposition,
      hypothesisId: "hypothesis:assumed",
    });

    expect(addedToGoal).toMatchObject({
      ok: true,
      transitionClass: "weakening",
      state: {
        goals: [
          {
            id: "goal:0",
            sequent: {
              context: {
                hypotheses: [
                  { id: "hypothesis:existing", statement: { expression: "p" } },
                  { id: "hypothesis:assumed", statement: { expression: proposition } },
                ],
              },
              conclusion: { expression: "r" },
            },
          },
          { id: "goal:sibling" },
        ],
        obligations: [{ id: "obligation:0" }],
      },
    });
    if (!addedToGoal.ok) throw new Error("Expected a successful assumed hypothesis.");
    expect(addedToGoal.state).not.toBe(input);
    expect(addedToGoal.state.goals[1]).toEqual(input.goals[1]);
    expect(addedToGoal.state.obligations[0]).toEqual(input.obligations[0]);
    proposition.comment = "mutated after transition";
    expect(
      addedToGoal.state.goals[0]?.sequent.context.hypotheses[1]?.statement.expression,
    ).toMatchObject({ comment: "assumed" });

    const addedToObligation = applyTransition(input, {
      ...base,
      target: { kind: "obligation", id: "obligation:0" },
      kind: "assume-hypothesis",
      proposition: "q",
      hypothesisId: "hypothesis:obligation-assumed",
    });
    expect(addedToObligation).toMatchObject({
      ok: true,
      transitionClass: "weakening",
      state: {
        goals: [{ id: "goal:0" }, { id: "goal:sibling" }],
        obligations: [
          {
            id: "obligation:0",
            sequent: {
              context: {
                hypotheses: [
                  {
                    id: "hypothesis:obligation-assumed",
                    statement: { expression: "q" },
                  },
                ],
              },
              conclusion: { expression: "p" },
            },
          },
        ],
      },
    });
  });

  it("rejects malformed, out-of-scope, and wrongly sorted propositions atomically", () => {
    const withTerm = [
      ...declarations,
      {
        id: "declaration:n",
        symbol: "n",
        sort: { kind: "named", id: "sort:natural" },
        role: "universal-parameter",
      },
    ];
    const input = executableProofStateSchema.parse({
      id: "state:before",
      goals: [{ id: "goal:0", sequent: sequent("r", [], withTerm) }],
      obligations: [],
    });
    const invalidPropositions: readonly [unknown, string][] = [
      [{ fn: [] }, "invalid-operation"],
      [["Add", 1, 2], "invalid-proposition"],
      ["n", "invalid-proposition"],
      ["undeclared", "invalid-proposition"],
      [["And", "p", "undeclared"], "invalid-proposition"],
    ];

    for (const [proposition, code] of invalidPropositions) {
      for (const operation of propositionOperations(proposition)) {
        const before = JSON.stringify(input);
        const result = applyTransition(input, operation);
        expect(result).toMatchObject({ ok: false, diagnostics: [{ code }] });
        expect(result.state).toBe(input);
        expect(JSON.stringify(input)).toBe(before);
      }
    }
    for (const operation of propositionOperations(["Equal", "n", "n"])) {
      expect(applyTransition(input, operation)).toMatchObject({ ok: true });
    }
  });

  it("validates supplied propositions against the configured operator environment", () => {
    const [customOperator] = operatorDeclarationsSchema.parse([
      {
        id: "operator:is-accepted",
        symbol: "IsAccepted",
        signature: { parameters: [PROPOSITION_SORT], result: PROPOSITION_SORT },
      },
    ]);
    if (customOperator === undefined) throw new Error("Expected a custom operator.");
    const input = state(["r"]);

    for (const operation of propositionOperations(["IsAccepted", "p"])) {
      expect(applyTransition(input, operation, { operators: [customOperator] })).toMatchObject({
        ok: true,
      });
      const rejected = applyTransition(input, operation);
      expect(rejected).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-proposition" }],
      });
      expect(rejected.state).toBe(input);
    }
  });

  it("closes both classical cases from one shared hypothesis set, leaving only bystanders", () => {
    const expression = fc.letrec<{ proposition: PlainMathJson }>((tie) => ({
      proposition: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.constantFrom<PlainMathJson>("p", "q", "r", "True", "False"),
        fc.tuple(fc.constant("Not"), tie("proposition")),
        fc.tuple(fc.constantFrom("And", "Or", "Implies"), tie("proposition"), tie("proposition")),
      ),
    })).proposition;

    fc.assert(
      fc.property(
        fc.array(expression, { minLength: 1, maxLength: 4 }),
        fc.array(expression, { maxLength: 3 }),
        fc.nat(),
        expression,
        fc.array(expression, { maxLength: 3 }),
        (goalExpressions, obligationExpressions, rawIndex, proposition, extraHypotheses) => {
          const targetIndex = rawIndex % goalExpressions.length;
          const conclusion = goalExpressions[targetIndex] as PlainMathJson;
          const hypotheses = [
            ...extraHypotheses.map((hypothesisExpression, index) => ({
              id: `hypothesis:extra:${index}`,
              expression: hypothesisExpression,
            })),
            { id: "hypothesis:fact", expression: conclusion },
          ];
          const input = executableProofStateSchema.parse({
            id: "state:before",
            goals: goalExpressions.map((goalExpression, index) => ({
              id: `goal:${index}`,
              sequent:
                index === targetIndex
                  ? sequent(goalExpression, hypotheses)
                  : sequent(goalExpression),
            })),
            obligations: obligationExpressions.map((obligationExpression, index) => ({
              id: `obligation:${index}`,
              sequent: sequent(obligationExpression),
            })),
          });
          const split = applyTransition(input, {
            ...base,
            target: { kind: "goal", id: `goal:${targetIndex}` },
            kind: "split-classical-cases",
            proposition,
            childIds: ["case:positive", "case:negative"],
            branchHypothesisIds: ["hypothesis:positive", "hypothesis:negative"],
          });
          if (!split.ok) throw new Error("Expected a classical case split.");
          expect(split.transitionClass).toBe("equivalence");

          let current = split.state;
          for (const [index, caseId] of ["case:positive", "case:negative"].entries()) {
            const closed = applyTransition(current, {
              expectedStateId: current.id,
              resultStateId: `state:closed:${index}`,
              target: { kind: "goal", id: caseId },
              kind: "close-by-hypothesis",
              hypothesisId: "hypothesis:fact",
            });
            if (!closed.ok) throw new Error("Expected each case to close from the shared fact.");
            expect(closed.transitionClass).toBe("equivalence");
            current = closed.state;
          }

          expect(current.goals).toEqual(
            input.goals.filter((_goal, index) => index !== targetIndex),
          );
          expect(current.obligations).toEqual(input.obligations);
        },
      ),
    );
  });
});

describe("contradiction, accepted inference, and alpha-equivalent closing", () => {
  const universal = (bound: string, free: string): PlainMathJson => [
    "ForAll",
    bound,
    ["Implies", bound, free],
  ];

  function withHypotheses(
    hypotheses: readonly Readonly<{ id: string; expression: PlainMathJson }>[],
    conclusion: PlainMathJson = "q",
  ): ExecutableProofState {
    return executableProofStateSchema.parse({
      id: "state:before",
      goals: [
        { id: "goal:0", sequent: sequent(conclusion, hypotheses) },
        { id: "goal:sibling", sequent: sequent("r") },
      ],
      obligations: [{ id: "obligation:0", sequent: sequent(conclusion, hypotheses) }],
    });
  }

  it("closes a target by an alpha-equivalent hypothesis but never by capture", () => {
    const accepted = withHypotheses(
      [{ id: "hypothesis:universal", expression: universal("p", "r") }],
      universal("q", "r"),
    );
    for (const targetRef of [target, { kind: "obligation", id: "obligation:0" }] as const) {
      const result = applyTransition(accepted, {
        ...base,
        target: targetRef,
        kind: "close-by-hypothesis",
        hypothesisId: "hypothesis:universal",
      });
      expect(result).toMatchObject({
        ok: true,
        transitionClass: "equivalence",
        evidence: "structural",
      });
    }

    for (const [hypothesisExpression, conclusion] of [
      [universal("p", "q"), universal("q", "q")],
      [universal("p", "q"), universal("p", "r")],
      [universal("p", "r"), ["ForAll", { sym: "q" }, ["Implies", { sym: "q" }, "r"]]],
    ] as const) {
      const input = withHypotheses(
        [{ id: "hypothesis:universal", expression: hypothesisExpression }],
        conclusion,
      );
      const result = applyTransition(input, {
        ...base,
        kind: "close-by-hypothesis",
        hypothesisId: "hypothesis:universal",
      });
      expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "rule-not-applicable" }] });
      expect(result.state).toBe(input);
    }
  });

  it("closes a target from P and an alpha-equivalent not-P in either collection", () => {
    const input = withHypotheses([
      { id: "hypothesis:positive", expression: universal("p", "r") },
      { id: "hypothesis:negative", expression: ["Not", universal("q", "r")] },
    ]);
    const closedGoal = applyTransition(input, {
      ...base,
      kind: "close-by-contradiction",
      hypothesisId: "hypothesis:positive",
      negationHypothesisId: "hypothesis:negative",
    });
    expect(closedGoal).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      evidence: "structural",
      state: {
        id: "state:after",
        goals: [{ id: "goal:sibling" }],
        obligations: [{ id: "obligation:0" }],
      },
    });
    expect(input.goals).toHaveLength(2);

    expect(
      applyTransition(input, {
        ...base,
        target: { kind: "obligation", id: "obligation:0" },
        kind: "close-by-contradiction",
        hypothesisId: "hypothesis:positive",
        negationHypothesisId: "hypothesis:negative",
      }),
    ).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: { goals: [{ id: "goal:0" }, { id: "goal:sibling" }], obligations: [] },
    });
  });

  it("rejects contradictions that are missing, stale, swapped, or captured", () => {
    const input = withHypotheses([
      { id: "hypothesis:positive", expression: universal("p", "q") },
      { id: "hypothesis:negative", expression: ["Not", universal("q", "q")] },
      { id: "hypothesis:matching-negative", expression: ["Not", universal("r", "q")] },
    ]);
    const operation = (fields: Readonly<Record<string, unknown>>) => ({
      ...base,
      kind: "close-by-contradiction",
      hypothesisId: "hypothesis:positive",
      negationHypothesisId: "hypothesis:matching-negative",
      ...fields,
    });
    expect(applyTransition(input, operation({}))).toMatchObject({ ok: true });

    for (const [fields, code] of [
      [{ negationHypothesisId: "hypothesis:negative" }, "rule-not-applicable"],
      [
        {
          hypothesisId: "hypothesis:matching-negative",
          negationHypothesisId: "hypothesis:positive",
        },
        "rule-not-applicable",
      ],
      [{ negationHypothesisId: "hypothesis:missing" }, "hypothesis-not-found"],
      [{ hypothesisId: "hypothesis:missing" }, "hypothesis-not-found"],
      [{ expectedStateId: "state:stale" }, "stale-state"],
      [{ negationHypothesisId: "not a stable id" }, "invalid-operation"],
    ] as const) {
      const before = JSON.stringify(input);
      const result = applyTransition(input, operation(fields));
      expect(result).toMatchObject({ ok: false, diagnostics: [{ code }] });
      expect(result.state).toBe(input);
      expect(JSON.stringify(input)).toBe(before);
    }

    const sibling = applyTransition(
      input,
      operation({ target: { kind: "goal", id: "goal:sibling" } }),
    );
    expect(sibling).toMatchObject({ ok: false, diagnostics: [{ code: "hypothesis-not-found" }] });
  });

  it("records an accepted inference as background evidence without judging the target", () => {
    const input = state(["p", "q"], ["False"]);
    const operation = {
      ...base,
      kind: "close-by-accepted-inference",
      attestationId: "attestation:quick-check:1",
    };
    expect(kernelOperationSchema.parse(operation)).toMatchObject({
      attestationId: "attestation:quick-check:1",
    });
    expect(applyTransition(input, operation)).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      evidence: "background-inference",
      state: { goals: [{ id: "goal:1" }], obligations: [{ id: "obligation:0" }] },
    });
    expect(
      applyTransition(input, {
        ...operation,
        target: { kind: "obligation", id: "obligation:0" },
      }),
    ).toMatchObject({
      ok: true,
      evidence: "background-inference",
      state: { goals: [{ id: "goal:0" }, { id: "goal:1" }], obligations: [] },
    });

    for (const [invalid, code] of [
      [{ ...operation, attestationId: "" }, "invalid-operation"],
      [{ ...operation, attestationId: 7 }, "invalid-operation"],
      [{ kind: operation.kind, ...base }, "invalid-operation"],
      [{ ...operation, expectedStateId: "state:stale" }, "stale-state"],
      [{ ...operation, target: { kind: "goal", id: "goal:missing" } }, "target-not-found"],
    ] as const) {
      const result = applyTransition(input, invalid);
      expect(result).toMatchObject({ ok: false, diagnostics: [{ code }] });
      expect(result.state).toBe(input);
    }
  });
});

describe("weakening and strengthening primitives", () => {
  const withContext = (conclusion: PlainMathJson) =>
    deepFreeze(
      executableProofStateSchema.parse({
        id: "state:before",
        goals: [
          {
            id: "goal:0",
            sequent: sequent(conclusion, [
              { id: "hypothesis:p", expression: "p" },
              { id: "hypothesis:q", expression: { sym: "q", comment: "kept" } },
            ]),
          },
          { id: "goal:sibling", sequent: sequent("r") },
        ],
        obligations: [{ id: "obligation:0", sequent: sequent("q") }],
      }),
    );

  it("replaces a conclusion with a detached arbitrary proposition as weakening", () => {
    const input = withContext(["And", "p", "q"]);
    const proposition = { fn: ["Or", "p", "r"], comment: "replacement" };
    const result = applyTransition(input, { ...base, kind: "replace-goal", proposition });
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "weakening",
      evidence: "structural",
      state: {
        goals: [
          {
            id: "goal:0",
            sequent: {
              context: input.goals[0]?.sequent.context,
              conclusion: { expression: proposition },
            },
          },
          { id: "goal:sibling" },
        ],
        obligations: [{ id: "obligation:0" }],
      },
    });
    proposition.comment = "mutated";
    if (!result.ok) throw new Error("Expected a replaced goal.");
    expect(result.state.goals[0]?.sequent.conclusion.expression).toMatchObject({
      comment: "replacement",
    });

    expect(
      applyTransition(input, {
        ...base,
        target: { kind: "obligation", id: "obligation:0" },
        kind: "replace-goal",
        proposition: "p",
      }),
    ).toMatchObject({
      ok: true,
      transitionClass: "weakening",
      state: {
        obligations: [{ id: "obligation:0", sequent: { conclusion: { expression: "p" } } }],
      },
    });

    for (const [operation, code] of [
      [{ ...base, kind: "replace-goal", proposition: ["And", "p", "q"] }, "rule-not-applicable"],
      [{ ...base, kind: "replace-goal", proposition: "p", extra: 1 }, "invalid-operation"],
      [{ ...base, kind: "replace-goal" }, "invalid-operation"],
      [
        { ...base, kind: "replace-goal", proposition: "p", expectedStateId: "state:stale" },
        "stale-state",
      ],
    ] as const) {
      const rejected = applyTransition(input, operation);
      expect(rejected).toMatchObject({ ok: false, diagnostics: [{ code }] });
      expect(rejected.state).toBe(input);
    }
  });

  it("reduces a goal to a sufficient proposition plus a contextual implication obligation", () => {
    const input = withContext("r");
    const proposition = ["And", "p", "q"];
    const result = applyTransition(input, {
      ...base,
      kind: "suffices",
      proposition,
      obligationId: "obligation:sufficiency",
    });
    const context = input.goals[0]?.sequent.context;
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      evidence: "structural",
      state: {
        goals: [
          { id: "goal:0", sequent: { context, conclusion: { expression: proposition } } },
          { id: "goal:sibling" },
        ],
        obligations: [
          { id: "obligation:0" },
          {
            id: "obligation:sufficiency",
            sequent: { context, conclusion: { expression: ["Implies", proposition, "r"] } },
          },
        ],
      },
    });
    if (!result.ok) throw new Error("Expected a sufficiency reduction.");
    const [reduced] = result.state.goals;
    const sufficiency = result.state.obligations[1];
    expect(reduced?.sequent.context).not.toBe(sufficiency?.sequent.context);

    expect(
      applyTransition(input, {
        ...base,
        target: { kind: "obligation", id: "obligation:0" },
        kind: "suffices",
        proposition: "p",
        obligationId: "obligation:sufficiency",
      }),
    ).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      state: {
        goals: [{ id: "goal:0" }, { id: "goal:sibling" }],
        obligations: [
          { id: "obligation:0", sequent: { conclusion: { expression: "p" } } },
          {
            id: "obligation:sufficiency",
            sequent: { conclusion: { expression: ["Implies", "p", "q"] } },
          },
        ],
      },
    });

    for (const obligationId of ["goal:sibling", "obligation:0", "goal:0"]) {
      const rejected = applyTransition(input, {
        ...base,
        kind: "suffices",
        proposition: "p",
        obligationId,
      });
      expect(rejected).toMatchObject({
        ok: false,
        diagnostics: [{ code: "identifier-collision" }],
      });
      expect(rejected.state).toBe(input);
    }
    expect(applyTransition(input, { ...base, kind: "suffices", proposition: "p" })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-operation" }],
    });
  });

  it("drops one local hypothesis as strengthening and rejects unknown hypotheses", () => {
    const input = withContext("r");
    const result = applyTransition(input, {
      ...base,
      kind: "drop-hypothesis",
      hypothesisId: "hypothesis:p",
    });
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      evidence: "structural",
      state: {
        goals: [
          {
            id: "goal:0",
            sequent: {
              context: {
                declarations,
                hypotheses: [
                  { id: "hypothesis:q", statement: { expression: { sym: "q", comment: "kept" } } },
                ],
              },
              conclusion: { expression: "r" },
            },
          },
          { id: "goal:sibling" },
        ],
      },
    });
    expect(input.goals[0]?.sequent.context.hypotheses).toHaveLength(2);

    for (const [operation, code] of [
      [
        { ...base, kind: "drop-hypothesis", hypothesisId: "hypothesis:missing" },
        "hypothesis-not-found",
      ],
      [
        {
          ...base,
          target: { kind: "goal", id: "goal:sibling" },
          kind: "drop-hypothesis",
          hypothesisId: "hypothesis:p",
        },
        "hypothesis-not-found",
      ],
      [
        {
          ...base,
          expectedStateId: "state:stale",
          kind: "drop-hypothesis",
          hypothesisId: "hypothesis:p",
        },
        "stale-state",
      ],
    ] as const) {
      const rejected = applyTransition(input, operation);
      expect(rejected).toMatchObject({ ok: false, diagnostics: [{ code }] });
      expect(rejected.state).toBe(input);
    }
  });
});

function propositionOperations(proposition: unknown): readonly Readonly<Record<string, unknown>>[] {
  return [
    {
      ...base,
      kind: "split-classical-cases",
      proposition,
      childIds: ["case:positive", "case:negative"],
      branchHypothesisIds: ["hypothesis:positive", "hypothesis:negative"],
    },
    { ...base, kind: "assume-hypothesis", proposition, hypothesisId: "hypothesis:assumed" },
    { ...base, kind: "replace-goal", proposition },
    { ...base, kind: "suffices", proposition, obligationId: "obligation:sufficiency" },
  ];
}

describe("kernel rejection and atomicity", () => {
  it.each([
    ["stale state", { ...base, expectedStateId: "state:stale", kind: "close-true" }, "stale-state"],
    [
      "reused result ID",
      { ...base, resultStateId: "state:before", kind: "close-true" },
      "result-state-id-collision",
    ],
    [
      "wrong collection",
      { ...base, target: { kind: "obligation", id: "goal:0" }, kind: "close-true" },
      "target-not-found",
    ],
    [
      "wrong constructor",
      { ...base, kind: "split-goal-conjunction", childIds: ["child:0", "child:1"] },
      "rule-not-applicable",
    ],
    [
      "bad disjunct",
      { ...base, kind: "choose-goal-disjunct", disjunctIndex: 3 },
      "rule-not-applicable",
    ],
    ["strict extra field", { ...base, kind: "close-true", extra: true }, "invalid-operation"],
  ])("rejects %s and returns the exact untouched input", (_label, operation, code) => {
    const input = state(["True"]);
    const before = JSON.stringify(input);
    const result = applyTransition(input, operation);
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code }] });
    expect(result.state).toBe(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("rejects out-of-range disjuncts, wrong ID counts, and ID collisions", () => {
    const disjunction = state([["Or", "p", "q"]]);
    expect(
      applyTransition(disjunction, {
        ...base,
        kind: "choose-goal-disjunct",
        disjunctIndex: 2,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "index-out-of-range" }] });

    const conjunction = state([["And", "p", "q", "r"]], ["p"]);
    expect(
      applyTransition(conjunction, {
        ...base,
        kind: "split-goal-conjunction",
        childIds: ["child:0", "child:1"],
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "arity-mismatch" }] });
    expect(
      applyTransition(conjunction, {
        ...base,
        kind: "split-goal-conjunction",
        childIds: ["child:0", "child:0", "obligation:0"],
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "identifier-collision" }] });
  });

  it("requires exactly two classical branch IDs and rejects all fresh-ID collisions atomically", () => {
    for (const operation of [
      {
        ...base,
        kind: "split-classical-cases",
        proposition: "p",
        childIds: ["case:only"],
        branchHypothesisIds: ["hypothesis:positive", "hypothesis:negative"],
      },
      {
        ...base,
        kind: "split-classical-cases",
        proposition: "p",
        childIds: ["case:one", "case:two", "case:three"],
        branchHypothesisIds: ["hypothesis:positive", "hypothesis:negative"],
      },
      {
        ...base,
        kind: "split-classical-cases",
        proposition: "p",
        childIds: ["case:positive", "case:negative"],
        branchHypothesisIds: ["hypothesis:one", "hypothesis:two", "hypothesis:three"],
      },
    ]) {
      expect(kernelOperationSchema.safeParse(operation)).toMatchObject({ success: false });
      expect(applyTransition(state(["r"]), operation)).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-operation" }],
      });
    }

    const input = executableProofStateSchema.parse({
      id: "state:before",
      goals: [
        {
          id: "goal:0",
          sequent: sequent("r", [{ id: "hypothesis:existing", expression: "q" }]),
        },
      ],
      obligations: [{ id: "obligation:0", sequent: sequent("p") }],
    });
    for (const operation of [
      {
        ...base,
        kind: "split-classical-cases",
        proposition: "p",
        childIds: ["case:duplicate", "case:duplicate"],
        branchHypothesisIds: ["hypothesis:positive", "hypothesis:negative"],
      },
      {
        ...base,
        kind: "split-classical-cases",
        proposition: "p",
        childIds: ["goal:0", "case:negative"],
        branchHypothesisIds: ["hypothesis:positive", "hypothesis:negative"],
      },
      {
        ...base,
        kind: "split-classical-cases",
        proposition: "p",
        childIds: ["case:positive", "obligation:0"],
        branchHypothesisIds: ["hypothesis:positive", "hypothesis:negative"],
      },
      {
        ...base,
        kind: "split-classical-cases",
        proposition: "p",
        childIds: ["case:positive", "case:negative"],
        branchHypothesisIds: ["hypothesis:duplicate", "hypothesis:duplicate"],
      },
      {
        ...base,
        kind: "split-classical-cases",
        proposition: "p",
        childIds: ["case:positive", "case:negative"],
        branchHypothesisIds: ["hypothesis:positive", "hypothesis:existing"],
      },
      {
        ...base,
        kind: "assume-hypothesis",
        proposition: "p",
        hypothesisId: "hypothesis:existing",
      },
    ]) {
      const before = JSON.stringify(input);
      const result = applyTransition(input, operation);
      expect(result).toMatchObject({
        ok: false,
        diagnostics: [{ code: "identifier-collision" }],
      });
      expect(result.state).toBe(input);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("rejects malformed and unresolved input states before applying an operation", () => {
    const unresolved = {
      id: "state:before",
      goals: [
        {
          id: "goal:0",
          sequent: {
            context: {
              declarations: [
                {
                  id: "declaration:task",
                  symbol: "task",
                  sort: PROPOSITION_SORT,
                  role: "construction-metavariable",
                  resolution: { status: "unresolved" },
                },
              ],
              hypotheses: [],
            },
            conclusion: { expression: "task" },
          },
        },
      ],
      obligations: [],
    } as unknown as ExecutableProofState;
    const result = applyTransition(unresolved, { ...base, kind: "close-true" });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-input-state" }] });
    expect(result.state).toBe(unresolved);
  });

  it("contains proxies retained by plain MathJSON validation", () => {
    const expression = new Proxy(["And", "True", "True"], {}) as unknown as PlainMathJson;
    const input = state([expression]);
    const result = applyTransition(input, {
      ...base,
      kind: "split-goal-conjunction",
      childIds: ["child:0", "child:1"],
    });

    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-input-state" }] });
    expect(result.state).toBe(input);
  });

  it("works with deeply frozen input and detaches successful output", () => {
    const input = deepFreeze(state([["Implies", "p", "q"]]));
    const result = applyTransition(input, {
      ...base,
      kind: "introduce-implication",
      hypothesisId: "hypothesis:p",
    });
    expect(result).toMatchObject({ ok: true, state: { id: "state:after" } });
    if (!result.ok) throw new Error("Expected a successful transition.");
    expect(result.state).not.toBe(input);
    expect(result.state.goals[0]).not.toBe(input.goals[0]);
  });

  it("rejects accessor-backed operation objects without invoking getters", () => {
    let invoked = false;
    const operation = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        invoked = true;
        return "close-true";
      },
    });
    expect(kernelOperationSchema.safeParse(operation).success).toBe(false);
    expect(invoked).toBe(false);

    const childIds = ["child:0", "child:1"];
    Object.defineProperty(childIds, 1, {
      enumerable: true,
      get() {
        invoked = true;
        return "child:1";
      },
    });
    expect(
      kernelOperationSchema.safeParse({
        ...base,
        kind: "split-goal-conjunction",
        childIds,
      }).success,
    ).toBe(false);
    expect(invoked).toBe(false);
  });

  it("normalizes expression, ID-list, term, and path payloads into detached operation data", () => {
    const term = { sym: "q", comment: "original" };
    const path = [0];
    const proposition = { fn: ["Or", "p", "q"], comment: "original proposition" };
    const childIds = ["case:positive", "case:negative"];
    const branchHypothesisIds = ["hypothesis:positive", "hypothesis:negative"];
    const parsed = kernelOperationSchema.safeParse({
      ...base,
      kind: "rewrite-with-equality",
      equalityHypothesisId: "hypothesis:equality",
      statement: { kind: "conclusion" },
      path,
      direction: "forward",
    });
    const instantiated = kernelOperationSchema.safeParse({
      ...base,
      kind: "instantiate-universal-hypothesis",
      hypothesisId: "hypothesis:universal",
      term,
      resultHypothesisId: "hypothesis:instance",
    });
    const split = kernelOperationSchema.safeParse({
      ...base,
      kind: "split-classical-cases",
      proposition,
      childIds,
      branchHypothesisIds,
    });

    expect(parsed.success).toBe(true);
    expect(instantiated.success).toBe(true);
    expect(split.success).toBe(true);
    path[0] = 4;
    term.comment = "mutated";
    proposition.comment = "mutated";
    childIds[0] = "case:mutated";
    branchHypothesisIds[1] = "hypothesis:mutated";
    if (parsed.success && parsed.data.kind === "rewrite-with-equality") {
      expect(parsed.data.path).toEqual([0]);
    }
    if (instantiated.success && instantiated.data.kind === "instantiate-universal-hypothesis") {
      expect(instantiated.data.term).toEqual({ sym: "q", comment: "original" });
    }
    if (split.success && split.data.kind === "split-classical-cases") {
      expect(split.data.proposition).toEqual({
        fn: ["Or", "p", "q"],
        comment: "original proposition",
      });
      expect(split.data.childIds).toEqual(["case:positive", "case:negative"]);
      expect(split.data.branchHypothesisIds).toEqual([
        "hypothesis:positive",
        "hypothesis:negative",
      ]);
    }
  });

  it("rejects inherited-looking kinds and symbol fields without throwing", () => {
    for (const kind of ["constructor", "toString", "__proto__"]) {
      expect(kernelOperationSchema.safeParse({ kind })).toMatchObject({ success: false });
      const input = state(["True"]);
      const result = applyTransition(input, { kind });
      expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-operation" }] });
      expect(result.state).toBe(input);
    }

    const operation = { ...base, kind: "close-true", [Symbol("extra")]: true };
    expect(kernelOperationSchema.safeParse(operation)).toMatchObject({ success: false });

    let iteratorInvoked = false;
    const childIds = ["child:0", "child:1"];
    Object.defineProperty(childIds, Symbol.iterator, {
      get() {
        iteratorInvoked = true;
        throw new Error("must not invoke custom iterator");
      },
    });
    const iteratorOperation = {
      ...base,
      kind: "split-goal-conjunction",
      childIds,
    };
    expect(kernelOperationSchema.safeParse(iteratorOperation)).toMatchObject({ success: false });
    expect(applyTransition(state([["And", "p", "q"]]), iteratorOperation)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-operation" }],
    });
    expect(iteratorInvoked).toBe(false);
  });
});

describe("transition classifications", () => {
  it("agree with exhaustive Boolean semantics for representative uses of all rules", () => {
    const transitions = representativeTransitions();
    let witnessedStrictStrengthening = false;
    let witnessedStrictWeakening = false;
    for (const [before, operation, expectedClass] of transitions) {
      const result = applyTransition(before, operation);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.transitionClass).toBe(expectedClass);
      expect(result.evidence).toBe(
        (operation as { kind: string }).kind === "close-by-accepted-inference"
          ? "background-inference"
          : "structural",
      );
      for (const valuation of valuations(["p", "q", "r"])) {
        const beforeValue = evaluateState(before, valuation);
        const afterValue = evaluateState(result.state, valuation);
        if (expectedClass === "equivalence") expect(afterValue).toBe(beforeValue);
        else if (expectedClass === "strengthening") {
          expect(!afterValue || beforeValue).toBe(true);
          witnessedStrictStrengthening ||= beforeValue && !afterValue;
        } else {
          expect(!beforeValue || afterValue).toBe(true);
          witnessedStrictWeakening ||= !beforeValue && afterValue;
        }
      }
    }
    expect(witnessedStrictStrengthening).toBe(true);
    expect(witnessedStrictWeakening).toBe(true);
  });
});

function representativeTransitions(): readonly [
  ExecutableProofState,
  unknown,
  "equivalence" | "strengthening" | "weakening",
][] {
  const withHypothesis = (conclusion: PlainMathJson, id: string, expression: PlainMathJson) =>
    executableProofStateSchema.parse({
      ...state([conclusion]),
      goals: [{ id: "goal:0", sequent: sequent(conclusion, [{ id, expression }]) }],
    });
  const transitions: readonly [
    ExecutableProofState,
    unknown,
    "equivalence" | "strengthening" | "weakening",
  ][] = [
    [
      withHypothesis("p", "hypothesis:p", "p"),
      { ...base, kind: "close-by-hypothesis", hypothesisId: "hypothesis:p" },
      "equivalence",
    ],
    [
      state(["p"], ["True"]),
      {
        ...base,
        target: { kind: "obligation", id: "obligation:0" },
        kind: "close-true",
      },
      "equivalence",
    ],
    [
      withHypothesis("p", "hypothesis:false", "False"),
      { ...base, kind: "close-false-hypothesis", hypothesisId: "hypothesis:false" },
      "equivalence",
    ],
    [state([["Equal", "p", "p"]]), { ...base, kind: "close-reflexive-equality" }, "equivalence"],
    [
      state([["Implies", "p", "q"]]),
      { ...base, kind: "introduce-implication", hypothesisId: "hypothesis:p" },
      "equivalence",
    ],
    [
      state([["Not", "p"]]),
      { ...base, kind: "introduce-negation", hypothesisId: "hypothesis:p" },
      "equivalence",
    ],
    [
      state([["And", "p", "q"]]),
      { ...base, kind: "split-goal-conjunction", childIds: ["child:p", "child:q"] },
      "equivalence",
    ],
    [
      state([["Or", "p", "q"]]),
      { ...base, kind: "choose-goal-disjunct", disjunctIndex: 0 },
      "strengthening",
    ],
    [
      withHypothesis("r", "hypothesis:and", ["And", "p", "q"]),
      {
        ...base,
        kind: "expand-hypothesis-conjunction",
        hypothesisId: "hypothesis:and",
        expandedHypothesisIds: ["hypothesis:p", "hypothesis:q"],
      },
      "equivalence",
    ],
    [
      withHypothesis("r", "hypothesis:or", ["Or", "p", "q"]),
      {
        ...base,
        kind: "split-hypothesis-disjunction",
        hypothesisId: "hypothesis:or",
        childIds: ["case:p", "case:q"],
        branchHypothesisIds: ["case-hypothesis:p", "case-hypothesis:q"],
      },
      "equivalence",
    ],
    [
      state(["q"]),
      {
        ...base,
        kind: "split-classical-cases",
        proposition: "p",
        childIds: ["case:p", "case:not-p"],
        branchHypothesisIds: ["hypothesis:p", "hypothesis:not-p"],
      },
      "equivalence",
    ],
    [
      state(["q"]),
      {
        ...base,
        kind: "assume-hypothesis",
        proposition: "p",
        hypothesisId: "hypothesis:p",
      },
      "weakening",
    ],
    [state([["And", "p", "q"]]), { ...base, kind: "replace-goal", proposition: "p" }, "weakening"],
    [
      state(["q"]),
      {
        ...base,
        kind: "suffices",
        proposition: ["And", "p", "q"],
        obligationId: "obligation:sufficiency",
      },
      "strengthening",
    ],
    [
      withHypothesis("p", "hypothesis:p", "p"),
      { ...base, kind: "drop-hypothesis", hypothesisId: "hypothesis:p" },
      "strengthening",
    ],
    [
      executableProofStateSchema.parse({
        ...state(["r"]),
        goals: [
          {
            id: "goal:0",
            sequent: sequent("r", [
              { id: "hypothesis:p", expression: "p" },
              { id: "hypothesis:not-p", expression: ["Not", "p"] },
            ]),
          },
        ],
      }),
      {
        ...base,
        kind: "close-by-contradiction",
        hypothesisId: "hypothesis:p",
        negationHypothesisId: "hypothesis:not-p",
      },
      "equivalence",
    ],
    [
      state([["Implies", "p", ["Or", "p", "q"]]]),
      { ...base, kind: "close-by-accepted-inference", attestationId: "attestation:valid" },
      "equivalence",
    ],
    [
      executableProofStateSchema.parse({
        ...state(["r"]),
        goals: [
          {
            id: "goal:0",
            sequent: sequent("r", [
              { id: "hypothesis:implication", expression: ["Implies", "p", "q"] },
              { id: "hypothesis:antecedent", expression: "p" },
            ]),
          },
        ],
      }),
      {
        ...base,
        kind: "apply-implication-hypothesis",
        implicationHypothesisId: "hypothesis:implication",
        antecedentHypothesisId: "hypothesis:antecedent",
        resultHypothesisId: "hypothesis:consequent",
      },
      "equivalence",
    ],
    [
      executableProofStateSchema.parse({
        ...state([["Implies", "p", "r"]]),
        goals: [
          {
            id: "goal:0",
            sequent: sequent(
              ["Implies", "p", "r"],
              [{ id: "hypothesis:equality", expression: ["Equal", "p", "q"] }],
            ),
          },
        ],
      }),
      {
        ...base,
        kind: "rewrite-with-equality",
        equalityHypothesisId: "hypothesis:equality",
        statement: { kind: "conclusion" },
        path: [0],
        direction: "forward",
      },
      "equivalence",
    ],
  ];
  return transitions.map(([input, operation, transitionClass]) => [
    addBystanders(input),
    operation,
    transitionClass,
  ]);
}

function addBystanders(input: ExecutableProofState): ExecutableProofState {
  return executableProofStateSchema.parse({
    ...input,
    goals: [...input.goals, { id: "goal:sibling", sequent: sequent("True") }],
    obligations: [...input.obligations, { id: "obligation:sibling", sequent: sequent("True") }],
  });
}

function valuations(symbols: readonly string[]): readonly Readonly<Record<string, boolean>>[] {
  return Array.from({ length: 2 ** symbols.length }, (_unused, bits) =>
    Object.fromEntries(symbols.map((symbol, index) => [symbol, Boolean(bits & (1 << index))])),
  );
}

function evaluateState(
  input: ExecutableProofState,
  valuation: Readonly<Record<string, boolean>>,
): boolean {
  return [...input.goals, ...input.obligations].every(({ sequent: current }) => {
    const assumptions = current.context.hypotheses.every(({ statement }) =>
      evaluate(statement.expression, valuation),
    );
    return !assumptions || evaluate(current.conclusion.expression, valuation);
  });
}

function evaluate(
  expression: PlainMathJson,
  valuation: Readonly<Record<string, boolean>>,
): boolean {
  if (typeof expression === "string") {
    if (expression === "True") return true;
    if (expression === "False") return false;
    return valuation[expression] ?? false;
  }
  if (typeof expression !== "object" || expression === null) return false;
  if (!Array.isArray(expression) && "sym" in expression) return evaluate(expression.sym, valuation);
  const fn = Array.isArray(expression)
    ? expression
    : "fn" in expression
      ? expression.fn
      : undefined;
  if (fn === undefined) return false;
  const operands = fn.slice(1) as readonly PlainMathJson[];
  if (fn[0] === "Not") return !evaluate(operands[0] as PlainMathJson, valuation);
  if (fn[0] === "And") return operands.every((operand) => evaluate(operand, valuation));
  if (fn[0] === "Or") return operands.some((operand) => evaluate(operand, valuation));
  if (fn[0] === "Implies") {
    return (
      !evaluate(operands[0] as PlainMathJson, valuation) ||
      evaluate(operands[1] as PlainMathJson, valuation)
    );
  }
  if (fn[0] === "Equal") {
    const values = operands.map((operand) => evaluate(operand, valuation));
    return values.every((value) => value === values[0]);
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}
