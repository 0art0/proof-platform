import { describe, expect, it } from "vitest";
import { mathJsonEquals, type PlainMathJson } from "@proof/mathjson-model";
import { createLatexRenderer, parseLatex } from "./latex";
import { OPERATORS } from "./test-fixtures";

const renderer = createLatexRenderer({ operators: OPERATORS });

describe("LaTeX serialization goldens", () => {
  it.each<[string, PlainMathJson, string]>([
    ["sum", ["Add", "x", 1], "x+1"],
    ["negative terms", ["Add", "x", ["Negate", "y"], -3], "x-y-3"],
    ["nested sum as a term", ["Add", "a", ["Add", "b", "c"]], "a+\\left(b+c\\right)"],
    ["difference", ["Subtract", "a", ["Subtract", "b", "c"]], "a-\\left(b-c\\right)"],
    ["left-nested difference", ["Subtract", ["Subtract", "a", "b"], "c"], "a-b-c"],
    ["subtracted negation", ["Subtract", "a", ["Negate", "b"]], "a-\\left(-b\\right)"],
    ["coefficient", ["Multiply", 2, "x"], "2x"],
    [
      "product",
      ["Multiply", "a", ["Add", "b", "c"], ["Negate", "d"]],
      "a\\cdot \\left(b+c\\right)\\cdot \\left(-d\\right)",
    ],
    ["leading negation in a product", ["Multiply", ["Negate", "a"], "b"], "-a\\cdot b"],
    ["negated product", ["Negate", ["Multiply", "a", "b"]], "-\\left(a\\cdot b\\right)"],
    ["negated power", ["Negate", ["Power", "a", 2]], "-a^{2}"],
    ["fraction", ["Divide", ["Add", "a", "b"], "c"], "\\frac{a+b}{c}"],
    ["power of a fraction", ["Power", ["Divide", 1, "x"], 2], "\\left(\\frac{1}{x}\\right)^{2}"],
    ["power of a negation", ["Power", ["Negate", "x"], 2], "\\left(-x\\right)^{2}"],
    ["tower", ["Power", "a", ["Power", "b", "c"]], "a^{b^{c}}"],
    ["absolute value", ["Abs", ["Subtract", "x", "y"]], "\\left|x-y\\right|"],
    ["negated relation", ["Not", ["Equal", "x", "y"]], "\\lnot \\left(x = y\\right)"],
    ["double negation", ["Not", ["Not", "p"]], "\\lnot \\lnot p"],
    [
      "conjunction of disjunction",
      ["And", ["Or", "p", "q"], ["Not", "r"]],
      "\\left(p \\lor q\\right) \\land \\lnot r",
    ],
    ["disjunction of conjunctions", ["Or", ["And", "p", "q"], "r"], "p \\land q \\lor r"],
    [
      "implication chain",
      ["Implies", ["Implies", "p", "q"], ["Implies", "q", "r"]],
      "\\left(p \\implies q\\right) \\implies q \\implies r",
    ],
    [
      "nested equivalence",
      ["Equivalent", "p", ["Equivalent", "q", "r"]],
      "p \\iff \\left(q \\iff r\\right)",
    ],
    [
      "quantifier with a connective body",
      ["ForAll", "x", ["And", ["Greater", "x", 0], ["Less", "x", 1]]],
      "\\forall x, \\left(x > 0 \\land x < 1\\right)",
    ],
    [
      "quantifier inside a conjunction",
      ["And", ["ForAll", "x", ["Greater", "x", 0]], "p"],
      "\\left(\\forall x, x > 0\\right) \\land p",
    ],
    [
      "typed binder",
      ["ForAll", ["Element", "x", "RealNumbers"], ["GreaterEqual", ["Power", "x", 2], 0]],
      "\\forall x \\in \\R, x^{2} \\ge 0",
    ],
    [
      "nested quantifiers",
      ["ForAll", "x", ["Exists", "y", ["Less", "x", "y"]]],
      "\\forall x, \\exists y, x < y",
    ],
    ["relation chain", ["LessEqual", "a", "b", "c"], "a \\le b \\le c"],
    ["membership", ["NotElement", "x", "S"], "x \\notin S"],
    ["subset", ["SubsetEqual", "A", "B"], "A \\subseteq B"],
    ["declared function", ["f", "x", ["Add", "y", 1]], "f(x, y+1)"],
    ["multi-letter function", ["Foo", "x"], "\\operatorname{Foo}(x)"],
    ["truth", ["And", "True", "False"], "\\top \\land \\bot"],
    [
      "custom atom template",
      ["Gcd", "a", ["Add", "b", 1]],
      "\\operatorname{gcd}\\left(a, b+1\\right)",
    ],
    ["custom infix template", ["Divides", ["Add", "a", 1], "b"], "a+1 \\divides b"],
    ["custom prefix template", ["IsPrime", ["Add", "n", 1]], "\\isprime \\left(n+1\\right)"],
    [
      "custom binder template",
      ["SumOverDivisors", "k", "n", ["Power", "k", 2]],
      "\\sum_{k \\mid n} k^{2}",
    ],
    ["custom operator without a template", ["Totient", "n"], "\\operatorname{Totient}(n)"],
    ["standard head delegated", ["Sin", ["Add", "x", 1]], "\\sin(x+1)"],
    [
      "custom operator inside a delegated head",
      ["Sin", ["Gcd", "a", "b"]],
      "\\sin(\\operatorname{gcd}\\left(a, b\\right))",
    ],
    [
      "custom operator inside a big operator",
      ["Sum", ["Gcd", "k", "n"], ["Tuple", "k", 1, "n"]],
      "\\sum_{k=1}^{n}\\operatorname{gcd}\\left(k, n\\right)",
    ],
    ["decimal", { num: "1.5" }, "1.5"],
    ["greek symbol", "alpha", "\\alpha"],
    ["object forms", { fn: ["Add", { sym: "x" }, 1] }, "x+1"],
  ])("%s", (_label, expression, latex) => {
    expect(renderer.serialize(expression)).toBe(latex);
  });

  it("is total on malformed input", () => {
    expect(renderer.serialize(Number.NaN as PlainMathJson)).toBe("\\text{?}");
    expect(renderer.serialize(["Not", "p", "q"])).toBeTypeOf("string");
  });

  it("rejects invalid operator environments", () => {
    expect(() =>
      createLatexRenderer({ operators: [OPERATORS[0], OPERATORS[0]] as never }),
    ).toThrow();
  });
});

describe("LaTeX parsing", () => {
  const roundTrip: readonly PlainMathJson[] = [
    ["Add", "x", 1],
    ["Subtract", "a", ["Subtract", "b", "c"]],
    ["Add", ["Subtract", "a", "b"], "c"],
    ["Multiply", 2, "x"],
    ["Multiply", "a", ["Add", "b", "c"], ["Negate", "d"]],
    ["Multiply", ["Negate", "a"], "b"],
    ["Negate", ["Multiply", "a", "b"]],
    ["Power", ["Negate", "x"], 2],
    ["Power", "x", ["Add", "n", 1]],
    ["Divide", ["Add", "a", "b"], "c"],
    ["Abs", ["Subtract", "x", "y"]],
    ["Not", ["Equal", "x", "y"]],
    ["And", ["Or", "p", "q"], ["Not", "r"]],
    ["Or", ["And", "p", "q"], "r"],
    ["Implies", ["Implies", "p", "q"], ["Implies", "q", "r"]],
    ["Equivalent", "p", ["Equivalent", "q", "r"]],
    ["ForAll", "x", ["And", ["Greater", "x", 0], ["Less", "x", 1]]],
    ["And", ["ForAll", "x", ["Greater", "x", 0]], "p"],
    ["ForAll", ["Element", "x", "RealNumbers"], ["GreaterEqual", ["Power", "x", 2], 0]],
    ["ForAll", "x", ["Exists", "y", ["Less", "x", "y"]]],
    ["LessEqual", "a", "b", "c"],
    ["NotEqual", "x", "y"],
    ["Element", "x", "S"],
    ["NotElement", "x", "S"],
    ["Subset", "A", "B"],
    ["SupersetEqual", "A", "B"],
    ["Exists", "y", ["Equal", ["f", "y"], "x"]],
    ["f", "x", "y"],
    ["Foo", "x"],
    ["And", "True", "False"],
    ["Sin", ["Add", "x", 1]],
    ["Totient", "n"],
    ["Gcd", "a", ["Add", "b", 1]],
    ["Equal", ["Gcd", "a", "b"], 1],
    ["Divides", ["Add", "a", 1], "b"],
    ["Implies", ["Divides", "a", "b"], ["LessEqual", "a", "b"]],
    ["IsPrime", ["Add", "n", 1]],
    ["Not", ["IsPrime", "n"]],
  ];

  it.each(roundTrip.map((expression) => [JSON.stringify(expression), expression] as const))(
    "round-trips %s",
    (_label, expression) => {
      const latex = renderer.serialize(expression);
      const parsed = renderer.parse(latex);
      expect(parsed.ok, latex).toBe(true);
      if (!parsed.ok) return;
      expect(mathJsonEquals(parsed.expression, expression), JSON.stringify(parsed.expression)).toBe(
        true,
      );
      expect(Object.isFrozen(parsed.expression)).toBe(true);
    },
  );

  it("parses custom triggers only when the operator is registered", () => {
    const withOperators = parseLatex("\\operatorname{gcd}\\left(a, b\\right)", {
      operators: OPERATORS,
    });
    expect(withOperators).toEqual({ ok: true, expression: ["Gcd", "a", "b"], diagnostics: [] });
    const standard = parseLatex("\\operatorname{gcd}\\left(a, b\\right)");
    expect(standard.ok && standard.expression).toEqual(["GCD", "a", "b"]);
  });

  it("normalizes juxtaposition, grouping and numerals", () => {
    const parse = (latex: string) => {
      const result = parseLatex(latex);
      return result.ok ? result.expression : result.diagnostics;
    };
    expect(parse("\\forall x, x>0")).toEqual(["ForAll", "x", ["Greater", "x", 0]]);
    expect(parse("P(x)\\land Q")).toEqual(["And", ["P", "x"], "Q"]);
    expect(parse("3y")).toEqual(["Multiply", 3, "y"]);
    expect(parse("((a))")).toBe("a");
  });

  it("reports empty and malformed input", () => {
    expect(parseLatex("  ")).toEqual({
      ok: false,
      diagnostics: [{ code: "empty-input", message: "The LaTeX is empty." }],
    });
    const malformed = parseLatex("\\frac{1}{");
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.diagnostics[0]?.code).toBe("parse-error");
  });
});
