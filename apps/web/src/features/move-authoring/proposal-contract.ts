import { z } from "zod";
import { templateDiagnosticSchema, templateReportSchema } from "./api-contract";

/**
 * "Save as reusable move" (architecture §5, refinement §7.1): the browser's side of the move
 * author. The proof service reads the applied step from its own storage, asks a model for a
 * general move, compiles it into an authored-move template and runs the template's examples
 * through the kernel. Nothing here records a draft: the user edits the proposal in the existing
 * authoring form and saves it with the ordinary command.
 */

export const EXTENSION_KINDS = ["macro", "heuristic", "principle"] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export const moveProposalSchema = z
  .object({
    status: z.literal("proposed"),
    callId: z.string().min(1),
    replayed: z.boolean(),
    executorCallId: z.string().min(1),
    revisedCallId: z.string().min(1).optional(),
    /** The proposal compiled into the authored-move template language; it may still be invalid. */
    template: z.record(z.string(), z.unknown()),
    motivation: z.string(),
    classification: z.object({ kind: z.enum(EXTENSION_KINDS), rationale: z.string() }).strict(),
    validation: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), report: templateReportSchema }).strict(),
      z
        .object({ ok: z.literal(false), diagnostics: z.array(templateDiagnosticSchema).min(1) })
        .strict(),
    ]),
    generality: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string(),
          path: z.array(z.union([z.string(), z.number()])).optional(),
        })
        .strict(),
    ),
    /** Present when the proposal cannot be submitted as a move (a new principle). */
    blocked: z
      .object({ code: z.string().min(1), message: z.string() })
      .strict()
      .optional(),
  })
  .loose();
export type MoveProposal = z.infer<typeof moveProposalSchema>;

const insufficientSchema = z
  .object({
    status: z.literal("insufficient-context"),
    result: z.object({ rationale: z.string() }).loose(),
  })
  .loose();
const declinedSchema = z
  .object({ status: z.literal("declined"), result: z.object({ reason: z.string() }).loose() })
  .loose();

const answerSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      data: z.union([moveProposalSchema, insufficientSchema, declinedSchema]),
    })
    .loose(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: z.string(), message: z.string() }).loose(),
    })
    .loose(),
]);

export type MoveProposalRequest = Readonly<{
  /** A fresh call ID for this proposal; the proof service stores the call under it. */
  id: string;
  /** The stored move-executor call whose applied step is to be generalized. */
  executorCallId: string;
  /** A revision names the proposal it revises and says what to change. */
  revision?: Readonly<{ previousCallId: string; feedback: string }>;
}>;

export type MoveProposalOutcome =
  | Readonly<{ kind: "proposed"; proposal: MoveProposal }>
  /** The model asked for more detail or declined; its reason is shown as it is. */
  | Readonly<{ kind: "model-note"; tone: "needs-detail" | "declined"; message: string }>
  | Readonly<{ kind: "error"; message: string }>;

/** The sentence for a refused or unreachable request, by status and code. */
export function describeProposalFailure(status: number, code: string, message: string): string {
  if (status === 429) return "Too many AI requests right now. Wait a minute and try again.";
  if (status === 503 && code === "ai-disabled") {
    return "Saving a step as a reusable move is unavailable: no AI provider is configured for this service.";
  }
  if (status === 503) return "The AI service is not available right now. Try again shortly.";
  if (status === 409 && (code === "plan-not-applied" || code === "executor-call-unavailable")) {
    return "That step is no longer part of the proof (it may have been deleted), so there is nothing to turn into a move.";
  }
  if (status === 409 && code === "not-a-user-instruction") {
    return "Only a step you described in your own words can be turned into a move.";
  }
  if (status === 409 && code === "session-read-only") {
    return "This session is read-only, so no move can be proposed.";
  }
  if (status === 409 && code === "proposal-not-revisable") {
    return "That proposal can no longer be revised. Start again from the proof workspace.";
  }
  if (status === 422 && (code === "invalid-output" || code === "rejected")) {
    return "The model's answer was rejected by the checker (for example, it did not give two positive examples and a negative one). Nothing was saved; try again.";
  }
  return message || "The proof service refused the request.";
}

/** Ask for a proposal. Nothing is recorded as a draft. */
export async function requestMoveProposal(
  sessionId: string,
  request: MoveProposalRequest,
  signal?: AbortSignal,
): Promise<MoveProposalOutcome> {
  let status: number;
  let value: unknown;
  try {
    const response = await fetch(
      `/api/proof-sessions/${encodeURIComponent(sessionId)}/ai-move-author`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        cache: "no-store",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    status = response.status;
    value = await response.json();
  } catch {
    return { kind: "error", message: "The proof service could not be reached. Nothing was saved." };
  }
  const parsed = answerSchema.safeParse(value);
  if (!parsed.success) {
    return {
      kind: "error",
      message: "The proof service returned an invalid response. Nothing was saved.",
    };
  }
  if (!parsed.data.ok) {
    const { code, message } = parsed.data.error;
    return { kind: "error", message: describeProposalFailure(status, code, message) };
  }
  const data = parsed.data.data;
  if (data.status === "insufficient-context") {
    return { kind: "model-note", tone: "needs-detail", message: data.result.rationale };
  }
  if (data.status === "declined") {
    return { kind: "model-note", tone: "declined", message: data.result.reason };
  }
  return { kind: "proposed", proposal: data };
}

// ---------------------------------------------------------------------------------------------
// Handing a proposal from the workspace to the authoring form
// ---------------------------------------------------------------------------------------------

const STASH_PREFIX = "proof-platform:move-proposal:";

function stashKey(sessionId: string, callId: string): string {
  return `${STASH_PREFIX}${sessionId}:${callId}`;
}

/**
 * Keep a proposal for the authoring page, in this tab's session storage (the proof service holds
 * the evidence; this only carries the already-checked answer across one navigation). False when
 * the browser does not allow storage.
 */
export function stashMoveProposal(sessionId: string, proposal: MoveProposal): boolean {
  try {
    window.sessionStorage.setItem(stashKey(sessionId, proposal.callId), JSON.stringify(proposal));
    return true;
  } catch {
    return false;
  }
}

/** The stashed proposal for a call, if this tab still has it and it still parses. */
export function readStashedMoveProposal(
  sessionId: string,
  callId: string,
): MoveProposal | undefined {
  try {
    const text = window.sessionStorage.getItem(stashKey(sessionId, callId));
    if (text === null) return undefined;
    const parsed = moveProposalSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The authoring page address that opens a proposal. */
export function proposalHref(movesHref: string, callId: string): string {
  return `${movesHref}?proposal=${encodeURIComponent(callId)}`;
}
