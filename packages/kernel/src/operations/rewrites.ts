/**
 * Handler of the three rewrite operations: one occurrence of a conclusion or hypothesis is replaced
 * using an equality, an equivalence or an implication from a hypothesis or an approved result.
 */
import {
  mathJsonEquals,
  type ContextualSequent,
  type Hypothesis,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofState,
} from "@proof/mathjson-model";
import { alphaEquivalentWithOperators } from "../alpha-equivalence";
import { locateRewriteOccurrence, rewriteCaptures, type RewriteSource } from "../deep-rewrite";
import { operatorOperands } from "../expression";
import type { KernelDiagnosticCode, TransitionClass, TransitionStatementTarget } from "../index";
import { instantiateResultInContext, type KernelResult, type KernelResultId } from "../results";
import {
  findHypothesis,
  findHypothesisIndex,
  hypothesis,
  internalFailure,
  missingHypothesis,
  notApplicable,
  replaceHypothesis,
  replaceTarget,
  replacementFailed,
  success,
  withConclusion,
  type InternalResult,
  type LocatedTarget,
  type OperationOfKind,
  type TargetEntry,
} from "./shared";

type RewriteOperation = OperationOfKind<
  "rewrite-with-equality" | "rewrite-with-equivalence" | "rewrite-with-implication"
>;

const REWRITE_SOURCE_OPERATORS = {
  "rewrite-with-equality": ["Equal", "equality"],
  "rewrite-with-equivalence": ["Equivalent", "equivalence"],
  "rewrite-with-implication": ["Implies", "implication"],
} as const;

/**
 * Rewrite one occurrence, addressed by an operand path or by an associative
 * lens under that path, in the conclusion or a hypothesis of the target.
 * Polarity is the overall polarity from the selection resolver's
 * `positionAtPath`: a conclusion is positive and a hypothesis negative, so the
 * rule reads the sequent as `∧hypotheses ⇒ conclusion`.
 *
 * - `rewrite-with-equality` replaces an exact occurrence of one side of a
 *   local binary equality by the other side (equivalence).
 * - `rewrite-with-equivalence` replaces a proposition occurrence
 *   alpha-equivalent to one side of `A ⇔ B` by the other side at any
 *   polarity (equivalence).
 * - `rewrite-with-implication` uses `A ⇒ B` monotonically. At a positive
 *   position an occurrence of `B` becomes `A`; at a negative position an
 *   occurrence of `A` becomes `B`. In both cases the new sequent entails the
 *   old one given `A ⇒ B`, so proving it suffices (strengthening). Mixed and
 *   neutral positions are rejected with `polarity-not-permitted`.
 *
 * A match whose free symbols, or a replacement whose free symbols, are bound
 * by a binder enclosing the occurrence is rejected as capture. A hypothesis
 * source is retained and cannot rewrite itself. A result source must be
 * premise-free; it is instantiated for backward application when the
 * conclusion is rewritten and for forward application when a hypothesis is.
 */
export function rewriteStatement(
  state: ProofState,
  target: LocatedTarget,
  operation: RewriteOperation,
  operators: readonly OperatorDeclaration[],
  results: readonly KernelResult[],
): InternalResult {
  const sequent = target.entry.sequent;
  const sourceReference: RewriteSource =
    operation.kind === "rewrite-with-equality"
      ? { kind: "hypothesis", hypothesisId: operation.equalityHypothesisId }
      : operation.source;
  const source = resolveRewriteSource(
    sourceReference,
    operation.statement,
    sequent,
    operators,
    results,
  );
  if (!source.ok) return internalFailure(state, source.code, source.message);
  const [sourceOperator, sourceLabel] = REWRITE_SOURCE_OPERATORS[operation.kind];
  const sides = operatorOperands(source.expression, sourceOperator);
  if (sides === undefined || sides.length !== 2) {
    return notApplicable(state, `The rewrite source is not a binary ${sourceLabel}.`);
  }
  if (
    sourceReference.kind === "hypothesis" &&
    operation.statement.kind === "hypothesis" &&
    operation.statement.id === sourceReference.hypothesisId
  ) {
    return notApplicable(state, "A rewrite source cannot consume itself as its own target.");
  }

  const statementHypothesisIndex =
    operation.statement.kind === "hypothesis"
      ? findHypothesisIndex(sequent, operation.statement.id)
      : -1;
  if (operation.statement.kind === "hypothesis" && statementHypothesisIndex < 0) {
    return missingHypothesis(state);
  }
  const expression =
    operation.statement.kind === "conclusion"
      ? sequent.conclusion.expression
      : (sequent.context.hypotheses[statementHypothesisIndex] as Hypothesis).statement.expression;
  const [left, right] = sides as readonly [PlainMathJson, PlainMathJson];
  const exact = operation.kind === "rewrite-with-equality";
  const same = (first: PlainMathJson, second: PlainMathJson): boolean =>
    exact ? mathJsonEquals(first, second) : alphaEquivalentWithOperators(first, second, operators);
  if (same(left, right)) {
    return notApplicable(state, `The ${sourceLabel} does not provide a distinct replacement.`);
  }

  const occurrence = locateRewriteOccurrence(
    expression,
    operation.path,
    operation.lens,
    operation.statement.kind === "conclusion" ? "positive" : "negative",
    sequent.context.declarations,
    operators,
  );
  if (occurrence === undefined) {
    return internalFailure(
      state,
      "invalid-path",
      "The rewrite path or lens does not address an occurrence.",
    );
  }
  if (!exact && occurrence.role !== "proposition") {
    return internalFailure(
      state,
      "invalid-path",
      "The rewrite occurrence is not in a proposition position.",
    );
  }

  let matched: PlainMathJson;
  let replacement: PlainMathJson;
  let transitionClass: TransitionClass = "equivalence";
  if (operation.kind === "rewrite-with-implication") {
    if (occurrence.polarity === "positive") {
      [matched, replacement] = [right, left];
    } else if (occurrence.polarity === "negative") {
      [matched, replacement] = [left, right];
    } else {
      return internalFailure(
        state,
        "polarity-not-permitted",
        `An implication cannot rewrite at a ${occurrence.polarity} position; only positive and negative positions are monotone.`,
      );
    }
    transitionClass = "strengthening";
  } else {
    [matched, replacement] = operation.direction === "forward" ? [left, right] : [right, left];
  }

  if (!same(occurrence.fragment, matched)) {
    return notApplicable(state, `The selected occurrence does not match the ${sourceLabel} side.`);
  }
  if (rewriteCaptures(occurrence, [matched, replacement], operators)) {
    return notApplicable(
      state,
      "The rewrite would capture a free symbol under an enclosing binder.",
    );
  }
  const rewritten = occurrence.replace(replacement);
  if (rewritten === undefined) return replacementFailed(state);

  const replacementTarget: TargetEntry =
    operation.statement.kind === "conclusion"
      ? withConclusion(target.entry, rewritten)
      : replaceHypothesis(target.entry, statementHypothesisIndex, [
          hypothesis(operation.statement.id, rewritten),
        ]);
  return success(
    replaceTarget(state, operation.target, target.index, [replacementTarget]),
    transitionClass,
    source.resultId === undefined ? "structural" : "library-result",
    source.resultId,
  );
}

type ResolvedRewriteSource =
  | Readonly<{ ok: true; expression: PlainMathJson; resultId?: KernelResultId }>
  | Readonly<{ ok: false; code: KernelDiagnosticCode; message: string }>;

function resolveRewriteSource(
  source: RewriteSource,
  statement: TransitionStatementTarget,
  sequent: ContextualSequent,
  operators: readonly OperatorDeclaration[],
  results: readonly KernelResult[],
): ResolvedRewriteSource {
  if (source.kind === "hypothesis") {
    const selected = findHypothesis(sequent, source.hypothesisId);
    return selected === undefined
      ? {
          ok: false,
          code: "hypothesis-not-found",
          message: "The hypothesis does not exist in the target's local context.",
        }
      : { ok: true, expression: selected.statement.expression };
  }
  const instance = instantiateResultInContext(
    results,
    source.resultId,
    statement.kind === "conclusion" ? "backward" : "forward",
    source.instantiation,
    sequent,
    operators,
  );
  if (!instance.ok) return { ok: false, code: instance.code, message: instance.message };
  if (instance.premises.length > 0) {
    return {
      ok: false,
      code: "rule-not-applicable",
      message: "Only a premise-free result can be used as a rewrite source.",
    };
  }
  return { ok: true, expression: instance.conclusion, resultId: source.resultId };
}
