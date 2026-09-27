/**
 * Construction tasks and placeholder metavariables (refinement §5).
 *
 * A placeholder is a registered operator of the state's construction task. Its
 * occurrences apply it to the task's allowed scope declarations, Skolem style,
 * so an occurrence shows exactly what the choice may depend on and later
 * variables (introduced universals, unpacked witnesses) can never leak into it.
 * Every other kernel rule treats an open placeholder as an uninterpreted
 * operator, so each rule's transition class holds for every interpretation and
 * therefore for the state read as "there is a choice of every open placeholder
 * such that all targets hold".
 *
 * Requirements and candidates are records. No requirement ever becomes a
 * hypothesis; necessary and heuristic requirements never become obligations
 * and never close anything. Resolution substitutes the chosen candidate through
 * every dependent statement (goals, obligations, open task records) and turns
 * the remaining sufficient requirements into obligations; targets are never
 * closed by resolution.
 */
import {
  CONSTRUCTION_REQUIREMENT_ROLES,
  constructionAttemptIdSchema,
  constructionCandidateIdSchema,
  constructionDependencyClosure,
  constructionPlaceholderOperator,
  constructionPlaceholderOperators,
  constructionRequirementEvidenceSchema,
  constructionRequirementIdSchema,
  constructionTaskIdSchema,
  createStatementViewSchema,
  freeSymbolNames,
  isOpenConstructionTask,
  plainMathJsonSchema,
  requirementEvidenceMatchesRole,
  sortSchema,
  statementIdSchema,
  substituteMathJson,
  RESERVED_BUILTIN_SYMBOLS,
  type ConstructionAttemptId,
  type ConstructionCandidateId,
  type ConstructionRequirement,
  type ConstructionRequirementEvidence,
  type ConstructionRequirementId,
  type ConstructionRequirementRole,
  type ConstructionTask,
  type ConstructionTaskId,
  type ContextualSequent,
  type Goal,
  type Obligation,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofContext,
  type ProofState,
  type Sort,
  type StatementId,
} from "@proof/mathjson-model";
import { alphaEquivalentWithOperators } from "./alpha-equivalence";
import { functionParts, readBuiltinQuantifier } from "./expression";
import type { KernelDiagnosticCode, OperationBase, TransitionTarget } from "./index";
import { collectSymbolNames, termHasSortInContext } from "./results";
import { denseArrayValues, hasExactKeys, isStrictRecord } from "./runtime";

export const CONSTRUCTION_OPERATION_KINDS = [
  "introduce-placeholder",
  "add-requirement",
  "add-candidate",
  "resolve-placeholder",
  "abandon-placeholder",
] as const;
export type ConstructionOperationKind = (typeof CONSTRUCTION_OPERATION_KINDS)[number];

/**
 * `existential-goal` replaces the witness of the target's existential
 * conclusion; the binder must be an untyped symbol whose sort a context
 * declaration supplies. `auxiliary-request` records a new task of the given
 * sort in the target's scope without changing the target; `requestedBy` names
 * an open task that becomes allowed to depend on it.
 */
export type PlaceholderOrigin =
  | Readonly<{ kind: "existential-goal" }>
  | Readonly<{
      kind: "auxiliary-request";
      sort: Sort;
      description: string;
      requestedBy?: ConstructionTaskId;
    }>;

export type ConstructionOperation =
  | (OperationBase &
      Readonly<{
        kind: "introduce-placeholder";
        taskId: ConstructionTaskId;
        /** Fresh symbol of the registered placeholder operator. */
        symbol: string;
        displayName: string;
        origin: PlaceholderOrigin;
        /** Declared symbols of the target's context the construction may depend on, in order. */
        dependencies: readonly string[];
        /** Open tasks whose placeholders the construction may use. */
        allowedTasks: readonly ConstructionTaskId[];
      }>)
  | (OperationBase &
      Readonly<{
        kind: "add-requirement";
        taskId: ConstructionTaskId;
        requirementId: ConstructionRequirementId;
        role: ConstructionRequirementRole;
        /** A proposition over the task's scope that mentions its placeholder. */
        proposition: PlainMathJson;
        evidence: ConstructionRequirementEvidence;
        attemptId: ConstructionAttemptId;
      }>)
  | (OperationBase &
      Readonly<{
        kind: "add-candidate";
        taskId: ConstructionTaskId;
        candidateId: ConstructionCandidateId;
        value: PlainMathJson;
        attemptId: ConstructionAttemptId;
      }>)
  | (OperationBase &
      Readonly<{
        kind: "resolve-placeholder";
        taskId: ConstructionTaskId;
        candidateId: ConstructionCandidateId;
        /** One fresh obligation ID per remaining sufficient requirement, in requirement order. */
        obligationIds: readonly StatementId[];
        attemptId: ConstructionAttemptId;
      }>)
  | (OperationBase &
      Readonly<{
        kind: "abandon-placeholder";
        taskId: ConstructionTaskId;
        attemptId: ConstructionAttemptId;
      }>);

export type ConstructionOutcome =
  | Readonly<{
      ok: true;
      state: ProofState;
      transitionClass: "equivalence" | "strengthening";
    }>
  | Readonly<{ ok: false; code: KernelDiagnosticCode; message: string }>;

type Op<K extends ConstructionOperationKind> = Extract<ConstructionOperation, { kind: K }>;

function fail(code: KernelDiagnosticCode, message: string): ConstructionOutcome {
  return { ok: false, code, message };
}

function tasksOf(state: ProofState): readonly ConstructionTask[] {
  return state.constructions ?? [];
}

function findTarget(state: ProofState, target: TransitionTarget): Goal | Obligation | undefined {
  const collection: readonly (Goal | Obligation)[] =
    target.kind === "goal" ? state.goals : state.obligations;
  return collection.find((entry) => entry.id === target.id);
}

/** An open task, or a diagnostic for a missing or closed one. */
function openTask(
  state: ProofState,
  taskId: ConstructionTaskId,
): ConstructionTask | Extract<ConstructionOutcome, { ok: false }> {
  const task = tasksOf(state).find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    return { ok: false, code: "task-not-found", message: `No construction task ${taskId}.` };
  }
  if (!isOpenConstructionTask(task)) {
    return {
      ok: false,
      code: "task-not-open",
      message: `Construction task ${taskId} is already ${task.status}.`,
    };
  }
  return task;
}

function isFailure(value: unknown): value is Extract<ConstructionOutcome, { ok: false }> {
  return typeof value === "object" && value !== null && "ok" in value;
}

function replaceTask(state: ProofState, task: ConstructionTask): ProofState {
  return {
    ...state,
    constructions: tasksOf(state).map((candidate) => (candidate.id === task.id ? task : candidate)),
  };
}

/** The status-independent fields of a task, for building a record with a new status. */
function taskBase(task: ConstructionTask) {
  return {
    id: task.id,
    symbol: task.symbol,
    displayName: task.displayName,
    sort: task.sort,
    origin: task.origin,
    scope: task.scope,
    allowedDependencies: task.allowedDependencies,
    requirements: task.requirements,
    candidates: task.candidates,
  };
}

/** Every expression that can mention a placeholder, for symbol-use checks. */
function stateExpressions(state: ProofState): readonly PlainMathJson[] {
  const expressions: PlainMathJson[] = [];
  const context = (proofContext: ProofContext) => {
    proofContext.hypotheses.forEach((entry) => expressions.push(entry.statement.expression));
    proofContext.declarations.forEach((declaration) => {
      if (
        declaration.role === "construction-metavariable" &&
        declaration.resolution.status === "resolved"
      ) {
        expressions.push(declaration.resolution.value);
      }
    });
  };
  [...state.goals, ...state.obligations].forEach((entry) => {
    context(entry.sequent.context);
    expressions.push(entry.sequent.conclusion.expression);
  });
  (state.assumptions ?? []).forEach((assumption) =>
    expressions.push(assumption.statement.expression),
  );
  tasksOf(state).forEach((task) => {
    context(task.scope);
    task.requirements.forEach((requirement) => expressions.push(requirement.statement.expression));
    task.candidates.forEach((candidate) => expressions.push(candidate.value));
    if (task.origin.kind === "existential-goal") expressions.push(task.origin.statement.expression);
  });
  return expressions;
}

function symbolsInUse(state: ProofState): ReadonlySet<string> {
  const names = new Set<string>();
  stateExpressions(state).forEach((expression) => collectSymbolNames(expression, names));
  const declarations = [
    ...[...state.goals, ...state.obligations].flatMap(
      (entry) => entry.sequent.context.declarations,
    ),
    ...(state.assumptions ?? []).flatMap((assumption) => assumption.declarations),
    ...tasksOf(state).flatMap((task) => task.scope.declarations),
  ];
  declarations.forEach((declaration) => names.add(declaration.symbol));
  tasksOf(state).forEach((task) => names.add(task.symbol));
  return names;
}

function mentions(expression: PlainMathJson, symbol: string): boolean {
  const names = new Set<string>();
  collectSymbolNames(expression, names);
  return names.has(symbol);
}

/** The first open placeholder a sequent mentions, if any. */
export function mentionsOpenPlaceholder(
  state: ProofState,
  sequent: ContextualSequent,
): string | undefined {
  const open = tasksOf(state).filter(isOpenConstructionTask);
  const expressions = [
    sequent.conclusion.expression,
    ...sequent.context.hypotheses.map((entry) => entry.statement.expression),
  ];
  return open.find((task) => expressions.some((expression) => mentions(expression, task.symbol)))
    ?.symbol;
}

/** The placeholder applied to its parameters, as it occurs in statements. */
function placeholderOccurrence(task: ConstructionTask): PlainMathJson {
  return [task.symbol, ...task.allowedDependencies.declarations];
}

/**
 * Replace every occurrence `[symbol, a1, …, an]` by `value[p1 := a1, …, pn := an]`,
 * capture-avoiding. The value's other free symbols are operators, which no
 * binder can capture. Returns undefined when an occurrence has the wrong arity
 * or an instantiation fails.
 */
export function substitutePlaceholder(
  expression: PlainMathJson,
  symbol: string,
  parameters: readonly string[],
  value: PlainMathJson,
  operators: readonly OperatorDeclaration[],
): PlainMathJson | undefined {
  const parts = functionParts(expression);
  if (parts === undefined) return structuredClone(expression);
  const operands: PlainMathJson[] = [];
  for (const operand of parts.operands) {
    const replaced = substitutePlaceholder(operand, symbol, parameters, value, operators);
    if (replaced === undefined) return undefined;
    operands.push(replaced);
  }
  if (parts.operator !== symbol) return parts.rebuild(operands);
  if (operands.length !== parameters.length) return undefined;
  if (parameters.length === 0) return structuredClone(value);
  const instantiated = substituteMathJson(
    value,
    parameters.map((parameter, index) => ({
      symbol: parameter,
      replacement: operands[index] as PlainMathJson,
    })),
    { operators },
  );
  return instantiated.ok ? instantiated.expression : undefined;
}

/**
 * Scope, dependency, and signature check for a construction value. Its free
 * symbols must be allowed declarations or placeholders of tasks the task may
 * reach through allowed-dependency edges (transitively); a placeholder that
 * reaches back to the task, or the task's own, is a cycle. The value must have
 * the task's sort using only the allowed declarations.
 */
function checkConstructionValue(
  state: ProofState,
  task: ConstructionTask,
  value: PlainMathJson,
  environmentOperators: readonly OperatorDeclaration[],
): Extract<ConstructionOutcome, { ok: false }> | undefined {
  const tasks = tasksOf(state);
  const closures = constructionDependencyClosure(tasks);
  if (closures === undefined) {
    return { ok: false, code: "cyclic-dependency", message: "Task dependencies are cyclic." };
  }
  const reachable = closures.get(task.id) ?? new Set<string>();
  const bySymbol = new Map(tasks.map((candidate) => [candidate.symbol, candidate]));
  const allowed = new Set(task.allowedDependencies.declarations);
  const scope = new Set(task.scope.declarations.map((declaration) => declaration.symbol));
  for (const symbol of freeSymbolNames(value, { operators: environmentOperators })) {
    const used = bySymbol.get(symbol);
    if (used !== undefined) {
      if (used.id === task.id || closures.get(used.id)?.has(task.id) === true) {
        return {
          ok: false,
          code: "cyclic-dependency",
          message: `Using placeholder ${symbol} would make construction ${task.id} depend on itself.`,
        };
      }
      if (!reachable.has(used.id)) {
        return {
          ok: false,
          code: "illegal-dependency",
          message: `Construction ${task.id} is not allowed to depend on task ${used.id}.`,
        };
      }
      if (!isOpenConstructionTask(used)) {
        return {
          ok: false,
          code: "illegal-dependency",
          message: `Placeholder ${symbol} belongs to a task that is already ${used.status}.`,
        };
      }
      continue;
    }
    if (allowed.has(symbol)) continue;
    return {
      ok: false,
      code: "illegal-dependency",
      message: scope.has(symbol)
        ? `${symbol} is in the task's scope but is not an allowed dependency.`
        : `${symbol} is outside the construction task's scope.`,
    };
  }
  const parameters = task.scope.declarations.filter((declaration) =>
    allowed.has(declaration.symbol),
  );
  const operators = [...environmentOperators, ...constructionPlaceholderOperators(state)];
  if (!termHasSortInContext(value, task.sort, parameters, operators)) {
    return {
      ok: false,
      code: "signature-mismatch",
      message: "The construction value does not have the task's sort.",
    };
  }
  return undefined;
}

/**
 * Introduce a construction task. For an existential goal the witness is
 * replaced by the placeholder applied to the dependencies. That is an
 * equivalence (Skolemization, by choice) when the dependencies include every
 * declared symbol free in the sequent, and a strengthening otherwise, since the
 * choice may then not vary with the excluded symbols. An auxiliary request
 * leaves the target unchanged (equivalence).
 */
export function introducePlaceholder(
  state: ProofState,
  operation: Op<"introduce-placeholder">,
  environmentOperators: readonly OperatorDeclaration[],
): ConstructionOutcome {
  const tasks = tasksOf(state);
  if (tasks.some((task) => task.id === operation.taskId)) {
    return fail("identifier-collision", `The task ID is not fresh: ${operation.taskId}.`);
  }
  if (
    RESERVED_BUILTIN_SYMBOLS.has(operation.symbol) ||
    environmentOperators.some((operator) => operator.symbol === operation.symbol) ||
    symbolsInUse(state).has(operation.symbol)
  ) {
    return fail(
      "identifier-collision",
      `The placeholder symbol is not fresh: ${operation.symbol}.`,
    );
  }
  const entry = findTarget(state, operation.target);
  if (entry === undefined) return fail("target-not-found", "The target does not exist.");
  const sequent = entry.sequent;

  const dependencies = new Set<string>();
  for (const symbol of operation.dependencies) {
    const declaration = sequent.context.declarations.find(
      (candidate) => candidate.symbol === symbol,
    );
    if (
      dependencies.has(symbol) ||
      (declaration?.role !== "universal-parameter" && declaration?.role !== "local-witness")
    ) {
      return fail(
        "illegal-dependency",
        `${symbol} is not a distinct variable declared in the target's context.`,
      );
    }
    dependencies.add(symbol);
  }
  const allowedTasks = new Set<string>();
  for (const id of operation.allowedTasks) {
    const task = openTask(state, id);
    if (isFailure(task)) return task;
    if (allowedTasks.has(id)) {
      return fail("illegal-dependency", `Task ${id} is listed twice.`);
    }
    allowedTasks.add(id);
  }

  let sort: Sort;
  let quantifier: ReturnType<typeof readBuiltinQuantifier>;
  let requester: ConstructionTask | undefined;
  if (operation.origin.kind === "existential-goal") {
    quantifier = readBuiltinQuantifier(sequent.conclusion.expression, "Exists");
    if (quantifier === undefined) {
      return fail("rule-not-applicable", "The target conclusion is not existential.");
    }
    const bound = quantifier.symbol;
    const declaration = sequent.context.declarations.find(
      (candidate) => candidate.symbol === bound,
    );
    if (declaration === undefined) {
      return fail(
        "rule-not-applicable",
        "The existential binder requires a declaration giving its sort in the local context.",
      );
    }
    if (dependencies.has(bound)) {
      return fail(
        "illegal-dependency",
        "A construction cannot depend on the symbol its own existential binds.",
      );
    }
    sort = declaration.sort;
  } else {
    sort = operation.origin.sort;
    if (operation.origin.requestedBy !== undefined) {
      const found = openTask(state, operation.origin.requestedBy);
      if (isFailure(found)) return found;
      requester = found;
    }
  }

  const task: ConstructionTask = {
    id: operation.taskId,
    symbol: operation.symbol,
    displayName: operation.displayName,
    sort: structuredClone(sort),
    origin:
      operation.origin.kind === "existential-goal"
        ? {
            kind: "existential-goal",
            target: { kind: operation.target.kind, id: operation.target.id },
            statement: { expression: structuredClone(sequent.conclusion.expression) },
          }
        : {
            kind: "auxiliary-request",
            description: operation.origin.description,
            ...(operation.origin.requestedBy === undefined
              ? {}
              : { requestedBy: operation.origin.requestedBy }),
          },
    scope: structuredClone(sequent.context),
    allowedDependencies: {
      declarations: [...operation.dependencies],
      tasks: [...operation.allowedTasks],
    },
    requirements: [],
    candidates: [],
    status: "unresolved",
  };
  const operator = constructionPlaceholderOperator(task);
  if (operator === undefined) {
    return fail("illegal-dependency", "The placeholder's parameters are not in its scope.");
  }

  const nextTasks = [
    ...tasks.map((candidate) =>
      requester !== undefined && candidate.id === requester.id
        ? {
            ...candidate,
            allowedDependencies: {
              ...candidate.allowedDependencies,
              tasks: [...candidate.allowedDependencies.tasks, task.id],
            },
          }
        : candidate,
    ),
    task,
  ];
  if (constructionDependencyClosure(nextTasks) === undefined) {
    return fail(
      "cyclic-dependency",
      "The requesting task would depend on a task that may depend on it.",
    );
  }
  const withTask: ProofState = { ...state, constructions: nextTasks };
  if (quantifier === undefined) {
    return { ok: true, state: withTask, transitionClass: "equivalence" };
  }

  const operators = [...environmentOperators, ...constructionPlaceholderOperators(state), operator];
  const instantiated = substituteMathJson(
    quantifier.body,
    [{ symbol: quantifier.symbol, replacement: placeholderOccurrence(task) }],
    { operators },
  );
  if (!instantiated.ok) {
    return fail("replacement-failed", "The placeholder could not replace the witness safely.");
  }
  const replaced = {
    ...entry,
    sequent: { ...sequent, conclusion: { expression: instantiated.expression } },
  };
  const collection = operation.target.kind === "goal" ? "goals" : "obligations";
  const next: ProofState = {
    ...withTask,
    [collection]: (withTask[collection] as readonly (Goal | Obligation)[]).map((candidate) =>
      candidate.id === entry.id ? replaced : candidate,
    ),
  };

  const declared = new Set(sequent.context.declarations.map((declaration) => declaration.symbol));
  const occurring = [
    sequent.conclusion.expression,
    ...sequent.context.hypotheses.map((hypothesis) => hypothesis.statement.expression),
  ].flatMap((expression) =>
    freeSymbolNames(expression, { operators }).filter((symbol) => declared.has(symbol)),
  );
  const complete = occurring.every((symbol) => dependencies.has(symbol));
  return { ok: true, state: next, transitionClass: complete ? "equivalence" : "strengthening" };
}

/**
 * Record a requirement. It is checked against its task's scope and the
 * role/evidence rule; `target` evidence must name an open target whose
 * conclusion is the requirement up to renaming of bound symbols. The proof
 * obligations are unchanged, so the transition is an equivalence.
 */
export function addRequirement(
  state: ProofState,
  operation: Op<"add-requirement">,
  environmentOperators: readonly OperatorDeclaration[],
): ConstructionOutcome {
  const task = openTask(state, operation.taskId);
  if (isFailure(task)) return task;
  if (task.requirements.some((requirement) => requirement.id === operation.requirementId)) {
    return fail(
      "identifier-collision",
      `The requirement ID is not fresh: ${operation.requirementId}.`,
    );
  }
  if (!requirementEvidenceMatchesRole(operation)) {
    return fail(
      "invalid-requirement",
      "A heuristic requirement has no evidence; a necessary one needs an attestation; a sufficient one needs an attestation or an open target.",
    );
  }
  const operators = [...environmentOperators, ...constructionPlaceholderOperators(state)];
  let wellFormed: boolean;
  try {
    wellFormed = createStatementViewSchema({
      declarations: task.scope.declarations,
      operators,
    }).safeParse({ expression: operation.proposition }).success;
  } catch {
    wellFormed = false;
  }
  if (!wellFormed) {
    return fail(
      "invalid-proposition",
      "The requirement is not a well-scoped, well-sorted proposition in the task's scope.",
    );
  }
  if (!mentions(operation.proposition, task.symbol)) {
    return fail("invalid-requirement", "A requirement must mention its task's placeholder.");
  }
  if (operation.evidence.kind === "target") {
    const evidenceTarget = findTarget(state, operation.evidence.target);
    if (evidenceTarget === undefined) {
      return fail("target-not-found", "The evidence target does not exist.");
    }
    if (
      !alphaEquivalentWithOperators(
        evidenceTarget.sequent.conclusion.expression,
        operation.proposition,
        operators,
      )
    ) {
      return fail(
        "invalid-requirement",
        "The requirement is not the conclusion of the evidence target.",
      );
    }
  }
  const requirement: ConstructionRequirement = {
    id: operation.requirementId,
    role: operation.role,
    statement: { expression: structuredClone(operation.proposition) },
    evidence: structuredClone(operation.evidence),
    attemptId: operation.attemptId,
  };
  const base = taskBase(task);
  return {
    ok: true,
    state: replaceTask(state, {
      ...base,
      requirements: [...task.requirements, requirement],
      status: "partially-specified",
    }),
    transitionClass: "equivalence",
  };
}

/** Record a candidate after the scope, dependency, and signature checks. */
export function addCandidate(
  state: ProofState,
  operation: Op<"add-candidate">,
  environmentOperators: readonly OperatorDeclaration[],
): ConstructionOutcome {
  const task = openTask(state, operation.taskId);
  if (isFailure(task)) return task;
  if (task.candidates.some((candidate) => candidate.id === operation.candidateId)) {
    return fail("identifier-collision", `The candidate ID is not fresh: ${operation.candidateId}.`);
  }
  const invalid = checkConstructionValue(state, task, operation.value, environmentOperators);
  if (invalid !== undefined) return invalid;
  return {
    ok: true,
    state: replaceTask(state, {
      ...task,
      candidates: [
        ...task.candidates,
        {
          id: operation.candidateId,
          value: structuredClone(operation.value),
          attemptId: operation.attemptId,
        },
      ],
    }),
    transitionClass: "equivalence",
  };
}

/**
 * Sufficient requirements the state does not already track: those without
 * `target` evidence. A target-tracked requirement is (or was) a target of the
 * state itself, which the substitution handles.
 */
function remainingSufficientRequirements(
  task: ConstructionTask,
): readonly ConstructionRequirement[] {
  return task.requirements.filter(
    (requirement) => requirement.role === "sufficient" && requirement.evidence.kind !== "target",
  );
}

/**
 * Resolve a task with one of its candidates: recheck scope, dependencies, and
 * signature; substitute through every goal and obligation and through the
 * records of the other open tasks; and turn each remaining sufficient
 * requirement into an obligation in the task's scope. No target is closed and
 * no requirement becomes a hypothesis. Proving the result proves the input
 * with the chosen construction, so the transition is a strengthening.
 */
export function resolvePlaceholder(
  state: ProofState,
  operation: Op<"resolve-placeholder">,
  environmentOperators: readonly OperatorDeclaration[],
): ConstructionOutcome {
  const task = openTask(state, operation.taskId);
  if (isFailure(task)) return task;
  const candidate = task.candidates.find((entry) => entry.id === operation.candidateId);
  if (candidate === undefined) {
    return fail(
      "candidate-not-found",
      `Task ${task.id} has no candidate ${operation.candidateId}.`,
    );
  }
  const invalid = checkConstructionValue(state, task, candidate.value, environmentOperators);
  if (invalid !== undefined) return invalid;
  const remaining = remainingSufficientRequirements(task);
  if (operation.obligationIds.length !== remaining.length) {
    return fail(
      "arity-mismatch",
      "Supply one obligation ID per remaining sufficient requirement, in requirement order.",
    );
  }
  const existing = new Set<string>([...state.goals, ...state.obligations].map((entry) => entry.id));
  const supplied = new Set<string>();
  for (const id of operation.obligationIds) {
    if (existing.has(id) || supplied.has(id)) {
      return fail("identifier-collision", `The supplied statement ID is not fresh: ${id}.`);
    }
    supplied.add(id);
  }

  const operators = [...environmentOperators, ...constructionPlaceholderOperators(state)];
  const parameters = task.allowedDependencies.declarations;
  let failed = false;
  const substitute = (expression: PlainMathJson): PlainMathJson => {
    const result = substitutePlaceholder(
      expression,
      task.symbol,
      parameters,
      candidate.value,
      operators,
    );
    if (result === undefined) {
      failed = true;
      return expression;
    }
    return result;
  };
  const substituteContext = (proofContext: ProofContext): ProofContext => ({
    declarations: proofContext.declarations.map((declaration) =>
      declaration.role === "construction-metavariable" &&
      declaration.resolution.status === "resolved"
        ? {
            ...declaration,
            resolution: { status: "resolved", value: substitute(declaration.resolution.value) },
          }
        : declaration,
    ),
    hypotheses: proofContext.hypotheses.map((hypothesis) => ({
      ...hypothesis,
      statement: { expression: substitute(hypothesis.statement.expression) },
    })),
  });
  const substituteEntry = <T extends Goal | Obligation>(entry: T): T => ({
    ...entry,
    sequent: {
      context: substituteContext(entry.sequent.context),
      conclusion: { expression: substitute(entry.sequent.conclusion.expression) },
    },
  });

  const obligations: Obligation[] = remaining.map((requirement, index) => ({
    id: operation.obligationIds[index] as StatementId,
    provenance: {
      kind: "construction-requirement",
      taskId: task.id,
      requirementId: requirement.id,
    },
    sequent: {
      context: substituteContext(task.scope),
      conclusion: { expression: substitute(requirement.statement.expression) },
    },
  }));
  const constructions = tasksOf(state).map((entry): ConstructionTask => {
    if (entry.id === task.id) {
      const base = taskBase(task);
      return {
        ...base,
        status: "resolved",
        resolution: {
          candidateId: candidate.id,
          attemptId: operation.attemptId,
          obligationIds: [...operation.obligationIds],
        },
      };
    }
    if (!isOpenConstructionTask(entry)) return entry;
    return {
      ...entry,
      scope: substituteContext(entry.scope),
      requirements: entry.requirements.map((requirement) => ({
        ...requirement,
        statement: { expression: substitute(requirement.statement.expression) },
      })),
      candidates: entry.candidates.map((other) => ({ ...other, value: substitute(other.value) })),
    };
  });
  const next: ProofState = {
    ...state,
    goals: state.goals.map(substituteEntry),
    obligations: [...state.obligations.map(substituteEntry), ...obligations],
    constructions,
  };
  if (failed) {
    return fail(
      "replacement-failed",
      "The construction could not be substituted into a dependent statement safely.",
    );
  }
  return { ok: true, state: next, transitionClass: "strengthening" };
}

/**
 * Abandon an open task whose placeholder no longer occurs in any goal,
 * obligation, or open task record. The proof content is unchanged
 * (equivalence); the task record is kept as history. Returning to the
 * existential goal is done by backtracking to the state before its
 * introduction, which the discovery tree preserves.
 */
export function abandonPlaceholder(
  state: ProofState,
  operation: Op<"abandon-placeholder">,
): ConstructionOutcome {
  const task = openTask(state, operation.taskId);
  if (isFailure(task)) return task;
  const others: ProofState = {
    ...state,
    constructions: tasksOf(state).filter(
      (entry) => entry.id !== task.id && isOpenConstructionTask(entry),
    ),
  };
  if (stateExpressions(others).some((expression) => mentions(expression, task.symbol))) {
    return fail(
      "placeholder-in-use",
      `Placeholder ${task.symbol} still occurs in the proof state; it cannot be abandoned.`,
    );
  }
  const base = taskBase(task);
  return {
    ok: true,
    state: replaceTask(state, {
      ...base,
      status: "abandoned",
      abandonment: { attemptId: operation.attemptId },
    }),
    transitionClass: "equivalence",
  };
}

type ConstructionParseResult =
  | Readonly<{ ok: true; operation: ConstructionOperation }>
  | Readonly<{ ok: false; message: string; path: readonly PropertyKey[] }>;

const CONSTRUCTION_FIELDS: Readonly<Record<ConstructionOperationKind, readonly string[]>> = {
  "introduce-placeholder": [
    "taskId",
    "symbol",
    "displayName",
    "origin",
    "dependencies",
    "allowedTasks",
  ],
  "add-requirement": ["taskId", "requirementId", "role", "proposition", "evidence", "attemptId"],
  "add-candidate": ["taskId", "candidateId", "value", "attemptId"],
  "resolve-placeholder": ["taskId", "candidateId", "obligationIds", "attemptId"],
  "abandon-placeholder": ["taskId", "attemptId"],
};

/** Recursively plain data: strict records, dense arrays, and primitives, with no accessors. */
function isPlainData(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) {
    const entries = denseArrayValues(value);
    return entries !== undefined && entries.every((entry) => isPlainData(entry, depth + 1));
  }
  return (
    isStrictRecord(value) && Object.values(value).every((entry) => isPlainData(entry, depth + 1))
  );
}

function parseFailure(message: string, path: readonly PropertyKey[]): ConstructionParseResult {
  return { ok: false, message, path };
}

function parseSymbols(value: unknown): readonly string[] | undefined {
  const entries = denseArrayValues(value);
  return entries?.every((entry) => typeof entry === "string" && entry.length > 0)
    ? (entries as string[]).slice()
    : undefined;
}

function parseIds<T>(
  value: unknown,
  schema: Readonly<{ safeParse: (input: unknown) => { success: boolean; data?: T } }>,
): readonly T[] | undefined {
  const entries = denseArrayValues(value);
  if (entries === undefined) return undefined;
  const ids: T[] = [];
  for (const entry of entries) {
    const parsed = schema.safeParse(entry);
    if (!parsed.success) return undefined;
    ids.push(parsed.data as T);
  }
  return ids;
}

function parseOrigin(value: unknown): PlaceholderOrigin | undefined {
  if (!isStrictRecord(value) || !isPlainData(value)) return undefined;
  if (value.kind === "existential-goal") {
    return hasExactKeys(value, ["kind"]) ? { kind: "existential-goal" } : undefined;
  }
  if (value.kind !== "auxiliary-request") return undefined;
  const hasRequester = Object.hasOwn(value, "requestedBy");
  if (
    !hasExactKeys(value, ["kind", "sort", "description", ...(hasRequester ? ["requestedBy"] : [])])
  ) {
    return undefined;
  }
  const sort = sortSchema.safeParse(value.sort);
  const requester = hasRequester
    ? constructionTaskIdSchema.safeParse(value.requestedBy)
    : undefined;
  if (
    !sort.success ||
    typeof value.description !== "string" ||
    value.description.length === 0 ||
    requester?.success === false
  ) {
    return undefined;
  }
  return {
    kind: "auxiliary-request",
    sort: structuredClone(sort.data),
    description: value.description,
    ...(requester?.success === true ? { requestedBy: requester.data } : {}),
  };
}

/** Guarded parser for construction operations; the caller has parsed the shared base. */
export function parseConstructionOperation(
  value: Readonly<Record<string, unknown>>,
  common: OperationBase,
): ConstructionParseResult {
  const kind = value.kind as ConstructionOperationKind;
  if (
    !hasExactKeys(value, [
      "kind",
      "expectedStateId",
      "resultStateId",
      "target",
      ...CONSTRUCTION_FIELDS[kind],
    ])
  ) {
    return parseFailure("The kernel operation contains missing or unknown fields.", []);
  }
  const taskId = constructionTaskIdSchema.safeParse(value.taskId);
  if (!taskId.success) return parseFailure("The construction task ID is invalid.", ["taskId"]);
  const attemptId =
    kind === "introduce-placeholder"
      ? undefined
      : constructionAttemptIdSchema.safeParse(value.attemptId);
  if (attemptId?.success === false) {
    return parseFailure("The attempt ID is invalid.", ["attemptId"]);
  }
  const attempt = attemptId?.data as ConstructionAttemptId;

  switch (kind) {
    case "introduce-placeholder": {
      if (typeof value.symbol !== "string" || value.symbol.length === 0) {
        return parseFailure("The placeholder symbol must be a nonempty string.", ["symbol"]);
      }
      if (typeof value.displayName !== "string" || value.displayName.length === 0) {
        return parseFailure("The display name must be a nonempty string.", ["displayName"]);
      }
      const origin = parseOrigin(value.origin);
      if (origin === undefined) {
        return parseFailure("The placeholder origin is invalid.", ["origin"]);
      }
      const dependencies = parseSymbols(value.dependencies);
      if (dependencies === undefined) {
        return parseFailure("Dependencies must be a dense list of symbols.", ["dependencies"]);
      }
      const allowedTasks = parseIds(value.allowedTasks, constructionTaskIdSchema);
      if (allowedTasks === undefined) {
        return parseFailure("Allowed tasks must be a dense list of task IDs.", ["allowedTasks"]);
      }
      return {
        ok: true,
        operation: {
          ...common,
          kind,
          taskId: taskId.data,
          symbol: value.symbol,
          displayName: value.displayName,
          origin,
          dependencies,
          allowedTasks,
        },
      };
    }
    case "add-requirement": {
      const requirementId = constructionRequirementIdSchema.safeParse(value.requirementId);
      if (!requirementId.success) {
        return parseFailure("The requirement ID is invalid.", ["requirementId"]);
      }
      const role = CONSTRUCTION_REQUIREMENT_ROLES.find((candidate) => candidate === value.role);
      if (role === undefined) {
        return parseFailure("The requirement role is invalid.", ["role"]);
      }
      if (!plainMathJsonSchema.safeParse(value.proposition).success) {
        return parseFailure("An expression must be serializable plain MathJSON.", ["proposition"]);
      }
      const evidence = isPlainData(value.evidence)
        ? constructionRequirementEvidenceSchema.safeParse(value.evidence)
        : undefined;
      if (evidence?.success !== true) {
        return parseFailure("The requirement evidence is invalid.", ["evidence"]);
      }
      return {
        ok: true,
        operation: {
          ...common,
          kind,
          taskId: taskId.data,
          requirementId: requirementId.data,
          role,
          proposition: structuredClone(value.proposition as PlainMathJson),
          evidence: structuredClone(evidence.data),
          attemptId: attempt,
        },
      };
    }
    case "add-candidate": {
      const candidateId = constructionCandidateIdSchema.safeParse(value.candidateId);
      if (!candidateId.success) {
        return parseFailure("The candidate ID is invalid.", ["candidateId"]);
      }
      if (!plainMathJsonSchema.safeParse(value.value).success) {
        return parseFailure("An expression must be serializable plain MathJSON.", ["value"]);
      }
      return {
        ok: true,
        operation: {
          ...common,
          kind,
          taskId: taskId.data,
          candidateId: candidateId.data,
          value: structuredClone(value.value as PlainMathJson),
          attemptId: attempt,
        },
      };
    }
    case "resolve-placeholder": {
      const candidateId = constructionCandidateIdSchema.safeParse(value.candidateId);
      if (!candidateId.success) {
        return parseFailure("The candidate ID is invalid.", ["candidateId"]);
      }
      const obligationIds = parseIds(value.obligationIds, statementIdSchema);
      if (obligationIds === undefined) {
        return parseFailure("An ID list must contain stable, dense IDs.", ["obligationIds"]);
      }
      return {
        ok: true,
        operation: {
          ...common,
          kind,
          taskId: taskId.data,
          candidateId: candidateId.data,
          obligationIds,
          attemptId: attempt,
        },
      };
    }
    case "abandon-placeholder":
      return {
        ok: true,
        operation: { ...common, kind, taskId: taskId.data, attemptId: attempt },
      };
  }
  return parseFailure("The kernel operation kind is unknown.", ["kind"]);
}
