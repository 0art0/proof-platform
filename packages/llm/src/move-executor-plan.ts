/**
 * The move executor's plan (architecture §5): an ordered list of kernel operations in the kernel's
 * own operation schema, minus the state IDs, which the worker assigns.
 *
 * Two shapes live here. The WIRE shape is what the model is asked for under a strict provider
 * JSON schema: every property present, optional ones nullable, no open-ended maps. The STORED
 * shape is the same plan normalised to kernel operations without state IDs; it is what call
 * evidence holds and what `executorPlanOperations` turns into concrete operations. Every stored
 * step is checked against the kernel's runtime operation schema, so this module never invents its
 * own idea of a valid operation. This file imports nothing from `./index` (which imports it).
 */
import { KERNEL_OPERATION_KINDS, kernelOperationSchema } from "@proof/kernel";
import { MAX_PLAN_STEPS } from "@proof/moves/authoring";
import { plainMathJsonSchema, sortSchema, stableIdentifierSchema } from "@proof/protocol";
import { z } from "zod";

export { MAX_PLAN_STEPS };

/** Operations the executor must never propose: sorries stay user-selected, attestation is separate. */
export const EXECUTOR_FORBIDDEN_OPERATION_KINDS = [
  "mark-sorry",
  "close-by-accepted-inference",
] as const;

const FORBIDDEN: ReadonlySet<string> = new Set(EXECUTOR_FORBIDDEN_OPERATION_KINDS);

/** The kernel primitives the executor may propose. Construction-task operations are not offered. */
export const EXECUTOR_OPERATION_KINDS = KERNEL_OPERATION_KINDS.filter(
  (kind) => !FORBIDDEN.has(kind),
);

const SHORT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** A reference to an ID in the supplied context, or to a label an earlier step introduced. */
const referenceSchema = stableIdentifierSchema;
/**
 * A fresh identifier chosen by the model. It is only a label: the worker namespaces it by the call
 * ID so that it cannot collide with anything already in the session.
 */
const labelSchema = z.string().regex(SHORT_LABEL_PATTERN);

const targetSchema = z
  .object({ kind: z.enum(["goal", "obligation"]), id: referenceSchema })
  .strict();

export type WireMathJson = string | number | WireMathJson[];
/** MathJSON as the model writes it: a symbol or number, or `[Operator, ...operands]`. */
export const wireMathJsonSchema: z.ZodType<WireMathJson> = z.lazy(() =>
  z.union([z.string(), z.number(), z.array(wireMathJsonSchema)]),
);
const mathJsonFields = ["proposition", "term", "witness"] as const;

const operandIndexSchema = z.number().int().min(0);
const pathSchema = z.array(operandIndexSchema).max(64);
const lensSchema = z
  .object({ startOperand: operandIndexSchema, endOperand: operandIndexSchema })
  .strict()
  .nullable();
const directionSchema = z.enum(["forward", "backward"]);

/** `{ kind: "conclusion", id: null }` or `{ kind: "hypothesis", id }`. */
const statementSchema = z
  .object({ kind: z.enum(["conclusion", "hypothesis"]), id: referenceSchema.nullable() })
  .strict()
  .refine(({ kind, id }) => (kind === "conclusion") === (id === null), {
    message: "A conclusion has no ID; a hypothesis has one.",
  });

const instantiationSchema = z
  .array(z.object({ symbol: z.string().min(1).max(200), term: wireMathJsonSchema }).strict())
  .max(32);

/** Where a rewrite's equivalence or implication comes from: a hypothesis, or an instantiated result. */
const rewriteSourceSchema = z
  .object({
    kind: z.enum(["hypothesis", "result"]),
    hypothesisId: referenceSchema.nullable(),
    resultId: referenceSchema.nullable(),
    instantiation: instantiationSchema.nullable(),
  })
  .strict()
  .refine(
    ({ kind, hypothesisId, resultId, instantiation }) =>
      kind === "hypothesis"
        ? hypothesisId !== null && resultId === null && instantiation === null
        : hypothesisId === null && resultId !== null && instantiation !== null,
    { message: "A rewrite source is a hypothesis, or a result with its instantiation." },
  );

const FRESH_ID_FIELDS: Record<string, readonly string[]> = {};

function operation<Kind extends string, Shape extends z.ZodRawShape>(
  kind: Kind,
  shape: Shape,
  freshFields: readonly (keyof Shape & string)[] = [],
) {
  FRESH_ID_FIELDS[kind] = freshFields;
  return z.object({ kind: z.literal(kind), target: targetSchema, ...shape }).strict();
}

const freshIds = (min: number, max = 64) => z.array(labelSchema).min(min).max(max);

const wireOperations = [
  operation("close-by-hypothesis", { hypothesisId: referenceSchema }),
  operation("close-true", {}),
  operation("close-false-hypothesis", { hypothesisId: referenceSchema }),
  operation("close-reflexive-equality", {}),
  operation("close-by-contradiction", {
    hypothesisId: referenceSchema,
    negationHypothesisId: referenceSchema,
  }),
  operation("introduce-implication", { hypothesisId: labelSchema }, ["hypothesisId"]),
  operation("introduce-negation", { hypothesisId: labelSchema }, ["hypothesisId"]),
  operation("split-goal-conjunction", { childIds: freshIds(2) }, ["childIds"]),
  operation("choose-goal-disjunct", { disjunctIndex: operandIndexSchema }),
  operation(
    "expand-hypothesis-conjunction",
    { hypothesisId: referenceSchema, expandedHypothesisIds: freshIds(2) },
    ["expandedHypothesisIds"],
  ),
  operation(
    "split-hypothesis-disjunction",
    { hypothesisId: referenceSchema, childIds: freshIds(2), branchHypothesisIds: freshIds(2) },
    ["childIds", "branchHypothesisIds"],
  ),
  operation(
    "split-classical-cases",
    {
      proposition: wireMathJsonSchema,
      childIds: freshIds(2, 2),
      branchHypothesisIds: freshIds(2, 2),
    },
    ["childIds", "branchHypothesisIds"],
  ),
  operation("assume-hypothesis", { proposition: wireMathJsonSchema, hypothesisId: labelSchema }, [
    "hypothesisId",
  ]),
  operation("replace-goal", { proposition: wireMathJsonSchema }),
  operation("suffices", { proposition: wireMathJsonSchema, obligationId: labelSchema }, [
    "obligationId",
  ]),
  operation("drop-hypothesis", { hypothesisId: referenceSchema }),
  operation(
    "apply-implication-hypothesis",
    {
      implicationHypothesisId: referenceSchema,
      antecedentHypothesisId: referenceSchema,
      resultHypothesisId: labelSchema,
    },
    ["resultHypothesisId"],
  ),
  operation(
    "introduce-universal",
    {
      parameterDeclarationId: labelSchema.nullable(),
      membershipHypothesisId: labelSchema.nullable(),
    },
    ["parameterDeclarationId", "membershipHypothesisId"],
  ),
  operation(
    "instantiate-universal-hypothesis",
    {
      hypothesisId: referenceSchema,
      term: wireMathJsonSchema,
      resultHypothesisId: labelSchema,
      membershipObligationId: labelSchema.nullable(),
    },
    ["resultHypothesisId", "membershipObligationId"],
  ),
  operation("choose-existential-witness", { witness: wireMathJsonSchema }),
  operation(
    "unpack-existential-hypothesis",
    {
      hypothesisId: referenceSchema,
      resultHypothesisId: labelSchema,
      witnessDeclarationId: labelSchema.nullable(),
      membershipHypothesisId: labelSchema.nullable(),
    },
    ["resultHypothesisId", "witnessDeclarationId", "membershipHypothesisId"],
  ),
  operation("rewrite-with-equality", {
    equalityHypothesisId: referenceSchema,
    statement: statementSchema,
    path: pathSchema,
    lens: lensSchema,
    direction: directionSchema,
  }),
  operation("rewrite-with-equivalence", {
    statement: statementSchema,
    path: pathSchema,
    lens: lensSchema,
    source: rewriteSourceSchema,
    direction: directionSchema,
  }),
  operation("rewrite-with-implication", {
    statement: statementSchema,
    path: pathSchema,
    lens: lensSchema,
    source: rewriteSourceSchema,
  }),
  operation(
    "apply-result-backward",
    {
      resultId: referenceSchema,
      instantiation: instantiationSchema,
      premiseTargetIds: freshIds(0),
    },
    ["premiseTargetIds"],
  ),
  operation(
    "apply-result-forward",
    {
      resultId: referenceSchema,
      instantiation: instantiationSchema,
      premiseHypothesisIds: z.array(referenceSchema.nullable()).max(64),
      resultHypothesisId: labelSchema,
      obligationIds: freshIds(0),
    },
    ["resultHypothesisId", "obligationIds"],
  ),
  operation("close-by-assumption", {
    assumptionId: referenceSchema,
    instantiation: instantiationSchema,
  }),
] as const;

const wireOperationSchema = z.union(
  wireOperations as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]],
);

/** A fresh label field of an operation kind, for tests and for the ID assignment below. */
export function executorFreshIdFields(kind: string): readonly string[] {
  return FRESH_ID_FIELDS[kind] ?? [];
}

/** An approved library result as a model sees it: its parameters, premises and conclusion. */
export const executorResultCardSchema = z
  .object({
    id: stableIdentifierSchema,
    name: z.string().min(1).max(500).optional(),
    parameters: z
      .array(z.object({ symbol: z.string().min(1).max(200), sort: sortSchema }).strict())
      .max(32),
    premises: z.array(plainMathJsonSchema).max(32),
    conclusion: plainMathJsonSchema,
    directions: z
      .array(z.enum(["forward", "backward"]))
      .min(1)
      .max(2),
  })
  .strict();
export type ExecutorResultCard = z.infer<typeof executorResultCardSchema>;

const explanationSchema = z.string().min(1).max(1000);

export const executorWirePlanSchema = z
  .object({
    kind: z.literal("plan"),
    steps: z.array(wireOperationSchema).min(1).max(MAX_PLAN_STEPS),
    explanation: explanationSchema,
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Normalising a wire step into a kernel operation without state IDs
// ---------------------------------------------------------------------------------------------

export type ExecutorPlanStep = Readonly<Record<string, unknown>> & Readonly<{ kind: string }>;

/** Drop nulls, rebuild the kernel's shapes for statements, sources and instantiations. */
export function normalizeWireStep(wire: Readonly<Record<string, unknown>>): ExecutorPlanStep {
  const step: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wire)) {
    if (value === null) continue;
    if (key === "statement") {
      const statement = value as { kind: string; id: string | null };
      step[key] =
        statement.kind === "conclusion"
          ? { kind: "conclusion" }
          : { kind: "hypothesis", id: statement.id };
    } else if (key === "source") {
      const source = value as {
        kind: string;
        hypothesisId: string | null;
        resultId: string | null;
        instantiation: { symbol: string; term: unknown }[] | null;
      };
      step[key] =
        source.kind === "hypothesis"
          ? { kind: "hypothesis", hypothesisId: source.hypothesisId }
          : {
              kind: "result",
              resultId: source.resultId,
              instantiation: instantiationRecord(source.instantiation ?? []),
            };
    } else if (key === "instantiation") {
      step[key] = instantiationRecord(value as { symbol: string; term: unknown }[]);
    } else if (key === "lens") {
      step[key] = { ...(value as object) };
    } else {
      step[key] = value;
    }
  }
  return step as ExecutorPlanStep;
}

function instantiationRecord(
  entries: readonly { symbol: string; term: unknown }[],
): Record<string, unknown> {
  return Object.fromEntries(entries.map(({ symbol, term }) => [symbol, term]));
}

// ---------------------------------------------------------------------------------------------
// The stored plan
// ---------------------------------------------------------------------------------------------

const VALIDATION_STATE_IDS = {
  expectedStateId: "state:executor-validation-before",
  resultStateId: "state:executor-validation-after",
};

/** Every fresh label a step introduces, in field order. */
function stepFreshLabels(step: ExecutorPlanStep): readonly string[] {
  return executorFreshIdFields(step.kind).flatMap((field) => {
    const value = step[field];
    if (typeof value === "string") return [value];
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  });
}

/** The result IDs a step cites: a result application, or a rewrite from a result. */
export function stepResultIds(step: ExecutorPlanStep): readonly string[] {
  if (typeof step.resultId === "string") return [step.resultId];
  const source = step.source as { kind?: unknown; resultId?: unknown } | undefined;
  return source?.kind === "result" && typeof source.resultId === "string" ? [source.resultId] : [];
}

/** Whether `step` is an allowed operation that the kernel's own schema accepts. */
export function isExecutorStep(value: unknown): value is ExecutorPlanStep {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !EXECUTOR_OPERATION_KINDS.some((allowed) => allowed === kind)) {
    return false;
  }
  if (
    "expectedStateId" in value ||
    "resultStateId" in value ||
    !kernelOperationSchema.safeParse({ ...value, ...VALIDATION_STATE_IDS }).success
  ) {
    return false;
  }
  return mathJsonFields.every(
    (field) =>
      !(field in value) ||
      plainMathJsonSchema.safeParse((value as Record<string, unknown>)[field]).success,
  );
}

export const executorPlanProposalSchema = z
  .object({
    kind: z.literal("plan"),
    steps: z
      .array(
        z.custom<ExecutorPlanStep>(isExecutorStep, {
          message: "A plan step must be an allowed kernel operation without state IDs.",
        }),
      )
      .min(1)
      .max(MAX_PLAN_STEPS),
    explanation: explanationSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    const labels = plan.steps.flatMap(stepFreshLabels);
    const everyLabelIsShort = labels.every((label) => SHORT_LABEL_PATTERN.test(label));
    if (new Set(labels).size !== labels.length || !everyLabelIsShort) {
      context.addIssue({
        code: "custom",
        message: "New identifiers must be unique short labels without colons.",
      });
    }
  });
export type ExecutorPlanProposal = z.infer<typeof executorPlanProposalSchema>;

export const executorInsufficientContextSchema = z
  .object({
    kind: z.literal("insufficient-context"),
    requestedCategories: z
      .array(z.enum(["selection-detail", "local-hypothesis", "declaration-sort", "library-result"]))
      .min(1)
      .max(4),
    rationale: z.string().min(1).max(500),
  })
  .strict();

/** Whether a (possibly invalid) candidate plan names an operation the executor may not propose. */
export function planUsesForbiddenOperation(candidate: unknown): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const steps = (candidate as { steps?: unknown }).steps;
  return (
    Array.isArray(steps) &&
    steps.some(
      (step) =>
        typeof step === "object" &&
        step !== null &&
        typeof (step as { kind?: unknown }).kind === "string" &&
        FORBIDDEN.has((step as { kind: string }).kind),
    )
  );
}

// ---------------------------------------------------------------------------------------------
// Concrete operations
// ---------------------------------------------------------------------------------------------

/** Statement-ID fields that refer to something that already exists (or an earlier label). */
const REFERENCE_FIELDS = [
  "hypothesisId",
  "implicationHypothesisId",
  "antecedentHypothesisId",
  "negationHypothesisId",
  "equalityHypothesisId",
  "assumptionId",
] as const;

/**
 * The step with every reference to an existing target or statement passed through `map` (a map
 * that returns an ID it does not know unchanged leaves a reference to a label an earlier step
 * introduced as it was). The labels the step introduces itself are not references.
 */
export function mapExecutorStepReferences(
  step: ExecutorPlanStep,
  map: (id: string) => string,
): ExecutorPlanStep {
  const fresh = new Set(executorFreshIdFields(step.kind));
  const mapped: Record<string, unknown> = structuredClone(step) as Record<string, unknown>;
  const target = mapped.target as { kind: string; id: string };
  mapped.target = { ...target, id: map(target.id) };
  for (const field of REFERENCE_FIELDS) {
    const value = mapped[field];
    if (!fresh.has(field) && typeof value === "string") mapped[field] = map(value);
  }
  const statement = mapped.statement as { kind: string; id?: string } | undefined;
  if (statement?.kind === "hypothesis" && statement.id !== undefined) {
    mapped.statement = { ...statement, id: map(statement.id) };
  }
  const source = mapped.source as { kind: string; hypothesisId?: string } | undefined;
  if (source?.kind === "hypothesis" && source.hypothesisId !== undefined) {
    mapped.source = { ...source, hypothesisId: map(source.hypothesisId) };
  }
  if (Array.isArray(mapped.premiseHypothesisIds)) {
    mapped.premiseHypothesisIds = mapped.premiseHypothesisIds.map((id) =>
      typeof id === "string" ? map(id) : id,
    );
  }
  return mapped as ExecutorPlanStep;
}

/** The ID of the state after step `index` (1-based) of the call's plan. */
function executorStateId(callId: string, index: number): string {
  return `state:${callId}:${index}`;
}

/**
 * Turn stored plan steps into concrete kernel operations: chain the state IDs from `stateId`,
 * and make every label the model introduced globally unique by prefixing it with the call ID.
 * References to a label introduced by an earlier step follow the label; every other ID is left
 * exactly as the model wrote it, for the kernel to accept or reject.
 */
export function executorPlanOperations(
  steps: readonly ExecutorPlanStep[],
  input: Readonly<{ stateId: string; callId: string }>,
): Record<string, unknown>[] {
  const introduced = new Set<string>();
  const namespaced = (label: string) => `${input.callId}:${label}`;
  const follow = (id: unknown) =>
    typeof id === "string" && introduced.has(id) ? namespaced(id) : id;
  return steps.map((step, position) => {
    const fresh = new Set(executorFreshIdFields(step.kind));
    const operation: Record<string, unknown> = structuredClone(step) as Record<string, unknown>;
    // References first, so that a step cannot refer to a label it introduces itself.
    const target = operation.target as { kind: string; id: unknown };
    operation.target = { ...target, id: follow(target.id) };
    for (const field of REFERENCE_FIELDS) {
      if (!fresh.has(field) && field in operation) operation[field] = follow(operation[field]);
    }
    const statement = operation.statement as { kind: string; id?: unknown } | undefined;
    if (statement?.kind === "hypothesis")
      operation.statement = { ...statement, id: follow(statement.id) };
    const source = operation.source as { kind: string; hypothesisId?: unknown } | undefined;
    if (source?.kind === "hypothesis") {
      operation.source = { ...source, hypothesisId: follow(source.hypothesisId) };
    }
    if (Array.isArray(operation.premiseHypothesisIds)) {
      operation.premiseHypothesisIds = operation.premiseHypothesisIds.map(follow);
    }
    for (const field of fresh) {
      const value = operation[field];
      if (typeof value === "string") {
        introduced.add(value);
        operation[field] = namespaced(value);
      } else if (Array.isArray(value)) {
        value.forEach((label) => typeof label === "string" && introduced.add(label));
        operation[field] = value.map((label) =>
          typeof label === "string" ? namespaced(label) : label,
        );
      }
    }
    operation.expectedStateId =
      position === 0 ? input.stateId : executorStateId(input.callId, position);
    operation.resultStateId = executorStateId(input.callId, position + 1);
    return operation;
  });
}
