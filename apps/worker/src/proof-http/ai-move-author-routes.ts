/**
 * The move author's route (architecture section 5, "Save as reusable move"), session-scoped:
 *
 * `POST /proof-sessions/:id/ai/move-author` `{ id, executorCallId, revision? }` proposes a general
 * move from a step the user described in words and applied. The worker reads the stored executor
 * call and its plan (never from the request), checks that the plan was really applied in this
 * session, builds the author's minimal context deterministically, dispatches one recorded call,
 * and then compiles the proposal and runs the authored-move template's own validation in the
 * session's environment. The answer carries the template, the examples' kernel results and the
 * generality notes. Nothing is recorded as a draft: the user submits the (possibly edited)
 * template through the ordinary `author-move-draft` command and it is reviewed like any other.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildMoveAuthorContext, prepareLlmCall } from "@proof/llm";
import { stableIdentifierSchema } from "@proof/protocol";
import { z } from "zod";
import { readLlmCall, runDurableLlmCall, type LlmCallOwner } from "../llm-call-repository";
import {
  evaluateMoveProposal,
  proposalFindings,
  readStoredProposal,
  type ProposalEnvironment,
} from "../move-author-proposal";
import { loadCurrentProofSession, proposalPlanApplied } from "../proof-repository";
import {
  admitProviderCall,
  LIMIT_MESSAGE,
  problem,
  readBody,
  repositoryStatus,
  writeJson,
} from "./ai-http";
import { repositoryFailureStatus, type ServiceContext } from "./shared";

const requestSchema = z
  .object({
    id: stableIdentifierSchema,
    /** The stored move-executor call whose applied step is to be generalized. */
    executorCallId: stableIdentifierSchema,
    /** A revision names a stored proposal of this session; it is read from storage. */
    revision: z
      .object({
        previousCallId: stableIdentifierSchema,
        feedback: z.string().trim().min(1).max(4_000),
      })
      .strict()
      .optional(),
  })
  .strict();

function reply(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra: object = {},
): void {
  writeJson(response, status, { ...extra, diagnostics: [{ code, message }] });
}

/** The environment a session's proposal runs in: its operators and approved results. */
function proposalEnvironment(
  context: ServiceContext,
  operators: ProposalEnvironment["operators"],
): ProposalEnvironment {
  const catalog = context.definitions.catalog(operators);
  return {
    operators,
    ...(catalog.kernelResults === undefined ? {} : { results: catalog.kernelResults }),
    artifactExists: (reference) =>
      reference.kind === "result" && catalog.results.some(({ id }) => id === reference.id),
  };
}

/** Propose a general move from an applied, user-described step. Nothing is recorded as a draft. */
export async function authorMove(
  context: ServiceContext,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = requestSchema.safeParse(body.value);
  if (!requestData.success) {
    return writeJson(response, 400, problem("The move-author request is invalid."));
  }
  const configured = context.ai?.["move-author"];
  if (configured === undefined || context.llmCalls === undefined) {
    return reply(
      response,
      503,
      "ai-disabled",
      "Saving a step as a reusable move is unavailable because its provider is not configured.",
      { status: "disabled" },
    );
  }
  const { id, executorCallId, revision } = requestData.data;

  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status !== "loaded") {
    return writeJson(response, repositoryFailureStatus(loaded), {
      diagnostics: loaded.diagnostics,
    });
  }
  if (loaded.session.readOnly === true) {
    return reply(
      response,
      409,
      "session-read-only",
      "A move cannot be proposed for a read-only session.",
      { status: "read-only" },
    );
  }

  // Only an executor call whose plan was applied in this session, from the user's own words.
  const owner: LlmCallOwner = { kind: "proof-session", id: sessionId };
  const notEligible = (code: string, message: string) =>
    reply(response, 409, code, message, { status: "not-eligible" });
  const executor = await readLlmCall(context.llmCalls, owner, executorCallId);
  if (executor.status !== "found") {
    return notEligible(
      "executor-call-unavailable",
      "This session has no such move-executor step to turn into a move.",
    );
  }
  const executorRecord = executor.record;
  const executorEnvelope = executorRecord.preparedCall.envelope;
  const plan =
    executorRecord.status === "completed" && executorRecord.evidence.status === "validated"
      ? executorRecord.evidence.output
      : undefined;
  if (
    executorRecord.role !== "move-executor" ||
    executorEnvelope.role !== "move-executor" ||
    plan?.kind !== "plan"
  ) {
    return notEligible(
      "executor-call-unavailable",
      "Only a validated move-executor plan can be turned into a move.",
    );
  }
  if (executorEnvelope.context.source !== "user-instruction") {
    return notEligible(
      "not-a-user-instruction",
      "Only a step you described in your own words can be turned into a move.",
    );
  }
  const applied = await proposalPlanApplied(context.store, sessionId, {
    commandIdPrefix: `command:${executorCallId}`,
    callId: executorCallId,
    stepCount: plan.steps.length,
  });
  if (!applied) {
    return notEligible(
      "plan-not-applied",
      "That step was not applied in this session (or has been deleted), so there is nothing to turn into a move.",
    );
  }

  const environment = proposalEnvironment(context, loaded.session.operators);
  let previous:
    | Readonly<{
        previousCallId: string;
        feedback: string;
        previousProposal: unknown;
        previousFindings: unknown;
      }>
    | undefined;
  if (revision !== undefined) {
    const read = await readStoredProposal(context.llmCalls, sessionId, revision.previousCallId);
    if (read.status === "missing") {
      return writeJson(response, repositoryStatus(read.failure), {
        diagnostics: read.failure.diagnostics,
      });
    }
    if (read.status === "not-a-proposal" || read.stored.executorCallId !== executorCallId) {
      return reply(
        response,
        409,
        "proposal-not-revisable",
        "Only a validated move proposal made from this same step can be revised.",
      );
    }
    previous = {
      previousCallId: revision.previousCallId,
      feedback: revision.feedback,
      previousProposal: read.stored.proposal,
      previousFindings: proposalFindings(
        evaluateMoveProposal(read.stored.proposal, read.stored.context, environment),
      ),
    };
  }

  const built = buildMoveAuthorContext({
    id,
    executorCallId,
    executorContext: executorEnvelope.context,
    executorPlan: plan,
    ...(previous === undefined ? {} : { revision: previous }),
  });
  if (!built.ok) {
    return reply(response, 422, built.diagnostics[0].code, built.diagnostics[0].message, {
      status: "rejected",
    });
  }
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) return writeJson(response, 400, { diagnostics: prepared.diagnostics });

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
    return writeJson(response, 503, problem("The move-author call outcome is uncertain."));
  }
  const callId = result.record.id;
  const replayed = result.replayed;
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
  if (output.kind !== "move-proposal") {
    return writeJson(response, 200, { status: output.kind, callId, replayed, result: output });
  }

  const evaluation = evaluateMoveProposal(output, built.envelope.context, environment);
  return writeJson(response, 200, {
    status: "proposed",
    provenance: { kind: "minimal-context-llm", role: "move-author" },
    callId,
    replayed,
    executorCallId,
    ...(previous === undefined ? {} : { revisedCallId: previous.previousCallId }),
    template: evaluation.template,
    motivation: output.motivation,
    classification: output.classification,
    validation: evaluation.validation.ok
      ? { ok: true, report: evaluation.validation.report }
      : { ok: false, diagnostics: evaluation.validation.diagnostics },
    generality: evaluation.generality,
    // A principle is not a move: approving a move cannot add a result (refinement section 7.3).
    ...(output.classification.kind === "principle"
      ? {
          blocked: {
            code: "principle-not-a-move",
            message:
              "The model classifies this as a new mathematical principle. A move cannot add a result by being approved; admit the result to the library instead.",
          },
        }
      : {}),
    diagnostics: [],
  });
}
