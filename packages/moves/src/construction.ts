/**
 * Constructed parameters of a move (refinement section 7.2; slice M, "Save as reusable move").
 *
 * A reviewed move template may state a proposition or a term as a MathJSON template over its
 * pattern metavariables, for example the contrapositive `Implies(Not(B), Not(A))` of a selected
 * `Implies(A, B)`. This module is the deterministic core of that language: which symbols of a
 * pattern are metavariables, how the selections bind them, and how a template is instantiated.
 * It adds no mathematics of its own. The instantiated value is only offered as one more item of
 * the parameter's menu (materialization), where the menu's typing check and then the kernel decide
 * whether it is acceptable.
 *
 * Metavariables are the free symbols of a pattern that are neither built-in nor operators, the same
 * convention retrieval uses for move patterns. Matching is first-order and binds a metavariable to
 * a subterm of the selected fragment. Instantiation is simultaneous and capture-avoiding
 * (`substituteMathJson`), so it commutes with renaming the symbols of the proof state.
 */
import { alphaEquivalent, matchExpressionPattern } from "@proof/kernel";
import {
  RESERVED_BUILTIN_SYMBOLS,
  freeSymbolNames,
  substituteMathJson,
  type OperatorDeclaration,
  type PlainMathJson,
} from "@proof/mathjson-model";

export type MetavariableBindings = ReadonlyMap<string, PlainMathJson>;

/** The symbols of a pattern or template that a binding must supply, in first-occurrence order. */
export function metavariablesOf(
  expression: PlainMathJson,
  operators: readonly OperatorDeclaration[],
): readonly string[] {
  const fixed = new Set(operators.map(({ symbol }) => symbol));
  return freeSymbolNames(expression, { operators }).filter(
    (symbol) => !fixed.has(symbol) && !RESERVED_BUILTIN_SYMBOLS.has(symbol),
  );
}

export type PatternFragment = Readonly<{
  /** The slot's pattern. */
  pattern: PlainMathJson;
  /** What the user selected for the slot. */
  fragment: PlainMathJson;
}>;

/**
 * Bind the metavariables of the patterns by matching each against the fragment selected for its
 * slot. A slot may carry several patterns; the first that matches consistently with what is bound
 * so far is used. A slot whose selection matches none of its patterns binds nothing: a template
 * that needs one of its metavariables is then reported by `instantiateTemplate`.
 */
export function bindPatterns(
  slots: readonly (readonly PatternFragment[])[],
  operators: readonly OperatorDeclaration[],
): Map<string, PlainMathJson> {
  const bindings = new Map<string, PlainMathJson>();
  for (const alternatives of slots) {
    for (const { pattern, fragment } of alternatives) {
      const matched = matchExpressionPattern(
        pattern,
        fragment,
        metavariablesOf(pattern, operators),
        {
          operators,
        },
      );
      if (matched !== undefined && mergeBindings(bindings, matched, operators)) break;
    }
  }
  return bindings;
}

/** Add `incoming` to `bindings` unless it contradicts them; false (bindings unchanged) then. */
export function mergeBindings(
  bindings: Map<string, PlainMathJson>,
  incoming: Readonly<Record<string, PlainMathJson>>,
  operators: readonly OperatorDeclaration[],
): boolean {
  const entries = Object.entries(incoming);
  const consistent = entries.every(([symbol, expression]) => {
    const known = bindings.get(symbol);
    return known === undefined || alphaEquivalent(known, expression, { operators });
  });
  if (!consistent) return false;
  for (const [symbol, expression] of entries) {
    if (!bindings.has(symbol)) bindings.set(symbol, expression);
  }
  return true;
}

export type Instantiation =
  | Readonly<{ ok: true; expression: PlainMathJson }>
  | Readonly<{ ok: false; message: string; unbound: readonly string[] }>;

/**
 * Instantiate a template with the bindings. Every metavariable of the template must be bound, so a
 * template cannot silently keep a symbol of the situation it was written in.
 */
export function instantiateTemplate(
  template: PlainMathJson,
  bindings: MetavariableBindings,
  operators: readonly OperatorDeclaration[],
): Instantiation {
  const needed = metavariablesOf(template, operators);
  const unbound = needed.filter((symbol) => !bindings.has(symbol));
  if (unbound.length > 0) {
    return {
      ok: false,
      message: `The template uses ${unbound.join(", ")}, which no selection of the move binds.`,
      unbound,
    };
  }
  const substitutions = needed.flatMap((symbol) => {
    const replacement = bindings.get(symbol) as PlainMathJson;
    return isSymbol(replacement, symbol) ? [] : [{ symbol, replacement }];
  });
  if (substitutions.length === 0) return { ok: true, expression: template };
  const substituted = substituteMathJson(template, substitutions, { operators });
  return substituted.ok
    ? { ok: true, expression: substituted.expression }
    : {
        ok: false,
        message: substituted.diagnostics[0]?.message ?? "The template could not be instantiated.",
        unbound: [],
      };
}

function isSymbol(expression: PlainMathJson, name: string): boolean {
  if (typeof expression === "string") return expression === name;
  return (
    typeof expression === "object" &&
    expression !== null &&
    !Array.isArray(expression) &&
    "sym" in expression &&
    expression.sym === name
  );
}
