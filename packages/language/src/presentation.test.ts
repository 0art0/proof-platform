import { describe, expect, it } from "vitest";
import type { PlainMathJson } from "@proof/mathjson-model";
import { createPresentation } from "./index";
import { NUMBER_THEORY_PACK } from "./terminology";
import { INTEGER, OPERATORS, declare } from "./test-fixtures";

describe("createPresentation", () => {
  const presentation = createPresentation({
    operators: OPERATORS,
    dictionaries: [NUMBER_THEORY_PACK],
    overrides: [{ expression: ["Divides", 2, "n"], text: "$n$ is even" }],
  });
  const statement: PlainMathJson = [
    "ForAll",
    "n",
    ["Implies", ["Divides", 2, "n"], ["Equal", ["Gcd", "n", 2], 2]],
  ];

  it("renders one statement to LaTeX and natural language from one registry", () => {
    const rendered = presentation.render(statement, { declarations: [declare("n", INTEGER)] });
    expect(rendered).toEqual({
      expression: statement,
      latex:
        "\\forall n, \\left(2 \\divides n \\implies \\operatorname{gcd}\\left(n, 2\\right) = 2\\right)",
      naturalLanguage:
        "for every integer $n$, if $n$ is even, then the greatest common divisor of $n$ and $2$ is equal to $2$",
    });
    expect(rendered.expression).toBe(statement);
    expect(Object.isFrozen(rendered)).toBe(true);
    expect(Object.isFrozen(presentation)).toBe(true);
  });

  it("parses what it serializes", () => {
    const parsed = presentation.parseLatex(presentation.latex(statement));
    expect(parsed).toEqual({ ok: true, expression: statement, diagnostics: [] });
  });

  it("does not mutate its inputs", () => {
    const input: PlainMathJson = ["Divides", ["Add", "a", 1], "b"];
    const before = JSON.stringify(input);
    presentation.latex(input);
    presentation.naturalLanguage(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
