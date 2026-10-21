import {
  createProofNodeSchema,
  operatorDeclarationSchema,
  proofStateDeltaSchema,
  transitionClassSchema,
  transitionEvidenceSchema,
  type OperatorDeclaration,
  type ProofNode,
} from "@proof/protocol";
import { z } from "zod";
import type { ProofSelectionDescriptor } from "./api-contract";

/**
 * The move-instruction box's calls to the proof service (architecture §5). The browser names a
 * description, the selections and the target; the proof service builds the model's context, runs
 * the kernel, and answers. Applying names only the stored call, never a plan.
 */

export type MoveInstructionRequest = Readonly<{
  /** A fresh call ID for this preview; the proof service stores the call under it. */
  id: string;
  expectedCurrentNodeId: string;
  instruction: string;
  source: "user-instruction" | "shortlisted-technique";
  target: Readonly<{ kind: "goal" | "obligation"; id: string }>;
  selections?: readonly ProofSelectionDescriptor[];
}>;

const provenanceSchema = z
  .object({
    kind: z.enum(["user-proposal", "minimal-context-llm"]),
    role: z.literal("move-executor"),
  })
  .strict();

const stepSchema = z
  .object({
    index: z.number().int().min(1),
    operation: z.object({ kind: z.string().min(1) }).loose(),
    transitionClass: transitionClassSchema,
    evidence: transitionEvidenceSchema,
  })
  .strict();

const previewedSchema = z
  .object({
    status: z.literal("previewed"),
    provenance: provenanceSchema,
    callId: z.string().min(1),
    replayed: z.boolean(),
    nodeId: z.string().min(1),
    explanation: z.string(),
    transitionClass: transitionClassSchema,
    evidence: transitionEvidenceSchema,
    steps: z.array(stepSchema).min(1),
    /** Library constants the plan's steps would add; the preview's states may use them. */
    constants: z.array(operatorDeclarationSchema).optional(),
    preview: z
      .object({
        transitionClass: transitionClassSchema,
        evidence: transitionEvidenceSchema,
        beforeState: z.unknown(),
        afterState: z.unknown(),
        delta: proofStateDeltaSchema,
      })
      .strict(),
  })
  .loose();

const planFailedSchema = z
  .object({
    status: z.literal("plan-failed"),
    provenance: provenanceSchema,
    callId: z.string().min(1),
    nodeId: z.string().min(1),
    explanation: z.string(),
    failure: z
      .object({
        stepIndex: z.number().int().min(1),
        stepCount: z.number().int().min(1),
        code: z.string(),
        message: z.string(),
      })
      .strict(),
  })
  .loose();

const insufficientSchema = z
  .object({
    status: z.literal("insufficient-context"),
    callId: z.string().min(1),
    result: z.object({ rationale: z.string() }).loose(),
  })
  .loose();

const declinedSchema = z
  .object({
    status: z.literal("declined"),
    callId: z.string().min(1),
    result: z.object({ reason: z.string() }).loose(),
  })
  .loose();

const appliedSchema = z
  .object({
    status: z.literal("applied"),
    callId: z.string().min(1),
    replayed: z.boolean(),
    nodeId: z.string().min(1),
    transitionClass: transitionClassSchema,
    steps: z.array(z.object({ index: z.number().int().min(1) }).loose()).min(1),
  })
  .loose();

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

const previewAnswerSchema = answerSchema(
  z.union([previewedSchema, planFailedSchema, insufficientSchema, declinedSchema]),
);
const applyAnswerSchema = answerSchema(appliedSchema);

export type ExecutorSteps = z.infer<typeof previewedSchema>["steps"];

export type ExecutorPreview = Readonly<{
  callId: string;
  nodeId: string;
  provenance: z.infer<typeof provenanceSchema>["kind"];
  explanation: string;
  transitionClass: z.infer<typeof transitionClassSchema>;
  evidence: z.infer<typeof transitionEvidenceSchema>;
  steps: ExecutorSteps;
  beforeState: ProofNode["state"];
  afterState: ProofNode["state"];
  delta: z.infer<typeof proofStateDeltaSchema>;
  /** Library constants that applying the plan would add to the proof's constants. */
  constants?: readonly OperatorDeclaration[];
}>;

export type MoveInstructionOutcome =
  | Readonly<{ kind: "previewed"; preview: ExecutorPreview }>
  | Readonly<{
      kind: "plan-failed";
      callId: string;
      nodeId: string;
      explanation: string;
      failure: z.infer<typeof planFailedSchema>["failure"];
    }>
  /** The model asked for more detail or declined; its reason is shown as it is. */
  | Readonly<{ kind: "model-note"; tone: "needs-detail" | "declined"; message: string }>
  | Readonly<{ kind: "error"; message: string; stale: boolean }>;

/** The sentence for a refused or unreachable request, by status and code. */
export function describeExecutorFailure(
  status: number,
  code: string,
  message: string,
): Readonly<{ message: string; stale: boolean }> {
  if (status === 429) {
    return {
      message: "Too many AI requests right now. Wait a minute and try again.",
      stale: false,
    };
  }
  if (status === 503 && code === "ai-disabled") {
    return {
      message: "Move instructions are unavailable: no AI provider is configured for this service.",
      stale: false,
    };
  }
  if (status === 503) {
    return {
      message: "The AI service is not available right now. Try again shortly.",
      stale: false,
    };
  }
  if (status === 409 && (code === "stale-evidence" || code === "serialized-stale-command")) {
    return {
      message:
        "The proof moved on since this step was previewed. Nothing was changed; preview again.",
      stale: true,
    };
  }
  if (status === 409 && code === "session-read-only") {
    return { message: "This session is read-only, so no step can be applied.", stale: false };
  }
  if (status === 422 && code === "invalid-output") {
    return {
      message:
        "The model's answer was rejected by the checker (for example, it proposed a step that is not allowed). Nothing was changed; try rewording the step.",
      stale: false,
    };
  }
  return { message: message || "The proof service refused the request.", stale: false };
}

async function post(
  sessionId: string,
  resource: "ai-execute" | "ai-execute/apply",
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Readonly<{ status: number; value: unknown }> | undefined> {
  try {
    const response = await fetch(
      `/api/proof-sessions/${encodeURIComponent(sessionId)}/${resource}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return { status: response.status, value: await response.json() };
  } catch {
    return undefined;
  }
}

const UNREACHABLE: MoveInstructionOutcome = {
  kind: "error",
  message: "The proof service could not be reached. Nothing was changed.",
  stale: false,
};
const INVALID: MoveInstructionOutcome = {
  kind: "error",
  message: "The proof service returned an invalid response. Nothing was changed.",
  stale: false,
};

/** Ask for a preview of the described step. Nothing is committed. */
export async function requestMoveInstructionPreview(
  sessionId: string,
  request: MoveInstructionRequest,
  operators: readonly OperatorDeclaration[],
  signal?: AbortSignal,
): Promise<MoveInstructionOutcome> {
  const answer = await post(sessionId, "ai-execute", request, signal);
  if (answer === undefined) return UNREACHABLE;
  const parsed = previewAnswerSchema.safeParse(answer.value);
  if (!parsed.success) return INVALID;
  if (!parsed.data.ok) {
    const { code, message } = parsed.data.error;
    return { kind: "error", ...describeExecutorFailure(answer.status, code, message) };
  }
  const data = parsed.data.data;
  if (data.status === "insufficient-context") {
    return { kind: "model-note", tone: "needs-detail", message: data.result.rationale };
  }
  if (data.status === "declined") {
    return { kind: "model-note", tone: "declined", message: data.result.reason };
  }
  if (data.status === "plan-failed") {
    return {
      kind: "plan-failed",
      callId: data.callId,
      nodeId: data.nodeId,
      explanation: data.explanation,
      failure: data.failure,
    };
  }
  // The plan's states are read in the proof's constants plus the ones its steps would add.
  const added = (data.constants ?? []).filter(
    ({ symbol }) => !operators.some((operator) => operator.symbol === symbol),
  );
  const schema = createProofNodeSchema({ operators: [...operators, ...added] });
  const before = schema.safeParse({ id: "node:preview-before", state: data.preview.beforeState });
  const after = schema.safeParse({ id: "node:preview-after", state: data.preview.afterState });
  if (!before.success || !after.success) return INVALID;
  return {
    kind: "previewed",
    preview: {
      callId: data.callId,
      nodeId: data.nodeId,
      provenance: data.provenance.kind,
      explanation: data.explanation,
      transitionClass: data.transitionClass,
      evidence: data.evidence,
      steps: data.steps,
      beforeState: before.data.state,
      afterState: after.data.state,
      delta: data.preview.delta,
      ...(added.length === 0 ? {} : { constants: added }),
    },
  };
}

export type ApplyOutcome =
  | Readonly<{ kind: "applied"; nodeId: string; stepCount: number; replayed: boolean }>
  | Readonly<{ kind: "error"; message: string; stale: boolean }>;

/** Commit the previewed plan. The proof service reads the plan from its stored call. */
export async function requestMoveInstructionApply(
  sessionId: string,
  request: Readonly<{ callId: string; expectedCurrentNodeId: string }>,
  signal?: AbortSignal,
): Promise<ApplyOutcome> {
  const answer = await post(sessionId, "ai-execute/apply", request, signal);
  if (answer === undefined) return { kind: "error", message: UNREACHABLE_MESSAGE, stale: false };
  const parsed = applyAnswerSchema.safeParse(answer.value);
  if (!parsed.success) return { kind: "error", message: INVALID_MESSAGE, stale: false };
  if (!parsed.data.ok) {
    const { code, message } = parsed.data.error;
    if (answer.status === 422) {
      return {
        kind: "error",
        message: `The proof service rejected the plan when applying it: ${message} Nothing was changed.`,
        stale: false,
      };
    }
    return { kind: "error", ...describeExecutorFailure(answer.status, code, message) };
  }
  const { data } = parsed.data;
  return {
    kind: "applied",
    nodeId: data.nodeId,
    stepCount: data.steps.length,
    replayed: data.replayed,
  };
}

const UNREACHABLE_MESSAGE = "The proof service could not be reached. Nothing was changed.";
const INVALID_MESSAGE = "The proof service returned an invalid response. Nothing was changed.";
