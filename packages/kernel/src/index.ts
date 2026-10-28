import type { stableIdentifierSchema } from "@proof/mathjson-model";
import {
  constructionPlaceholderOperators,
  createExecutableProofStateSchema,
  operatorDeclarationsSchema,
  type AssumptionId,
  type AttestationId,
  type DeclarationId,
  type ExecutableProofState,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofState,
  type ProofStateId,
  type StatementId,
} from "@proof/mathjson-model";
import type { RewriteLens, RewriteSource } from "./deep-rewrite";
import type { ConstructionOperation, ConstructionOperationKind } from "./constructions";
import {
  parseKernelResultCatalog,
  type KernelResult,
  type KernelResultId,
  type ResultInstantiation,
} from "./results";
import { kernelOperationSchema } from "./operation-parsing";
import { applyValidatedOperation } from "./operations/apply";
import type { LocatedTarget } from "./operations/shared";

export { alphaEquivalent, type AlphaEquivalenceEnvironment } from "./alpha-equivalence";
export { functionParts, operatorOperands, symbolValue, type FunctionParts } from "./expression";
export { hasExactKeys, isStrictRecord } from "./runtime";
export { sorryClosure, type SorryClosure, type SorryClosureResult } from "./obligations";
export type { RewriteLens, RewriteSource } from "./deep-rewrite";
export {
  RESULT_APPLICATION_DIRECTIONS,
  freeResultParameters,
  kernelResultIdSchema,
  matchExpressionPattern,
  matchResultConclusion,
  parseKernelResultCatalog,
  type KernelResult,
  type KernelResultId,
  type KernelResultParameter,
  type ResultApplicationDirection,
  type ResultCatalogIssue,
  type ResultCatalogParseResult,
  type ResultInstantiation,
  type ResultMatch,
  type ResultMatchDiagnostic,
} from "./results";

/**
 * Logical direction of a transition from state S to state T (design plan §10):
 * equivalence (S provable iff T provable), strengthening (proving T proves S),
 * and weakening (T is not claimed to establish S; it never counts toward a
 * provability route). Weakening is the conservative label for any primitive
 * whose result the kernel does not relate to its input, such as `replace-goal`.
 */
export type TransitionClass = "equivalence" | "strengthening" | "weakening";

const TRANSITION_CLASS_ORDER: Readonly<Record<TransitionClass, number>> = {
  equivalence: 0,
  strengthening: 1,
  weakening: 2,
};

/**
 * The class of a composed transition is the weakest guarantee among its steps. Weakening
 * dominates strengthening, which dominates equivalence. An empty sequence is an equivalence.
 */
export function composeTransitionClasses(classes: readonly TransitionClass[]): TransitionClass {
  return classes.reduce<TransitionClass>(
    (weakest, next) =>
      TRANSITION_CLASS_ORDER[next] > TRANSITION_CLASS_ORDER[weakest] ? next : weakest,
    "equivalence",
  );
}

/**
 * How a transition's logical direction is supported (refinement §9). This is
 * orthogonal to the transition class. `structural` means the kernel checked
 * the step itself; `background-inference` means the kernel only recorded an
 * external attestation reference and did not judge it. `library-result` means
 * the kernel checked the instantiation and matching of an approved result from
 * `KernelEnvironment.results`, whose truth it takes from the catalog; the
 * transition result then also carries that result's `resultId`. `sorry` means
 * the target was removed by `mark-sorry` and its dependency-restricted
 * universal closure appended to the state's additional assumptions; the
 * transition is an equivalence only relative to that extended assumption set.
 */
export const TRANSITION_EVIDENCE_KINDS = [
  "structural",
  "background-inference",
  "library-result",
  "sorry",
] as const;
export type TransitionEvidence = (typeof TRANSITION_EVIDENCE_KINDS)[number];

const EVIDENCE_CAVEAT: Readonly<Record<TransitionEvidence, number>> = {
  structural: 0,
  "library-result": 1,
  "background-inference": 2,
  sorry: 3,
};

/**
 * The evidence of a composed transition: the most caveated among its steps (an unproved sorry,
 * then an accepted background inference, then a cited library result, then a structural rule).
 * An empty sequence is structural.
 */
export function composeTransitionEvidence(
  evidence: readonly TransitionEvidence[],
): TransitionEvidence {
  return evidence.reduce<TransitionEvidence>(
    (most, next) => (EVIDENCE_CAVEAT[next] > EVIDENCE_CAVEAT[most] ? next : most),
    "structural",
  );
}

export { attestationIdSchema, type AttestationId } from "@proof/mathjson-model";
export {
  CONSTRUCTION_OPERATION_KINDS,
  substitutePlaceholder,
  type ConstructionOperation,
  type ConstructionOperationKind,
  type PlaceholderOrigin,
} from "./constructions";

export type TransitionTarget = Readonly<{
  kind: "goal" | "obligation";
  id: StatementId;
}>;

export type TransitionStatementTarget =
  Readonly<{ kind: "conclusion" }> | Readonly<{ kind: "hypothesis"; id: StatementId }>;

/**
 * Trusted primitive names are verb-first and name the construct they act on.
 * `split-classical-cases` (roadmap "case-split") splits on an arbitrary
 * proposition by excluded middle, in contrast to `split-hypothesis-disjunction`.
 * `assume-hypothesis` adds an unproved hypothesis; it is a weakening, so the
 * assumption is never silently treated as established. `apply-result-backward`
 * and `apply-result-forward` instantiate an approved result from the
 * environment's catalog. `rewrite-with-equivalence` and `rewrite-with-implication`
 * rewrite one proposition occurrence, possibly deep inside a statement, with an
 * `Equivalent` or `Implies` statement from a hypothesis or an instantiated
 * premise-free result; see `rewriteStatement` for the polarity rules.
 * `mark-sorry` removes a target and records its closure as an additional
 * assumption; `close-by-assumption` closes a target with an instance of such an
 * assumption. There is no separate `discharge-obligation`: every closer accepts
 * an obligation target, which is how an obligation is discharged.
 *
 * Obligation provenance: `suffices` creates a `suffices` obligation;
 * `apply-result-forward` obligations for unmet premises and, on an obligation
 * target, `apply-result-backward` premise obligations are `premise-of-result`;
 * case splits (`split-hypothesis-disjunction`, `split-classical-cases`) of an
 * obligation yield `case` obligations; conjunct obligations from
 * `split-goal-conjunction` and every rewritten obligation keep the parent's
 * provenance. Obligations a transition does not touch, and the state's
 * additional assumptions, are always preserved unchanged.
 *
 * These are the proof primitives, each with one hand-authored move. The
 * construction-task operations (`CONSTRUCTION_OPERATION_KINDS`:
 * `introduce-placeholder`, `add-requirement`, `add-candidate`,
 * `resolve-placeholder`, `abandon-placeholder`) are also kernel operations
 * applied through `applyTransition`, but act on construction-task records and
 * have no moves yet; `resolve-placeholder` creates `construction-requirement`
 * obligations.
 */
export const KERNEL_OPERATION_KINDS = [
  "close-by-hypothesis",
  "close-true",
  "close-false-hypothesis",
  "close-reflexive-equality",
  "close-by-contradiction",
  "close-by-accepted-inference",
  "introduce-implication",
  "introduce-negation",
  "split-goal-conjunction",
  "choose-goal-disjunct",
  "expand-hypothesis-conjunction",
  "split-hypothesis-disjunction",
  "split-classical-cases",
  "assume-hypothesis",
  "replace-goal",
  "suffices",
  "drop-hypothesis",
  "apply-implication-hypothesis",
  "introduce-universal",
  "instantiate-universal-hypothesis",
  "choose-existential-witness",
  "unpack-existential-hypothesis",
  "rewrite-with-equality",
  "rewrite-with-equivalence",
  "rewrite-with-implication",
  "apply-result-backward",
  "apply-result-forward",
  "mark-sorry",
  "close-by-assumption",
] as const;
export type KernelOperationKind = (typeof KERNEL_OPERATION_KINDS)[number];

const classes = (...allowed: TransitionClass[]): readonly TransitionClass[] =>
  Object.freeze(allowed);

/**
 * The classes each primitive may report. The kernel classifies a transition from its actual
 * outcome and refuses to report a class outside this set. Most primitives have one class;
 * `apply-result-forward` is an equivalence only when every premise is matched by a hypothesis, and
 * a strengthening when unmet premises become obligations; `instantiate-universal-hypothesis` is
 * likewise an equivalence unless a typed binder's membership `t ∈ S` becomes an obligation. The record is exhaustive so a new
 * primitive must choose its classes explicitly.
 */
export const KERNEL_TRANSITION_CLASSES: Readonly<
  Record<KernelOperationKind, readonly TransitionClass[]>
> = Object.freeze({
  "close-by-hypothesis": classes("equivalence"),
  "close-true": classes("equivalence"),
  "close-false-hypothesis": classes("equivalence"),
  "close-reflexive-equality": classes("equivalence"),
  "close-by-contradiction": classes("equivalence"),
  "close-by-accepted-inference": classes("equivalence"),
  "introduce-implication": classes("equivalence"),
  "introduce-negation": classes("equivalence"),
  "split-goal-conjunction": classes("equivalence"),
  "choose-goal-disjunct": classes("strengthening"),
  "expand-hypothesis-conjunction": classes("equivalence"),
  "split-hypothesis-disjunction": classes("equivalence"),
  "split-classical-cases": classes("equivalence"),
  "assume-hypothesis": classes("weakening"),
  "replace-goal": classes("weakening"),
  suffices: classes("strengthening"),
  "drop-hypothesis": classes("strengthening"),
  "apply-implication-hypothesis": classes("equivalence"),
  "introduce-universal": classes("equivalence"),
  "instantiate-universal-hypothesis": classes("equivalence", "strengthening"),
  "choose-existential-witness": classes("strengthening"),
  "unpack-existential-hypothesis": classes("equivalence"),
  "rewrite-with-equality": classes("equivalence"),
  "rewrite-with-equivalence": classes("equivalence"),
  "rewrite-with-implication": classes("strengthening"),
  "apply-result-backward": classes("strengthening"),
  "apply-result-forward": classes("equivalence", "strengthening"),
  "mark-sorry": classes("equivalence"),
  "close-by-assumption": classes("equivalence"),
});

/**
 * The classes each construction-task operation may report (N11, N42). Introducing a placeholder is
 * an equivalence when its dependencies cover the sequent and a strengthening otherwise; resolving
 * is a strengthening; recording a requirement or candidate and abandoning an unused task leave
 * the proof content unchanged.
 */
export const CONSTRUCTION_TRANSITION_CLASSES: Readonly<
  Record<ConstructionOperationKind, readonly TransitionClass[]>
> = Object.freeze({
  "introduce-placeholder": classes("equivalence", "strengthening"),
  "add-requirement": classes("equivalence"),
  "add-candidate": classes("equivalence"),
  "resolve-placeholder": classes("strengthening"),
  "abandon-placeholder": classes("equivalence"),
});

const ALLOWED_TRANSITION_CLASSES = {
  ...KERNEL_TRANSITION_CLASSES,
  ...CONSTRUCTION_TRANSITION_CLASSES,
} as Readonly<Record<string, readonly TransitionClass[] | undefined>>;

/**
 * The class a move over this primitive declares before any outcome is known: the weakest of the
 * classes the primitive may report. The stored preview and edge carry the actual class.
 */
export function declaredTransitionClass(
  kind: KernelOperationKind | ConstructionOperationKind,
): TransitionClass {
  const allowed: readonly TransitionClass[] =
    kind in CONSTRUCTION_TRANSITION_CLASSES
      ? CONSTRUCTION_TRANSITION_CLASSES[kind as ConstructionOperationKind]
      : KERNEL_TRANSITION_CLASSES[kind as KernelOperationKind];
  return composeTransitionClasses(allowed);
}

/**
 * The shared shape of every kernel operation. The target is the goal or
 * obligation the operation acts on; for a construction-task operation other
 * than an existential `introduce-placeholder` it is the target the operation
 * was invoked from, and the target itself is left unchanged.
 */
export type OperationBase = Readonly<{
  expectedStateId: ProofStateId;
  resultStateId: ProofStateId;
  target: TransitionTarget;
}>;

export type KernelOperation =
  | (OperationBase & Readonly<{ kind: "close-by-hypothesis"; hypothesisId: StatementId }>)
  | (OperationBase & Readonly<{ kind: "close-true" }>)
  | (OperationBase & Readonly<{ kind: "close-false-hypothesis"; hypothesisId: StatementId }>)
  | (OperationBase & Readonly<{ kind: "close-reflexive-equality" }>)
  | (OperationBase &
      Readonly<{
        kind: "close-by-contradiction";
        hypothesisId: StatementId;
        negationHypothesisId: StatementId;
      }>)
  | (OperationBase &
      Readonly<{ kind: "close-by-accepted-inference"; attestationId: AttestationId }>)
  | (OperationBase & Readonly<{ kind: "introduce-implication"; hypothesisId: StatementId }>)
  | (OperationBase & Readonly<{ kind: "introduce-negation"; hypothesisId: StatementId }>)
  | (OperationBase & Readonly<{ kind: "split-goal-conjunction"; childIds: readonly StatementId[] }>)
  | (OperationBase & Readonly<{ kind: "choose-goal-disjunct"; disjunctIndex: number }>)
  | (OperationBase &
      Readonly<{
        kind: "expand-hypothesis-conjunction";
        hypothesisId: StatementId;
        expandedHypothesisIds: readonly StatementId[];
      }>)
  | (OperationBase &
      Readonly<{
        kind: "split-hypothesis-disjunction";
        hypothesisId: StatementId;
        childIds: readonly StatementId[];
        branchHypothesisIds: readonly StatementId[];
      }>)
  | (OperationBase &
      Readonly<{
        kind: "split-classical-cases";
        proposition: PlainMathJson;
        childIds: readonly [StatementId, StatementId];
        branchHypothesisIds: readonly [StatementId, StatementId];
      }>)
  | (OperationBase &
      Readonly<{
        kind: "assume-hypothesis";
        proposition: PlainMathJson;
        hypothesisId: StatementId;
      }>)
  | (OperationBase & Readonly<{ kind: "replace-goal"; proposition: PlainMathJson }>)
  | (OperationBase &
      Readonly<{ kind: "suffices"; proposition: PlainMathJson; obligationId: StatementId }>)
  | (OperationBase & Readonly<{ kind: "drop-hypothesis"; hypothesisId: StatementId }>)
  | (OperationBase &
      Readonly<{
        kind: "apply-implication-hypothesis";
        implicationHypothesisId: StatementId;
        antecedentHypothesisId: StatementId;
        resultHypothesisId: StatementId;
      }>)
  | (OperationBase &
      Readonly<{
        kind: "introduce-universal";
        /** Typed binder `∀x∈S` only: the fresh universal-parameter declaration and its `x ∈ S`. */
        parameterDeclarationId?: DeclarationId;
        membershipHypothesisId?: StatementId;
      }>)
  | (OperationBase &
      Readonly<{
        kind: "instantiate-universal-hypothesis";
        hypothesisId: StatementId;
        term: PlainMathJson;
        resultHypothesisId: StatementId;
        /** Typed binder `∀x∈S` only: the obligation `t ∈ S`, used when no hypothesis states it. */
        membershipObligationId?: StatementId;
      }>)
  | (OperationBase & Readonly<{ kind: "choose-existential-witness"; witness: PlainMathJson }>)
  | (OperationBase &
      Readonly<{
        kind: "unpack-existential-hypothesis";
        hypothesisId: StatementId;
        resultHypothesisId: StatementId;
        /** Typed binder `∃x∈S` only: the fresh local-witness declaration and its `x ∈ S`. */
        witnessDeclarationId?: DeclarationId;
        membershipHypothesisId?: StatementId;
      }>)
  | (OperationBase &
      Readonly<{
        kind: "rewrite-with-equality";
        equalityHypothesisId: StatementId;
        statement: TransitionStatementTarget;
        path: readonly number[];
        /** Optional associative lens: `path` then addresses the associative container. */
        lens?: RewriteLens;
        direction: "forward" | "backward";
      }>)
  | (OperationBase &
      Readonly<{
        kind: "rewrite-with-equivalence";
        statement: TransitionStatementTarget;
        path: readonly number[];
        lens?: RewriteLens;
        source: RewriteSource;
        /** Forward replaces the left side of `A ⇔ B` by the right side; backward the reverse. */
        direction: "forward" | "backward";
      }>)
  | (OperationBase &
      Readonly<{
        kind: "rewrite-with-implication";
        statement: TransitionStatementTarget;
        path: readonly number[];
        lens?: RewriteLens;
        /** The rewrite direction of `A ⇒ B` is determined by the occurrence's polarity. */
        source: RewriteSource;
      }>)
  | (OperationBase &
      Readonly<{
        kind: "apply-result-backward";
        resultId: KernelResultId;
        instantiation: ResultInstantiation;
        premiseTargetIds: readonly StatementId[];
      }>)
  | (OperationBase &
      Readonly<{
        kind: "apply-result-forward";
        resultId: KernelResultId;
        instantiation: ResultInstantiation;
        /** One entry per premise: a matching local hypothesis, or null to create an obligation. */
        premiseHypothesisIds: readonly (StatementId | null)[];
        resultHypothesisId: StatementId;
        /** One fresh obligation ID per null premise entry, in premise order. */
        obligationIds: readonly StatementId[];
      }>)
  | (OperationBase &
      Readonly<{
        kind: "mark-sorry";
        /** Fresh ID of the appended additional assumption. */
        assumptionId: AssumptionId;
        /** Optional external sorry reference recorded in the assumption's origin. */
        sorryId?: SorryId;
      }>)
  | (OperationBase &
      Readonly<{
        kind: "close-by-assumption";
        assumptionId: AssumptionId;
        /** Terms for a prefix of the assumption's leading universal binders, keyed by symbol. */
        instantiation: ResultInstantiation;
      }>)
  | ConstructionOperation;

type SorryId = ReturnType<typeof stableIdentifierSchema.parse>;

export {
  kernelOperationSchema,
  transitionStatementTargetSchema,
  transitionTargetSchema,
} from "./operation-parsing";

export type KernelEnvironment = Readonly<{
  operators?: readonly OperatorDeclaration[];
  /** Approved results that `apply-result-*` operations may instantiate. */
  results?: readonly KernelResult[];
}>;

export type KernelDiagnosticCode =
  | "invalid-environment"
  | "invalid-input-state"
  | "invalid-operation"
  | "stale-state"
  | "result-state-id-collision"
  | "target-not-found"
  | "hypothesis-not-found"
  | "identifier-collision"
  | "arity-mismatch"
  | "index-out-of-range"
  | "invalid-path"
  | "invalid-proposition"
  | "replacement-failed"
  | "rule-not-applicable"
  | "invalid-result-state"
  | "result-not-found"
  | "direction-not-permitted"
  | "missing-instantiation"
  | "invalid-instantiation"
  | "conclusion-mismatch"
  | "premise-mismatch"
  | "polarity-not-permitted"
  | "assumption-not-found"
  | "construction-metavariable-dependency"
  | "task-not-found"
  | "task-not-open"
  | "candidate-not-found"
  | "invalid-requirement"
  | "illegal-dependency"
  | "cyclic-dependency"
  | "signature-mismatch"
  | "placeholder-in-use";

export type KernelDiagnostic = Readonly<{
  code: KernelDiagnosticCode;
  message: string;
  path?: readonly PropertyKey[];
}>;

export type KernelTransitionResult =
  | Readonly<{
      ok: true;
      state: ExecutableProofState;
      transitionClass: TransitionClass;
      evidence: TransitionEvidence;
      /** Present exactly when `evidence` is `library-result`. */
      resultId?: KernelResultId;
      diagnostics: readonly [];
    }>
  | Readonly<{
      ok: false;
      state: ExecutableProofState;
      diagnostics: readonly KernelDiagnostic[];
    }>;

/**
 * Apply one trusted primitive atomically. Failures return the exact input state
 * reference; successful results are detached snapshots and never mutate it.
 */
export function applyTransition(
  state: ExecutableProofState,
  operationInput: unknown,
  environment: KernelEnvironment = {},
): KernelTransitionResult {
  let stateSchema: ReturnType<typeof createExecutableProofStateSchema>;
  let operators: readonly OperatorDeclaration[];
  try {
    operators = operatorDeclarationsSchema.parse(environment.operators ?? []);
    stateSchema = createExecutableProofStateSchema({ operators });
  } catch (error: unknown) {
    return failure(state, "invalid-environment", errorMessage(error));
  }
  let results: readonly KernelResult[] = [];
  if (environment.results !== undefined) {
    const catalog = parseKernelResultCatalog(environment.results, operators);
    if (!catalog.ok) {
      return failure(state, "invalid-environment", catalog.issue.message, [
        "results",
        ...catalog.issue.path,
      ]);
    }
    results = catalog.results;
  }

  const inputState = stateSchema.safeParse(state);
  if (!inputState.success) {
    return failure(
      state,
      "invalid-input-state",
      "The input is not an executable proof state.",
      inputState.error.issues[0]?.path,
    );
  }

  const parsedOperation = kernelOperationSchema.safeParse(operationInput);
  if (!parsedOperation.success) {
    return failure(
      state,
      "invalid-operation",
      "The kernel operation does not match its strict runtime schema.",
      parsedOperation.error.issues[0]?.path,
    );
  }
  const operation = parsedOperation.data;

  if (operation.expectedStateId !== inputState.data.id) {
    return failure(state, "stale-state", "The operation targets a different proof-state snapshot.");
  }
  if (operation.resultStateId === inputState.data.id) {
    return failure(
      state,
      "result-state-id-collision",
      "A successful transition requires a fresh result-state ID.",
    );
  }

  let working: ProofState;
  try {
    working = structuredClone(inputState.data) as ProofState;
  } catch {
    return failure(
      state,
      "invalid-input-state",
      "The input proof state could not be detached safely for an atomic transition.",
    );
  }
  const located = locateTarget(working, operation.target);
  if (located === undefined) {
    return failure(state, "target-not-found", "The target does not exist in that collection.");
  }

  // Open placeholders are registered operators wherever the state's statements are checked.
  const stateOperators = [...operators, ...constructionPlaceholderOperators(inputState.data)];
  const transition = applyValidatedOperation(
    working,
    located,
    operation,
    stateOperators,
    results,
    operators,
  );
  if (!transition.ok) return { ...transition, state };

  const allowed = ALLOWED_TRANSITION_CLASSES[operation.kind];
  if (allowed !== undefined && !allowed.includes(transition.transitionClass)) {
    return failure(
      state,
      "invalid-result-state",
      `The ${operation.kind} transition reported ${transition.transitionClass}, which is outside its allowed classes.`,
    );
  }
  if (
    transition.transitionClass === "equivalence" &&
    addsRequiredObligation(inputState.data, transition.state)
  ) {
    return failure(
      state,
      "invalid-result-state",
      "A transition that creates required obligations cannot be an equivalence.",
    );
  }

  const candidate: ProofState = { ...transition.state, id: operation.resultStateId };
  const outputState = stateSchema.safeParse(candidate);
  if (!outputState.success) {
    return failure(
      state,
      "invalid-result-state",
      "The resulting proof state failed executable-state validation.",
      outputState.error.issues[0]?.path,
    );
  }

  return {
    ok: true,
    state: outputState.data,
    transitionClass: transition.transitionClass,
    evidence: transition.evidence,
    ...(transition.resultId === undefined ? {} : { resultId: transition.resultId }),
    diagnostics: [],
  };
}

/** Whether the transition appended an obligation a later proof must discharge (premise, sufficiency or binder membership). */
function addsRequiredObligation(before: ProofState, after: ProofState): boolean {
  const existing = new Set(before.obligations.map((entry) => entry.id));
  return after.obligations.some(
    (entry) =>
      !existing.has(entry.id) &&
      (entry.provenance?.kind === "premise-of-result" ||
        entry.provenance?.kind === "suffices" ||
        entry.provenance?.kind === "binder-membership"),
  );
}

function locateTarget(state: ProofState, target: TransitionTarget): LocatedTarget | undefined {
  const collection = target.kind === "goal" ? state.goals : state.obligations;
  const index = collection.findIndex((entry) => entry.id === target.id);
  const entry = collection[index];
  return entry === undefined ? undefined : { entry, index };
}

function failure(
  state: ExecutableProofState,
  code: KernelDiagnosticCode,
  message: string,
  path?: readonly PropertyKey[],
): Extract<KernelTransitionResult, { ok: false }> {
  return {
    ok: false,
    state,
    diagnostics: [{ code, message, ...(path === undefined ? {} : { path }) }],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The kernel environment is invalid.";
}
