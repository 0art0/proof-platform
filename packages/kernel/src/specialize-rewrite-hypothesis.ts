import {
  builtinBinderSorts,
  freshSymbolName,
  substituteMathJson,
  type Declaration,
  type OperatorDeclaration,
  type PlainMathJson,
  type Sort,
} from "@proof/mathjson-model";
import { functionParts, readQuantifier } from "./expression";
import {
  collectSymbolNames,
  matchResultExpressions,
  termHasSortInContext,
  type ResultInstance,
} from "./results";

/** Specialize leading universal quantifiers by matching the addressed side in its lexical context.
 * Fresh pattern names keep domain expressions, outer declarations and nested shadowing distinct.
 * Each restricted quantifier contributes its membership premise.
 */
export function specializeRewriteHypothesis(
  expression: PlainMathJson,
  fragment: PlainMathJson,
  direction: "forward" | "backward",
  sourceDeclarations: readonly Declaration[],
  occurrenceDeclarations: readonly Declaration[],
  operators: readonly OperatorDeclaration[],
): ResultInstance {
  const bindings = new Map(sourceDeclarations.map(({ symbol, sort }) => [symbol, sort]));
  const names = new Set([...bindings.keys(), ...operators.map(({ symbol }) => symbol)]);
  collectSymbolNames(expression, names);
  collectSymbolNames(fragment, names);
  const parameters = new Map<string, Sort>();
  const memberships: PlainMathJson[] = [];
  let body = expression;
  for (;;) {
    const binder = readQuantifier(body, "ForAll");
    if (binder === undefined) break;
    const sort = builtinBinderSorts(
      "ForAll",
      functionParts(body)!.operands,
      bindings,
      operators,
    )?.get(binder.symbol);
    if (sort === undefined)
      return {
        ok: false,
        code: "invalid-instantiation",
        message: "The quantified rewrite variable has no sort.",
      };
    const symbol = freshSymbolName("RewriteParam", names);
    names.add(symbol);
    bindings.set(symbol, sort);
    parameters.set(symbol, sort);
    if (binder.domain !== undefined) memberships.push(["Element", symbol, binder.domain]);
    const opened = substituteMathJson(
      binder.body,
      [{ symbol: binder.symbol, replacement: symbol }],
      { operators },
    );
    if (!opened.ok)
      return {
        ok: false,
        code: "replacement-failed",
        message: "Could not open the quantified rewrite hypothesis.",
      };
    body = opened.expression;
  }
  const side = functionParts(body)?.operands[direction === "forward" ? 0 : 1];
  const instance =
    side === undefined
      ? undefined
      : matchResultExpressions([[side, fragment]], [...parameters.keys()], operators);
  if (instance === undefined)
    return {
      ok: false,
      code: "invalid-instantiation",
      message: "The quantified relation does not match the selected occurrence.",
    };
  const substitutions: { symbol: string; replacement: PlainMathJson }[] = [];
  for (const [symbol, sort] of parameters) {
    const term = instance[symbol];
    if (
      term === undefined ||
      !termHasSortInContext(term, sort, occurrenceDeclarations, operators)
    ) {
      return {
        ok: false,
        code: "invalid-instantiation",
        message:
          "The occurrence must determine a well-sorted term for every quantified rewrite variable.",
      };
    }
    substitutions.push({ symbol, replacement: term });
  }
  const statements: PlainMathJson[] = [];
  for (const statement of [body, ...memberships]) {
    const result = substituteMathJson(statement, substitutions, { operators });
    if (!result.ok)
      return {
        ok: false,
        code: "replacement-failed",
        message: "Could not specialize the quantified rewrite without capture.",
      };
    statements.push(result.expression);
  }
  return { ok: true, conclusion: statements[0]!, premises: statements.slice(1) };
}
