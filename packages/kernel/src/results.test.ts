import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PROPOSITION_SORT,
  createExecutableProofStateSchema,
  operatorDeclarationsSchema,
  substituteMathJson,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  alphaEquivalent,
  applyTransition,
  kernelOperationSchema,
  matchResultConclusion,
  parseKernelResultCatalog,
  type KernelEnvironment,
  type KernelResult,
} from "./index";

const natSort = { kind: "named", id: "sort:natural" } as const;
const natToProp = {
  kind: "function",
  signature: { parameters: [natSort], result: PROPOSITION_SORT },
} as const;

/** `Every n. body`: a custom binder whose bound symbol's sort comes from its signature. */
const operators = operatorDeclarationsSchema.parse([
  {
    id: "operator:every",
    symbol: "Every",
    signature: { parameters: [natSort, PROPOSITION_SORT], result: PROPOSITION_SORT },
    binder: { kind: "direct-symbols", boundOperands: [0], scopedOperands: [1] },
  },
]);

const contextDeclarations = [
  ...["p", "q", "r"].map((symbol) => ({ symbol, sort: PROPOSITION_SORT })),
  ...["x", "y", "z", "n"].map((symbol) => ({ symbol, sort: natSort })),
  { symbol: "Q", sort: natToProp },
].map((declaration, index) => ({
  id: `declaration:${index}`,
  ...declaration,
  role: "universal-parameter" as const,
}));

type Fact = Readonly<{ id: string; expression: PlainMathJson }>;

function sequent(conclusion: PlainMathJson, hypotheses: readonly Fact[] = []) {
  return {
    context: {
      declarations: contextDeclarations,
      hypotheses: hypotheses.map(({ id, expression }) => ({ id, statement: { expression } })),
    },
    conclusion: { expression: conclusion },
  };
}

function goalState(
  conclusion: PlainMathJson,
  hypotheses: readonly Fact[] = [],
  obligations: readonly PlainMathJson[] = [],
): ExecutableProofState {
  return parseState({
    id: "state:before",
    goals: [{ id: "goal:0", sequent: sequent(conclusion, hypotheses) }],
    obligations: obligations.map((expression, index) => ({
      id: `obligation:${index}`,
      sequent: sequent(expression),
    })),
  });
}

function parseState(value: unknown): ExecutableProofState {
  return createExecutableProofStateSchema({ operators }).parse(value);
}

function nat(symbol: string) {
  return { symbol, sort: natSort };
}

function prop(symbol: string) {
  return { symbol, sort: PROPOSITION_SORT };
}

const lessTransitive: KernelResult = {
  id: "result:less-transitive",
  parameters: [nat("a"), nat("b"), nat("c")],
  premises: [{ expression: ["Less", "a", "b"] }, { expression: ["Less", "b", "c"] }],
  conclusion: { expression: ["Less", "a", "c"] },
  directions: ["backward", "forward"],
} as unknown as KernelResult;

const lessEqualReflexive = {
  id: "result:less-equal-reflexive",
  parameters: [nat("a")],
  premises: [],
  conclusion: { expression: ["LessEqual", "a", "a"] },
  directions: ["backward"],
} as unknown as KernelResult;

/** `CORE_LOGIC_RESULTS` modus ponens, hand-converted from `((p ⇒ q) ∧ p) ⇒ q`. */
const modusPonens = {
  id: "result:modus-ponens",
  parameters: [prop("p"), prop("q")],
  premises: [{ expression: ["Implies", "p", "q"] }, { expression: "p" }],
  conclusion: { expression: "q" },
  directions: ["forward"],
} as unknown as KernelResult;

/** A premise binds `n`; instantiating `t` with a term mentioning a free `n` must not be captured. */
const boundedPremise = {
  id: "result:bounded-premise",
  parameters: [nat("t")],
  premises: [{ expression: ["Every", "n", ["Less", "n", "t"]] }],
  conclusion: { expression: ["LessEqual", "t", "t"] },
  directions: ["backward", "forward"],
} as unknown as KernelResult;

const predicateReflexive = {
  id: "result:predicate-implies-itself",
  parameters: [{ symbol: "P", sort: natToProp }, nat("a")],
  premises: [],
  conclusion: { expression: ["Implies", ["P", "a"], ["P", "a"]] },
  directions: ["backward"],
} as unknown as KernelResult;

const environment: KernelEnvironment = {
  operators,
  results: [lessTransitive, lessEqualReflexive, modusPonens, boundedPremise, predicateReflexive],
};

const goalTarget = { kind: "goal" as const, id: "goal:0" };
const base = { expectedStateId: "state:before", resultStateId: "state:after", target: goalTarget };

function backward(
  resultId: string,
  instantiation: Readonly<Record<string, PlainMathJson>>,
  premiseTargetIds: readonly string[],
  target: Readonly<{ kind: "goal" | "obligation"; id: string }> = goalTarget,
) {
  return {
    ...base,
    target,
    kind: "apply-result-backward",
    resultId,
    instantiation,
    premiseTargetIds,
  };
}

function forward(
  resultId: string,
  instantiation: Readonly<Record<string, PlainMathJson>>,
  premiseHypothesisIds: readonly (string | null)[],
  obligationIds: readonly string[] = [],
  target: Readonly<{ kind: "goal" | "obligation"; id: string }> = goalTarget,
) {
  return {
    ...base,
    target,
    kind: "apply-result-forward",
    resultId,
    instantiation,
    premiseHypothesisIds,
    resultHypothesisId: "hypothesis:derived",
    obligationIds,
  };
}

describe("result catalog validation", () => {
  it("accepts a well-formed catalog and returns a detached copy", () => {
    const parsed = parseKernelResultCatalog(environment.results, operators);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.results).toEqual(environment.results);
      expect(parsed.results[0]).not.toBe(lessTransitive);
    }
  });

  it.each<[string, unknown]>([
    ["duplicate IDs", [lessTransitive, lessTransitive]],
    [
      "duplicate parameter symbols",
      [{ ...lessTransitive, parameters: [nat("a"), nat("a"), nat("c")] }],
    ],
    ["a parameter reusing an operator", [{ ...lessEqualReflexive, parameters: [nat("Every")] }]],
    ["a reserved parameter symbol", [{ ...lessEqualReflexive, parameters: [nat("Add")] }]],
    [
      "a conclusion that is a term",
      [{ ...lessEqualReflexive, conclusion: { expression: ["Add", "a", 1] } }],
    ],
    [
      "a free symbol that is not a parameter",
      [{ ...lessEqualReflexive, conclusion: { expression: ["LessEqual", "a", "w"] } }],
    ],
    ["an ill-sorted premise", [{ ...modusPonens, premises: [{ expression: ["Less", "p", "q"] }] }]],
    ["empty directions", [{ ...lessEqualReflexive, directions: [] }]],
    ["duplicate directions", [{ ...lessEqualReflexive, directions: ["backward", "backward"] }]],
    ["an unknown direction", [{ ...lessEqualReflexive, directions: ["sideways"] }]],
    ["unknown fields", [{ ...lessEqualReflexive, equivalence: true }]],
  ])("rejects %s as an invalid environment", (_label, results) => {
    const input = goalState(["LessEqual", "x", "x"]);
    const result = applyTransition(input, backward("result:less-equal-reflexive", { a: "x" }, []), {
      operators,
      results: results as readonly KernelResult[],
    });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-environment" }] });
    expect(result.state).toBe(input);
  });
});

describe("apply-result-backward", () => {
  it("replaces a goal with its instantiated premises in the same context", () => {
    const input = goalState(["Less", "x", "z"], [{ id: "hypothesis:h", expression: "r" }]);
    const before = JSON.stringify(input);
    const result = applyTransition(
      input,
      backward("result:less-transitive", { a: "x", b: ["Add", "y", 1], c: "z" }, [
        "goal:left",
        "goal:right",
      ]),
      environment,
    );
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      evidence: "library-result",
      resultId: "result:less-transitive",
      state: {
        id: "state:after",
        goals: [
          {
            id: "goal:left",
            sequent: {
              context: {
                declarations: contextDeclarations,
                hypotheses: [{ id: "hypothesis:h", statement: { expression: "r" } }],
              },
              conclusion: { expression: ["Less", "x", ["Add", "y", 1]] },
            },
          },
          {
            id: "goal:right",
            sequent: { conclusion: { expression: ["Less", ["Add", "y", 1], "z"] } },
          },
        ],
        obligations: [],
      },
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps obligation premises as obligations at the target's position", () => {
    const input = parseState({
      id: "state:before",
      goals: [],
      obligations: [
        { id: "obligation:first", sequent: sequent(["Less", "x", "z"]) },
        { id: "obligation:last", sequent: sequent("r") },
      ],
    });
    const result = applyTransition(
      input,
      backward("result:less-transitive", { a: "x", b: "y", c: "z" }, ["o:1", "o:2"], {
        kind: "obligation",
        id: "obligation:first",
      }),
      environment,
    );
    expect(result).toMatchObject({
      ok: true,
      state: {
        goals: [],
        obligations: [{ id: "o:1" }, { id: "o:2" }, { id: "obligation:last" }],
      },
    });
  });

  it("closes the target when the result has no premises", () => {
    const result = applyTransition(
      goalState(["LessEqual", "x", "x"]),
      backward("result:less-equal-reflexive", { a: "x" }, []),
      environment,
    );
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      evidence: "library-result",
      state: { goals: [], obligations: [] },
    });
  });

  it("instantiates function-sorted parameters with declared function symbols", () => {
    const result = applyTransition(
      goalState(["Implies", ["Q", "x"], ["Q", "x"]]),
      backward("result:predicate-implies-itself", { P: "Q", a: "x" }, []),
      environment,
    );
    expect(result).toMatchObject({ ok: true, state: { goals: [] } });
    const illSorted = applyTransition(
      goalState(["Implies", ["Q", "x"], ["Q", "x"]]),
      backward("result:predicate-implies-itself", { P: "x", a: "x" }, []),
      environment,
    );
    expect(illSorted).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-instantiation" }],
    });
  });

  it("avoids capturing a free instantiation symbol under a binder in a premise", () => {
    const result = applyTransition(
      goalState(["LessEqual", "n", "n"]),
      backward("result:bounded-premise", { t: "n" }, ["goal:bounded"]),
      environment,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const premise = result.state.goals[0]?.sequent.conclusion.expression as PlainMathJson;
    expect(premise).toEqual(["Every", "n_1", ["Less", "n_1", "n"]]);
    expect(alphaEquivalent(premise, ["Every", "k", ["Less", "k", "n"]], { operators })).toBe(true);
    expect(alphaEquivalent(premise, ["Every", "n", ["Less", "n", "n"]], { operators })).toBe(false);
  });

  const less: PlainMathJson = ["Less", "x", "z"];
  const lessEqual: PlainMathJson = ["LessEqual", "x", "x"];
  it.each<[string, PlainMathJson, Readonly<Record<string, unknown>>, string]>([
    [
      "an unknown result",
      lessEqual,
      backward("result:missing", { a: "x" }, []),
      "result-not-found",
    ],
    [
      "a forward-only result",
      "q",
      backward("result:modus-ponens", { p: "p", q: "q" }, ["g:1", "g:2"]),
      "direction-not-permitted",
    ],
    [
      "a missing parameter",
      less,
      backward("result:less-transitive", { a: "x", c: "z" }, ["g:1", "g:2"]),
      "missing-instantiation",
    ],
    [
      "an unknown parameter",
      lessEqual,
      backward("result:less-equal-reflexive", { a: "x", extra: "y" }, []),
      "invalid-instantiation",
    ],
    [
      "an ill-sorted term",
      lessEqual,
      backward("result:less-equal-reflexive", { a: "p" }, []),
      "invalid-instantiation",
    ],
    [
      "an out-of-scope term",
      lessEqual,
      backward("result:less-equal-reflexive", { a: "w" }, []),
      "invalid-instantiation",
    ],
    [
      "a conclusion mismatch",
      lessEqual,
      backward("result:less-equal-reflexive", { a: "y" }, []),
      "conclusion-mismatch",
    ],
    [
      "too few premise target IDs",
      less,
      backward("result:less-transitive", { a: "x", b: "y", c: "z" }, ["g:1"]),
      "arity-mismatch",
    ],
    [
      "a premise target ID that is not fresh",
      less,
      backward("result:less-transitive", { a: "x", b: "y", c: "z" }, ["g:1", "goal:0"]),
      "identifier-collision",
    ],
    [
      "duplicate premise target IDs",
      less,
      backward("result:less-transitive", { a: "x", b: "y", c: "z" }, ["g:1", "g:1"]),
      "identifier-collision",
    ],
  ])("rejects %s atomically", (_label, conclusion, operation, code) => {
    const input = goalState(conclusion);
    const result = applyTransition(input, operation, environment);
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code }] });
    expect(result.state).toBe(input);
  });

  it("parses strictly and rejects malformed result operations", () => {
    const valid = backward("result:less-equal-reflexive", { a: "x" }, []);
    expect(kernelOperationSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, resultId: "" },
      { ...valid, instantiation: [] },
      { ...valid, instantiation: { a: undefined } },
      { ...valid, premiseTargetIds: [""] },
      { ...valid, premiseTargetIds: [null] },
      { ...valid, extra: true },
      { ...forward("result:modus-ponens", {}, []), premiseHypothesisIds: [7] },
    ]) {
      expect(kernelOperationSchema.safeParse(invalid).success).toBe(false);
    }
    let invoked = false;
    const hostile = Object.defineProperty({}, "a", {
      enumerable: true,
      get() {
        invoked = true;
        return "x";
      },
    });
    expect(kernelOperationSchema.safeParse({ ...valid, instantiation: hostile }).success).toBe(
      false,
    );
    expect(invoked).toBe(false);
  });
});

describe("apply-result-forward", () => {
  const facts: readonly Fact[] = [
    { id: "hypothesis:implication", expression: ["Implies", "r", ["Less", "x", "y"]] },
    { id: "hypothesis:r", expression: "r" },
  ];

  it("derives modus ponens from matching hypotheses as an equivalence", () => {
    const input = goalState("q", facts);
    const result = applyTransition(
      input,
      forward("result:modus-ponens", { p: "r", q: ["Less", "x", "y"] }, [
        "hypothesis:implication",
        "hypothesis:r",
      ]),
      environment,
    );
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      evidence: "library-result",
      resultId: "result:modus-ponens",
      state: {
        goals: [
          {
            id: "goal:0",
            sequent: {
              context: {
                hypotheses: [
                  { id: "hypothesis:implication" },
                  { id: "hypothesis:r" },
                  { id: "hypothesis:derived", statement: { expression: ["Less", "x", "y"] } },
                ],
              },
              conclusion: { expression: "q" },
            },
          },
        ],
        obligations: [],
      },
    });
  });

  it("turns unmet premises into obligations in the target's original context", () => {
    const input = goalState("q", [facts[0] as Fact], ["p"]);
    const result = applyTransition(
      input,
      forward(
        "result:modus-ponens",
        { p: "r", q: ["Less", "x", "y"] },
        ["hypothesis:implication", null],
        ["obligation:premise"],
      ),
      environment,
    );
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [{ id: "goal:0" }],
        obligations: [
          { id: "obligation:0" },
          {
            id: "obligation:premise",
            sequent: {
              context: { hypotheses: [{ id: "hypothesis:implication" }] },
              conclusion: { expression: "r" },
            },
          },
        ],
      },
    });
    if (result.ok) {
      expect(result.state.goals[0]?.sequent.context.hypotheses).toHaveLength(2);
      expect(result.state.obligations[1]?.sequent.context.hypotheses).toHaveLength(1);
    }
  });

  it("keeps obligations created for an obligation target adjacent to it", () => {
    const input = parseState({
      id: "state:before",
      goals: [{ id: "goal:0", sequent: sequent("r") }],
      obligations: [
        { id: "obligation:target", sequent: sequent("q") },
        { id: "obligation:last", sequent: sequent("r") },
      ],
    });
    const result = applyTransition(
      input,
      forward(
        "result:modus-ponens",
        { p: "p", q: "q" },
        [null, null],
        ["obligation:implication", "obligation:antecedent"],
        { kind: "obligation", id: "obligation:target" },
      ),
      environment,
    );
    expect(result).toMatchObject({
      ok: true,
      state: {
        goals: [{ id: "goal:0" }],
        obligations: [
          { id: "obligation:target" },
          {
            id: "obligation:implication",
            sequent: { conclusion: { expression: ["Implies", "p", "q"] } },
          },
          { id: "obligation:antecedent", sequent: { conclusion: { expression: "p" } } },
          { id: "obligation:last" },
        ],
      },
    });
  });

  it("matches premises up to renaming of bound symbols after capture-avoiding instantiation", () => {
    const input = goalState("q", [
      { id: "hypothesis:bounded", expression: ["Every", "k", ["Less", "k", "n"]] },
    ]);
    const result = applyTransition(
      input,
      forward("result:bounded-premise", { t: "n" }, ["hypothesis:bounded"]),
      environment,
    );
    expect(result).toMatchObject({
      ok: true,
      state: {
        goals: [
          {
            sequent: {
              context: {
                hypotheses: [
                  { id: "hypothesis:bounded" },
                  {
                    id: "hypothesis:derived",
                    statement: { expression: ["LessEqual", "n", "n"] },
                  },
                ],
              },
            },
          },
        ],
      },
    });

    // A hypothesis in which the bound symbol captured the instantiation term is a different fact.
    const captured = goalState("q", [
      { id: "hypothesis:bounded", expression: ["Every", "n", ["Less", "n", "n"]] },
    ]);
    expect(
      applyTransition(
        captured,
        forward("result:bounded-premise", { t: "n" }, ["hypothesis:bounded"]),
        environment,
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "premise-mismatch" }] });
  });

  it.each<[string, Readonly<Record<string, unknown>>, string]>([
    [
      "a hypothesis that does not match its premise",
      forward("result:modus-ponens", { p: "r", q: ["Less", "x", "y"] }, [
        "hypothesis:r",
        "hypothesis:implication",
      ]),
      "premise-mismatch",
    ],
    [
      "a premise hypothesis outside the local context",
      forward("result:modus-ponens", { p: "r", q: ["Less", "x", "y"] }, [
        "hypothesis:implication",
        "hypothesis:missing",
      ]),
      "hypothesis-not-found",
    ],
    [
      "a premise list of the wrong length",
      forward("result:modus-ponens", { p: "r", q: "q" }, ["hypothesis:implication"]),
      "arity-mismatch",
    ],
    [
      "obligation IDs that do not match the unmet premises",
      forward("result:modus-ponens", { p: "r", q: ["Less", "x", "y"] }, [
        "hypothesis:implication",
        null,
      ]),
      "arity-mismatch",
    ],
    [
      "an obligation ID that is not fresh",
      forward(
        "result:modus-ponens",
        { p: "r", q: ["Less", "x", "y"] },
        ["hypothesis:implication", null],
        ["goal:0"],
      ),
      "identifier-collision",
    ],
    [
      "a derived hypothesis ID that is not fresh",
      {
        ...forward("result:modus-ponens", { p: "r", q: ["Less", "x", "y"] }, [
          "hypothesis:implication",
          "hypothesis:r",
        ]),
        resultHypothesisId: "hypothesis:r",
      },
      "identifier-collision",
    ],
    [
      "a backward-only result",
      forward("result:less-equal-reflexive", { a: "x" }, []),
      "direction-not-permitted",
    ],
    [
      "an ill-sorted instantiation",
      forward("result:modus-ponens", { p: "x", q: "q" }, [null, null], ["o:1", "o:2"]),
      "invalid-instantiation",
    ],
  ])("rejects %s atomically", (_label, operation, code) => {
    const input = goalState("q", facts);
    const result = applyTransition(input, operation, environment);
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code }] });
    expect(result.state).toBe(input);
  });
});

describe("matchResultConclusion", () => {
  it("instantiates conclusion parameters and reports premise-only parameters", () => {
    const match = matchResultConclusion(modusPonens, { expression: ["Less", "x", "y"] });
    expect(match).toEqual({
      ok: true,
      instantiation: { q: ["Less", "x", "y"] },
      unboundParameters: ["p"],
      diagnostics: [],
    });
    expect(Object.isFrozen(match)).toBe(true);
    if (match.ok) expect(Object.isFrozen(match.instantiation)).toBe(true);
  });

  it("matches non-linear patterns consistently", () => {
    expect(
      matchResultConclusion(lessEqualReflexive, { expression: ["LessEqual", "x", "x"] }),
    ).toMatchObject({ ok: true, instantiation: { a: "x" }, unboundParameters: [] });
    expect(
      matchResultConclusion(lessEqualReflexive, { expression: ["LessEqual", "x", "y"] }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "conclusion-mismatch" }] });
  });

  it("respects binders in the pattern and the statement", () => {
    const every = {
      id: "result:every-below",
      parameters: [nat("a")],
      premises: [],
      conclusion: { expression: ["Every", "m", ["Less", "m", "a"]] },
      directions: ["backward"],
    };
    expect(
      matchResultConclusion(
        every,
        { expression: ["Every", "k", ["Less", "k", "x"]] },
        {
          operators,
        },
      ),
    ).toMatchObject({ ok: true, instantiation: { a: "x" } });
    // `a` cannot match a symbol bound inside the statement.
    expect(
      matchResultConclusion(
        every,
        { expression: ["Every", "k", ["Less", "k", "k"]] },
        {
          operators,
        },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "conclusion-mismatch" }] });
    // Without the operator environment, Every is not a binder and the result is invalid.
    expect(
      matchResultConclusion(every, { expression: ["Every", "k", ["Less", "k", "x"]] }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-result" }] });
  });

  it("binds function-sorted parameters in head position", () => {
    expect(
      matchResultConclusion(predicateReflexive, {
        expression: ["Implies", ["Q", "x"], ["Q", "x"]],
      }),
    ).toMatchObject({ ok: true, instantiation: { P: "Q", a: "x" } });
  });

  it("rejects invalid inputs without throwing", () => {
    expect(matchResultConclusion({ id: "result:bad" }, { expression: "p" })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-result" }],
    });
    expect(matchResultConclusion(modusPonens, { expression: undefined })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-proposition" }],
    });
    expect(matchResultConclusion(modusPonens, "p")).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-proposition" }],
    });
  });
});

describe("result application invariants", () => {
  /**
   * The pattern binds `n` under `Every`, and random terms mention the context
   * symbol `n`, so instantiation regularly has to rename the pattern binder.
   */
  const generic = {
    id: "result:generic",
    parameters: [prop("s"), nat("a"), nat("b")],
    premises: [{ expression: ["Less", "b", "a"] }, { expression: "s" }],
    conclusion: {
      expression: [
        "And",
        ["Implies", "s", ["Less", "a", "b"]],
        ["Every", "n", ["Or", "s", ["LessEqual", "n", "a"]]],
      ],
    },
    directions: ["backward", "forward"],
  } as unknown as KernelResult;
  const invariantEnvironment: KernelEnvironment = { operators, results: [generic] };

  const natTerm: fc.Arbitrary<PlainMathJson> = fc.letrec<{ term: PlainMathJson }>((tie) => ({
    term: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      fc.constantFrom<PlainMathJson>("x", "y", "z", "n", 0, 3),
      fc
        .tuple(tie("term"), tie("term"))
        .map(([left, right]): PlainMathJson => ["Add", left, right]),
    ),
  })).term;
  const propTerm: fc.Arbitrary<PlainMathJson> = fc.oneof(
    fc.constantFrom<PlainMathJson>("p", "q", "r", "True"),
    fc.tuple(natTerm, natTerm).map(([left, right]): PlainMathJson => ["Less", left, right]),
    fc
      .tuple(natTerm, natTerm)
      .map(([left, right]): PlainMathJson => ["Not", ["Equal", left, right]]),
    natTerm.map((term): PlainMathJson => ["Every", "n", ["Less", "n", term]]),
    fc.constantFrom<PlainMathJson>("x", "n").map((bound): PlainMathJson => ["Q", bound]),
  );

  it("backward application succeeds on the instantiation computed by matching", () => {
    fc.assert(
      fc.property(propTerm, natTerm, natTerm, (s, a, b) => {
        const substituted = substituteMathJson(
          generic.conclusion.expression,
          [
            { symbol: "s", replacement: s },
            { symbol: "a", replacement: a },
            { symbol: "b", replacement: b },
          ],
          { operators },
        );
        expect(substituted.ok).toBe(true);
        const conclusion = substituted.expression;
        const match = matchResultConclusion(generic, { expression: conclusion }, { operators });
        expect(match.ok).toBe(true);
        if (!match.ok) return;
        expect(match.unboundParameters).toEqual([]);
        for (const [symbol, term] of [
          ["s", s],
          ["a", a],
          ["b", b],
        ] as const) {
          expect(
            alphaEquivalent(match.instantiation[symbol] as PlainMathJson, term, { operators }),
          ).toBe(true);
        }

        const input = goalState(conclusion);
        const result = applyTransition(
          input,
          backward("result:generic", match.instantiation, ["goal:premise-0", "goal:premise-1"]),
          invariantEnvironment,
        );
        expect(result).toMatchObject({
          ok: true,
          transitionClass: "strengthening",
          evidence: "library-result",
          resultId: "result:generic",
        });
        if (!result.ok) return;
        expect(result.state.goals.map(({ id }) => id)).toEqual([
          "goal:premise-0",
          "goal:premise-1",
        ]);
        result.state.goals.forEach((goal) =>
          expect(goal.sequent.context).toEqual(input.goals[0]?.sequent.context),
        );
        expect(result.state.goals[1]?.sequent.conclusion.expression).toEqual(s);
      }),
      { numRuns: 200 },
    );
  });

  it("forward application with every premise unmet adds the conclusion and one obligation each", () => {
    fc.assert(
      fc.property(propTerm, natTerm, natTerm, (s, a, b) => {
        const input = goalState("r");
        const result = applyTransition(
          input,
          forward("result:generic", { s, a, b }, [null, null], ["o:1", "o:2"]),
          invariantEnvironment,
        );
        expect(result).toMatchObject({ ok: true, transitionClass: "equivalence" });
        if (!result.ok) return;
        const goal = result.state.goals[0];
        expect(goal?.sequent.conclusion.expression).toBe("r");
        expect(goal?.sequent.context.hypotheses).toHaveLength(1);
        expect(result.state.obligations.map(({ id }) => id)).toEqual(["o:1", "o:2"]);
        result.state.obligations.forEach((obligation) =>
          expect(obligation.sequent.context).toEqual(input.goals[0]?.sequent.context),
        );
      }),
      { numRuns: 100 },
    );
  });
});
