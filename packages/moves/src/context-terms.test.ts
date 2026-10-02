import { describe, expect, it } from "vitest";
import type { PlainMathJson } from "@proof/mathjson-model";
import { boundSymbolsAtPath, statementOccurrences } from "./context-terms";

const conclusion = { kind: "conclusion" } as const;

function occurrencesOf(expression: PlainMathJson) {
  return statementOccurrences([{ statement: conclusion, expression }], []).map(
    ({ path, expression: found }) => ({ path, found }),
  );
}

describe("context terms under binder shapes", () => {
  it("binds the symbol of a typed quantifier and skips its declaration", () => {
    const expression: PlainMathJson = [
      "ForAll",
      ["Element", "x", "RealNumbers"],
      ["Less", "x", "a"],
    ];
    const found = occurrencesOf(expression);
    // The declaration operand is not a subexpression; `x` is bound, so only `a` is offered.
    expect(found.map(({ path }) => path)).toEqual([[], [1, 1]]);
    expect(boundSymbolsAtPath(expression, [1, 0], [])).toEqual(new Set(["x"]));
    expect(boundSymbolsAtPath(expression, [0], [])).toBeUndefined();
  });

  it("binds the index of a Sum over limits and of a typed Sum", () => {
    const limits: PlainMathJson = ["Sum", ["Multiply", "k", "n"], ["Limits", "k", 1, "n"]];
    expect(boundSymbolsAtPath(limits, [0, 0], [])).toEqual(new Set(["k"]));
    expect(occurrencesOf(limits).map(({ path }) => path)).toEqual([[], [0, 1]]);
    const typed: PlainMathJson = ["Sum", ["Multiply", "k", "n"], ["Element", "k", "S"]];
    expect(boundSymbolsAtPath(typed, [0], [])).toEqual(new Set(["k"]));
  });

  it("binds every Function parameter, whatever its declaration form", () => {
    const lambda: PlainMathJson = [
      "Function",
      ["Add", "s", "t", "a"],
      "s",
      ["Element", "t", "RealNumbers"],
    ];
    expect(boundSymbolsAtPath(lambda, [0, 1], [])).toEqual(new Set(["s", "t"]));
    expect(occurrencesOf(lambda).map(({ path }) => path)).toEqual([[], [0, 2]]);
  });

  it("binds the variable of an integral", () => {
    const integral: PlainMathJson = ["Integrate", ["Multiply", "u", "c"], ["Limits", "u", 0, 1]];
    expect(boundSymbolsAtPath(integral, [0, 1], [])).toEqual(new Set(["u"]));
    expect(occurrencesOf(integral).map(({ path }) => path)).toEqual([[], [0, 1]]);
  });

  it("keeps untyped quantifiers unchanged", () => {
    const expression: PlainMathJson = ["ForAll", "x", ["Less", "x", "a"]];
    expect(boundSymbolsAtPath(expression, [1, 0], [])).toEqual(new Set(["x"]));
    expect(occurrencesOf(expression).map(({ path }) => path)).toEqual([[], [1, 1]]);
  });
});
