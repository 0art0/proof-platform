import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  executableProofStateSchema,
  freeSymbolNames,
  operatorDeclarationsSchema,
  substituteMathJson,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { alphaEquivalent, applyTransition, matchResultConclusion } from "./index";

const real = { kind: "named", id: "sort:real" } as const;
const realSet = { kind: "named", id: "sort:set", arguments: [real] } as const;
const operators = operatorDeclarationsSchema.parse([
  {
    id: "operator:big",
    symbol: "Big",
    signature: { parameters: [real, real, real], result: real },
    binder: { kind: "direct-symbols", boundOperands: [0], scopedOperands: [2] },
  },
]);

describe("alpha-equivalence under the term-language binders", () => {
  it.each<[string, PlainMathJson, PlainMathJson, boolean]>([
    [
      "renamed typed quantifier",
      ["ForAll", ["Element", "x", "S"], ["Less", "x", "y"]],
      ["ForAll", ["Element", "u", "S"], ["Less", "u", "y"]],
      true,
    ],
    [
      "different typed domains",
      ["ForAll", ["Element", "x", "S"], ["Less", "x", "y"]],
      ["ForAll", ["Element", "x", "T"], ["Less", "x", "y"]],
      false,
    ],
    [
      "typed and untyped binders differ",
      ["ForAll", ["Element", "x", "S"], "True"],
      ["ForAll", "x", "True"],
      false,
    ],
    [
      "a domain refers to the enclosing scope, not the new binder",
      ["ForAll", ["Element", "x", "x"], ["P", "x"]],
      ["ForAll", ["Element", "u", "x"], ["P", "u"]],
      true,
    ],
    [
      "a domain is not renamed with its binder",
      ["ForAll", ["Element", "x", "x"], ["P", "x"]],
      ["ForAll", ["Element", "u", "u"], ["P", "u"]],
      false,
    ],
    [
      "renamed lambda parameters",
      ["Function", ["Add", "s", ["Multiply", 2, "t"]], "s", ["Element", "t", "S"]],
      ["Function", ["Add", "a", ["Multiply", 2, "b"]], "a", ["Element", "b", "S"]],
      true,
    ],
    [
      "swapped lambda parameters",
      ["Function", ["Subtract", "s", "t"], "s", "t"],
      ["Function", ["Subtract", "s", "t"], "t", "s"],
      false,
    ],
    [
      "renamed summation index with outer bounds",
      ["Sum", ["At", "a", "k"], ["Limits", "k", 1, "n"]],
      ["Sum", ["At", "a", "j"], ["Limits", "j", 1, "n"]],
      true,
    ],
    [
      "different summation bounds",
      ["Sum", ["At", "a", "k"], ["Limits", "k", 1, "n"]],
      ["Sum", ["At", "a", "k"], ["Limits", "k", 0, "n"]],
      false,
    ],
    [
      "renamed integration variable",
      ["Integrate", ["f", "t"], ["Limits", "t", 0, 1]],
      ["Integrate", ["f", "s"], ["Limits", "s", 0, 1]],
      true,
    ],
    [
      "limit through a renamed lambda",
      ["Limit", ["Function", ["Divide", 1, "t"], "t"], "PositiveInfinity"],
      ["Limit", ["Function", ["Divide", 1, "u"], "u"], "PositiveInfinity"],
      true,
    ],
  ])("%s", (_label, left, right, expected) => {
    expect(alphaEquivalent(left, right)).toBe(expected);
    expect(alphaEquivalent(right, left)).toBe(expected);
  });
});

/* A binder-shaped abstract syntax whose bound variables are referenced by binder id, rendered
 * twice with different name choices. Both renderings denote the same term, so they must be
 * alpha-equivalent, and so must the results of the same substitution into each. */

type Abstract =
  | Readonly<{ kind: "free"; name: string }>
  | Readonly<{ kind: "bound"; binder: number }>
  | Readonly<{ kind: "literal"; value: number }>
  | Readonly<{ kind: "node"; head: string; operands: readonly Abstract[] }>
  | Readonly<{
      kind: "binder";
      id: number;
      binderKind: BinderKind;
      outer: readonly Abstract[];
      body: Abstract;
    }>;

type BinderKind =
  | "ForAll"
  | "ForAllTyped"
  | "Exists"
  | "Function"
  | "SumLimits"
  | "ProductElement"
  | "Integrate"
  | "Limit"
  | "Big";

const BINDER_KINDS: readonly BinderKind[] = [
  "ForAll",
  "ForAllTyped",
  "Exists",
  "Function",
  "SumLimits",
  "ProductElement",
  "Integrate",
  "Limit",
  "Big",
];
const OUTER_COUNT: Readonly<Record<BinderKind, number>> = {
  ForAll: 0,
  ForAllTyped: 1,
  Exists: 1,
  Function: 1,
  SumLimits: 2,
  ProductElement: 1,
  Integrate: 2,
  Limit: 1,
  Big: 1,
};

const FREE = ["a", "b", "x"] as const;

function abstractArbitrary(): fc.Arbitrary<Abstract> {
  let nextId = 0;
  const build = (depth: number, scope: readonly number[]): fc.Arbitrary<Abstract> => {
    const leaves: fc.Arbitrary<Abstract>[] = [
      fc.constantFrom(...FREE).map((name): Abstract => ({ kind: "free", name })),
      fc.integer({ min: 0, max: 3 }).map((value): Abstract => ({ kind: "literal", value })),
    ];
    if (scope.length > 0) {
      leaves.push(fc.constantFrom(...scope).map((binder): Abstract => ({ kind: "bound", binder })));
    }
    if (depth <= 0) return fc.oneof(...leaves);
    return fc.oneof(
      ...leaves,
      fc
        .tuple(build(depth - 1, scope), build(depth - 1, scope))
        .map(([left, right]): Abstract => ({ kind: "node", head: "Add", operands: [left, right] })),
      fc.constantFrom(...BINDER_KINDS).chain((binderKind) => {
        const id = nextId++;
        return fc
          .tuple(
            fc.array(build(depth - 1, scope), {
              minLength: OUTER_COUNT[binderKind],
              maxLength: OUTER_COUNT[binderKind],
            }),
            build(depth - 1, [...scope, id]),
          )
          .map(([outer, body]): Abstract => ({ kind: "binder", id, binderKind, outer, body }));
      }),
    );
  };
  return fc.integer({ min: 1, max: 3 }).chain((depth) => build(depth, []));
}

/** Render with a bound-name choice per binder id; undefined when a choice would capture. */
function render(
  term: Abstract,
  names: ReadonlyMap<number, string>,
  scope: readonly Readonly<{ id: number; name: string }>[] = [],
): PlainMathJson | undefined {
  switch (term.kind) {
    case "free":
      // A free name must not be shadowed by an enclosing binder.
      return scope.some(({ name }) => name === term.name) ? undefined : term.name;
    case "literal":
      return term.value;
    case "bound": {
      const index = scope.findIndex(({ id }) => id === term.binder);
      const name = scope[index]?.name;
      // An intervening binder with the same name would shadow the reference.
      if (name === undefined || scope.slice(index + 1).some((entry) => entry.name === name)) {
        return undefined;
      }
      return name;
    }
    case "node": {
      const operands = term.operands.map((operand) => render(operand, names, scope));
      return operands.some((operand) => operand === undefined)
        ? undefined
        : ([term.head, ...operands] as PlainMathJson);
    }
    case "binder": {
      const name = names.get(term.id) ?? "v";
      const outer = term.outer.map((operand) => render(operand, names, scope));
      const body = render(term.body, names, [...scope, { id: term.id, name }]);
      if (body === undefined || outer.some((operand) => operand === undefined)) return undefined;
      const [first, second] = outer as PlainMathJson[];
      const proposition: PlainMathJson = ["Less", body, 0];
      switch (term.binderKind) {
        case "ForAll":
          return ["ForAll", name, proposition];
        case "ForAllTyped":
          return ["ForAll", ["Element", name, first as PlainMathJson], proposition];
        case "Exists":
          return ["Exists", ["Element", name, first as PlainMathJson], proposition];
        case "Function":
          return ["Apply", ["Function", body, name], first as PlainMathJson];
        case "SumLimits":
          return ["Sum", body, ["Limits", name, first as PlainMathJson, second as PlainMathJson]];
        case "ProductElement":
          return ["Product", body, ["Element", name, first as PlainMathJson]];
        case "Integrate":
          return [
            "Integrate",
            body,
            ["Limits", name, first as PlainMathJson, second as PlainMathJson],
          ];
        case "Limit":
          return ["Limit", ["Function", body, name], first as PlainMathJson];
        case "Big":
          return ["Big", name, first as PlainMathJson, body];
      }
    }
  }
}

function binderIds(term: Abstract, result: number[] = []): number[] {
  if (term.kind === "node") term.operands.forEach((operand) => binderIds(operand, result));
  if (term.kind === "binder") {
    result.push(term.id);
    term.outer.forEach((operand) => binderIds(operand, result));
    binderIds(term.body, result);
  }
  return result;
}

const renderedPair = abstractArbitrary()
  .chain((term) => {
    const ids = binderIds(term);
    const choice = fc.array(fc.constantFrom("x", "y", "u", "v"), {
      minLength: ids.length,
      maxLength: ids.length,
    });
    return fc.tuple(choice, choice).map(([left, right]) => {
      const leftNames = new Map(ids.map((id, index) => [id, left[index] as string]));
      const rightNames = new Map(ids.map((id, index) => [id, right[index] as string]));
      return [render(term, leftNames), render(term, rightNames)] as const;
    });
  })
  .filter(
    (pair): pair is readonly [PlainMathJson, PlainMathJson] =>
      pair[0] !== undefined && pair[1] !== undefined,
  );

const replacementArbitrary = fc.oneof(
  fc.constantFrom<PlainMathJson>("x", "y", "u", "v", "b"),
  fc
    .tuple(fc.constantFrom("x", "y", "u", "v"), fc.constantFrom("x", "y", "u", "v"))
    .map(([left, right]): PlainMathJson => ["Add", left, right]),
);

describe("capture avoidance properties under every binder kind", () => {
  it("treats consistent renderings of one binder structure as alpha-equivalent", () => {
    fc.assert(
      fc.property(renderedPair, ([left, right]) => {
        expect(alphaEquivalent(left, right, { operators })).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it("commutes substitution with alpha-renaming, never capturing replacement names", () => {
    fc.assert(
      fc.property(
        renderedPair,
        fc.constantFrom("a", "x"),
        replacementArbitrary,
        ([left, right], target, replacement) => {
          const environment = { operators };
          const leftResult = substituteMathJson(
            left,
            [{ symbol: target, replacement }],
            environment,
          );
          const rightResult = substituteMathJson(
            right,
            [{ symbol: target, replacement }],
            environment,
          );
          expect(leftResult.ok && rightResult.ok).toBe(true);
          expect(alphaEquivalent(leftResult.expression, rightResult.expression, environment)).toBe(
            true,
          );
          if (freeSymbolNames(left, environment).includes(target)) {
            const free = freeSymbolNames(leftResult.expression, environment);
            freeSymbolNames(replacement, environment).forEach((name) =>
              expect(free).toContain(name),
            );
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("kernel operations with typed binders", () => {
  const declarations = [
    { id: "decl:x", symbol: "x", sort: real, role: "universal-parameter" },
    { id: "decl:y", symbol: "y", sort: real, role: "universal-parameter" },
  ];

  it("instantiates across a typed binder by renaming it, without declaring the fresh name", () => {
    const input = executableProofStateSchema.parse({
      id: "state:before",
      goals: [
        {
          id: "goal:0",
          sequent: {
            context: {
              declarations,
              hypotheses: [
                {
                  id: "hypothesis:universal",
                  statement: {
                    expression: [
                      "ForAll",
                      "x",
                      ["ForAll", ["Element", "y", "RealNumbers"], ["Less", "x", ["Add", "y", 1]]],
                    ],
                  },
                },
              ],
            },
            conclusion: { expression: ["Less", "x", "y"] },
          },
        },
      ],
      obligations: [],
    });
    const result = applyTransition(input, {
      expectedStateId: "state:before",
      resultStateId: "state:after",
      target: { kind: "goal", id: "goal:0" },
      kind: "instantiate-universal-hypothesis",
      hypothesisId: "hypothesis:universal",
      term: "y",
      resultHypothesisId: "hypothesis:instance",
    });
    expect(result).toMatchObject({
      ok: true,
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
                      expression: [
                        "ForAll",
                        ["Element", "y_1", "RealNumbers"],
                        ["Less", "y", ["Add", "y_1", 1]],
                      ],
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

  it("matches result conclusions through typed binders, binding parameters in domains", () => {
    const result = {
      id: "result:below-every-member",
      parameters: [
        { symbol: "A", sort: realSet },
        { symbol: "c", sort: real },
      ],
      premises: [],
      conclusion: { expression: ["ForAll", ["Element", "t", "A"], ["Less", "c", "t"]] },
      directions: ["backward"],
    };
    expect(
      matchResultConclusion(result, {
        expression: ["ForAll", ["Element", "s", "RealNumbers"], ["Less", "x", "s"]],
      }),
    ).toMatchObject({ ok: true, instantiation: { A: "RealNumbers", c: "x" } });
    // A parameter cannot match the binder's own bound symbol.
    expect(
      matchResultConclusion(result, {
        expression: ["ForAll", ["Element", "s", "RealNumbers"], ["Less", "s", "s"]],
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "conclusion-mismatch" }] });
  });
});
