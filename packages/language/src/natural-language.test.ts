import { describe, expect, it } from "vitest";
import {
  PROPOSITION_SORT,
  operatorDeclarationSchema,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { createNaturalLanguageRenderer, type NaturalLanguageContext } from "./natural-language";
import {
  NUMBER_THEORY_PACK,
  type ExactEntry,
  articleFor,
  naturalLanguageDictionarySchema,
  pluralize,
} from "./terminology";
import { INTEGER, NATURAL, OPERATORS, REAL, declare, namedSort } from "./test-fixtures";

const context: NaturalLanguageContext = {
  declarations: [
    declare("x", REAL),
    declare("y", REAL),
    declare("z", REAL),
    declare("m", INTEGER),
    declare("n", INTEGER),
    declare("k", NATURAL),
    declare("A", namedSort("sort:set", REAL)),
    declare("G", namedSort("sort:group")),
    declare("H", namedSort("sort:group")),
    declare("P", PROPOSITION_SORT),
  ],
};

const renderer = createNaturalLanguageRenderer({ operators: OPERATORS });
const say = (expression: PlainMathJson, extra: NaturalLanguageContext = {}) =>
  renderer.statement(expression, { ...context, ...extra });

describe("statement constructors", () => {
  it.each<[string, PlainMathJson, string]>([
    ["implication", ["Implies", "p", "q"], "if $p$, then $q$"],
    ["equivalence", ["Equivalent", "p", "q"], "$p$ if and only if $q$"],
    ["conjunction", ["And", "p", "q"], "$p$ and $q$"],
    ["n-ary disjunction", ["Or", "p", "q", "r"], "$p$, $q$, or $r$"],
    ["generic negation", ["Not", "p"], "it is not the case that $p$"],
    ["negated conjunction", ["Not", ["And", "p", "q"]], "it is not the case that both $p$ and $q$"],
    ["conjunction inside disjunction", ["Or", ["And", "p", "q"], "r"], "both $p$ and $q$ or $r$"],
    ["disjunction inside conjunction", ["And", "p", ["Or", "q", "r"]], "$p$ and either $q$ or $r$"],
    [
      "nested markers",
      ["Or", ["And", "p", "q"], ["And", "r", "s"]],
      "both $p$ and $q$ or both $r$ and $s$",
    ],
    [
      "grouped n-ary coordination",
      ["And", ["Or", "p", "q", "r"], "s"],
      "($p$, $q$, or $r$) and $s$",
    ],
    [
      "implication inside conjunction",
      ["And", ["Implies", "p", "q"], "r"],
      "(if $p$, then $q$) and $r$",
    ],
    [
      "implication as antecedent",
      ["Implies", ["Implies", "p", "q"], "r"],
      "if (if $p$, then $q$), then $r$",
    ],
    [
      "implication as consequent",
      ["Implies", "p", ["Implies", "q", "r"]],
      "if $p$, then if $q$, then $r$",
    ],
    [
      "equivalence of a conjunction",
      ["Equivalent", ["And", "p", "q"], "r"],
      "both $p$ and $q$ if and only if $r$",
    ],
    [
      "negation inside conjunction",
      ["And", ["Not", "p"], "q"],
      "(it is not the case that $p$) and $q$",
    ],
    ["truth", "True", "$\\top$"],
  ])("%s", (_label, expression, text) => {
    expect(say(expression)).toBe(text);
  });
});

describe("relations", () => {
  it.each<[string, PlainMathJson, string]>([
    ["less", ["Less", "x", "y"], "$x$ is less than $y$"],
    [
      "greater or equal",
      ["GreaterEqual", ["Add", "x", 1], 0],
      "$x+1$ is greater than or equal to $0$",
    ],
    ["membership", ["Element", "x", "A"], "$x$ is an element of $A$"],
    ["membership in a number set", ["Element", "n", "Integers"], "$n$ is an integer"],
    ["negated equality", ["Not", ["Equal", "x", "y"]], "$x$ is not equal to $y$"],
    ["inequality", ["NotEqual", "x", "y"], "$x$ is not equal to $y$"],
    ["negated inequality", ["Not", ["NotEqual", "x", "y"]], "$x$ is equal to $y$"],
    [
      "negated number-set membership",
      ["Not", ["Element", "x", "RationalNumbers"]],
      "$x$ is not a rational number",
    ],
    ["subset", ["SubsetEqual", "A", "B"], "$A$ is a subset of $B$"],
    ["chain", ["Less", "x", "y", "z"], "$x < y < z$"],
    ["negated chain", ["Not", ["Less", "x", "y", "z"]], "it is not the case that $x < y < z$"],
  ])("%s", (_label, expression, text) => {
    expect(say(expression)).toBe(text);
  });

  it("supports a symbolic relation style", () => {
    const symbolic = createNaturalLanguageRenderer({ relationStyle: "symbols" });
    expect(symbolic.statement(["Not", ["Equal", "x", "y"]])).toBe("$x \\neq y$");
    expect(symbolic.statement(["Not", ["LessEqual", "x", "y"]])).toBe("$x \\not\\le y$");
    expect(symbolic.statement(["Implies", ["Less", "x", "y"], ["Element", "x", "S"]])).toBe(
      "if $x < y$, then $x \\in S$",
    );
  });
});

describe("construction placeholders", () => {
  const placeholderRenderer = createNaturalLanguageRenderer({
    operators: [
      ...OPERATORS,
      operatorDeclarationSchema.parse({
        id: "construction-placeholder:task:m",
        symbol: "ph",
        signature: { parameters: [REAL], result: REAL },
        presentation: { displayName: "δ" },
      }),
    ],
  });

  it("names a placeholder by its task, not as an application", () => {
    expect(placeholderRenderer.statement(["Less", ["ph", "x"], "y"], context)).toBe(
      "$\\boxed{δ}$ is less than $y$",
    );
    expect(
      placeholderRenderer.statement(
        ["And", ["Greater", ["ph", "x"], 0], ["Less", ["ph", "x"], "y"]],
        context,
      ),
    ).toBe("$\\boxed{δ}$ is greater than $0$ and $\\boxed{δ}$ is less than $y$");
  });
});

describe("quantifiers and sort nouns", () => {
  it.each<[string, PlainMathJson, string]>([
    [
      "universal",
      ["ForAll", "x", ["GreaterEqual", ["Power", "x", 2], 0]],
      "for every real number $x$, $x^{2}$ is greater than or equal to $0$",
    ],
    [
      "existential",
      ["Exists", "n", ["Greater", "n", 0]],
      "there exists an integer $n$ such that $n$ is greater than $0$",
    ],
    [
      "merged binders",
      ["ForAll", "x", ["ForAll", "y", ["Equal", ["Add", "x", "y"], ["Add", "y", "x"]]]],
      "for all real numbers $x$ and $y$, $x+y$ is equal to $y+x$",
    ],
    [
      "mixed binders",
      ["ForAll", "n", ["ForAll", "x", ["ForAll", "y", ["Less", "x", "y"]]]],
      "for every integer $n$ and all real numbers $x$ and $y$, $x$ is less than $y$",
    ],
    [
      "merged existential binders",
      ["Exists", "m", ["Exists", "n", ["Less", "m", "n"]]],
      "there exist integers $m$ and $n$ such that $m$ is less than $n$",
    ],
    [
      "article agreement",
      ["ForAll", "k", ["Exists", "n", ["Less", "k", "n"]]],
      "for every natural number $k$, there exists an integer $n$ such that $k$ is less than $n$",
    ],
    [
      "derived sort nouns",
      ["ForAll", "G", ["ForAll", "H", ["Equal", "G", "H"]]],
      "for all groups $G$ and $H$, $G$ is equal to $H$",
    ],
    [
      "set sorts",
      ["Exists", "A", ["Element", 0, "A"]],
      "there exists a set of real numbers $A$ such that $0$ is an element of $A$",
    ],
    [
      "proposition variables",
      ["ForAll", "P", ["Or", "P", ["Not", "P"]]],
      "for every proposition $P$, $P$ or it is not the case that $P$",
    ],
    [
      "undeclared variable",
      ["ForAll", "t", ["Equal", "t", "t"]],
      "for every $t$, $t$ is equal to $t$",
    ],
    [
      "typed binder over a number set",
      ["ForAll", ["Element", "t", "RealNumbers"], ["GreaterEqual", ["Abs", "t"], 0]],
      "for every real number $t$, $\\left|t\\right|$ is greater than or equal to $0$",
    ],
    [
      "typed binders over a set",
      ["ForAll", ["Element", "s", "S"], ["ForAll", ["Element", "t", "S"], ["Equal", "s", "t"]]],
      "for all elements $s$ and $t$ of $S$, $s$ is equal to $t$",
    ],
    [
      "negated existential",
      ["Not", ["Exists", "n", ["Equal", ["Multiply", 2, "n"], 1]]],
      "there is no integer $n$ such that $2n$ is equal to $1$",
    ],
    [
      "negated existential with several binders",
      ["Not", ["Exists", "m", ["Exists", "n", ["Equal", "m", "n"]]]],
      "there are no integers $m$ and $n$ such that $m$ is equal to $n$",
    ],
    [
      "quantifier as antecedent",
      ["Implies", ["ForAll", "x", ["Greater", "x", 0]], "P"],
      "if (for every real number $x$, $x$ is greater than $0$), then $P$",
    ],
    [
      "quantifier inside conjunction",
      ["And", ["Exists", "n", ["Greater", "n", 0]], "P"],
      "(there exists an integer $n$ such that $n$ is greater than $0$) and $P$",
    ],
  ])("%s", (_label, expression, text) => {
    expect(say(expression)).toBe(text);
  });

  it("applies plural and article rules", () => {
    expect(pluralize("real number")).toBe("real numbers");
    expect(pluralize("family")).toBe("families");
    expect(pluralize("matrix")).toBe("matrices");
    expect(articleFor({ singular: "integer" })).toBe("an");
    expect(articleFor({ singular: "unit" })).toBe("a");
    expect(articleFor({ singular: "hour" })).toBe("an");
    expect(articleFor({ singular: "ideal", article: "a" })).toBe("a");
  });
});

describe("dictionaries and templates", () => {
  it.each<[string, PlainMathJson, string]>([
    [
      "term template",
      ["Equal", ["Gcd", "m", "n"], 1],
      "the greatest common divisor of $m$ and $n$ is equal to $1$",
    ],
    [
      "nested term templates",
      ["Less", ["Gcd", ["Gcd", "m", "n"], 2], 3],
      "the greatest common divisor of the greatest common divisor of $m$ and $n$ and $2$ is less than $3$",
    ],
    [
      "term template inside inline math",
      ["Equal", ["Add", ["Gcd", "m", "n"], 1], 2],
      "$\\operatorname{gcd}\\left(m, n\\right)+1$ is equal to $2$",
    ],
    ["proposition template", ["Divides", "m", "n"], "$m$ divides $n$"],
    ["negated proposition template", ["Not", ["Divides", "m", "n"]], "$m$ does not divide $n$"],
    [
      "proposition template without negation",
      ["Not", ["IsPrime", "k"]],
      "it is not the case that $k$ is prime",
    ],
    [
      "binder template with math-mode placeholders",
      ["Equal", ["SumOverDivisors", "d", "n", ["Power", "d", 2]], "m"],
      "the sum of $d^{2}$ over all divisors $d$ of $n$ is equal to $m$",
    ],
    [
      "operator without a template",
      ["Equal", ["Totient", "n"], 4],
      "$\\operatorname{Totient}(n)$ is equal to $4$",
    ],
    ["unknown statement", ["Q", "x"], "$Q(x)$"],
    ["unknown standard head", ["Equal", ["Sin", "x"], 0], "$\\sin(x)$ is equal to $0$"],
  ])("%s", (_label, expression, text) => {
    expect(say(expression)).toBe(text);
  });

  it("uses domain packs for patterns and set nouns", () => {
    const withPack = createNaturalLanguageRenderer({
      operators: OPERATORS,
      dictionaries: [NUMBER_THEORY_PACK],
    });
    expect(withPack.statement(["Equal", ["Mod", "n", 2], 0])).toBe("$n$ is even");
    expect(withPack.statement(["Not", ["Equal", ["Mod", "n", 2], 1]])).toBe(
      "it is not the case that $n$ is odd",
    );
    expect(withPack.statement(["Implies", ["Element", "p", "Primes"], ["Greater", "p", 1]])).toBe(
      "if $p$ is a prime, then $p$ is greater than $1$",
    );
    expect(
      withPack.statement(["ForAll", ["Element", "p", "Primes"], ["Equal", ["GCD", "p", "p"], "p"]]),
    ).toBe("for every prime $p$, $\\gcd(p, p)$ is equal to $p$");
    expect(withPack.statement(["Equal", ["GCD", ["Add", "a", 1], "b"], 1])).toBe(
      "$a+1$ and $b$ are coprime",
    );
  });

  it("applies the precedence override > exact > pattern > operator > constructor", () => {
    const pattern = { pattern: ["Divides", "_a", "_b"], template: "#b is a multiple of #a" };
    const exact = { expression: ["Divides", 2, "n"], text: "$n$ is even" };
    const dictionaries = [
      naturalLanguageDictionarySchema.parse({ id: "dict:local", exact: [exact] }),
      naturalLanguageDictionarySchema.parse({ id: "dict:patterns", patterns: [pattern] }),
    ];
    const layered = createNaturalLanguageRenderer({ operators: OPERATORS, dictionaries });
    const override: ExactEntry = {
      expression: ["Divides", 2, "n"],
      text: "$n$ is divisible by two",
    };

    expect(layered.statement(["Divides", 2, "n"], { overrides: [override] })).toBe(
      "$n$ is divisible by two",
    );
    expect(layered.statement(["Divides", 2, "n"])).toBe("$n$ is even");
    expect(layered.statement(["Divides", 3, "n"])).toBe("$n$ is a multiple of $3$");
    expect(renderer.statement(["Divides", 3, "n"])).toBe("$3$ divides $n$");
    expect(createNaturalLanguageRenderer().statement(["Divides", 3, "n"])).toBe("$3\\mid n$");
    expect(
      createNaturalLanguageRenderer({ overrides: [override] }).statement({
        fn: ["Divides", 2, { sym: "n" }],
      }),
    ).toBe("$n$ is divisible by two");
  });

  it("uses dictionary entries for terms and repeated wildcards", () => {
    const dictionary = naturalLanguageDictionarySchema.parse({
      id: "dict:terms",
      exact: [{ expression: ["Exp", 1], text: "Euler's number" }],
      patterns: [{ pattern: ["Multiply", "_a", "_a"], template: "the square of #a" }],
      sortNouns: { "sort:group": { singular: "finite group" } },
    });
    const local = createNaturalLanguageRenderer({ dictionaries: [dictionary] });
    expect(local.statement(["Greater", ["Exp", 1], 2])).toBe("Euler's number is greater than $2$");
    expect(local.statement(["Equal", ["Multiply", "x", "x"], 4])).toBe(
      "the square of $x$ is equal to $4$",
    );
    expect(local.statement(["Equal", ["Multiply", "x", "y"], 4])).toBe(
      "$x\\cdot y$ is equal to $4$",
    );
    expect(local.statement(["ForAll", "G", ["Equal", "G", "G"]], context)).toBe(
      "for every finite group $G$, $G$ is equal to $G$",
    );
    expect(local.term(["Exp", 1])).toBe("Euler's number");
  });

  it("validates pattern templates against wildcards", () => {
    expect(
      naturalLanguageDictionarySchema.safeParse({
        id: "dict:bad",
        patterns: [{ pattern: ["Divides", "_a", "_b"], template: "#c divides #b" }],
      }).success,
    ).toBe(false);
  });

  it("is total", () => {
    expect(renderer.statement(Number.NaN as PlainMathJson)).toBe("$\\text{?}$");
    expect(renderer.statement(["Implies", "p"])).toBe("$\\operatorname{Implies}(p)$");
    expect(renderer.statement(["Equal", "x", "y"], { overrides: [{ bad: true }] as never })).toBe(
      "$x = y$",
    );
  });
});
