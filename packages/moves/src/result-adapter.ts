import {
  parseKernelResultCatalog,
  type KernelResult,
  type KernelResultId,
  type ResultApplicationDirection,
} from "@proof/kernel";
import type { LibraryResult } from "@proof/library";
import type { OperatorDeclaration, PlainMathJson, StatementView } from "@proof/mathjson-model";

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
 * premise-free `Implies`, so it cannot be a `rewrite-with-implication` source.
 * Equivalences, equalities and other statements are never split, so they remain
 * premise-free rewrite sources when they have no premises.
 */
export function libraryResultToKernelResult(
  result: LibraryResult,
  environment: Readonly<{ operators?: readonly OperatorDeclaration[] }> = {},
): ResultAdapterResult {
  try {
    const premises: StatementView[] = [
      ...result.premises.map((premise) => ({ expression: structuredClone(premise.expression) })),
      ...result.sideConditions.flatMap((condition) =>
        condition.statement === undefined
          ? []
          : [{ expression: structuredClone(condition.statement.expression) }],
      ),
    ];
    let conclusion: PlainMathJson = structuredClone(result.statement.expression);
    const implication = binaryOperands(conclusion, "Implies");
    if (implication !== undefined) {
      const [antecedent, consequent] = implication;
      const conjuncts = operands(antecedent, "And");
      (conjuncts !== undefined && conjuncts.length > 0 ? conjuncts : [antecedent]).forEach(
        (expression) => premises.push({ expression }),
      );
      conclusion = consequent;
    }
    const candidate = {
      id: result.id as string as KernelResultId,
      parameters: result.parameters.map(({ symbol, sort }) => ({
        symbol,
        sort: structuredClone(sort),
      })),
      premises,
      conclusion: { expression: conclusion },
      directions: [...result.applicationDirections] as ResultApplicationDirection[],
    };
    const parsed = parseKernelResultCatalog([candidate], environment.operators ?? []);
    if (!parsed.ok) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "invalid-result",
            message: parsed.issue.message,
            path: parsed.issue.path.slice(1),
          },
        ],
      };
    }
    return deepFreeze({ ok: true, result: parsed.results[0] as KernelResult, diagnostics: [] });
  } catch {
    return {
      ok: false,
      diagnostics: [
        { code: "invalid-result", message: "The library result could not be adapted.", path: [] },
      ],
    };
  }
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
  const adapted: KernelResult[] = [];
  for (const [index, result] of results.entries()) {
    if (result.approval.status !== "approved") continue;
    const converted = libraryResultToKernelResult(result, environment);
    if (!converted.ok) {
      const diagnostic = converted.diagnostics[0];
      return {
        ok: false,
        diagnostics: [{ ...diagnostic, path: [index, ...diagnostic.path] }],
      };
    }
    adapted.push(converted.result);
  }
  return deepFreeze({ ok: true, results: adapted, diagnostics: [] });
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

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
