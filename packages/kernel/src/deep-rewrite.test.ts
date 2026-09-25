import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
  mathJsonEquals,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { locateRewriteOccurrence } from "./deep-rewrite";
import { applyTransition, kernelOperationSchema, type KernelEnvironment } from "./index";

/*
 * Deep, polarity-aware rewriting. The semantic properties interpret a
 * contextual sequent as `∧hypotheses ⇒ conclusion` over Boolean valuations of
 * p, q, r (quantifiers range over Booleans) and check each transition class
 * claim by brute-force truth tables:
 *   equivalence:   T(v) ⇔ S(v) for every valuation v where the source holds;
 *   strengthening: T(v) ⇒ S(v) for every valuation v where the source holds.
 * A hypothesis source is part of both sequents; a result source is treated as
 * an axiom, so only valuations satisfying its instance are considered.
 */

const ATOMS = ["p", "q", "r"] as const;
const realSort = { kind: "named", id: "sort:real" } as const;

const propositionDeclarations = ATOMS.map((symbol, index) => ({
  id: `declaration:${index}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
}));

type Hypotheses = readonly Readonly<{ id: string; expression: PlainMathJson }>[];

function state(
  conclusion: PlainMathJson,
  hypotheses: Hypotheses = [],
  declarations: readonly unknown[] = propositionDeclarations,
): ExecutableProofState {
  return executableProofStateSchema.parse({
    id: "state:before",
    goals: [
      {
        id: "goal:0",
        sequent: {
          context: {
            declarations,
            hypotheses: hypotheses.map(({ id, expression }) => ({ id, statement: { expression } })),
          },
          conclusion: { expression: conclusion },
        },
      },
    ],
    obligations: [],
  });
}

const base = {
  expectedStateId: "state:before",
  resultStateId: "state:after",
  target: { kind: "goal", id: "goal:0" },
} as const;

const hypothesisSource = { kind: "hypothesis", hypothesisId: "hypothesis:source" } as const;

// ---------------------------------------------------------------------------
// Reference semantics
// ---------------------------------------------------------------------------

type Valuation = Readonly<Record<string, boolean>>;

function head(expression: PlainMathJson): string | undefined {
  return Array.isArray(expression) && typeof expression[0] === "string" ? expression[0] : undefined;
}

function operands(expression: PlainMathJson): readonly PlainMathJson[] {
  return Array.isArray(expression) ? (expression.slice(1) as readonly PlainMathJson[]) : [];
}

function evaluate(expression: PlainMathJson, valuation: Valuation): boolean {
  if (typeof expression === "string") {
    if (expression === "True") return true;
    if (expression === "False") return false;
    const value = valuation[expression];
    if (value === undefined) throw new Error(`Unbound symbol ${expression}.`);
    return value;
  }
  const args = operands(expression);
  const at = (index: number): boolean => evaluate(args[index] as PlainMathJson, valuation);
  switch (head(expression)) {
    case "Not":
      return !at(0);
    case "And":
      return args.every((_arg, index) => at(index));
    case "Or":
      return args.some((_arg, index) => at(index));
    case "Implies":
      return !at(0) || at(1);
    case "Equivalent":
    case "Equal":
      return at(0) === at(1);
    case "ForAll":
    case "Exists": {
      const symbol = args[0] as string;
      const values = [true, false].map((value) =>
        evaluate(args[1] as PlainMathJson, { ...valuation, [symbol]: value }),
      );
      return head(expression) === "ForAll" ? values.every(Boolean) : values.some(Boolean);
    }
  }
  throw new Error(`Cannot evaluate ${JSON.stringify(expression)}.`);
}

const VALUATIONS: readonly Valuation[] = Array.from(
  { length: 2 ** ATOMS.length },
  (_unused, bits) =>
    Object.fromEntries(ATOMS.map((symbol, index) => [symbol, Boolean(bits & (1 << index))])),
);

function sequentHolds(input: ExecutableProofState, valuation: Valuation): boolean {
  return input.goals.every(({ sequent }) => {
    const assumptions = sequent.context.hypotheses.every(({ statement }) =>
      evaluate(statement.expression, valuation),
    );
    return !assumptions || evaluate(sequent.conclusion.expression, valuation);
  });
}

function checkClass(
  before: ExecutableProofState,
  after: ExecutableProofState,
  transitionClass: string,
  axiom: PlainMathJson | undefined,
): boolean {
  return VALUATIONS.every((valuation) => {
    if (axiom !== undefined && !evaluate(axiom, valuation)) return true;
    const old = sequentHolds(before, valuation);
    const next = sequentHolds(after, valuation);
    return transitionClass === "equivalence" ? old === next : !next || old;
  });
}

function freeSymbols(expression: PlainMathJson, bound: ReadonlySet<string> = new Set()): string[] {
  if (typeof expression === "string") {
    return ATOMS.includes(expression as (typeof ATOMS)[number]) && !bound.has(expression)
      ? [expression]
      : [];
  }
  const args = operands(expression);
  if (head(expression) === "ForAll" || head(expression) === "Exists") {
    return freeSymbols(args[1] as PlainMathJson, new Set([...bound, args[0] as string]));
  }
  return args.flatMap((arg) => freeSymbols(arg, bound));
}

type Polarity = "positive" | "negative" | "mixed" | "neutral";

/** Independent recursive statement of design plan §7.1 over overall polarity. */
function referencePosition(
  expression: PlainMathJson,
  path: readonly number[],
  basePolarity: Polarity,
): Readonly<{ polarity: Polarity; role: "proposition" | "term" | "binder"; bound: Set<string> }> {
  const flip = (polarity: Polarity): Polarity =>
    polarity === "positive" ? "negative" : polarity === "negative" ? "positive" : polarity;
  let polarity = basePolarity;
  let role: "proposition" | "term" | "binder" = "proposition";
  let current = expression;
  const bound = new Set<string>();
  for (const index of path) {
    const operator = head(current);
    const args = operands(current);
    if (operator === "Not") polarity = flip(polarity);
    else if (operator === "Implies") polarity = index === 0 ? flip(polarity) : polarity;
    else if (operator === "Equivalent") polarity = polarity === "neutral" ? polarity : "mixed";
    else if (operator === "ForAll" || operator === "Exists") {
      if (index === 0) {
        polarity = "neutral";
        role = "binder";
      } else {
        bound.add(args[0] as string);
      }
    } else if (operator === "Equal") {
      polarity = "neutral";
      role = "term";
    }
    if (operator !== "Equal" && !((operator === "ForAll" || operator === "Exists") && index === 0))
      role = "proposition";
    current = args[index] as PlainMathJson;
  }
  return { polarity, role, bound };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const atom = fc.constantFrom<PlainMathJson>("p", "q", "r", "True", "False");

/** Quantifier-free propositions, used for the non-matched side of a source. */
const quantifierFree: fc.Arbitrary<PlainMathJson> = fc.letrec<{ node: PlainMathJson }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    atom,
    fc.tuple(fc.constant("Not"), tie("node")),
    fc.tuple(fc.constant("And"), tie("node"), tie("node")),
    fc.tuple(fc.constant("Implies"), tie("node"), tie("node")),
  ) as fc.Arbitrary<PlainMathJson>,
})).node;

const formula: fc.Arbitrary<PlainMathJson> = fc.letrec<{ node: PlainMathJson }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true, maxDepth: 4 },
    atom,
    fc.tuple(fc.constant("Not"), tie("node")),
    fc
      .tuple(fc.constantFrom("And", "Or"), fc.array(tie("node"), { minLength: 2, maxLength: 4 }))
      .map(([operator, args]) => [operator, ...args]),
    fc.tuple(fc.constant("Implies"), tie("node"), tie("node")),
    fc.tuple(fc.constant("Equivalent"), tie("node"), tie("node")),
    fc.tuple(fc.constant("Equal"), tie("node"), tie("node")),
    fc.tuple(fc.constantFrom("ForAll", "Exists"), fc.constantFrom("p", "q"), tie("node")),
  ) as fc.Arbitrary<PlainMathJson>,
})).node;

type Occurrence = Readonly<{
  path: readonly number[];
  lens?: Readonly<{ startOperand: number; endOperand: number }>;
  fragment: PlainMathJson;
}>;

/** Every non-binder path, plus every proper contiguous lens of every And/Or. */
function occurrences(expression: PlainMathJson): readonly Occurrence[] {
  const found: Occurrence[] = [];
  const visit = (current: PlainMathJson, path: readonly number[]): void => {
    found.push({ path, fragment: current });
    const operator = head(current);
    const args = operands(current);
    if (operator === "And" || operator === "Or") {
      for (let start = 0; start < args.length; start += 1) {
        for (let end = start + 2; end <= args.length; end += 1) {
          if (end - start === args.length) continue;
          found.push({
            path,
            lens: { startOperand: start, endOperand: end },
            fragment: [operator, ...args.slice(start, end)],
          });
        }
      }
    }
    args.forEach((arg, index) => {
      if ((operator === "ForAll" || operator === "Exists") && index === 0) return;
      visit(arg, [...path, index]);
    });
  };
  visit(expression, []);
  return found;
}

// ---------------------------------------------------------------------------
// Polarity
// ---------------------------------------------------------------------------

describe("polarity at a path", () => {
  it("matches the reference recursive definition at every path of random formulas", () => {
    fc.assert(
      fc.property(formula, fc.constantFrom("positive", "negative"), (expression, basePolarity) => {
        for (const { path, lens } of occurrences(expression)) {
          if (lens !== undefined) continue;
          const located = locateRewriteOccurrence(
            expression,
            path,
            undefined,
            basePolarity,
            propositionDeclarations as never,
            [],
          );
          const expected = referencePosition(expression, path, basePolarity);
          expect(located).toBeDefined();
          expect({ polarity: located?.polarity, role: located?.role }).toEqual({
            polarity: expected.polarity,
            role: expected.role,
          });
          expect([...(located?.boundSymbols ?? [])].sort()).toEqual([...expected.bound].sort());
        }
      }),
      { numRuns: 200 },
    );
  });

  it("gives a lens the polarity of its covered operands", () => {
    const expression: PlainMathJson = ["Not", ["And", "p", "q", "r"]];
    const located = locateRewriteOccurrence(
      expression,
      [0],
      { startOperand: 1, endOperand: 3 },
      "positive",
      [],
      [],
    );
    expect(located).toMatchObject({ polarity: "negative", fragment: ["And", "q", "r"] });
    expect(located?.replace("p")).toEqual(["Not", ["And", "p", "p"]]);
    expect(
      locateRewriteOccurrence(
        expression,
        [0],
        { startOperand: 0, endOperand: 3 },
        "positive",
        [],
        [],
      ),
    ).toBeUndefined();
    expect(
      locateRewriteOccurrence(
        expression,
        [],
        { startOperand: 0, endOperand: 2 },
        "positive",
        [],
        [],
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Semantic truth-table properties
// ---------------------------------------------------------------------------

type RewriteKind = "rewrite-with-equivalence" | "rewrite-with-implication";

const acceptedByKind = new Map<RewriteKind, number>();

/** Try every source form around the fragment and check acceptance and the class claim. */
function checkAllSourceForms(
  conclusion: PlainMathJson,
  statementHypothesis: PlainMathJson,
  statementKind: "conclusion" | "hypothesis",
  occurrence: Occurrence,
  other: PlainMathJson,
  sourceKind: "hypothesis" | "result",
): void {
  const statementExpression = statementKind === "conclusion" ? conclusion : statementHypothesis;
  const reference = referencePosition(
    statementExpression,
    occurrence.lens === undefined
      ? occurrence.path
      : [...occurrence.path, occurrence.lens.startOperand],
    statementKind === "conclusion" ? "positive" : "negative",
  );
  const captures = [...freeSymbols(occurrence.fragment), ...freeSymbols(other)].some((symbol) =>
    reference.bound.has(symbol),
  );
  const forms: readonly (readonly [
    RewriteKind,
    PlainMathJson,
    "forward" | "backward" | undefined,
  ])[] = [
    ["rewrite-with-equivalence", ["Equivalent", occurrence.fragment, other], "forward"],
    ["rewrite-with-equivalence", ["Equivalent", other, occurrence.fragment], "backward"],
    ["rewrite-with-implication", ["Implies", other, occurrence.fragment], undefined],
    ["rewrite-with-implication", ["Implies", occurrence.fragment, other], undefined],
  ];
  for (const [kind, sourceExpression, direction] of forms) {
    const hypotheses: Hypotheses = [
      { id: "hypothesis:statement", expression: statementHypothesis },
      ...(sourceKind === "hypothesis"
        ? [{ id: "hypothesis:source", expression: sourceExpression }]
        : []),
    ];
    const input = state(conclusion, hypotheses);
    const sourceSides = operands(sourceExpression);
    const environment: KernelEnvironment =
      sourceKind === "result"
        ? {
            results: [
              {
                id: "result:source",
                parameters: [
                  { symbol: "a", sort: PROPOSITION_SORT },
                  { symbol: "b", sort: PROPOSITION_SORT },
                ],
                premises: [],
                conclusion: { expression: [head(sourceExpression) as string, "a", "b"] },
                directions: ["forward", "backward"],
              },
            ] as never,
          }
        : {};
    const source =
      sourceKind === "hypothesis"
        ? hypothesisSource
        : {
            kind: "result",
            resultId: "result:source",
            instantiation: { a: sourceSides[0], b: sourceSides[1] },
          };
    const result = applyTransition(
      input,
      {
        ...base,
        kind,
        statement:
          statementKind === "conclusion"
            ? { kind: "conclusion" }
            : { kind: "hypothesis", id: "hypothesis:statement" },
        path: occurrence.path,
        ...(occurrence.lens === undefined ? {} : { lens: occurrence.lens }),
        source,
        ...(direction === undefined ? {} : { direction }),
      },
      environment,
    );

    // Expected acceptance, derived from the reference definition only.
    let expected = reference.role === "proposition" && !captures;
    if (kind === "rewrite-with-implication") {
      const matchesAntecedent = mathJsonEquals(
        sourceSides[0] as PlainMathJson,
        occurrence.fragment,
      );
      const matchesConsequent = mathJsonEquals(
        sourceSides[1] as PlainMathJson,
        occurrence.fragment,
      );
      expected &&=
        (reference.polarity === "positive" && matchesConsequent) ||
        (reference.polarity === "negative" && matchesAntecedent);
    }
    expect(result.ok, JSON.stringify({ kind, sourceExpression, occurrence, statementKind })).toBe(
      expected,
    );
    if (!result.ok) {
      if (
        kind === "rewrite-with-implication" &&
        reference.role === "proposition" &&
        (reference.polarity === "mixed" || reference.polarity === "neutral")
      ) {
        expect(result.diagnostics[0]?.code).toBe("polarity-not-permitted");
      }
      continue;
    }
    acceptedByKind.set(kind, (acceptedByKind.get(kind) ?? 0) + 1);
    expect(result.transitionClass).toBe(
      kind === "rewrite-with-equivalence" ? "equivalence" : "strengthening",
    );
    expect(result.evidence).toBe(sourceKind === "hypothesis" ? "structural" : "library-result");
    expect(
      checkClass(
        input,
        result.state,
        result.transitionClass,
        sourceKind === "result" ? sourceExpression : undefined,
      ),
      JSON.stringify({ kind, sourceExpression, occurrence, statementKind, after: result.state }),
    ).toBe(true);
  }
}

describe("deep rewrites respect their transition class semantically", () => {
  it("has a truth-table checker that detects false class claims", () => {
    const axiom: PlainMathJson = ["Implies", "p", "q"];
    expect(checkClass(state("q"), state("p"), "strengthening", axiom)).toBe(true);
    expect(checkClass(state("p"), state("q"), "strengthening", axiom)).toBe(false);
    expect(checkClass(state("q"), state("p"), "equivalence", axiom)).toBe(false);
    expect(checkClass(state("q"), state("p"), "equivalence", ["Equivalent", "p", "q"])).toBe(true);
    expect(checkClass(state(["ForAll", "p", "p"]), state("False"), "equivalence", undefined)).toBe(
      true,
    );
  });

  for (const sourceKind of ["hypothesis", "result"] as const) {
    it(`checks every position of random formulas with a ${sourceKind} source`, () => {
      fc.assert(
        fc.property(
          formula,
          formula,
          quantifierFree,
          fc.constantFrom("conclusion", "hypothesis"),
          fc.nat(),
          (conclusion, statementHypothesis, other, statementKind, choice) => {
            const statementExpression =
              statementKind === "conclusion" ? conclusion : statementHypothesis;
            const candidates = occurrences(statementExpression).filter(
              ({ fragment }) => !mathJsonEquals(fragment, other),
            );
            // Check a few occurrences per formula to keep the property fast.
            for (let offset = 0; offset < Math.min(3, candidates.length); offset += 1) {
              const occurrence = candidates[(choice + offset) % candidates.length] as Occurrence;
              checkAllSourceForms(
                conclusion,
                statementHypothesis,
                statementKind,
                occurrence,
                other,
                sourceKind,
              );
            }
          },
        ),
        { numRuns: 120 },
      );
      // The property must exercise accepted rewrites of both kinds, not only rejections.
      expect(acceptedByKind.get("rewrite-with-equivalence") ?? 0).toBeGreaterThan(50);
      expect(acceptedByKind.get("rewrite-with-implication") ?? 0).toBeGreaterThan(50);
      acceptedByKind.clear();
    });
  }
});

// ---------------------------------------------------------------------------
// Golden rewrites and rejections
// ---------------------------------------------------------------------------

describe("golden deep rewrites", () => {
  it("rewrites with an equivalence under a negation and inside a hypothesis", () => {
    const input = state(
      ["Not", ["And", "p", "r"]],
      [
        { id: "hypothesis:source", expression: ["Equivalent", "p", "q"] },
        { id: "hypothesis:statement", expression: ["Implies", "q", "r"] },
      ],
    );
    expect(
      applyTransition(input, {
        ...base,
        kind: "rewrite-with-equivalence",
        statement: { kind: "conclusion" },
        path: [0, 0],
        source: hypothesisSource,
        direction: "forward",
      }),
    ).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      evidence: "structural",
      state: { goals: [{ sequent: { conclusion: { expression: ["Not", ["And", "q", "r"]] } } }] },
    });
    const hypothesisRewrite = applyTransition(input, {
      ...base,
      kind: "rewrite-with-equivalence",
      statement: { kind: "hypothesis", id: "hypothesis:statement" },
      path: [0],
      source: hypothesisSource,
      direction: "backward",
    });
    expect(hypothesisRewrite).toMatchObject({
      ok: true,
      state: {
        goals: [
          {
            sequent: {
              context: {
                hypotheses: [
                  { id: "hypothesis:source", statement: { expression: ["Equivalent", "p", "q"] } },
                  {
                    id: "hypothesis:statement",
                    statement: { expression: ["Implies", "p", "r"] },
                  },
                ],
              },
            },
          },
        ],
      },
    });
  });

  it("strengthens with an implication by polarity in goals and hypotheses", () => {
    const implication = { id: "hypothesis:source", expression: ["Implies", "p", "q"] } as const;
    const rewrite = (
      conclusion: PlainMathJson,
      statementHypothesis: PlainMathJson,
      statement: "conclusion" | "hypothesis",
      path: readonly number[],
    ) =>
      applyTransition(
        state(conclusion, [
          implication,
          { id: "hypothesis:statement", expression: statementHypothesis },
        ]),
        {
          ...base,
          kind: "rewrite-with-implication",
          statement:
            statement === "conclusion"
              ? { kind: "conclusion" }
              : { kind: "hypothesis", id: "hypothesis:statement" },
          path,
          source: hypothesisSource,
        },
      );

    // Positive goal position: q becomes p.
    expect(rewrite(["Or", "q", "r"], "True", "conclusion", [0])).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      state: { goals: [{ sequent: { conclusion: { expression: ["Or", "p", "r"] } } }] },
    });
    // Negative goal position (implication antecedent): p becomes q.
    expect(rewrite(["Implies", "p", "r"], "True", "conclusion", [0])).toMatchObject({
      ok: true,
      state: { goals: [{ sequent: { conclusion: { expression: ["Implies", "q", "r"] } } }] },
    });
    // Hypothesis root is negative: p becomes q.
    expect(rewrite("r", ["And", "p", "r"], "hypothesis", [0])).toMatchObject({
      ok: true,
      state: {
        goals: [
          {
            sequent: {
              context: {
                hypotheses: [{}, { statement: { expression: ["And", "q", "r"] } }],
              },
            },
          },
        ],
      },
    });
    // Under a negation inside a hypothesis the position is positive: q becomes p.
    expect(rewrite("r", ["Not", "q"], "hypothesis", [0])).toMatchObject({
      ok: true,
      state: {
        goals: [
          {
            sequent: { context: { hypotheses: [{}, { statement: { expression: ["Not", "p"] } }] } },
          },
        ],
      },
    });
    // The wrong side for the polarity is not applicable.
    expect(rewrite(["Or", "p", "r"], "True", "conclusion", [0])).toMatchObject({
      ok: false,
      diagnostics: [{ code: "rule-not-applicable" }],
    });
    // Mixed and neutral positions are rejected specifically.
    expect(rewrite(["Equivalent", "q", "r"], "True", "conclusion", [0])).toMatchObject({
      ok: false,
      diagnostics: [{ code: "polarity-not-permitted" }],
    });
    expect(rewrite(["Equal", ["Not", "q"], "r"], "True", "conclusion", [0, 0])).toMatchObject({
      ok: false,
      diagnostics: [{ code: "polarity-not-permitted" }],
    });
    // A term position is not a proposition occurrence.
    expect(rewrite(["Equal", "q", "r"], "True", "conclusion", [0])).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-path" }],
    });
  });

  it("rewrites with an instantiated premise-free result and records its ID", () => {
    const environment: KernelEnvironment = {
      results: [
        {
          id: "result:double-negation",
          parameters: [{ symbol: "a", sort: PROPOSITION_SORT }],
          premises: [],
          conclusion: { expression: ["Equivalent", ["Not", ["Not", "a"]], "a"] },
          directions: ["backward"],
        },
        {
          id: "result:with-premise",
          parameters: [
            { symbol: "a", sort: PROPOSITION_SORT },
            { symbol: "b", sort: PROPOSITION_SORT },
          ],
          premises: [{ expression: "a" }],
          conclusion: { expression: ["Implies", "a", "b"] },
          directions: ["backward", "forward"],
        },
      ] as never,
    };
    const input = state(
      ["And", "r", ["Not", ["Not", "p"]]],
      [{ id: "hypothesis:h", expression: ["Not", ["Not", "q"]] }],
    );
    const rewrite = (fields: Readonly<Record<string, unknown>>) =>
      applyTransition(input, { ...base, kind: "rewrite-with-equivalence", ...fields }, environment);
    expect(
      rewrite({
        statement: { kind: "conclusion" },
        path: [1],
        source: { kind: "result", resultId: "result:double-negation", instantiation: { a: "p" } },
        direction: "forward",
      }),
    ).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      evidence: "library-result",
      resultId: "result:double-negation",
      state: { goals: [{ sequent: { conclusion: { expression: ["And", "r", "p"] } } }] },
    });
    // A hypothesis rewrite is forward application, which this result does not permit.
    expect(
      rewrite({
        statement: { kind: "hypothesis", id: "hypothesis:h" },
        path: [],
        source: { kind: "result", resultId: "result:double-negation", instantiation: { a: "q" } },
        direction: "forward",
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "direction-not-permitted" }] });
    expect(
      applyTransition(
        input,
        {
          ...base,
          kind: "rewrite-with-implication",
          statement: { kind: "conclusion" },
          path: [0],
          source: {
            kind: "result",
            resultId: "result:with-premise",
            instantiation: { a: "q", b: "r" },
          },
        },
        environment,
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "rule-not-applicable" }] });
  });

  it("rewrites an associative lens with equalities, equivalences, and implications", () => {
    const realDeclarations = ["x", "y", "z", "w"].map((symbol, index) => ({
      id: `declaration:real-${index}`,
      symbol,
      sort: realSort,
      role: "universal-parameter" as const,
    }));
    const terms = state(
      ["Equal", ["Add", "x", "y", "z"], "w"],
      [{ id: "hypothesis:source", expression: ["Equal", ["Add", "y", "z"], "w"] }],
      realDeclarations,
    );
    expect(
      applyTransition(terms, {
        ...base,
        kind: "rewrite-with-equality",
        equalityHypothesisId: "hypothesis:source",
        statement: { kind: "conclusion" },
        path: [0],
        lens: { startOperand: 1, endOperand: 3 },
        direction: "forward",
      }),
    ).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [{ sequent: { conclusion: { expression: ["Equal", ["Add", "x", "w"], "w"] } } }],
      },
    });
    expect(
      applyTransition(terms, {
        ...base,
        kind: "rewrite-with-equality",
        equalityHypothesisId: "hypothesis:source",
        statement: { kind: "conclusion" },
        path: [0],
        lens: { startOperand: 0, endOperand: 2 },
        direction: "forward",
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "rule-not-applicable" }] });

    const propositions = state(
      ["Or", "r", "p", "q"],
      [{ id: "hypothesis:source", expression: ["Implies", "r", ["Or", "p", "q"]] }],
    );
    expect(
      applyTransition(propositions, {
        ...base,
        kind: "rewrite-with-implication",
        statement: { kind: "conclusion" },
        path: [],
        lens: { startOperand: 1, endOperand: 3 },
        source: hypothesisSource,
      }),
    ).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      state: { goals: [{ sequent: { conclusion: { expression: ["Or", "r", "r"] } } }] },
    });
    // The whole container is addressed by its path, not by a lens.
    expect(
      applyTransition(propositions, {
        ...base,
        kind: "rewrite-with-implication",
        statement: { kind: "conclusion" },
        path: [],
        lens: { startOperand: 0, endOperand: 3 },
        source: hypothesisSource,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-path" }] });
  });

  it("rejects capture of the matched side or the replacement under a binder", () => {
    // Before N10 the equality rewrite matched the bound p against the free p of the source.
    const boundMatch = state(
      ["ForAll", "p", ["Implies", "q", "p"]],
      [{ id: "hypothesis:source", expression: ["Equal", "p", "q"] }],
    );
    expect(
      applyTransition(boundMatch, {
        ...base,
        kind: "rewrite-with-equality",
        equalityHypothesisId: "hypothesis:source",
        statement: { kind: "conclusion" },
        path: [1, 1],
        direction: "forward",
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "rule-not-applicable" }] });

    const goal: PlainMathJson = ["ForAll", "p", ["Or", "p", "q"]];
    for (const [expression, path] of [
      [
        ["Equivalent", "q", "p"],
        [1, 1],
      ],
      [
        ["Equivalent", "p", "r"],
        [1, 0],
      ],
    ] as const) {
      expect(
        applyTransition(state(goal, [{ id: "hypothesis:source", expression }]), {
          ...base,
          kind: "rewrite-with-equivalence",
          statement: { kind: "conclusion" },
          path,
          source: hypothesisSource,
          direction: "forward",
        }),
      ).toMatchObject({ ok: false, diagnostics: [{ code: "rule-not-applicable" }] });
    }
    expect(
      applyTransition(
        state(goal, [{ id: "hypothesis:source", expression: ["Implies", "p", "q"] }]),
        {
          ...base,
          kind: "rewrite-with-implication",
          statement: { kind: "conclusion" },
          path: [1, 1],
          source: hypothesisSource,
        },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "rule-not-applicable" }] });
    // Binder operands are never occurrences.
    expect(
      applyTransition(
        state(goal, [{ id: "hypothesis:source", expression: ["Equivalent", "p", "r"] }]),
        {
          ...base,
          kind: "rewrite-with-equivalence",
          statement: { kind: "conclusion" },
          path: [0],
          source: hypothesisSource,
          direction: "forward",
        },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-path" }] });
  });

  it("rejects self-rewrites and non-matching sources", () => {
    const input = state("r", [{ id: "hypothesis:source", expression: ["Implies", "p", "q"] }]);
    expect(
      applyTransition(input, {
        ...base,
        kind: "rewrite-with-implication",
        statement: { kind: "hypothesis", id: "hypothesis:source" },
        path: [0],
        source: hypothesisSource,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "rule-not-applicable" }] });
    expect(
      applyTransition(input, {
        ...base,
        kind: "rewrite-with-equivalence",
        statement: { kind: "conclusion" },
        path: [],
        source: hypothesisSource,
        direction: "forward",
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "rule-not-applicable" }] });
  });
});

describe("deep rewrite operation schema", () => {
  it("accepts optional lenses and discriminated sources strictly", () => {
    const operation = {
      ...base,
      kind: "rewrite-with-implication",
      statement: { kind: "conclusion" },
      path: [0],
      lens: { startOperand: 0, endOperand: 2 },
      source: { kind: "result", resultId: "result:r", instantiation: { a: "p" } },
    };
    expect(kernelOperationSchema.safeParse(operation)).toMatchObject({
      success: true,
      data: operation,
    });
    for (const invalid of [
      { ...operation, lens: { startOperand: 0, endOperand: 1 } },
      { ...operation, lens: { startOperand: 0, endOperand: 2, extra: true } },
      { ...operation, source: { kind: "hypothesis", hypothesisId: "hypothesis:h", extra: 1 } },
      { ...operation, source: { kind: "result", resultId: "result:r" } },
      { ...operation, direction: "forward" },
      { ...operation, kind: "rewrite-with-equivalence" },
      {
        ...base,
        kind: "close-true",
        lens: { startOperand: 0, endOperand: 2 },
      },
    ]) {
      expect(kernelOperationSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
