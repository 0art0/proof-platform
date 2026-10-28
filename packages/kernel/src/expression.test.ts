import { describe, expect, it } from "vitest";
import type { PlainMathJson } from "@proof/mathjson-model";
import {
  functionParts,
  hasExactKeys,
  isStrictRecord,
  operatorOperands,
  symbolValue,
} from "./index";

describe("function node helpers", () => {
  it("reads array and object function forms and rebuilds them in kind", () => {
    const array = functionParts(["Add", "x", 1]);
    expect(array).toMatchObject({ operator: "Add", operands: ["x", 1] });
    expect(array?.rebuild(["y"])).toEqual(["Add", "y"]);

    const object = functionParts({ fn: ["Add", "x", 1], comment: "kept" });
    expect(object).toMatchObject({ operator: "Add", operands: ["x", 1] });
    expect(object?.rebuild(["y"])).toEqual({ fn: ["Add", "y"], comment: "kept" });

    expect(operatorOperands(["Add", "x", 1], "Add")).toEqual(["x", 1]);
    expect(operatorOperands({ fn: ["Add", "x"] }, "Mul")).toBeUndefined();
  });

  it("does not read a function out of a malformed object form", () => {
    const stringFn = { fn: "Add" } as unknown as PlainMathJson;
    const objectFn = { fn: { 0: "Add" } } as unknown as PlainMathJson;
    expect(functionParts(stringFn)).toBeUndefined();
    expect(functionParts(objectFn)).toBeUndefined();
    expect(functionParts({ sym: "x" })).toBeUndefined();
    expect(functionParts([1, 2] as unknown as PlainMathJson)).toBeUndefined();
    expect(operatorOperands(stringFn, "A")).toBeUndefined();
  });

  it("reads symbols in bare and object form", () => {
    expect(symbolValue("x")).toBe("x");
    expect(symbolValue({ sym: "x" })).toBe("x");
    expect(symbolValue(["Add", "x"])).toBeUndefined();
    expect(symbolValue(3)).toBeUndefined();
  });
});

describe("strict runtime record guards", () => {
  it("accepts only plain data records and exact key sets", () => {
    expect(isStrictRecord({ a: 1 })).toBe(true);
    expect(isStrictRecord(Object.create(null))).toBe(true);
    expect(isStrictRecord([])).toBe(false);
    expect(isStrictRecord(new Map())).toBe(false);
    expect(isStrictRecord(Object.defineProperty({}, "a", { enumerable: true, get: () => 1 }))).toBe(
      false,
    );

    expect(hasExactKeys({ a: 1, b: 2 }, ["b", "a"])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, [Symbol("s")]: 2 }, ["a"])).toBe(false);
  });
});
