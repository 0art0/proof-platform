import { describe, expect, it } from "vitest";
import { createPresentation } from "@proof/language";
import { operatorDeclarationSchema, type PlainMathJson } from "@proof/mathjson-model";
import { renderInteractiveLatex } from "./mathlive-selection";
import { splitNaturalLanguage } from "./presentation";

const PRECEDES = operatorDeclarationSchema.parse({
  id: "operator:precedes",
  symbol: "Precedes",
  signature: {
    parameters: [
      { kind: "named", id: "sort:real" },
      { kind: "named", id: "sort:real" },
    ],
    result: { kind: "proposition" },
  },
  presentation: {
    displayName: "precedes",
    latex: { template: "#2 \\succ #1", precedence: "relation" },
    naturalLanguage: [{ template: "#1 precedes #2" }],
  },
});

describe("splitNaturalLanguage", () => {
  it("separates inline mathematics from prose", () => {
    expect(splitNaturalLanguage("for every $x$, $x > 0$")).toEqual([
      { kind: "text", value: "for every " },
      { kind: "math", value: "x" },
      { kind: "text", value: ", " },
      { kind: "math", value: "x > 0" },
    ]);
  });

  it("treats an unmatched dollar sign as prose", () => {
    expect(splitNaturalLanguage("costs $5")).toEqual([
      { kind: "text", value: "costs " },
      { kind: "text", value: "5" },
    ]);
  });
});

/**
 * Why MathLive fields keep `renderMathJson`: the interactive projection annotates leaves by
 * scanning the LaTeX left to right in operand-path order. A presentation template may place
 * operands in any order, so the registry's LaTeX cannot back that annotation.
 */
describe("interactive LaTeX projection", () => {
  const expression: PlainMathJson = ["Precedes", "a", "b"];

  it("would misorder leaves under a reordering presentation template", () => {
    const latex = createPresentation({ operators: [PRECEDES] }).latex(expression);
    expect(latex).toBe("b \\succ a");
    expect(latex.indexOf("b")).toBeLessThan(latex.indexOf("a"));
  });

  it("keeps annotating every leaf occurrence in path order with the raw projection", () => {
    const annotated = renderInteractiveLatex(expression);
    expect(annotated).toContain("proof-path-1=0}{a}");
    expect(annotated).toContain("proof-path-1=1}{b}");
    expect(annotated.indexOf("proof-path-1=0")).toBeLessThan(annotated.indexOf("proof-path-1=1"));
  });
});
