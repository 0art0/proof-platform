/**
 * Handlers of the operations that apply an approved result from the environment's catalog to the
 * acted-on target, backward from a conclusion or forward from hypotheses.
 */
import type {
  Obligation,
  OperatorDeclaration,
  PlainMathJson,
  ProofState,
  StatementId,
} from "@proof/mathjson-model";
import { alphaEquivalentWithOperators } from "../alpha-equivalence";
import { instantiateResultInContext, type KernelResult } from "../results";
import {
  appendHypothesis,
  findHypothesis,
  hypothesis,
  hypothesisIdCollision,
  idCollision,
  internalFailure,
  missingHypothesis,
  obligationProvenance,
  replaceTarget,
  replaceWithObligations,
  success,
  targetIdCollision,
  type InternalResult,
  type LocatedTarget,
  type OperationOfKind,
  type TargetEntry,
} from "./shared";

/**
 * Backward application: the instantiated conclusion must match the target
 * conclusion up to alpha-equivalence, and each instantiated premise replaces
 * the target as a new target of the same kind in the same local context. A
 * result without premises closes the target. Proving the premises proves the
 * target, so the transition is a strengthening.
 */
export function applyResultBackward(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"apply-result-backward">,
  operators: readonly OperatorDeclaration[],
  results: readonly KernelResult[],
): InternalResult {
  const instance = instantiateResultInContext(
    results,
    operation.resultId,
    "backward",
    operation.instantiation,
    target.entry.sequent,
    operators,
  );
  if (!instance.ok) return internalFailure(state, instance.code, instance.message);
  if (
    !alphaEquivalentWithOperators(
      instance.conclusion,
      target.entry.sequent.conclusion.expression,
      operators,
    )
  ) {
    return internalFailure(
      state,
      "conclusion-mismatch",
      "The instantiated result conclusion does not match the target conclusion up to renaming of bound symbols.",
    );
  }
  if (operation.premiseTargetIds.length !== instance.premises.length) {
    return internalFailure(
      state,
      "arity-mismatch",
      "The supplied premise target IDs must correspond one-for-one with the result premises.",
    );
  }
  const collision = targetIdCollision(state, operation.premiseTargetIds);
  if (collision !== undefined) return idCollision(state, collision);
  const replacements = instance.premises.map((premise, index): TargetEntry => ({
    id: operation.premiseTargetIds[index] as StatementId,
    ...obligationProvenance(operation.target, {
      kind: "premise-of-result",
      resultId: operation.resultId,
    }),
    sequent: {
      context: structuredClone(target.entry.sequent.context),
      conclusion: { expression: premise },
    },
  }));
  return success(
    replaceTarget(state, operation.target, target.index, replacements),
    "strengthening",
    "library-result",
    operation.resultId,
  );
}

/**
 * Forward application: each instantiated premise is either matched up to
 * alpha-equivalence by the named local hypothesis or, for a null entry,
 * becomes an obligation in the target's local context. The instantiated
 * conclusion is appended to the target as a derived hypothesis. The kernel
 * classifies this from the outcome: equivalence when every premise is matched
 * (the derived fact adds nothing unprovable), strengthening when unmet premises
 * remain as required obligations. Obligations follow an
 * obligation target directly and are appended after existing obligations for
 * a goal target, as with `suffices`.
 */
export function applyResultForward(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"apply-result-forward">,
  operators: readonly OperatorDeclaration[],
  results: readonly KernelResult[],
): InternalResult {
  const instance = instantiateResultInContext(
    results,
    operation.resultId,
    "forward",
    operation.instantiation,
    target.entry.sequent,
    operators,
  );
  if (!instance.ok) return internalFailure(state, instance.code, instance.message);
  if (operation.premiseHypothesisIds.length !== instance.premises.length) {
    return internalFailure(
      state,
      "arity-mismatch",
      "The premise hypothesis list must have one entry per result premise.",
    );
  }
  const unmet: PlainMathJson[] = [];
  for (const [index, premise] of instance.premises.entries()) {
    const hypothesisId = operation.premiseHypothesisIds[index];
    if (hypothesisId === null || hypothesisId === undefined) {
      unmet.push(premise);
      continue;
    }
    const selected = findHypothesis(target.entry.sequent, hypothesisId);
    if (selected === undefined) return missingHypothesis(state);
    if (!alphaEquivalentWithOperators(selected.statement.expression, premise, operators)) {
      return internalFailure(
        state,
        "premise-mismatch",
        `Hypothesis ${hypothesisId} does not match result premise ${index} up to renaming of bound symbols.`,
      );
    }
  }
  if (operation.obligationIds.length !== unmet.length) {
    return internalFailure(
      state,
      "arity-mismatch",
      "The supplied obligation IDs must correspond one-for-one with the unmatched premises.",
    );
  }
  const obligationCollision = targetIdCollision(state, operation.obligationIds);
  if (obligationCollision !== undefined) return idCollision(state, obligationCollision);
  const hypothesisCollision = hypothesisIdCollision(target.entry.sequent, [
    operation.resultHypothesisId,
  ]);
  if (hypothesisCollision !== undefined) return idCollision(state, hypothesisCollision);

  const obligations = unmet.map((premise, index): Obligation => ({
    id: operation.obligationIds[index] as StatementId,
    provenance: { kind: "premise-of-result", resultId: operation.resultId },
    sequent: {
      context: structuredClone(target.entry.sequent.context),
      conclusion: { expression: premise },
    },
  }));
  const derived = appendHypothesis(
    target.entry,
    hypothesis(operation.resultHypothesisId, instance.conclusion),
  );
  const next = replaceWithObligations(state, target, operation.target, derived, obligations);
  // Unmet premises are required obligations, so the new state is stronger than the old one: it
  // proves the original goal, but it is not interchangeable with it.
  return success(
    next,
    unmet.length === 0 ? "equivalence" : "strengthening",
    "library-result",
    operation.resultId,
  );
}
