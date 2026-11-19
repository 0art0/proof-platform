import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PROPOSITION_SORT,
  createExecutableProofStateSchema,
  operatorDeclarationsSchema,
  sortSchema,
  statementIdSchema,
  type ExecutableProofState,
  type PlainMathJson,
  type Sort,
} from "@proof/mathjson-model";
import {
  applyTransition,
  kernelResultIdSchema,
  parseKernelResultCatalog,
  previewGeneralizedRewrite,
  type GeneralizedRewriteSelection,
  type KernelEnvironment,
  type KernelResult,
} from "./index";

const real = sortSchema.parse({ kind: "named", id: "sort:real" });
const integer = sortSchema.parse({ kind: "named", id: "sort:integer" });
const operators = operatorDeclarationsSchema.parse([
  {
    id: "operator:congruent",
    symbol: "Congruent",
    signature: { parameters: [integer, integer, integer], result: PROPOSITION_SORT },
  },
]);
const declarations = [
  ...["a", "b", "c", "x"].map((symbol) => ({ symbol, sort: real })),
  ...["p", "q", "r"].map((symbol) => ({ symbol, sort: PROPOSITION_SORT })),
].map((parameter) => ({
  ...parameter,
  id: `decl:${parameter.symbol}`,
  role: "universal-parameter",
}));
const before = "state:before";
const base = {
  kind: "generalized-rewrite",
  expectedStateId: before,
  resultStateId: "state:after",
} as const;

function state(
  goal: PlainMathJson,
  hypotheses: Record<string, PlainMathJson> = {},
): ExecutableProofState {
  return createExecutableProofStateSchema({ operators }).parse({
    id: before,
    goals: [
      {
        id: "goal:0",
        sequent: {
          context: {
            declarations,
            hypotheses: Object.entries(hypotheses).map(([id, expression]) => ({
              id: `hyp:${id}`,
              statement: { expression },
            })),
          },
          conclusion: { expression: goal },
        },
      },
    ],
    obligations: [],
  });
}

function rule(
  id: string,
  symbols: string,
  premises: readonly PlainMathJson[],
  conclusion: PlainMathJson,
  sort: Sort = real,
  extras: Partial<KernelResult> = {},
): KernelResult {
  return {
    id: kernelResultIdSchema.parse(`result:${id}`),
    parameters: [...symbols].map((symbol) => ({ symbol, sort })),
    premises: premises.map((expression) => ({ expression })),
    conclusion: { expression: conclusion },
    directions: ["forward", "backward"],
    ...extras,
  };
}

const lessMultiply = rule(
  "less-multiply-positive",
  "abc",
  [
    ["Less", "a", "b"],
    ["Greater", "c", 0],
  ],
  ["Less", ["Multiply", "a", "c"], ["Multiply", "b", "c"]],
  real,
  { congruenceSymbols: ["Multiply"] },
);

const lessTransport = rule(
  "less-transport-left",
  "abc",
  [
    ["Less", "a", "b"],
    ["Less", "b", "c"],
  ],
  ["Less", "a", "c"],
  real,
  {
    congruenceSymbols: ["Less"],
    congruenceRule: {
      premises: [{ expression: ["Less", "a", "b"] }],
      conclusion: { expression: ["Implies", ["Less", "b", "c"], ["Less", "a", "c"]] },
    },
  },
);

const congruentAddition = rule(
  "congruent-addition",
  "abcd",
  [["Congruent", "a", "b", "d"]],
  ["Congruent", ["Add", "a", "c"], ["Add", "b", "c"], "d"],
  integer,
  { congruenceSymbols: ["Add"] },
);

const congruentPredicate = rule(
  "congruent-predicate",
  "abcd",
  [["Congruent", "a", "b", "d"]],
  ["Equivalent", ["Congruent", "a", "c", "d"], ["Congruent", "b", "c", "d"]],
  integer,
  { congruenceSymbols: ["Congruent"] },
);

function selection(
  path: readonly number[],
  extras: Partial<GeneralizedRewriteSelection> = {},
): GeneralizedRewriteSelection {
  return {
    target: { kind: "goal", id: statementIdSchema.parse("goal:0") },
    statement: { kind: "conclusion" },
    source: { kind: "hypothesis", hypothesisId: statementIdSchema.parse("hyp:source") },
    path,
    direction: "forward",
    ...extras,
  };
}

function environment(...results: readonly KernelResult[]): KernelEnvironment {
  return { operators, results };
}

function apply(
  input: ExecutableProofState,
  select: GeneralizedRewriteSelection,
  ...results: readonly KernelResult[]
) {
  const env = environment(...results);
  const planned = previewGeneralizedRewrite(input, select, env);
  if (!planned.ok) throw new Error(planned.message);
  return applyTransition(
    input,
    {
      ...base,
      ...select,
      congruenceResultIds: planned.congruenceResultIds,
      obligationIds: planned.obligations.map((_expression, index) => `obligation:${index}`),
    },
    env,
  );
}

describe("generalized rewriting", () => {
  it("uses result equality at an associative occurrence and closes guards in their lexical scope", () => {
    const cancel = rule(
      "divide-self",
      "t",
      [["NotEqual", "t", 0]],
      ["Equal", ["Divide", "t", "t"], 1],
    );
    const goal: PlainMathJson = [
      "ForAll",
      ["Element", "x", "RealNumbers"],
      ["Equal", ["Add", ["Divide", "x", "x"], 2, 3], 10],
    ];
    const input = state(goal, { shadowed: ["NotEqual", "x", 0] });
    const select = selection([1, 0, 0], {
      source: { kind: "result", resultId: cancel.id, instantiation: { t: "x" } },
    });
    const outcome = apply(input, select, cancel);
    expect(outcome).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      evidence: "library-result",
      resultId: cancel.id,
      state: {
        goals: [
          {
            sequent: {
              conclusion: {
                expression: [
                  "ForAll",
                  ["Element", "x", "RealNumbers"],
                  ["Equal", ["Add", 1, 2, 3], 10],
                ],
              },
            },
          },
        ],
        obligations: [
          {
            provenance: { kind: "premise-of-result", resultId: cancel.id },
            sequent: {
              conclusion: {
                expression: ["ForAll", ["Element", "x", "RealNumbers"], ["NotEqual", "x", 0]],
              },
            },
          },
        ],
      },
    });
    const shadowed = state(goal, { source: ["Equal", ["Divide", "x", "x"], 1] });
    expect(previewGeneralizedRewrite(shadowed, selection([1, 0, 0]), environment())).toMatchObject({
      ok: false,
      code: "invalid-instantiation",
    });

    const lensGoal = state(["Equal", ["Add", 1, 2, 7], 10], {
      source: ["Equal", ["Add", 1, 2], 3],
    });
    expect(
      apply(lensGoal, selection([0], { lens: { startOperand: 0, endOperand: 2 } })),
    ).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: { goals: [{ sequent: { conclusion: { expression: ["Equal", ["Add", 3, 7], 10] } } }] },
    });
  });

  it("combines conditional arithmetic lifting with endpoint transport and pins both witnesses", () => {
    const input = state(["Less", ["Multiply", "a", "c"], 20], { source: ["Less", "a", "b"] });
    const select = selection([0, 0]);
    const env = environment(lessMultiply, lessTransport);
    expect(previewGeneralizedRewrite(input, select, env)).toMatchObject({
      ok: true,
      congruenceResultIds: [lessMultiply.id, lessTransport.id],
      obligations: [["Greater", "c", 0]],
    });
    const outcome = apply(input, select, lessMultiply, lessTransport);
    expect(outcome).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      resultId: lessMultiply.id,
      state: {
        goals: [{ sequent: { conclusion: { expression: ["Less", ["Multiply", "b", "c"], 20] } } }],
        obligations: [
          {
            provenance: { kind: "premise-of-result", resultId: lessMultiply.id },
            sequent: { conclusion: { expression: ["Greater", "c", 0] } },
          },
        ],
      },
    });
    expect(
      applyTransition(
        input,
        {
          ...base,
          ...select,
          obligationIds: ["obligation:new"],
          congruenceResultIds: [lessTransport.id, lessMultiply.id],
        },
        env,
      ),
    ).toMatchObject({ ok: false, state: input });
    const differentWitness = {
      ...lessMultiply,
      id: kernelResultIdSchema.parse("result:alternate-multiply"),
    };
    expect(
      previewGeneralizedRewrite(
        input,
        {
          ...select,
          congruenceResultIds: [lessMultiply.id, lessTransport.id],
        },
        environment(differentWitness, lessMultiply, lessTransport),
      ),
    ).toMatchObject({ ok: true, congruenceResultIds: [lessMultiply.id, lessTransport.id] });
  });

  it("requires congruence transport for the same parameter and refuses unapproved argument lifting", () => {
    const select = selection([0, 0]);
    const input = state(["Congruent", ["Add", 8, 3], 4, 6], { source: ["Congruent", 8, 2, 6] });
    expect(apply(input, select, congruentAddition, congruentPredicate)).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [{ sequent: { conclusion: { expression: ["Congruent", ["Add", 2, 3], 4, 6] } } }],
      },
    });
    const wrongModulus = state(["Congruent", ["Add", 8, 3], 4, 5], {
      source: ["Congruent", 8, 2, 6],
    });
    expect(
      previewGeneralizedRewrite(
        wrongModulus,
        select,
        environment(congruentAddition, congruentPredicate),
      ),
    ).toMatchObject({ ok: false });
    expect(previewGeneralizedRewrite(input, select, environment(congruentPredicate))).toMatchObject(
      { ok: false },
    );
  });

  it("uses implication at negative occurrences and refuses the opposite direction or a mixed position", () => {
    const input = state(
      ["ForAll", ["Element", "u", "Booleans"], ["Implies", ["And", "p", "u"], "r"]],
      { source: ["Implies", "p", "q"] },
    );
    expect(apply(input, selection([1, 0, 0]))).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      state: {
        goals: [
          {
            sequent: {
              conclusion: {
                expression: [
                  "ForAll",
                  ["Element", "u", "Booleans"],
                  ["Implies", ["And", "q", "u"], "r"],
                ],
              },
            },
          },
        ],
      },
    });
    expect(
      previewGeneralizedRewrite(
        state(["Equivalent", "p", "r"], { source: ["Implies", "p", "q"] }),
        selection([0]),
        environment(),
      ),
    ).toMatchObject({ ok: false, code: "polarity-not-permitted" });
    expect(
      previewGeneralizedRewrite(
        state("p", { source: ["Implies", "p", "q"] }),
        selection([]),
        environment(),
      ),
    ).toMatchObject({ ok: false, code: "polarity-not-permitted" });
  });

  it("never reports equivalence using a condition discharged only by the rewritten hypothesis", () => {
    const conditional = rule(
      "conditional-equivalence",
      "pqr",
      ["p"],
      ["Equivalent", "p", ["Or", "q", "r"]],
      PROPOSITION_SORT,
    );
    const input = state("p", { target: "p" });
    const select = selection([], {
      statement: { kind: "hypothesis", id: statementIdSchema.parse("hyp:target") },
      source: {
        kind: "result",
        resultId: conditional.id,
        instantiation: { p: "p", q: "q", r: "r" },
      },
    });
    expect(apply(input, select, conditional)).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
    });
    expect(previewGeneralizedRewrite(input, select, environment(conditional))).toMatchObject({
      ok: true,
      obligations: ["p"],
    });
  });

  it("rejects an alternative rule view that changes the theorem", () => {
    const counterfeit = {
      ...lessTransport,
      congruenceRule: {
        ...lessTransport.congruenceRule,
        conclusion: { expression: ["Implies", ["Less", "b", "c"], ["Less", "c", "a"]] },
      },
    };
    expect(parseKernelResultCatalog([counterfeit], operators)).toMatchObject({
      ok: false,
      issue: { path: [0, "congruenceRule"] },
    });
  });

  it("preserves numerical implications of every generated positive-order transport", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -20, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: -300, max: 300 }),
        (a, gap, c, boundary) => {
          const b = a + gap;
          const input = state(["Less", ["Multiply", a, c], boundary], {
            source: ["Less", a, b],
            guard: ["Greater", c, 0],
          });
          const output = apply(input, selection([0, 0]), lessMultiply, lessTransport);
          expect(output).toMatchObject({ ok: true, state: { obligations: [] } });
          expect(!(b * c < boundary) || a * c < boundary).toBe(true);
        },
      ),
      { numRuns: 35 },
    );
  });
});
