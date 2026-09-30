import { describe, expect, it } from "vitest";
import type { PlainMathJson } from "@proof/mathjson-model";
import type { StatementAnchor } from "@proof/selections";
import { readAnchoredOccurrenceAtPoint, type MathLivePointPort } from "./mathlive-point";

const anchor = {
  stateId: "state:a",
  target: { kind: "goal", id: "goal:a" },
  statement: { kind: "conclusion" },
} as StatementAnchor;
const expression = ["And", "p", ["Or", "q", "r"]] as PlainMathJson;

function field(data: Record<number, Record<string, string> | undefined>, offset = 2) {
  return {
    lastOffset: 10,
    getOffsetFromPoint: () => offset,
    getElementInfo: (at: number) => ({ data: data[at] }),
  } as unknown as MathLivePointPort;
}

const root = { kind: "exact", anchor, path: [] };

describe("occurrence at a point", () => {
  it("returns the annotated leaf under the pointer", () => {
    const at = readAnchoredOccurrenceAtPoint(
      field({ 2: { "proof-path-2": "1.0" } }),
      expression,
      anchor,
      { x: 1, y: 1 },
    );
    expect(at).toEqual({ kind: "exact", anchor, path: [1, 0] });
  });

  it("looks at the neighbouring offsets before giving up", () => {
    const at = readAnchoredOccurrenceAtPoint(
      field({ 1: { "proof-path-1": "0" } }),
      expression,
      anchor,
      { x: 1, y: 1 },
    );
    expect(at).toEqual({ kind: "exact", anchor, path: [0] });
  });

  it("snaps to the whole statement when there is no usable metadata", () => {
    expect(readAnchoredOccurrenceAtPoint(undefined, expression, anchor, { x: 0, y: 0 })).toEqual(
      root,
    );
    expect(readAnchoredOccurrenceAtPoint(field({}), expression, anchor, { x: 0, y: 0 })).toEqual(
      root,
    );
    // A path that does not exist in the expression is stale metadata.
    expect(
      readAnchoredOccurrenceAtPoint(field({ 2: { "proof-path-1": "9" } }), expression, anchor, {
        x: 0,
        y: 0,
      }),
    ).toEqual(root);
    const throwing = {
      lastOffset: 1,
      getOffsetFromPoint: () => {
        throw new Error("no layout");
      },
      getElementInfo: () => undefined,
    } as unknown as MathLivePointPort;
    expect(readAnchoredOccurrenceAtPoint(throwing, expression, anchor, { x: 0, y: 0 })).toEqual(
      root,
    );
  });
});
