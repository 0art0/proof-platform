import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PlainMathJson } from "@proof/mathjson-model";
import {
  createAssociativeSelection,
  expressionAtPath,
  findExactPaths,
  replaceAtPath,
  replaceSelection,
  resolveSelection,
} from "./index";

const statement = [
  "Equal",
  ["Add", ["Power", "x", 2], ["Multiply", 3, "y"], "z", "y"],
  12,
] as const satisfies PlainMathJson;

describe("operand paths", () => {
  it("uses zero-based operand indices and never counts the operator", () => {
    expect(expressionAtPath(statement, [])).toBe(statement);
    expect(expressionAtPath(statement, [0, 0])).toEqual(["Power", "x", 2]);
    expect(expressionAtPath(statement, [0, 1, 1])).toBe("y");
    expect(expressionAtPath(statement, [2])).toBeUndefined();
  });

  it("distinguishes equal expressions by occurrence", () => {
    expect(findExactPaths(statement, "y")).toEqual([
      [0, 1, 1],
      [0, 3],
    ]);
    expect(resolveSelection(statement, "y", { occurrence: 1 })).toMatchObject({
      kind: "exact",
      path: [0, 3],
    });
    expect(resolveSelection(statement, "y", { paths: [[0, 1, 1]] })).toMatchObject({
      kind: "exact",
      path: [0, 1, 1],
    });
    expect(
      resolveSelection(statement, "y", {
        paths: [
          [0, 2],
          [0, 3],
        ],
      }),
    ).toMatchObject({ kind: "exact", path: [0, 3] });
  });

  it("replaces an exact occurrence without changing its source or siblings", () => {
    const before = JSON.stringify(statement);
    const result = replaceAtPath(statement, [0, 1], "u");

    expect(result).toEqual({
      ok: true,
      expression: ["Equal", ["Add", ["Power", "x", 2], "u", "z", "y"], 12],
      diagnostics: [],
    });
    expect(JSON.stringify(statement)).toBe(before);
  });

  it("returns a diagnostic and the untouched expression for invalid paths", () => {
    const result = replaceAtPath(statement, [0, 9], "u");
    expect(result.ok).toBe(false);
    expect(result.expression).toBe(statement);
    expect(result.diagnostics[0]).toMatchObject({ code: "invalid-path", path: [0, 9] });
  });

  it("supports object-form function expressions", () => {
    const expression = {
      fn: ["Equal", { fn: ["Add", "a", "b"], comment: "keep me" }, "c"],
    } as const satisfies PlainMathJson;
    const result = replaceAtPath(expression, [0, 1], "x");
    expect(result.expression).toEqual({
      fn: ["Equal", { fn: ["Add", "a", "x"], comment: "keep me" }, "c"],
    });
  });
});

describe("associative virtual selections", () => {
  it.each([
    ["Add", ["Add", "a", "b", "c", "d"]],
    ["Multiply", ["Multiply", "a", "b", "c", "d"]],
    ["And", ["And", "a", "b", "c", "d"]],
    ["Or", ["Or", "a", "b", "c", "d"]],
  ] as const)("extracts and reinserts a contiguous %s range", (operator, expression) => {
    const lens = createAssociativeSelection(expression, [], 1, 3);
    expect(lens).toMatchObject({
      kind: "associative",
      operator,
      containerPath: [],
      startOperand: 1,
      endOperand: 3,
      coveredOperandPaths: [[1], [2]],
      fragment: [operator, "b", "c"],
    });

    expect(replaceSelection(expression, lens!, "u")).toEqual({
      ok: true,
      expression: [operator, "a", "u", "d"],
      diagnostics: [],
    });
  });

  it("resolves a displayed contiguous range to a lens", () => {
    expect(
      resolveSelection(statement, ["Add", ["Multiply", 3, "y"], "z"], {
        paths: [
          [0, 1, 0],
          [0, 2],
        ],
        displayRange: [4, 9],
      }),
    ).toMatchObject({
      kind: "associative",
      containerPath: [0],
      startOperand: 1,
      endOperand: 3,
      displayRange: [4, 9],
    });
  });

  it("rejects noncontiguous and singleton ranges", () => {
    expect(createAssociativeSelection(statement, [0], 1, 1)).toBeUndefined();
    expect(createAssociativeSelection(statement, [0], 1, 5)).toBeUndefined();
    expect(createAssociativeSelection(["Subtract", "a", "b", "c"], [], 0, 2)).toBeUndefined();
  });

  it("rejects a stale lens rather than replacing a changed container", () => {
    const expression: PlainMathJson = ["Add", "a", "b", "c"];
    const lens = createAssociativeSelection(expression, [], 0, 2);
    const changed: PlainMathJson = ["Add", "x", "b", "c"];
    const result = replaceSelection(changed, lens!, "u");
    expect(result).toMatchObject({
      ok: false,
      expression: changed,
      diagnostics: [{ code: "invalid-associative-range" }],
    });
  });

  it("preserves all unselected operands for arbitrary integer lists", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 4, maxLength: 12 }),
        fc.integer(),
        (operands, replacement) => {
          const expression: PlainMathJson = ["Add", ...operands];
          const lens = createAssociativeSelection(expression, [], 1, 3);
          expect(lens).toBeDefined();
          const result = replaceSelection(expression, lens!, replacement);
          expect(result).toEqual({
            ok: true,
            expression: ["Add", operands[0], replacement, ...operands.slice(3)],
            diagnostics: [],
          });
        },
      ),
    );
  });
});

describe("visible fallback semantics", () => {
  it("snaps a cross-branch range to the common enclosing subtree", () => {
    const requested: PlainMathJson = ["Add", 2, ["Multiply", 3, "y"]];
    expect(
      resolveSelection(statement, requested, {
        paths: [
          [0, 0, 1],
          [0, 1, 1],
        ],
      }),
    ).toMatchObject({
      kind: "fallback",
      path: [0],
      fragment: statement[1],
      requestedFragment: requested,
    });
  });

  it("uses leaf containment when display metadata is unavailable", () => {
    expect(resolveSelection(statement, ["Add", 2, 3, "z"])).toMatchObject({
      kind: "fallback",
      path: [0],
    });
  });
});
