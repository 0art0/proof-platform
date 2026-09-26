import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PROPOSITION_SORT,
  operatorDeclarationsSchema,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { alphaEquivalent } from "./index";

const realSort = { kind: "named", id: "sort:real" } as const;
const operators = operatorDeclarationsSchema.parse([
  {
    id: "operator:scoped",
    symbol: "Scoped",
    signature: {
      parameters: [realSort, PROPOSITION_SORT, PROPOSITION_SORT],
      result: PROPOSITION_SORT,
    },
    binder: { kind: "direct-symbols", boundOperands: [0], scopedOperands: [1] },
  },
  {
    id: "operator:bind-pair",
    symbol: "BindPair",
    signature: { parameters: [realSort, realSort, PROPOSITION_SORT], result: PROPOSITION_SORT },
    binder: { kind: "direct-symbols", boundOperands: [0, 1], scopedOperands: [2] },
  },
]);

describe("alpha-equivalence", () => {
  it.each<[string, PlainMathJson, PlainMathJson, boolean]>([
    ["identical free symbols", "p", "p", true],
    ["different free symbols", "p", "q", false],
    [
      "renamed quantifier",
      ["ForAll", "x", ["P", "x", "y"]],
      ["ForAll", "z", ["P", "z", "y"]],
      true,
    ],
    [
      "capture of a free symbol",
      ["ForAll", "x", ["P", "x", "y"]],
      ["ForAll", "y", ["P", "y", "y"]],
      false,
    ],
    [
      "bound versus free occurrence",
      ["ForAll", "x", ["P", "x", "x"]],
      ["ForAll", "z", ["P", "z", "x"]],
      false,
    ],
    [
      "inner shadowing",
      ["ForAll", "x", ["Exists", "x", ["P", "x"]]],
      ["ForAll", "y", ["Exists", "z", ["P", "z"]]],
      true,
    ],
    [
      "outer reference under shadowing",
      ["ForAll", "x", ["Exists", "x", ["P", "x"]]],
      ["ForAll", "y", ["Exists", "z", ["P", "y"]]],
      false,
    ],
    ["different quantifiers", ["ForAll", "x", ["P", "x"]], ["Exists", "x", ["P", "x"]], false],
    ["bound function head", ["ForAll", "f", ["f", "a"]], ["ForAll", "g", ["g", "a"]], true],
    [
      "string versus object symbol",
      ["ForAll", "x", ["P", "x"]],
      ["ForAll", { sym: "y" }, ["P", "y"]],
      false,
    ],
    [
      "matching symbol metadata",
      ["ForAll", { sym: "x", comment: "c" }, ["P", { sym: "x", comment: "d" }]],
      ["ForAll", { sym: "y", comment: "c" }, ["P", { sym: "y", comment: "d" }]],
      true,
    ],
    [
      "different wrapper metadata",
      { fn: ["ForAll", "x", ["P", "x"]], comment: "left" },
      { fn: ["ForAll", "y", ["P", "y"]], comment: "right" },
      false,
    ],
    [
      "array versus object function form",
      ["ForAll", "x", ["P", "x"]],
      { fn: ["ForAll", "x", ["P", "x"]] },
      false,
    ],
    ["numbers compare exactly", ["Equal", 1, 1], ["Equal", 1, 2], false],
  ])("%s", (_label, left, right, expected) => {
    expect(alphaEquivalent(left, right)).toBe(expected);
    expect(alphaEquivalent(right, left)).toBe(expected);
  });

  it("follows custom binder scopes, including unscoped operands and multiple bound names", () => {
    const scoped: PlainMathJson = ["Scoped", "x", ["Equal", "x", "y"], ["Equal", "x", "z"]];
    expect(
      alphaEquivalent(scoped, ["Scoped", "w", ["Equal", "w", "y"], ["Equal", "x", "z"]], {
        operators,
      }),
    ).toBe(true);
    expect(
      alphaEquivalent(scoped, ["Scoped", "w", ["Equal", "w", "y"], ["Equal", "w", "z"]], {
        operators,
      }),
    ).toBe(false);
    // Without the declaration, Scoped is an ordinary function and its operands compare exactly.
    expect(alphaEquivalent(scoped, ["Scoped", "w", ["Equal", "w", "y"], ["Equal", "x", "z"]])).toBe(
      false,
    );

    const pair: PlainMathJson = ["BindPair", "a", "b", ["Less", "a", "b"]];
    expect(alphaEquivalent(pair, ["BindPair", "b", "a", ["Less", "b", "a"]], { operators })).toBe(
      true,
    );
    expect(alphaEquivalent(pair, ["BindPair", "b", "a", ["Less", "a", "b"]], { operators })).toBe(
      false,
    );
  });

  it("rejects an invalid operator environment", () => {
    expect(alphaEquivalent("p", "p", { operators: [{ symbol: "ForAll" }] as never })).toBe(false);
  });

  it("is invariant under consistent fresh renaming and detects capture", () => {
    const body = fc.letrec<{ body: PlainMathJson }>((tie) => ({
      body: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.constantFrom<PlainMathJson>("x", "p", "q"),
        fc.tuple(fc.constant("Not"), tie("body")),
        fc.tuple(fc.constantFrom("And", "Or", "Implies"), tie("body"), tie("body")),
        fc.tuple(fc.constant("Exists"), fc.constantFrom("x", "q"), tie("body")),
      ),
    })).body;

    fc.assert(
      fc.property(body, (generated) => {
        const original: PlainMathJson = ["ForAll", "x", generated];
        const renamed: PlainMathJson = ["ForAll", "w", renameFree(generated, "x", "w")];
        expect(alphaEquivalent(original, original)).toBe(true);
        expect(alphaEquivalent(original, renamed)).toBe(true);
        expect(alphaEquivalent(renamed, original)).toBe(true);

        // Renaming the bound x to p is an alpha-renaming exactly when p is not free in the body;
        // otherwise the free p would be captured.
        const captured: PlainMathJson = ["ForAll", "p", renameFree(generated, "x", "p")];
        expect(alphaEquivalent(original, captured)).toBe(!freeNames(generated).has("p"));
      }),
    );
  });
});

/** Rename free occurrences in the generated fragment, which binds only through Exists. */
function renameFree(expression: PlainMathJson, from: string, to: string): PlainMathJson {
  if (typeof expression === "string") return expression === from ? to : expression;
  if (!Array.isArray(expression)) return expression;
  const [head, ...operands] = expression as readonly PlainMathJson[];
  if (head === "Exists") {
    if (operands[0] === from) return expression;
    return [head, operands[0] as PlainMathJson, renameFree(operands[1] as PlainMathJson, from, to)];
  }
  return [head as string, ...operands.map((operand) => renameFree(operand, from, to))];
}

function freeNames(expression: PlainMathJson, bound: ReadonlySet<string> = new Set()): Set<string> {
  if (typeof expression === "string") {
    return bound.has(expression) ? new Set() : new Set([expression]);
  }
  if (!Array.isArray(expression)) return new Set();
  const [head, ...operands] = expression as readonly PlainMathJson[];
  if (head === "Exists") {
    return freeNames(operands[1] as PlainMathJson, new Set([...bound, operands[0] as string]));
  }
  return new Set(operands.flatMap((operand) => [...freeNames(operand, bound)]));
}
