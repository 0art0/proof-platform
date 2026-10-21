/**
 * The move executor's routes (architecture §5), both session-scoped:
 *
 * - `POST /proof-sessions/:id/ai/execute` describes a step in words. The worker builds the
 *   executor's minimal context deterministically, dispatches one recorded call, runs the returned
 *   plan through the kernel against the current state, and answers with the preview (or the first
 *   failing step). Nothing is committed; the call is session-owned evidence.
 * - `POST /proof-sessions/:id/ai/execute/apply` commits a previewed plan. The plan is read from the
 *   stored call, never from the request, and committed as a sequence of ordinary commands that
 *   each name the call as their provenance.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildMoveExecutorContext,
  executorPlanOperations,
  executorSourceSchema,
  MAX_EXECUTOR_INSTRUCTION_LENGTH,
  prepareLlmCall,
  type ExecutorSource,
} from "@proof/llm";
import { composeTransitionEvidence, composeTransitionClasses } from "@proof/kernel";
import { actorSchema, proofNodeIdSchema, stableIdentifierSchema } from "@proof/protocol";
import { resolveProofSelection } from "@proof/selections";
import { z } from "zod";
import { readLlmCall, runDurableLlmCall, type LlmCallOwner } from "../llm-call-repository";
import { runExecutorPlan } from "../move-executor";
import { executeProposalPlan, loadCurrentProofSession } from "../proof-repository";
import { catalogOperators, sequenceConstants } from "../session-constants";
import {
  admitProviderCall,
  LIMIT_MESSAGE,
  problem,
  readBody,
  repositoryStatus,
  writeJson,
} from "./ai-http";
import {
  proofHttpSelectionDescriptorSchema,
  repositoryFailureStatus,
  type ServiceContext,
} from "./shared";

/** The human behind the web application; they previewed and confirmed the plan. */
const WEB_ACTOR = actorSchema.parse({ id: "actor:web", kind: "human" });

const executeRequestSchema = z
  .object({
    id: stableIdentifierSchema,
    expectedCurrentNodeId: stableIdentifierSchema,
    instruction: z.string().trim().min(1).max(MAX_EXECUTOR_INSTRUCTION_LENGTH),
    source: executorSourceSchema,
    selections: z
      .array(proofHttpSelectionDescriptorSchema)
      .max(16)
      .refine(
        (selections) => selections.every(({ abstraction }) => abstraction === undefined),
        "A move description uses the concrete selection, not an abstraction.",
      )
      .optional(),
    target: z.object({ kind: z.enum(["goal", "obligation"]), id: stableIdentifierSchema }).strict(),
  })
  .strict();

const applyRequestSchema = z
  .object({
    callId: stableIdentifierSchema,
    expectedCurrentNodeId: proofNodeIdSchema,
  })
  .strict();

/** `user-proposal` for the user's own words, `minimal-context-llm` for a suggested technique. */
function provenanceOf(source: ExecutorSource) {
  return source === "user-instruction" ? "user-proposal" : "minimal-context-llm";
}

function diagnostics(status: number, code: string, message: string, extra: object = {}) {
  return { status, body: { ...extra, diagnostics: [{ code, message }] } };
}

function reply(response: ServerResponse, outcome: { status: number; body: unknown }): void {
  writeJson(response, outcome.status, outcome.body);
}

/** Preview a described step: one recorded model call, then the kernel. Nothing is committed. */
export async function executeMove(
  context: ServiceContext,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = executeRequestSchema.safeParse(body.value);
  if (!requestData.success) {
    return writeJson(response, 400, problem("The move-instruction request is invalid."));
  }
  const configured = context.ai?.["move-executor"];
  if (configured === undefined || context.llmCalls === undefined) {
    return reply(
      response,
      diagnostics(
        503,
        "ai-disabled",
        "Move instructions are unavailable because their provider is not configured.",
        { status: "disabled" },
      ),
    );
  }
  const { id, expectedCurrentNodeId, instruction, source, target, selections } = requestData.data;

  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status !== "loaded") {
    return writeJson(response, repositoryFailureStatus(loaded), {
      diagnostics: loaded.diagnostics,
    });
  }
  if (loaded.session.readOnly === true) {
    return reply(
      response,
      diagnostics(409, "session-read-only", "A move cannot be described for a read-only session.", {
        status: "read-only",
      }),
    );
  }
  const stale = (callId?: string, replayed?: boolean) =>
    diagnostics(409, "stale-evidence", "The proof session moved since the request was prepared.", {
      status: "stale",
      ...(callId === undefined ? {} : { callId }),
      ...(replayed === undefined ? {} : { replayed }),
    });
  if (loaded.session.currentNodeId !== expectedCurrentNodeId) return reply(response, stale());

  const operators = loaded.session.operators;
  const resolved = [];
  for (const descriptor of selections ?? []) {
    const result = resolveProofSelection(loaded.node.state, descriptor, { operators });
    if (!result.ok) {
      return writeJson(response, 400, problem(result.diagnostics[0].message));
    }
    resolved.push(result.selection);
  }
  // The model is offered the results valid in the effective operators and those that would
  // activate an available library constant; a plan that applies one adds that constant when it is
  // applied (the command service records the activation).
  const catalog = context.definitions.catalog(catalogOperators(operators, context.definitions));
  const built = buildMoveExecutorContext({
    id,
    node: loaded.node,
    instruction,
    source,
    target,
    selections: resolved,
    operators,
    results: catalog.kernelResults ?? [],
    resultNames: Object.fromEntries(
      catalog.results.map(({ id: resultId, name }) => [resultId, name]),
    ),
  });
  if (!built.ok) return writeJson(response, 400, { diagnostics: built.diagnostics });
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) return writeJson(response, 400, { diagnostics: prepared.diagnostics });

  const owner: LlmCallOwner = { kind: "proof-session", id: sessionId };
  const admission = await admitProviderCall(context, owner, prepared.call.id);
  if (!admission.ok) {
    response.setHeader("retry-after", String(admission.retryAfterSeconds));
    return writeJson(response, 429, {
      status: "rate-limited",
      diagnostics: [{ code: admission.code, message: LIMIT_MESSAGE }],
    });
  }
  let result;
  try {
    result = await runDurableLlmCall(
      context.llmCalls,
      { owner, call: prepared.call, dispatch: configured.dispatch },
      configured.transport,
    );
  } finally {
    admission.release();
  }
  if (result.status !== "completed") {
    return writeJson(response, repositoryStatus(result), { diagnostics: result.diagnostics });
  }
  if (result.record.status !== "completed") {
    return writeJson(response, 503, problem("The move-instruction call outcome is uncertain."));
  }
  const callId = result.record.id;
  const replayed = result.replayed;

  // The model may have taken a while; a session that moved meanwhile has nothing to preview.
  const latest = await loadCurrentProofSession(context.store, sessionId);
  if (latest.status !== "loaded" || latest.session.currentNodeId !== expectedCurrentNodeId) {
    return reply(response, stale(callId, replayed));
  }

  const evidence = result.record.evidence;
  if (evidence.status !== "validated" || evidence.output === undefined) {
    return writeJson(response, evidence.status === "transport-failed" ? 503 : 422, {
      status: evidence.status,
      callId,
      replayed,
      diagnostics: evidence.diagnostics,
    });
  }
  const output = evidence.output;
  if (output.kind !== "plan") {
    return writeJson(response, 200, { status: output.kind, callId, replayed, result: output });
  }

  const provenance = { kind: provenanceOf(source), role: "move-executor" } as const;
  // The plan is run in the effective operators plus the constants its result applications would
  // activate, so the preview sees what the applied steps will.
  const ahead = sequenceConstants(
    context.definitions,
    operators,
    executorPlanOperations(output.steps, { stateId: loaded.node.state.id, callId }),
  );
  const planCatalog = context.definitions.catalog(ahead.operators);
  const run = runExecutorPlan(loaded.node, output.steps, callId, {
    operators: ahead.operators,
    ...(planCatalog.kernelResults === undefined ? {} : { results: planCatalog.kernelResults }),
  });
  if (!run.ok) {
    return writeJson(response, 200, {
      status: "plan-failed",
      provenance,
      callId,
      replayed,
      nodeId: loaded.node.id,
      explanation: output.explanation,
      failure: {
        stepIndex: run.stepIndex,
        stepCount: run.stepCount,
        code: run.code,
        message: run.message,
      },
      diagnostics: [],
    });
  }
  return writeJson(response, 200, {
    status: "previewed",
    provenance,
    callId,
    replayed,
    nodeId: loaded.node.id,
    explanation: output.explanation,
    transitionClass: run.transitionClass,
    evidence: run.evidence,
    steps: run.steps,
    ...(ahead.constants.length === 0 ? {} : { constants: ahead.constants }),
    preview: {
      transitionClass: run.transitionClass,
      evidence: run.evidence,
      beforeState: run.beforeState,
      afterState: run.afterState,
      delta: run.delta,
    },
    diagnostics: [],
  });
}

/**
 * Commit a previewed plan. The plan comes from the stored call; the request names only the call
 * and the node the user previewed it at. A retry replays the recorded commands.
 */
export async function applyExecutedMove(
  context: ServiceContext,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = applyRequestSchema.safeParse(body.value);
  if (!requestData.success) {
    return writeJson(response, 400, problem("The apply request is invalid."));
  }
  if (context.llmCalls === undefined) {
    return reply(
      response,
      diagnostics(503, "ai-disabled", "LLM evidence storage is unavailable.", {
        status: "disabled",
      }),
    );
  }
  const { callId, expectedCurrentNodeId } = requestData.data;
  const owner: LlmCallOwner = { kind: "proof-session", id: sessionId };
  const stored = await readLlmCall(context.llmCalls, owner, callId);
  if (stored.status !== "found") {
    return writeJson(response, repositoryStatus(stored), { diagnostics: stored.diagnostics });
  }
  const { record } = stored;
  const output =
    record.status === "completed" && record.evidence.status === "validated"
      ? record.evidence.output
      : undefined;
  const { envelope } = record.preparedCall;
  if (
    record.role !== "move-executor" ||
    envelope.role !== "move-executor" ||
    output?.kind !== "plan"
  ) {
    return reply(
      response,
      diagnostics(
        409,
        "plan-not-applicable",
        "Only a validated move-executor plan can be applied.",
        { status: "not-applicable" },
      ),
    );
  }
  if (envelope.context.nodeId !== expectedCurrentNodeId) {
    return reply(
      response,
      diagnostics(409, "stale-evidence", "The plan was previewed at a different proof node.", {
        status: "stale",
      }),
    );
  }

  const operations = executorPlanOperations(output.steps, {
    stateId: envelope.context.stateId,
    callId,
  });
  const applied = await executeProposalPlan(
    context.store,
    sessionId,
    {
      commandIdPrefix: `command:${callId}`,
      expectedCurrentNodeId,
      operations,
      proposal: { source: provenanceOf(envelope.context.source), callId },
    },
    WEB_ACTOR,
    context.definitions,
    context.now === undefined ? {} : { now: context.now },
  );
  if (applied.status !== "committed") {
    return writeJson(response, repositoryFailureStatus(applied), {
      status: applied.diagnostics[0].code === "plan-step-failed" ? "plan-failed" : "rejected",
      diagnostics: applied.diagnostics,
    });
  }
  const steps = applied.results.map(({ receipt }, position) => ({
    index: position + 1,
    commandId: receipt.commandId,
    nodeId: receipt.nodeId,
    transitionClass: receipt.transitionClass,
    evidence: receipt.evidence,
  }));
  const last = applied.results.at(-1)?.receipt;
  return writeJson(response, applied.replayed ? 200 : 201, {
    status: "applied",
    provenance: { kind: provenanceOf(envelope.context.source), role: "move-executor" },
    callId,
    replayed: applied.replayed,
    nodeId: last?.nodeId,
    transitionClass: composeTransitionClasses(steps.map(({ transitionClass }) => transitionClass)),
    evidence: composeTransitionEvidence(
      steps.flatMap(({ evidence }) => (evidence === undefined ? [] : [evidence])),
    ),
    steps,
    diagnostics: [],
  });
}
