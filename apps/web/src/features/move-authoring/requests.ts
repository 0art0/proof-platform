import {
  createProofEdgeSchema,
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  protocolCommandEnvelopeSchema,
  protocolCommandResponseSchema,
  type DisplayedSuggestionSet,
  type OperatorDeclaration,
  type ProofNode,
  type ProtocolCommandEnvelope,
} from "@proof/protocol";
import { z } from "zod";
import { sessionLibrarySchema, type SessionLibrary } from "../library-drawer/api-contract";
import { proofHistoryApiResponseSchema } from "../stored-proof-workspace/api-contract";
import { WEB_ACTOR, type HistoryEdge } from "../stored-proof-workspace/toolbar-actions";
import {
  authoredMovesApiResponseSchema,
  templateDiagnosticSchema,
  templateValidationApiResponseSchema,
  type AuthoredMoves,
  type ReviewDecision,
  type TemplateDiagnosticView,
  type TemplateValidation,
} from "./api-contract";

export type Outcome<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; status: number; code: string; message: string }>;

const UNAVAILABLE = {
  ok: false,
  status: 0,
  code: "unavailable",
  message: "The proof service could not be reached.",
} as const;

const INVALID = {
  ok: false,
  status: 502,
  code: "invalid_response",
  message: "The proof service returned an invalid response.",
} as const;

function sessionPath(sessionId: string): string {
  return `/api/proof-sessions/${encodeURIComponent(sessionId)}`;
}

export async function fetchAuthoredMoves(
  sessionId: string,
  signal?: AbortSignal,
): Promise<Outcome<AuthoredMoves>> {
  try {
    const response = await fetch(`${sessionPath(sessionId)}/authored-moves`, {
      cache: "no-store",
      ...(signal === undefined ? {} : { signal }),
    });
    const parsed = authoredMovesApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return INVALID;
    return parsed.data.ok
      ? { ok: true, value: parsed.data.data }
      : { ok: false, status: response.status, ...parsed.data.error };
  } catch {
    return UNAVAILABLE;
  }
}

/** Dry-run the template in the session's environment: nothing is recorded. */
export async function requestTemplateValidation(
  sessionId: string,
  template: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<Outcome<TemplateValidation>> {
  try {
    const response = await fetch(`${sessionPath(sessionId)}/authored-moves/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template }),
      cache: "no-store",
      ...(signal === undefined ? {} : { signal }),
    });
    const parsed = templateValidationApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return INVALID;
    return parsed.data.ok
      ? { ok: true, value: parsed.data.data }
      : { ok: false, status: response.status, ...parsed.data.error };
  } catch {
    return UNAVAILABLE;
  }
}

export async function fetchSessionLibrary(
  sessionId: string,
  signal?: AbortSignal,
): Promise<Outcome<SessionLibrary>> {
  try {
    const response = await fetch(`${sessionPath(sessionId)}/library`, {
      cache: "no-store",
      ...(signal === undefined ? {} : { signal }),
    });
    const body: unknown = await response.json();
    const parsed = z
      .union([
        z.object({ ok: z.literal(true), data: sessionLibrarySchema }).strict(),
        z
          .object({
            ok: z.literal(false),
            error: z.object({ code: z.string(), message: z.string() }).strict(),
          })
          .strict(),
      ])
      .safeParse(body);
    if (!parsed.success || parsed.data.ok !== response.ok) return INVALID;
    return parsed.data.ok
      ? { ok: true, value: parsed.data.data }
      : { ok: false, status: response.status, ...parsed.data.error };
  } catch {
    return UNAVAILABLE;
  }
}

export type StoredHistory = Readonly<{
  nodes: readonly ProofNode[];
  edges: readonly HistoryEdge[];
}>;

/** The retained proof-discovery tree, exactly as stored. */
export async function fetchHistory(
  sessionId: string,
  operators: readonly OperatorDeclaration[],
  signal?: AbortSignal,
): Promise<Outcome<StoredHistory>> {
  try {
    const response = await fetch(`${sessionPath(sessionId)}/history`, {
      cache: "no-store",
      ...(signal === undefined ? {} : { signal }),
    });
    const parsed = proofHistoryApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return INVALID;
    if (!parsed.data.ok) return { ok: false, status: response.status, ...parsed.data.error };
    const nodeSchema = createProofNodeSchema({ operators });
    const edgeSchema = createProofEdgeSchema({ operators });
    const nodes = parsed.data.data.nodes.map((value) => nodeSchema.safeParse(value));
    const edges = parsed.data.data.edges.map(({ edge, name }) => ({
      name,
      parsed: edgeSchema.safeParse(edge),
    }));
    if (nodes.some((node) => !node.success) || edges.some(({ parsed }) => !parsed.success)) {
      return INVALID;
    }
    return {
      ok: true,
      value: {
        nodes: nodes.map((node) => node.data as ProofNode),
        edges: edges.map(({ name, parsed }) => ({ name, edge: parsed.data! })),
      },
    };
  } catch {
    return UNAVAILABLE;
  }
}

const suggestionSetResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      data: z.object({ suggestionSet: displayedSuggestionSetSchema }).loose(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
]);

/** The displayed suggestion set a stored edge was applied from (static history). */
export async function fetchSuggestionSet(
  sessionId: string,
  suggestionSetId: string,
  signal?: AbortSignal,
): Promise<Outcome<DisplayedSuggestionSet>> {
  try {
    const response = await fetch(
      `${sessionPath(sessionId)}/suggestion-sets/${encodeURIComponent(suggestionSetId)}`,
      { cache: "no-store", ...(signal === undefined ? {} : { signal }) },
    );
    const parsed = suggestionSetResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return INVALID;
    return parsed.data.ok
      ? { ok: true, value: parsed.data.data.suggestionSet }
      : { ok: false, status: response.status, ...parsed.data.error };
  } catch {
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------------------------
// Commands (the same envelope protocol humans and agents use)
// ---------------------------------------------------------------------------------------------

export function authoringCommandId(action: "author" | "review"): string {
  return `command:web-${action}-move-${crypto.randomUUID()}`;
}

/** Save a template as a draft revision. The acting human is the author. */
export function authorDraftEnvelope(
  commandId: string,
  template: Readonly<Record<string, unknown>>,
): ProtocolCommandEnvelope {
  return protocolCommandEnvelopeSchema.parse({
    commandId,
    actor: WEB_ACTOR,
    command: {
      kind: "author-move-draft",
      template,
      payloadSource: "reviewed-authoring",
    },
  });
}

/** Decide a draft. The acting human is the reviewer; the decision is recorded with the notes. */
export function reviewEnvelope(
  commandId: string,
  draftArtifactId: string,
  decision: ReviewDecision,
  notes: string,
): ProtocolCommandEnvelope {
  return protocolCommandEnvelopeSchema.parse({
    commandId,
    actor: WEB_ACTOR,
    command: {
      kind: "review-move-draft",
      draftArtifactId,
      decision,
      notes,
      payloadSource: "reviewed-authoring",
    },
  });
}

const authorResultSchema = z
  .object({
    artifactId: z.string(),
    moveId: z.string(),
    revision: z.number().int().positive(),
    definitionDigest: z.string(),
    status: z.literal("draft"),
    validation: z.union([
      z.object({ ok: z.literal(true), report: z.unknown() }).passthrough(),
      z
        .object({ ok: z.literal(false), diagnostics: z.array(templateDiagnosticSchema) })
        .passthrough(),
    ]),
  })
  .passthrough();

const reviewResultSchema = z
  .object({
    artifactId: z.string(),
    draftArtifactId: z.string(),
    moveId: z.string(),
    decision: z.enum(["approved", "rejected", "changes-requested"]),
    definitionDigest: z.string(),
    retrievable: z.boolean(),
  })
  .passthrough();

export type AuthoredDraft = z.infer<typeof authorResultSchema>;
export type ReviewedDraft = z.infer<typeof reviewResultSchema>;

export type AuthoringFailure = Readonly<{
  ok: false;
  status: number;
  code: string;
  message: string;
  /** The template validation diagnostics a refused request carried. */
  validation?: readonly TemplateDiagnosticView[];
}>;

export type AuthoringOutcome<Result> =
  Readonly<{ ok: true; replayed: boolean; result: Result }> | AuthoringFailure;

const failureDetailsSchema = z
  .object({ validation: z.array(templateDiagnosticSchema) })
  .passthrough();

async function postAuthoringCommand<Result>(
  sessionId: string,
  envelope: ProtocolCommandEnvelope,
  resultSchema: z.ZodType<Result>,
): Promise<AuthoringOutcome<Result>> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(`${sessionPath(sessionId)}/protocol-commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      cache: "no-store",
    });
    body = await response.json();
  } catch {
    return UNAVAILABLE;
  }
  const parsed = z
    .discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
      z
        .object({
          ok: z.literal(false),
          error: z.object({ code: z.string().min(1), message: z.string() }).strict(),
          details: z.unknown().optional(),
        })
        .strict(),
    ])
    .safeParse(body);
  if (!parsed.success || parsed.data.ok !== response.ok) return INVALID;
  if (!parsed.data.ok) {
    const details = failureDetailsSchema.safeParse(parsed.data.details);
    return {
      ok: false,
      status: response.status,
      code: parsed.data.error.code,
      message: parsed.data.error.message || "The command was refused without a reason.",
      ...(details.success ? { validation: details.data.validation } : {}),
    };
  }
  const committed = protocolCommandResponseSchema.safeParse(parsed.data.data);
  if (!committed.success || committed.data.commandId !== envelope.commandId) return INVALID;
  const result = resultSchema.safeParse(committed.data.result);
  if (!result.success) return INVALID;
  return { ok: true, replayed: committed.data.replayed, result: result.data };
}

export function postAuthorDraft(
  sessionId: string,
  envelope: ProtocolCommandEnvelope,
): Promise<AuthoringOutcome<AuthoredDraft>> {
  return postAuthoringCommand(sessionId, envelope, authorResultSchema);
}

export function postReview(
  sessionId: string,
  envelope: ProtocolCommandEnvelope,
): Promise<AuthoringOutcome<ReviewedDraft>> {
  return postAuthoringCommand(sessionId, envelope, reviewResultSchema);
}
