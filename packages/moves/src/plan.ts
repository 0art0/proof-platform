/**
 * Multi-operation plans (design plan §13; used by macro moves in N35).
 *
 * A plan is a fixed sequence of kernel primitive kinds. `planMoveSequence` applies concrete
 * operations against successive states through the kernel. Each operation must name the previous
 * result state as its expected state, so the kernel's own stale-state check chains the steps. The
 * sequence is atomic: any failure yields no preview at all.
 */
import {
  KERNEL_OPERATION_KINDS,
  TRANSITION_EVIDENCE_KINDS,
  applyTransition,
  kernelOperationSchema,
  type KernelEnvironment,
  type KernelOperation,
  type KernelOperationKind,
  type KernelResultId,
  type TransitionClass,
  type TransitionEvidence,
} from "@proof/kernel";
import { stableIdentifierSchema, type ExecutableProofState } from "@proof/mathjson-model";
import { z } from "zod";
import { PRIMITIVE_TRANSITION_CLASSES, PRIMITIVE_TRANSITION_EVIDENCE } from "./index";

export const movePlanStepSchema = z
  .object({ id: stableIdentifierSchema, operationKind: z.enum(KERNEL_OPERATION_KINDS) })
  .strict();
export type MovePlanStep = z.infer<typeof movePlanStepSchema>;

/** Plans consist of primitives only; construction-task operations have no move definition. */
function isPrimitiveKind(kind: KernelOperation["kind"]): kind is KernelOperationKind {
  return (KERNEL_OPERATION_KINDS as readonly string[]).includes(kind);
}

/**
 * The implementation kind of a multi-step move. It is not yet a member of
 * `moveImplementationSchema`: retrieval and the worker read `implementation.operationKind`, so
 * admitting plans into `MoveDefinition` is left to N35, together with those readers.
 */
export const movePlanImplementationSchema = z
  .object({ kind: z.literal("deterministic-plan"), steps: z.array(movePlanStepSchema).min(1) })
  .strict()
  .superRefine((plan, context) => {
    const seen = new Set<string>();
    plan.steps.forEach((step, index) => {
      if (seen.has(step.id)) {
        context.addIssue({
          code: "custom",
          message: "Each plan step ID must be unique.",
          path: ["steps", index, "id"],
        });
      }
      seen.add(step.id);
    });
  });
export type MovePlanImplementation = z.infer<typeof movePlanImplementationSchema>;

const CLASS_STRENGTH: Readonly<Record<TransitionClass, number>> = {
  equivalence: 0,
  strengthening: 1,
  weakening: 2,
};

/**
 * The class of a composed transition is the weakest guarantee among its steps. Weakening
 * dominates strengthening, which dominates equivalence. An empty sequence is an equivalence.
 */
export function composeTransitionClasses(classes: readonly TransitionClass[]): TransitionClass {
  return classes.reduce<TransitionClass>(
    (weakest, next) => (CLASS_STRENGTH[next] > CLASS_STRENGTH[weakest] ? next : weakest),
    "equivalence",
  );
}

export type MoveSequenceDiagnosticCode =
  "invalid-request" | "plan-mismatch" | "kernel-rejected" | "invalid-move-definition";

export type MoveSequenceDiagnostic = Readonly<{
  code: MoveSequenceDiagnosticCode;
  message: string;
  /** The failing step, when the failure belongs to one. */
  stepIndex?: number;
}>;

export type MoveSequenceStepPreview = Readonly<{
  operation: KernelOperation;
  transitionClass: TransitionClass;
  evidence: TransitionEvidence;
  resultId?: KernelResultId;
}>;

export type MoveSequencePlanResult =
  | Readonly<{
      ok: true;
      steps: readonly MoveSequenceStepPreview[];
      preview: Readonly<{
        /** The final state; intermediate states are not retained. */
        state: ExecutableProofState;
        transitionClass: TransitionClass;
        /** Union of the step evidence, in `TRANSITION_EVIDENCE_KINDS` order. */
        evidence: readonly TransitionEvidence[];
      }>;
      diagnostics: readonly [];
    }>
  | Readonly<{ ok: false; diagnostics: readonly [MoveSequenceDiagnostic] }>;

/**
 * Apply operations in sequence against successive states. When a plan is given, the operations
 * must match its steps one-for-one by kind. Each step's class and evidence must agree with its
 * primitive's declared class and evidence, as `planMove` requires for a single move.
 */
export function planMoveSequence(
  stateInput: ExecutableProofState,
  operationsInput: readonly unknown[],
  environment: KernelEnvironment = {},
  planInput?: unknown,
): MoveSequencePlanResult {
  try {
    if (!Array.isArray(operationsInput) || operationsInput.length === 0) {
      return sequenceFailure("invalid-request", "A plan needs at least one operation.");
    }
    let plan: MovePlanImplementation | undefined;
    if (planInput !== undefined) {
      const parsedPlan = movePlanImplementationSchema.safeParse(planInput);
      if (!parsedPlan.success) {
        return sequenceFailure("invalid-request", "The plan implementation is invalid.");
      }
      plan = parsedPlan.data;
      if (plan.steps.length !== operationsInput.length) {
        return sequenceFailure(
          "plan-mismatch",
          "The operations must correspond one-for-one with the plan steps.",
        );
      }
    }
    let state = stateInput;
    const steps: MoveSequenceStepPreview[] = [];
    for (const [stepIndex, input] of operationsInput.entries()) {
      const operation = kernelOperationSchema.safeParse(input);
      if (!operation.success) {
        return sequenceFailure("invalid-request", "A plan operation is invalid.", stepIndex);
      }
      const expectedKind = plan?.steps[stepIndex]?.operationKind;
      if (expectedKind !== undefined && expectedKind !== operation.data.kind) {
        return sequenceFailure(
          "plan-mismatch",
          `Step ${stepIndex} must be a ${expectedKind} operation.`,
          stepIndex,
        );
      }
      const transition = applyTransition(state, operation.data, environment);
      if (!transition.ok) {
        const diagnostic = transition.diagnostics[0];
        return sequenceFailure(
          "kernel-rejected",
          diagnostic === undefined
            ? `The kernel rejected step ${stepIndex}.`
            : `The kernel rejected step ${stepIndex}: ${diagnostic.code}.`,
          stepIndex,
        );
      }
      const kind = operation.data.kind;
      if (
        !isPrimitiveKind(kind) ||
        transition.transitionClass !== PRIMITIVE_TRANSITION_CLASSES[kind] ||
        !PRIMITIVE_TRANSITION_EVIDENCE[kind].includes(transition.evidence)
      ) {
        return sequenceFailure(
          "invalid-move-definition",
          `The kernel transition of step ${stepIndex} contradicts its primitive definition.`,
          stepIndex,
        );
      }
      steps.push({
        operation: operation.data,
        transitionClass: transition.transitionClass,
        evidence: transition.evidence,
        ...(transition.resultId === undefined ? {} : { resultId: transition.resultId }),
      });
      state = transition.state;
    }
    const evidence = new Set(steps.map((step) => step.evidence));
    return deepFreeze(
      structuredClone({
        ok: true as const,
        steps,
        preview: {
          state,
          transitionClass: composeTransitionClasses(steps.map((step) => step.transitionClass)),
          evidence: TRANSITION_EVIDENCE_KINDS.filter((kind) => evidence.has(kind)),
        },
        diagnostics: [] as const,
      }),
    );
  } catch {
    return sequenceFailure("invalid-request", "The plan inputs could not be inspected safely.");
  }
}

function sequenceFailure(
  code: MoveSequenceDiagnosticCode,
  message: string,
  stepIndex?: number,
): MoveSequencePlanResult {
  return {
    ok: false,
    diagnostics: [{ code, message, ...(stepIndex === undefined ? {} : { stepIndex }) }],
  };
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
