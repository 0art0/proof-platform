import {
  assumptionIdSchema,
  attestationIdSchema,
  constructionPlaceholderOperators,
  createExecutableProofStateSchema,
  operatorDeclarationsSchema,
  plainMathJsonSchema,
  proofStateIdSchema,
  declarationIdSchema,
  stableIdentifierSchema,
  statementIdSchema,
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
import {
  copyRewriteLens,
  isRewriteLens,
  parseRewriteSource,
  type RewriteLens,
  type RewriteSource,
} from "./deep-rewrite";
import {
  CONSTRUCTION_OPERATION_KINDS,
  parseConstructionOperation,
  type ConstructionOperation,
  type ConstructionOperationKind,
} from "./constructions";
import {
  kernelResultIdSchema,
  parseKernelResultCatalog,
  type KernelResult,
  type KernelResultId,
  type ResultInstantiation,
} from "./results";
import { applyValidatedOperation } from "./operations/apply";
import type { LocatedTarget } from "./operations/shared";
import { denseArrayValues, hasExactKeys, isStrictRecord } from "./runtime";

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

type RuntimeIssue = Readonly<{ message: string; path: readonly PropertyKey[] }>;
type RuntimeParseResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{ success: false; error: Readonly<{ issues: readonly RuntimeIssue[] }> }>;
type RuntimeSchema<T> = Readonly<{
  safeParse: (value: unknown) => RuntimeParseResult<T>;
  parse: (value: unknown) => T;
}>;

export const transitionTargetSchema: RuntimeSchema<TransitionTarget> =
  createRuntimeSchema(parseTransitionTarget);
export const transitionStatementTargetSchema: RuntimeSchema<TransitionStatementTarget> =
  createRuntimeSchema(parseTransitionStatementTarget);
export const kernelOperationSchema: RuntimeSchema<KernelOperation> =
  createRuntimeSchema(parseKernelOperation);

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

function createRuntimeSchema<T>(
  parser: (value: unknown) => RuntimeParseResult<T>,
): RuntimeSchema<T> {
  const safeParse = (value: unknown): RuntimeParseResult<T> => {
    try {
      return parser(value);
    } catch {
      return runtimeFailure("Runtime schema validation could not inspect the value safely.", []);
    }
  };
  return Object.freeze({
    safeParse,
    parse(value: unknown): T {
      const result = safeParse(value);
      if (result.success) return result.data;
      throw new Error(result.error.issues[0]?.message ?? "Runtime schema validation failed.");
    },
  });
}

function parseTransitionTarget(value: unknown): RuntimeParseResult<TransitionTarget> {
  if (!isStrictRecord(value) || !hasExactKeys(value, ["kind", "id"])) {
    return runtimeFailure("A transition target must be a strict goal or obligation target.", []);
  }
  if (value.kind !== "goal" && value.kind !== "obligation") {
    return runtimeFailure("A transition target kind must be goal or obligation.", ["kind"]);
  }
  const id = statementIdSchema.safeParse(value.id);
  if (!id.success) return runtimeFailure("A transition target requires a stable ID.", ["id"]);
  return { success: true, data: { kind: value.kind, id: id.data } };
}

function parseTransitionStatementTarget(
  value: unknown,
): RuntimeParseResult<TransitionStatementTarget> {
  if (!isStrictRecord(value) || typeof value.kind !== "string") {
    return runtimeFailure("A statement target must be a strict discriminated object.", []);
  }
  if (value.kind === "conclusion") {
    return hasExactKeys(value, ["kind"])
      ? { success: true, data: { kind: "conclusion" } }
      : runtimeFailure("A conclusion target contains unknown fields.", []);
  }
  if (value.kind !== "hypothesis" || !hasExactKeys(value, ["kind", "id"])) {
    return runtimeFailure("A statement target must identify a conclusion or hypothesis.", []);
  }
  const id = statementIdSchema.safeParse(value.id);
  return id.success
    ? { success: true, data: { kind: "hypothesis", id: id.data } }
    : runtimeFailure("A hypothesis statement target requires a stable ID.", ["id"]);
}

const LENS_OPERATION_KINDS: ReadonlySet<string> = new Set<KernelOperationKind>([
  "rewrite-with-equality",
  "rewrite-with-equivalence",
  "rewrite-with-implication",
]);

const TYPED_BINDER_FIELDS: Readonly<Partial<Record<KernelOperationKind, readonly string[]>>> = {
  "introduce-universal": ["parameterDeclarationId", "membershipHypothesisId"],
  "instantiate-universal-hypothesis": ["membershipObligationId"],
  "unpack-existential-hypothesis": ["witnessDeclarationId", "membershipHypothesisId"],
};

function parseKernelOperation(value: unknown): RuntimeParseResult<KernelOperation> {
  if (!isStrictRecord(value) || typeof value.kind !== "string") {
    return runtimeFailure("A kernel operation must be a strict discriminated object.", []);
  }

  const extraKeys: Readonly<Record<KernelOperationKind, readonly string[]>> = {
    "close-by-hypothesis": ["hypothesisId"],
    "close-true": [],
    "close-false-hypothesis": ["hypothesisId"],
    "close-reflexive-equality": [],
    "close-by-contradiction": ["hypothesisId", "negationHypothesisId"],
    "close-by-accepted-inference": ["attestationId"],
    "introduce-implication": ["hypothesisId"],
    "introduce-negation": ["hypothesisId"],
    "split-goal-conjunction": ["childIds"],
    "choose-goal-disjunct": ["disjunctIndex"],
    "expand-hypothesis-conjunction": ["hypothesisId", "expandedHypothesisIds"],
    "split-hypothesis-disjunction": ["hypothesisId", "childIds", "branchHypothesisIds"],
    "split-classical-cases": ["proposition", "childIds", "branchHypothesisIds"],
    "assume-hypothesis": ["proposition", "hypothesisId"],
    "replace-goal": ["proposition"],
    suffices: ["proposition", "obligationId"],
    "drop-hypothesis": ["hypothesisId"],
    "apply-implication-hypothesis": [
      "implicationHypothesisId",
      "antecedentHypothesisId",
      "resultHypothesisId",
    ],
    "introduce-universal": [],
    "instantiate-universal-hypothesis": ["hypothesisId", "term", "resultHypothesisId"],
    "choose-existential-witness": ["witness"],
    "unpack-existential-hypothesis": ["hypothesisId", "resultHypothesisId"],
    "rewrite-with-equality": ["equalityHypothesisId", "statement", "path", "direction"],
    "rewrite-with-equivalence": ["statement", "path", "source", "direction"],
    "rewrite-with-implication": ["statement", "path", "source"],
    "apply-result-backward": ["resultId", "instantiation", "premiseTargetIds"],
    "apply-result-forward": [
      "resultId",
      "instantiation",
      "premiseHypothesisIds",
      "resultHypothesisId",
      "obligationIds",
    ],
    "mark-sorry": ["assumptionId"],
    "close-by-assumption": ["assumptionId", "instantiation"],
  };
  if ((CONSTRUCTION_OPERATION_KINDS as readonly string[]).includes(value.kind)) {
    const constructionBase = parseOperationBase(value);
    if (!constructionBase.success) return constructionBase;
    const parsed = parseConstructionOperation(value, constructionBase.data);
    return parsed.ok
      ? { success: true, data: parsed.operation }
      : runtimeFailure(parsed.message, parsed.path);
  }
  if (!(KERNEL_OPERATION_KINDS as readonly string[]).includes(value.kind)) {
    return runtimeFailure("The kernel operation kind is unknown.", ["kind"]);
  }
  const extras = extraKeys[value.kind as KernelOperationKind];
  // Rewrites accept one optional field: an associative lens under `path`.
  const hasLens = LENS_OPERATION_KINDS.has(value.kind) && Object.hasOwn(value, "lens");
  // A sorry accepts one optional field: an external sorry reference.
  const hasSorryId = value.kind === "mark-sorry" && Object.hasOwn(value, "sorryId");
  // Typed quantifier binders add optional IDs for the declaration, hypothesis or obligation they create.
  const typedBinderKeys = (TYPED_BINDER_FIELDS[value.kind as KernelOperationKind] ?? []).filter(
    (key) => Object.hasOwn(value, key),
  );
  if (
    !hasExactKeys(value, [
      "kind",
      "expectedStateId",
      "resultStateId",
      "target",
      ...extras,
      ...(hasLens ? ["lens"] : []),
      ...(hasSorryId ? ["sorryId"] : []),
      ...typedBinderKeys,
    ])
  ) {
    return runtimeFailure("The kernel operation contains missing or unknown fields.", []);
  }

  const base = parseOperationBase(value);
  if (!base.success) return base;

  for (const field of [
    "hypothesisId",
    "implicationHypothesisId",
    "antecedentHypothesisId",
    "resultHypothesisId",
    "equalityHypothesisId",
    "negationHypothesisId",
    "obligationId",
  ] as const) {
    if (field in value && !statementIdSchema.safeParse(value[field]).success) {
      return runtimeFailure("The statement ID is invalid.", [field]);
    }
  }
  if ("assumptionId" in value && !assumptionIdSchema.safeParse(value.assumptionId).success) {
    return runtimeFailure("The assumption ID is invalid.", ["assumptionId"]);
  }
  if (hasSorryId && !stableIdentifierSchema.safeParse(value.sorryId).success) {
    return runtimeFailure("The sorry ID is invalid.", ["sorryId"]);
  }
  if ("attestationId" in value && !attestationIdSchema.safeParse(value.attestationId).success) {
    return runtimeFailure("The attestation ID is invalid.", ["attestationId"]);
  }
  for (const field of ["childIds", "expandedHypothesisIds", "branchHypothesisIds"] as const) {
    if (field in value && !isStatementIdArray(value[field])) {
      return runtimeFailure("An ID list requires at least two stable, dense IDs.", [field]);
    }
  }
  if ("resultId" in value && !kernelResultIdSchema.safeParse(value.resultId).success) {
    return runtimeFailure("The result ID is invalid.", ["resultId"]);
  }
  if ("instantiation" in value && !isInstantiation(value.instantiation)) {
    return runtimeFailure("An instantiation must map parameter symbols to plain MathJSON terms.", [
      "instantiation",
    ]);
  }
  for (const field of ["premiseTargetIds", "obligationIds"] as const) {
    if (field in value && !isStatementIdArray(value[field], 0)) {
      return runtimeFailure("An ID list must contain stable, dense IDs.", [field]);
    }
  }
  if ("premiseHypothesisIds" in value && !isOptionalStatementIdArray(value.premiseHypothesisIds)) {
    return runtimeFailure("Premise hypothesis entries must be stable IDs or null.", [
      "premiseHypothesisIds",
    ]);
  }
  if (
    value.kind === "split-classical-cases" &&
    ((value.childIds as readonly unknown[]).length !== 2 ||
      (value.branchHypothesisIds as readonly unknown[]).length !== 2)
  ) {
    return runtimeFailure("A classical case split requires exactly two IDs in each list.", []);
  }
  if (
    "disjunctIndex" in value &&
    (typeof value.disjunctIndex !== "number" ||
      !Number.isInteger(value.disjunctIndex) ||
      value.disjunctIndex < 0)
  ) {
    return runtimeFailure("A disjunct index must be a nonnegative integer.", ["disjunctIndex"]);
  }
  for (const field of ["term", "witness", "proposition"] as const) {
    if (field in value && !plainMathJsonSchema.safeParse(value[field]).success) {
      return runtimeFailure("An expression must be serializable plain MathJSON.", [field]);
    }
  }
  if ("path" in value && !isOperandPath(value.path)) {
    return runtimeFailure("A rewrite path must be a dense list of operand indices.", ["path"]);
  }
  if ("direction" in value && value.direction !== "forward" && value.direction !== "backward") {
    return runtimeFailure("A rewrite direction must be forward or backward.", ["direction"]);
  }
  const statement =
    "statement" in value ? transitionStatementTargetSchema.safeParse(value.statement) : undefined;
  if (statement !== undefined && !statement.success) {
    return runtimeFailure("The rewrite statement target is invalid.", ["statement"]);
  }
  if (hasLens && !isRewriteLens(value.lens)) {
    return runtimeFailure(
      "A rewrite lens must contain exactly startOperand and endOperand covering at least two operands.",
      ["lens"],
    );
  }
  const lens: Readonly<{ lens?: RewriteLens }> = hasLens
    ? { lens: copyRewriteLens(value.lens) }
    : {};
  const source =
    "source" in value
      ? parseRewriteSource(value.source, isInstantiation, copyInstantiation)
      : undefined;
  if ("source" in value && source === undefined) {
    return runtimeFailure(
      "A rewrite source must be a hypothesis ID or a result ID with an instantiation.",
      ["source"],
    );
  }

  const common = base.data;
  switch (value.kind) {
    case "close-by-hypothesis":
    case "close-false-hypothesis":
    case "introduce-implication":
    case "introduce-negation":
    case "drop-hypothesis":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          hypothesisId: statementIdSchema.parse(value.hypothesisId),
        },
      };
    case "close-true":
    case "close-reflexive-equality":
      return { success: true, data: { ...common, kind: value.kind } };
    case "introduce-universal":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          ...optionalDeclarationId(value, "parameterDeclarationId"),
          ...optionalStatementId(value, "membershipHypothesisId"),
        },
      };
    case "close-by-contradiction":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          hypothesisId: statementIdSchema.parse(value.hypothesisId),
          negationHypothesisId: statementIdSchema.parse(value.negationHypothesisId),
        },
      };
    case "close-by-accepted-inference":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          attestationId: attestationIdSchema.parse(value.attestationId),
        },
      };
    case "split-goal-conjunction":
      return {
        success: true,
        data: { ...common, kind: value.kind, childIds: copyStatementIds(value.childIds) },
      };
    case "choose-goal-disjunct":
      return {
        success: true,
        data: { ...common, kind: value.kind, disjunctIndex: value.disjunctIndex as number },
      };
    case "expand-hypothesis-conjunction":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          hypothesisId: statementIdSchema.parse(value.hypothesisId),
          expandedHypothesisIds: copyStatementIds(value.expandedHypothesisIds),
        },
      };
    case "split-hypothesis-disjunction":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          hypothesisId: statementIdSchema.parse(value.hypothesisId),
          childIds: copyStatementIds(value.childIds),
          branchHypothesisIds: copyStatementIds(value.branchHypothesisIds),
        },
      };
    case "split-classical-cases":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          proposition: copyPlainMathJson(value.proposition),
          childIds: copyStatementIdPair(value.childIds),
          branchHypothesisIds: copyStatementIdPair(value.branchHypothesisIds),
        },
      };
    case "replace-goal":
      return {
        success: true,
        data: { ...common, kind: value.kind, proposition: copyPlainMathJson(value.proposition) },
      };
    case "suffices":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          proposition: copyPlainMathJson(value.proposition),
          obligationId: statementIdSchema.parse(value.obligationId),
        },
      };
    case "assume-hypothesis":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          proposition: copyPlainMathJson(value.proposition),
          hypothesisId: statementIdSchema.parse(value.hypothesisId),
        },
      };
    case "apply-implication-hypothesis":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          implicationHypothesisId: statementIdSchema.parse(value.implicationHypothesisId),
          antecedentHypothesisId: statementIdSchema.parse(value.antecedentHypothesisId),
          resultHypothesisId: statementIdSchema.parse(value.resultHypothesisId),
        },
      };
    case "instantiate-universal-hypothesis":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          hypothesisId: statementIdSchema.parse(value.hypothesisId),
          term: copyPlainMathJson(value.term),
          resultHypothesisId: statementIdSchema.parse(value.resultHypothesisId),
          ...optionalStatementId(value, "membershipObligationId"),
        },
      };
    case "choose-existential-witness":
      return {
        success: true,
        data: { ...common, kind: value.kind, witness: copyPlainMathJson(value.witness) },
      };
    case "unpack-existential-hypothesis":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          hypothesisId: statementIdSchema.parse(value.hypothesisId),
          resultHypothesisId: statementIdSchema.parse(value.resultHypothesisId),
          ...optionalDeclarationId(value, "witnessDeclarationId"),
          ...optionalStatementId(value, "membershipHypothesisId"),
        },
      };
    case "rewrite-with-equality":
      if (statement === undefined || !statement.success) {
        return runtimeFailure("The rewrite statement target is invalid.", ["statement"]);
      }
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          equalityHypothesisId: statementIdSchema.parse(value.equalityHypothesisId),
          statement: statement.data,
          path: copyOperandPath(value.path),
          ...lens,
          direction: value.direction as "forward" | "backward",
        },
      };
    case "rewrite-with-equivalence":
    case "rewrite-with-implication": {
      if (statement === undefined || !statement.success || source === undefined) {
        return runtimeFailure("The rewrite statement target or source is invalid.", []);
      }
      const rewrite = {
        ...common,
        statement: statement.data,
        path: copyOperandPath(value.path),
        ...lens,
        source,
      };
      return value.kind === "rewrite-with-implication"
        ? { success: true, data: { ...rewrite, kind: value.kind } }
        : {
            success: true,
            data: {
              ...rewrite,
              kind: value.kind,
              direction: value.direction as "forward" | "backward",
            },
          };
    }
    case "apply-result-backward":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          resultId: kernelResultIdSchema.parse(value.resultId),
          instantiation: copyInstantiation(value.instantiation),
          premiseTargetIds: copyStatementIds(value.premiseTargetIds),
        },
      };
    case "apply-result-forward":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          resultId: kernelResultIdSchema.parse(value.resultId),
          instantiation: copyInstantiation(value.instantiation),
          premiseHypothesisIds: copyOptionalStatementIds(value.premiseHypothesisIds),
          resultHypothesisId: statementIdSchema.parse(value.resultHypothesisId),
          obligationIds: copyStatementIds(value.obligationIds),
        },
      };
    case "mark-sorry":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          assumptionId: assumptionIdSchema.parse(value.assumptionId),
          ...(hasSorryId ? { sorryId: stableIdentifierSchema.parse(value.sorryId) } : {}),
        },
      };
    case "close-by-assumption":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          assumptionId: assumptionIdSchema.parse(value.assumptionId),
          instantiation: copyInstantiation(value.instantiation),
        },
      };
  }
  return runtimeFailure("The kernel operation kind is unknown.", ["kind"]);
}

function parseOperationBase(
  value: Readonly<Record<string, unknown>>,
): RuntimeParseResult<OperationBase> {
  const expectedStateId = proofStateIdSchema.safeParse(value.expectedStateId);
  if (!expectedStateId.success) {
    return runtimeFailure("The expected state ID is invalid.", ["expectedStateId"]);
  }
  const resultStateId = proofStateIdSchema.safeParse(value.resultStateId);
  if (!resultStateId.success) {
    return runtimeFailure("The result state ID is invalid.", ["resultStateId"]);
  }
  const target = transitionTargetSchema.safeParse(value.target);
  if (!target.success) {
    return runtimeFailure(target.error.issues[0]?.message ?? "The target is invalid.", ["target"]);
  }
  return {
    success: true,
    data: {
      expectedStateId: expectedStateId.data,
      resultStateId: resultStateId.data,
      target: target.data,
    },
  };
}

function copyPlainMathJson(value: unknown): PlainMathJson {
  const parsed = plainMathJsonSchema.parse(value);
  return structuredClone(parsed);
}

function copyOperandPath(value: unknown): readonly number[] {
  if (!Array.isArray(value)) throw new Error("Expected a validated operand path.");
  return Array.from({ length: value.length }, (_unused, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("Expected a dense operand path.");
    }
    return descriptor.value as number;
  });
}

function isOperandPath(value: unknown): value is readonly number[] {
  if (!Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !Number.isInteger(Number(key))) ||
        (key !== "length" && (Number(key) < 0 || Number(key) >= value.length)),
    )
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "number" ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0
    ) {
      return false;
    }
  }
  return true;
}

function optionalStatementId(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, StatementId>> {
  return value[key] === undefined ? {} : { [key]: statementIdSchema.parse(value[key]) };
}

function optionalDeclarationId(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, DeclarationId>> {
  return value[key] === undefined ? {} : { [key]: declarationIdSchema.parse(value[key]) };
}

function copyStatementIds(value: unknown): readonly StatementId[] {
  if (!Array.isArray(value)) throw new Error("Expected a validated statement-ID array.");
  return Array.from({ length: value.length }, (_unused, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("Expected a dense statement-ID array.");
    }
    return statementIdSchema.parse(descriptor.value);
  });
}

function copyStatementIdPair(value: unknown): readonly [StatementId, StatementId] {
  const ids = copyStatementIds(value);
  if (ids.length !== 2) throw new Error("Expected exactly two validated statement IDs.");
  return [ids[0] as StatementId, ids[1] as StatementId];
}

function isInstantiation(value: unknown): value is ResultInstantiation {
  return (
    isStrictRecord(value) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && key.length > 0) &&
    Object.values(value).every((term) => plainMathJsonSchema.safeParse(term).success)
  );
}

function copyInstantiation(value: unknown): ResultInstantiation {
  if (!isStrictRecord(value)) throw new Error("Expected a validated instantiation.");
  return Object.fromEntries(
    Object.entries(value).map(([symbol, term]) => [symbol, copyPlainMathJson(term)]),
  );
}

function isOptionalStatementIdArray(value: unknown): value is readonly (StatementId | null)[] {
  const entries = denseArrayValues(value);
  return (
    entries !== undefined &&
    entries.every((entry) => entry === null || statementIdSchema.safeParse(entry).success)
  );
}

function copyOptionalStatementIds(value: unknown): readonly (StatementId | null)[] {
  const entries = denseArrayValues(value);
  if (entries === undefined) throw new Error("Expected a validated premise hypothesis list.");
  return entries.map((entry) => (entry === null ? null : statementIdSchema.parse(entry)));
}

function isStatementIdArray(value: unknown, minimumLength = 2): value is readonly StatementId[] {
  if (!Array.isArray(value) || value.length < minimumLength) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !Number.isInteger(Number(key))) ||
        (key !== "length" && (Number(key) < 0 || Number(key) >= value.length)),
    )
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return false;
    if (!statementIdSchema.safeParse(descriptor.value).success) return false;
  }
  return true;
}

function runtimeFailure<T>(message: string, path: readonly PropertyKey[]): RuntimeParseResult<T> {
  return { success: false, error: { issues: [{ message, path }] } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The kernel environment is invalid.";
}
