import { mathJsonEquals, type PlainMathJson } from "@proof/mathjson-model";
import { ASSOCIATIVE_OPERATORS } from "@proof/selections";

export type FunctionParts = Readonly<{
  operator: string;
  operands: readonly PlainMathJson[];
}>;

/** Options shared by the discrimination tree and the first-order matcher. */
export type PatternMatchOptions = Readonly<{
  /**
   * When true, a binary pattern over an associative head (`And`, `Or`, `Add`,
   * `Multiply`) also matches a variadic occurrence of that head. The first
   * operand matches the first argument and the second operand matches the
   * right-grouped remainder, so `["And", "p", "q"]` matches `["And", a, b, c]`
   * with `p := a` and `q := ["And", b, c]`. Only move patterns use this: the
   * kernel's conjunction and disjunction primitives are variadic, whereas a
   * result instance must match its target exactly.
   */
  associativeGrouping: boolean;
}>;

const ASSOCIATIVE_OPERATOR_SET: ReadonlySet<string> = new Set(ASSOCIATIVE_OPERATORS);

export function isAssociativeOperator(operator: string): boolean {
  return ASSOCIATIVE_OPERATOR_SET.has(operator);
}

export function functionParts(expression: PlainMathJson): FunctionParts | undefined {
  if (Array.isArray(expression)) {
    const operator = expression[0];
    return typeof operator === "string"
      ? { operator, operands: expression.slice(1) as readonly PlainMathJson[] }
      : undefined;
  }
  if (typeof expression !== "object" || expression === null || !("fn" in expression)) {
    return undefined;
  }
  const operator = expression.fn[0];
  return typeof operator === "string" ? { operator, operands: expression.fn.slice(1) } : undefined;
}

export function symbolValue(expression: PlainMathJson): string | undefined {
  if (typeof expression === "string") return expression;
  return typeof expression === "object" &&
    expression !== null &&
    !Array.isArray(expression) &&
    "sym" in expression
    ? expression.sym
    : undefined;
}

/**
 * The operands a binary associative pattern node sees for a candidate with the
 * same head: the first argument and the right-grouped remainder. Returns
 * undefined when the candidate has fewer than two arguments.
 */
export function groupedAssociativeOperands(
  operator: string,
  operands: readonly PlainMathJson[],
): readonly [PlainMathJson, PlainMathJson] | undefined {
  const first = operands[0];
  const second = operands[1];
  if (first === undefined || second === undefined) return undefined;
  return operands.length === 2 ? [first, second] : [first, [operator, ...operands.slice(1)]];
}

/** Whether a pattern function node is a binary associative node eligible for grouping. */
export function usesAssociativeGrouping(
  parts: FunctionParts,
  wildcardSymbols: ReadonlySet<string>,
  options: PatternMatchOptions,
): boolean {
  return (
    options.associativeGrouping &&
    parts.operands.length === 2 &&
    !wildcardSymbols.has(parts.operator) &&
    isAssociativeOperator(parts.operator)
  );
}

/** First-order matching of a pattern against a concrete term; returns the extended bindings. */
export function matchPattern(
  pattern: PlainMathJson,
  candidate: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
  options: PatternMatchOptions,
  initialBindings: ReadonlyMap<string, PlainMathJson> = new Map(),
): ReadonlyMap<string, PlainMathJson> | undefined {
  const bindings = new Map(initialBindings);
  return matchExpression(pattern, candidate, wildcardSymbols, options, bindings)
    ? bindings
    : undefined;
}

function matchExpression(
  pattern: PlainMathJson,
  candidate: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
  options: PatternMatchOptions,
  bindings: Map<string, PlainMathJson>,
): boolean {
  const patternSymbol = symbolValue(pattern);
  if (patternSymbol !== undefined && wildcardSymbols.has(patternSymbol)) {
    return bindWildcard(patternSymbol, candidate, bindings);
  }
  const patternParts = functionParts(pattern);
  const candidateParts = functionParts(candidate);
  if (patternParts !== undefined || candidateParts !== undefined) {
    if (patternParts === undefined || candidateParts === undefined) return false;
    if (wildcardSymbols.has(patternParts.operator)) {
      if (!bindWildcard(patternParts.operator, candidateParts.operator, bindings)) return false;
    } else if (patternParts.operator !== candidateParts.operator) {
      return false;
    }
    const candidateOperands =
      usesAssociativeGrouping(patternParts, wildcardSymbols, options) &&
      candidateParts.operands.length > 2
        ? groupedAssociativeOperands(candidateParts.operator, candidateParts.operands)
        : candidateParts.operands;
    return (
      candidateOperands !== undefined &&
      patternParts.operands.length === candidateOperands.length &&
      patternParts.operands.every((operand, index) => {
        const candidateOperand = candidateOperands[index];
        return (
          candidateOperand !== undefined &&
          matchExpression(operand, candidateOperand, wildcardSymbols, options, bindings)
        );
      })
    );
  }
  const candidateSymbol = symbolValue(candidate);
  if (patternSymbol !== undefined || candidateSymbol !== undefined) {
    return patternSymbol !== undefined && patternSymbol === candidateSymbol;
  }
  return mathJsonEquals(pattern, candidate);
}

function bindWildcard(
  symbol: string,
  value: PlainMathJson,
  bindings: Map<string, PlainMathJson>,
): boolean {
  const previous = bindings.get(symbol);
  if (previous !== undefined) return mathJsonEquals(previous, value);
  bindings.set(symbol, value);
  return true;
}
