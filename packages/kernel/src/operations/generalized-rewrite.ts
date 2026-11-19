import {
  createStatementViewSchema,
  type ContextualSequent,
  type Obligation,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofState,
  type StatementId,
} from "@proof/mathjson-model";
import { alphaEquivalentWithOperators } from "../alpha-equivalence";
import {
  closeRewriteCondition,
  locateRewriteOccurrence,
  rewriteCaptures,
  type RewriteAncestor,
} from "../deep-rewrite";
import { functionParts } from "../expression";
import type { GeneralizedRewriteSelection, KernelDiagnosticCode, TransitionClass } from "../index";
import {
  instantiateResultRule,
  matchResultExpressions,
  type KernelResult,
  type KernelResultId,
} from "../results";
import {
  findHypothesis,
  findHypothesisIndex,
  hypothesis,
  idCollision,
  internalFailure,
  replaceHypothesis,
  replaceWithObligations,
  success,
  targetIdCollision,
  withConclusion,
  type InternalResult,
  type LocatedTarget,
  type OperationOfKind,
} from "./shared";

type Relation = Readonly<{
  operator: string;
  left: PlainMathJson;
  right: PlainMathJson;
  parameters: readonly PlainMathJson[];
}>;

/** The first two arguments are the related expressions. Any remaining arguments stay fixed. */
export function rewriteRelationOf(expression: PlainMathJson): Relation | undefined {
  const parts = functionParts(expression);
  const [left, right, ...parameters] = parts?.operands ?? [];
  return parts === undefined || left === undefined || right === undefined
    ? undefined
    : { operator: parts.operator, left, right, parameters };
}

type Condition = Readonly<{ expression: PlainMathJson; resultId: KernelResultId }>;

type Failure = Readonly<{ ok: false; code: KernelDiagnosticCode; message: string }>;

type RewritePlan =
  | Failure
  | Readonly<{
      ok: true;
      relation: string;
      rewritten: PlainMathJson;
      replacement: PlainMathJson;
      conditions: readonly Condition[];
      transitionClass: TransitionClass;
      hypothesisIndex: number;
      resultId?: KernelResultId;
      congruenceResultIds: readonly KernelResultId[];
    }>;

function fail(code: KernelDiagnosticCode, message: string): Failure {
  return { ok: false, code, message };
}

function ruleView(result: KernelResult): KernelResult {
  return result.congruenceRule === undefined ? result : { ...result, ...result.congruenceRule };
}

function sourceInstance(
  operation: GeneralizedRewriteSelection,
  sequent: ContextualSequent,
  occurrence: NonNullable<ReturnType<typeof locateRewriteOccurrence>>,
  results: readonly KernelResult[],
  operators: readonly OperatorDeclaration[],
) {
  const { source, statement } = operation;
  if (source.kind === "hypothesis") {
    if (statement.kind === "hypothesis" && statement.id === source.hypothesisId) {
      return fail(
        "rule-not-applicable",
        "A rewrite source cannot consume itself as its own target.",
      );
    }
    const selected = findHypothesis(sequent, source.hypothesisId);
    if (selected === undefined) {
      return fail("hypothesis-not-found", "The rewrite hypothesis does not exist in this context.");
    }
    if (rewriteCaptures(occurrence, [selected.statement.expression], operators)) {
      return fail(
        "invalid-instantiation",
        "The rewrite hypothesis refers to a symbol shadowed at the selected occurrence.",
      );
    }
    return { ok: true as const, conclusion: selected.statement.expression, premises: [] };
  }
  const result = results.find(({ id }) => id === source.resultId);
  if (result === undefined)
    return fail("result-not-found", `No result ${source.resultId} is in the environment.`);
  const direction = statement.kind === "hypothesis" ? "forward" : "backward";
  if (!result.directions.includes(direction)) {
    return fail(
      "direction-not-permitted",
      `The result ${source.resultId} is not approved for ${direction} application.`,
    );
  }
  const selectedPremise =
    source.premiseIndex === undefined ? undefined : result.premises[source.premiseIndex];
  if (source.premiseIndex !== undefined && selectedPremise === undefined) {
    return fail(
      "index-out-of-range",
      "The indexed antecedent is not a premise of the rewrite result.",
    );
  }
  // P, Γ ⊢ C is also Γ ⊢ (P ⇒ C). The selected premise becomes the
  // implication's left side while the other premises remain side conditions.
  const sourceRule: KernelResult =
    selectedPremise === undefined
      ? ruleView(result)
      : {
          ...result,
          premises: result.premises.filter((_premise, index) => source.premiseIndex !== index),
          conclusion: {
            expression: ["Implies", selectedPremise.expression, result.conclusion.expression],
          },
        };
  return instantiateResultRule(
    sourceRule,
    source.instantiation,
    occurrence.declarations,
    operators,
  );
}

type Step = RewriteAncestor &
  Readonly<{
    old: PlainMathJson;
    next: PlainMathJson;
    groupedOld?: PlainMathJson;
  }>;

function rewriteSteps(
  occurrence: NonNullable<ReturnType<typeof locateRewriteOccurrence>>,
  expression: PlainMathJson,
  plan: GeneralizedRewriteSelection,
  replacement: PlainMathJson,
): readonly Step[] {
  const steps: Step[] = [];
  let next = replacement;
  if (plan.lens !== undefined) {
    const { startOperand, endOperand } = plan.lens;
    const container = plan.path.reduce(
      (current, index) => functionParts(current)?.operands[index] as PlainMathJson,
      expression,
    );
    const parts = functionParts(container)!;
    const before = parts.operands.slice(0, startOperand);
    const after = parts.operands.slice(endOperand);
    next = parts.rebuild([...before, replacement, ...after]);
    steps.push({
      parts,
      operand: startOperand,
      declarations: occurrence.declarations,
      scope: occurrence.scope,
      entersBinder: false,
      old: container,
      groupedOld: parts.rebuild([...before, occurrence.fragment, ...after]),
      next,
    });
  }
  for (const ancestor of [...occurrence.ancestors].reverse()) {
    next = ancestor.parts.rebuild(
      ancestor.parts.operands.map((operand, index) =>
        index === ancestor.operand ? next : operand,
      ),
    );
    steps.push({ ...ancestor, old: ancestor.parts.rebuild(ancestor.parts.operands), next });
  }
  return steps;
}

function isSymmetric(relation: Relation): boolean {
  return (
    relation.parameters.length === 0 &&
    (relation.operator === "Equal" || relation.operator === "Equivalent")
  );
}

function structuralLift(
  relation: Relation,
  step: Step,
  same: (left: PlainMathJson, right: PlainMathJson) => boolean,
  operators: readonly OperatorDeclaration[],
): Relation | undefined {
  const { operator } = step.parts;
  const { operand, old, next } = step;
  // Equality substitutes in ordinary expressions. For binding operators, the
  // standard binders are extensional in their bodies. Custom binders need a
  // separate inference principle when the selected operand is bound.
  if (relation.operator === "Equal" && relation.parameters.length === 0) {
    if (
      step.entersBinder &&
      operators.some((candidate) => candidate.symbol === operator && candidate.binder !== undefined)
    ) {
      return undefined;
    }
    const resultOperator = [
      "ForAll",
      "Exists",
      "Not",
      "Implies",
      "Equivalent",
      "And",
      "Or",
    ].includes(operator)
      ? "Equivalent"
      : "Equal";
    // Quantifier domains can be substituted for equals too.
    return { operator: resultOperator, left: old, right: next, parameters: [] };
  }
  const quantifierBody = (operator === "ForAll" || operator === "Exists") && operand === 1;
  const monotone =
    quantifierBody ||
    operator === "And" ||
    operator === "Or" ||
    (operator === "Implies" && operand === 1);
  const antitone = operator === "Not" || (operator === "Implies" && operand === 0);
  if (relation.parameters.length !== 0) return undefined;
  if (relation.operator === "Equivalent" && (monotone || antitone || operator === "Equivalent")) {
    return { operator: "Equivalent", left: old, right: next, parameters: [] };
  }
  if (relation.operator === "Implies" && (monotone || antitone)) {
    const selectedIsAntecedent = same(relation.left, matchingOperand(step));
    return antitone === selectedIsAntecedent
      ? { operator: "Implies", left: next, right: old, parameters: [] }
      : { operator: "Implies", left: old, right: next, parameters: [] };
  }
  return undefined;
}

function matchingOperand(step: Step): PlainMathJson {
  if (step.groupedOld !== undefined) {
    return functionParts(step.groupedOld)!.operands[step.operand] as PlainMathJson;
  }
  return step.parts.operands[step.operand] as PlainMathJson;
}

type Lift = Readonly<{
  relation: Relation;
  conditions: readonly Condition[];
  congruenceResultIds: readonly KernelResultId[];
}>;

type Search = Readonly<{
  steps: readonly Step[];
  operators: readonly OperatorDeclaration[];
  rulesByHead: ReadonlyMap<string, readonly KernelResult[]>;
  sequent: ContextualSequent;
  statement: GeneralizedRewriteSelection["statement"];
  pinned: readonly KernelResultId[] | undefined;
  same: (left: PlainMathJson, right: PlainMathJson) => boolean;
}>;

function* theoremLifts(
  incoming: Relation,
  step: Step,
  search: Search,
  witnessIndex: number,
): Generator<
  Readonly<{ relation: Relation; conditions: readonly Condition[]; resultId: KernelResultId }>
> {
  // A theorem that consumes a premise outside a binder cannot consume a fact
  // that is only true for the variable bound in that binder's body.
  if (step.entersBinder) return;
  const { operators, pinned } = search;
  const sourceOperands = [
    [incoming.left, incoming.right],
    ...(isSymmetric(incoming) ? [[incoming.right, incoming.left]] : []),
  ];
  const old = step.groupedOld ?? step.old;
  for (const candidate of search.rulesByHead.get(step.parts.operator) ?? []) {
    if (
      !candidate.directions.includes("forward") ||
      (pinned !== undefined && candidate.id !== pinned[witnessIndex])
    )
      continue;
    const rule = ruleView(candidate);
    const output = rewriteRelationOf(rule.conclusion.expression);
    if (output === undefined) continue;
    const parameters = rule.parameters.map(({ symbol }) => symbol);
    for (const [index, premise] of rule.premises.entries()) {
      if (functionParts(premise.expression)?.operator !== incoming.operator) continue;
      for (const [left, right] of sourceOperands) {
        const fact: PlainMathJson = [
          incoming.operator,
          left as PlainMathJson,
          right as PlainMathJson,
          ...incoming.parameters,
        ];
        for (const reversal of [false, true]) {
          const instantiation = matchResultExpressions(
            [
              [premise.expression, fact],
              [output.left, reversal ? step.next : old],
              [output.right, reversal ? old : step.next],
            ],
            parameters,
            operators,
          );
          if (instantiation === undefined) continue;
          const instance = instantiateResultRule(rule, instantiation, step.declarations, operators);
          if (!instance.ok) continue;
          const proven = rewriteRelationOf(instance.conclusion);
          if (proven === undefined) continue;
          const conditions = collectConditions(
            instance.premises.filter((_premise, premiseIndex) => premiseIndex !== index),
            candidate.id,
            step.scope,
            search,
          );
          if (conditions === undefined) continue;
          yield {
            relation: {
              ...proven,
              left: reversal ? step.next : step.old,
              right: reversal ? step.old : step.next,
            },
            conditions,
            resultId: candidate.id,
          };
        }
      }
    }
  }
}

function collectConditions(
  premises: readonly PlainMathJson[],
  resultId: KernelResultId,
  scope: RewriteAncestor["scope"],
  search: Pick<Search, "sequent" | "operators" | "same" | "statement">,
): readonly Condition[] | undefined {
  const conditions: Condition[] = [];
  for (const premise of premises) {
    const closed = closeRewriteCondition(premise, scope, search.operators);
    if (closed === undefined) return undefined;
    if (
      closed === "True" ||
      search.sequent.context.hypotheses.some(
        ({ id, statement }) =>
          (search.statement.kind !== "hypothesis" || search.statement.id !== id) &&
          search.same(statement.expression, closed),
      )
    )
      continue;
    conditions.push({ expression: closed, resultId });
  }
  return conditions;
}

function finishLift(
  relation: Relation,
  search: Search,
  old: PlainMathJson,
  next: PlainMathJson,
): boolean {
  if (isSymmetric(relation)) return true;
  if (relation.operator !== "Implies" || relation.parameters.length !== 0) return false;
  const [from, to] = search.statement.kind === "conclusion" ? [next, old] : [old, next];
  return search.same(relation.left, from) && search.same(relation.right, to);
}

function findLift(
  initial: Lift,
  old: PlainMathJson,
  next: PlainMathJson,
  search: Search,
): Lift | undefined {
  // A rewrite has one edited path; the alternative branches are different
  // approved theorems for one ancestor on that path. Bound unpinned search
  // to keep broad catalogs from multiplying equivalent alternatives.
  let remaining = 2048;
  function visit(index: number, current: Lift): Lift | undefined {
    if (remaining-- <= 0) return undefined;
    const step = search.steps[index];
    if (step === undefined) {
      return (search.pinned === undefined ||
        current.congruenceResultIds.length === search.pinned.length) &&
        finishLift(current.relation, search, old, next)
        ? current
        : undefined;
    }
    const structural = structuralLift(current.relation, step, search.same, search.operators);
    let best =
      structural === undefined ? undefined : visit(index + 1, { ...current, relation: structural });
    if (best?.conditions.length === current.conditions.length) return best;
    for (const candidate of theoremLifts(
      current.relation,
      step,
      search,
      current.congruenceResultIds.length,
    )) {
      const complete = visit(index + 1, {
        relation: candidate.relation,
        conditions: [...current.conditions, ...candidate.conditions],
        congruenceResultIds: [...current.congruenceResultIds, candidate.resultId],
      });
      if (
        complete !== undefined &&
        (best === undefined || complete.conditions.length < best.conditions.length)
      ) {
        best = complete;
        if (best.conditions.length === current.conditions.length) break;
      }
    }
    return best;
  }
  return visit(0, initial);
}

export function planGeneralizedRewrite(
  target: LocatedTarget,
  operation: GeneralizedRewriteSelection,
  operators: readonly OperatorDeclaration[],
  results: readonly KernelResult[],
): RewritePlan {
  const { sequent } = target.entry;
  const hypothesisIndex =
    operation.statement.kind === "hypothesis"
      ? findHypothesisIndex(sequent, operation.statement.id)
      : -1;
  const expression =
    operation.statement.kind === "conclusion"
      ? sequent.conclusion.expression
      : sequent.context.hypotheses[hypothesisIndex]?.statement.expression;
  if (expression === undefined)
    return fail("hypothesis-not-found", "The selected hypothesis does not exist.");
  const occurrence = locateRewriteOccurrence(
    expression,
    operation.path,
    operation.lens,
    operation.statement.kind === "conclusion" ? "positive" : "negative",
    sequent.context.declarations,
    operators,
  );
  if (occurrence === undefined)
    return fail("invalid-path", "The rewrite path or lens does not address an occurrence.");
  const instance = sourceInstance(operation, sequent, occurrence, results, operators);
  if (!instance.ok) return instance;
  const relation = rewriteRelationOf(instance.conclusion);
  if (relation === undefined)
    return fail("rule-not-applicable", "The source does not relate two expressions.");
  const [matched, replacement] =
    operation.direction === "forward"
      ? [relation.left, relation.right]
      : [relation.right, relation.left];
  const same = (left: PlainMathJson, right: PlainMathJson): boolean =>
    alphaEquivalentWithOperators(left, right, operators);
  if (same(matched, replacement) || !same(matched, occurrence.fragment)) {
    return fail(
      "rule-not-applicable",
      "The selected occurrence does not match a distinct side of the rewrite source.",
    );
  }
  const newExpression = occurrence.replace(replacement);
  const schema = createStatementViewSchema({
    declarations: sequent.context.declarations,
    operators,
  });
  if (newExpression === undefined || !schema.safeParse({ expression: newExpression }).success) {
    return fail(
      "replacement-failed",
      "The rewrite does not produce a well-scoped, well-sorted statement.",
    );
  }
  const sourceId = operation.source.kind === "result" ? operation.source.resultId : undefined;
  const rulesByHead = new Map<string, KernelResult[]>();
  for (const rule of results) {
    for (const head of rule.congruenceSymbols ?? []) {
      const existing = rulesByHead.get(head);
      if (existing === undefined) rulesByHead.set(head, [rule]);
      else existing.push(rule);
    }
  }
  const search: Search = {
    steps: rewriteSteps(occurrence, expression, operation, replacement),
    sequent,
    operators,
    rulesByHead,
    same,
    statement: operation.statement,
    pinned: operation.congruenceResultIds,
  };
  const conditions =
    sourceId === undefined
      ? []
      : collectConditions(instance.premises, sourceId, occurrence.scope, search);
  if (conditions === undefined)
    return fail(
      "invalid-instantiation",
      "The source conditions cannot be closed over the selected binders.",
    );
  const proven = findLift(
    { relation, conditions, congruenceResultIds: [] },
    expression,
    newExpression,
    search,
  );
  if (proven === undefined) {
    return fail(
      "polarity-not-permitted",
      "The checked rewrite and congruence rules do not establish the required direction.",
    );
  }
  const uniqueConditions = proven.conditions.filter(
    (condition, index, all) =>
      !all
        .slice(0, index)
        .some(
          (previous) =>
            previous.resultId === condition.resultId &&
            same(previous.expression, condition.expression),
        ),
  );
  if (uniqueConditions.some(({ expression }) => !schema.safeParse({ expression }).success)) {
    return fail(
      "invalid-proposition",
      "A rewrite condition is not a well-scoped, well-sorted obligation.",
    );
  }
  const resultId = sourceId ?? proven.congruenceResultIds[0];
  return {
    ok: true,
    relation: relation.operator,
    rewritten: newExpression,
    replacement,
    conditions: uniqueConditions,
    hypothesisIndex,
    transitionClass:
      isSymmetric(proven.relation) && uniqueConditions.length === 0
        ? "equivalence"
        : "strengthening",
    ...(resultId === undefined ? {} : { resultId }),
    congruenceResultIds: proven.congruenceResultIds,
  };
}

export function applyGeneralizedRewrite(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"generalized-rewrite">,
  operators: readonly OperatorDeclaration[],
  results: readonly KernelResult[],
): InternalResult {
  const plan = planGeneralizedRewrite(target, operation, operators, results);
  if (!plan.ok) return internalFailure(state, plan.code, plan.message);
  if (operation.obligationIds.length !== plan.conditions.length) {
    return internalFailure(
      state,
      "arity-mismatch",
      "The obligation IDs must correspond one-for-one with the unmet rewrite conditions.",
    );
  }
  const collision = targetIdCollision(state, operation.obligationIds);
  if (collision !== undefined) return idCollision(state, collision);
  const entry =
    operation.statement.kind === "conclusion"
      ? withConclusion(target.entry, plan.rewritten)
      : replaceHypothesis(target.entry, plan.hypothesisIndex, [
          hypothesis(operation.statement.id, plan.rewritten),
        ]);
  const obligations = plan.conditions.map(({ expression, resultId }, index): Obligation => ({
    id: operation.obligationIds[index] as StatementId,
    provenance: { kind: "premise-of-result", resultId },
    sequent: {
      context: target.entry.sequent.context,
      conclusion: { expression },
    },
  }));
  return success(
    replaceWithObligations(state, target, operation.target, entry, obligations),
    plan.transitionClass,
    plan.resultId === undefined ? "structural" : "library-result",
    plan.resultId,
  );
}
