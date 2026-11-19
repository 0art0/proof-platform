import {
  functionParts,
  parseKernelResultCatalog,
  type KernelResult,
  type KernelResultId,
  type ResultCatalogIssue,
} from "@proof/kernel";
import type { LibraryResult } from "@proof/library";
import {
  deepFreeze,
  mathJsonEquals,
  type OperatorDeclaration,
  type PlainMathJson,
  type StatementView,
} from "@proof/mathjson-model";

export type ResultAdapterDiagnostic = Readonly<{
  code: "invalid-result";
  message: string;
  path: readonly PropertyKey[];
}>;

export type ResultAdapterResult =
  | Readonly<{ ok: true; result: KernelResult; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly [ResultAdapterDiagnostic] }>;

/**
 * Adapt a library result `∀ parameters. premises ⊢ statement` to the kernel's
 * `∀ parameters. premises ⇒ conclusion` shape.
 *
 * - Parameters keep their symbol and sort; the library declaration IDs are dropped.
 * - Premises are the explicit premises followed by every side condition that has
 *   a statement, in declaration order. A purely descriptive side condition (no
 *   statement) is not a premise; the kernel cannot check it.
 * - Implication rule: a top-level `Implies(A, B)` statement always splits. Its
 *   antecedent is appended to the premises, and the consequent `B` becomes the
 *   conclusion. When `A` is an `And`, each of its direct conjuncts becomes one
 *   premise, in order; nested `And`s and a curried consequent `B = C ⇒ D` are
 *   not split further. Modus ponens `((p⇒q)∧p)⇒q` therefore becomes premises
 *   `[p⇒q, p]` with conclusion `q`.
 *
 * The split is logically an equivalence, `P ⊢ (A ⇒ B)` iff `P, A ⊢ B`. It
 * matches how the library indexes an implication for retrieval (and how
 * `generateVariants` derives patterns): the forward pattern is the antecedent,
 * a hypothesis, and the backward pattern is the consequent, a goal. Split this
 * way, `applicationDirections` keep their meaning. Forward application derives
 * `B` from hypotheses matching the antecedent, and backward application reduces
 * a goal `B` to goals `A`. The cost is that an implication result is no longer a
 * premise-free `Implies`. The original rule is also retained for generalized rewriting,
 * which uses it to transport directional relations through predicates.
 * A tagged predicate transport can also expose an implication from its final
 * premise to its conclusion while keeping both in their ordinary positions.
 */
export function libraryResultToKernelResult(
  result: LibraryResult,
  environment: Readonly<{ operators?: readonly OperatorDeclaration[] }> = {},
): ResultAdapterResult {
  try {
    const candidate = resultCandidate(result);
    const parsed = parseKernelResultCatalog([candidate], environment.operators ?? []);
    if (!parsed.ok) {
      return invalidResult(parsed.issue.message, parsed.issue.path.slice(1));
    }
    return deepFreeze({ ok: true, result: parsed.results[0] as KernelResult, diagnostics: [] });
  } catch {
    return invalidResult("The library result could not be adapted.", []);
  }
}

function resultCandidate(result: LibraryResult): KernelResult {
  const premises: StatementView[] = [
    ...result.premises.map(({ expression }) => ({ expression })),
    ...result.sideConditions.flatMap(({ statement }) =>
      statement === undefined ? [] : [{ expression: statement.expression }],
    ),
  ];
  let conclusion = result.statement.expression;
  const implication = binaryOperands(conclusion, "Implies");
  const congruenceRule =
    implication === undefined
      ? predicateTransportRule(result.congruenceSymbols, premises, conclusion)
      : { premises: [...premises], conclusion: { expression: conclusion } };
  if (implication !== undefined) {
    const [antecedent, consequent] = implication;
    const conjuncts = operands(antecedent, "And");
    (conjuncts !== undefined && conjuncts.length > 0 ? conjuncts : [antecedent]).forEach(
      (expression) => premises.push({ expression }),
    );
    conclusion = consequent;
  }
  return {
    id: result.id as string as KernelResultId,
    parameters: result.parameters.map(({ symbol, sort }) => ({ symbol, sort })),
    premises,
    ...(result.congruenceSymbols === undefined
      ? {}
      : { congruenceSymbols: result.congruenceSymbols }),
    ...(congruenceRule === undefined ? {} : { congruenceRule }),
    conclusion: { expression: conclusion },
    directions: result.applicationDirections,
  };
}

/** Curry the final premise of a tagged predicate transport for congruence search. */
function predicateTransportRule(
  symbols: readonly string[] | undefined,
  premises: readonly StatementView[],
  conclusion: PlainMathJson,
): KernelResult["congruenceRule"] {
  if (symbols?.length !== 1 || premises.length < 2) return undefined;
  const output = functionParts(conclusion);
  // An And antecedent would split into multiple ordinary premises.
  if (output === undefined || output.operator === "And" || output.operator !== symbols[0]) {
    return undefined;
  }
  const antecedent = premises.at(-1)?.expression;
  const input = antecedent === undefined ? undefined : functionParts(antecedent);
  if (
    antecedent === undefined ||
    input?.operator !== output.operator ||
    input.operands.length !== output.operands.length
  ) {
    return undefined;
  }
  const changes = input.operands.filter(
    (operand, index) => !mathJsonEquals(operand, output.operands[index] as PlainMathJson),
  );
  return changes.length === 1
    ? {
        premises: premises.slice(0, -1),
        conclusion: { expression: ["Implies", antecedent, conclusion] },
      }
    : undefined;
}

function invalidResult(
  message: string,
  path: ResultCatalogIssue["path"],
): Extract<ResultAdapterResult, { ok: false }> {
  return { ok: false, diagnostics: [{ code: "invalid-result", message, path }] };
}

/**
 * Adapt every approved result of a catalog, in catalog order. Draft and
 * rejected results are never applicable; a result that fails adaptation is
 * reported rather than silently dropped.
 */
export function approvedKernelResults(
  results: readonly LibraryResult[],
  environment: Readonly<{ operators?: readonly OperatorDeclaration[] }> = {},
):
  | Readonly<{ ok: true; results: readonly KernelResult[]; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly [ResultAdapterDiagnostic] }> {
  const candidates: KernelResult[] = [];
  const sourceIndexes: number[] = [];
  for (const [index, result] of results.entries()) {
    if (result.approval.status !== "approved") continue;
    try {
      candidates.push(resultCandidate(result));
      sourceIndexes.push(index);
    } catch {
      return invalidResult("The library result could not be adapted.", [index]);
    }
  }
  const parsed = parseKernelResultCatalog(candidates, environment.operators ?? []);
  if (!parsed.ok) {
    const [index, ...issuePath] = parsed.issue.path;
    const path =
      typeof index === "number" ? [sourceIndexes[index] ?? index, ...issuePath] : parsed.issue.path;
    return invalidResult(parsed.issue.message, path);
  }
  return deepFreeze({ ok: true, results: parsed.results, diagnostics: [] });
}

function operands(expression: PlainMathJson, operator: string): PlainMathJson[] | undefined {
  if (Array.isArray(expression)) {
    return expression[0] === operator ? (expression.slice(1) as PlainMathJson[]) : undefined;
  }
  if (typeof expression === "object" && expression !== null && "fn" in expression) {
    return expression.fn[0] === operator ? expression.fn.slice(1) : undefined;
  }
  return undefined;
}

function binaryOperands(
  expression: PlainMathJson,
  operator: string,
): readonly [PlainMathJson, PlainMathJson] | undefined {
  const found = operands(expression, operator);
  return found?.length === 2 ? [found[0] as PlainMathJson, found[1] as PlainMathJson] : undefined;
}
