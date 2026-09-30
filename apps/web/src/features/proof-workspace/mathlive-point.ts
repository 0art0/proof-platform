import type { PlainMathJson } from "@proof/mathjson-model";
import {
  expressionAtPath,
  type AnchoredProofSelection,
  type StatementAnchor,
} from "@proof/selections";
import { operandPathFromElementData, type MathLiveSelectionPort } from "./mathlive-selection";

/** The part of a MathLive field needed to find the occurrence under a pointer. */
export type MathLivePointPort = Pick<MathLiveSelectionPort, "getElementInfo" | "lastOffset"> &
  Readonly<{
    getOffsetFromPoint: (x: number, y: number, options?: { bias?: -1 | 0 | 1 }) => number;
  }>;

/**
 * The exact occurrence at a screen point, for drops onto a slot. Only a leaf-annotated display
 * offset is trusted; anything else (no field, no metadata, an outdated path) snaps to the whole
 * statement, which is always a genuine occurrence.
 */
export function readAnchoredOccurrenceAtPoint(
  field: MathLivePointPort | undefined,
  expression: PlainMathJson,
  anchor: StatementAnchor,
  point: Readonly<{ x: number; y: number }>,
): AnchoredProofSelection {
  const root: AnchoredProofSelection = { kind: "exact", anchor, path: [] };
  if (field === undefined) return root;
  try {
    const offset = field.getOffsetFromPoint(point.x, point.y, { bias: 0 });
    for (const delta of [0, -1, 1]) {
      const candidate = Math.max(0, Math.min(field.lastOffset, offset + delta));
      const path = operandPathFromElementData(field.getElementInfo(candidate)?.data);
      if (
        path !== undefined &&
        path.length > 0 &&
        expressionAtPath(expression, path) !== undefined
      ) {
        return { kind: "exact", anchor, path };
      }
    }
  } catch {
    // The field could not be hit-tested; the whole statement is the honest fallback.
  }
  return root;
}
