import {
  assumptionIdSchema,
  attestationIdSchema,
  constructionPlaceholderOperators,
  createExecutableProofStateSchema,
  createStatementViewSchema,
  freeSymbolNames,
  mathJsonEquals,
  operatorDeclarationsSchema,
  plainMathJsonSchema,
  proofStateIdSchema,
  stableIdentifierSchema,
  statementIdSchema,
  substituteMathJson,
  type AdditionalAssumption,
  type AssumptionId,
  type AttestationId,
  type ContextualSequent,
  type Declaration,
  type ExecutableProofState,
  type Goal,
  type Hypothesis,
  type Obligation,
  type ObligationProvenance,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofState,
  type ProofStateId,
  type StatementId,
} from "@proof/mathjson-model";
import { alphaEquivalentWithOperators } from "./alpha-equivalence";
import {
  copyRewriteLens,
  isRewriteLens,
  locateRewriteOccurrence,
  parseRewriteSource,
  rewriteCaptures,
  type RewriteLens,
  type RewriteSource,
} from "./deep-rewrite";
import {
  CONSTRUCTION_OPERATION_KINDS,
  abandonPlaceholder,
  addCandidate,
  addRequirement,
  introducePlaceholder,
  mentionsOpenPlaceholder,
  parseConstructionOperation,
  resolvePlaceholder,
  type ConstructionOperation,
} from "./constructions";
import { operatorOperands, readBuiltinQuantifier } from "./expression";
import { closesByAssumption, sorryClosure } from "./obligations";
import {
  instantiateResultInContext,
  kernelResultIdSchema,
  parseKernelResultCatalog,
  type KernelResult,
  type KernelResultId,
  type ResultInstantiation,
} from "./results";
import { denseArrayValues, hasExactKeys, isStrictRecord } from "./runtime";

export { alphaEquivalent, type AlphaEquivalenceEnvironment } from "./alpha-equivalence";
export { sorryClosure, type SorryClosure, type SorryClosureResult } from "./obligations";
export type { RewriteLens, RewriteSource } from "./deep-rewrite";
export {
  RESULT_APPLICATION_DIRECTIONS,
  freeResultParameters,
  kernelResultIdSchema,
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
  | (OperationBase & Readonly<{ kind: "introduce-universal" }>)
  | (OperationBase &
      Readonly<{
        kind: "instantiate-universal-hypothesis";
        hypothesisId: StatementId;
        term: PlainMathJson;
        resultHypothesisId: StatementId;
      }>)
  | (OperationBase & Readonly<{ kind: "choose-existential-witness"; witness: PlainMathJson }>)
  | (OperationBase &
      Readonly<{
        kind: "unpack-existential-hypothesis";
        hypothesisId: StatementId;
        resultHypothesisId: StatementId;
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

type TargetEntry = Goal | Obligation;
type LocatedTarget = Readonly<{ entry: TargetEntry; index: number }>;

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

type InternalResult =
  | Readonly<{
      ok: true;
      state: ProofState;
      transitionClass: TransitionClass;
      evidence: TransitionEvidence;
      resultId?: KernelResultId;
    }>
  | Readonly<{ ok: false; state: ProofState; diagnostics: readonly KernelDiagnostic[] }>;

function applyValidatedOperation(
  state: ProofState,
  target: LocatedTarget,
  operation: KernelOperation,
  operators: readonly OperatorDeclaration[],
  results: readonly KernelResult[],
  environmentOperators: readonly OperatorDeclaration[],
): InternalResult {
  switch (operation.kind) {
    case "close-by-hypothesis": {
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
      return success(replaceTarget(state, operation.target, target.index, []), "equivalence");
    }
    case "close-true": {
      if (!isSymbol(target.entry.sequent.conclusion.expression, "True")) {
        return notApplicable(state, "The target conclusion is not truth.");
      }
      return success(replaceTarget(state, operation.target, target.index, []), "equivalence");
    }
    case "close-false-hypothesis": {
      const selected = findHypothesis(target.entry.sequent, operation.hypothesisId);
      if (selected === undefined) return missingHypothesis(state);
      if (!isSymbol(selected.statement.expression, "False")) {
        return notApplicable(state, "The selected hypothesis is not falsity.");
      }
      return success(replaceTarget(state, operation.target, target.index, []), "equivalence");
    }
    case "close-reflexive-equality": {
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
      return success(replaceTarget(state, operation.target, target.index, []), "equivalence");
    }
    case "close-by-contradiction": {
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
      return success(replaceTarget(state, operation.target, target.index, []), "equivalence");
    }
    case "close-by-accepted-inference":
      // The attestation is recorded in the operation; the kernel does not judge it.
      return success(
        replaceTarget(state, operation.target, target.index, []),
        "equivalence",
        "background-inference",
      );
    case "introduce-implication": {
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
    case "introduce-negation": {
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
    case "split-goal-conjunction": {
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
      return success(
        replaceTarget(state, operation.target, target.index, replacements),
        "equivalence",
      );
    }
    case "choose-goal-disjunct": {
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
    case "expand-hypothesis-conjunction": {
      const hypothesisIndex = findHypothesisIndex(target.entry.sequent, operation.hypothesisId);
      if (hypothesisIndex < 0) return missingHypothesis(state);
      const selected = target.entry.sequent.context.hypotheses[hypothesisIndex] as Hypothesis;
      const operands = logicalOperands(selected.statement.expression, "And");
      if (operands === undefined) {
        return notApplicable(state, "The selected hypothesis is not a conjunction.");
      }
      if (operation.expandedHypothesisIds.length !== operands.length) return arityMismatch(state);
      const collision = hypothesisIdCollision(
        target.entry.sequent,
        operation.expandedHypothesisIds,
      );
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
    case "split-hypothesis-disjunction": {
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
      return success(
        replaceTarget(state, operation.target, target.index, replacements),
        "equivalence",
      );
    }
    case "split-classical-cases": {
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
      return success(
        replaceTarget(state, operation.target, target.index, replacements),
        "equivalence",
      );
    }
    case "assume-hypothesis": {
      if (!isPropositionInContext(operation.proposition, target.entry.sequent, operators)) {
        return invalidProposition(state, "assumed hypothesis");
      }
      const collision = hypothesisIdCollision(target.entry.sequent, [operation.hypothesisId]);
      if (collision !== undefined) return idCollision(state, collision);
      const replacement = appendHypothesis(
        target.entry,
        hypothesis(operation.hypothesisId, operation.proposition),
      );
      return success(
        replaceTarget(state, operation.target, target.index, [replacement]),
        "weakening",
      );
    }
    case "replace-goal": {
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
    case "suffices": {
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
      const next =
        operation.target.kind === "obligation"
          ? replaceTarget(state, operation.target, target.index, [replaced, implication])
          : {
              ...replaceTarget(state, operation.target, target.index, [replaced]),
              obligations: [...state.obligations, implication],
            };
      return success(next, "strengthening");
    }
    case "drop-hypothesis": {
      const hypothesisIndex = findHypothesisIndex(target.entry.sequent, operation.hypothesisId);
      if (hypothesisIndex < 0) return missingHypothesis(state);
      return success(
        replaceTarget(state, operation.target, target.index, [
          replaceHypothesis(target.entry, hypothesisIndex, []),
        ]),
        "strengthening",
      );
    }
    case "apply-implication-hypothesis": {
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
    case "introduce-universal": {
      const quantifier = readBuiltinQuantifier(
        target.entry.sequent.conclusion.expression,
        "ForAll",
      );
      if (quantifier === undefined) {
        return notApplicable(state, "The target conclusion is not a universal statement.");
      }
      const declaration = findDeclaration(target.entry.sequent, quantifier.symbol);
      if (declaration?.role !== "universal-parameter") {
        return notApplicable(
          state,
          "The bound symbol requires a universal-parameter declaration in the local context.",
        );
      }
      if (contextDependsOnSymbol(target.entry.sequent, quantifier.symbol, operators, true)) {
        return notApplicable(
          state,
          "The universal parameter occurs freely in a local hypothesis or construction.",
        );
      }
      const replacement: TargetEntry = {
        ...target.entry,
        sequent: {
          ...target.entry.sequent,
          conclusion: { expression: structuredClone(quantifier.body) },
        },
      };
      return success(
        replaceTarget(state, operation.target, target.index, [replacement]),
        "equivalence",
      );
    }
    case "instantiate-universal-hypothesis": {
      const selected = findHypothesis(target.entry.sequent, operation.hypothesisId);
      if (selected === undefined) return missingHypothesis(state);
      const quantifier = readBuiltinQuantifier(selected.statement.expression, "ForAll");
      if (quantifier === undefined) {
        return notApplicable(state, "The selected hypothesis is not universal.");
      }
      const collision = hypothesisIdCollision(target.entry.sequent, [operation.resultHypothesisId]);
      if (collision !== undefined) return idCollision(state, collision);
      const instantiated = substituteBoundSymbol(
        quantifier.body,
        quantifier.symbol,
        operation.term,
        operators,
      );
      if (instantiated === undefined) return replacementFailed(state);
      const replacement = appendHypothesis(
        target.entry,
        hypothesis(operation.resultHypothesisId, instantiated),
      );
      return success(
        replaceTarget(state, operation.target, target.index, [replacement]),
        "equivalence",
      );
    }
    case "choose-existential-witness": {
      const quantifier = readBuiltinQuantifier(
        target.entry.sequent.conclusion.expression,
        "Exists",
      );
      if (quantifier === undefined) {
        return notApplicable(state, "The target conclusion is not existential.");
      }
      const instantiated = substituteBoundSymbol(
        quantifier.body,
        quantifier.symbol,
        operation.witness,
        operators,
      );
      if (instantiated === undefined) return replacementFailed(state);
      const replacement: TargetEntry = {
        ...target.entry,
        sequent: {
          ...target.entry.sequent,
          conclusion: { expression: instantiated },
        },
      };
      return success(
        replaceTarget(state, operation.target, target.index, [replacement]),
        "strengthening",
      );
    }
    case "unpack-existential-hypothesis": {
      const hypothesisIndex = findHypothesisIndex(target.entry.sequent, operation.hypothesisId);
      if (hypothesisIndex < 0) return missingHypothesis(state);
      const selected = target.entry.sequent.context.hypotheses[hypothesisIndex] as Hypothesis;
      const quantifier = readBuiltinQuantifier(selected.statement.expression, "Exists");
      if (quantifier === undefined) {
        return notApplicable(state, "The selected hypothesis is not existential.");
      }
      const declaration = findDeclaration(target.entry.sequent, quantifier.symbol);
      if (declaration?.role !== "local-witness") {
        return notApplicable(
          state,
          "The bound symbol requires a local-witness declaration in the local context.",
        );
      }
      if (
        contextDependsOnSymbol(
          target.entry.sequent,
          quantifier.symbol,
          operators,
          false,
          operation.hypothesisId,
        )
      ) {
        return notApplicable(
          state,
          "The existential witness is not fresh for the rest of the contextual sequent.",
        );
      }
      const collision = hypothesisIdCollision(target.entry.sequent, [operation.resultHypothesisId]);
      if (collision !== undefined) return idCollision(state, collision);
      const replacement = replaceHypothesis(target.entry, hypothesisIndex, [
        hypothesis(operation.resultHypothesisId, quantifier.body),
      ]);
      return success(
        replaceTarget(state, operation.target, target.index, [replacement]),
        "equivalence",
      );
    }
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
    case "close-by-assumption": {
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
      return success(replaceTarget(state, operation.target, target.index, []), "equivalence");
    }
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

/**
 * Remove the target and append its dependency-restricted universal closure
 * (see `sorryClosure`) as an additional assumption whose origin records the
 * removed target. Relative to the extended assumption set the result is
 * provable exactly when the input is, so the class is equivalence; the
 * evidence is `sorry` because the closure itself is unproved.
 */
function markSorry(
  state: ProofState,
  target: LocatedTarget,
  operation: Extract<KernelOperation, { kind: "mark-sorry" }>,
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

/**
 * Backward application: the instantiated conclusion must match the target
 * conclusion up to alpha-equivalence, and each instantiated premise replaces
 * the target as a new target of the same kind in the same local context. A
 * result without premises closes the target. Proving the premises proves the
 * target, so the transition is a strengthening.
 */
function applyResultBackward(
  state: ProofState,
  target: LocatedTarget,
  operation: Extract<KernelOperation, { kind: "apply-result-backward" }>,
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
 * classifies this as equivalence: the derived fact adds nothing unprovable,
 * and unmet premises remain as required obligations. Obligations follow an
 * obligation target directly and are appended after existing obligations for
 * a goal target, as with `suffices`.
 */
function applyResultForward(
  state: ProofState,
  target: LocatedTarget,
  operation: Extract<KernelOperation, { kind: "apply-result-forward" }>,
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
  const next =
    operation.target.kind === "obligation"
      ? replaceTarget(state, operation.target, target.index, [derived, ...obligations])
      : {
          ...replaceTarget(state, operation.target, target.index, [derived]),
          obligations: [...state.obligations, ...obligations],
        };
  return success(next, "equivalence", "library-result", operation.resultId);
}

function locateTarget(state: ProofState, target: TransitionTarget): LocatedTarget | undefined {
  const collection = target.kind === "goal" ? state.goals : state.obligations;
  const index = collection.findIndex((entry) => entry.id === target.id);
  const entry = collection[index];
  return entry === undefined ? undefined : { entry, index };
}

function replaceTarget(
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

function replaceHypothesis(
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

function appendHypothesis(target: TargetEntry, appended: Hypothesis): TargetEntry {
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

function withConclusion(target: TargetEntry, expression: PlainMathJson): TargetEntry {
  return {
    ...target,
    sequent: { ...target.sequent, conclusion: { expression: structuredClone(expression) } },
  };
}

/** A new obligation copies its parent's provenance; goals carry none. */
function provenanceOf(entry: TargetEntry): Readonly<{ provenance?: ObligationProvenance }> {
  return "provenance" in entry && entry.provenance !== undefined
    ? { provenance: structuredClone(entry.provenance) }
    : {};
}

/** Provenance for a new target replacing `target`: only obligations carry it. */
function obligationProvenance(
  target: TransitionTarget,
  provenance: ObligationProvenance,
): Readonly<{ provenance?: ObligationProvenance }> {
  return target.kind === "obligation" ? { provenance } : {};
}

function hypothesis(id: StatementId, expression: PlainMathJson): Hypothesis {
  return { id, statement: { expression: structuredClone(expression) } };
}

function findHypothesis(sequent: ContextualSequent, id: StatementId): Hypothesis | undefined {
  return sequent.context.hypotheses.find((candidate) => candidate.id === id);
}

function findHypothesisIndex(sequent: ContextualSequent, id: StatementId): number {
  return sequent.context.hypotheses.findIndex((candidate) => candidate.id === id);
}

function findDeclaration(sequent: ContextualSequent, symbol: string): Declaration | undefined {
  return sequent.context.declarations.find((candidate) => candidate.symbol === symbol);
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

function substituteBoundSymbol(
  body: PlainMathJson,
  symbol: string,
  replacement: PlainMathJson,
  operators: readonly OperatorDeclaration[],
): PlainMathJson | undefined {
  const result = substituteMathJson(body, [{ symbol, replacement }], { operators });
  return result.ok ? result.expression : undefined;
}

function contextDependsOnSymbol(
  sequent: ContextualSequent,
  symbol: string,
  operators: readonly OperatorDeclaration[],
  ignoreConclusion: boolean,
  ignoredHypothesisId?: StatementId,
): boolean {
  const expressions: PlainMathJson[] = [];
  if (!ignoreConclusion) expressions.push(sequent.conclusion.expression);
  sequent.context.hypotheses.forEach((candidate) => {
    if (candidate.id !== ignoredHypothesisId) expressions.push(candidate.statement.expression);
  });
  sequent.context.declarations.forEach((declaration) => {
    if (
      declaration.role === "construction-metavariable" &&
      declaration.resolution.status === "resolved"
    ) {
      expressions.push(declaration.resolution.value);
    }
  });
  return expressions.some((expression) =>
    freeSymbolNames(expression, { operators }).includes(symbol),
  );
}

type RewriteOperation = Extract<
  KernelOperation,
  { kind: "rewrite-with-equality" | "rewrite-with-equivalence" | "rewrite-with-implication" }
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
function rewriteStatement(
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

function logicalOperands(
  expression: PlainMathJson,
  operator: "And" | "Or" | "Implies",
): readonly PlainMathJson[] | undefined {
  return operatorOperands(expression, operator);
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

function targetIdCollision(state: ProofState, ids: readonly StatementId[]): string | undefined {
  const existing = new Set([...state.goals, ...state.obligations].map((entry) => entry.id));
  return firstCollision(ids, existing);
}

function hypothesisIdCollision(
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

function success(
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

function internalFailure(
  state: ProofState,
  code: KernelDiagnosticCode,
  message: string,
): Extract<InternalResult, { ok: false }> {
  return { ok: false, state, diagnostics: [{ code, message }] };
}

function missingHypothesis(state: ProofState): Extract<InternalResult, { ok: false }> {
  return internalFailure(
    state,
    "hypothesis-not-found",
    "The hypothesis does not exist in the target's local context.",
  );
}

function idCollision(
  state: ProofState,
  identifier: string,
): Extract<InternalResult, { ok: false }> {
  return internalFailure(
    state,
    "identifier-collision",
    `The supplied statement ID is not fresh: ${identifier}.`,
  );
}

function arityMismatch(state: ProofState): Extract<InternalResult, { ok: false }> {
  return internalFailure(
    state,
    "arity-mismatch",
    "The supplied IDs must correspond one-for-one with the logical operands.",
  );
}

function replacementFailed(state: ProofState): Extract<InternalResult, { ok: false }> {
  return internalFailure(
    state,
    "replacement-failed",
    "The requested capture-safe replacement could not be constructed.",
  );
}

function invalidProposition(
  state: ProofState,
  label: string,
): Extract<InternalResult, { ok: false }> {
  return internalFailure(
    state,
    "invalid-proposition",
    `The ${label} is not a well-scoped, well-sorted proposition in the target's local context.`,
  );
}

function notApplicable(state: ProofState, message: string): Extract<InternalResult, { ok: false }> {
  return internalFailure(state, "rule-not-applicable", message);
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
  if (
    !hasExactKeys(value, [
      "kind",
      "expectedStateId",
      "resultStateId",
      "target",
      ...extras,
      ...(hasLens ? ["lens"] : []),
      ...(hasSorryId ? ["sorryId"] : []),
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
    case "introduce-universal":
      return { success: true, data: { ...common, kind: value.kind } };
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
