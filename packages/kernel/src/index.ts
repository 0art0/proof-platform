import {
  BUILTIN_BINDER_SPECIFICATIONS,
  createExecutableProofStateSchema,
  freeSymbolNames,
  mathJsonEquals,
  operatorDeclarationsSchema,
  plainMathJsonSchema,
  proofStateIdSchema,
  statementIdSchema,
  substituteMathJson,
  type ContextualSequent,
  type Declaration,
  type ExecutableProofState,
  type Goal,
  type Hypothesis,
  type Obligation,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofState,
  type ProofStateId,
  type StatementId,
} from "@proof/mathjson-model";

export type TransitionClass = "equivalence" | "strengthening" | "weakening";

export type TransitionTarget = Readonly<{
  kind: "goal" | "obligation";
  id: StatementId;
}>;

export type TransitionStatementTarget =
  Readonly<{ kind: "conclusion" }> | Readonly<{ kind: "hypothesis"; id: StatementId }>;

export const KERNEL_OPERATION_KINDS = [
  "close-by-hypothesis",
  "close-true",
  "close-false-hypothesis",
  "introduce-implication",
  "introduce-negation",
  "split-goal-conjunction",
  "choose-goal-disjunct",
  "expand-hypothesis-conjunction",
  "split-hypothesis-disjunction",
  "apply-implication-hypothesis",
  "introduce-universal",
  "instantiate-universal-hypothesis",
  "choose-existential-witness",
  "unpack-existential-hypothesis",
  "rewrite-with-equality",
] as const;
export type KernelOperationKind = (typeof KERNEL_OPERATION_KINDS)[number];

type OperationBase = Readonly<{
  expectedStateId: ProofStateId;
  resultStateId: ProofStateId;
  target: TransitionTarget;
}>;

export type KernelOperation =
  | (OperationBase & Readonly<{ kind: "close-by-hypothesis"; hypothesisId: StatementId }>)
  | (OperationBase & Readonly<{ kind: "close-true" }>)
  | (OperationBase & Readonly<{ kind: "close-false-hypothesis"; hypothesisId: StatementId }>)
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
        direction: "forward" | "backward";
      }>);

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
  | "replacement-failed"
  | "rule-not-applicable"
  | "invalid-result-state";

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

  const transition = applyValidatedOperation(working, located, operation, operators);
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
    diagnostics: [],
  };
}

type InternalResult =
  | Readonly<{ ok: true; state: ProofState; transitionClass: TransitionClass }>
  | Readonly<{ ok: false; state: ProofState; diagnostics: readonly KernelDiagnostic[] }>;

function applyValidatedOperation(
  state: ProofState,
  target: LocatedTarget,
  operation: KernelOperation,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  switch (operation.kind) {
    case "close-by-hypothesis": {
      const selected = findHypothesis(target.entry.sequent, operation.hypothesisId);
      if (selected === undefined) return missingHypothesis(state);
      if (
        !mathJsonEquals(selected.statement.expression, target.entry.sequent.conclusion.expression)
      ) {
        return notApplicable(
          state,
          "The selected hypothesis does not exactly match the conclusion.",
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
        };
      });
      return success(
        replaceTarget(state, operation.target, target.index, replacements),
        "equivalence",
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
    case "rewrite-with-equality": {
      return rewriteWithEquality(state, target, operation, operators);
    }
  }
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

function readBuiltinQuantifier(
  expression: PlainMathJson,
  operator: "ForAll" | "Exists",
): Readonly<{ symbol: string; body: PlainMathJson }> | undefined {
  const operands = operatorOperands(expression, operator);
  const symbol = operands === undefined ? undefined : symbolValue(operands[0] as PlainMathJson);
  const body = operands?.[1];
  return operands?.length === 2 && symbol !== undefined && body !== undefined
    ? { symbol, body }
    : undefined;
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

function rewriteWithEquality(
  state: ProofState,
  target: LocatedTarget,
  operation: Extract<KernelOperation, { kind: "rewrite-with-equality" }>,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const equality = findHypothesis(target.entry.sequent, operation.equalityHypothesisId);
  if (equality === undefined) return missingHypothesis(state);
  const equalityOperands = operatorOperands(equality.statement.expression, "Equal");
  if (equalityOperands === undefined || equalityOperands.length !== 2) {
    return notApplicable(state, "The selected hypothesis is not a binary equality.");
  }
  if (
    operation.statement.kind === "hypothesis" &&
    operation.statement.id === operation.equalityHypothesisId
  ) {
    return notApplicable(state, "An equality cannot consume itself as its own rewrite target.");
  }

  const statementHypothesisIndex =
    operation.statement.kind === "hypothesis"
      ? findHypothesisIndex(target.entry.sequent, operation.statement.id)
      : -1;
  if (operation.statement.kind === "hypothesis" && statementHypothesisIndex < 0) {
    return missingHypothesis(state);
  }
  const expression =
    operation.statement.kind === "conclusion"
      ? target.entry.sequent.conclusion.expression
      : (target.entry.sequent.context.hypotheses[statementHypothesisIndex] as Hypothesis).statement
          .expression;
  const source = equalityOperands[operation.direction === "forward" ? 0 : 1] as PlainMathJson;
  const replacement = equalityOperands[operation.direction === "forward" ? 1 : 0] as PlainMathJson;
  if (mathJsonEquals(source, replacement)) {
    return notApplicable(state, "The equality does not provide a distinct replacement.");
  }

  const occurrence = occurrenceAtPath(expression, operation.path, operators);
  if (occurrence === undefined) {
    return internalFailure(state, "invalid-path", "The rewrite path is not a term occurrence.");
  }
  if (!mathJsonEquals(occurrence.fragment, source)) {
    return notApplicable(state, "The selected occurrence does not match the equality source.");
  }
  const replacementFree = new Set(freeSymbolNames(replacement, { operators }));
  if ([...occurrence.boundSymbols].some((symbol) => replacementFree.has(symbol))) {
    return notApplicable(
      state,
      "The rewrite would capture a free symbol under an enclosing binder.",
    );
  }
  const rewritten = replaceExpressionAtPath(expression, operation.path, replacement);
  if (rewritten === undefined) return replacementFailed(state);

  const replacementTarget: TargetEntry =
    operation.statement.kind === "conclusion"
      ? {
          ...target.entry,
          sequent: { ...target.entry.sequent, conclusion: { expression: rewritten } },
        }
      : replaceHypothesis(target.entry, statementHypothesisIndex, [
          hypothesis(operation.statement.id, rewritten),
        ]);
  return success(
    replaceTarget(state, operation.target, target.index, [replacementTarget]),
    "equivalence",
  );
}

type ExpressionOccurrence = Readonly<{
  fragment: PlainMathJson;
  boundSymbols: ReadonlySet<string>;
}>;

function occurrenceAtPath(
  expression: PlainMathJson,
  path: readonly number[],
  operators: readonly OperatorDeclaration[],
): ExpressionOccurrence | undefined {
  let current = expression;
  const boundSymbols = new Set<string>();
  for (const operandIndex of path) {
    const parts = functionParts(current);
    if (parts === undefined) return undefined;
    const binder =
      parts.operator === "ForAll" || parts.operator === "Exists"
        ? BUILTIN_BINDER_SPECIFICATIONS[parts.operator]
        : operators.find((candidate) => candidate.symbol === parts.operator)?.binder;
    if (binder?.boundOperands.includes(operandIndex)) return undefined;
    if (binder?.scopedOperands.includes(operandIndex)) {
      binder.boundOperands.forEach((boundIndex) => {
        const name = symbolValue(parts.operands[boundIndex] as PlainMathJson);
        if (name !== undefined) boundSymbols.add(name);
      });
    }
    const next = parts.operands[operandIndex];
    if (next === undefined) return undefined;
    current = next;
  }
  return { fragment: current, boundSymbols };
}

function replaceExpressionAtPath(
  expression: PlainMathJson,
  path: readonly number[],
  replacement: PlainMathJson,
): PlainMathJson | undefined {
  if (path.length === 0) return structuredClone(replacement);
  const [operandIndex, ...rest] = path;
  if (operandIndex === undefined) return undefined;
  const parts = functionParts(expression);
  const operand = parts?.operands[operandIndex];
  if (parts === undefined || operand === undefined) return undefined;
  const replacedOperand = replaceExpressionAtPath(operand, rest, replacement);
  if (replacedOperand === undefined) return undefined;
  const operands = [...parts.operands];
  operands[operandIndex] = replacedOperand;
  return parts.rebuild(operands);
}

function logicalOperands(
  expression: PlainMathJson,
  operator: "And" | "Or" | "Implies",
): readonly PlainMathJson[] | undefined {
  return operatorOperands(expression, operator);
}

type FunctionParts = Readonly<{
  operator: string;
  operands: readonly PlainMathJson[];
  rebuild: (operands: readonly PlainMathJson[]) => PlainMathJson;
}>;

function functionParts(expression: PlainMathJson): FunctionParts | undefined {
  if (Array.isArray(expression)) {
    const operator = expression[0];
    return typeof operator === "string"
      ? {
          operator,
          operands: expression.slice(1) as readonly PlainMathJson[],
          rebuild: (operands) => [operator, ...operands],
        }
      : undefined;
  }
  if (typeof expression !== "object" || expression === null || !("fn" in expression)) {
    return undefined;
  }
  const fn = expression.fn;
  const operator = fn[0];
  return typeof operator === "string"
    ? {
        operator,
        operands: fn.slice(1),
        rebuild: (operands) => ({ ...expression, fn: [operator, ...operands] }),
      }
    : undefined;
}

function operatorOperands(
  expression: PlainMathJson,
  operator: string,
): readonly PlainMathJson[] | undefined {
  const parts = functionParts(expression);
  return parts?.operator === operator ? parts.operands : undefined;
}

function symbolValue(expression: PlainMathJson): string | undefined {
  if (typeof expression === "string") return expression;
  return typeof expression === "object" &&
    expression !== null &&
    !Array.isArray(expression) &&
    "sym" in expression
    ? expression.sym
    : undefined;
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
): Extract<InternalResult, { ok: true }> {
  return { ok: true, state, transitionClass };
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

function parseKernelOperation(value: unknown): RuntimeParseResult<KernelOperation> {
  if (!isStrictRecord(value) || typeof value.kind !== "string") {
    return runtimeFailure("A kernel operation must be a strict discriminated object.", []);
  }

  const extraKeys: Readonly<Record<KernelOperationKind, readonly string[]>> = {
    "close-by-hypothesis": ["hypothesisId"],
    "close-true": [],
    "close-false-hypothesis": ["hypothesisId"],
    "introduce-implication": ["hypothesisId"],
    "introduce-negation": ["hypothesisId"],
    "split-goal-conjunction": ["childIds"],
    "choose-goal-disjunct": ["disjunctIndex"],
    "expand-hypothesis-conjunction": ["hypothesisId", "expandedHypothesisIds"],
    "split-hypothesis-disjunction": ["hypothesisId", "childIds", "branchHypothesisIds"],
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
  };
  if (!(KERNEL_OPERATION_KINDS as readonly string[]).includes(value.kind)) {
    return runtimeFailure("The kernel operation kind is unknown.", ["kind"]);
  }
  const extras = extraKeys[value.kind as KernelOperationKind];
  if (!hasExactKeys(value, ["kind", "expectedStateId", "resultStateId", "target", ...extras])) {
    return runtimeFailure("The kernel operation contains missing or unknown fields.", []);
  }

  if (!proofStateIdSchema.safeParse(value.expectedStateId).success) {
    return runtimeFailure("The expected state ID is invalid.", ["expectedStateId"]);
  }
  if (!proofStateIdSchema.safeParse(value.resultStateId).success) {
    return runtimeFailure("The result state ID is invalid.", ["resultStateId"]);
  }
  const target = transitionTargetSchema.safeParse(value.target);
  if (!target.success) {
    return runtimeFailure(target.error.issues[0]?.message ?? "The target is invalid.", ["target"]);
  }

  for (const field of [
    "hypothesisId",
    "implicationHypothesisId",
    "antecedentHypothesisId",
    "resultHypothesisId",
    "equalityHypothesisId",
  ] as const) {
    if (field in value && !statementIdSchema.safeParse(value[field]).success) {
      return runtimeFailure("The hypothesis ID is invalid.", [field]);
    }
  }
  for (const field of ["childIds", "expandedHypothesisIds", "branchHypothesisIds"] as const) {
    if (field in value && !isStatementIdArray(value[field])) {
      return runtimeFailure("An ID list requires at least two stable, dense IDs.", [field]);
    }
  }
  if (
    "disjunctIndex" in value &&
    (typeof value.disjunctIndex !== "number" ||
      !Number.isInteger(value.disjunctIndex) ||
      value.disjunctIndex < 0)
  ) {
    return runtimeFailure("A disjunct index must be a nonnegative integer.", ["disjunctIndex"]);
  }
  for (const field of ["term", "witness"] as const) {
    if (field in value && !plainMathJsonSchema.safeParse(value[field]).success) {
      return runtimeFailure("A term must be serializable plain MathJSON.", [field]);
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

  const common: OperationBase = {
    expectedStateId: proofStateIdSchema.parse(value.expectedStateId),
    resultStateId: proofStateIdSchema.parse(value.resultStateId),
    target: target.data,
  };
  switch (value.kind) {
    case "close-by-hypothesis":
    case "close-false-hypothesis":
    case "introduce-implication":
    case "introduce-negation":
      return {
        success: true,
        data: {
          ...common,
          kind: value.kind,
          hypothesisId: statementIdSchema.parse(value.hypothesisId),
        },
      };
    case "close-true":
    case "introduce-universal":
      return { success: true, data: { ...common, kind: value.kind } };
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
          direction: value.direction as "forward" | "backward",
        },
      };
  }
  return runtimeFailure("The kernel operation kind is unknown.", ["kind"]);
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

function isStatementIdArray(value: unknown): value is readonly StatementId[] {
  if (!Array.isArray(value) || value.length < 2) return false;
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

function isStrictRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.enumerable && "value" in descriptor,
  );
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return false;
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function runtimeFailure<T>(message: string, path: readonly PropertyKey[]): RuntimeParseResult<T> {
  return { success: false, error: { issues: [{ message, path }] } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The kernel environment is invalid.";
}
