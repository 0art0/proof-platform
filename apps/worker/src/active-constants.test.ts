import { describe, expect, it } from "vitest";
import type { LibraryResult } from "@proof/library";
import { problemSetupSort } from "@proof/protocol";
import {
  appliedResultIds,
  deriveSessionConstants,
  libraryConstantSymbols,
  mentionedSymbols,
  resultSymbols,
} from "./active-constants";

const INTEGER = problemSetupSort("integer");
const operator = (symbol: string) => ({
  id: `operator:${symbol.toLowerCase()}`,
  symbol,
  signature: { parameters: [INTEGER, INTEGER], result: INTEGER },
});
const OPERATORS = [operator("Divides"), operator("Gcd"), operator("Lcm")];

function result(id: string, statement: unknown, premises: unknown[] = []): LibraryResult {
  return {
    id,
    statement: { expression: statement },
    premises: premises.map((expression) => ({ expression })),
    patterns: [],
  } as unknown as LibraryResult;
}
const RESULTS = [
  result("result:gcd", ["Equal", ["Gcd", "a", "b"], "b"]),
  result("result:both", ["Equal", ["Lcm", "a", "b"], ["Gcd", "a", "b"]]),
  result("result:plain", ["Divides", "a", "a"]),
  result("result:premise", ["Divides", "a", "b"], [["Equal", ["Lcm", "a", "b"], "b"]]),
];

function edge(id: string, operation: Record<string, unknown>, sequence: number | undefined) {
  return { id, childNodeId: `node:${id}`, operation, sequence } as never;
}
const apply = (resultId: string) => ({ kind: "apply-result-backward", resultId });
const rewrite = (resultId: string) => ({
  kind: "rewrite-with-equivalence",
  source: { kind: "result", resultId },
});

describe("which results a step applies", () => {
  it("names the result of an application or of a rewrite whose source is a result", () => {
    expect(appliedResultIds(apply("result:a") as never)).toEqual(["result:a"]);
    expect(
      appliedResultIds({ ...apply("result:a"), kind: "apply-result-forward" } as never),
    ).toEqual(["result:a"]);
    expect(appliedResultIds(rewrite("result:a") as never)).toEqual(["result:a"]);
    expect(
      appliedResultIds({
        kind: "rewrite-with-implication",
        source: { kind: "result", resultId: "result:b" },
      } as never),
    ).toEqual(["result:b"]);
    expect(
      appliedResultIds({
        kind: "rewrite-with-equivalence",
        source: { kind: "hypothesis", hypothesisId: "hyp" },
      } as never),
    ).toEqual([]);
    expect(appliedResultIds({ kind: "close-true" } as never)).toEqual([]);
  });

  it("reads every symbol of an expression, operator heads included", () => {
    expect(
      [
        ...mentionedSymbols(["Equal", ["Gcd", { sym: "a" }, 1], { fn: ["Lcm", "b"] } as never]),
      ].sort(),
    ).toEqual(["Equal", "Gcd", "Lcm", "a", "b"]);
    expect([...resultSymbols(RESULTS[3]!)].sort()).toEqual(["Divides", "Equal", "Lcm", "a", "b"]);
  });
});

describe("deriveSessionConstants", () => {
  const derive = (edges: unknown[], libraryConstants = ["Gcd", "Lcm"]) =>
    deriveSessionConstants({
      operators: OPERATORS as never,
      libraryConstants,
      edges: edges as never,
      results: RESULTS,
    });

  it("keeps library constants dormant while no step applies a result that uses them", () => {
    const none = derive([]);
    expect(none.active.map(({ symbol }) => symbol)).toEqual(["Divides"]);
    expect(none.dormant.map(({ symbol }) => symbol)).toEqual(["Gcd", "Lcm"]);
    expect(none.activations).toEqual([]);
    const structural = derive([
      edge("e1", { kind: "close-true" }, 1),
      edge("e2", apply("result:plain"), 2),
    ]);
    expect(structural.activations).toEqual([]);
  });

  it("activates a constant at the first step that applies a result using it, and only once", () => {
    const derived = derive([
      edge("e2", apply("result:gcd"), 2),
      edge("e1", apply("result:plain"), 1),
      edge("e3", rewrite("result:gcd"), 3),
    ]);
    expect(derived.activations).toEqual([
      { symbol: "Gcd", edgeId: "e2", nodeId: "node:e2", resultId: "result:gcd", sequence: 2 },
    ]);
    expect(derived.active.map(({ symbol }) => symbol)).toEqual(["Divides", "Gcd"]);
    expect(derived.dormant.map(({ symbol }) => symbol)).toEqual(["Lcm"]);
  });

  it("reads steps in transition order, activates several constants at one step, and counts premises", () => {
    const derived = derive([
      edge("late", apply("result:premise"), 9),
      edge("early", apply("result:both"), 4),
    ]);
    expect(derived.activations.map(({ symbol, edgeId }) => [symbol, edgeId])).toEqual([
      ["Gcd", "early"],
      ["Lcm", "early"],
    ]);
    expect(derived.dormant).toEqual([]);
  });

  it("uses the stored order for steps without a sequence, and ignores results it does not know", () => {
    const derived = derive([
      edge("first", apply("result:unknown"), undefined),
      edge("second", apply("result:gcd"), undefined),
      edge("third", apply("result:both"), undefined),
    ]);
    expect(derived.activations.map(({ symbol, edgeId }) => [symbol, edgeId])).toEqual([
      ["Gcd", "second"],
      ["Lcm", "third"],
    ]);
  });

  it("treats only the recorded library constants as dormant", () => {
    const derived = derive([], []);
    expect(derived.dormant).toEqual([]);
    expect(derived.active).toHaveLength(3);
    expect(
      libraryConstantSymbols({
        operators: OPERATORS,
        metadata: { libraryConstants: ["Gcd", "Nope"] },
      } as never),
    ).toEqual(["Gcd"]);
    expect(libraryConstantSymbols({ operators: OPERATORS } as never)).toEqual([]);
  });
});
