import { alphaEquivalent } from "@proof/kernel";
import type { LibraryResult } from "@proof/library";
import {
  RESERVED_BUILTIN_SYMBOLS,
  createStatementViewSchema,
  declarationIdSchema,
  freeSymbolNames,
  freshSymbolName,
  substituteMathJson,
  type Declaration,
  type OperatorDeclaration,
  type PlainMathJson,
  type Sort,
} from "@proof/mathjson-model";

/**
 * How well a bound term fits a declared parameter sort:
 * `exact` when the local declarations prove the sort, `mismatch` when every
 * free symbol is declared yet the sort check fails (the kernel would reject
 * the instantiation), and `unknown` when the term mentions symbols the local
 * context does not declare, such as variables bound by an enclosing binder.
 */
export type TypeFit = "exact" | "unknown" | "mismatch";

export type FilterContext = Readonly<{
  declarations: readonly Declaration[];
  hypotheses: readonly PlainMathJson[];
  operators: readonly OperatorDeclaration[];
  /** Per-query memo of sort checks keyed by term and sort. */
  sortCache: Map<string, TypeFit>;
}>;

/** Typed unification: combine the fits of every bound, sorted result parameter. */
export function bindingsTypeFit(
  result: LibraryResult,
  bindings: ReadonlyMap<string, PlainMathJson>,
  context: FilterContext,
): TypeFit {
  let fit: TypeFit = "exact";
  for (const parameter of result.parameters) {
    const term = bindings.get(parameter.symbol);
    if (term === undefined) continue;
    const parameterFit = termSortFit(term, parameter.sort, context);
    if (parameterFit === "mismatch") return "mismatch";
    if (parameterFit === "unknown") fit = "unknown";
  }
  return fit;
}

/**
 * The parts of a sort probe that depend only on the local declarations and operators, not on the
 * term or sort being checked: the declared symbol set, the probe's declaration ID and symbol, and
 * the statement validators already built for each expected sort.
 *
 * Every term that reaches a probe has only declared or reserved free symbols, and
 * `freshSymbolName` already avoids reserved symbols, so the probe symbol is the same for every term
 * of a context and for every expected sort.
 */
type SortProbeBase = Readonly<{
  declared: ReadonlySet<string>;
  probeId: string;
  probeSymbol: string;
  /** Validators by serialized expected sort; `undefined` when the validator cannot be built. */
  validators: Map<string, ReturnType<typeof createStatementViewSchema> | undefined>;
}>;

/** Keyed by the identity of the immutable declaration and operator lists a context carries. */
const sortProbeBases = new WeakMap<
  readonly Declaration[],
  WeakMap<readonly OperatorDeclaration[], SortProbeBase>
>();

function sortProbeBaseFor(context: FilterContext): SortProbeBase {
  let byOperators = sortProbeBases.get(context.declarations);
  if (byOperators === undefined) {
    byOperators = new WeakMap();
    sortProbeBases.set(context.declarations, byOperators);
  }
  const existing = byOperators.get(context.operators);
  if (existing !== undefined) return existing;
  const declared = new Set<string>([
    ...context.declarations.map(({ symbol }) => symbol),
    ...context.operators.map(({ symbol }) => symbol),
  ]);
  const usedIds = new Set<string>(context.declarations.map(({ id }) => id));
  let probeId = "declaration:retrieval-sort-probe";
  for (let suffix = 1; usedIds.has(probeId); suffix += 1) {
    probeId = `declaration:retrieval-sort-probe-${suffix}`;
  }
  const base: SortProbeBase = {
    declared,
    probeId,
    probeSymbol: freshSymbolName("SortProbe", declared),
    validators: new Map(),
  };
  byOperators.set(context.operators, base);
  return base;
}

function termSortFit(term: PlainMathJson, expected: Sort, context: FilterContext): TypeFit {
  const cacheKey = `${JSON.stringify(term)}\u0000${JSON.stringify(expected)}`;
  const cached = context.sortCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const base = sortProbeBaseFor(context);
  const undeclared = freeSymbolNames(term, { operators: context.operators }).some(
    (symbol) => !base.declared.has(symbol) && !RESERVED_BUILTIN_SYMBOLS.has(symbol),
  );
  const fit: TypeFit = undeclared ? "unknown" : probeTermSort(term, expected, context, base);
  context.sortCache.set(cacheKey, fit);
  return fit;
}

/**
 * Check a term's sort with the statement validator: a fresh predicate of sort
 * `(expected) -> proposition` is applied to the term, which is proposition
 * valued exactly when the term has the expected sort in the local context.
 * This mirrors the kernel's own instantiation check.
 *
 * Only a genuine schema rejection is a `mismatch`. A probe that throws, such as an environment the
 * validator refuses to build, proves nothing about the term, so it yields the conservative
 * `unknown` and the candidate is kept rather than silently dropped.
 */
function probeTermSort(
  term: PlainMathJson,
  expected: Sort,
  context: FilterContext,
  base: SortProbeBase,
): TypeFit {
  try {
    const sortKey = JSON.stringify(expected);
    if (!base.validators.has(sortKey)) {
      base.validators.set(sortKey, buildProbeValidator(expected, context, base));
    }
    const validator = base.validators.get(sortKey);
    if (validator === undefined) return "unknown";
    return validator.safeParse({ expression: [base.probeSymbol, term] }).success
      ? "exact"
      : "mismatch";
  } catch {
    return "unknown";
  }
}

function buildProbeValidator(
  expected: Sort,
  context: FilterContext,
  base: SortProbeBase,
): ReturnType<typeof createStatementViewSchema> | undefined {
  try {
    return createStatementViewSchema({
      declarations: [
        ...context.declarations,
        {
          id: declarationIdSchema.parse(base.probeId),
          symbol: base.probeSymbol,
          sort: {
            kind: "function",
            signature: { parameters: [expected], result: { kind: "proposition" } },
          },
          role: "universal-parameter",
        },
      ],
      operators: context.operators,
    });
  } catch {
    return undefined;
  }
}

export type PredictedObligation = Readonly<{
  kind: "premise" | "side-condition";
  /** Zero-based position among the result's premises or side conditions. */
  index: number;
  description: string;
  /**
   * Zero-based position among the premises a result application instantiates: the explicit
   * premises, then the side conditions that have a statement, in declaration order. Absent for a
   * purely descriptive side condition, which no application checks.
   */
  applicationPremiseIndex?: number | undefined;
}>;

export type PremiseEvaluation = Readonly<{
  /** IDs of result parameters that the match leaves undetermined, sorted. */
  unresolvedParameters: readonly string[];
  availablePremiseCount: number;
  obligations: readonly PredictedObligation[];
}>;

/**
 * Side-condition evaluation for a matched result. A premise or statement-backed
 * side condition whose instance is alpha-equivalent to a hypothesis of the
 * selection's context is already available; every other premise or side
 * condition, including one that mentions an undetermined parameter or has
 * only a prose description, is predicted to become a new obligation.
 */
export function evaluateResultPremises(
  result: LibraryResult,
  bindings: ReadonlyMap<string, PlainMathJson>,
  context: FilterContext,
): PremiseEvaluation {
  const parameterSymbols = new Set(result.parameters.map(({ symbol }) => symbol));
  const freeParameters = (expression: PlainMathJson): readonly string[] =>
    freeSymbolNames(expression, { operators: context.operators }).filter((symbol) =>
      parameterSymbols.has(symbol),
    );
  const statements = [
    result.statement.expression,
    ...result.premises.map(({ expression }) => expression),
    ...result.sideConditions.flatMap(({ statement }) =>
      statement === undefined ? [] : [statement.expression],
    ),
  ];
  const required = new Set(statements.flatMap(freeParameters));
  const unresolvedParameters = result.parameters
    .filter(({ symbol }) => required.has(symbol) && !bindings.has(symbol))
    .map(({ id }) => id)
    .sort(compareStrings);

  const isAvailable = (expression: PlainMathJson): boolean => {
    const free = freeParameters(expression);
    if (free.some((symbol) => !bindings.has(symbol))) return false;
    const substituted = substituteMathJson(
      expression,
      free.map((symbol) => ({ symbol, replacement: bindings.get(symbol) as PlainMathJson })),
      { operators: context.operators },
    );
    return (
      substituted.ok &&
      context.hypotheses.some((hypothesis) =>
        alphaEquivalent(substituted.expression, hypothesis, { operators: context.operators }),
      )
    );
  };

  let availablePremiseCount = 0;
  const obligations: PredictedObligation[] = [];
  result.premises.forEach((premise, index) => {
    if (isAvailable(premise.expression)) {
      availablePremiseCount += 1;
    } else {
      obligations.push({
        kind: "premise",
        index,
        description: `premise ${index + 1}`,
        applicationPremiseIndex: index,
      });
    }
  });
  let applicationPremiseIndex = result.premises.length;
  result.sideConditions.forEach((condition, index) => {
    if (condition.statement !== undefined && isAvailable(condition.statement.expression)) {
      availablePremiseCount += 1;
    } else {
      obligations.push({
        kind: "side-condition",
        index,
        description: condition.description,
        ...(condition.statement === undefined ? {} : { applicationPremiseIndex }),
      });
    }
    if (condition.statement !== undefined) applicationPremiseIndex += 1;
  });
  return { unresolvedParameters, availablePremiseCount, obligations };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
