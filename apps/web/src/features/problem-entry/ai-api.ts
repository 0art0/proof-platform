import { z } from "zod";

/** Calls to the web application's AI relay routes, with failures reduced to a plain message. */
const apiAnswerSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
    details: z.unknown().optional(),
  }),
]);

export type AiAnswer =
  | Readonly<{ ok: true; data: unknown }>
  | Readonly<{ ok: false; message: string; status?: number; details?: unknown }>;

export async function postAi(url: string, body: unknown): Promise<AiAnswer> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, message: "The proof service could not be reached." };
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  const parsed = apiAnswerSchema.safeParse(value);
  if (!parsed.success || parsed.data.ok !== response.ok) {
    return { ok: false, message: "The proof service returned an invalid response." };
  }
  if (parsed.data.ok) return { ok: true, data: parsed.data.data };
  return {
    ok: false,
    message: failureMessage(response.status, parsed.data.error),
    status: response.status,
    details: parsed.data.details,
  };
}

function failureMessage(status: number, error: Readonly<{ code: string; message: string }>) {
  if (status === 429) return "Too many AI requests right now. Wait a minute and try again.";
  if (error.code === "ai-disabled") return "AI assistance is not configured on this server.";
  if (error.code === "invalid-output") {
    return "The model's answer did not pass validation and was discarded. Nothing changed.";
  }
  return error.message;
}

/** A context request or refusal: the model returned no proposal. */
export const nonProposalSchema = z.object({
  status: z.enum(["insufficient-context", "declined"]),
  result: z.union([
    z.object({
      kind: z.literal("insufficient-context"),
      requestedCategories: z.array(z.string()),
      rationale: z.string(),
    }),
    z.object({ kind: z.literal("declined"), reason: z.string() }),
  ]),
});

export function invalidAnswer(): Readonly<{ kind: "failed"; message: string }> {
  return { kind: "failed", message: "The proof service returned an invalid response." };
}
