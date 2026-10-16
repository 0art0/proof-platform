/**
 * Running a move-executor plan through the kernel (architecture §5). The plan is stored LLM output:
 * kernel operations without state IDs. This module turns it into concrete operations and runs them
 * with `planMoveSequence`; the preview route shows the outcome and the apply route commits the very
 * same operations as ordinary commands. Nothing here writes anything.
 */
import {
  applyTransition,
  composeTransitionEvidence,
  type KernelEnvironment,
  type KernelOperation,
  type TransitionClass,
  type TransitionEvidence,
} from "@proof/kernel";
import { executorPlanOperations, type ExecutorPlanStep } from "@proof/llm";
import { planMoveSequence } from "@proof/moves";
import { computeDelta, type ProofNode, type ProofStateDelta } from "@proof/protocol";

export type ExecutorStepPreview = Readonly<{
  /** 1-based position in the plan. */
  index: number;
  operation: KernelOperation;
  transitionClass: TransitionClass;
  evidence: TransitionEvidence;
}>;

export type ExecutorPlanRun =
  | Readonly<{
      ok: true;
      operations: readonly KernelOperation[];
      steps: readonly ExecutorStepPreview[];
      /** The composed class: the weakest guarantee among the steps. */
      transitionClass: TransitionClass;
      /** The most caveated evidence among the steps. */
      evidence: TransitionEvidence;
      beforeState: ProofNode["state"];
      afterState: ProofNode["state"];
      delta: ProofStateDelta;
    }>
  | Readonly<{
      ok: false;
      /** The first step the kernel rejected, 1-based. */
      stepIndex: number;
      stepCount: number;
      code: string;
      message: string;
    }>;

/** Run `steps` against `node` through the kernel; the node itself is never changed. */
export function runExecutorPlan(
  node: ProofNode,
  steps: readonly ExecutorPlanStep[],
  callId: string,
  environment: KernelEnvironment,
): ExecutorPlanRun {
  const operations = executorPlanOperations(steps, { stateId: node.state.id, callId });
  const planned = planMoveSequence(node.state, operations, environment);
  if (!planned.ok) {
    const diagnostic = planned.diagnostics[0];
    const position = diagnostic.stepIndex ?? 0;
    // `planMoveSequence` names only the kernel's code; the kernel's own sentence is clearer.
    const cause = kernelCause(node, operations, position, environment);
    return {
      ok: false,
      stepIndex: position + 1,
      stepCount: steps.length,
      code: cause?.code ?? diagnostic.code,
      message: cause?.message ?? diagnostic.message,
    };
  }
  return {
    ok: true,
    operations: planned.steps.map(({ operation }) => operation),
    steps: planned.steps.map((step, position) => ({
      index: position + 1,
      operation: step.operation,
      transitionClass: step.transitionClass,
      evidence: step.evidence,
    })),
    transitionClass: planned.preview.transitionClass,
    evidence: composeTransitionEvidence(planned.steps.map(({ evidence }) => evidence)),
    beforeState: node.state,
    afterState: planned.preview.state,
    delta: computeDelta(node.state, planned.preview.state),
  };
}

function kernelCause(
  node: ProofNode,
  operations: readonly Record<string, unknown>[],
  position: number,
  environment: KernelEnvironment,
): Readonly<{ code: string; message: string }> | undefined {
  let state = node.state;
  for (const operation of operations.slice(0, position)) {
    const result = applyTransition(state, operation, environment);
    if (!result.ok) return undefined;
    state = result.state;
  }
  const failed = applyTransition(state, operations[position], environment);
  const diagnostic = failed.ok ? undefined : failed.diagnostics[0];
  return diagnostic === undefined
    ? undefined
    : { code: diagnostic.code, message: diagnostic.message };
}
