/**
 * Dispatch of a validated kernel operation to the handler of its kind. Every handler checks its own
 * preconditions against the located target and returns either the new proof state with its
 * transition class and evidence, or the first failing diagnostic.
 */
import type { OperatorDeclaration, ProofState } from "@proof/mathjson-model";
import {
  abandonPlaceholder,
  addCandidate,
  addRequirement,
  introducePlaceholder,
  resolvePlaceholder,
} from "../constructions";
import type { KernelOperation } from "../index";
import type { KernelResult } from "../results";
import { closeByAssumption, markSorry } from "./assumptions";
import {
  closeByAcceptedInference,
  closeByContradiction,
  closeByHypothesis,
  closeFalseHypothesis,
  closeReflexiveEquality,
  closeTrue,
} from "./closing";
import {
  applyImplicationHypothesis,
  assumeHypothesis,
  chooseGoalDisjunct,
  dropHypothesis,
  expandHypothesisConjunction,
  introduceImplication,
  introduceNegation,
  replaceGoal,
  splitClassicalCases,
  splitGoalConjunction,
  splitHypothesisDisjunction,
  suffices,
} from "./connectives";
import { applyResultBackward, applyResultForward } from "./library-results";
import {
  chooseExistentialWitness,
  instantiateUniversalHypothesis,
  introduceUniversal,
  unpackExistentialHypothesis,
} from "./quantifiers";
import { rewriteStatement } from "./rewrites";
import { internalFailure, success, type InternalResult, type LocatedTarget } from "./shared";

export function applyValidatedOperation(
  state: ProofState,
  target: LocatedTarget,
  operation: KernelOperation,
  operators: readonly OperatorDeclaration[],
  results: readonly KernelResult[],
  environmentOperators: readonly OperatorDeclaration[],
): InternalResult {
  switch (operation.kind) {
    case "close-by-hypothesis":
      return closeByHypothesis(state, target, operation, operators);
    case "close-true":
      return closeTrue(state, target, operation);
    case "close-false-hypothesis":
      return closeFalseHypothesis(state, target, operation);
    case "close-reflexive-equality":
      return closeReflexiveEquality(state, target, operation, operators);
    case "close-by-contradiction":
      return closeByContradiction(state, target, operation, operators);
    case "close-by-accepted-inference":
      return closeByAcceptedInference(state, target, operation);
    case "introduce-implication":
      return introduceImplication(state, target, operation);
    case "introduce-negation":
      return introduceNegation(state, target, operation);
    case "split-goal-conjunction":
      return splitGoalConjunction(state, target, operation);
    case "choose-goal-disjunct":
      return chooseGoalDisjunct(state, target, operation);
    case "expand-hypothesis-conjunction":
      return expandHypothesisConjunction(state, target, operation);
    case "split-hypothesis-disjunction":
      return splitHypothesisDisjunction(state, target, operation);
    case "split-classical-cases":
      return splitClassicalCases(state, target, operation, operators);
    case "assume-hypothesis":
      return assumeHypothesis(state, target, operation, operators);
    case "replace-goal":
      return replaceGoal(state, target, operation, operators);
    case "suffices":
      return suffices(state, target, operation, operators);
    case "drop-hypothesis":
      return dropHypothesis(state, target, operation);
    case "apply-implication-hypothesis":
      return applyImplicationHypothesis(state, target, operation);
    case "introduce-universal":
      return introduceUniversal(state, target, operation, operators);
    case "instantiate-universal-hypothesis":
      return instantiateUniversalHypothesis(state, target, operation, operators);
    case "choose-existential-witness":
      return chooseExistentialWitness(state, target, operation, operators);
    case "unpack-existential-hypothesis":
      return unpackExistentialHypothesis(state, target, operation, operators);
    case "rewrite-with-equality":
    case "rewrite-with-equivalence":
    case "rewrite-with-implication":
      return rewriteStatement(state, target, operation, operators, results);
    case "apply-result-backward":
      return applyResultBackward(state, target, operation, operators, results);
    case "apply-result-forward":
      return applyResultForward(state, target, operation, operators, results);
    case "mark-sorry":
      return markSorry(state, target, operation, operators);
    case "close-by-assumption":
      return closeByAssumption(state, target, operation, operators);
    case "introduce-placeholder":
      return constructionResult(
        state,
        introducePlaceholder(state, operation, environmentOperators),
      );
    case "add-requirement":
      return constructionResult(state, addRequirement(state, operation, environmentOperators));
    case "add-candidate":
      return constructionResult(state, addCandidate(state, operation, environmentOperators));
    case "resolve-placeholder":
      return constructionResult(state, resolvePlaceholder(state, operation, environmentOperators));
    case "abandon-placeholder":
      return constructionResult(state, abandonPlaceholder(state, operation));
  }
}

/** Construction-task transitions are structurally checked by the kernel. */
function constructionResult(
  state: ProofState,
  outcome: ReturnType<typeof introducePlaceholder>,
): InternalResult {
  return outcome.ok
    ? success(outcome.state, outcome.transitionClass)
    : internalFailure(state, outcome.code, outcome.message);
}
