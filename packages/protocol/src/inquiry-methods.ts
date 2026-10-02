/**
 * Method-created inquiry records and failure diagnostics (refinement §3.4, §6, §10; roadmap N24).
 *
 * Each function here is a pure derivation from stored data to one inquiry command: the records a
 * platform action creates by its stated semantics. The worker validates and records the command
 * through the single inquiry command path (`prepareInquiryCommand`), atomically with the action
 * where there is one. Nothing is recomputed from history: diagnostics come from the stored
 * suggestion set, edge and snapshots.
 *
 * No intention is attributed beyond an action's semantics. Every reason these commands carry has
 * `method-encoded` provenance naming the method that encodes it, and no command records a
 * `motivatedBy` relation, a decision, or an explicit-user, agent or later-interpretation reason.
 *
 * - "Try this theorem" (`try-result`): applying a displayed result suggestion to a target is an
 *   attempt to establish that target with the result. It records the attempt (reusing an active
 *   objective focused on that very target, or creating the Establish question and its required
 *   objective), one required objective per premise target the application created (the missing
 *   premises), `requires` relations from the attempt to them, and a `wouldSufficeFor` claim backed
 *   by the stored transition. Every premise or side condition the displayed match found unavailable
 *   becomes an observation naming that condition plus an obstruction of the attempt; when the
 *   application turned it into a premise target, that premise's objective `addresses` it.
 * - "Investigate this hypothesis" (`investigate-hypothesis`): a `Determine` question for the target
 *   with that hypothesis removed, referenced by identity, with an elective objective. It `tests` an
 *   existing Establish question of the same target when there is one. Failing to prove the stronger
 *   statement establishes nothing about the hypothesis's necessity; the question records none.
 * - "Extract a conditional lemma" (`extract-conditional-lemma`): `planConditionalLemma` checks that
 *   a target is closed in the stored subtree below its node without sorry assumptions and returns
 *   the context and conclusion for N12's `extractDerivedResult`, retaining only the hypotheses the
 *   subtree used (`usedHypotheses`, conservative where usage is unknown); the derived command
 *   records an observation naming the lemma and its dependence on that subtree.
 */
import type { KernelOperation } from "@proof/kernel";
import type { ProofContext, ProofState, StatementView } from "@proof/mathjson-model";
import { analyzeDiscoveryTree } from "./discovery-tree";
import {
  currentInquiryStatus,
  recordInquiryCommandRequestSchema,
  type InquiryRecord,
  type RecordInquiryCommandRequest,
  type ResultCondition,
} from "./inquiry";
import { usedHypotheses, type ConservativeHypothesisUse } from "./lemma-hypotheses";
import type { DisplayedSuggestionSet, ProofEdge, ProofNode } from "./index";

export type InquiryTarget = Readonly<{ kind: "goal" | "obligation"; id: string }>;

export type InquiryMethodDiagnosticCode =
  | "invalid-method-input"
  | "not-a-result-application"
  | "target-not-found"
  | "hypothesis-not-found"
  | "not-established"
  | "depends-on-sorry"
  | "too-many-records";

export type InquiryMethodDiagnostic = Readonly<{
  code: InquiryMethodDiagnosticCode;
  message: string;
}>;

export type DeriveInquiryCommandResult =
  | Readonly<{ ok: true; request: RecordInquiryCommandRequest; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly [InquiryMethodDiagnostic] }>;

/** The most records one inquiry command may hold (`recordInquiryCommandRequestSchema`). */
const MAX_COMMAND_RECORDS = 32;
const MAX_DETAIL_LENGTH = 1000;

/** The inquiry command ID a "Try this theorem" proof command records its inquiry under. */
export function tryResultInquiryCommandId(proofCommandId: string): string {
  return `${proofCommandId}:try-result`;
}

// ---------------------------------------------------------------------------------------------
// Try this theorem
// ---------------------------------------------------------------------------------------------

export type TryResultInput = Readonly<{
  /** The inquiry command ID; record IDs are derived from it. */
  commandId: string;
  parent: ProofNode;
  child: ProofNode;
  /** The stored transition that applied the chosen result suggestion. */
  edge: ProofEdge;
  /** The stored displayed suggestion set the edge's suggestion was chosen from. */
  suggestionSet: DisplayedSuggestionSet;
  /** Inquiry records recorded before this command, for reusing an active objective. */
  records: readonly InquiryRecord[];
}>;

type ResultApplication = Extract<
  KernelOperation,
  { kind: "apply-result-backward" | "apply-result-forward" }
>;

type PremiseTarget = Readonly<{ premiseIndex: number; target: InquiryTarget }>;

/** Derive the "Try this theorem" command for a stored result application. */
export function deriveTryResultInquiry(input: TryResultInput): DeriveInquiryCommandResult {
  const { commandId, parent, child, edge, suggestionSet } = input;
  if (
    edge.parentNodeId !== parent.id ||
    edge.childNodeId !== child.id ||
    edge.suggestionSetId === undefined ||
    edge.suggestionSetId !== suggestionSet.id ||
    suggestionSet.nodeId !== parent.id
  ) {
    return failure(
      "invalid-method-input",
      "The edge must link the given nodes and cite the given displayed suggestion set.",
    );
  }
  const suggestion = suggestionSet.suggestions.find(({ id }) => id === edge.chosenSuggestionId);
  const operation = edge.operation;
  if (
    suggestion === undefined ||
    suggestion.source !== "result" ||
    (operation.kind !== "apply-result-backward" && operation.kind !== "apply-result-forward") ||
    operation.resultId !== suggestion.artifactId
  ) {
    return failure(
      "not-a-result-application",
      "Try this theorem needs a transition that applied the chosen result suggestion's result.",
    );
  }
  const target: InquiryTarget = { kind: operation.target.kind, id: operation.target.id };
  if (findTarget(parent.state, target) === undefined) {
    return failure("target-not-found", "The applied target is not in the parent snapshot.");
  }
  const id = (suffix: string) => `${commandId}:${suffix}`;
  const resultMethod = { kind: "library-result", resultId: operation.resultId as string };
  const records: unknown[] = [];

  const reused = reusableObjective(input.records, parent.id, target);
  let objectiveId: string;
  let questionId: string;
  if (reused === undefined) {
    questionId = id("question");
    objectiveId = id("objective");
    records.push(
      {
        id: questionId,
        kind: "question",
        question: {
          form: "establish",
          proposition: { kind: "target", nodeId: parent.id, target },
        },
      },
      {
        id: objectiveId,
        kind: "objective",
        questionId,
        necessity: "required",
        focus: { nodeId: parent.id, target },
      },
    );
  } else {
    ({ objectiveId, questionId } = reused);
  }
  const attemptId = id("attempt");
  records.push({
    id: attemptId,
    kind: "attempt",
    objectiveId,
    method: resultMethod,
    suggestion: { suggestionSetId: suggestionSet.id, suggestionId: suggestion.id },
  });

  // The missing premises: one required objective per premise target the application created.
  const premises = premiseTargets(operation);
  const premiseQuestionIds = new Map<string, string>();
  const premiseObjectiveIds = new Map<number, string>();
  for (const premise of premises) {
    if (findTarget(child.state, premise.target) === undefined) {
      return failure("target-not-found", "A premise target is not in the child snapshot.");
    }
    const prefix = `premise-${premise.premiseIndex + 1}`;
    const premiseQuestionId = id(`${prefix}:question`);
    const premiseObjectiveId = id(`${prefix}:objective`);
    premiseQuestionIds.set(targetKey(premise.target), premiseQuestionId);
    premiseObjectiveIds.set(premise.premiseIndex, premiseObjectiveId);
    records.push(
      {
        id: premiseQuestionId,
        kind: "question",
        question: {
          form: "establish",
          proposition: { kind: "target", nodeId: child.id, target: premise.target },
        },
      },
      {
        id: premiseObjectiveId,
        kind: "objective",
        questionId: premiseQuestionId,
        necessity: "required",
        focus: { nodeId: child.id, target: premise.target },
        parentAttemptId: attemptId,
      },
      {
        id: id(`${prefix}:requires`),
        kind: "relationship",
        relation: "requires",
        from: [attemptId],
        to: premiseObjectiveId,
        reason: { provenance: "method-encoded", method: resultMethod },
      },
    );
  }

  // Why the new targets suffice: the stored transition, covering every target it created or
  // changed. A forward application also changes the target itself (a derived hypothesis).
  if (edge.transitionClass !== "weakening") {
    const claims: string[] = [];
    for (const changed of changedTargets(parent.state, child.state)) {
      const known = premiseQuestionIds.get(targetKey(changed));
      if (known !== undefined) {
        claims.push(known);
        continue;
      }
      const continuationId = id(`continuation:${changed.kind}:${changed.id}`);
      records.push({
        id: continuationId,
        kind: "question",
        question: {
          form: "establish",
          proposition: { kind: "target", nodeId: child.id, target: changed },
        },
      });
      claims.push(continuationId);
    }
    if (claims.length > 0) {
      records.push({
        id: id("suffices"),
        kind: "relationship",
        relation: "wouldSufficeFor",
        from: claims,
        to: questionId,
        support: { kind: "transition", childNodeId: child.id },
      });
    }
  }

  // Failed premise matches: each condition the displayed match found unavailable.
  for (const condition of suggestion.predictedObligations ?? []) {
    const applicationIndex = condition.applicationPremiseIndex;
    if (
      operation.kind === "apply-result-forward" &&
      applicationIndex !== undefined &&
      (operation.premiseHypothesisIds[applicationIndex] ?? null) !== null
    ) {
      continue; // The application matched it to a hypothesis after all.
    }
    const created =
      applicationIndex === undefined
        ? undefined
        : premises.find(({ premiseIndex }) => premiseIndex === applicationIndex);
    const prefix = `condition:${condition.kind}-${condition.index + 1}`;
    const observationId = id(`${prefix}:observation`);
    const obstructionId = id(`${prefix}:obstruction`);
    const reference: ResultCondition = { kind: condition.kind, index: condition.index };
    records.push(
      {
        id: observationId,
        kind: "observation",
        references: [
          {
            kind: "result-condition",
            nodeId: parent.id,
            suggestionSetId: suggestionSet.id,
            suggestionId: suggestion.id,
            condition: reference,
          },
          ...(created === undefined
            ? []
            : [{ kind: "target", nodeId: child.id, target: created.target }]),
        ],
        diagnostic: {
          code: "unmet-condition",
          detail: unmetConditionDetail(operation.resultId, condition, created?.target),
        },
      },
      {
        id: obstructionId,
        kind: "obstruction",
        attemptId,
        cause: { kind: "observation", observationId },
      },
    );
    const addressingObjective =
      created === undefined ? undefined : premiseObjectiveIds.get(created.premiseIndex);
    if (addressingObjective !== undefined) {
      records.push({
        id: id(`${prefix}:addresses`),
        kind: "relationship",
        relation: "addresses",
        from: [addressingObjective],
        to: obstructionId,
        reason: {
          provenance: "method-encoded",
          method: { kind: "inquiry-method", methodId: "try-result" },
        },
      });
    }
  }

  return command(commandId, parent.id, records);
}

/** Premise targets created by a result application, in premise order. */
function premiseTargets(operation: ResultApplication): readonly PremiseTarget[] {
  if (operation.kind === "apply-result-backward") {
    return operation.premiseTargetIds.map((targetId, premiseIndex) => ({
      premiseIndex,
      target: { kind: operation.target.kind, id: targetId },
    }));
  }
  const created: PremiseTarget[] = [];
  let next = 0;
  operation.premiseHypothesisIds.forEach((hypothesisId, premiseIndex) => {
    if (hypothesisId !== null) return;
    const obligationId = operation.obligationIds[next];
    next += 1;
    if (obligationId !== undefined) {
      created.push({ premiseIndex, target: { kind: "obligation", id: obligationId } });
    }
  });
  return created;
}

function unmetConditionDetail(
  resultId: string,
  condition: NonNullable<
    DisplayedSuggestionSet["suggestions"][number]["predictedObligations"]
  >[number],
  created: InquiryTarget | undefined,
): string {
  const name =
    condition.kind === "premise"
      ? `Premise ${condition.index + 1}`
      : `Side condition ${condition.index + 1} ("${condition.description}")`;
  const effect =
    created !== undefined
      ? `; the application made it ${created.kind} ${created.id}.`
      : condition.applicationPremiseIndex === undefined
        ? "; it has no statement, so the application does not check it."
        : ".";
  const detail = `${name} of ${resultId} is not available as a hypothesis${effect}`;
  return detail.length <= MAX_DETAIL_LENGTH ? detail : `${detail.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
}

/** An active objective focused on exactly this target whose question establishes it. */
function reusableObjective(
  records: readonly InquiryRecord[],
  nodeId: string,
  target: InquiryTarget,
): Readonly<{ objectiveId: string; questionId: string }> | undefined {
  const byId = new Map(records.map((record) => [record.id as string, record]));
  let found: InquiryRecord | undefined;
  for (const record of records) {
    if (
      record.kind !== "objective" ||
      record.focus?.nodeId !== nodeId ||
      !sameTarget(record.focus.target, target) ||
      currentInquiryStatus(record, records) !== "active"
    ) {
      continue;
    }
    const question = byId.get(record.questionId);
    if (question === undefined || !establishesExactly(question, nodeId, target)) continue;
    if (found === undefined || record.sequence > found.sequence) found = record;
  }
  return found?.kind === "objective"
    ? { objectiveId: found.id, questionId: found.questionId }
    : undefined;
}

// ---------------------------------------------------------------------------------------------
// Investigate this hypothesis
// ---------------------------------------------------------------------------------------------

export type HypothesisInvestigationInput = Readonly<{
  commandId: string;
  node: ProofNode;
  target: InquiryTarget;
  hypothesisId: string;
  /** Inquiry records recorded before this command, for the Establish question it tests. */
  records: readonly InquiryRecord[];
}>;

/** Derive the "Investigate this hypothesis" command: Determine the target without it. */
export function deriveHypothesisInvestigation(
  input: HypothesisInvestigationInput,
): DeriveInquiryCommandResult {
  const { commandId, node, target, hypothesisId } = input;
  const entry = findTarget(node.state, target);
  if (entry === undefined) {
    return failure("target-not-found", "The target is not in the proof node's snapshot.");
  }
  if (!entry.sequent.context.hypotheses.some(({ id }) => id === hypothesisId)) {
    return failure("hypothesis-not-found", "The hypothesis is not in the target's context.");
  }
  const questionId = `${commandId}:question`;
  const records: unknown[] = [
    {
      id: questionId,
      kind: "question",
      question: {
        form: "determine",
        proposition: {
          kind: "target",
          nodeId: node.id,
          target,
          withoutHypotheses: [hypothesisId],
        },
      },
    },
    {
      id: `${commandId}:objective`,
      kind: "objective",
      questionId,
      necessity: "elective",
      focus: { nodeId: node.id, target },
    },
  ];
  let tested: InquiryRecord | undefined;
  for (const record of input.records) {
    if (!establishesExactly(record, node.id, target)) continue;
    if (tested === undefined || record.sequence > tested.sequence) tested = record;
  }
  if (tested !== undefined) {
    records.push({
      id: `${commandId}:tests`,
      kind: "relationship",
      relation: "tests",
      from: [questionId],
      to: tested.id,
      reason: {
        provenance: "method-encoded",
        method: { kind: "inquiry-method", methodId: "investigate-hypothesis" },
      },
    });
  }
  return command(commandId, node.id, records);
}

// ---------------------------------------------------------------------------------------------
// Extract a conditional lemma
// ---------------------------------------------------------------------------------------------

export type ConditionalLemmaPlanInput = Readonly<{
  nodes: readonly ProofNode[];
  edges: readonly ProofEdge[];
  nodeId: string;
  target: InquiryTarget;
}>;

export type ConditionalLemmaPlan = Readonly<{
  nodeId: string;
  target: InquiryTarget;
  /** The target's local context and conclusion, for N12's `extractDerivedResult`. */
  context: ProofContext;
  conclusion: StatementView;
  /**
   * The hypotheses of the context the establishing steps used (N44): the lemma's premises, in
   * context order. When some step's usage is unknown, every hypothesis is retained.
   */
  retainedHypothesisIds: readonly string[];
  /** Context hypotheses no establishing step used, which the lemma does not retain. */
  unusedHypothesisIds: readonly string[];
  /** Steps whose usage could not be determined, which forced every hypothesis to be kept. */
  conservativeHypothesisUse: readonly ConservativeHypothesisUse[];
  /** The route steps below the node that close the target and its replacements, in order. */
  establishingEdgeIds: readonly string[];
  /** Establishing steps supported by an accepted background inference. */
  backgroundInferenceEdgeIds: readonly string[];
}>;

export type ConditionalLemmaPlanResult =
  | Readonly<{ ok: true; plan: ConditionalLemmaPlan; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly [InquiryMethodDiagnostic] }>;

/**
 * Check that a target is established in the stored subtree below its node, using the discovery
 * tree's route and per-target closure (N17), and describe the conditional lemma it yields. A
 * closure that uses a sorry, or a sorry assumption, is refused: the lemma could not retain it.
 */
export function planConditionalLemma(input: ConditionalLemmaPlanInput): ConditionalLemmaPlanResult {
  const node = input.nodes.find(({ id }) => id === input.nodeId);
  if (node === undefined) return failure("invalid-method-input", "The proof node is not stored.");
  const entry = findTarget(node.state, input.target);
  if (entry === undefined) {
    return failure("target-not-found", "The target is not in the proof node's snapshot.");
  }
  const subtreeNodeIds = new Set<string>([node.id]);
  const subtreeEdges: ProofEdge[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of input.edges) {
      if (subtreeNodeIds.has(edge.parentNodeId) && !subtreeNodeIds.has(edge.childNodeId)) {
        subtreeNodeIds.add(edge.childNodeId);
        subtreeEdges.push(edge);
        grew = true;
      }
    }
  }
  const analysis = analyzeDiscoveryTree({
    nodes: input.nodes.filter(({ id }) => subtreeNodeIds.has(id)),
    edges: subtreeEdges,
    rootId: node.id,
  });
  if (!analysis.ok) {
    return failure(
      "invalid-method-input",
      analysis.diagnostics[0]?.message ?? "The stored discovery subtree could not be analyzed.",
    );
  }
  const key = targetKey(input.target);
  const status = analysis.route.targetStatus[0]?.targets.find(
    ({ target }) => targetKey(target) === key,
  );
  if (status?.status !== "closed") {
    return failure(
      "not-established",
      `The ${input.target.kind} ${input.target.id} is not closed in the discovery tree below that node.`,
    );
  }
  // The steps acting on the target or on targets that replaced it.
  const lineage = new Set<string>([key]);
  const establishing = analysis.route.steps.filter((step) => {
    if (!lineage.has(targetKey(step.target))) return false;
    step.createdTargets.forEach((created) => lineage.add(targetKey(created)));
    return true;
  });
  const unsupported = establishing.find(
    (step) => step.evidence === "sorry" || step.operation.kind === "close-by-assumption",
  );
  if (unsupported !== undefined) {
    return failure(
      "depends-on-sorry",
      `The closure uses a sorry assumption at edge ${unsupported.edgeId}; a conditional lemma cannot retain it.`,
    );
  }
  const usage = usedHypotheses(
    entry.sequent.context.hypotheses.map(({ id }) => id),
    establishing,
  );
  return {
    ok: true,
    plan: freeze({
      nodeId: node.id,
      target: { kind: input.target.kind, id: input.target.id },
      context: structuredClone(entry.sequent.context),
      conclusion: structuredClone(entry.sequent.conclusion),
      retainedHypothesisIds: usage.usedHypothesisIds,
      unusedHypothesisIds: usage.unusedHypothesisIds,
      conservativeHypothesisUse: usage.conservative,
      establishingEdgeIds: establishing.map(({ edgeId }) => edgeId),
      backgroundInferenceEdgeIds: establishing
        .filter(({ evidence }) => evidence === "background-inference")
        .map(({ edgeId }) => edgeId),
    }),
    diagnostics: [],
  };
}

export type ConditionalLemmaInquiryInput = Readonly<{
  commandId: string;
  plan: ConditionalLemmaPlan;
  /** The derived library result extracted from the plan. */
  lemmaId: string;
}>;

/** Derive the command recording that a conditional lemma was extracted from a target. */
export function deriveConditionalLemmaInquiry(
  input: ConditionalLemmaInquiryInput,
): DeriveInquiryCommandResult {
  const { plan } = input;
  const hypotheses = plan.retainedHypothesisIds.length;
  const unused = plan.unusedHypothesisIds.length;
  const background = plan.backgroundInferenceEdgeIds.length;
  const note =
    `Conditional lemma ${input.lemmaId}: the conclusion of ${plan.target.kind} ${plan.target.id} ` +
    `holds under the ${hypotheses} hypothesis(es) of its context that its proof used, which it retains as premises` +
    (unused === 0 ? "" : ` (${unused} unused hypothesis(es) are not retained)`) +
    (plan.conservativeHypothesisUse.length === 0
      ? ". "
      : `; every hypothesis is kept because ${plan.conservativeHypothesisUse
          .map(({ edgeId, reason }) => `edge ${edgeId}: ${reason}`)
          .join("; ")}. `) +
    `It depends on the ${plan.establishingEdgeIds.length} establishing step(s) below proof node ` +
    `${plan.nodeId}` +
    (background === 0
      ? "."
      : `, including ${background} accepted background inference(s): ${plan.backgroundInferenceEdgeIds.join(", ")}.`);
  return command(input.commandId, plan.nodeId, [
    {
      id: `${input.commandId}:observation`,
      kind: "observation",
      references: [{ kind: "target", nodeId: plan.nodeId, target: plan.target }],
      note: note.length <= 2000 ? note : `${note.slice(0, 1999)}…`,
    },
  ]);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function command(
  commandId: string,
  nodeId: string,
  records: readonly unknown[],
): DeriveInquiryCommandResult {
  if (records.length > MAX_COMMAND_RECORDS) {
    return failure(
      "too-many-records",
      `The method would record ${records.length} records; one inquiry command holds at most ${MAX_COMMAND_RECORDS}.`,
    );
  }
  const parsed = recordInquiryCommandRequestSchema.safeParse({ commandId, nodeId, records });
  if (!parsed.success) {
    return failure(
      "invalid-method-input",
      parsed.error.issues[0]?.message ?? "The derived inquiry command is invalid.",
    );
  }
  return { ok: true, request: freeze(parsed.data), diagnostics: [] };
}

function establishesExactly(record: InquiryRecord, nodeId: string, target: InquiryTarget): boolean {
  if (record.kind !== "question" || record.question.form !== "establish") return false;
  const proposition = record.question.proposition;
  return (
    proposition.kind === "target" &&
    proposition.nodeId === nodeId &&
    sameTarget(proposition.target, target) &&
    proposition.withoutHypotheses === undefined &&
    proposition.negated === undefined
  );
}

function findTarget(state: ProofState, target: InquiryTarget) {
  return (target.kind === "goal" ? state.goals : state.obligations).find(
    ({ id }) => id === target.id,
  );
}

/** Child targets that are new or differ from the parent's target with the same ID. */
function changedTargets(parent: ProofState, child: ProofState): readonly InquiryTarget[] {
  const entries = (state: ProofState) => [
    ...state.goals.map((goal) => ({ target: { kind: "goal", id: goal.id } as const, goal })),
    ...state.obligations.map((obligation) => ({
      target: { kind: "obligation", id: obligation.id } as const,
      goal: obligation,
    })),
  ];
  const before = new Map(
    entries(parent).map(({ target, goal }) => [targetKey(target), canonicalJson(goal)]),
  );
  return entries(child)
    .filter(({ target, goal }) => before.get(targetKey(target)) !== canonicalJson(goal))
    .map(({ target }) => target);
}

function sameTarget(left: InquiryTarget, right: InquiryTarget): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function targetKey(target: InquiryTarget): string {
  return `${target.kind}\u0000${target.id}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function failure(
  code: InquiryMethodDiagnosticCode,
  message: string,
): Readonly<{ ok: false; diagnostics: readonly [InquiryMethodDiagnostic] }> {
  return { ok: false, diagnostics: [{ code, message }] };
}

function freeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach((child: unknown) => freeze(child));
    Object.freeze(value);
  }
  return value;
}
