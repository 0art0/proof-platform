/** Handlers of the operations that close the acted-on target from the local context alone. */
import type { OperatorDeclaration, PlainMathJson, ProofState } from "@proof/mathjson-model";
import { alphaEquivalentWithOperators } from "../alpha-equivalence";
import { operatorOperands } from "../expression";
import {
  closeTarget,
  findHypothesis,
  missingHypothesis,
  notApplicable,
  replaceTarget,
  success,
  type InternalResult,
  type LocatedTarget,
  type OperationOfKind,
} from "./shared";

export function closeByHypothesis(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"close-by-hypothesis">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const selected = findHypothesis(target.entry.sequent, operation.hypothesisId);
  if (selected === undefined) return missingHypothesis(state);
  if (
    !alphaEquivalentWithOperators(
      selected.statement.expression,
      target.entry.sequent.conclusion.expression,
      operators,
    )
  ) {
    return notApplicable(
      state,
      "The selected hypothesis does not match the conclusion up to renaming of bound symbols.",
    );
  }
  return closeTarget(state, target, operation.target);
}

export function closeTrue(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"close-true">,
): InternalResult {
  if (!isSymbol(target.entry.sequent.conclusion.expression, "True")) {
    return notApplicable(state, "The target conclusion is not truth.");
  }
  return closeTarget(state, target, operation.target);
}

export function closeFalseHypothesis(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"close-false-hypothesis">,
): InternalResult {
  const selected = findHypothesis(target.entry.sequent, operation.hypothesisId);
  if (selected === undefined) return missingHypothesis(state);
  if (!isSymbol(selected.statement.expression, "False")) {
    return notApplicable(state, "The selected hypothesis is not falsity.");
  }
  return closeTarget(state, target, operation.target);
}

export function closeReflexiveEquality(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"close-reflexive-equality">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const operands = operatorOperands(target.entry.sequent.conclusion.expression, "Equal");
  if (
    operands === undefined ||
    operands.length !== 2 ||
    !alphaEquivalentWithOperators(
      operands[0] as PlainMathJson,
      operands[1] as PlainMathJson,
      operators,
    )
  ) {
    return notApplicable(
      state,
      "The target conclusion is not a binary equality between alpha-equivalent sides.",
    );
  }
  return closeTarget(state, target, operation.target);
}

export function closeByContradiction(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"close-by-contradiction">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const positive = findHypothesis(target.entry.sequent, operation.hypothesisId);
  const negation = findHypothesis(target.entry.sequent, operation.negationHypothesisId);
  if (positive === undefined || negation === undefined) return missingHypothesis(state);
  const negated = operatorOperands(negation.statement.expression, "Not");
  if (negated === undefined || negated.length !== 1) {
    return notApplicable(state, "The negation hypothesis is not a unary negation.");
  }
  if (
    !alphaEquivalentWithOperators(
      positive.statement.expression,
      negated[0] as PlainMathJson,
      operators,
    )
  ) {
    return notApplicable(
      state,
      "The negation hypothesis does not negate the selected hypothesis up to renaming of bound symbols.",
    );
  }
  return closeTarget(state, target, operation.target);
}

export function closeByAcceptedInference(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"close-by-accepted-inference">,
): InternalResult {
  // The attestation is recorded in the operation; the kernel does not judge it.
  return success(
    replaceTarget(state, operation.target, target.index, []),
    "equivalence",
    "background-inference",
  );
}

function isSymbol(expression: PlainMathJson, expected: "True" | "False"): boolean {
  return (
    expression === expected ||
    (typeof expression === "object" &&
      expression !== null &&
      !Array.isArray(expression) &&
      "sym" in expression &&
      expression.sym === expected)
  );
}
