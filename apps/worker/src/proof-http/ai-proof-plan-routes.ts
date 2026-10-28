/**
 * Motivated proof plans (`docs/motivated-proof-plans.md`), all session-scoped:
 *
 * - `POST /proof-sessions/:id/ai/proof-plan` asks the planner for one structured proof of the
 *   current goal and answers with the stored plan, its numbering and its walking units.
 * - `GET /proof-sessions/:id/ai/proof-plan/:callId` reads a stored plan back the same way.
 * - `POST /proof-sessions/:id/ai/proof-plan/translate` translates one move of one unit: the
 *   realization check, the candidate actions, Jev's choice and menus, and the ordinary preview.
 *   Nothing is committed.
 * - `POST /proof-sessions/:id/ai/proof-plan/apply` commits a translated move. The command is
 *   re-derived from the stored calls and the recorded suggestion set, never taken from the client.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_TRANSLATOR_MIN_CONFIDENCE,
  MAX_TRANSLATOR_MENUS,
  MAX_TRANSLATOR_MENU_ITEMS,
  NO_FITTING_ITEM_CHOICE_ID,
  NO_MOVE_CHOICE_ID,
  STEP_REALIZED_CHOICE_ID,
  buildProofPlannerContext,
  buildStepTranslatorContext,
  criterionLabel,
  menuQuestionId,
  prepareLlmCall,
  proofPlanWalk,
  type PreparedLlmCall,
  type ProofPlanProposal,
  type ProofPlannerContext,
  type StepTranslatorContext,
  type StepTranslatorOutput,
  type TranslatorAnswer,
  type TranslatorCandidate,
  type TranslatorMenu,
} from "@proof/llm";
import { actorSchema, stableIdentifierSchema, type Actor, type ProofNode } from "@proof/protocol";
import { z } from "zod";
import type { AiRoleRuntime } from "../ai-runtime";
import {
  readLlmCall,
  runDurableLlmCall,
  type LlmCallOwner,
  type StoredLlmCall,
} from "../llm-call-repository";
import {
  candidateActions,
  checkRealization,
  followFocus,
  latexRenderer,
  plannerContext,
  renderedLatex,
  unparsedLatex,
} from "../proof-plan-walk";
import {
  loadCurrentProofSession,
  loadNode,
  loadSession,
  readDisplayedSuggestionSet,
  type MoveRequiresInput,
  type ProofSession,
} from "../proof-repository";
import { catalogOperators } from "../session-constants";
import { admitProviderCall, LIMIT_MESSAGE, problem, readBody, repositoryStatus } from "./ai-http";
import { writeJson } from "./http-util";
import {
  applyMoveChoice,
  approvedRetrievalIndex,
  previewMoveChoice,
  recordSuggestions,
  repositoryFailureStatus,
  type ServiceContext,
} from "./shared";

/** The stateful proof agent whose plan Jev carried out; the person confirmed each move. */
export const PROOF_PLAN_ACTOR = actorSchema.parse({ id: "actor:proof-planner", kind: "agent" });
/** The person, when they chose a different candidate than Jev. */
const WEB_ACTOR = actorSchema.parse({ id: "actor:web", kind: "human" });

/** A unit that needs more moves than this is reported as stuck. */
export const MAX_MOVES_PER_UNIT = 4;
const DEFAULT_PLAN_ANSWER_WAIT_MS = 15_000;
const MAX_MENU_ROUNDS = 3;
const ALTERNATIVES_SHOWN = 3;

const planRequestSchema = z
  .object({ id: stableIdentifierSchema, expectedCurrentNodeId: stableIdentifierSchema })
  .strict();

const labelSchema = z.string().min(1).max(48);
const translateRequestSchema = z
  .object({
    id: stableIdentifierSchema,
    planCallId: stableIdentifierSchema,
    stepId: labelSchema,
    expectedCurrentNodeId: stableIdentifierSchema,
    /** The node and focused goal at the start of the unit. */
    start: z
      .object({ nodeId: stableIdentifierSchema, focusTargetId: stableIdentifierSchema })
      .strict(),
    /** Names of the moves applied for this unit so far. */
    movesSoFar: z.array(z.string().min(1).max(500)).max(MAX_MOVES_PER_UNIT),
    /** The hypotheses each earlier step label names, as earlier units reported them. */
    refs: z.record(labelSchema, z.array(stableIdentifierSchema).max(16)),
    /** Preview this candidate of the stored action call instead of Jev's choice. */
    chosenCandidateId: stableIdentifierSchema.optional(),
  })
  .strict();

const applyRequestSchema = z
  .object({
    callId: stableIdentifierSchema,
    candidateId: stableIdentifierSchema,
    expectedCurrentNodeId: stableIdentifierSchema,
  })
  .strict();

type Outcome = Readonly<{ status: number; body: unknown }>;

function diagnostics(status: number, code: string, message: string, extra: object = {}): Outcome {
  return { status, body: { ...extra, diagnostics: [{ code, message }] } };
}

function reply(response: ServerResponse, outcome: Outcome): void {
  writeJson(response, outcome.status, outcome.body);
}

function disabled(what: string): Outcome {
  return diagnostics(
    503,
    "ai-disabled",
    `${what} is unavailable because its provider is not configured.`,
    {
      status: "disabled",
    },
  );
}

const sessionOwner = (sessionId: string): LlmCallOwner => ({
  kind: "proof-session",
  id: sessionId,
});

type RunOutcome =
  | Readonly<{ ok: true; record: StoredLlmCall & { status: "completed" }; replayed: boolean }>
  | Readonly<{ ok: false; outcome: Outcome; retryAfterSeconds?: number }>;

/** Admit, dispatch and durably record one call under the shared cost guard. */
async function runCall(
  context: ServiceContext,
  sessionId: string,
  call: PreparedLlmCall,
  configured: AiRoleRuntime,
): Promise<RunOutcome> {
  const owner = sessionOwner(sessionId);
  const admission = await admitProviderCall(context, owner, call.id);
  if (!admission.ok) {
    return {
      ok: false,
      retryAfterSeconds: admission.retryAfterSeconds,
      outcome: {
        status: 429,
        body: {
          status: "rate-limited",
          diagnostics: [{ code: admission.code, message: LIMIT_MESSAGE }],
        },
      },
    };
  }
  let result;
  try {
    result = await runDurableLlmCall(
      context.llmCalls!,
      { owner, call, dispatch: configured.dispatch },
      configured.transport,
    );
  } finally {
    admission.release();
  }
  if (result.status !== "completed") {
    return {
      ok: false,
      outcome: { status: repositoryStatus(result), body: { diagnostics: result.diagnostics } },
    };
  }
  if (result.record.status !== "completed") {
    return { ok: false, outcome: { status: 503, body: problem("The call outcome is uncertain.") } };
  }
  return {
    ok: true,
    record: result.record as StoredLlmCall & { status: "completed" },
    replayed: result.replayed,
  };
}

function replyRun(response: ServerResponse, run: Extract<RunOutcome, { ok: false }>): void {
  if (run.retryAfterSeconds !== undefined)
    response.setHeader("retry-after", String(run.retryAfterSeconds));
  reply(response, run.outcome);
}

/** The plan view the client walks: the stored plan, its numbers and units, and parse warnings. */
function planView(
  plan: ProofPlanProposal,
  planContext: ProofPlannerContext,
  operators: ProofSession["operators"],
) {
  const walk = proofPlanWalk(plan, planContext);
  if (walk === undefined) return undefined;
  const numbers: { stepId: string; number: string; level: number }[] = [];
  const visit = (nodes: typeof walk.roots) =>
    nodes.forEach((node) => {
      numbers.push({ stepId: node.step.id, number: node.number, level: node.level });
      visit(node.children);
    });
  visit(walk.roots);
  return {
    plan,
    numbers,
    units: walk.units,
    initialState: {
      nodeId: planContext.initialState.nodeId,
      goalId: planContext.initialState.goalId,
    },
    warnings: unparsedLatex(plan.steps, operators).map(({ stepId, field }) => ({
      stepId,
      field,
      message: `The LaTeX of ${field} does not parse in this session's notation; it is kept as prose.`,
    })),
    rendered: renderedLatex(plan, operators),
  };
}

type StoredPlan = Readonly<{ plan: ProofPlanProposal; context: ProofPlannerContext }>;

async function readStoredPlan(
  context: ServiceContext,
  sessionId: string,
  callId: string,
): Promise<Readonly<{ ok: true; stored: StoredPlan }> | Readonly<{ ok: false; outcome: Outcome }>> {
  const read = await readLlmCall(context.llmCalls!, sessionOwner(sessionId), callId);
  if (read.status !== "found") {
    return {
      ok: false,
      outcome: { status: repositoryStatus(read), body: { diagnostics: read.diagnostics } },
    };
  }
  const { record } = read;
  const envelope = record.preparedCall.envelope;
  const output =
    record.status === "completed" && record.evidence.status === "validated"
      ? record.evidence.output
      : undefined;
  if (
    record.role !== "proof-planner" ||
    envelope.role !== "proof-planner" ||
    output?.kind !== "proof-plan"
  ) {
    return {
      ok: false,
      outcome: diagnostics(
        409,
        "plan-not-available",
        "The call is not a validated proof plan of this session.",
        {
          status: "not-a-plan",
        },
      ),
    };
  }
  return { ok: true, stored: { plan: output, context: envelope.context } };
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

export async function writeProofPlan(
  context: ServiceContext,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = planRequestSchema.safeParse(body.value);
  if (!requestData.success)
    return writeJson(response, 400, problem("The proof-plan request is invalid."));
  const configured = context.ai?.["proof-planner"];
  if (configured === undefined || context.llmCalls === undefined)
    return reply(response, disabled("Proof planning"));
  const { id, expectedCurrentNodeId } = requestData.data;
  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status !== "loaded") {
    return writeJson(response, repositoryFailureStatus(loaded), {
      diagnostics: loaded.diagnostics,
    });
  }
  if (loaded.session.readOnly === true) {
    return reply(
      response,
      diagnostics(409, "session-read-only", "A read-only session cannot be planned.", {
        status: "read-only",
      }),
    );
  }
  if (loaded.session.currentNodeId !== expectedCurrentNodeId) {
    return reply(
      response,
      diagnostics(
        409,
        "stale-evidence",
        "The proof session moved since the request was prepared.",
        { status: "stale" },
      ),
    );
  }
  const operators = loaded.session.operators;
  const catalog = context.definitions.catalog(catalogOperators(operators, context.definitions));
  const built = plannerContext({
    node: loaded.node,
    metadata: loaded.session.metadata,
    operators,
    results: catalog.results,
  });
  if (!built.ok)
    return reply(
      response,
      diagnostics(409, "plan-context-unavailable", built.message, { status: "unavailable" }),
    );
  const envelope = buildProofPlannerContext({ id, context: built.context });
  if (!envelope.ok) return writeJson(response, 400, { diagnostics: envelope.diagnostics });
  const prepared = prepareLlmCall(envelope.envelope);
  if (!prepared.ok) return writeJson(response, 400, { diagnostics: prepared.diagnostics });
  // Writing a whole proof can outlast an HTTP exchange. The durable call keeps running; a request
  // that is not answered in time says so, and the plan is read back by its call ID.
  const pending = runCall(context, sessionId, prepared.call, configured).catch((): RunOutcome => ({
    ok: false,
    outcome: { status: 500, body: problem("Planning failed.") },
  }));
  const stopWaiting = new AbortController();
  const waited = delay(context.planAnswerWaitMs ?? DEFAULT_PLAN_ANSWER_WAIT_MS, undefined, {
    signal: stopWaiting.signal,
  }).catch(() => undefined);
  const run = await Promise.race([pending, waited]);
  stopWaiting.abort();
  if (run === undefined) {
    return writeJson(response, 202, {
      status: "planning",
      callId: prepared.call.id,
      diagnostics: [],
    });
  }
  if (!run.ok) return replyRun(response, run);
  writePlanEvidence(response, run.record, run.replayed, operators);
}

function writePlanEvidence(
  response: ServerResponse,
  record: StoredLlmCall & { status: "completed" },
  replayed: boolean,
  operators: ProofSession["operators"],
): void {
  const evidence = record.evidence;
  const envelope = record.preparedCall.envelope;
  if (
    evidence.status !== "validated" ||
    evidence.output === undefined ||
    envelope.role !== "proof-planner"
  ) {
    return writeJson(response, evidence.status === "transport-failed" ? 503 : 422, {
      status: evidence.status,
      callId: record.id,
      replayed,
      diagnostics: evidence.diagnostics,
    });
  }
  const output = evidence.output;
  if (output.kind !== "proof-plan") {
    return writeJson(response, 200, {
      status: output.kind,
      callId: record.id,
      replayed,
      result: output,
    });
  }
  const view = planView(output, envelope.context, operators);
  if (view === undefined)
    return writeJson(response, 500, problem("The stored plan no longer checks."));
  writeJson(response, 200, {
    status: "planned",
    callId: record.id,
    replayed,
    ...view,
    diagnostics: [],
  });
}

export async function readProofPlan(
  context: ServiceContext,
  sessionId: string,
  callId: string,
  response: ServerResponse,
): Promise<void> {
  if (context.llmCalls === undefined) return reply(response, disabled("Proof planning"));
  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status !== "loaded") {
    return writeJson(response, repositoryFailureStatus(loaded), {
      diagnostics: loaded.diagnostics,
    });
  }
  const read = await readLlmCall(context.llmCalls, sessionOwner(sessionId), callId);
  if (read.status !== "found")
    return writeJson(response, repositoryStatus(read), { diagnostics: read.diagnostics });
  if (read.record.role === "proof-planner" && read.record.status === "dispatching") {
    return writeJson(response, 200, { status: "planning", callId, diagnostics: [] });
  }
  if (read.record.role !== "proof-planner" || read.record.status !== "completed") {
    return reply(
      response,
      diagnostics(409, "plan-not-available", "The call is not a proof plan of this session.", {
        status: "not-a-plan",
      }),
    );
  }
  writePlanEvidence(
    response,
    read.record as StoredLlmCall & { status: "completed" },
    true,
    loaded.session.operators,
  );
}

// ---------------------------------------------------------------------------------------------
// Translate
// ---------------------------------------------------------------------------------------------

function minimumConfidence(configured: AiRoleRuntime): number {
  return configured.dispatch.minimumConfidence ?? DEFAULT_TRANSLATOR_MIN_CONFIDENCE;
}

type ActionContext = Extract<StepTranslatorContext, { kind: "action" }>;

function alternatives(answer: TranslatorAnswer, context: ActionContext, except?: string) {
  const byId = new Map(context.candidates.map((candidate) => [candidate.id, candidate]));
  return answer.ranked
    .filter(({ id }) => byId.has(id) && id !== except)
    .slice(0, ALTERNATIVES_SHOWN)
    .map(({ id, probability }) => ({ ...candidateSummary(byId.get(id)!), probability }));
}

function candidateSummary(candidate: TranslatorCandidate) {
  const { id, label, source, artifactId, selections } = candidate;
  return { id, label, source, artifactId, selections };
}

async function loadStartNode(
  context: ServiceContext,
  sessionId: string,
  nodeId: string,
): Promise<ProofNode | undefined> {
  return context.store.transaction(async (transaction) => {
    const session = await loadSession(transaction, sessionId as ProofSession["id"]);
    if (!session.ok) return undefined;
    const node = await loadNode(
      transaction,
      session.session,
      session.environment,
      nodeId as ProofNode["id"],
      "current-node-not-found",
      "invalid-current-node",
    );
    return node.ok ? node.node : undefined;
  });
}

export async function translatePlanStep(
  context: ServiceContext,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = translateRequestSchema.safeParse(body.value);
  if (!requestData.success)
    return writeJson(response, 400, problem("The translation request is invalid."));
  const configured = context.ai?.["step-translator"];
  if (configured === undefined || context.llmCalls === undefined)
    return reply(response, disabled("Step translation"));
  const input = requestData.data;
  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status !== "loaded") {
    return writeJson(response, repositoryFailureStatus(loaded), {
      diagnostics: loaded.diagnostics,
    });
  }
  if (loaded.session.readOnly === true) {
    return reply(
      response,
      diagnostics(409, "session-read-only", "A read-only session cannot be changed.", {
        status: "read-only",
      }),
    );
  }
  if (loaded.session.currentNodeId !== input.expectedCurrentNodeId) {
    return reply(
      response,
      diagnostics(
        409,
        "stale-evidence",
        "The proof session moved since the request was prepared.",
        { status: "stale" },
      ),
    );
  }
  const stored = await readStoredPlan(context, sessionId, input.planCallId);
  if (!stored.ok) return reply(response, stored.outcome);
  const { plan, context: planContext } = stored.stored;
  const walk = proofPlanWalk(plan, planContext);
  const unit = walk?.units.find(({ stepId }) => stepId === input.stepId);
  const step = plan.steps.find(({ id }) => id === input.stepId);
  if (unit === undefined || step === undefined) {
    return reply(
      response,
      diagnostics(404, "unit-not-found", "The plan has no unit for this step.", {
        status: "not-found",
      }),
    );
  }
  const base = { stepId: unit.stepId, number: unit.number, form: unit.form };
  if (unit.unsupported !== undefined) {
    return writeJson(response, 200, {
      status: "unsupported",
      ...base,
      reason: unit.unsupported,
      diagnostics: [],
    });
  }

  const startNode =
    input.start.nodeId === loaded.node.id
      ? loaded.node
      : await loadStartNode(context, sessionId, input.start.nodeId);
  const focus =
    startNode === undefined
      ? undefined
      : followFocus(startNode, input.start.focusTargetId, loaded.node);
  if (focus === undefined) {
    return reply(
      response,
      diagnostics(
        409,
        "focus-not-found",
        "The unit's starting node or goal is not part of this session.",
        { status: "invalid-start" },
      ),
    );
  }
  const operators = loaded.session.operators;
  const realization = checkRealization({
    unit,
    step,
    cases: plan.steps.filter(({ parent, form }) => parent === step.id && form === "case"),
    focus,
    movesApplied: input.movesSoFar.length,
    operators,
  });
  if (realization.realized) {
    return writeJson(response, 200, {
      status: "realized",
      ...base,
      outputs: realization.outputs,
      diagnostics: [],
    });
  }
  if (input.movesSoFar.length >= MAX_MOVES_PER_UNIT) {
    return writeJson(response, 200, {
      status: "stuck",
      ...base,
      reason: `${MAX_MOVES_PER_UNIT} moves were applied for this step without carrying it out.`,
      diagnostics: [],
    });
  }
  const goal = focus.successors[0];
  if (goal === undefined) {
    return writeJson(response, 200, {
      status: "stuck",
      ...base,
      reason: "The goal this step works on is closed, but the step's claim is not established.",
      diagnostics: [],
    });
  }

  // What the step acts on, as statements of the focused goal.
  const hypothesisIds = new Set<string>(goal.sequent.context.hypotheses.map(({ id }) => id));
  const labelled = new Map(
    planContext.initialState.hypotheses.map(({ label, statementId }) => [label, statementId]),
  );
  const latex = latexRenderer(operators);
  const actsOn = step.actsOn.map((reference) => {
    if (reference === "goal") return { reference, ids: ["conclusion"] };
    const ids = labelled.has(reference)
      ? [labelled.get(reference)!]
      : (input.refs[reference] ?? []);
    return { reference, ids: ids.filter((statementId) => hypothesisIds.has(statementId)) };
  });
  const statementLatex = (statementId: string) => {
    if (statementId === "conclusion") return latex.serialize(goal.sequent.conclusion.expression);
    const hypothesis = goal.sequent.context.hypotheses.find(({ id }) => id === statementId);
    return hypothesis === undefined ? null : latex.serialize(hypothesis.statement.expression);
  };

  const index = approvedRetrievalIndex(context.definitions, operators);
  if (!index.ok)
    return writeJson(response, 500, {
      diagnostics: [{ code: "invalid-catalog", message: index.message }],
    });
  const actions = candidateActions({
    index: index.index,
    node: loaded.node,
    goal,
    actsOn: actsOn.flatMap(({ ids }) => ids),
    operators,
  });
  if (actions.candidates.length === 0) {
    return writeJson(response, 200, {
      status: "no-move",
      ...base,
      reason: "No displayed action applies to the goal this step works on.",
      focus: { targetId: goal.id },
      candidateCount: 0,
      diagnostics: [],
    });
  }

  const actionContext: ActionContext = {
    kind: "action",
    nodeId: loaded.node.id,
    plan: { callId: input.planCallId, stepId: step.id, number: unit.number, form: step.form },
    step: {
      claim: step.claim,
      variables: step.variables,
      assumptions: step.assumptions,
      term: step.term,
      by: step.by,
      motivation: step.motivation,
      actsOn: actsOn.map(({ reference, ids }) => ({
        reference,
        statement: ids[0] === undefined ? null : statementLatex(ids[0]),
      })),
    },
    enclosingClaim: unit.enclosingClaim,
    focus: {
      targetId: goal.id,
      conclusion: latex.serialize(goal.sequent.conclusion.expression),
      hypotheses: goal.sequent.context.hypotheses.map(({ id, statement }) => ({
        id,
        statement: latex.serialize(statement.expression),
      })),
    },
    movesSoFar: input.movesSoFar.map((name) => criterionLabel(name)),
    selectionSets: actions.selectionSets.map(({ id, selections }) => ({
      id,
      selections: [...selections],
    })),
    candidates: [...actions.candidates],
    offerRealized: !realization.decidable,
  };
  const action = await askJev(context, sessionId, input.id, actionContext, configured);
  if (!action.ok) return replyRun(response, action);
  const answer = action.output.answers.action!;
  const callId = action.callId;
  const threshold = minimumConfidence(configured);
  const common = {
    ...base,
    callId,
    replayed: action.replayed,
    candidateCount: actions.candidates.length,
    droppedCandidates: actions.dropped,
    confidence: answer.confidence,
  };

  let chosenId = answer.choice;
  let actor: Actor = PROOF_PLAN_ACTOR;
  if (input.chosenCandidateId !== undefined) {
    if (!actionContext.candidates.some(({ id }) => id === input.chosenCandidateId)) {
      return writeJson(
        response,
        400,
        problem("The chosen candidate is not one of the call's candidates."),
      );
    }
    chosenId = input.chosenCandidateId;
    actor =
      chosenId === answer.choice && answer.confidence >= threshold ? PROOF_PLAN_ACTOR : WEB_ACTOR;
  } else if (answer.confidence < threshold) {
    return writeJson(response, 200, {
      status: "uncertain",
      ...common,
      reason: "Jev's best answer is below the confidence threshold.",
      alternatives: alternatives(answer, actionContext),
      diagnostics: [],
    });
  } else if (chosenId === NO_MOVE_CHOICE_ID) {
    return writeJson(response, 200, {
      status: "no-move",
      ...common,
      reason: "Jev judged that no displayed action carries out this step: a move is missing.",
      focus: { targetId: goal.id },
      alternatives: alternatives(answer, actionContext),
      diagnostics: [],
    });
  } else if (chosenId === STEP_REALIZED_CHOICE_ID) {
    const before = new Set(focus.start.sequent.context.hypotheses.map(({ id }) => id));
    return writeJson(response, 200, {
      status: "realized",
      ...common,
      outputs: {
        focusTargetId: goal.id,
        produced: goal.sequent.context.hypotheses
          .filter(({ id }) => !before.has(id))
          .map(({ id }) => id),
      },
      diagnostics: [],
    });
  }

  const candidate = actionContext.candidates.find(({ id }) => id === chosenId)!;
  const proposed = await proposeCandidate(
    context,
    sessionId,
    actionContext,
    callId,
    candidate,
    actor,
    configured,
  );
  if (!proposed.ok) {
    if ("run" in proposed) return replyRun(response, proposed.run);
    return writeJson(response, proposed.status, { ...common, ...proposed.body });
  }
  writeJson(response, 200, {
    status: "proposed",
    ...common,
    actor,
    choice: {
      ...candidateSummary(candidate),
      probability: answer.ranked.find(({ id }) => id === candidate.id)?.probability ?? 0,
    },
    alternatives: alternatives(answer, actionContext, candidate.id),
    menuChoices: proposed.menuChoices,
    menuCallIds: proposed.menuCallIds,
    preview: proposed.preview,
    diagnostics: [],
  });
}

type JevOutcome =
  | Readonly<{ ok: true; output: StepTranslatorOutput; callId: string; replayed: boolean }>
  | Extract<RunOutcome, { ok: false }>;

async function askJev(
  context: ServiceContext,
  sessionId: string,
  id: string,
  translatorContext: StepTranslatorContext,
  configured: AiRoleRuntime,
): Promise<JevOutcome> {
  const envelope = buildStepTranslatorContext({ id, context: translatorContext });
  if (!envelope.ok)
    return { ok: false, outcome: { status: 400, body: { diagnostics: envelope.diagnostics } } };
  const prepared = prepareLlmCall(envelope.envelope);
  if (!prepared.ok)
    return { ok: false, outcome: { status: 400, body: { diagnostics: prepared.diagnostics } } };
  const run = await runCall(context, sessionId, prepared.call, configured);
  if (!run.ok) return run;
  const evidence = run.record.evidence;
  if (evidence.status !== "validated" || evidence.output?.kind !== "translator-choices") {
    return {
      ok: false,
      outcome: {
        status: evidence.status === "transport-failed" ? 503 : 422,
        body: {
          status: evidence.status,
          callId: run.record.id,
          replayed: run.replayed,
          diagnostics: evidence.diagnostics,
        },
      },
    };
  }
  return { ok: true, output: evidence.output, callId: run.record.id, replayed: run.replayed };
}

/** The deterministic IDs of everything one candidate of an action call records. */
export function candidateRecordIds(callId: string, candidate: TranslatorCandidate) {
  const number = candidate.id.replace(/^candidate:/, "");
  return {
    suggestionSetId: `suggestion-set:${callId}:${candidate.selectionSetId.replace(/^selection-set:/, "")}`,
    commandId: `command:${callId}:${number}`,
    menuCallId: (round: number) => `${callId}:menus:${number}:${round}`,
  };
}

type ProposeOutcome =
  | Readonly<{
      ok: true;
      preview: unknown;
      menuChoices: Readonly<Record<string, string>>;
      menuCallIds: readonly string[];
    }>
  | Readonly<{ ok: false; status: number; body: Record<string, unknown> }>
  | Readonly<{ ok: false; run: Extract<RunOutcome, { ok: false }> }>;

/**
 * Record the candidate's suggestion set, answer its menus with Jev, and preview it through the
 * ordinary preview path. The command and set IDs are derived from the call, so a retry replays.
 */
async function proposeCandidate(
  context: ServiceContext,
  sessionId: string,
  actionContext: ActionContext,
  callId: string,
  candidate: TranslatorCandidate,
  actor: Actor,
  configured: AiRoleRuntime,
): Promise<ProposeOutcome> {
  const ids = candidateRecordIds(callId, candidate);
  const located = await locateCandidate(
    context,
    sessionId,
    actionContext,
    candidate,
    ids.suggestionSetId,
  );
  if (!located.ok) return located;
  const menuChoices: Record<string, string> = {};
  const menuCallIds: string[] = [];
  const operators = located.operators;
  for (let round = 1; ; round += 1) {
    const choice = {
      commandId: ids.commandId,
      suggestionSetId: ids.suggestionSetId,
      chosenSuggestionId: located.suggestionId,
      ...(Object.keys(menuChoices).length === 0 ? {} : { menuChoices: { ...menuChoices } }),
    };
    const previewed = await previewMoveChoice(context, sessionId, choice as never, actor);
    if (previewed.status === "previewed")
      return { ok: true, preview: previewed.preview, menuChoices, menuCallIds };
    if (previewed.status === "stale-preview") {
      return {
        ok: false,
        status: 409,
        body: {
          status: "stale",
          diagnostics: [
            { code: "stale-evidence", message: "The proof session moved during translation." },
          ],
        },
      };
    }
    if (previewed.status === "failed") {
      return {
        ok: false,
        status: repositoryFailureStatus(previewed.failure),
        body: { status: "preview-failed", diagnostics: previewed.failure.diagnostics },
      };
    }
    if (round > MAX_MENU_ROUNDS) {
      return {
        ok: false,
        status: 200,
        body: {
          status: "stuck",
          reason: "The move kept asking for more menu choices.",
          diagnostics: [],
        },
      };
    }
    const menus = translatorMenus(previewed.input, operators);
    const menusContext: StepTranslatorContext = {
      kind: "menus",
      nodeId: actionContext.nodeId,
      actionCallId: callId,
      candidateId: candidate.id,
      plan: actionContext.plan,
      step: actionContext.step,
      focus: actionContext.focus,
      suggestion: { name: candidate.label, artifactId: candidate.artifactId },
      menus: menus.menus,
    };
    const asked = await askJev(context, sessionId, ids.menuCallId(round), menusContext, configured);
    if (!asked.ok) return { ok: false, run: asked };
    menuCallIds.push(asked.callId);
    const threshold = minimumConfidence(configured);
    for (const [index, menu] of menus.menus.entries()) {
      const answer = asked.output.answers[menuQuestionId(index)]!;
      if (answer.choice === NO_FITTING_ITEM_CHOICE_ID || answer.confidence < threshold) {
        return {
          ok: false,
          status: 200,
          body: {
            status:
              answer.choice === NO_FITTING_ITEM_CHOICE_ID ? "missing-construction" : "uncertain",
            reason:
              answer.choice === NO_FITTING_ITEM_CHOICE_ID
                ? `The move ${candidate.label} exists, but none of its "${menu.label}" values is the one the step needs.`
                : `Jev is unsure which "${menu.label}" value the step needs.`,
            choice: candidateSummary(candidate),
            menu: { parameterId: menu.parameterId, label: menu.label, items: menu.items },
            menuCallIds,
            truncatedMenus: menus.truncated,
            diagnostics: [],
          },
        };
      }
      menuChoices[menu.parameterId] = answer.choice;
    }
  }
}

/** Record the candidate's suggestion set and find the candidate in it again. */
async function locateCandidate(
  context: ServiceContext,
  sessionId: string,
  actionContext: ActionContext,
  candidate: TranslatorCandidate,
  suggestionSetId: string,
): Promise<
  | Readonly<{ ok: true; suggestionId: string; operators: ProofSession["operators"] }>
  | Readonly<{ ok: false; status: number; body: Record<string, unknown> }>
> {
  const selectionSet = actionContext.selectionSets.find(
    ({ id }) => id === candidate.selectionSetId,
  )!;
  const recorded = await recordSuggestions(
    context,
    sessionId,
    suggestionSetId as never,
    selectionSet.selections,
  );
  if (recorded.status === "invalid-catalog") {
    return {
      ok: false,
      status: 500,
      body: { diagnostics: [{ code: "invalid-catalog", message: recorded.message }] },
    };
  }
  if (recorded.status === "failed") {
    return {
      ok: false,
      status: repositoryFailureStatus(recorded.failure),
      body: { status: "rejected", diagnostics: recorded.failure.diagnostics },
    };
  }
  const suggestion = recorded.suggestionSet.suggestions[candidate.suggestionIndex];
  if (suggestion === undefined || suggestion.artifactId !== candidate.artifactId) {
    return {
      ok: false,
      status: 409,
      body: {
        status: "stale",
        diagnostics: [
          {
            code: "candidates-changed",
            message: "The displayed suggestions changed since the candidates were computed.",
          },
        ],
      },
    };
  }
  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status !== "loaded") {
    return {
      ok: false,
      status: repositoryFailureStatus(loaded),
      body: { diagnostics: loaded.diagnostics },
    };
  }
  return { ok: true, suggestionId: suggestion.id, operators: loaded.session.operators };
}

/** The menus the preview asks for, as Jev questions: each item labelled in LaTeX or text. */
function translatorMenus(
  input: MoveRequiresInput,
  operators: ProofSession["operators"],
): Readonly<{ menus: TranslatorMenu[]; truncated: boolean }> {
  const latex = latexRenderer(operators);
  const missing = new Set(input.missingParameters);
  let truncated = false;
  const menus = input.menus
    .filter(({ parameterId, items }) => missing.has(parameterId) && items.length > 0)
    .slice(0, MAX_TRANSLATOR_MENUS)
    .map((menu) => {
      if (menu.items.length > MAX_TRANSLATOR_MENU_ITEMS) truncated = true;
      return {
        parameterId: menu.parameterId,
        label: criterionLabel(menu.label),
        items: menu.items.slice(0, MAX_TRANSLATOR_MENU_ITEMS).map(({ id, label }) => ({
          id,
          label: criterionLabel(
            label.kind === "text" ? label.text || id : latex.serialize(label.expression),
          ),
        })),
      };
    });
  return { menus, truncated };
}

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

export async function applyPlanStep(
  context: ServiceContext,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = applyRequestSchema.safeParse(body.value);
  if (!requestData.success)
    return writeJson(response, 400, problem("The apply request is invalid."));
  const configured = context.ai?.["step-translator"];
  if (context.llmCalls === undefined) return reply(response, disabled("Step translation"));
  const { callId, candidateId, expectedCurrentNodeId } = requestData.data;
  const read = await readLlmCall(context.llmCalls, sessionOwner(sessionId), callId);
  if (read.status !== "found")
    return writeJson(response, repositoryStatus(read), { diagnostics: read.diagnostics });
  const { record } = read;
  const envelope = record.preparedCall.envelope;
  const output =
    record.status === "completed" && record.evidence.status === "validated"
      ? record.evidence.output
      : undefined;
  if (
    record.role !== "step-translator" ||
    envelope.role !== "step-translator" ||
    envelope.context.kind !== "action" ||
    output?.kind !== "translator-choices"
  ) {
    return reply(
      response,
      diagnostics(409, "move-not-applicable", "Only a validated step translation can be applied.", {
        status: "not-applicable",
      }),
    );
  }
  const actionContext = envelope.context;
  if (actionContext.nodeId !== expectedCurrentNodeId) {
    return reply(
      response,
      diagnostics(409, "stale-evidence", "The move was translated at a different proof node.", {
        status: "stale",
      }),
    );
  }
  const candidate = actionContext.candidates.find(({ id }) => id === candidateId);
  if (candidate === undefined)
    return writeJson(response, 400, problem("The candidate is not one of the call's candidates."));
  const answer = output.answers.action!;
  const threshold =
    configured === undefined ? DEFAULT_TRANSLATOR_MIN_CONFIDENCE : minimumConfidence(configured);
  const actor =
    answer.choice === candidateId && answer.confidence >= threshold ? PROOF_PLAN_ACTOR : WEB_ACTOR;

  const ids = candidateRecordIds(callId, candidate);
  const set = await readDisplayedSuggestionSet(context.store, sessionId, ids.suggestionSetId);
  if (set.status !== "loaded") {
    return reply(
      response,
      diagnostics(409, "move-not-previewed", "Translate the step before applying it.", {
        status: "not-previewed",
      }),
    );
  }
  const suggestion = set.suggestionSet.suggestions[candidate.suggestionIndex];
  if (suggestion === undefined || suggestion.artifactId !== candidate.artifactId) {
    return reply(
      response,
      diagnostics(
        409,
        "candidates-changed",
        "The recorded suggestion does not match the candidate.",
        { status: "stale" },
      ),
    );
  }
  // The menu items Jev chose, read back from the stored menu calls in order.
  const menuChoices: Record<string, string> = {};
  for (let round = 1; round <= MAX_MENU_ROUNDS + 1; round += 1) {
    const menus = await readLlmCall(
      context.llmCalls,
      sessionOwner(sessionId),
      ids.menuCallId(round),
    );
    if (menus.status !== "found") break;
    const menuEnvelope = menus.record.preparedCall.envelope;
    const menuOutput =
      menus.record.status === "completed" && menus.record.evidence.status === "validated"
        ? menus.record.evidence.output
        : undefined;
    if (
      menuEnvelope.role !== "step-translator" ||
      menuEnvelope.context.kind !== "menus" ||
      menuOutput?.kind !== "translator-choices"
    ) {
      break;
    }
    menuEnvelope.context.menus.forEach((menu, index) => {
      const choice = menuOutput.answers[menuQuestionId(index)]?.choice;
      if (choice !== undefined && choice !== NO_FITTING_ITEM_CHOICE_ID)
        menuChoices[menu.parameterId] = choice;
    });
  }
  const choice = {
    commandId: ids.commandId,
    suggestionSetId: ids.suggestionSetId,
    chosenSuggestionId: suggestion.id,
    ...(Object.keys(menuChoices).length === 0 ? {} : { menuChoices }),
  };
  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status === "loaded" && loaded.session.currentNodeId !== expectedCurrentNodeId) {
    // A retry after the move was committed replays it; anything else moved the session on.
    const replay = await applyMoveChoice(context, sessionId, choice as never, undefined, actor);
    if (replay.status === "applied" && replay.executed.replayed)
      return writeApplied(response, replay, callId, candidateId);
    return reply(
      response,
      diagnostics(409, "stale-evidence", "The proof session moved since the move was translated.", {
        status: "stale",
      }),
    );
  }
  const applied = await applyMoveChoice(context, sessionId, choice as never, undefined, actor);
  if (applied.status === "requires-input") {
    return reply(
      response,
      diagnostics(
        409,
        "move-not-previewed",
        "The move still needs menu choices; translate it again.",
        { status: "not-previewed" },
      ),
    );
  }
  if (applied.status === "failed") {
    return writeJson(response, repositoryFailureStatus(applied.failure), {
      status: "rejected",
      diagnostics: applied.failure.diagnostics,
    });
  }
  if (applied.status === "preview-regenerated") {
    return reply(
      response,
      diagnostics(
        409,
        "preview-regenerated",
        "The approved definitions changed; translate the step again.",
        { status: "stale" },
      ),
    );
  }
  writeApplied(response, applied, callId, candidateId);
}

function writeApplied(
  response: ServerResponse,
  applied: Extract<Awaited<ReturnType<typeof applyMoveChoice>>, { status: "applied" }>,
  callId: string,
  candidateId: string,
): void {
  const { receipt } = applied.executed.result;
  writeJson(response, applied.executed.replayed ? 200 : 201, {
    status: "applied",
    callId,
    candidateId,
    replayed: applied.executed.replayed,
    nodeId: applied.node.id,
    receipt,
    diagnostics: [],
  });
}
