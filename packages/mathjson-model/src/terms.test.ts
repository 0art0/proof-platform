import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PROPOSITION_SORT,
  binderShape,
  builtinBinderSorts,
  createStatementViewSchema,
  declarationSchema,
  freeSymbolNames,
  operatorDeclarationSchema,
  substituteMathJson,
  type Declaration,
  type PlainMathJson,
  type Sort,
} from "./index";

const real = { kind: "named", id: "sort:real" } as Sort;
const natural = { kind: "named", id: "sort:natural" } as Sort;
const integer = { kind: "named", id: "sort:integer" } as Sort;
const fn = (parameters: readonly Sort[], result: Sort): Sort => ({
  kind: "function",
  signature: { parameters, result },
});
const named = (id: string, ...args: readonly Sort[]): Sort =>
  ({ kind: "named", id, arguments: args }) as Sort;

function universal(symbol: string, sort: Sort): Declaration {
  return declarationSchema.parse({
    id: `decl:${symbol}`,
    symbol,
    sort,
    role: "universal-parameter",
  });
}

/** The golden environment: first- and higher-order variables of every new sort. */
const DECLARATIONS: readonly Declaration[] = [
  universal("x", real),
  universal("y", real),
  universal("n", natural),
  universal("i", integer),
  universal("p", PROPOSITION_SORT),
  universal("f", fn([real], real)),
  universal("P", fn([real], PROPOSITION_SORT)),
  universal("F", fn([fn([real], real)], real)),
  universal("S", named("sort:set", real)),
  universal("C", named("sort:set", fn([real], real))),
  universal("Q", named("sort:set", fn([real], PROPOSITION_SORT))),
  universal("L", named("sort:list", real)),
  universal("a", named("sort:sequence", real)),
  universal("T", named("sort:tuple", real, natural)),
];

const schema = createStatementViewSchema({ declarations: DECLARATIONS });
const valid = (expression: PlainMathJson): boolean => schema.safeParse({ expression }).success;

const REALS = "RealNumbers";

describe("term-language validation (golden)", () => {
  it.each<[string, PlainMathJson]>([
    ["legacy untyped quantifier", ["ForAll", "x", ["Less", "x", 1]]],
    [
      "typed quantifier over a standard set, with an undeclared bound symbol",
      ["ForAll", ["Element", "t", REALS], ["GreaterEqual", ["Power", "t", 2], 0]],
    ],
    [
      "typed existential over a declared set",
      ["Exists", ["Element", "t", "S"], ["Less", "t", "x"]],
    ],
    [
      "nested typed quantifiers",
      ["ForAll", ["Element", "t", "S"], ["ForAll", ["Element", "u", "S"], ["LessEqual", "t", "u"]]],
    ],
    [
      "quantification over functions, applied in head and Apply form",
      ["ForAll", ["Element", "g", "C"], ["Equal", ["g", "x"], ["Apply", "g", "x"]]],
    ],
    [
      "quantification over a declared predicate variable",
      ["ForAll", "P", ["Implies", ["P", "x"], ["P", "x"]]],
    ],
    ["quantification over a set of predicates", ["Exists", ["Element", "R", "Q"], ["R", "x"]]],
    [
      "quantification over propositions",
      ["ForAll", ["Element", "q", "Booleans"], ["Or", "q", ["Not", "q"]]],
    ],
    [
      "typed lambda literal",
      ["Equal", "f", ["Function", ["Add", "t", 1], ["Element", "t", REALS]]],
    ],
    [
      "untyped lambda parameter sorted by the expected function sort",
      ["Equal", "f", ["Function", ["Multiply", 2, "t"], "t"]],
    ],
    ["constant lambda checked against its expected sort", ["Equal", "f", ["Function", 1, "t"]]],
    [
      "application of a lambda literal",
      [
        "Equal",
        ["Apply", ["Function", ["Add", "t", 1], ["Element", "t", REALS]], "x"],
        ["Add", "x", 1],
      ],
    ],
    [
      "application of an untyped lambda sorted by its argument",
      ["Equal", ["Apply", ["Function", ["Add", "t", 1], "t"], "x"], "y"],
    ],
    [
      "binary lambda",
      [
        "Equal",
        [
          "Apply",
          ["Function", ["Add", "s", "t"], ["Element", "s", REALS], ["Element", "t", REALS]],
          "x",
          "y",
        ],
        "y",
      ],
    ],
    [
      "a higher-order functional applied to a lambda",
      ["Less", ["F", ["Function", ["Power", "t", 2], ["Element", "t", REALS]]], 1],
    ],
    ["a predicate lambda", ["Apply", ["Function", ["Less", "t", 0], ["Element", "t", REALS]], "x"]],
    ["tuple literal", ["Equal", "T", ["Tuple", "x", "n"]]],
    ["tuple of literals checked structurally", ["Equal", "T", ["Tuple", 1, 2]]],
    ["tuple projection", ["Equal", ["At", "T", 2], "n"]],
    ["set literal membership", ["Element", "x", ["Set", "x", "y"]]],
    ["empty set literal checked structurally", ["Equal", "S", ["Set"]]],
    ["set literal inclusion", ["SubsetEqual", ["Set", "x", 1], "S"]],
    ["list literal", ["Equal", "L", ["List", "x", 1]]],
    ["list indexing", ["Equal", ["At", "L", "n"], "x"]],
    ["sequence indexing", ["Less", ["At", "a", "n"], 1]],
    ["indexed family (function) indexing", ["Equal", ["At", "f", "x"], "y"]],
    ["finite sum", ["Equal", ["Sum", ["At", "a", "k"], ["Limits", "k", 1, "n"]], "x"]],
    ["integer-indexed product", ["Less", ["Product", "k", ["Limits", "k", "i", 3]], 5]],
    ["series", ["Equal", ["Sum", ["At", "a", "k"], ["Limits", "k", 0, "PositiveInfinity"]], "x"]],
    ["sum over a set", ["Less", ["Product", "t", ["Element", "t", "S"]], "x"]],
    ["definite integral", ["Equal", ["Integrate", ["f", "t"], ["Limits", "t", 0, 1]], "x"]],
    [
      "improper integral",
      ["Less", ["Integrate", ["f", "t"], ["Limits", "t", 0, "PositiveInfinity"]], "x"],
    ],
    [
      "limit of an untyped lambda at infinity",
      ["Equal", ["Limit", ["Function", ["Divide", 1, "t"], "t"], "PositiveInfinity"], 0],
    ],
    ["limit of a function variable at a point", ["Equal", ["Limit", "f", "x"], "y"]],
    [
      "limit of a sequence",
      [
        "Equal",
        [
          "Limit",
          ["Function", ["At", "a", "m"], ["Element", "m", "NonNegativeIntegers"]],
          "PositiveInfinity",
        ],
        "x",
      ],
    ],
  ])("accepts %s", (_label, expression) => {
    expect(valid(expression)).toBe(true);
  });

  it.each<[string, PlainMathJson]>([
    ["an untyped quantifier over an undeclared symbol", ["ForAll", "t", ["Less", "t", 1]]],
    ["a typed domain that is not a set", ["ForAll", ["Element", "t", "x"], ["Less", "t", 1]]],
    [
      "a domain that mentions its own bound symbol",
      ["ForAll", ["Element", "t", "t"], ["Less", "t", 1]],
    ],
    ["a reserved bound symbol", ["ForAll", ["Element", "Sum", "S"], "True"]],
    ["an object-prototype key as a domain", ["ForAll", ["Element", "t", "constructor"], "True"]],
    ["a term-valued quantifier body", ["ForAll", ["Element", "t", "S"], "t"]],
    ["a quantifier over a summation range", ["ForAll", ["Limits", "k", 1, "n"], "True"]],
    ["a malformed typed declaration", ["ForAll", ["Element", "t", "S", "S"], "True"]],
    ["a lambda without parameters", ["Equal", "f", ["Function", "x"]]],
    [
      "a lambda with duplicate parameters",
      [
        "Equal",
        ["Apply", ["Function", "s", ["Element", "s", REALS], ["Element", "s", REALS]], "x", "y"],
        "x",
      ],
    ],
    ["a lambda of the wrong sort", ["Equal", "f", ["Function", ["Less", "t", 0], "t"]]],
    ["application with the wrong arity", ["Equal", ["Apply", "f", "x", "y"], "x"]],
    ["application of a non-function", ["Equal", ["Apply", "x", "y"], "x"]],
    ["application to an argument of the wrong sort", ["Equal", ["Apply", "F", "x"], "x"]],
    ["a heterogeneous set literal", ["Element", "x", ["Set", "x", "p"]]],
    ["an empty tuple", ["Equal", "T", ["Tuple"]]],
    ["a tuple projection out of range", ["Equal", ["At", "T", 3], "x"]],
    ["a tuple projection by a variable", ["Equal", ["At", "T", "n"], "x"]],
    ["list indexing by a real", ["Equal", ["At", "L", "x"], "x"]],
    ["a sum over real bounds", ["Less", ["Sum", "k", ["Limits", "k", 0, "x"]], 1]],
    ["a sum of propositions", ["Less", ["Sum", ["Less", "k", 1], ["Limits", "k", 1, "n"]], 1]],
    [
      "a sum with only infinite bounds",
      ["Less", ["Sum", 1, ["Limits", "k", "NegativeInfinity", "PositiveInfinity"]], 1],
    ],
    ["an integral over a set", ["Less", ["Integrate", "t", ["Element", "t", "S"]], 1]],
    ["a limit of a predicate", ["Equal", ["Limit", "P", "x"], "y"]],
    ["a stray Limits node", ["Equal", ["Limits", "k", 1, 2], "x"]],
    ["infinity as an ordinary term", ["Less", "x", "PositiveInfinity"]],
  ])("rejects %s", (_label, expression) => {
    expect(valid(expression)).toBe(false);
  });

  it("does not accept reserved term-language heads as declarations", () => {
    for (const symbol of ["Function", "Apply", "Sum", "Limits", "RealNumbers", "Set"]) {
      expect(
        declarationSchema.safeParse({
          id: "decl:reserved",
          symbol,
          sort: real,
          role: "universal-parameter",
        }).success,
      ).toBe(false);
    }
  });

  it("reports the sorts a built-in binder introduces", () => {
    const bindings = new Map(
      DECLARATIONS.map((declaration) => [declaration.symbol, declaration.sort]),
    );
    expect(builtinBinderSorts("ForAll", [["Element", "g", "C"], "True"], bindings, [])).toEqual(
      new Map([["g", fn([real], real)]]),
    );
    expect(builtinBinderSorts("Sum", ["k", ["Limits", "k", 1, "n"]], bindings, [])).toEqual(
      new Map([["k", natural]]),
    );
    expect(builtinBinderSorts("Sum", ["k", ["Limits", "k", 1, "x"]], bindings, [])).toBeUndefined();
    expect(builtinBinderSorts("Add", ["x", "y"], bindings, [])).toBeUndefined();
  });

  it("resolves variadic lambda shapes", () => {
    expect(binderShape("Function", 3, [])).toMatchObject({
      boundOperands: [1, 2],
      scopedOperands: [0],
    });
    expect(binderShape("Limit", 2, [])).toBeUndefined();
  });
});

describe("free names and substitution under the new binders (golden)", () => {
  it.each<[string, PlainMathJson, readonly string[]]>([
    [
      "a typed domain is outside its own scope",
      ["ForAll", ["Element", "x", "x"], ["P", "x"]],
      ["P", "x"],
    ],
    [
      "summation bounds are outside the index scope",
      ["Sum", ["Multiply", "k", "c"], ["Limits", "k", "k", "n"]],
      ["c", "k", "n"],
    ],
    ["lambda parameters", ["Function", ["f", "x", "y"], "x", ["Element", "y", "S"]], ["S", "f"]],
    [
      "integration variable",
      ["Integrate", ["f", "t", "u"], ["Limits", "t", "a", "b"]],
      ["a", "b", "f", "u"],
    ],
    ["a limit binds through its lambda", ["Limit", ["Function", ["g", "t"], "t"], "t"], ["g", "t"]],
    [
      "constructors and standard sets are not free",
      ["Element", ["Tuple", "u", 1], "RealNumbers"],
      ["u"],
    ],
  ])("%s", (_label, expression, expected) => {
    expect(freeSymbolNames(expression)).toEqual(expected);
  });

  it("alpha-renames a typed binder without touching its outer domain", () => {
    const result = substituteMathJson(
      ["ForAll", ["Element", "y", "y"], ["Less", "x", "y"]],
      [
        { symbol: "x", replacement: "y" },
        { symbol: "y", replacement: "z" },
      ],
    );
    expect(result).toMatchObject({
      ok: true,
      expression: ["ForAll", ["Element", "y_1", "z"], ["Less", "y", "y_1"]],
      alphaRenamings: [{ binderPath: [], from: "y", to: "y_1" }],
    });
  });

  it("substitutes summation bounds in the outer scope and renames the index", () => {
    const result = substituteMathJson(
      ["Sum", ["Multiply", "x", "k"], ["Limits", "k", "k", "n"]],
      [{ symbol: "x", replacement: "k" }],
    );
    expect(result).toMatchObject({
      ok: true,
      expression: ["Sum", ["Multiply", "k", "k_1"], ["Limits", "k_1", "k", "n"]],
    });
  });

  it("renames lambda parameters in object form and keeps metadata", () => {
    const result = substituteMathJson(
      { fn: ["Function", ["Add", "x", "t"], { sym: "t", comment: "parameter" }] },
      [{ symbol: "x", replacement: ["Multiply", 2, "t"] }],
    );
    expect(result).toMatchObject({
      ok: true,
      expression: {
        fn: [
          "Function",
          ["Add", ["Multiply", 2, "t"], "t_1"],
          { sym: "t_1", comment: "parameter" },
        ],
      },
    });
  });

  it("rejects malformed new binders atomically", () => {
    for (const expression of [
      ["Sum", "k", "k"],
      ["Function", "x"],
      ["Integrate", "t", ["Element", "t", "S"]],
      ["Exists", ["Element", "t", "S", "S"], "True"],
    ] as const) {
      const result = substituteMathJson(expression, [{ symbol: "S", replacement: "T" }]);
      expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-binder" }] });
      expect(result.expression).toBe(expression);
    }
  });

  it("validates a capture-renamed typed quantifier without declaring the fresh name", () => {
    const declarations = [universal("x", real), universal("S", named("sort:set", real))];
    const typedSchema = createStatementViewSchema({ declarations });
    const expression: PlainMathJson = ["ForAll", ["Element", "y", "S"], ["Less", "x", "y"]];
    const result = substituteMathJson(expression, [{ symbol: "x", replacement: ["Add", "y", 1] }]);
    expect(result.ok).toBe(true);
    // y is now free and must be declared, but the fresh bound name y_1 needs no declaration.
    const withY = createStatementViewSchema({
      declarations: [...declarations, universal("y", real)],
    });
    expect(typedSchema.safeParse({ expression }).success).toBe(true);
    expect(withY.safeParse({ expression: result.expression }).success).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Properties: capture avoidance under every binder kind.                                     */
/* ------------------------------------------------------------------------------------------ */

const NAMES = ["x", "y", "z", "w"] as const;

const CUSTOM_BINDER = operatorDeclarationSchema.parse({
  id: "operator:big",
  symbol: "Big",
  signature: { parameters: [real, real, real], result: real },
  binder: { kind: "direct-symbols", boundOperands: [0], scopedOperands: [2] },
});
const OPERATORS = [CUSTOM_BINDER];

const nameArbitrary = fc.constantFrom(...NAMES);

/**
 * Real-sorted terms and propositions over the name pool using every binder kind. When `typed`,
 * every binder carries its own sort, so the result is well-sorted with only the pool and `S`
 * declared.
 */
function languageArbitraries(typed: boolean) {
  return fc.letrec<{ term: PlainMathJson; proposition: PlainMathJson }>((tie) => {
    const term = tie("term");
    const proposition = tie("proposition");
    const domain = fc.constantFrom<PlainMathJson>("S", REALS);
    const binderTerms = [
      fc
        .tuple(term, nameArbitrary, domain)
        .map(([body, name, set]): PlainMathJson => ["Sum", body, ["Element", name, set]]),
      fc
        .tuple(term, nameArbitrary, domain)
        .map(([body, name, set]): PlainMathJson => ["Product", body, ["Element", name, set]]),
      fc
        .tuple(term, nameArbitrary, term, term)
        .map(([body, name, lower, upper]): PlainMathJson => [
          "Integrate",
          body,
          ["Limits", name, lower, upper],
        ]),
      fc
        .tuple(term, nameArbitrary, domain, term)
        .map(([body, name, set, argument]): PlainMathJson => [
          "Apply",
          ["Function", body, ["Element", name, set]],
          argument,
        ]),
      fc
        .tuple(term, nameArbitrary, nameArbitrary, term, term)
        .filter(([, first, second]) => first !== second)
        .map(([body, first, second, left, right]): PlainMathJson => [
          "Apply",
          ["Function", body, ["Element", first, REALS], ["Element", second, "S"]],
          left,
          right,
        ]),
      fc
        .tuple(term, nameArbitrary, term)
        .map(([body, name, point]): PlainMathJson => [
          "Limit",
          ["Function", body, typed ? ["Element", name, REALS] : name],
          point,
        ]),
    ];
    if (!typed) {
      binderTerms.push(
        fc
          .tuple(nameArbitrary, term, term)
          .map(([name, outer, body]): PlainMathJson => ["Big", name, outer, body]),
        fc
          .tuple(term, nameArbitrary, term, term)
          .map(([body, name, lower, upper]): PlainMathJson => [
            "Sum",
            body,
            ["Limits", name, lower, upper],
          ]),
      );
    }
    const quantifiers = [
      fc
        .tuple(fc.constantFrom("ForAll", "Exists"), nameArbitrary, domain, proposition)
        .map(([quantifier, name, set, body]): PlainMathJson => [
          quantifier,
          ["Element", name, set],
          body,
        ]),
    ];
    if (!typed) {
      quantifiers.push(
        fc
          .tuple(fc.constantFrom("ForAll", "Exists"), nameArbitrary, proposition)
          .map(([quantifier, name, body]): PlainMathJson => [quantifier, name, body]),
      );
    }
    return {
      term: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        nameArbitrary,
        fc.integer({ min: 0, max: 3 }),
        fc.tuple(term, term).map(([left, right]): PlainMathJson => ["Add", left, right]),
        ...binderTerms,
      ),
      proposition: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.tuple(term, term).map(([left, right]): PlainMathJson => ["Less", left, right]),
        fc
          .tuple(proposition, proposition)
          .map(([left, right]): PlainMathJson => ["And", left, right]),
        ...quantifiers,
      ),
    };
  });
}

const untyped = languageArbitraries(false);
const typed = languageArbitraries(true);

describe("capture-avoiding substitution properties", () => {
  it("obeys the free-name law for every binder kind", () => {
    fc.assert(
      fc.property(
        fc.oneof(untyped.term, untyped.proposition),
        nameArbitrary,
        untyped.term,
        (expression, target, replacement) => {
          const environment = { operators: OPERATORS };
          const result = substituteMathJson(
            expression,
            [{ symbol: target, replacement }],
            environment,
          );
          expect(result.ok).toBe(true);
          const before = freeSymbolNames(expression, environment);
          const expected = new Set(before.filter((name) => name !== target));
          if (before.includes(target)) {
            freeSymbolNames(replacement, environment).forEach((name) => expected.add(name));
          }
          // No free name of the replacement is captured, and no other free name changes.
          expect(freeSymbolNames(result.expression, environment)).toEqual(
            [...expected].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it("leaves an expression unchanged when the target is not free", () => {
    fc.assert(
      fc.property(
        fc.oneof(untyped.term, untyped.proposition),
        untyped.term,
        (expression, replacement) => {
          const result = substituteMathJson(expression, [{ symbol: "absent", replacement }], {
            operators: OPERATORS,
          });
          expect(result).toMatchObject({ ok: true, alphaRenamings: [] });
          expect(result.expression).toBe(expression);
        },
      ),
    );
  });

  it("preserves well-sortedness under typed binders without declaring fresh names", () => {
    const declarations = [
      ...NAMES.map((name) => universal(name, real)),
      universal("S", named("sort:set", real)),
    ];
    const typedSchema = createStatementViewSchema({ declarations });
    fc.assert(
      fc.property(
        typed.proposition,
        nameArbitrary,
        typed.term,
        (expression, target, replacement) => {
          fc.pre(typedSchema.safeParse({ expression }).success);
          const result = substituteMathJson(expression, [{ symbol: target, replacement }]);
          expect(result.ok).toBe(true);
          expect(typedSchema.safeParse({ expression: result.expression }).success).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("generates well-sorted typed statements", () => {
    const declarations = [
      ...NAMES.map((name) => universal(name, real)),
      universal("S", named("sort:set", real)),
    ];
    const typedSchema = createStatementViewSchema({ declarations });
    fc.assert(
      fc.property(typed.proposition, (expression) => {
        expect(typedSchema.safeParse({ expression }).success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
