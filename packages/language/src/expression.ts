import { mathJsonEquals, type PlainMathJson } from "@proof/mathjson-model";

export type ExpressionParts = Readonly<{ operator: string; operands: readonly PlainMathJson[] }>;

function asRecord(expression: PlainMathJson): Readonly<Record<string, unknown>> | undefined {
  return typeof expression === "object" && expression !== null && !Array.isArray(expression)
    ? (expression as Readonly<Record<string, unknown>>)
    : undefined;
}

export function symbolName(expression: PlainMathJson): string | undefined {
  if (typeof expression === "string") return expression;
  const symbol = asRecord(expression)?.sym;
  return typeof symbol === "string" ? symbol : undefined;
}

export function expressionParts(expression: PlainMathJson): ExpressionParts | undefined {
  if (Array.isArray(expression)) {
    const operator: unknown = expression[0];
    if (typeof operator !== "string") return undefined;
    return { operator, operands: expression.slice(1) as readonly PlainMathJson[] };
  }
  const fn = asRecord(expression)?.fn;
  if (!Array.isArray(fn) || typeof fn[0] !== "string") return undefined;
  return { operator: fn[0], operands: fn.slice(1) as readonly PlainMathJson[] };
}

export function numericValue(expression: PlainMathJson): number | undefined {
  if (typeof expression === "number") return expression;
  const value = asRecord(expression)?.num;
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) return undefined;
  return Number(value);
}

export function headOf(expression: PlainMathJson): string | undefined {
  return expressionParts(expression)?.operator;
}

/**
 * A matching-only normal form: `{sym}` and `{fn}` wrappers become their short forms, integer
 * `{num}` literals become numbers, and metadata is dropped. It is never persisted.
 */
export function normalizeExpression(expression: PlainMathJson): PlainMathJson {
  const symbol = symbolName(expression);
  if (symbol !== undefined) return symbol;
  const parts = expressionParts(expression);
  if (parts !== undefined) {
    return [parts.operator, ...parts.operands.map(normalizeExpression)] as PlainMathJson;
  }
  const record = asRecord(expression);
  if (record !== undefined && typeof record.num === "string" && /^-?\d+$/.test(record.num)) {
    const value = Number(record.num);
    if (Number.isSafeInteger(value)) return value;
  }
  if (record !== undefined && typeof record.num === "string") return { num: record.num };
  if (record !== undefined && typeof record.str === "string") return { str: record.str };
  return expression;
}

export function structurallyEqual(left: PlainMathJson, right: PlainMathJson): boolean {
  return mathJsonEquals(normalizeExpression(left), normalizeExpression(right));
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** A detached, deeply frozen copy of plain JSON data. */
export function detach<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/** Match a pattern whose symbols starting with `_` are wildcards; `_` alone binds nothing. */
export function matchPattern(
  pattern: PlainMathJson,
  expression: PlainMathJson,
): ReadonlyMap<string, PlainMathJson> | undefined {
  const bindings = new Map<string, PlainMathJson>();
  return matchInto(normalizeExpression(pattern), normalizeExpression(expression), bindings)
    ? bindings
    : undefined;
}

function isWildcard(name: string): boolean {
  return name.startsWith("_");
}

function bind(name: string, value: PlainMathJson, bindings: Map<string, PlainMathJson>): boolean {
  if (name === "_") return true;
  const key = name.slice(1);
  const existing = bindings.get(key);
  if (existing !== undefined) return mathJsonEquals(existing, value);
  bindings.set(key, value);
  return true;
}

function matchInto(
  pattern: PlainMathJson,
  expression: PlainMathJson,
  bindings: Map<string, PlainMathJson>,
): boolean {
  if (typeof pattern === "string" && isWildcard(pattern)) {
    return bind(pattern, expression, bindings);
  }
  if (Array.isArray(pattern)) {
    if (!Array.isArray(expression) || pattern.length !== expression.length) return false;
    const [patternHead, ...patternOperands] = pattern as readonly [string, ...PlainMathJson[]];
    const [head, ...operands] = expression as readonly [string, ...PlainMathJson[]];
    const headMatches = isWildcard(patternHead)
      ? bind(patternHead, head, bindings)
      : patternHead === head;
    return (
      headMatches &&
      patternOperands.every((operand, index) =>
        matchInto(operand, operands[index] as PlainMathJson, bindings),
      )
    );
  }
  return mathJsonEquals(pattern, expression);
}
