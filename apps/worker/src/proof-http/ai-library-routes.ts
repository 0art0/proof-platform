/**
 * The librarian's routes (`docs/ai-agents-architecture.md` section 2, initial library):
 *
 * - `POST /ai/library` proposes general library results for the approved background and constants
 *   of a construction. Nothing is written to any library scope: the response is the deterministic
 *   verdict on each proposed result (admitted, with variants, or rejected with reasons).
 * - `POST /ai/library/decisions` records which admitted results the person kept. The request
 *   names result IDs only; the artifacts are read from the stored call.
 *
 * The librarian never sees the problem statement. Its background and constants are resolved from
 * the approved background decision in storage, never from the request.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { starterLibraryPacks, libraryPacksForOperators } from "@proof/library";
import {
  MAX_LIBRARIAN_CONTEXT_RESULTS,
  MAX_LIBRARIAN_RESULTS,
  buildLibrarianContext,
  prepareLlmCall,
} from "@proof/llm";
import { stableIdentifierSchema } from "@proof/protocol";
import { z } from "zod";
import { approvedBackgroundReferenceSchema, loadApprovedConstants } from "../approved-background";
import {
  evaluateLibraryProposal,
  LIBRARY_REVIEWER_ID,
  selectApprovedResults,
} from "../library-proposal";
import {
  libraryProposalOf,
  readLlmCall,
  recordLibraryProposalDecision,
  runDurableLlmCall,
  type LlmCallOwner,
} from "../llm-call-repository";
import { resolveSessionOperators } from "../problem-setup";
import {
  LIMIT_MESSAGE,
  WEB_REVIEWER_ID,
  admitProviderCall,
  problem,
  readBody,
  repositoryStatus,
  writeJson,
} from "./ai-http";
import { type ServiceContext } from "./shared";

const libraryRequestSchema = z
  .object({
    constructionId: stableIdentifierSchema,
    id: stableIdentifierSchema,
    /** The approved background whose profile and constants the librarian works from. */
    approvedBackground: approvedBackgroundReferenceSchema,
    /** The notation packs of the setup: their operators and results are part of the context. */
    packs: z.array(stableIdentifierSchema).max(7),
  })
  .strict();

const libraryDecisionRequestSchema = z
  .object({
    constructionId: stableIdentifierSchema,
    decisionId: stableIdentifierSchema,
    callId: stableIdentifierSchema,
    /** The kept results; the worker reads the artifacts from the stored call. */
    approvedResultIds: z
      .array(stableIdentifierSchema)
      .min(1)
      .max(MAX_LIBRARIAN_RESULTS)
      .refine((ids) => new Set(ids).size === ids.length, "Result IDs must be unique."),
    rationale: z.string().trim().min(1).max(2_000).optional(),
    /** Chosen once by the reviewer's client, so a retried decision is idempotent. */
    decidedAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** Propose initial library results for a construction's approved background and constants. */
export async function proposeLibrary(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = libraryRequestSchema.safeParse(body.value);
  if (!requestData.success) {
    return writeJson(response, 400, problem("The library request is invalid."));
  }
  const configured = context.ai?.librarian;
  if (configured === undefined || context.llmCalls === undefined) {
    return writeJson(response, 503, {
      status: "disabled",
      diagnostics: [
        {
          code: "ai-disabled",
          message: "Library suggestions are unavailable because their provider is not configured.",
        },
      ],
    });
  }
  const { constructionId, id, approvedBackground, packs: selected } = requestData.data;
  const packs = starterLibraryPacks();
  if (
    new Set(selected).size !== selected.length ||
    packs.filter((pack) => selected.includes(pack.id)).length !== selected.length
  ) {
    return writeJson(response, 400, problem("A selected library pack is not available."));
  }

  // The background and its constants come from storage by decision ID; the request cannot carry
  // declarations of its own.
  const loaded = await loadApprovedConstants(
    context.llmCalls,
    constructionId,
    approvedBackground.decisionId,
  );
  if (!loaded.ok) return writeJson(response, loaded.status, { diagnostics: loaded.diagnostics });
  const conflicts: string[] = [];
  const { operators } = resolveSessionOperators(
    selected,
    packs,
    loaded.constants,
    (_code, message) => conflicts.push(message),
    ["packs"],
  );
  if (conflicts.length > 0) {
    return writeJson(response, 409, {
      diagnostics: [{ code: "approved-constant-conflict", message: conflicts[0] }],
    });
  }
  // What the library already holds for these operators, so that the librarian does not repeat it.
  const existingResults = libraryPacksForOperators(operators, packs)
    .flatMap((pack) => pack.results)
    .slice(0, MAX_LIBRARIAN_CONTEXT_RESULTS)
    .map(({ id: resultId, name, statement }) => ({
      id: resultId,
      name,
      statement: statement.expression,
    }));

  const built = buildLibrarianContext({
    id,
    kind: "initial",
    background: loaded.approved.proposal.background,
    constants: operators,
    existingResults,
  });
  if (!built.ok) return writeJson(response, 400, { diagnostics: built.diagnostics });
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) return writeJson(response, 400, { diagnostics: prepared.diagnostics });
  const owner: LlmCallOwner = { kind: "construction", id: constructionId };
  const limited = await admitProviderCall(context, owner, prepared.call.id);
  if (!limited.ok) {
    response.setHeader("retry-after", String(limited.retryAfterSeconds));
    return writeJson(response, 429, {
      status: "rate-limited",
      diagnostics: [{ code: limited.code, message: LIMIT_MESSAGE }],
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
    limited.release();
  }
  if (result.status !== "completed") {
    return writeJson(response, repositoryStatus(result), { diagnostics: result.diagnostics });
  }
  if (result.record.status !== "completed") {
    return writeJson(response, 503, problem("The library call outcome is uncertain."));
  }
  const evidence = result.record.evidence;
  if (evidence.status !== "validated" || evidence.output === undefined) {
    return writeJson(response, evidence.status === "transport-failed" ? 503 : 422, {
      status: evidence.status,
      callId: result.record.id,
      replayed: result.replayed,
      diagnostics: evidence.diagnostics,
    });
  }
  // The verdict is a function of the stored call alone, so a replay answers identically.
  const stored = libraryProposalOf(result.record);
  if (stored === undefined) {
    return writeJson(response, 200, {
      status: evidence.output.kind,
      callId: result.record.id,
      replayed: result.replayed,
      result: evidence.output,
    });
  }
  const evaluation = evaluateLibraryProposal({
    callId: stored.callId,
    context: stored.context,
    proposal: stored.proposal,
  });
  return writeJson(response, 200, {
    status: "proposed",
    provenance: { kind: "minimal-context-llm", role: "librarian" },
    callId: result.record.id,
    replayed: result.replayed,
    requestKind: stored.context.kind,
    results: evaluation.results.map(({ artifact, variants, newConstantSymbols }) => ({
      artifact,
      variants,
      newConstantSymbols,
    })),
    rejected: evaluation.rejected,
    newConstants: evaluation.newConstants,
    rejectedConstants: evaluation.rejectedConstants,
  });
}

/**
 * Record which admitted results the person kept. The artifacts are read from the stored call and
 * the deterministic gate runs again, so only results the gate admitted can be approved.
 */
export async function decideLibrary(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = libraryDecisionRequestSchema.safeParse(body.value);
  if (!requestData.success) {
    return writeJson(response, 400, problem("The library decision request is invalid."));
  }
  if (context.llmCalls === undefined) {
    return writeJson(response, 503, {
      diagnostics: [{ code: "ai-disabled", message: "LLM evidence storage is unavailable." }],
    });
  }
  const { constructionId, decisionId, callId, approvedResultIds, rationale, decidedAt } =
    requestData.data;
  const owner: LlmCallOwner = { kind: "construction", id: constructionId };
  const stored = await readLlmCall(context.llmCalls, owner, callId);
  if (stored.status !== "found") {
    return writeJson(response, repositoryStatus(stored), { diagnostics: stored.diagnostics });
  }
  const proposal = libraryProposalOf(stored.record);
  if (proposal === undefined) {
    return writeJson(response, 409, {
      diagnostics: [
        {
          code: "proposal-not-reviewable",
          message: "Only a validated library proposal can be approved.",
        },
      ],
    });
  }
  const evaluation = evaluateLibraryProposal({
    callId: proposal.callId,
    context: proposal.context,
    proposal: proposal.proposal,
  });
  const kept = selectApprovedResults(evaluation, approvedResultIds, LIBRARY_REVIEWER_ID);
  if (!kept.ok) {
    return writeJson(response, 409, {
      diagnostics: [
        {
          code: "result-not-admitted",
          message: `These results were not admitted by the library checks, so they cannot be approved: ${kept.unknown.join(", ")}.`,
        },
      ],
    });
  }
  // The stored order is the proposal's, whatever order the client listed the results in.
  const ordered = evaluation.results
    .map(({ artifact }) => artifact.id)
    .filter((resultId) => approvedResultIds.includes(resultId));
  const recorded = await recordLibraryProposalDecision(context.llmCalls, {
    id: decisionId,
    owner,
    callId,
    reviewerId: WEB_REVIEWER_ID,
    decidedAt,
    rationale: rationale ?? "Kept in the problem setup form.",
    decision: "approved",
    approvedManifestId: `library-approval:${decisionId}`,
    approvedResultIds: ordered,
  });
  if (recorded.status !== "recorded") {
    const code = recorded.diagnostics[0].code;
    const status =
      recorded.status === "uncertain"
        ? 503
        : code === "decision-id-conflict" || code === "proposal-not-reviewable"
          ? 409
          : 400;
    return writeJson(response, status, { diagnostics: recorded.diagnostics });
  }
  return writeJson(response, recorded.replayed ? 200 : 201, {
    status: "recorded",
    replayed: recorded.replayed,
    decision: recorded.decision,
    approvedLibrary: {
      decisionId,
      callId,
      approvedResultIds: recorded.decision.approvedResultIds,
      variantCount: kept.kept.variants.length,
      addedOperatorSymbols: kept.kept.constants.map(({ symbol }) => symbol),
    },
  });
}
