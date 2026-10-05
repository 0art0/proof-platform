import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildMoveShortlisterContext,
  buildProofStateFormalizerContext,
  prepareLlmCall,
} from "@proof/llm";
import {
  PROBLEM_SETUP_SORT_CHOICES,
  stableIdentifierSchema,
  suggestionSetIdSchema,
} from "@proof/protocol";
import { createExecutableProofStateSchema, type ExecutableProofState } from "@proof/mathjson-model";
import { starterLibraryPacks } from "@proof/library";
import { z } from "zod";
import { validateProblemDraft } from "../problem-setup";
import {
  listLlmCalls,
  readLlmCall,
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

const MAX_AI_REQUEST_BYTES = 256 * 1024;
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
  const { constructionId, ...formalizerInput } = requestData.data;
  const selectedPacks = starterLibraryPacks().filter((pack) =>
    formalizerInput.packs.includes(pack.id),
  );
  if (selectedPacks.length !== formalizerInput.packs.length) {
    return writeJson(response, 400, problem("A selected library pack is not available."));
  }
  const built = buildProofStateFormalizerContext({
    ...formalizerInput,
    approvedLibrary: {
      results: selectedPacks.flatMap((pack) =>
        pack.results.map(({ id, name, description, statement, premises }) => ({
          id,
          name,
          description,
          statement: statement.expression,
          premises: premises.map((premise) => premise.expression),
        })),
      ),
      operators: selectedPacks.flatMap((pack) => pack.operators),
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
  const admission = validateProblemDraft(draft);
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

const LIMIT_MESSAGE = "The AI request budget is exhausted; retry later.";

type ProviderAdmission =
  | Readonly<{ ok: true; release: () => void }>
  | Readonly<{ ok: false; code: string; retryAfterSeconds: number }>;

/**
 * Reserve limiter budget only when a provider call will really be dispatched: a stored call with
 * the same owner and ID is a replay or conflict and never reaches the provider.
 */
async function admitProviderCall(
  context: ServiceContext,
  owner: LlmCallOwner,
  callId: string,
): Promise<ProviderAdmission> {
  const limiter = context.aiLimiter;
  if (limiter === undefined) return { ok: true, release: () => undefined };
  if (context.llmCalls !== undefined) {
    const existing = await readLlmCall(context.llmCalls, owner, callId);
    if (existing.status === "found") return { ok: true, release: () => undefined };
  }
  return limiter.tryAcquire();
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

type BodyResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; status: 400 | 413 | 415; message: string }>;

async function readBody(request: IncomingMessage): Promise<BodyResult> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    return { ok: false, status: 415, message: "Content-Type must be application/json." };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_AI_REQUEST_BYTES) {
      return { ok: false, status: 413, message: "The AI request is too large." };
    }
    chunks.push(bytes);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400, message: "The request body is not valid JSON." };
  }
}

function pathSegments(requestTarget: string | undefined): string[] | undefined {
  try {
    return new URL(requestTarget ?? "/", "http://proof.local").pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

function methodNotAllowed(response: ServerResponse, method: string): true {
  writeJson(response, 405, {
    diagnostics: [{ code: "method-not-allowed", message: `Use ${method} for this resource.` }],
  });
  return true;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function problem(message: string) {
  return { diagnostics: [{ code: "invalid-request", message }] };
}

function repositoryStatus(result: {
  status: "rejected" | "uncertain";
  diagnostics: readonly [{ code: string }];
}): number {
  if (result.status === "uncertain") return 503;
  if (result.diagnostics[0].code === "call-not-found") return 404;
  if (result.diagnostics[0].code === "call-id-conflict") return 409;
  if (result.diagnostics[0].code === "call-in-progress-or-uncertain") return 503;
  return 400;
}
