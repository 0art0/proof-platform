import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildBackgroundProposerContext,
  buildMoveShortlisterContext,
  buildProofStateFormalizerContext,
  buildTopicExtractorContext,
  prepareLlmCall,
  SUPPORTED_LLM_ROLES,
  type BackgroundProposal,
} from "@proof/llm";
import {
  PROBLEM_SETUP_SORT_CHOICES,
  problemDraftSchema,
  type OperatorDeclaration,
  stableIdentifierSchema,
  suggestionSetIdSchema,
} from "@proof/protocol";
import { createExecutableProofStateSchema, type ExecutableProofState } from "@proof/mathjson-model";
import { starterLibraryPacks } from "@proof/library";
import { z } from "zod";
import {
  resolveSessionOperators,
  unapprovedConstantDiagnostics,
  validateProblemDraft,
} from "../problem-setup";
import {
  approvedBackgroundReferenceSchema,
  loadApprovedConstants,
  resolveAgainstRegistry,
} from "../approved-background";
import {
  listLlmCalls,
  readLlmCall,
  recordBackgroundProposalDecision,
  recordTopicProposalDecision,
  runDurableLlmCall,
  storedLlmCallSchema,
  type LlmCallOwner,
} from "../llm-call-repository";
import {
  loadCurrentProofSession,
  jsonEquals,
  proofSessionIdSchema,
  readDisplayedSuggestionSet,
} from "../proof-repository";
import { type ServiceContext } from "./shared";
import {
  LIMIT_MESSAGE,
  WEB_REVIEWER_ID,
  admitProviderCall,
  methodNotAllowed,
  pathSegments,
  problem,
  readBody,
  repositoryStatus,
  writeJson,
} from "./ai-http";
import { decideLibrary, proposeLibrary } from "./ai-library-routes";
import {
  approvedLibraryReferenceSchema,
  formalizerLibraryResults,
  loadApprovedLibrary,
} from "../approved-library";
import type { ApprovedInitialLibrary } from "../library-proposal";

const formalizeRequestSchema = z
  .object({
    constructionId: stableIdentifierSchema,
    id: stableIdentifierSchema,
    problem: z
      .object({ title: z.string().min(1).max(500), statement: z.string().min(1).max(20_000) })
      .strict(),
    background: z.unknown(),
    preferences: z.unknown().optional(),
    libraryLayerIds: z.array(stableIdentifierSchema).max(4),
    packs: z.array(stableIdentifierSchema).max(7),
    /** The approved background whose constants the formalizer may use; resolved from storage. */
    approvedBackground: approvedBackgroundReferenceSchema.optional(),
    /** The approved initial library whose results the formalizer is shown; resolved from storage. */
    approvedLibrary: approvedLibraryReferenceSchema.optional(),
  })
  .strict();
const backgroundRequestSchema = z
  .object({
    constructionId: stableIdentifierSchema,
    id: stableIdentifierSchema,
    problem: formalizeRequestSchema.shape.problem,
    preferences: z.unknown().optional(),
    /** A revision names a stored call of this construction; its proposal is read from storage. */
    revision: z
      .object({
        previousCallId: stableIdentifierSchema,
        feedback: z.string().trim().min(1).max(4_000),
      })
      .strict()
      .optional(),
  })
  .strict();
const topicRequestSchema = z
  .object({
    constructionId: stableIdentifierSchema,
    id: stableIdentifierSchema,
    problem: formalizeRequestSchema.shape.problem,
    background: z.unknown(),
    preferences: z.unknown().optional(),
  })
  .strict();
const proposalDecisionRequestSchema = z
  .object({
    constructionId: stableIdentifierSchema,
    decisionId: stableIdentifierSchema,
    callId: stableIdentifierSchema,
    decision: z.enum(["approved", "rejected"]),
    rationale: z.string().trim().min(1).max(2_000),
    /** Chosen once by the reviewer's client, so a retried decision is idempotent. */
    decidedAt: z.string().datetime({ offset: true }),
  })
  .strict();
const shortlistRequestSchema = z
  .object({
    id: stableIdentifierSchema,
    expectedCurrentNodeId: stableIdentifierSchema,
    suggestionSetId: suggestionSetIdSchema,
    candidateIds: z.array(stableIdentifierSchema).min(1).max(32),
    trigger: z.enum(["deterministic-empty", "explicit-user"]),
    maxChoices: z.number().int().min(1).max(8).optional(),
  })
  .strict()
  .superRefine((request, issue) => {
    if (new Set(request.candidateIds).size !== request.candidateIds.length) {
      issue.addIssue({
        code: "custom",
        path: ["candidateIds"],
        message: "Candidate IDs must be unique.",
      });
    }
  });

const aiCallListSchema = z.object({ records: z.array(storedLlmCallSchema) }).strict();
const aiCallReadSchema = z.object({ record: storedLlmCallSchema }).strict();

/** Handle bounded AI endpoints and owner-scoped read-only evidence routes. */
export async function handleAiRoute(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const path = pathSegments(request.url);
  if (path === undefined) return false;

  if (path.length === 2 && path[0] === "ai" && path[1] === "capabilities") {
    if (request.method !== "GET") return methodNotAllowed(response, "GET");
    writeJson(response, 200, capabilities(context));
    return true;
  }

  if (path.length === 2 && path[0] === "ai" && path[1] === "topics") {
    if (request.method !== "POST") return methodNotAllowed(response, "POST");
    await extractTopics(context, request, response);
    return true;
  }

  if (path.length === 3 && path[0] === "ai" && path[1] === "topics" && path[2] === "decisions") {
    if (request.method !== "POST") return methodNotAllowed(response, "POST");
    await decideTopics(context, request, response);
    return true;
  }

  if (path.length === 2 && path[0] === "ai" && path[1] === "background") {
    if (request.method !== "POST") return methodNotAllowed(response, "POST");
    await proposeBackground(context, request, response);
    return true;
  }

  if (
    path.length === 3 &&
    path[0] === "ai" &&
    path[1] === "background" &&
    path[2] === "decisions"
  ) {
    if (request.method !== "POST") return methodNotAllowed(response, "POST");
    await decideBackground(context, request, response);
    return true;
  }

  if (path.length === 2 && path[0] === "ai" && path[1] === "library") {
    if (request.method !== "POST") return methodNotAllowed(response, "POST");
    await proposeLibrary(context, request, response);
    return true;
  }

  if (path.length === 3 && path[0] === "ai" && path[1] === "library" && path[2] === "decisions") {
    if (request.method !== "POST") return methodNotAllowed(response, "POST");
    await decideLibrary(context, request, response);
    return true;
  }

  if (path.length === 2 && path[0] === "ai" && path[1] === "formalize") {
    if (request.method !== "POST") return methodNotAllowed(response, "POST");
    await formalize(context, request, response);
    return true;
  }

  if (path[0] === "proof-sessions" && path.length >= 2) {
    const parsedSessionId = proofSessionIdSchema.safeParse(path[1]);
    if (!parsedSessionId.success) return false;
    if (path.length === 4 && path[2] === "ai" && path[3] === "shortlist") {
      if (request.method !== "POST") return methodNotAllowed(response, "POST");
      await shortlist(context, parsedSessionId.data, request, response);
      return true;
    }
    if (path[2] === "llm-calls" && (path.length === 3 || path.length === 4)) {
      if (request.method !== "GET") return methodNotAllowed(response, "GET");
      await readEvidence(
        context,
        { kind: "proof-session", id: parsedSessionId.data },
        path[3],
        response,
      );
      return true;
    }
  }

  if (path[0] === "constructions" && path.length >= 2) {
    const ownerId = stableIdentifierSchema.safeParse(path[1]);
    if (!ownerId.success) return false;
    if (path[2] === "llm-calls" && (path.length === 3 || path.length === 4)) {
      if (request.method !== "GET") return methodNotAllowed(response, "GET");
      await readEvidence(context, { kind: "construction", id: ownerId.data }, path[3], response);
      return true;
    }
  }
  return false;
}

/** Which roles can reach a provider; no configuration detail or credential is disclosed. */
function capabilities(context: ServiceContext) {
  return {
    roles: Object.fromEntries(
      SUPPORTED_LLM_ROLES.map((role) => [
        role,
        context.ai?.[role] !== undefined && context.llmCalls !== undefined,
      ]),
    ),
  };
}

/**
 * Propose a topic and vocabulary manifest (design plan §4.2). The manifest is recorded evidence
 * only: it changes no proof state and no library until a human records a decision on it.
 */
async function extractTopics(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = topicRequestSchema.safeParse(body.value);
  if (!requestData.success)
    return writeJson(response, 400, problem("The topic request is invalid."));
  const preferences =
    requestData.data.preferences === undefined
      ? undefined
      : problemDraftSchema.shape.preferences.safeParse(requestData.data.preferences);
  if (preferences !== undefined && !preferences.success) {
    return writeJson(response, 400, problem("The topic request preferences are invalid."));
  }
  const configured = context.ai?.["topic-extractor"];
  if (configured === undefined || context.llmCalls === undefined) {
    return writeJson(response, 503, {
      status: "disabled",
      diagnostics: [
        {
          code: "ai-disabled",
          message: "Topic suggestions are unavailable because their provider is not configured.",
        },
      ],
    });
  }
  const { constructionId, id, problem: problemText, background } = requestData.data;
  const built = buildTopicExtractorContext({
    id,
    problem: `${problemText.title}\n\n${problemText.statement}`,
    background,
    ...(preferences?.data === undefined
      ? {}
      : {
          preferences: {
            domains: preferences.data.domains ?? [],
            notation: preferences.data.notation ?? [],
          },
        }),
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
    return writeJson(response, 503, problem("The topic call outcome is uncertain."));
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
  if (evidence.output.kind !== "topic-manifest") {
    return writeJson(response, 200, {
      status: evidence.output.kind,
      callId: result.record.id,
      replayed: result.replayed,
      result: evidence.output,
    });
  }
  return writeJson(response, 200, {
    status: "proposed",
    provenance: { kind: "minimal-context-llm", role: "topic-extractor" },
    callId: result.record.id,
    replayed: result.replayed,
    proposal: evidence.output,
  });
}

/**
 * Record the human decision on a proposed manifest. The proposal is read from the stored call,
 * never from the request, so a client cannot approve text the model did not return.
 */
async function decideTopics(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = proposalDecisionRequestSchema.safeParse(body.value);
  if (!requestData.success)
    return writeJson(response, 400, problem("The topic decision request is invalid."));
  if (context.llmCalls === undefined) {
    return writeJson(response, 503, {
      diagnostics: [{ code: "ai-disabled", message: "LLM evidence storage is unavailable." }],
    });
  }
  const { constructionId, decisionId, callId, decision, rationale, decidedAt } = requestData.data;
  const owner: LlmCallOwner = { kind: "construction", id: constructionId };
  const stored = await readLlmCall(context.llmCalls, owner, callId);
  if (stored.status !== "found") {
    return writeJson(response, repositoryStatus(stored), { diagnostics: stored.diagnostics });
  }
  const record = stored.record;
  if (
    record.status !== "completed" ||
    record.role !== "topic-extractor" ||
    record.evidence.status !== "validated" ||
    record.evidence.output?.kind !== "topic-manifest"
  ) {
    return writeJson(response, 409, {
      diagnostics: [
        {
          code: "proposal-not-reviewable",
          message: "Only a validated topic proposal can be approved or rejected.",
        },
      ],
    });
  }
  const recorded = await recordTopicProposalDecision(context.llmCalls, {
    id: decisionId,
    owner,
    callId,
    reviewerId: WEB_REVIEWER_ID,
    decidedAt,
    proposal: record.evidence.output,
    rationale,
    decision,
    ...(decision === "approved" ? { approvedManifestId: `topic-manifest:${decisionId}` } : {}),
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
    ...(recorded.approvedManifest === undefined
      ? {}
      : { approvedManifest: recorded.approvedManifest }),
  });
}

/**
 * Propose the background of a problem and the constants that suffice to formalize it
 * (`docs/ai-agents-architecture.md` section 1), or revise an earlier proposal of this
 * construction with the user's feedback. The proposal is recorded evidence only: it changes no
 * proof state until a human records a decision on it, and the previous proposal of a revision is
 * read from storage, never from the request.
 */
async function proposeBackground(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = backgroundRequestSchema.safeParse(body.value);
  if (!requestData.success) {
    return writeJson(response, 400, problem("The background request is invalid."));
  }
  const preferences =
    requestData.data.preferences === undefined
      ? undefined
      : problemDraftSchema.shape.preferences.safeParse(requestData.data.preferences);
  if (preferences !== undefined && !preferences.success) {
    return writeJson(response, 400, problem("The background request preferences are invalid."));
  }
  const configured = context.ai?.["background-proposer"];
  if (configured === undefined || context.llmCalls === undefined) {
    return writeJson(response, 503, {
      status: "disabled",
      diagnostics: [
        {
          code: "ai-disabled",
          message: "Background proposals are unavailable because their provider is not configured.",
        },
      ],
    });
  }
  const { constructionId, id, problem: problemText, revision } = requestData.data;
  const owner: LlmCallOwner = { kind: "construction", id: constructionId };

  let previous:
    | Readonly<{
        previousCallId: string;
        previousProposal: BackgroundProposal;
        feedback: string;
      }>
    | undefined;
  if (revision !== undefined) {
    const stored = await readLlmCall(context.llmCalls, owner, revision.previousCallId);
    if (stored.status !== "found") {
      return writeJson(response, repositoryStatus(stored), { diagnostics: stored.diagnostics });
    }
    const record = stored.record;
    if (
      record.status !== "completed" ||
      record.role !== "background-proposer" ||
      record.evidence.status !== "validated" ||
      record.evidence.output?.kind !== "background-proposal"
    ) {
      return writeJson(response, 409, {
        diagnostics: [
          {
            code: "proposal-not-revisable",
            message: "Only a validated background proposal of this construction can be revised.",
          },
        ],
      });
    }
    previous = {
      previousCallId: revision.previousCallId,
      previousProposal: record.evidence.output,
      feedback: revision.feedback,
    };
  }

  const built = buildBackgroundProposerContext({
    id,
    problem: `${problemText.title}\n\n${problemText.statement}`,
    ...(preferences?.data === undefined
      ? {}
      : {
          preferences: {
            domains: preferences.data.domains ?? [],
            notation: preferences.data.notation ?? [],
          },
        }),
    // The global operator registry (the packs' operators), so that a constant can reference an
    // existing operator with its exact signature instead of clashing with it.
    operators: starterLibraryPacks().flatMap((pack) => pack.operators),
    ...(previous === undefined ? {} : { revision: previous }),
  });
  if (!built.ok) return writeJson(response, 400, { diagnostics: built.diagnostics });
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) return writeJson(response, 400, { diagnostics: prepared.diagnostics });
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
    return writeJson(response, 503, problem("The background call outcome is uncertain."));
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
  if (evidence.output.kind !== "background-proposal") {
    return writeJson(response, 200, {
      status: evidence.output.kind,
      callId: result.record.id,
      replayed: result.replayed,
      result: evidence.output,
    });
  }
  return writeJson(response, 200, {
    status: "proposed",
    provenance: { kind: "minimal-context-llm", role: "background-proposer" },
    callId: result.record.id,
    replayed: result.replayed,
    ...(previous === undefined ? {} : { revisedCallId: previous.previousCallId }),
    proposal: evidence.output,
  });
}

/**
 * Record the human decision on a proposed background. The proposal is read from the stored call,
 * never from the request. An approval is refused when a constant clashes with the global
 * operator registry, so a clash is found when the user accepts, not when the setup is checked.
 */
async function decideBackground(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = proposalDecisionRequestSchema.safeParse(body.value);
  if (!requestData.success) {
    return writeJson(response, 400, problem("The background decision request is invalid."));
  }
  if (context.llmCalls === undefined) {
    return writeJson(response, 503, {
      diagnostics: [{ code: "ai-disabled", message: "LLM evidence storage is unavailable." }],
    });
  }
  const { constructionId, decisionId, callId, decision, rationale, decidedAt } = requestData.data;
  const owner: LlmCallOwner = { kind: "construction", id: constructionId };
  const stored = await readLlmCall(context.llmCalls, owner, callId);
  if (stored.status !== "found") {
    return writeJson(response, repositoryStatus(stored), { diagnostics: stored.diagnostics });
  }
  const record = stored.record;
  if (
    record.status !== "completed" ||
    record.role !== "background-proposer" ||
    record.evidence.status !== "validated" ||
    record.evidence.output?.kind !== "background-proposal"
  ) {
    return writeJson(response, 409, {
      diagnostics: [
        {
          code: "proposal-not-reviewable",
          message: "Only a validated background proposal can be approved or rejected.",
        },
      ],
    });
  }
  if (decision === "approved") {
    const { conflicts } = resolveAgainstRegistry(
      record.evidence.output.constants.map(({ operator }) => operator),
    );
    if (conflicts.length > 0) {
      return writeJson(response, 409, {
        diagnostics: [
          {
            code: "approved-constant-conflict",
            message: `${conflicts.join(" ")} Revise the background so the constant keeps the existing signature, or renames it.`,
          },
        ],
      });
    }
  }
  const recorded = await recordBackgroundProposalDecision(context.llmCalls, {
    id: decisionId,
    owner,
    callId,
    reviewerId: WEB_REVIEWER_ID,
    decidedAt,
    proposal: record.evidence.output,
    rationale,
    decision,
    ...(decision === "approved" ? { approvedManifestId: `background-approval:${decisionId}` } : {}),
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
    ...(recorded.approvedBackground === undefined
      ? {}
      : { approvedBackground: recorded.approvedBackground }),
  });
}

async function formalize(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = formalizeRequestSchema.safeParse(body.value);
  if (!requestData.success)
    return writeJson(response, 400, problem("The formalizer request is invalid."));
  const configured = context.ai?.["proof-state-formalizer"];
  if (configured === undefined || context.llmCalls === undefined) {
    return writeJson(response, 503, {
      status: "disabled",
      diagnostics: [
        {
          code: "ai-disabled",
          message: "The formalizer is unavailable because its provider is not configured.",
        },
      ],
    });
  }
  const { constructionId, approvedBackground, approvedLibrary, ...formalizerInput } =
    requestData.data;
  const packs = starterLibraryPacks();
  const selectedPacks = packs.filter((pack) => formalizerInput.packs.includes(pack.id));
  if (selectedPacks.length !== formalizerInput.packs.length) {
    return writeJson(response, 400, problem("A selected library pack is not available."));
  }
  // The approved constants are resolved from storage by decision ID; the request cannot carry
  // declarations of its own.
  let constants: readonly OperatorDeclaration[] = [];
  if (approvedBackground !== undefined) {
    const loaded = await loadApprovedConstants(
      context.llmCalls,
      constructionId,
      approvedBackground.decisionId,
    );
    if (!loaded.ok) return writeJson(response, loaded.status, { diagnostics: loaded.diagnostics });
    constants = loaded.constants;
  }
  // The same holds for the approved initial library: the decision names result IDs, and the
  // artifacts (and the new constants they apply) are read from the stored librarian call.
  let library: ApprovedInitialLibrary | undefined;
  if (approvedLibrary !== undefined) {
    const loaded = await loadApprovedLibrary(
      context.llmCalls,
      constructionId,
      approvedLibrary.decisionId,
    );
    if (!loaded.ok) return writeJson(response, loaded.status, { diagnostics: loaded.diagnostics });
    library = loaded.library;
  }
  const constantConflicts: string[] = [];
  const { operators: approvedOperators } = resolveSessionOperators(
    formalizerInput.packs,
    packs,
    constants,
    (_code, message, path) => {
      if (path[0] === "approvedBackground" || path[0] === "approvedLibrary") {
        constantConflicts.push(message);
      }
    },
    ["packs"],
    library?.constants ?? [],
  );
  if (constantConflicts.length > 0) {
    return writeJson(response, 409, {
      diagnostics: [{ code: "approved-constant-conflict", message: constantConflicts[0] }],
    });
  }
  const built = buildProofStateFormalizerContext({
    ...formalizerInput,
    approvedLibrary: {
      results: formalizerLibraryResults(selectedPacks, library),
      operators: approvedOperators,
      sorts: PROBLEM_SETUP_SORT_CHOICES.map(({ id }) => id),
    },
  });
  if (!built.ok) return writeJson(response, 400, { diagnostics: built.diagnostics });
  if (built.envelope.role !== "proof-state-formalizer") {
    return writeJson(response, 400, problem("The formalizer context could not be constructed."));
  }
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) return writeJson(response, 400, { diagnostics: prepared.diagnostics });
  const formalizerOwner: LlmCallOwner = { kind: "construction", id: constructionId };
  const limited = await admitProviderCall(context, formalizerOwner, prepared.call.id);
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
      { owner: formalizerOwner, call: prepared.call, dispatch: configured.dispatch },
      configured.transport,
    );
  } finally {
    limited.release();
  }
  if (result.status !== "completed") {
    return writeJson(response, repositoryStatus(result), { diagnostics: result.diagnostics });
  }
  if (result.record.status !== "completed") {
    return writeJson(response, 503, problem("The formalizer call outcome is uncertain."));
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
  if (evidence.output.kind !== "formalization") {
    return writeJson(response, 200, {
      status: evidence.output.kind,
      callId: result.record.id,
      replayed: result.replayed,
      result: evidence.output,
    });
  }
  const submittedContext = built.envelope.context;
  const draft = evidence.output.draft;
  if (
    !jsonEquals(draft.problem, submittedContext.problem) ||
    !jsonEquals(draft.background, submittedContext.background) ||
    !jsonEquals(draft.preferences, submittedContext.preferences) ||
    !jsonEquals(draft.libraryLayerIds, submittedContext.libraryLayerIds) ||
    !jsonEquals(draft.packs, submittedContext.packs)
  ) {
    return writeJson(response, 422, {
      status: "needs-review",
      callId: result.record.id,
      replayed: result.replayed,
      draft,
      diagnostics: [
        {
          code: "invalid-draft",
          message:
            "The formalizer changed the submitted problem, background, preferences, or approved library selection.",
          path: [],
        },
      ],
    });
  }
  // Any operator outside the approved set (the selected packs, the approved constants and the
  // built-in symbols) is reported precisely and returns the draft for review.
  const unapproved = unapprovedConstantDiagnostics(draft, packs, { constants, library });
  if (unapproved.length > 0) {
    return writeJson(response, 422, {
      status: "needs-review",
      callId: result.record.id,
      replayed: result.replayed,
      draft,
      diagnostics: unapproved,
    });
  }
  const admission = validateProblemDraft(draft, packs, { constants, library });
  if (!admission.ok) {
    return writeJson(response, 422, {
      status: "needs-review",
      callId: result.record.id,
      replayed: result.replayed,
      draft,
      diagnostics: admission.diagnostics,
    });
  }
  const proofState: ExecutableProofState = admission.value.rootNode.state;
  const parsedProofState = createExecutableProofStateSchema({
    operators: admission.value.operators,
  }).safeParse(proofState);
  if (!parsedProofState.success) {
    return writeJson(response, 422, {
      status: "needs-review",
      callId: result.record.id,
      replayed: result.replayed,
      draft,
      diagnostics: [
        {
          code: "invalid-root-state",
          message: "The admitted problem draft did not produce a valid executable proof state.",
          path: [],
        },
      ],
    });
  }
  return writeJson(response, 200, {
    status: "ready-for-review",
    provenance: { kind: "minimal-context-llm", role: "proof-state-formalizer" },
    callId: result.record.id,
    replayed: result.replayed,
    proofState,
    draft,
    review: admission.value.review,
  });
}

async function shortlist(
  context: ServiceContext,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const requestData = shortlistRequestSchema.safeParse(body.value);
  if (!requestData.success)
    return writeJson(response, 400, problem("The shortlist request is invalid."));
  let fallbackCandidateIds: string[] = [];
  const respondWithFallback = (
    status: number,
    reason: string,
    stale = false,
    callId?: string,
    replayed?: boolean,
  ) =>
    writeJson(response, status, {
      status: stale ? "stale" : "deterministic-fallback",
      provenance: "deterministic",
      ...(callId === undefined ? {} : { callId }),
      ...(replayed === undefined ? {} : { replayed }),
      ...(stale ? { stale: true } : {}),
      choices: [],
      fallbackCandidateIds,
      diagnostics: [{ code: stale ? "stale-evidence" : "ai-fallback", message: reason }],
    });

  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status !== "loaded") {
    return respondWithFallback(
      loaded.diagnostics[0]?.code === "session-not-found" ? 404 : 503,
      "The proof session could not be loaded.",
    );
  }
  if (loaded.session.currentNodeId !== requestData.data.expectedCurrentNodeId) {
    return respondWithFallback(
      409,
      "The proof session moved since the request was prepared.",
      true,
    );
  }
  const stored = await readDisplayedSuggestionSet(
    context.store,
    sessionId,
    requestData.data.suggestionSetId,
  );
  if (stored.status !== "loaded") {
    return respondWithFallback(409, "The displayed suggestion set is unavailable or stale.", true);
  }
  const requestedCandidateIds = new Set(requestData.data.candidateIds);
  fallbackCandidateIds = stored.suggestionSet.suggestions
    .filter(({ id }) => requestedCandidateIds.has(id))
    .map(({ id }) => id);
  if (fallbackCandidateIds.length !== requestedCandidateIds.size) {
    return respondWithFallback(400, "Every candidate must belong to the displayed suggestion set.");
  }
  if (loaded.session.readOnly === true) {
    return respondWithFallback(409, "AI suggestions cannot be recorded for a read-only session.");
  }
  const built = buildMoveShortlisterContext({
    id: requestData.data.id,
    node: loaded.node,
    suggestionSet: stored.suggestionSet,
    candidateIds: fallbackCandidateIds,
    trigger: requestData.data.trigger,
    ...(requestData.data.maxChoices === undefined
      ? {}
      : { maxChoices: requestData.data.maxChoices }),
    operators: loaded.session.operators,
  });
  if (!built.ok) {
    fallbackCandidateIds = [];
    return respondWithFallback(409, built.diagnostics[0].message, true);
  }
  if (fallbackCandidateIds.length === 1) {
    return respondWithFallback(200, "A single candidate does not need model ranking.");
  }
  const configured = context.ai?.["move-shortlister"];
  if (configured === undefined || context.llmCalls === undefined) {
    return respondWithFallback(200, "The Jev shortlister is not configured.");
  }
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) return respondWithFallback(409, prepared.diagnostics[0].message, true);
  const owner: LlmCallOwner = { kind: "proof-session", id: sessionId };
  const admission = await admitProviderCall(context, owner, prepared.call.id);
  if (!admission.ok) {
    response.setHeader("retry-after", String(admission.retryAfterSeconds));
    return writeJson(response, 429, {
      status: "deterministic-fallback",
      provenance: "deterministic",
      choices: [],
      fallbackCandidateIds,
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
    return respondWithFallback(repositoryStatus(result), result.diagnostics[0].message);
  }
  if (result.record.status !== "completed") {
    return respondWithFallback(503, "The Jev call outcome is uncertain.");
  }
  const latest = await loadCurrentProofSession(context.store, sessionId);
  if (
    latest.status !== "loaded" ||
    latest.session.currentNodeId !== requestData.data.expectedCurrentNodeId
  ) {
    fallbackCandidateIds = [];
    return respondWithFallback(
      409,
      "The proof session moved while the shortlist was being produced.",
      true,
      result.record.id,
      result.replayed,
    );
  }
  const evidence = result.record.evidence;
  if (evidence.status !== "validated" || evidence.output?.kind !== "move-shortlist") {
    return respondWithFallback(
      200,
      evidence.status === "transport-failed"
        ? "The Jev request failed; deterministic suggestions remain available."
        : evidence.output?.kind === "declined"
          ? evidence.output.reason
          : (evidence.diagnostics[0]?.message ?? "Jev did not return an admissible shortlist."),
      false,
      result.record.id,
      result.replayed,
    );
  }
  return writeJson(response, 200, {
    status: "shortlisted",
    provenance: "minimal-context-llm",
    callId: result.record.id,
    replayed: result.replayed,
    suggestionSetId: stored.suggestionSet.id,
    nodeId: loaded.node.id,
    choices: evidence.output.choices,
    fallbackCandidateIds,
    diagnostics: [],
  });
}

async function readEvidence(
  context: ServiceContext,
  owner: LlmCallOwner,
  callId: string | undefined,
  response: ServerResponse,
): Promise<void> {
  if (context.llmCalls === undefined)
    return writeJson(response, 503, {
      diagnostics: [{ code: "ai-disabled", message: "LLM evidence storage is unavailable." }],
    });
  if (callId === undefined) {
    const result = await listLlmCalls(context.llmCalls, owner);
    return result.status === "found"
      ? writeJson(response, 200, aiCallListSchema.parse({ records: result.records }))
      : writeJson(response, repositoryStatus(result), { diagnostics: result.diagnostics });
  }
  const parsedId = stableIdentifierSchema.safeParse(callId);
  if (!parsedId.success) return writeJson(response, 400, problem("The LLM call ID is invalid."));
  const result = await readLlmCall(context.llmCalls, owner, parsedId.data);
  return result.status === "found"
    ? writeJson(response, 200, aiCallReadSchema.parse({ record: result.record }))
    : writeJson(response, repositoryStatus(result), { diagnostics: result.diagnostics });
}
