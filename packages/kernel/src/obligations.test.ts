import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
  freeSymbolNames,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  TRANSITION_EVIDENCE_KINDS,
  applyTransition,
  kernelOperationSchema,
  sorryClosure,
  type KernelEnvironment,
  type KernelResult,
} from "./index";

const realSort = { kind: "named", id: "sort:real" } as const;
const realToProp = {
  kind: "function",
  signature: { parameters: [realSort], result: PROPOSITION_SORT },
} as const;

type Fact = Readonly<{ id: string; expression: PlainMathJson }>;
type DeclarationInput = Readonly<{
  symbol: string;
  sort: unknown;
  role?: "universal-parameter" | "local-witness";
}>;

function declarations(entries: readonly DeclarationInput[]) {
  return entries.map(({ symbol, sort, role }, index) => ({
    id: `declaration:${index}`,
    symbol,
    sort,
    role: role ?? "universal-parameter",
  }));
}

const reals = (...symbols: readonly string[]): readonly DeclarationInput[] =>
  symbols.map((symbol) => ({ symbol, sort: realSort }));

function sequent(
  conclusion: PlainMathJson,
  hypotheses: readonly Fact[] = [],
  localDeclarations: readonly unknown[] = declarations(reals("x", "y", "z", "w")),
) {
  return {
    context: {
      declarations: localDeclarations,
      hypotheses: hypotheses.map(({ id, expression }) => ({ id, statement: { expression } })),
    },
    conclusion: { expression: conclusion },
  };
}

function parse(value: unknown): ExecutableProofState {
  return executableProofStateSchema.parse(value);
}

function goalState(goalSequent: unknown, extra: Readonly<Record<string, unknown>> = {}) {
  return parse({
    id: "state:before",
    goals: [{ id: "goal:0", sequent: goalSequent }],
    obligations: [],
    ...extra,
  });
}

const base = { expectedStateId: "state:before", resultStateId: "state:after" } as const;
const goal0 = { kind: "goal", id: "goal:0" } as const;

function markSorry(
  input: ExecutableProofState,
  target: Readonly<{ kind: "goal" | "obligation"; id: string }> = goal0,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return applyTransition(input, {
    ...base,
    kind: "mark-sorry",
    target,
    assumptionId: "assumption:sorry",
    ...extra,
  });
}

describe("mark-sorry closures", () => {
  it("builds golden dependency-restricted universal closures", () => {
    const cases: readonly Readonly<{
      name: string;
      sequent: ReturnType<typeof sequent>;
      statement: PlainMathJson;
      declarations: readonly string[];
    }>[] = [
      {
        name: "one relevant hypothesis, no And",
        sequent: sequent(
          ["Greater", "x", 0],
          [
            { id: "hypothesis:x", expression: ["Greater", "x", 1] },
            { id: "hypothesis:y", expression: ["Greater", "y", 0] },
          ],
        ),
        statement: ["ForAll", "x", ["Implies", ["Greater", "x", 1], ["Greater", "x", 0]]],
        declarations: ["x"],
      },
      {
        name: "transitive chain in declaration order, unrelated hypothesis dropped",
        sequent: sequent(
          ["Less", "x", "z"],
          [
            { id: "hypothesis:yz", expression: ["Less", "y", "z"] },
            { id: "hypothesis:w", expression: ["Greater", "w", 0] },
            { id: "hypothesis:xy", expression: ["Less", "x", "y"] },
            { id: "hypothesis:closed", expression: ["Less", 0, 1] },
          ],
        ),
        statement: [
          "ForAll",
          "x",
          [
            "ForAll",
            "y",
            [
              "ForAll",
              "z",
              ["Implies", ["And", ["Less", "y", "z"], ["Less", "x", "y"]], ["Less", "x", "z"]],
            ],
          ],
        ],
        declarations: ["x", "y", "z"],
      },
      {
        name: "no hypotheses omits the implication",
        sequent: sequent(
          ["Greater", "x", 0],
          [{ id: "hypothesis:w", expression: ["Less", "w", 0] }],
        ),
        statement: ["ForAll", "x", ["Greater", "x", 0]],
        declarations: ["x"],
      },
      {
        name: "no declared symbols omits the quantifier",
        sequent: sequent(["Equal", 1, 1], [{ id: "hypothesis:x", expression: ["Less", "x", 0] }]),
        statement: ["Equal", 1, 1],
        declarations: [],
      },
      {
        name: "inner binders keep their declarations without becoming outer binders",
        sequent: sequent(["ForAll", "y", ["LessEqual", "x", ["Add", "x", ["Abs", "y"]]]]),
        statement: ["ForAll", "x", ["ForAll", "y", ["LessEqual", "x", ["Add", "x", ["Abs", "y"]]]]],
        declarations: ["x", "y"],
      },
      {
        name: "predicate symbols and local witnesses are bound too",
        sequent: sequent(
          ["P", "x"],
          [{ id: "hypothesis:x", expression: ["Greater", "x", 0] }],
          declarations([
            { symbol: "x", sort: realSort, role: "local-witness" },
            { symbol: "P", sort: realToProp },
          ]),
        ),
        statement: ["ForAll", "x", ["ForAll", "P", ["Implies", ["Greater", "x", 0], ["P", "x"]]]],
        declarations: ["x", "P"],
      },
    ];

    for (const entry of cases) {
      const result = markSorry(goalState(entry.sequent));
      expect(result.ok, entry.name).toBe(true);
      if (!result.ok) continue;
      expect(result.transitionClass).toBe("equivalence");
      expect(result.evidence).toBe("sorry");
      expect(result.state.goals).toEqual([]);
      const [assumption] = result.state.assumptions ?? [];
      expect(assumption?.statement.expression, entry.name).toEqual(entry.statement);
      expect(assumption?.declarations.map(({ symbol }) => symbol)).toEqual(entry.declarations);
    }
  });

  it("records the sorry origin contract for goals and obligations", () => {
    const input = parse({
      id: "state:before",
      goals: [{ id: "goal:0", sequent: sequent(["Greater", "x", 0]) }],
      obligations: [
        { id: "obligation:0", sequent: sequent(["Less", "y", 0]), provenance: { kind: "user" } },
      ],
      assumptions: [],
    });
    const fromGoal = markSorry(input, goal0, { sorryId: "sorry:external-1" });
    expect(fromGoal).toMatchObject({ ok: true, evidence: "sorry" });
    expect(fromGoal.state.assumptions?.[0]?.origin).toEqual({
      kind: "sorry",
      sourceTarget: { kind: "goal", id: "goal:0" },
      sorryId: "sorry:external-1",
    });
    expect(fromGoal.state.obligations).toEqual(input.obligations);

    const fromObligation = markSorry(input, { kind: "obligation", id: "obligation:0" });
    expect(fromObligation.state.obligations).toEqual([]);
    expect(fromObligation.state.goals).toEqual(input.goals);
    expect(fromObligation.state.assumptions?.[0]?.origin).toEqual({
      kind: "sorry",
      sourceTarget: { kind: "obligation", id: "obligation:0" },
    });
    expect(TRANSITION_EVIDENCE_KINDS).toContain("sorry");
  });

  it("rejects construction metavariables in the dependency set and stale inputs", () => {
    const withConstruction = goalState(
      sequent(
        ["Greater", "x", "c"],
        [],
        [
          ...declarations(reals("x")),
          {
            id: "declaration:c",
            symbol: "c",
            sort: realSort,
            role: "construction-metavariable",
            resolution: { status: "resolved", value: 1 },
          },
        ],
      ),
    );
    const rejected = markSorry(withConstruction);
    expect(rejected).toMatchObject({
      ok: false,
      diagnostics: [{ code: "construction-metavariable-dependency" }],
    });
    expect(rejected.state).toBe(withConstruction);

    const once = markSorry(goalState(sequent(["Greater", "x", 0])));
    expect(once.ok).toBe(true);
    const twice = parse({
      ...once.state,
      id: "state:before",
      goals: [{ id: "goal:1", sequent: sequent(["Greater", "y", 0]) }],
    });
    expect(markSorry(twice, { kind: "goal", id: "goal:1" })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "identifier-collision" }],
    });
    expect(
      kernelOperationSchema.safeParse({
        ...base,
        kind: "mark-sorry",
        target: goal0,
        assumptionId: "assumption:a",
        sorryId: "",
      }).success,
    ).toBe(false);
  });

  const variables = ["v0", "v1", "v2", "v3", "v4", "v5"] as const;
  const variableSet = fc.subarray([...variables]);
  const atom = (symbols: readonly string[]): PlainMathJson => {
    if (symbols.length === 0) return ["Less", 0, 1];
    const parts: PlainMathJson[] = symbols.map((symbol) => ["Less", symbol, 0]);
    return parts.length === 1 ? (parts[0] as PlainMathJson) : ["And", ...parts];
  };
  const contexts = fc.record({
    goal: variableSet,
    hypotheses: fc.array(variableSet, { maxLength: 7 }),
  });

  it("produces closed closures that are minimal under the dependency rule", () => {
    fc.assert(
      fc.property(contexts, ({ goal, hypotheses }) => {
        const facts = hypotheses.map((symbols, index) => ({
          id: `hypothesis:${index}`,
          expression: atom(symbols),
        }));
        const input = goalState(sequent(atom(goal), facts, declarations(reals(...variables))));
        const target = input.goals[0];
        if (target === undefined) return;
        const result = sorryClosure(target.sequent, []);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const { closure } = result;

        // Closed: no free symbols besides built-in operators.
        expect(freeSymbolNames(closure.statement)).toEqual([]);

        // Independent reachability from G's variables through shared variables.
        const reached = new Set<string>(goal);
        const reachedHypotheses = new Set<number>();
        for (let grew = true; grew;) {
          grew = false;
          hypotheses.forEach((symbols, index) => {
            if (reachedHypotheses.has(index) || !symbols.some((symbol) => reached.has(symbol))) {
              return;
            }
            reachedHypotheses.add(index);
            symbols.forEach((symbol) => reached.add(symbol));
            grew = true;
          });
        }
        expect(closure.binders).toEqual(variables.filter((symbol) => reached.has(symbol)));
        expect(closure.hypothesisIds).toEqual(
          facts.filter((_fact, index) => reachedHypotheses.has(index)).map(({ id }) => id),
        );
        const binders = new Set(closure.binders);
        hypotheses.forEach((symbols, index) => {
          if (reachedHypotheses.has(index)) {
            expect(symbols.some((symbol) => binders.has(symbol))).toBe(true);
            expect(symbols.every((symbol) => binders.has(symbol))).toBe(true);
          } else {
            expect(symbols.some((symbol) => binders.has(symbol))).toBe(false);
          }
        });

        // The kernel accepts the closure as a valid, closed additional assumption and a
        // sibling goal of the same shape closes by its identity instance.
        const withSibling = parse({
          ...input,
          goals: [...input.goals, { id: "goal:sibling", sequent: target.sequent }],
        });
        const marked = markSorry(withSibling);
        expect(marked.ok).toBe(true);
        const closed = applyTransition(parse({ ...marked.state, id: "state:marked" }), {
          expectedStateId: "state:marked",
          resultStateId: "state:closed",
          kind: "close-by-assumption",
          target: { kind: "goal", id: "goal:sibling" },
          assumptionId: "assumption:sorry",
          instantiation: Object.fromEntries(closure.binders.map((symbol) => [symbol, symbol])),
        });
        expect(closed).toMatchObject({
          ok: true,
          transitionClass: "equivalence",
          evidence: "structural",
          state: { goals: [] },
        });
      }),
      { numRuns: 60 },
    );
  });
});

describe("close-by-assumption", () => {
  const shape = (a: string, b: string) =>
    sequent(
      ["Less", a, ["Add", b, 1]],
      [{ id: `hypothesis:${a}${b}`, expression: ["Less", a, b] }],
      declarations(reals(a, b)),
    );

  function roundTripState(): ExecutableProofState {
    const input = parse({
      id: "state:before",
      goals: [
        { id: "goal:0", sequent: shape("x", "y") },
        { id: "goal:1", sequent: shape("u", "t") },
      ],
      obligations: [],
    });
    const marked = markSorry(input);
    expect(marked.ok).toBe(true);
    return parse({ ...marked.state, id: "state:marked" });
  }

  const closeSibling = (instantiation: unknown, state = roundTripState()) =>
    applyTransition(state, {
      expectedStateId: "state:marked",
      resultStateId: "state:closed",
      kind: "close-by-assumption",
      target: { kind: "goal", id: "goal:1" },
      assumptionId: "assumption:sorry",
      instantiation,
    });

  it("closes a sibling goal of the same shape after mark-sorry", () => {
    const state = roundTripState();
    expect(state.assumptions?.[0]?.statement.expression).toEqual([
      "ForAll",
      "x",
      ["ForAll", "y", ["Implies", ["Less", "x", "y"], ["Less", "x", ["Add", "y", 1]]]],
    ]);
    const closed = closeSibling({ x: "u", y: "t" }, state);
    expect(closed).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      evidence: "structural",
      state: { id: "state:closed", goals: [] },
    });
    expect(closed.state.assumptions).toEqual(state.assumptions);
  });

  it("rejects wrong instantiations, missing antecedents, and mismatched conclusions", () => {
    expect(closeSibling({ y: "t" })).toMatchObject({
      diagnostics: [{ code: "invalid-instantiation" }],
    });
    expect(closeSibling({ x: "u", y: "t", z: "u" })).toMatchObject({
      diagnostics: [{ code: "invalid-instantiation" }],
    });
    expect(closeSibling({ x: "undeclared", y: "t" })).toMatchObject({
      diagnostics: [{ code: "invalid-instantiation" }],
    });
    expect(closeSibling({ x: "t", y: "u" })).toMatchObject({
      diagnostics: [{ code: "conclusion-mismatch" }],
    });
    // Instantiating only x leaves a universal whose body cannot match the conclusion.
    expect(closeSibling({ x: "u" })).toMatchObject({
      diagnostics: [{ code: "conclusion-mismatch" }],
    });

    const withoutAntecedent = parse({
      ...roundTripState(),
      goals: [
        {
          id: "goal:1",
          sequent: sequent(["Less", "u", ["Add", "t", 1]], [], declarations(reals("u", "t"))),
        },
      ],
    });
    expect(closeSibling({ x: "u", y: "t" }, withoutAntecedent)).toMatchObject({
      diagnostics: [{ code: "premise-mismatch" }],
    });

    const unknown = applyTransition(roundTripState(), {
      expectedStateId: "state:marked",
      resultStateId: "state:closed",
      kind: "close-by-assumption",
      target: { kind: "goal", id: "goal:1" },
      assumptionId: "assumption:missing",
      instantiation: {},
    });
    expect(unknown).toMatchObject({ diagnostics: [{ code: "assumption-not-found" }] });
  });

  it("accepts conjunctive antecedents hypothesis by hypothesis", () => {
    const chain = (a: string, b: string, c: string) =>
      sequent(
        ["Less", a, c],
        [
          { id: "hypothesis:ab", expression: ["Less", a, b] },
          { id: "hypothesis:bc", expression: ["Less", b, c] },
        ],
        declarations(reals(a, b, c)),
      );
    const marked = markSorry(
      parse({
        id: "state:before",
        goals: [
          { id: "goal:0", sequent: chain("x", "y", "z") },
          { id: "goal:1", sequent: chain("u", "t", "s") },
        ],
        obligations: [],
      }),
    );
    expect(marked.ok).toBe(true);
    expect(
      closeSibling({ x: "u", y: "t", z: "s" }, parse({ ...marked.state, id: "state:marked" })),
    ).toMatchObject({ ok: true, state: { goals: [] } });
  });
});

describe("obligations as targets", () => {
  const facts: readonly Fact[] = [
    { id: "hypothesis:p", expression: "p" },
    { id: "hypothesis:not-p", expression: ["Not", "p"] },
    { id: "hypothesis:false", expression: "False" },
  ];
  const propositions = declarations(
    ["p", "q"].map((symbol) => ({ symbol, sort: PROPOSITION_SORT })),
  );
  const obligationState = (
    conclusion: PlainMathJson,
    extra: Readonly<Record<string, unknown>> = {},
  ) =>
    parse({
      id: "state:before",
      goals: [{ id: "goal:0", sequent: sequent("q", [], propositions) }],
      obligations: [
        {
          id: "obligation:0",
          sequent: sequent(conclusion, facts, propositions),
          provenance: { kind: "premise-of-result", resultId: "result:earlier" },
        },
      ],
      ...extra,
    });
  const obligation = { kind: "obligation", id: "obligation:0" } as const;
  const environment: KernelEnvironment = {
    results: [
      {
        id: "result:truth",
        parameters: [],
        premises: [],
        conclusion: { expression: "True" },
        directions: ["backward"],
      } as unknown as KernelResult,
    ],
  };
  const sorryAssumption = {
    id: "assumption:q",
    declarations: propositions.slice(1),
    statement: { expression: ["ForAll", "q", "q"] },
    origin: { kind: "sorry", sourceTarget: { kind: "goal", id: "goal:old" } },
  };

  it("discharges an obligation with every closer", () => {
    const cases: readonly Readonly<{
      conclusion: PlainMathJson;
      operation: Readonly<Record<string, unknown>>;
      extra?: Readonly<Record<string, unknown>>;
    }>[] = [
      { conclusion: "p", operation: { kind: "close-by-hypothesis", hypothesisId: "hypothesis:p" } },
      { conclusion: "True", operation: { kind: "close-true" } },
      {
        conclusion: "q",
        operation: { kind: "close-false-hypothesis", hypothesisId: "hypothesis:false" },
      },
      { conclusion: ["Equal", 1, 1], operation: { kind: "close-reflexive-equality" } },
      {
        conclusion: "q",
        operation: {
          kind: "close-by-contradiction",
          hypothesisId: "hypothesis:p",
          negationHypothesisId: "hypothesis:not-p",
        },
      },
      {
        conclusion: "q",
        operation: { kind: "close-by-accepted-inference", attestationId: "attestation:1" },
      },
      {
        conclusion: "True",
        operation: {
          kind: "apply-result-backward",
          resultId: "result:truth",
          instantiation: {},
          premiseTargetIds: [],
        },
      },
      {
        conclusion: "q",
        operation: {
          kind: "close-by-assumption",
          assumptionId: "assumption:q",
          instantiation: { q: "q" },
        },
        extra: { assumptions: [sorryAssumption] },
      },
    ];
    for (const { conclusion, operation, extra } of cases) {
      const input = obligationState(conclusion, extra);
      const result = applyTransition(
        input,
        { ...base, target: obligation, ...operation },
        environment,
      );
      expect(result.ok, String(operation.kind)).toBe(true);
      expect(result.state.obligations).toEqual([]);
      expect(result.state.goals).toEqual(input.goals);
      expect(result.state.assumptions).toEqual(input.assumptions);
    }
  });
});

describe("obligation provenance", () => {
  const props = declarations(["p", "q", "r"].map((symbol) => ({ symbol, sort: PROPOSITION_SORT })));
  const ctx = (conclusion: PlainMathJson, hypotheses: readonly Fact[] = []) =>
    sequent(conclusion, hypotheses, props);
  const modusPonens = {
    id: "result:mp",
    parameters: [
      { symbol: "a", sort: PROPOSITION_SORT },
      { symbol: "b", sort: PROPOSITION_SORT },
    ],
    premises: [{ expression: "a" }, { expression: ["Implies", "a", "b"] }],
    conclusion: { expression: "b" },
    directions: ["forward", "backward"],
  } as unknown as KernelResult;
  const environment: KernelEnvironment = { results: [modusPonens] };
  const disjunction: Fact = { id: "hypothesis:or", expression: ["Or", "p", "q"] };
  const input = (conclusion: PlainMathJson) =>
    parse({
      id: "state:before",
      goals: [{ id: "goal:0", sequent: ctx(conclusion, [disjunction]) }],
      obligations: [
        {
          id: "obligation:0",
          sequent: ctx(conclusion, [disjunction]),
          provenance: { kind: "side-condition", resultId: "result:x", sideConditionId: "side:1" },
        },
      ],
    });
  const provenances = (state: ExecutableProofState) =>
    state.obligations.map(({ id, provenance }) => ({ id, provenance }));
  const obligation = { kind: "obligation", id: "obligation:0" } as const;

  it("labels suffices and result-premise obligations", () => {
    const suffices = applyTransition(input("r"), {
      ...base,
      target: goal0,
      kind: "suffices",
      proposition: "p",
      obligationId: "obligation:suffices",
    });
    expect(provenances(suffices.state)).toEqual([
      {
        id: "obligation:0",
        provenance: { kind: "side-condition", resultId: "result:x", sideConditionId: "side:1" },
      },
      { id: "obligation:suffices", provenance: { kind: "suffices" } },
    ]);

    const forward = applyTransition(
      input("r"),
      {
        ...base,
        target: obligation,
        kind: "apply-result-forward",
        resultId: "result:mp",
        instantiation: { a: "p", b: "q" },
        premiseHypothesisIds: [null, null],
        resultHypothesisId: "hypothesis:q",
        obligationIds: ["obligation:a", "obligation:b"],
      },
      environment,
    );
    const premise = { kind: "premise-of-result", resultId: "result:mp" };
    expect(provenances(forward.state)).toEqual([
      {
        id: "obligation:0",
        provenance: { kind: "side-condition", resultId: "result:x", sideConditionId: "side:1" },
      },
      { id: "obligation:a", provenance: premise },
      { id: "obligation:b", provenance: premise },
    ]);

    const backward = (target: typeof goal0 | typeof obligation) =>
      applyTransition(
        input("r"),
        {
          ...base,
          target,
          kind: "apply-result-backward",
          resultId: "result:mp",
          instantiation: { a: "p", b: "r" },
          premiseTargetIds: ["premise:a", "premise:b"],
        },
        environment,
      );
    expect(provenances(backward(obligation).state)).toEqual([
      { id: "premise:a", provenance: premise },
      { id: "premise:b", provenance: premise },
    ]);
    const onGoal = backward(goal0).state;
    expect(onGoal.goals.map((entry) => Object.keys(entry).sort())).toEqual([
      ["id", "sequent"],
      ["id", "sequent"],
    ]);
  });

  it("labels case splits of an obligation and inherits provenance for conjunct splits", () => {
    const classical = applyTransition(input("r"), {
      ...base,
      target: obligation,
      kind: "split-classical-cases",
      proposition: "p",
      childIds: ["case:p", "case:not-p"],
      branchHypothesisIds: ["hypothesis:p", "hypothesis:not-p"],
    });
    expect(provenances(classical.state)).toEqual([
      { id: "case:p", provenance: { kind: "case" } },
      { id: "case:not-p", provenance: { kind: "case" } },
    ]);
    const disjunctive = applyTransition(input("r"), {
      ...base,
      target: obligation,
      kind: "split-hypothesis-disjunction",
      hypothesisId: "hypothesis:or",
      childIds: ["case:p", "case:q"],
      branchHypothesisIds: ["hypothesis:p", "hypothesis:q"],
    });
    expect(provenances(disjunctive.state).map(({ provenance }) => provenance)).toEqual([
      { kind: "case" },
      { kind: "case" },
    ]);
    const onGoal = applyTransition(input("r"), {
      ...base,
      target: goal0,
      kind: "split-classical-cases",
      proposition: "p",
      childIds: ["case:p", "case:not-p"],
      branchHypothesisIds: ["hypothesis:p", "hypothesis:not-p"],
    });
    expect(onGoal.ok).toBe(true);
    expect(onGoal.state.goals.every((entry) => !("provenance" in entry))).toBe(true);

    const conjunction = applyTransition(input(["And", "p", "q"]), {
      ...base,
      target: obligation,
      kind: "split-goal-conjunction",
      childIds: ["part:p", "part:q"],
    });
    const inherited = { kind: "side-condition", resultId: "result:x", sideConditionId: "side:1" };
    expect(provenances(conjunction.state)).toEqual([
      { id: "part:p", provenance: inherited },
      { id: "part:q", provenance: inherited },
    ]);
  });

  /**
   * Invariant: for random sequences of applicable operations, every existing additional
   * assumption survives unchanged and in order, and every obligation a step does not target
   * survives with its provenance.
   */
  it("preserves assumptions and untouched obligations' provenance across transitions", () => {
    const hypotheses: readonly Fact[] = [
      { id: "h:p", expression: "p" },
      { id: "h:and", expression: ["And", "p", "q"] },
      { id: "h:or", expression: ["Or", "p", "q"] },
      { id: "h:imp", expression: ["Implies", "p", "r"] },
      { id: "h:eqv", expression: ["Equivalent", "q", "r"] },
    ];
    const conclusions: readonly PlainMathJson[] = [
      "p",
      ["And", "p", "r"],
      ["Implies", "q", "r"],
      ["Or", "q", "r"],
      "r",
      ["Not", "q"],
    ];
    const provenanceChoices = [
      { kind: "user" },
      { kind: "case" },
      { kind: "suffices" },
      { kind: "premise-of-result", resultId: "result:mp" },
      undefined,
    ] as const;
    const initialAssumption = {
      id: "assumption:initial",
      declarations: props.slice(0, 1),
      statement: { expression: ["ForAll", "p", ["Or", "p", ["Not", "p"]]] },
      origin: { kind: "sorry", sourceTarget: { kind: "goal", id: "goal:earlier" } },
    };
    const initial = parse({
      id: "state:0",
      goals: conclusions.map((conclusion, index) => ({
        id: `goal:${index}`,
        sequent: ctx(conclusion, hypotheses),
      })),
      obligations: conclusions.map((conclusion, index) => {
        const provenance = provenanceChoices[index];
        return {
          id: `obligation:${index}`,
          sequent: ctx(conclusion, hypotheses),
          ...(provenance === undefined ? {} : { provenance }),
        };
      }),
      assumptions: [initialAssumption],
    });

    const templates = (fresh: string): readonly Readonly<Record<string, unknown>>[] => [
      { kind: "close-by-hypothesis", hypothesisId: "h:p" },
      { kind: "close-by-accepted-inference", attestationId: "attestation:x" },
      { kind: "introduce-implication", hypothesisId: `${fresh}:h` },
      { kind: "introduce-negation", hypothesisId: `${fresh}:h` },
      { kind: "split-goal-conjunction", childIds: [`${fresh}:a`, `${fresh}:b`] },
      { kind: "choose-goal-disjunct", disjunctIndex: 0 },
      {
        kind: "expand-hypothesis-conjunction",
        hypothesisId: "h:and",
        expandedHypothesisIds: [`${fresh}:a`, `${fresh}:b`],
      },
      {
        kind: "split-hypothesis-disjunction",
        hypothesisId: "h:or",
        childIds: [`${fresh}:a`, `${fresh}:b`],
        branchHypothesisIds: [`${fresh}:c`, `${fresh}:d`],
      },
      {
        kind: "split-classical-cases",
        proposition: "q",
        childIds: [`${fresh}:a`, `${fresh}:b`],
        branchHypothesisIds: [`${fresh}:c`, `${fresh}:d`],
      },
      { kind: "assume-hypothesis", proposition: "q", hypothesisId: `${fresh}:h` },
      { kind: "replace-goal", proposition: "q" },
      { kind: "suffices", proposition: "q", obligationId: `${fresh}:o` },
      { kind: "drop-hypothesis", hypothesisId: "h:and" },
      {
        kind: "apply-implication-hypothesis",
        implicationHypothesisId: "h:imp",
        antecedentHypothesisId: "h:p",
        resultHypothesisId: `${fresh}:h`,
      },
      {
        kind: "rewrite-with-equivalence",
        statement: { kind: "conclusion" },
        path: [],
        source: { kind: "hypothesis", hypothesisId: "h:eqv" },
        direction: "backward",
      },
      {
        kind: "apply-result-forward",
        resultId: "result:mp",
        instantiation: { a: "p", b: "r" },
        premiseHypothesisIds: ["h:p", null],
        resultHypothesisId: `${fresh}:h`,
        obligationIds: [`${fresh}:o`],
      },
      {
        kind: "apply-result-backward",
        resultId: "result:mp",
        instantiation: { a: "p", b: "r" },
        premiseTargetIds: [`${fresh}:a`, `${fresh}:b`],
      },
      { kind: "mark-sorry", assumptionId: `${fresh}:sorry` },
    ];
    const templateCount = templates("x").length;
    const appliedKinds = new Set<unknown>();
    // Some templates apply to only one initial target (e.g. choose-goal-disjunct needs `q ∨ r`),
    // so seed every template × initial target as a single-step example. Examples count toward
    // numRuns, so 150 random runs are added on top.
    type Step = { template: number; obligationTarget: boolean; index: number };
    const examples: [Step[]][] = Array.from({ length: templateCount }, (_, template) =>
      [false, true].flatMap((obligationTarget) =>
        conclusions.map((_conclusion, index): [Step[]] => [
          [{ template, obligationTarget, index }],
        ]),
      ),
    ).flat();

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            template: fc.nat({ max: templateCount - 1 }),
            obligationTarget: fc.boolean(),
            index: fc.nat({ max: 7 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (steps) => {
          let current = initial;
          steps.forEach((step, stepIndex) => {
            const collection = step.obligationTarget ? current.obligations : current.goals;
            const entry = collection[step.index % Math.max(collection.length, 1)];
            if (entry === undefined) return;
            const fresh = `step${stepIndex}`;
            const template = templates(fresh)[step.template] as Readonly<Record<string, unknown>>;
            const operation = {
              ...template,
              expectedStateId: current.id,
              resultStateId: `state:${stepIndex + 1}`,
              target: { kind: step.obligationTarget ? "obligation" : "goal", id: entry.id },
            };
            const result = applyTransition(current, operation, environment);
            if (!result.ok) {
              expect(result.state).toBe(current);
              return;
            }
            appliedKinds.add(template.kind);
            const before = current.assumptions ?? [];
            const after = result.state.assumptions ?? [];
            expect(after.slice(0, before.length)).toEqual(before);
            expect(after.length).toBe(before.length + (template.kind === "mark-sorry" ? 1 : 0));
            const afterById = new Map(result.state.obligations.map((item) => [item.id, item]));
            current.obligations.forEach((untouched) => {
              if (step.obligationTarget && untouched.id === entry.id) return;
              expect(afterById.get(untouched.id)).toEqual(untouched);
            });
            if (step.obligationTarget) {
              const replaced = afterById.get(entry.id);
              if (replaced !== undefined) {
                expect(replaced.provenance).toEqual(
                  (entry as (typeof current.obligations)[number]).provenance,
                );
              }
            }
            current = result.state;
          });
        },
      ),
      { numRuns: examples.length + 150, examples },
    );
    // Every template must actually have been exercised by some successful step.
    expect([...appliedKinds].sort()).toEqual(
      [...new Set(templates("x").map((template) => template.kind))].sort(),
    );
  });
});
