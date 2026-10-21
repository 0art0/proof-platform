import { operatorDeclarationSchema, stableIdentifierSchema } from "@proof/protocol";
import { z } from "zod";

/**
 * The browser's view of the library top-up routes (`docs/ai-endpoints.md`, "Top up the library
 * during a proof") and of the session's constants. The worker owns the contract; these schemas
 * only decide what the page shows.
 */

/**
 * `GET /proof-sessions/:id/library/constants`: the constants of a session as the records say. The
 * active ones are the setup operators and the constants committed steps activated; the available
 * ones are declared by library results and become active when a step applies such a result.
 */
export const libraryConstantsSchema = z
  .object({
    sessionId: stableIdentifierSchema,
    readOnly: z.boolean(),
    active: z.array(
      z
        .object({
          symbol: z.string().min(1),
          origin: z.enum(["setup", "activated"]),
          operator: operatorDeclarationSchema,
        })
        .strict(),
    ),
    available: z.array(
      z
        .object({
          symbol: z.string().min(1),
          operator: operatorDeclarationSchema,
          /** The library results that apply the constant; applying one activates it. */
          results: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
        })
        .strict(),
    ),
    activated: z.array(
      z
        .object({
          symbol: z.string().min(1),
          sequence: z.number().int(),
          commandId: z.string(),
          edgeId: z.string(),
          nodeId: z.string(),
          resultId: z.string(),
          /** The name of the library result the activating step applied, when it is known. */
          resultName: z.string().nullable(),
          transitionSequence: z.number().int(),
          activatedAt: z.string(),
          /** The recorded top-up that covered the activation, if one did. */
          topUp: z.object({ callId: z.string() }).strict().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type LibraryConstants = z.infer<typeof libraryConstantsSchema>;

const rejectedSchema = z
  .object({ id: z.string(), name: z.string(), reasons: z.array(z.string()) })
  .passthrough();

/** The worker's answers to a top-up request, as the proxy relays them. */
const topUpDataSchema = z.union([
  z
    .object({
      status: z.literal("topped-up"),
      requestKind: z.enum(["new-constants", "no-relevant-results"]),
      addedCount: z.number().int().min(0),
      added: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
      rejected: z.array(rejectedSchema),
    })
    .passthrough(),
  z
    .object({
      status: z.enum(["declined", "insufficient-context"]),
      result: z
        .object({ reason: z.string().optional(), rationale: z.string().optional() })
        .passthrough(),
    })
    .passthrough(),
]);

export const topUpAnswerSchema = z.union([
  z.object({ ok: z.literal(true), data: topUpDataSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type TopUpAnswer = z.infer<typeof topUpAnswerSchema>;

export const constantsAnswerSchema = z.union([
  z.object({ ok: z.literal(true), data: libraryConstantsSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** What to tell the user about a top-up that reached the library. */
export function describeTopUpOutcome(
  data: Extract<TopUpAnswer, { ok: true }>["data"],
): Readonly<{ added: number; message: string }> {
  if (data.status === "topped-up") {
    if (data.addedCount > 0) {
      return {
        added: data.addedCount,
        message: `Added ${plural(data.addedCount, "result")} to the library. Ask for suggestions again to use ${data.addedCount === 1 ? "it" : "them"}.`,
      };
    }
    const reason = data.rejected[0]?.reasons[0];
    return {
      added: 0,
      message:
        reason === undefined
          ? "No new results were added: the library already covers this."
          : `No new results were added: ${lowerFirst(reason)}`,
    };
  }
  const why = data.result.reason ?? data.result.rationale;
  return {
    added: 0,
    message:
      data.status === "declined"
        ? `No new results were added${why === undefined ? "." : `: ${lowerFirst(why)}`}`
        : "No new results were added: the assistant needs more detail about the background.",
  };
}

function lowerFirst(text: string): string {
  const trimmed = text.trim();
  return trimmed.length === 0 ? trimmed : `${trimmed[0]!.toLowerCase()}${trimmed.slice(1)}`;
}

/** Plain words for a failed request, by the worker's diagnostic. */
export function describeTopUpFailure(status: number, code: string, message: string): string {
  if (status === 429) return "Too many AI requests right now. Wait a minute and try again.";
  if (code === "ai-disabled" || status === 503) {
    return "Finding more results is unavailable right now: the library assistant is not reachable or not configured.";
  }
  if (code === "session-read-only") return "This session is read-only, so its library cannot grow.";
  if (code === "stale-evidence") {
    return "The proof moved on while this was being prepared. Select again, then retry.";
  }
  return message;
}
