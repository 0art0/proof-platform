import { describe, expect, it } from "vitest";
import type { PlainMathJson } from "@proof/mathjson-model";
import {
  operandPathFromElementData,
  readMathLiveSelection,
  renderInteractiveLatex,
  type MathLiveSelectionPort,
} from "./mathlive-selection";
import { INITIAL_STATEMENT } from "./mathjson-spike";

function selectionPort(
  options: Readonly<{
    collapsed?: boolean;
    json?: PlainMathJson;
    pathsByOffset?: Readonly<Record<number, string>>;
    position?: number;
    range?: readonly [number, number];
  }> = {},
): MathLiveSelectionPort {
  const range = options.range ?? [4, 9];
  return {
    selection: { ranges: [range] },
    selectionIsCollapsed: options.collapsed ?? false,
    position: options.position ?? range[0],
    lastOffset: 20,
    getValue: () => JSON.stringify(options.json ?? ["Add", ["Multiply", 3, "y"], "z"]),
    getElementInfo: (offset) => {
      const path = options.pathsByOffset?.[offset];
      return path ? { data: { [`proof-path-${path.split(".").length}`]: path } } : undefined;
    },
  };
}

describe("interactive LaTeX metadata", () => {
  it("annotates every displayed leaf occurrence without changing the stored tree", () => {
    const before = JSON.stringify(INITIAL_STATEMENT);
    const latex = renderInteractiveLatex(INITIAL_STATEMENT);

    expect(latex).toContain("proof-path-3=0.1.1");
    expect(latex).toContain("proof-path-2=0.3");
    expect(latex).toContain("proof-path-1=1");
    expect(JSON.stringify(INITIAL_STATEMENT)).toBe(before);
  });

  it("chooses the deepest nested path exposed by MathLive", () => {
    expect(
      operandPathFromElementData({
        "proof-path-0": "root",
        "proof-path-2": "0.3",
        "proof-path-3": "0.1.1",
      }),
    ).toEqual([0, 1, 1]);
  });
});

describe("MathLive selection interpretation", () => {
  it("recovers a duplicate leaf by occurrence metadata", () => {
    expect(
      readMathLiveSelection(
        selectionPort({ collapsed: true, position: 8, pathsByOffset: { 8: "0.3" } }),
        INITIAL_STATEMENT,
      ),
    ).toMatchObject({ kind: "exact", path: [0, 3], fragment: "y" });
  });

  it("recovers an exact nested subtree from its endpoint paths", () => {
    expect(
      readMathLiveSelection(
        selectionPort({
          json: ["Power", "x", 2],
          pathsByOffset: { 1: "0.0.0", 4: "0.0.1" },
          range: [1, 4],
        }),
        INITIAL_STATEMENT,
      ),
    ).toMatchObject({ kind: "exact", path: [0, 0], fragment: ["Power", "x", 2] });
  });

  it("recovers a contiguous associative virtual selection", () => {
    expect(
      readMathLiveSelection(
        selectionPort({ pathsByOffset: { 4: "0.1.0", 9: "0.2" } }),
        INITIAL_STATEMENT,
      ),
    ).toMatchObject({
      kind: "associative",
      containerPath: [0],
      startOperand: 1,
      endOperand: 3,
    });
  });

  it("visibly classifies an unsupported cross-branch range as fallback", () => {
    expect(
      readMathLiveSelection(
        selectionPort({
          json: ["Add", 2, ["Multiply", 3, "y"]],
          pathsByOffset: { 3: "0.0.1", 8: "0.1.1" },
          range: [3, 8],
        }),
        INITIAL_STATEMENT,
      ),
    ).toMatchObject({ kind: "fallback", path: [0], fragment: INITIAL_STATEMENT[1] });
  });
});
