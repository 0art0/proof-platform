import {
  freeSymbolNames,
  substituteMathJson,
  type AdditionalAssumption,
  type ContextualSequent,
  type Declaration,
  type Hypothesis,
  type OperatorDeclaration,
  type PlainMathJson,
  type StatementId,
} from "@proof/mathjson-model";
import { alphaEquivalentWithOperators } from "./alpha-equivalence";
import { operatorOperands, symbolValue } from "./expression";
import { collectSymbolNames, termHasSortInContext, type ResultInstantiation } from "./results";

/**
 * The universal closure of a contextual sequent restricted to what its
 * conclusion depends on (design plan §11): `∀x1..xn. (H1 ∧ … ∧ Hk) ⇒ G`.
 *
 * Dependency rule: start from the declared symbols free in `G`; repeatedly
 * include every hypothesis whose free declared symbols intersect the included
 * symbols, and add that hypothesis's free declared symbols. The binders are the
 * included symbols in context-declaration order, and the hypotheses keep
 * context order. With no hypotheses the implication is omitted, with one there
 * is no `And`, and with no binders there is no quantifier. Built-in `ForAll`
 * binds exactly one symbol whose sort comes from the declarations, so binders
 * nest. `declarations` lists exactly the context declarations of symbols that
 * occur in the closure (its binders and any symbol bound inside `G` or an
 * included hypothesis), which is what validation needs to sort its binders.
 */
export type SorryClosure = Readonly<{
  statement: PlainMathJson;
  declarations: readonly Declaration[];
  /** Bound symbols of the outer universal prefix, outermost first. */
  binders: readonly string[];
  hypothesisIds: readonly StatementId[];
}>;

export type SorryClosureResult =
  | Readonly<{ ok: true; closure: SorryClosure }>
  | Readonly<{ ok: false; code: "construction-metavariable-dependency"; message: string }>;

export function sorryClosure(
  sequent: ContextualSequent,
  operators: readonly OperatorDeclaration[],
): SorryClosureResult {
  const declared = new Map(
    sequent.context.declarations.map((declaration) => [declaration.symbol, declaration]),
  );
  const freeDeclared = (expression: PlainMathJson): readonly string[] =>
    freeSymbolNames(expression, { operators }).filter((symbol) => declared.has(symbol));

  const variables = new Set(freeDeclared(sequent.conclusion.expression));
  const included = new Set<number>();
  for (let changed = true; changed;) {
    changed = false;
    sequent.context.hypotheses.forEach((candidate, index) => {
      if (included.has(index)) return;
      const symbols = freeDeclared(candidate.statement.expression);
      if (!symbols.some((symbol) => variables.has(symbol))) return;
      included.add(index);
      symbols.forEach((symbol) => variables.add(symbol));
      changed = true;
    });
  }

  const hypotheses = sequent.context.hypotheses.filter((_candidate, index) => included.has(index));
  const occurring = new Set<string>();
  [sequent.conclusion.expression, ...hypotheses.map(statementExpression)].forEach((expression) =>
    collectSymbolNames(expression, occurring),
  );
  const declarations = sequent.context.declarations.filter((declaration) =>
    occurring.has(declaration.symbol),
  );
  const construction = declarations.find(
    (declaration) => declaration.role === "construction-metavariable",
  );
  if (construction !== undefined) {
    return {
      ok: false,
      code: "construction-metavariable-dependency",
      message: `The target depends on construction metavariable ${construction.symbol}; resolve or eliminate it before marking the target as a sorry.`,
    };
  }

  const binders = sequent.context.declarations
    .filter((declaration) => variables.has(declaration.symbol))
    .map((declaration) => declaration.symbol);
  const conclusion = structuredClone(sequent.conclusion.expression);
  const antecedents = hypotheses.map((entry) => structuredClone(statementExpression(entry)));
  let statement: PlainMathJson =
    antecedents.length === 0
      ? conclusion
      : [
          "Implies",
          antecedents.length === 1 ? (antecedents[0] as PlainMathJson) : ["And", ...antecedents],
          conclusion,
        ];
  for (const symbol of [...binders].reverse()) statement = ["ForAll", symbol, statement];

  return {
    ok: true,
    closure: {
      statement,
      declarations: structuredClone(declarations),
      binders,
      hypothesisIds: hypotheses.map((entry) => entry.id),
    },
  };
}

export type AssumptionInstanceResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code:
        "invalid-instantiation" | "replacement-failed" | "conclusion-mismatch" | "premise-mismatch";
      message: string;
    }>;

/**
 * Decide whether an additional assumption closes a target. The instantiation
 * names the leading `ForAll` binders of the assumption, outermost first and
 * without gaps; each term must be well-sorted and in scope in the target's
 * local context, with the binder's sort taken from the assumption's
 * declarations. The instantiated body then closes the target when it is
 * alpha-equivalent to the conclusion, or when it is `A ⇒ G'` with `G'`
 * alpha-equivalent to the conclusion and `A` available locally: either `A`
 * itself or, for a conjunction `A`, every conjunct is alpha-equivalent to a
 * local hypothesis. Every accepted case is an instance of the closed
 * assumption followed by modus ponens, whatever the closure's original shape.
 */
export function closesByAssumption(
  assumption: AdditionalAssumption,
  instantiation: ResultInstantiation,
  sequent: ContextualSequent,
  operators: readonly OperatorDeclaration[],
): AssumptionInstanceResult {
  const remaining = new Set(Object.keys(instantiation));
  const substitutions: { symbol: string; replacement: PlainMathJson }[] = [];
  let body = assumption.statement.expression;
  while (remaining.size > 0) {
    const operands = operatorOperands(body, "ForAll");
    const symbol = operands?.length === 2 ? symbolValue(operands[0] as PlainMathJson) : undefined;
    if (operands === undefined || symbol === undefined || !remaining.has(symbol)) {
      return instanceFailure(
        "invalid-instantiation",
        "The instantiation must name exactly a prefix of the assumption's leading universal binders.",
      );
    }
    const declaration = assumption.declarations.find((candidate) => candidate.symbol === symbol);
    const term = instantiation[symbol] as PlainMathJson;
    if (
      declaration === undefined ||
      !termHasSortInContext(term, declaration.sort, sequent.context.declarations, operators)
    ) {
      return instanceFailure(
        "invalid-instantiation",
        `The term for binder ${symbol} is not well-sorted and in scope in the target's local context.`,
      );
    }
    substitutions.push({ symbol, replacement: term });
    remaining.delete(symbol);
    body = operands[1] as PlainMathJson;
  }
  const substituted = substituteMathJson(body, substitutions, { operators });
  if (!substituted.ok) {
    return instanceFailure(
      "replacement-failed",
      "The capture-avoiding instantiation of the assumption could not be constructed.",
    );
  }
  const instance = substituted.expression;
  const conclusion = sequent.conclusion.expression;
  if (alphaEquivalentWithOperators(instance, conclusion, operators)) return { ok: true };

  const implication = operatorOperands(instance, "Implies");
  if (
    implication?.length !== 2 ||
    !alphaEquivalentWithOperators(implication[1] as PlainMathJson, conclusion, operators)
  ) {
    return instanceFailure(
      "conclusion-mismatch",
      "The instantiated assumption does not conclude the target conclusion up to renaming of bound symbols.",
    );
  }
  const antecedent = implication[0] as PlainMathJson;
  const available = (expression: PlainMathJson): boolean =>
    sequent.context.hypotheses.some((candidate) =>
      alphaEquivalentWithOperators(statementExpression(candidate), expression, operators),
    );
  const conjuncts = operatorOperands(antecedent, "And");
  if (
    available(antecedent) ||
    (conjuncts !== undefined && conjuncts.length > 0 && conjuncts.every(available))
  ) {
    return { ok: true };
  }
  return instanceFailure(
    "premise-mismatch",
    "Some antecedent hypothesis of the instantiated assumption is not present in the target's local context.",
  );
}

function statementExpression(entry: Hypothesis): PlainMathJson {
  return entry.statement.expression;
}

function instanceFailure(
  code: Extract<AssumptionInstanceResult, { ok: false }>["code"],
  message: string,
): AssumptionInstanceResult {
  return { ok: false, code, message };
}
