/**
 * Constant activations (`docs/ai-agents-architecture.md` section 2).
 *
 * A session's constants are the operator declarations it works with. Its setup operators (the
 * selected packs, the accepted background's constants, and any library constant the problem
 * statement itself uses) are active from the start. A library result may need further constants,
 * which the session holds as *available* (dormant) library constants: they are declared by the
 * library results that need them and are not yet part of any state. A committed step that applies
 * such a result activates them. The activation is an append-only record, written in the step's own
 * transaction and validated like the step: like a library addition (§12.4) it persists after
 * backtracking and after the step is deleted, so the session's effective operators only grow.
 *
 * The effective operators of a session are its setup operators followed by its activated
 * constants in activation order.
 */
import { mergeLibraryOperators } from "@proof/library";
import {
  operatorDeclarationSchema,
  stableIdentifierSchema,
  type OperatorDeclaration,
} from "@proof/mathjson-model";
import { z } from "zod";
import type { CommandId, ProofEdge, ProofEdgeId, ProofNodeId } from "./index";

// The identifier schemas are rebuilt here rather than imported: `./index` re-exports this module
// while it is still evaluating, so its own schemas do not exist yet.
const commandIdSchema = stableIdentifierSchema.brand("CommandId");
const proofEdgeIdSchema = stableIdentifierSchema.brand("ProofEdgeId");
const proofNodeIdSchema = stableIdentifierSchema.brand("ProofNodeId");

export const constantActivationSchema = z
  .object({
    /** The activation's position among the session's activations, from 1. */
    sequence: z.number().int().min(1),
    /** The constant's symbol; it repeats the declaration's. */
    symbol: z.string().min(1).max(200),
    declaration: operatorDeclarationSchema,
    /** The command of the step that applied the library result. */
    commandId: commandIdSchema,
    edgeId: proofEdgeIdSchema,
    /** The node that step created. */
    nodeId: proofNodeIdSchema,
    /** The library result the step applied. */
    resultId: stableIdentifierSchema,
    /** The step's transition sequence when the activation was recorded. */
    transitionSequence: z.number().int().min(1),
    activatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((activation, context) => {
    if (activation.symbol !== activation.declaration.symbol) {
      context.addIssue({
        code: "custom",
        message: "The activation's symbol must be its declaration's symbol.",
        path: ["symbol"],
      });
    }
  });
export type ConstantActivation = Readonly<{
  sequence: number;
  symbol: string;
  declaration: OperatorDeclaration;
  commandId: CommandId;
  edgeId: ProofEdgeId;
  nodeId: ProofNodeId;
  resultId: string;
  transitionSequence: number;
  activatedAt: string;
}>;

export type EffectiveOperatorsResult =
  | Readonly<{ ok: true; operators: readonly OperatorDeclaration[] }>
  | Readonly<{ ok: false; message: string }>;

/**
 * A session's effective operators: the setup operators followed by the activated constants in
 * activation order. The activations must be numbered 1, 2, ... in order, must each declare a
 * symbol that is not yet an operator, and must merge into one valid environment.
 */
export function effectiveOperators(
  setup: readonly OperatorDeclaration[],
  activations: readonly Pick<ConstantActivation, "sequence" | "symbol" | "declaration">[],
): EffectiveOperatorsResult {
  const symbols = new Set(setup.map(({ symbol }) => symbol));
  for (const [index, activation] of activations.entries()) {
    if (activation.sequence !== index + 1) {
      return { ok: false, message: "Constant activations must be numbered 1, 2, ... in order." };
    }
    if (symbols.has(activation.symbol)) {
      return {
        ok: false,
        message: `The constant ${activation.symbol} is activated twice or is already a setup operator.`,
      };
    }
    symbols.add(activation.symbol);
  }
  if (activations.length === 0) return { ok: true, operators: setup };
  const merged = mergeLibraryOperators([setup, activations.map(({ declaration }) => declaration)]);
  if (!merged.ok) return merged;
  // `mergeLibraryOperators` keeps first-seen symbol order: setup operators, then activations.
  return { ok: true, operators: merged.operators };
}

/** The library results a kernel operation applies (none for a structural step). */
export function appliedResultIds(operation: ProofEdge["operation"]): readonly string[] {
  switch (operation.kind) {
    case "apply-result-backward":
    case "apply-result-forward":
      return [operation.resultId];
    case "rewrite-with-equivalence":
    case "rewrite-with-implication":
      return operation.source.kind === "result" ? [operation.source.resultId] : [];
    default:
      return [];
  }
}
