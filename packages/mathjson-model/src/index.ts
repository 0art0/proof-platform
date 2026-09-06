import { ComputeEngine } from "@cortex-js/compute-engine";
import type { MathJsonExpression } from "@cortex-js/compute-engine/math-json";

/**
 * The persisted expression type. It deliberately excludes every boxed Compute
 * Engine type: callers own plain JSON and box it only at an explicit boundary.
 */
export type PlainMathJson = MathJsonExpression;

export type MathJsonRenderDiagnostic = Readonly<{
  code: "invalid-math-json" | "render-failed";
  message: string;
}>;

export type MathJsonRenderResult =
  | Readonly<{
      ok: true;
      latex: string;
      diagnostics: readonly [];
    }>
  | Readonly<{
      ok: false;
      latex: "";
      diagnostics: readonly MathJsonRenderDiagnostic[];
    }>;

const computeEngine = new ComputeEngine();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }

  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

/** Runtime guard for the serializable MathJSON forms accepted by the spike. */
export function isPlainMathJson(value: unknown): value is PlainMathJson {
  if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
    return true;
  }

  if (Array.isArray(value)) {
    return (
      value.length > 0 && typeof value[0] === "string" && value.slice(1).every(isPlainMathJson)
    );
  }

  if (!isRecord(value) || !isJsonValue(value)) return false;

  if ("fn" in value) {
    return Array.isArray(value.fn) && isPlainMathJson(value.fn);
  }
  if ("sym" in value) return typeof value.sym === "string";
  if ("str" in value) return typeof value.str === "string";
  if ("num" in value) return typeof value.num === "string";
  return "dict" in value && isRecord(value.dict);
}

export function parsePlainMathJson(source: string): PlainMathJson | undefined {
  try {
    const parsed: unknown = JSON.parse(source);
    return isPlainMathJson(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function mathJsonEquals(left: PlainMathJson, right: PlainMathJson): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => mathJsonEquals(value, right[index] as PlainMathJson))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;

  const leftRecord: Readonly<Record<string, unknown>> = left;
  const rightRecord: Readonly<Record<string, unknown>> = right;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }

  return leftKeys.every((key) => jsonValueEquals(leftRecord[key], rightRecord[key]));
}

function jsonValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValueEquals(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonValueEquals(left[key], right[key]),
    )
  );
}

/**
 * The sole Compute Engine boundary for Stage 1. `form: "raw"` prevents
 * canonicalization from reordering or otherwise replacing stored MathJSON.
 */
export function renderMathJson(expression: PlainMathJson): MathJsonRenderResult {
  if (!isPlainMathJson(expression)) {
    return {
      ok: false,
      latex: "",
      diagnostics: [{ code: "invalid-math-json", message: "The value is not plain MathJSON." }],
    };
  }

  try {
    return {
      ok: true,
      latex: computeEngine.expr(expression, { form: "raw" }).latex,
      diagnostics: [],
    };
  } catch (error) {
    return {
      ok: false,
      latex: "",
      diagnostics: [
        {
          code: "render-failed",
          message:
            error instanceof Error ? error.message : "Compute Engine could not render this value.",
        },
      ],
    };
  }
}
