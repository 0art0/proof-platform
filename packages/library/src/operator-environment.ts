/**
 * Operator environments for the library: merging them, and finding the symbols a library result
 * mentions (design plan §12.4; `docs/ai-agents-architecture.md` section 2).
 *
 * This module imports nothing from the rest of the package, so the artifact schemas can use it
 * while `./index` is still evaluating.
 */
import {
  canonicalJsonEquals,
  operatorDeclarationsSchema,
  type OperatorDeclaration,
  type PlainMathJson,
} from "@proof/mathjson-model";

export type MergeLibraryOperatorsResult =
  | Readonly<{ ok: true; operators: readonly OperatorDeclaration[] }>
  | Readonly<{ ok: false; message: string }>;

/**
 * Merge operator environments (for example the global registry and a session's operators).
 * Identical declarations of one symbol collapse to one; any other conflict, and any invalid
 * combined environment, is rejected with the reason: a symbol declared differently, or an
 * identifier or LaTeX parse trigger that two different operators share.
 */
export function mergeLibraryOperators(
  groups: readonly (readonly unknown[])[],
): MergeLibraryOperatorsResult {
  const bySymbol = new Map<string, unknown>();
  for (const operator of groups.flat()) {
    const symbol =
      typeof operator === "object" && operator !== null && "symbol" in operator
        ? operator.symbol
        : undefined;
    if (typeof symbol !== "string") return { ok: false, message: "An operator is invalid." };
    const existing = bySymbol.get(symbol);
    if (existing === undefined) bySymbol.set(symbol, operator);
    else if (!canonicalJsonEquals(existing, operator)) {
      return { ok: false, message: `The operator ${symbol} is declared inconsistently.` };
    }
  }
  let parsed: ReturnType<typeof operatorDeclarationsSchema.safeParse>;
  try {
    parsed = operatorDeclarationsSchema.safeParse(structuredClone([...bySymbol.values()]));
  } catch {
    return { ok: false, message: "The combined operator environment is invalid." };
  }
  if (parsed.success) return deepFreeze({ ok: true, operators: parsed.data });
  return { ok: false, message: explainClash([...bySymbol.values()]) };
}

/** Why a set of distinct-symbol operators cannot form one environment, in plain words. */
function explainClash(operators: readonly unknown[]): string {
  const ids = new Map<string, string>();
  const triggers = new Map<string, string>();
  for (const operator of operators) {
    const record = operator as Readonly<{
      id?: unknown;
      symbol?: unknown;
      presentation?: { latex?: { parse?: { trigger?: unknown } } };
    }>;
    const symbol = typeof record.symbol === "string" ? record.symbol : "?";
    if (typeof record.id === "string") {
      const other = ids.get(record.id);
      if (other !== undefined) {
        return `The operators ${other} and ${symbol} share the identifier ${record.id}.`;
      }
      ids.set(record.id, symbol);
    }
    const trigger = record.presentation?.latex?.parse?.trigger;
    if (typeof trigger === "string") {
      const other = triggers.get(trigger);
      if (other !== undefined) {
        return `The operators ${other} and ${symbol} share the LaTeX trigger ${trigger}.`;
      }
      triggers.set(trigger, symbol);
    }
  }
  return "The combined operator environment is invalid.";
}

/**
 * Every symbol a plain MathJSON expression mentions: bare symbols, applied heads and symbol or
 * function nodes alike. Numbers and string literals are not symbols but may be returned as
 * strings; callers intersect the result with operator symbols.
 */
export function mentionedSymbols(
  expression: PlainMathJson,
  symbols: Set<string> = new Set<string>(),
): Set<string> {
  if (typeof expression === "string") {
    symbols.add(expression);
  } else if (Array.isArray(expression)) {
    expression.forEach((child) => mentionedSymbols(child as PlainMathJson, symbols));
  } else if (typeof expression === "object" && expression !== null) {
    if ("sym" in expression && typeof expression.sym === "string") symbols.add(expression.sym);
    if ("fn" in expression) {
      (expression.fn as readonly PlainMathJson[]).forEach((child) =>
        mentionedSymbols(child, symbols),
      );
    }
  }
  return symbols;
}

/** The symbols a library result's statement, premises, side conditions and patterns mention. */
export function resultMentionedSymbols(
  result: Readonly<{
    statement: Readonly<{ expression: PlainMathJson }>;
    premises: readonly Readonly<{ expression: PlainMathJson }>[];
    sideConditions?: readonly Readonly<{
      statement?: Readonly<{ expression: PlainMathJson }> | undefined;
    }>[];
    patterns: readonly Readonly<{ expression: PlainMathJson }>[];
  }>,
): ReadonlySet<string> {
  const symbols = new Set<string>();
  mentionedSymbols(result.statement.expression, symbols);
  result.premises.forEach(({ expression }) => mentionedSymbols(expression, symbols));
  (result.sideConditions ?? []).forEach(({ statement }) => {
    if (statement !== undefined) mentionedSymbols(statement.expression, symbols);
  });
  result.patterns.forEach(({ expression }) => mentionedSymbols(expression, symbols));
  return symbols;
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
