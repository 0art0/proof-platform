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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const EXPRESSION_KEYS = ["fn", "sym", "str", "num", "dict"] as const;
const STRING_METADATA_KEYS = new Set([
  "comment",
  "documentation",
  "latex",
  "wikidata",
  "wikibase",
  "openmathSymbol",
  "openmathCd",
  "sourceUrl",
  "sourceContent",
]);
const METADATA_KEYS = new Set([...STRING_METADATA_KEYS, "sourceOffsets"]);
const MATHJSON_NUMBER_PATTERN =
  /^(?:NaN|-Infinity|\+Infinity|-?\d+(?:\.(?:\d+(?:\(\d+\))?|\(\d+\)))?(?:[eE][+-]?\d+)?)$/;

function hasOnlyEnumerableDataProperties(record: Readonly<Record<string, unknown>>): boolean {
  const keys = Reflect.ownKeys(record);
  if (keys.some((key) => typeof key !== "string")) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function hasValidMetadata(
  record: Readonly<Record<string, unknown>>,
  expressionKey: string,
): boolean {
  for (const [key, value] of Object.entries(record)) {
    if (key === expressionKey) continue;
    if (!METADATA_KEYS.has(key)) return false;
    if (key === "sourceOffsets") {
      if (
        !Array.isArray(value) ||
        !isDenseArray(value) ||
        value.length !== 2 ||
        !value.every(
          (offset) => typeof offset === "number" && Number.isInteger(offset) && offset >= 0,
        ) ||
        (value[0] as number) > (value[1] as number)
      ) {
        return false;
      }
    } else if (typeof value !== "string") {
      return false;
    }
  }
  return true;
}

function isDenseArray(value: readonly unknown[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)),
    )
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return false;
  }
  return true;
}

function isDictionaryValue(value: unknown, ancestors: WeakSet<object>): boolean {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    if (!isDenseArray(value) || ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = value.every((item) => isDictionaryValue(item, ancestors));
    ancestors.delete(value);
    return valid;
  }
  return isPlainMathJsonValue(value, ancestors, false);
}

function isPlainMathJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  allowArrayExpression: boolean,
): boolean {
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);

  if (Array.isArray(value)) {
    if (!allowArrayExpression || !isDenseArray(value) || ancestors.has(value)) return false;
    if (value.length === 0 || typeof value[0] !== "string" || value[0].length === 0) return false;
    ancestors.add(value);
    const valid = value.slice(1).every((item) => isPlainMathJsonValue(item, ancestors, true));
    ancestors.delete(value);
    return valid;
  }

  if (!isRecord(value) || ancestors.has(value) || !hasOnlyEnumerableDataProperties(value)) {
    return false;
  }
  const discriminators = EXPRESSION_KEYS.filter((key) => key in value);
  if (discriminators.length !== 1) return false;
  const expressionKey = discriminators[0];
  if (expressionKey === undefined || !hasValidMetadata(value, expressionKey)) return false;

  ancestors.add(value);
  let valid = false;
  if (expressionKey === "sym") {
    valid = typeof value.sym === "string" && value.sym.length > 0;
  } else if (expressionKey === "str") {
    valid = typeof value.str === "string";
  } else if (expressionKey === "num") {
    valid = typeof value.num === "string" && MATHJSON_NUMBER_PATTERN.test(value.num);
  } else if (expressionKey === "fn") {
    valid =
      Array.isArray(value.fn) &&
      isDenseArray(value.fn) &&
      value.fn.length > 0 &&
      typeof value.fn[0] === "string" &&
      value.fn[0].length > 0 &&
      value.fn.slice(1).every((item) => isPlainMathJsonValue(item, ancestors, true));
  } else if (isRecord(value.dict) && hasOnlyEnumerableDataProperties(value.dict)) {
    valid = Object.values(value.dict).every((item) => isDictionaryValue(item, ancestors));
  }
  ancestors.delete(value);
  return valid;
}

/** Runtime guard for serializable, unboxed MathJSON. It never boxes or canonicalizes its input. */
export function isPlainMathJson(value: unknown): value is PlainMathJson {
  try {
    return isPlainMathJsonValue(value, new WeakSet<object>(), true);
  } catch {
    return false;
  }
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

export * from "./contracts";
export * from "./binding";
