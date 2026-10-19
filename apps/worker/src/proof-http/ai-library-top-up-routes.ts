/**
 * Library top-ups during a proof (`docs/ai-agents-architecture.md` section 2):
 *
 * - `POST /proof-sessions/:id/ai/library/top-up` asks the librarian for more results while a proof
 *   is in progress. Two request kinds: `new-constants` (a step just made constants active that the
 *   library has no results about) and `no-relevant-results` (the user's selections found nothing
 *   useful). The worker builds the librarian's context deterministically, dispatches one recorded
 *   call, judges every returned result with the admission gate and records the admitted ones, with
 *   their generated variants, as `proof-time-background` additions of the session. There is no
 *   review step. Nothing here touches proof state, and stored suggestion sets are never rewritten;
 *   the next suggestion request simply sees the larger library.
 * - `GET /proof-sessions/:id/library/constants` tells which constants are active, dormant or newly
 *   activated by a committed step, and which activations a recorded top-up already covered.
 *
 * Session-owned evidence, the shared cost guard and replay by call ID work as for the move
 * executor, with one difference: a top-up changes the library, so the context a replay would
 * rebuild differs from the stored one. A request whose call ID is already stored is therefore
 * answered from the stored call (after checking that it is the same kind of request), and its
 * additions, whose event IDs derive from the session, the call and the artifact, are recorded
 * at most once.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readAdditionEvents } from "../library-repository";
import {
  MAX_LIBRARIAN_ACTIVATED_CONSTANTS,
  MAX_LIBRARIAN_CONTEXT_CONSTANTS,
  MAX_LIBRARIAN_CONTEXT_RESULTS,
  MAX_LIBRARIAN_SITUATION_SELECTIONS,
  buildLibrarianContext,
  buildLibrarianSituation,
  prepareLlmCall,
  type LibrarianContext,
  type LibrarianProposal,
  type LibrarianTopUpContext,
  type PreparedLlmCall,
} from "@proof/llm";
import type { LibraryAdditionEvent, LibraryResult } from "@proof/library";
import type { OperatorDeclaration } from "@proof/mathjson-model";
import { resolveProofSelection } from "@proof/selections";
import { z } from "zod";
import {
  coveredConstants,
  loadSessionConstants,
  mentionedSymbols,
  type SessionConstants,
} from "../active-constants";
import {
  addLibraryArtifact,
  type AddLibraryArtifactResult,
  type LibraryStore,
} from "../library-repository";
import { evaluateTopUpProposal, TOP_UP_REVIEWER_ID } from "../library-proposal";
import {
  readLlmCall,
  runDurableLlmCall,
  type LlmCallOwner,
  type StoredLlmCall,
} from "../llm-call-repository";
import { loadCurrentProofSession, type ProofSession } from "../proof-repository";
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
import { stableIdentifierSchema } from "@proof/protocol";

const topUpRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: stableIdentifierSchema,
      kind: z.literal("new-constants"),
      /** Optional symbols to cover; the worker finds the activated constants itself. */
      constants: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(MAX_LIBRARIAN_ACTIVATED_CONSTANTS)
        .refine((symbols) => new Set(symbols).size === symbols.length, "Symbols must be unique.")
        .optional(),
      expectedCurrentNodeId: stableIdentifierSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: stableIdentifierSchema,
      kind: z.literal("no-relevant-results"),
      selections: z
        .array(proofHttpSelectionDescriptorSchema)
        .min(1)
        .max(MAX_LIBRARIAN_SITUATION_SELECTIONS)
        .refine(
          (selections) => selections.every(({ abstraction }) => abstraction === undefined),
          "A top-up describes the concrete selection, not an abstraction.",
        ),
      expectedCurrentNodeId: stableIdentifierSchema.optional(),
    })
    .strict(),
]);
type TopUpRequest = z.infer<typeof topUpRequestSchema>;

/** The origin actor of a top-up's additions: the recorded call, which holds the provenance. */
function callActorId(callId: string): string {
  return callId.startsWith("llm-call:") ? callId : `llm-call:${callId}`;
}

/** The deterministic ID of the addition that records an artifact for a session and a call. */
export function topUpEventId(sessionId: string, callId: string, artifactId: string): string {
  return `${topUpEventPrefix(sessionId, callId)}${artifactId}`;
}
function topUpEventPrefix(sessionId: string, callId: string): string {
  return `library-addition:${sessionId}:top-up:${callId}:`;
}

type Outcome = Readonly<{ status: number; body: unknown }>;
function refuse(status: number, code: string, message: string, extra: object = {}): Outcome {
  return { status, body: { ...extra, diagnostics: [{ code, message }] } };
}

// ---------------------------------------------------------------------------------------------
// POST /proof-sessions/:id/ai/library/top-up
// ---------------------------------------------------------------------------------------------

export async function topUpLibrary(
  context: ServiceContext,
  sessionId: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const reply = (outcome: Outcome) => writeJson(response, outcome.status, outcome.body);
  const body = await readBody(request);
  if (!body.ok) return writeJson(response, body.status, problem(body.message));
  const parsed = topUpRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return writeJson(response, 400, problem("The library top-up request is invalid."));
  }
  const requested = parsed.data;
  const configured = context.ai?.librarian;
  if (configured === undefined || context.llmCalls === undefined) {
    return reply(
      refuse(
        503,
        "ai-disabled",
        "Library top-ups are unavailable because their provider is not configured.",
        { status: "disabled" },
      ),
    );
  }
  if (context.library === undefined) {
    return reply(
      refuse(503, "library-unavailable", "Library storage is unavailable.", { status: "disabled" }),
    );
  }

  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status !== "loaded") {
    return writeJson(response, repositoryFailureStatus(loaded), {
      diagnostics: loaded.diagnostics,
    });
  }
  if (loaded.session.readOnly === true) {
    return reply(
      refuse(409, "session-read-only", "The library of a read-only session cannot grow.", {
        status: "read-only",
      }),
    );
  }

  const owner: LlmCallOwner = { kind: "proof-session", id: sessionId };
  const stored = await readLlmCall(context.llmCalls, owner, requested.id);
  let record: StoredLlmCall;
  let replayed: boolean;
  if (stored.status === "found") {
    const conflict = replayConflict(requested, loaded, stored.record);
    if (conflict !== undefined) return reply(conflict);
    record = stored.record;
    replayed = true;
  } else if (stored.diagnostics[0].code !== "call-not-found") {
    return writeJson(response, repositoryStatus(stored), { diagnostics: stored.diagnostics });
  } else {
    if (
      requested.expectedCurrentNodeId !== undefined &&
      loaded.session.currentNodeId !== requested.expectedCurrentNodeId
    ) {
      return reply(
        refuse(409, "stale-evidence", "The proof session moved since the request was prepared.", {
          status: "stale",
        }),
      );
    }
    const prepared = await prepareContext(context, sessionId, requested, loaded);
    if (!prepared.ok) return reply(prepared.outcome);
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
    record = result.record;
    replayed = result.replayed;
  }

  if (record.status !== "completed") {
    return writeJson(response, 503, problem("The library top-up call outcome is uncertain."));
  }
  const evidence = record.evidence;
  if (evidence.status !== "validated" || evidence.output === undefined) {
    return writeJson(response, evidence.status === "transport-failed" ? 503 : 422, {
      status: evidence.status,
      callId: record.id,
      replayed,
      diagnostics: evidence.diagnostics,
    });
  }
  const output = evidence.output;
  const envelope = record.preparedCall.envelope;
  if (envelope.role !== "librarian" || envelope.context.kind === "initial") {
    return reply(
      refuse(409, "call-id-conflict", "The call ID belongs to another kind of request."),
    );
  }
  const topUp = envelope.context;
  if (output.kind !== "library-proposal") {
    return writeJson(response, 200, {
      status: output.kind,
      callId: record.id,
      replayed,
      requestKind: topUp.kind,
      result: output,
    });
  }
  return reply(
    await recordTopUp(context, context.library, loaded.session, {
      callId: record.id,
      replayed,
      topUp,
      proposal: output,
    }),
  );
}

/** A replay must be the same kind of request as the stored call; otherwise the ID was reused. */
function replayConflict(
  requested: TopUpRequest,
  loaded: Extract<Awaited<ReturnType<typeof loadCurrentProofSession>>, { status: "loaded" }>,
  record: StoredLlmCall,
): Outcome | undefined {
  const conflict = (message: string) => refuse(409, "call-id-conflict", message);
  const envelope = record.preparedCall.envelope;
  if (record.role !== "librarian" || envelope.role !== "librarian") {
    return conflict("The call ID is already used by another kind of request.");
  }
  if (envelope.context.kind !== requested.kind) {
    return conflict("The call ID is already used by a different top-up request.");
  }
  if (record.status !== "completed") {
    return refuse(
      503,
      "call-in-progress-or-uncertain",
      "The call was claimed previously; its provider outcome may be unknown.",
    );
  }
  const stored = envelope.context;
  if (requested.kind === "new-constants" && stored.kind === "new-constants") {
    const symbols = new Set(stored.newConstants.map(({ symbol }) => symbol));
    if (
      requested.constants !== undefined &&
      (requested.constants.length !== symbols.size ||
        requested.constants.some((symbol) => !symbols.has(symbol)))
    ) {
      return conflict("The call ID was used for other constants.");
    }
  }
  if (requested.kind === "no-relevant-results" && stored.kind === "no-relevant-results") {
    // When the selections still resolve (the proof has not moved on), they must describe the
    // stored situation; after the proof moved on there is nothing left to compare.
    const situation = situationOf(requested.selections, loaded);
    if (situation.ok && JSON.stringify(situation.situation) !== JSON.stringify(stored.situation)) {
      return conflict("The call ID was used for other selections.");
    }
  }
  return undefined;
}

type Loaded = Extract<Awaited<ReturnType<typeof loadCurrentProofSession>>, { status: "loaded" }>;

function situationOf(
  selections: Extract<TopUpRequest, { kind: "no-relevant-results" }>["selections"],
  loaded: Loaded,
):
  | Readonly<{ ok: true; situation: NonNullable<ReturnType<typeof buildLibrarianSituation>> }>
  | Readonly<{ ok: false; stale: boolean; message: string }> {
  const operators = loaded.session.operators;
  const resolved: unknown[] = [];
  for (const descriptor of selections) {
    const result = resolveProofSelection(loaded.node.state, descriptor, { operators });
    if (!result.ok) {
      return {
        ok: false,
        stale: result.diagnostics[0].code === "stale-state",
        message: result.diagnostics[0].message,
      };
    }
    resolved.push(result.selection);
  }
  const situation = buildLibrarianSituation(resolved, operators);
  return situation === undefined
    ? { ok: false, stale: false, message: "The selections cannot be described to the library." }
    : { ok: true, situation };
}

type PreparedContext =
  Readonly<{ ok: true; call: PreparedLlmCall }> | Readonly<{ ok: false; outcome: Outcome }>;

/** Everything deterministic that precedes the model call. */
async function prepareContext(
  context: ServiceContext,
  sessionId: string,
  requested: TopUpRequest,
  loaded: Loaded,
): Promise<PreparedContext> {
  const fail = (outcome: Outcome): PreparedContext => ({ ok: false, outcome });
  const { session } = loaded;
  const background = session.metadata?.background;
  if (background === undefined) {
    return fail(
      refuse(
        409,
        "background-missing",
        "This session has no background profile, so results cannot be admitted to its library.",
      ),
    );
  }
  if (background.domains === undefined || background.maximumLevel === undefined) {
    return fail(
      refuse(
        409,
        "background-undeclared",
        "This session's background does not declare its domains and maximum level, so the library gate would admit nothing. Revise the background first.",
      ),
    );
  }
  const catalog = context.definitions.catalog(session.operators);
  const state = await loadSessionConstants(context.store, sessionId, catalog.results);
  if (state.status !== "loaded") {
    return fail({
      status: repositoryFailureStatus(state),
      body: { diagnostics: state.diagnostics },
    });
  }

  let situation:
    Extract<LibrarianContext, { kind: "no-relevant-results" }>["situation"] | undefined;
  let newConstants: readonly OperatorDeclaration[] = [];
  if (requested.kind === "no-relevant-results") {
    const described = situationOf(requested.selections, loaded);
    if (!described.ok) {
      return fail(
        described.stale
          ? refuse(409, "stale-evidence", described.message, { status: "stale" })
          : refuse(400, "invalid-request", described.message),
      );
    }
    situation = described.situation;
  } else {
    const covered = await coveredConstants(context.llmCalls!, sessionId);
    if (covered === undefined) {
      return fail(refuse(503, "storage-failure", "The recorded top-ups could not be read."));
    }
    const { activations } = state.constants;
    const unknown = (requested.constants ?? []).filter(
      (symbol) => !activations.some((activation) => activation.symbol === symbol),
    );
    if (unknown.length > 0) {
      return fail(
        refuse(
          409,
          "constant-not-activated",
          `No committed step has activated ${unknown.join(", ")} in this session.`,
        ),
      );
    }
    const wanted = activations.filter(
      ({ symbol }) => !covered.has(symbol) && (requested.constants ?? [symbol]).includes(symbol),
    );
    if (wanted.length === 0) {
      return fail(
        refuse(
          409,
          "no-new-constants",
          "No newly activated constant is waiting for a library top-up.",
        ),
      );
    }
    const symbols = new Set(wanted.map(({ symbol }) => symbol));
    newConstants = session.operators.filter(({ symbol }) => symbols.has(symbol));
  }

  const newSymbols = new Set(newConstants.map(({ symbol }) => symbol));
  const constants = state.constants.active.filter(({ symbol }) => !newSymbols.has(symbol));
  if (constants.length > MAX_LIBRARIAN_CONTEXT_CONSTANTS) {
    return fail(refuse(400, "invalid-request", "The session declares too many constants."));
  }
  const built = buildLibrarianContext({
    id: requested.id,
    kind: requested.kind,
    background,
    constants,
    existingResults: existingResultsFor(catalog.results, newSymbols),
    ...(requested.kind === "new-constants" ? { newConstants } : { situation }),
  });
  if (!built.ok) return fail({ status: 400, body: { diagnostics: built.diagnostics } });
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) return fail({ status: 400, body: { diagnostics: prepared.diagnostics } });
  return { ok: true, call: prepared.call };
}

/**
 * The names and statements of the session library, capped. Results about the constants being
 * topped up come first, then originals before generated variants, each group in catalog order.
 */
function existingResultsFor(results: readonly LibraryResult[], focus: ReadonlySet<string>) {
  const about = (result: LibraryResult) =>
    focus.size > 0 && [...mentionedSymbols(result.statement.expression)].some((s) => focus.has(s));
  const isVariant = (result: LibraryResult) => result.provenance.kind === "derived-variant";
  const rank = (result: LibraryResult) => (about(result) ? 0 : 2) + (isVariant(result) ? 1 : 0);
  return results
    .map((result, position) => ({ result, position }))
    .sort((a, b) => rank(a.result) - rank(b.result) || a.position - b.position)
    .slice(0, MAX_LIBRARIAN_CONTEXT_RESULTS)
    .map(({ result }) => ({
      id: result.id,
      name: result.name.slice(0, 500),
      statement: result.statement.expression,
    }));
}

// ---------------------------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------------------------

type Added = Readonly<{
  id: string;
  name: string;
  description: string;
  renderings: LibraryResult["renderings"];
  variantIds: readonly string[];
  eventId: string;
}>;
type Rejected = Readonly<{
  id: string;
  name: string;
  reasons: readonly string[];
  codes: readonly string[];
}>;

/**
 * Judge the stored proposal and record what the gate admits, once. The verdict is a function of the
 * stored call, the session's operators and background, and its library without this call's own
 * additions; every addition has a deterministic event ID, so doing this again (a replay, or the
 * retry of an interrupted run) records only what is missing.
 */
async function recordTopUp(
  context: ServiceContext,
  library: LibraryStore,
  session: ProofSession,
  input: Readonly<{
    callId: string;
    replayed: boolean;
    topUp: LibrarianTopUpContext;
    proposal: LibrarianProposal;
  }>,
): Promise<Outcome> {
  const { callId, replayed, topUp, proposal } = input;
  const sessionId = session.id;
  const profile = session.metadata?.background;
  if (profile === undefined) {
    return refuse(409, "background-missing", "This session has no background profile.");
  }
  const read = await readAdditionEvents(library, sessionId);
  if (read.status !== "found") {
    return { status: repositoryFailureStatus(read), body: { diagnostics: read.diagnostics } };
  }
  const prefix = topUpEventPrefix(sessionId, callId);
  const own = new Map<string, LibraryAdditionEvent>(
    read.events.filter(({ id }) => id.startsWith(prefix)).map((event) => [event.id, event]),
  );
  const ownArtifactIds = new Set(
    [...own.values()].flatMap((event) =>
      event.admission.decision === "admitted" ? [event.artifact.id] : [],
    ),
  );
  const catalog = context.definitions.catalog(session.operators);
  const known = new Set<string>(catalog.results.map(({ id }) => id));
  const existing: LibraryResult[] = catalog.results.filter(({ id }) => !ownArtifactIds.has(id));
  for (const event of read.events) {
    // Admitted results that the catalog cannot offer still count as taken identifiers.
    if (
      event.admission.decision === "admitted" &&
      event.artifact.kind === "result" &&
      !known.has(event.artifact.id) &&
      !ownArtifactIds.has(event.artifact.id)
    ) {
      existing.push(event.artifact);
    }
  }

  const evaluation = evaluateTopUpProposal({
    callId,
    context: topUp,
    proposal,
    operators: session.operators,
    profile,
    existing,
  });

  const now = (context.now?.() ?? new Date()).toISOString();
  const rejected: Rejected[] = [...evaluation.rejected];
  const added: Added[] = [];
  let recordedNow = 0;

  type Recorded =
    | Readonly<{ kind: "admitted" }>
    | Readonly<{ kind: "rejected"; reasons: readonly string[]; codes: readonly string[] }>
    | Readonly<{ kind: "abort"; outcome: Outcome }>;
  const record = async (artifact: LibraryResult): Promise<Recorded> => {
    const eventId = topUpEventId(sessionId, callId, artifact.id);
    const result: AddLibraryArtifactResult = await addLibraryArtifact(library, {
      id: eventId,
      sessionId,
      occurredAt: own.get(eventId)?.occurredAt ?? now,
      layer: "proof-time-background",
      origin: { kind: "service", actorId: callActorId(callId) },
      artifact,
    });
    if (result.status !== "recorded") {
      const code = result.diagnostics[0].code;
      if (code === "artifact-id-conflict") {
        return {
          kind: "rejected",
          reasons: [result.diagnostics[0].message],
          codes: ["duplicate-id"],
        };
      }
      return {
        kind: "abort",
        outcome: {
          status: repositoryFailureStatus(result),
          body: {
            status: "incomplete",
            callId,
            replayed,
            added,
            rejected,
            diagnostics: [
              {
                code: "top-up-incomplete",
                message: `The library could not record every result (${result.diagnostics[0].message}). Repeating the request with the same call ID finishes it without repeating any result.`,
              },
            ],
          },
        },
      };
    }
    if (!result.admitted) {
      return {
        kind: "rejected",
        reasons: result.event.admission.diagnostics.map(({ message }) => message),
        codes: result.event.admission.diagnostics.map(({ code }) => code),
      };
    }
    if (!result.replayed) recordedNow += 1;
    return { kind: "admitted" };
  };

  for (const entry of evaluation.results) {
    const source = await record(entry.artifact);
    if (source.kind === "abort") return source.outcome;
    if (source.kind === "rejected") {
      rejected.push({
        id: entry.artifact.id,
        name: entry.artifact.name,
        reasons: source.reasons,
        codes: source.codes,
      });
      continue;
    }
    const variantIds: string[] = [];
    for (const variant of entry.variants) {
      const recorded = await record(variant);
      if (recorded.kind === "abort") return recorded.outcome;
      if (recorded.kind === "admitted") variantIds.push(variant.id);
    }
    added.push({
      id: entry.artifact.id,
      name: entry.artifact.name,
      description: entry.artifact.description,
      renderings: entry.artifact.renderings,
      variantIds,
      eventId: topUpEventId(sessionId, callId, entry.artifact.id),
    });
  }

  return {
    status: recordedNow > 0 ? 201 : 200,
    body: {
      status: "topped-up",
      provenance: { kind: "minimal-context-llm", role: "librarian" },
      admittedBy: TOP_UP_REVIEWER_ID,
      callId,
      replayed,
      requestKind: topUp.kind,
      ...(topUp.kind === "new-constants"
        ? { coveredConstants: topUp.newConstants.map(({ symbol }) => symbol) }
        : {}),
      added,
      addedCount: added.length,
      rejected,
      rejectedConstants: evaluation.rejectedConstants,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// GET /proof-sessions/:id/library/constants
// ---------------------------------------------------------------------------------------------

export type SessionConstantsResponse = Readonly<{
  sessionId: string;
  readOnly: boolean;
  /** Symbols of the operators in play. */
  active: readonly string[];
  /** Declared by the approved initial library only; no step has used them yet. */
  dormant: readonly string[];
  /** Constants a committed step made active, with the step and the top-up that covered them. */
  activated: readonly Readonly<{
    symbol: string;
    edgeId: string;
    nodeId: string;
    resultId: string;
    sequence: number | null;
    topUp: Readonly<{ callId: string }> | null;
  }>[];
}>;

/** Describe a session's constants; `diagnostics` carry a failure. */
export async function readSessionConstants(
  context: ServiceContext,
  sessionId: string,
): Promise<
  | SessionConstantsResponse
  | Readonly<{
      status: "rejected" | "uncertain";
      diagnostics: readonly [Readonly<{ code: string; message: string }>];
    }>
> {
  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status !== "loaded") return loaded;
  const catalog = context.definitions.catalog(loaded.session.operators);
  const state = await loadSessionConstants(context.store, sessionId, catalog.results);
  if (state.status !== "loaded") return state;
  const covered =
    context.llmCalls === undefined
      ? new Map<string, string>()
      : ((await coveredConstants(context.llmCalls, sessionId)) ?? new Map<string, string>());
  const constants: SessionConstants = state.constants;
  return {
    sessionId,
    readOnly: loaded.session.readOnly === true,
    active: constants.active.map(({ symbol }) => symbol),
    dormant: constants.dormant.map(({ symbol }) => symbol),
    activated: constants.activations.map((activation) => ({
      symbol: activation.symbol,
      edgeId: activation.edgeId,
      nodeId: activation.nodeId,
      resultId: activation.resultId,
      sequence: activation.sequence ?? null,
      topUp:
        covered.get(activation.symbol) === undefined
          ? null
          : { callId: covered.get(activation.symbol) as string },
    })),
  };
}
