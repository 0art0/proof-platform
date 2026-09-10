import { describe, expect, it } from "vitest";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
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
  it("closes a target only with an exact hypothesis in its local context", () => {
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

  it("normalizes term and path payloads into detached operation data", () => {
    const term = { sym: "q", comment: "original" };
    const path = [0];
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

    expect(parsed.success).toBe(true);
    expect(instantiated.success).toBe(true);
    path[0] = 4;
    term.comment = "mutated";
    if (parsed.success && parsed.data.kind === "rewrite-with-equality") {
      expect(parsed.data.path).toEqual([0]);
    }
    if (instantiated.success && instantiated.data.kind === "instantiate-universal-hypothesis") {
      expect(instantiated.data.term).toEqual({ sym: "q", comment: "original" });
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
    for (const [before, operation, expectedClass] of transitions) {
      const result = applyTransition(before, operation);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.transitionClass).toBe(expectedClass);
      for (const valuation of valuations(["p", "q", "r"])) {
        const beforeValue = evaluateState(before, valuation);
        const afterValue = evaluateState(result.state, valuation);
        if (expectedClass === "equivalence") expect(afterValue).toBe(beforeValue);
        else expect(!afterValue || beforeValue).toBe(true);
      }
    }
  });
});

function representativeTransitions(): readonly [
  ExecutableProofState,
  unknown,
  "equivalence" | "strengthening",
][] {
  const withHypothesis = (conclusion: PlainMathJson, id: string, expression: PlainMathJson) =>
    executableProofStateSchema.parse({
      ...state([conclusion]),
      goals: [{ id: "goal:0", sequent: sequent(conclusion, [{ id, expression }]) }],
    });
  const transitions: readonly [ExecutableProofState, unknown, "equivalence" | "strengthening"][] = [
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
    goals: [...input.goals, { id: "goal:sibling", sequent: sequent("q") }],
    obligations: [...input.obligations, { id: "obligation:sibling", sequent: sequent("r") }],
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
