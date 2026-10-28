/**
 * Handlers of the propositional operations: introducing and splitting connectives in a conclusion
 * or a hypothesis, and adding, replacing or dropping propositions of the local context.
 */
import {
  createStatementViewSchema,
  mathJsonEquals,
  type ContextualSequent,
  type Hypothesis,
  type Obligation,
  type ObligationProvenance,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofState,
  type StatementId,
} from "@proof/mathjson-model";
import { alphaEquivalentWithOperators } from "../alpha-equivalence";
import { operatorOperands } from "../expression";
import {
  appendHypothesis,
  arityMismatch,
  findHypothesis,
  findHypothesisIndex,
  hypothesis,
  hypothesisIdCollision,
  idCollision,
  internalFailure,
  invalidProposition,
  missingHypothesis,
  notApplicable,
  obligationProvenance,
  replaceHypothesis,
  replaceTarget,
  replaceWithObligations,
  success,
  targetIdCollision,
  withConclusion,
  type InternalResult,
  type LocatedTarget,
  type OperationOfKind,
  type TargetEntry,
} from "./shared";

export function introduceImplication(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"introduce-implication">,
): InternalResult {
  const operands = logicalOperands(target.entry.sequent.conclusion.expression, "Implies");
  if (operands === undefined || operands.length !== 2) {
    return notApplicable(state, "The target conclusion is not a binary implication.");
  }
  const collision = hypothesisIdCollision(target.entry.sequent, [operation.hypothesisId]);
  if (collision !== undefined) return idCollision(state, collision);
  const replacement: TargetEntry = {
    ...target.entry,
    sequent: {
      context: {
        ...target.entry.sequent.context,
        hypotheses: [
          ...target.entry.sequent.context.hypotheses,
          hypothesis(operation.hypothesisId, operands[0] as PlainMathJson),
        ],
      },
      conclusion: { expression: structuredClone(operands[1] as PlainMathJson) },
    },
  };
  return success(
    replaceTarget(state, operation.target, target.index, [replacement]),
    "equivalence",
  );
}

export function introduceNegation(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"introduce-negation">,
): InternalResult {
  const operands = operatorOperands(target.entry.sequent.conclusion.expression, "Not");
  if (operands === undefined || operands.length !== 1) {
    return notApplicable(state, "The target conclusion is not a unary negation.");
  }
  const collision = hypothesisIdCollision(target.entry.sequent, [operation.hypothesisId]);
  if (collision !== undefined) return idCollision(state, collision);
  const replacement: TargetEntry = {
    ...target.entry,
    sequent: {
      context: {
        ...target.entry.sequent.context,
        hypotheses: [
          ...target.entry.sequent.context.hypotheses,
          hypothesis(operation.hypothesisId, operands[0] as PlainMathJson),
        ],
      },
      conclusion: { expression: "False" },
    },
  };
  return success(
    replaceTarget(state, operation.target, target.index, [replacement]),
    "equivalence",
  );
}

export function splitGoalConjunction(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"split-goal-conjunction">,
): InternalResult {
  const operands = logicalOperands(target.entry.sequent.conclusion.expression, "And");
  if (operands === undefined) return notApplicable(state, "The target is not a conjunction.");
  if (operation.childIds.length !== operands.length) return arityMismatch(state);
  const collision = targetIdCollision(state, operation.childIds);
  if (collision !== undefined) return idCollision(state, collision);
  const replacements = operands.map((operand, index): TargetEntry => ({
    id: operation.childIds[index] as StatementId,
    ...provenanceOf(target.entry),
    sequent: {
      context: structuredClone(target.entry.sequent.context),
      conclusion: { expression: structuredClone(operand) },
    },
  }));
  return success(replaceTarget(state, operation.target, target.index, replacements), "equivalence");
}

export function chooseGoalDisjunct(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"choose-goal-disjunct">,
): InternalResult {
  const operands = logicalOperands(target.entry.sequent.conclusion.expression, "Or");
  if (operands === undefined) return notApplicable(state, "The target is not a disjunction.");
  const selected = operands[operation.disjunctIndex];
  if (selected === undefined) {
    return internalFailure(
      state,
      "index-out-of-range",
      "The selected disjunct index is outside the conclusion.",
    );
  }
  const replacement: TargetEntry = {
    ...target.entry,
    sequent: {
      ...target.entry.sequent,
      conclusion: { expression: structuredClone(selected) },
    },
  };
  return success(
    replaceTarget(state, operation.target, target.index, [replacement]),
    "strengthening",
  );
}

export function expandHypothesisConjunction(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"expand-hypothesis-conjunction">,
): InternalResult {
  const hypothesisIndex = findHypothesisIndex(target.entry.sequent, operation.hypothesisId);
  if (hypothesisIndex < 0) return missingHypothesis(state);
  const selected = target.entry.sequent.context.hypotheses[hypothesisIndex] as Hypothesis;
  const operands = logicalOperands(selected.statement.expression, "And");
  if (operands === undefined) {
    return notApplicable(state, "The selected hypothesis is not a conjunction.");
  }
  if (operation.expandedHypothesisIds.length !== operands.length) return arityMismatch(state);
  const collision = hypothesisIdCollision(target.entry.sequent, operation.expandedHypothesisIds);
  if (collision !== undefined) return idCollision(state, collision);
  const expanded = operands.map((operand, index) =>
    hypothesis(operation.expandedHypothesisIds[index] as StatementId, operand),
  );
  const replacement = replaceHypothesis(target.entry, hypothesisIndex, expanded);
  return success(
    replaceTarget(state, operation.target, target.index, [replacement]),
    "equivalence",
  );
}

export function splitHypothesisDisjunction(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"split-hypothesis-disjunction">,
): InternalResult {
  const hypothesisIndex = findHypothesisIndex(target.entry.sequent, operation.hypothesisId);
  if (hypothesisIndex < 0) return missingHypothesis(state);
  const selected = target.entry.sequent.context.hypotheses[hypothesisIndex] as Hypothesis;
  const operands = logicalOperands(selected.statement.expression, "Or");
  if (operands === undefined) {
    return notApplicable(state, "The selected hypothesis is not a disjunction.");
  }
  if (
    operation.childIds.length !== operands.length ||
    operation.branchHypothesisIds.length !== operands.length
  ) {
    return arityMismatch(state);
  }
  const childCollision = targetIdCollision(state, operation.childIds);
  if (childCollision !== undefined) return idCollision(state, childCollision);
  const hypothesisCollision = hypothesisIdCollision(
    target.entry.sequent,
    operation.branchHypothesisIds,
  );
  if (hypothesisCollision !== undefined) return idCollision(state, hypothesisCollision);
  const replacements = operands.map((operand, index): TargetEntry => {
    const branch = structuredClone(target.entry);
    return {
      ...replaceHypothesis(branch, hypothesisIndex, [
        hypothesis(operation.branchHypothesisIds[index] as StatementId, operand),
      ]),
      id: operation.childIds[index] as StatementId,
      ...obligationProvenance(operation.target, { kind: "case" }),
    };
  });
  return success(replaceTarget(state, operation.target, target.index, replacements), "equivalence");
}

export function splitClassicalCases(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"split-classical-cases">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  if (!isPropositionInContext(operation.proposition, target.entry.sequent, operators)) {
    return invalidProposition(state, "case-split proposition");
  }
  const childCollision = targetIdCollision(state, operation.childIds);
  if (childCollision !== undefined) return idCollision(state, childCollision);
  const hypothesisCollision = hypothesisIdCollision(
    target.entry.sequent,
    operation.branchHypothesisIds,
  );
  if (hypothesisCollision !== undefined) return idCollision(state, hypothesisCollision);

  const branchExpressions: readonly PlainMathJson[] = [
    operation.proposition,
    ["Not", operation.proposition],
  ];
  const replacements = branchExpressions.map((expression, index): TargetEntry => {
    const branch = structuredClone(target.entry);
    return {
      ...appendHypothesis(
        branch,
        hypothesis(operation.branchHypothesisIds[index] as StatementId, expression),
      ),
      id: operation.childIds[index] as StatementId,
      ...obligationProvenance(operation.target, { kind: "case" }),
    };
  });
  return success(replaceTarget(state, operation.target, target.index, replacements), "equivalence");
}

export function assumeHypothesis(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"assume-hypothesis">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  if (!isPropositionInContext(operation.proposition, target.entry.sequent, operators)) {
    return invalidProposition(state, "assumed hypothesis");
  }
  const collision = hypothesisIdCollision(target.entry.sequent, [operation.hypothesisId]);
  if (collision !== undefined) return idCollision(state, collision);
  const replacement = appendHypothesis(
    target.entry,
    hypothesis(operation.hypothesisId, operation.proposition),
  );
  return success(replaceTarget(state, operation.target, target.index, [replacement]), "weakening");
}

export function replaceGoal(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"replace-goal">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  if (!isPropositionInContext(operation.proposition, target.entry.sequent, operators)) {
    return invalidProposition(state, "replacement conclusion");
  }
  if (
    alphaEquivalentWithOperators(
      operation.proposition,
      target.entry.sequent.conclusion.expression,
      operators,
    )
  ) {
    return notApplicable(state, "The replacement conclusion is the current conclusion.");
  }
  return success(
    replaceTarget(state, operation.target, target.index, [
      withConclusion(target.entry, operation.proposition),
    ]),
    "weakening",
  );
}

export function suffices(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"suffices">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  if (!isPropositionInContext(operation.proposition, target.entry.sequent, operators)) {
    return invalidProposition(state, "sufficient proposition");
  }
  const collision = targetIdCollision(state, [operation.obligationId]);
  if (collision !== undefined) return idCollision(state, collision);
  const implication: Obligation = {
    id: operation.obligationId,
    provenance: { kind: "suffices" },
    sequent: {
      context: structuredClone(target.entry.sequent.context),
      conclusion: {
        expression: [
          "Implies",
          structuredClone(operation.proposition),
          structuredClone(target.entry.sequent.conclusion.expression),
        ],
      },
    },
  };
  const replaced = withConclusion(target.entry, operation.proposition);
  // An obligation target keeps its sufficiency obligation adjacent; a goal
  // target appends it to the obligation collection.
  const next = replaceWithObligations(state, target, operation.target, replaced, [implication]);
  return success(next, "strengthening");
}

export function dropHypothesis(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"drop-hypothesis">,
): InternalResult {
  const hypothesisIndex = findHypothesisIndex(target.entry.sequent, operation.hypothesisId);
  if (hypothesisIndex < 0) return missingHypothesis(state);
  return success(
    replaceTarget(state, operation.target, target.index, [
      replaceHypothesis(target.entry, hypothesisIndex, []),
    ]),
    "strengthening",
  );
}

export function applyImplicationHypothesis(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"apply-implication-hypothesis">,
): InternalResult {
  const implication = findHypothesis(target.entry.sequent, operation.implicationHypothesisId);
  if (implication === undefined) return missingHypothesis(state);
  const antecedent = findHypothesis(target.entry.sequent, operation.antecedentHypothesisId);
  if (antecedent === undefined) return missingHypothesis(state);
  const operands = operatorOperands(implication.statement.expression, "Implies");
  if (operands === undefined || operands.length !== 2) {
    return notApplicable(state, "The selected hypothesis is not a binary implication.");
  }
  if (!mathJsonEquals(antecedent.statement.expression, operands[0] as PlainMathJson)) {
    return notApplicable(
      state,
      "The antecedent hypothesis does not exactly match the implication antecedent.",
    );
  }
  const collision = hypothesisIdCollision(target.entry.sequent, [operation.resultHypothesisId]);
  if (collision !== undefined) return idCollision(state, collision);
  const replacement = appendHypothesis(
    target.entry,
    hypothesis(operation.resultHypothesisId, operands[1] as PlainMathJson),
  );
  return success(
    replaceTarget(state, operation.target, target.index, [replacement]),
    "equivalence",
  );
}

function logicalOperands(
  expression: PlainMathJson,
  operator: "And" | "Or" | "Implies",
): readonly PlainMathJson[] | undefined {
  return operatorOperands(expression, operator);
}

/** A new obligation copies its parent's provenance; goals carry none. */
function provenanceOf(entry: TargetEntry): Readonly<{ provenance?: ObligationProvenance }> {
  return "provenance" in entry && entry.provenance !== undefined
    ? { provenance: structuredClone(entry.provenance) }
    : {};
}

/** Scope and sort check for a user-supplied proposition against the target's local context. */
function isPropositionInContext(
  expression: PlainMathJson,
  sequent: ContextualSequent,
  operators: readonly OperatorDeclaration[],
): boolean {
  try {
    return createStatementViewSchema({
      declarations: sequent.context.declarations,
      operators,
    }).safeParse({ expression }).success;
  } catch {
    return false;
  }
}
