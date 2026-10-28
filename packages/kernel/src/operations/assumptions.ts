/**
 * Handlers of the operations that involve the state's additional assumptions: `mark-sorry` removes
 * a target and records its closure as an assumption, `close-by-assumption` closes a target with an
 * instance of one.
 */
import type { AdditionalAssumption, OperatorDeclaration, ProofState } from "@proof/mathjson-model";
import { mentionsOpenPlaceholder } from "../constructions";
import { closesByAssumption, sorryClosure } from "../obligations";
import {
  closeTarget,
  internalFailure,
  replaceTarget,
  success,
  type InternalResult,
  type LocatedTarget,
  type OperationOfKind,
} from "./shared";

/**
 * Remove the target and append its dependency-restricted universal closure
 * (see `sorryClosure`) as an additional assumption whose origin records the
 * removed target. Relative to the extended assumption set the result is
 * provable exactly when the input is, so the class is equivalence; the
 * evidence is `sorry` because the closure itself is unproved.
 */
export function markSorry(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"mark-sorry">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const existing = state.assumptions ?? [];
  if (existing.some((candidate) => candidate.id === operation.assumptionId)) {
    return internalFailure(
      state,
      "identifier-collision",
      `The supplied assumption ID is not fresh: ${operation.assumptionId}.`,
    );
  }
  // A closed assumption cannot mention a choice still to be made.
  const placeholder = mentionsOpenPlaceholder(state, target.entry.sequent);
  if (placeholder !== undefined) {
    return internalFailure(
      state,
      "construction-metavariable-dependency",
      `The target depends on the open placeholder ${placeholder}; resolve it before marking the target as a sorry.`,
    );
  }
  const closure = sorryClosure(target.entry.sequent, operators);
  if (!closure.ok) return internalFailure(state, closure.code, closure.message);
  const assumption: AdditionalAssumption = {
    id: operation.assumptionId,
    declarations: [...closure.closure.declarations],
    statement: { expression: closure.closure.statement },
    origin: {
      kind: "sorry",
      sourceTarget: { kind: operation.target.kind, id: operation.target.id },
      ...(operation.sorryId === undefined ? {} : { sorryId: operation.sorryId }),
    },
  };
  return success(
    {
      ...replaceTarget(state, operation.target, target.index, []),
      assumptions: [...existing, assumption],
    },
    "equivalence",
    "sorry",
  );
}

export function closeByAssumption(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"close-by-assumption">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const assumption = (state.assumptions ?? []).find(
    (candidate) => candidate.id === operation.assumptionId,
  );
  if (assumption === undefined) {
    return internalFailure(
      state,
      "assumption-not-found",
      "The additional assumption does not exist in this proof state.",
    );
  }
  const closes = closesByAssumption(
    assumption,
    operation.instantiation,
    target.entry.sequent,
    operators,
  );
  if (!closes.ok) return internalFailure(state, closes.code, closes.message);
  // The kernel checks the instantiation and modus ponens itself; the
  // assumption is explicit, state-global, and already marked by the `sorry`
  // evidence of the transition that created it, so this step is structural.
  return closeTarget(state, target, operation.target);
}
