import { z } from "zod";

/**
 * The proof-plan panel's calls to the proof service (`docs/motivated-proof-plans.md`). The browser
 * asks for a plan, then for one move of one step at a time; applying names only the stored
 * translation call and its candidate, never a command.
 */

const claimSchema = z.object({ latex: z.string().nullable(), prose: z.string() }).loose();

const stepSchema = z
  .object({
    id: z.string().min(1),
    parent: z.string().nullable(),
    form: z.string().min(1),
    claim: claimSchema.nullable(),
    variables: z.array(z.object({ name: z.string(), sort: z.string() }).loose()),
    assumptions: z.array(claimSchema),
    term: claimSchema.nullable(),
    actsOn: z.array(z.string()),
    by: z
      .object({
        facts: z.array(z.string()),
        results: z.array(z.string()),
        background: z.string().nullable(),
        method: z.string().nullable(),
      })
      .loose(),
    motivation: z.string().nullable(),
  })
  .loose();
export type PlanStep = z.infer<typeof stepSchema>;

const unitSchema = z
  .object({
    stepId: z.string().min(1),
    number: z.string().min(1),
    form: z.string().min(1),
    focus: z.string().min(1),
    unsupported: z.string().optional(),
  })
  .loose();
export type PlanUnit = z.infer<typeof unitSchema>;

const renderedStepSchema = z
  .object({
    claim: z.string().nullable(),
    term: z.string().nullable(),
    assumptions: z.array(z.string().nullable()),
  })
  .loose();

export const planViewSchema = z
  .object({
    status: z.literal("planned"),
    callId: z.string().min(1),
    plan: z
      .object({
        theorem: claimSchema,
        sketch: z.string(),
        steps: z.array(stepSchema).min(1),
      })
      .loose(),
    numbers: z.array(
      z.object({ stepId: z.string(), number: z.string(), level: z.number().int() }).loose(),
    ),
    units: z.array(unitSchema).min(1),
    initialState: z.object({ nodeId: z.string().min(1), goalId: z.string().min(1) }).loose(),
    warnings: z.array(z.object({ stepId: z.string(), message: z.string() }).loose()),
    /** LaTeX serialized from parsed MathJSON; the only LaTeX the panel typesets. */
    rendered: z
      .object({
        theorem: z.string().nullable(),
        steps: z.record(z.string(), renderedStepSchema),
      })
      .loose(),
  })
  .loose();
export type PlanView = z.infer<typeof planViewSchema>;

const candidateSchema = z
  .object({
    id: z.string().min(1),
    label: z.string(),
    artifactId: z.string(),
    selections: z.array(z.string()),
    probability: z.number().optional(),
  })
  .loose();
export type PlanCandidate = z.infer<typeof candidateSchema>;

const outputsSchema = z
  .object({
    focusTargetId: z.string().optional(),
    caseTargets: z.record(z.string(), z.string()).optional(),
    produced: z.array(z.string()),
  })
  .loose();
export type UnitOutputs = z.infer<typeof outputsSchema>;

const translationSchema = z.union([
  z
    .object({
      status: z.literal("proposed"),
      callId: z.string().min(1),
      confidence: z.number(),
      actor: z.object({ kind: z.enum(["agent", "human"]) }).loose(),
      choice: candidateSchema,
      alternatives: z.array(candidateSchema),
      menuChoices: z.record(z.string(), z.string()),
      preview: z
        .object({
          nodeId: z.string().min(1),
          transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
        })
        .loose(),
    })
    .loose(),
  z.object({ status: z.literal("realized"), outputs: outputsSchema }).loose(),
  z
    .object({
      status: z.enum(["no-move", "missing-construction", "uncertain", "unsupported", "stuck"]),
      reason: z.string(),
      callId: z.string().optional(),
      confidence: z.number().optional(),
      candidateCount: z.number().optional(),
      alternatives: z.array(candidateSchema).optional(),
    })
    .loose(),
]);
export type Translation = z.infer<typeof translationSchema>;

const answerSchema = <Data extends z.ZodType>(data: Data) =>
  z.union([
    z.object({ ok: z.literal(true), data }).loose(),
    z
      .object({
        ok: z.literal(false),
        error: z.object({ code: z.string(), message: z.string() }).loose(),
      })
      .loose(),
  ]);

const planAnswerSchema = answerSchema(
  z.union([
    planViewSchema,
    z.object({ status: z.literal("planning"), callId: z.string().min(1) }).loose(),
    z
      .object({
        status: z.enum(["insufficient-context", "declined"]),
        result: z.object({ missing: z.string().optional(), reason: z.string().optional() }).loose(),
      })
      .loose(),
  ]),
);

export type PlanOutcome =
  | Readonly<{ kind: "planned"; view: PlanView }>
  | Readonly<{ kind: "planning"; callId: string }>
  | Readonly<{ kind: "note"; message: string }>
  | Readonly<{ kind: "error"; message: string }>;

export type TranslateRequest = Readonly<{
  id: string;
  planCallId: string;
  stepId: string;
  expectedCurrentNodeId: string;
  start: Readonly<{ nodeId: string; focusTargetId: string }>;
  movesSoFar: readonly string[];
  refs: Readonly<Record<string, readonly string[]>>;
  chosenCandidateId?: string;
}>;

export type TranslateOutcome =
  | Readonly<{ kind: "translated"; translation: Translation }>
  | Readonly<{ kind: "error"; message: string; stale: boolean }>;

export type ApplyOutcome =
  | Readonly<{ kind: "applied"; nodeId: string }>
  | Readonly<{ kind: "error"; message: string; stale: boolean }>;

function failureMessage(status: number, code: string, message: string) {
  if (status === 429)
    return {
      message: "Too many AI requests right now. Wait a minute and try again.",
      stale: false,
    };
  if (status === 503 && code === "ai-disabled") {
    return {
      message: "Proof plans are unavailable: no AI provider is configured for this service.",
      stale: false,
    };
  }
  if (status === 503)
    return {
      message: "The AI service is not available right now. Try again shortly.",
      stale: false,
    };
  if (status === 409 && /stale/.test(code)) {
    return {
      message: "The proof moved on since this was prepared. Nothing was changed.",
      stale: true,
    };
  }
  if (status === 422) {
    return { message: `The model's answer was rejected by the checker: ${message}`, stale: false };
  }
  return { message: message === "" ? "The request failed." : message, stale: false };
}

async function call(
  path: string,
  init: RequestInit,
): Promise<Readonly<{ status: number; json: unknown }>> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

const post = (path: string, body: unknown) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function sessionPath(sessionId: string, suffix: string) {
  return `/api/proof-sessions/${encodeURIComponent(sessionId)}/${suffix}`;
}

function planOutcome(status: number, json: unknown): PlanOutcome {
  const parsed = planAnswerSchema.safeParse(json);
  if (!parsed.success)
    return { kind: "error", message: "The proof service gave an unexpected answer." };
  const answer = parsed.data;
  if (!answer.ok)
    return {
      kind: "error",
      message: failureMessage(status, answer.error.code, answer.error.message).message,
    };
  const data = answer.data;
  if (data.status === "planned") return { kind: "planned", view: data as PlanView };
  if (data.status === "planning")
    return { kind: "planning", callId: (data as { callId: string }).callId };
  const result = (data as { result: { missing?: string; reason?: string } }).result;
  return data.status === "declined"
    ? { kind: "note", message: `The planner declined: ${result.reason ?? ""}` }
    : { kind: "note", message: `The planner needs more context: ${result.missing ?? ""}` };
}

export async function requestProofPlan(
  sessionId: string,
  request: Readonly<{ id: string; expectedCurrentNodeId: string }>,
): Promise<PlanOutcome> {
  try {
    const { status, json } = await post(sessionPath(sessionId, "ai-proof-plan"), request);
    return planOutcome(status, json);
  } catch {
    return { kind: "error", message: "The proof service could not be reached." };
  }
}

export async function readProofPlan(sessionId: string, callId: string): Promise<PlanOutcome> {
  try {
    const { status, json } = await call(
      sessionPath(sessionId, `ai-proof-plan/${encodeURIComponent(callId)}`),
      { method: "GET" },
    );
    return planOutcome(status, json);
  } catch {
    return { kind: "error", message: "The proof service could not be reached." };
  }
}

const translateAnswerSchema = answerSchema(translationSchema);

export async function requestPlanTranslation(
  sessionId: string,
  request: TranslateRequest,
): Promise<TranslateOutcome> {
  try {
    const { status, json } = await post(sessionPath(sessionId, "ai-proof-plan-translate"), request);
    const parsed = translateAnswerSchema.safeParse(json);
    if (!parsed.success)
      return {
        kind: "error",
        message: "The proof service gave an unexpected answer.",
        stale: false,
      };
    if (!parsed.data.ok)
      return {
        kind: "error",
        ...failureMessage(status, parsed.data.error.code, parsed.data.error.message),
      };
    return { kind: "translated", translation: parsed.data.data };
  } catch {
    return { kind: "error", message: "The proof service could not be reached.", stale: false };
  }
}

const applyAnswerSchema = answerSchema(
  z.object({ status: z.literal("applied"), nodeId: z.string().min(1) }).loose(),
);

export async function requestPlanApply(
  sessionId: string,
  request: Readonly<{ callId: string; candidateId: string; expectedCurrentNodeId: string }>,
): Promise<ApplyOutcome> {
  try {
    const { status, json } = await post(sessionPath(sessionId, "ai-proof-plan-apply"), request);
    const parsed = applyAnswerSchema.safeParse(json);
    if (!parsed.success)
      return {
        kind: "error",
        message: "The proof service gave an unexpected answer.",
        stale: false,
      };
    if (!parsed.data.ok)
      return {
        kind: "error",
        ...failureMessage(status, parsed.data.error.code, parsed.data.error.message),
      };
    return { kind: "applied", nodeId: parsed.data.data.nodeId };
  } catch {
    return { kind: "error", message: "The proof service could not be reached.", stale: false };
  }
}
