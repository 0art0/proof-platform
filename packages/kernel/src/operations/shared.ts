/**
 * Types and helpers shared by the kernel's operation handlers: the internal result of a handler,
 * the located target it acts on, the constructors of its successes and failures, and the small
 * edits of goals, obligations and local contexts that several handlers build on.
 */
import type {
  ContextualSequent,
  Declaration,
  Goal,
  Hypothesis,
  Obligation,
  ObligationProvenance,
  PlainMathJson,
  ProofState,
  StatementId,
} from "@proof/mathjson-model";
import type {
  KernelDiagnostic,
  KernelDiagnosticCode,
  KernelOperation,
  TransitionClass,
  TransitionEvidence,
  TransitionTarget,
} from "../index";
import type { KernelResultId } from "../results";

export type TargetEntry = Goal | Obligation;
export type LocatedTarget = Readonly<{ entry: TargetEntry; index: number }>;

/** The operation of one kind, narrowed out of the `KernelOperation` union. */
export type OperationOfKind<Kind extends KernelOperation["kind"]> = Extract<
  KernelOperation,
  { kind: Kind }
>;

export type InternalResult =
  | Readonly<{
      ok: true;
      state: ProofState;
      transitionClass: TransitionClass;
      evidence: TransitionEvidence;
      resultId?: KernelResultId;
    }>
  | Readonly<{ ok: false; state: ProofState; diagnostics: readonly KernelDiagnostic[] }>;

export function success(
  state: ProofState,
  transitionClass: TransitionClass,
  evidence: TransitionEvidence = "structural",
  resultId?: KernelResultId,
): Extract<InternalResult, { ok: true }> {
  return {
    ok: true,
    state,
    transitionClass,
    evidence,
    ...(resultId === undefined ? {} : { resultId }),
  };
}

export function internalFailure(
  state: ProofState,
  code: KernelDiagnosticCode,
  message: string,
): Extract<InternalResult, { ok: false }> {
  return { ok: false, state, diagnostics: [{ code, message }] };
}

export function missingHypothesis(state: ProofState): Extract<InternalResult, { ok: false }> {
  return internalFailure(
    state,
    "hypothesis-not-found",
    "The hypothesis does not exist in the target's local context.",
  );
}

export function idCollision(
  state: ProofState,
  identifier: string,
): Extract<InternalResult, { ok: false }> {
  return internalFailure(
    state,
    "identifier-collision",
    `The supplied statement ID is not fresh: ${identifier}.`,
  );
}

export function arityMismatch(state: ProofState): Extract<InternalResult, { ok: false }> {
  return internalFailure(
    state,
    "arity-mismatch",
    "The supplied IDs must correspond one-for-one with the logical operands.",
  );
}

export function replacementFailed(state: ProofState): Extract<InternalResult, { ok: false }> {
  return internalFailure(
    state,
    "replacement-failed",
    "The requested capture-safe replacement could not be constructed.",
  );
}

export function invalidProposition(
  state: ProofState,
  label: string,
): Extract<InternalResult, { ok: false }> {
  return internalFailure(
    state,
    "invalid-proposition",
    `The ${label} is not a well-scoped, well-sorted proposition in the target's local context.`,
  );
}

export function notApplicable(
  state: ProofState,
  message: string,
): Extract<InternalResult, { ok: false }> {
  return internalFailure(state, "rule-not-applicable", message);
}

export function replaceTarget(
  state: ProofState,
  target: TransitionTarget,
  index: number,
  replacements: readonly TargetEntry[],
): ProofState {
  if (target.kind === "goal") {
    const goals = [...state.goals];
    goals.splice(index, 1, ...(replacements as readonly Goal[]));
    return { ...state, goals };
  }
  const obligations = [...state.obligations];
  obligations.splice(index, 1, ...(replacements as readonly Obligation[]));
  return { ...state, obligations };
}

/** Remove the acted-on target, closing it without a replacement. */
export function closeTarget(
  state: ProofState,
  target: LocatedTarget,
  operationTarget: TransitionTarget,
): Extract<InternalResult, { ok: true }> {
  return success(replaceTarget(state, operationTarget, target.index, []), "equivalence");
}

/**
 * Replace the acted-on target by `entry` and place new `obligations` after it: directly after an
 * obligation target, at the end of the obligation collection for a goal target.
 */
export function replaceWithObligations(
  state: ProofState,
  target: LocatedTarget,
  operationTarget: TransitionTarget,
  entry: TargetEntry,
  obligations: readonly Obligation[],
): ProofState {
  return operationTarget.kind === "obligation"
    ? replaceTarget(state, operationTarget, target.index, [entry, ...obligations])
    : {
        ...replaceTarget(state, operationTarget, target.index, [entry]),
        obligations: [...state.obligations, ...obligations],
      };
}

export function replaceHypothesis(
  target: TargetEntry,
  index: number,
  replacements: readonly Hypothesis[],
): TargetEntry {
  const hypotheses = [...target.sequent.context.hypotheses];
  hypotheses.splice(index, 1, ...replacements);
  return {
    ...target,
    sequent: {
      ...target.sequent,
      context: { ...target.sequent.context, hypotheses },
    },
  };
}

export function appendHypothesis(target: TargetEntry, appended: Hypothesis): TargetEntry {
  return {
    ...target,
    sequent: {
      ...target.sequent,
      context: {
        ...target.sequent.context,
        hypotheses: [...target.sequent.context.hypotheses, appended],
      },
    },
  };
}

export function withConclusion(target: TargetEntry, expression: PlainMathJson): TargetEntry {
  return {
    ...target,
    sequent: { ...target.sequent, conclusion: { expression: structuredClone(expression) } },
  };
}

/** Provenance for a new target replacing `target`: only obligations carry it. */
export function obligationProvenance(
  target: TransitionTarget,
  provenance: ObligationProvenance,
): Readonly<{ provenance?: ObligationProvenance }> {
  return target.kind === "obligation" ? { provenance } : {};
}

export function hypothesis(id: StatementId, expression: PlainMathJson): Hypothesis {
  return { id, statement: { expression: structuredClone(expression) } };
}

export function findHypothesis(
  sequent: ContextualSequent,
  id: StatementId,
): Hypothesis | undefined {
  return sequent.context.hypotheses.find((candidate) => candidate.id === id);
}

export function findHypothesisIndex(sequent: ContextualSequent, id: StatementId): number {
  return sequent.context.hypotheses.findIndex((candidate) => candidate.id === id);
}

export function findDeclaration(
  sequent: ContextualSequent,
  symbol: string,
): Declaration | undefined {
  return sequent.context.declarations.find((candidate) => candidate.symbol === symbol);
}

export function targetIdCollision(
  state: ProofState,
  ids: readonly StatementId[],
): string | undefined {
  const existing = new Set([...state.goals, ...state.obligations].map((entry) => entry.id));
  return firstCollision(ids, existing);
}

export function hypothesisIdCollision(
  sequent: ContextualSequent,
  ids: readonly StatementId[],
): string | undefined {
  const existing = new Set(sequent.context.hypotheses.map((entry) => entry.id));
  return firstCollision(ids, existing);
}

function firstCollision(
  ids: readonly StatementId[],
  existing: ReadonlySet<string>,
): string | undefined {
  const supplied = new Set<string>();
  for (const id of ids) {
    if (existing.has(id) || supplied.has(id)) return id;
    supplied.add(id);
  }
  return undefined;
}
