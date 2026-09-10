import { describe, expect, it } from "vitest";
import {
  isPlainMathJson,
  mathJsonEquals,
  parsePlainMathJson,
  renderMathJson,
  type PlainMathJson,
} from "./index";

describe("plain MathJSON", () => {
  it("accepts array and object expression forms but rejects non-expression JSON", () => {
    expect(isPlainMathJson(["Equal", ["Add", "x", 1], 2])).toBe(true);
    expect(isPlainMathJson({ fn: ["Power", { sym: "x" }, { num: "2" }] })).toBe(true);
    expect(isPlainMathJson({ dict: { domain: "real", enabled: true } })).toBe(true);
    expect(isPlainMathJson([])).toBe(false);
    expect(isPlainMathJson([1, 2])).toBe(false);
    expect(isPlainMathJson(null)).toBe(false);
    expect(isPlainMathJson(Number.NaN)).toBe(false);
  });

  it("rejects ambiguous, cyclic, sparse, and accessor-backed runtime values", () => {
    expect(isPlainMathJson({ sym: "x", fn: ["Add", "x", 1] })).toBe(false);
    expect(isPlainMathJson({ sym: "x", unexpected: true })).toBe(false);
    expect(isPlainMathJson({ num: "not-a-number" })).toBe(false);
    expect(isPlainMathJson({ num: "1(3)" })).toBe(false);
    expect(isPlainMathJson({ num: "1.(3)" })).toBe(true);

    const cyclic: { fn: unknown[] } = { fn: ["Identity"] };
    cyclic.fn.push(cyclic);
    expect(isPlainMathJson(cyclic)).toBe(false);

    const sparse: unknown[] = new Array(4);
    sparse[0] = "Add";
    sparse[1] = "x";
    sparse[3] = 1;
    expect(isPlainMathJson(sparse)).toBe(false);

    const accessor = Object.defineProperty({}, "sym", {
      enumerable: true,
      get: () => "x",
    });
    expect(isPlainMathJson(accessor)).toBe(false);

    const sparseOffsets: unknown[] = new Array(2);
    expect(isPlainMathJson({ sym: "x", sourceOffsets: sparseOffsets })).toBe(false);

    let dictionaryGetterRead = false;
    const dictionary = Object.defineProperty({}, "entry", {
      enumerable: true,
      get: () => {
        dictionaryGetterRead = true;
        return 1;
      },
    });
    expect(isPlainMathJson({ dict: dictionary })).toBe(false);
    expect(dictionaryGetterRead).toBe(false);
  });

  it("preserves supported object metadata without canonicalizing it", () => {
    const expression = {
      fn: ["Equal", { fn: ["Add", "x", 1], latex: "x+1" }, { fn: ["Add", 1, "x"] }],
      comment: "keep operand order",
      sourceOffsets: [4, 12],
    } as const;

    expect(isPlainMathJson(expression)).toBe(true);
    const parsed = parsePlainMathJson(JSON.stringify(expression));
    expect(parsed).toEqual(expression);
  });

  it("parses only valid expression roots", () => {
    expect(parsePlainMathJson('["Add", "x", 1]')).toEqual(["Add", "x", 1]);
    expect(parsePlainMathJson("true")).toBeUndefined();
    expect(parsePlainMathJson("not json")).toBeUndefined();
  });

  it("compares nested array and object forms structurally", () => {
    const expression: PlainMathJson = { fn: ["Add", { sym: "x" }, 1], comment: "raw" };
    expect(mathJsonEquals(expression, { comment: "raw", fn: ["Add", { sym: "x" }, 1] })).toBe(true);
    expect(mathJsonEquals(expression, ["Add", "x", 1])).toBe(false);
  });
});

describe("Compute Engine boundary", () => {
  it("renders a noncanonical expression without replacing the source", () => {
    const expression = [
      "Equal",
      ["Add", ["Power", "x", 2], ["Multiply", 3, "y"], "z", "y"],
      12,
    ] as const satisfies PlainMathJson;
    const before = JSON.stringify(expression);

    const result = renderMathJson(expression);

    expect(result).toEqual({ ok: true, latex: "x^2+3y+z+y=12", diagnostics: [] });
    expect(JSON.stringify(expression)).toBe(before);
  });
});
