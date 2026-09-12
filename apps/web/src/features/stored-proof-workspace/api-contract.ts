import {
  commandIdSchema,
  displayedSuggestionSetSchema,
  operatorDeclarationSchema,
  proofCommandReceiptSchema,
  proofNodeIdSchema,
  stableIdentifierSchema as protocolStableIdentifierSchema,
  suggestionIdSchema,
  suggestionSetIdSchema,
  transitionClassSchema,
} from "@proof/protocol";
import { stableIdentifierSchema } from "@proof/mathjson-model";
import { z } from "zod";

const operandPathSchema = z.array(z.number().int().nonnegative());
const displayRangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([start, end]) => end > start, "A display range must be nonempty and ordered.");
const statementAnchorSchema = z
  .object({
    stateId: stableIdentifierSchema,
    target: z.object({ kind: z.enum(["goal", "obligation"]), id: stableIdentifierSchema }).strict(),
    statement: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("conclusion") }).strict(),
      z.object({ kind: z.literal("hypothesis"), id: stableIdentifierSchema }).strict(),
    ]),
  })
  .strict();

export const proofSelectionDescriptorSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("exact"), anchor: statementAnchorSchema, path: operandPathSchema })
    .strict(),
  z
    .object({
      kind: z.literal("associative"),
      anchor: statementAnchorSchema,
      containerPath: operandPathSchema,
      startOperand: z.number().int().nonnegative(),
      endOperand: z.number().int().nonnegative(),
      displayRange: displayRangeSchema.optional(),
    })
    .strict()
    .refine(
      ({ startOperand, endOperand }) => endOperand - startOperand >= 2,
      "An associative range must contain at least two operands.",
    ),
]);

export type ProofSelectionDescriptor = z.infer<typeof proofSelectionDescriptorSchema>;

export const suggestionRequestSchema = z
  .object({
    id: suggestionSetIdSchema,
    selections: z.array(proofSelectionDescriptorSchema).min(1).max(16),
  })
  .strict();

/** The browser names a persisted choice; only the worker materializes trusted command records. */
export const moveChoiceRequestSchema = z
  .object({
    commandId: commandIdSchema,
    suggestionSetId: suggestionSetIdSchema,
    chosenSuggestionId: suggestionIdSchema,
  })
  .strict();

export type MoveChoiceRequest = z.infer<typeof moveChoiceRequestSchema>;

export const backtrackRequestSchema = z
  .object({
    expectedCurrentNodeId: proofNodeIdSchema,
    targetNodeId: proofNodeIdSchema,
  })
  .strict();

export type BacktrackRequest = z.infer<typeof backtrackRequestSchema>;

export const suggestionTransitionClassSchema = z
  .object({
    suggestionId: suggestionIdSchema,
    transitionClass: transitionClassSchema,
  })
  .strict();

export type SuggestionTransitionClass = z.infer<typeof suggestionTransitionClassSchema>;

export const storedProofSessionSchema = z
  .object({
    id: protocolStableIdentifierSchema,
    rootNodeId: proofNodeIdSchema,
    currentNodeId: proofNodeIdSchema,
    operators: z.array(operatorDeclarationSchema),
  })
  .strict();

const apiFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
  })
  .strict();

export const suggestionApiSuccessSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        suggestionSet: displayedSuggestionSetSchema,
        replayed: z.boolean(),
        transitionClasses: z.array(suggestionTransitionClassSchema),
      })
      .strict()
      .superRefine(({ suggestionSet, transitionClasses }, context) => {
        const moveSuggestionIds = suggestionSet.suggestions
          .filter(({ source }) => source === "move")
          .map(({ id }) => id);
        if (
          moveSuggestionIds.length !== transitionClasses.length ||
          moveSuggestionIds.some((id, index) => transitionClasses[index]?.suggestionId !== id)
        ) {
          context.addIssue({
            code: "custom",
            message: "Transition classes must identify every displayed move in persisted order.",
          });
        }
      }),
  })
  .strict();

export const suggestionApiFailureSchema = apiFailureSchema;

export const suggestionApiResponseSchema = z.discriminatedUnion("ok", [
  suggestionApiSuccessSchema,
  suggestionApiFailureSchema,
]);

export type SuggestionApiResponse = z.infer<typeof suggestionApiResponseSchema>;

const movePreviewApiSuccessSchema = z
  .object({
    ok: z.literal(true),
    // The caller validates this with createMovePreviewSchema({ operators }) from its session.
    data: z.object({ preview: z.unknown(), replayed: z.boolean() }).strict(),
  })
  .strict();

export const movePreviewApiResponseSchema = z.union([
  movePreviewApiSuccessSchema,
  apiFailureSchema,
]);

export type MovePreviewApiResponse = z.infer<typeof movePreviewApiResponseSchema>;

const proofCommandApiSuccessSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        session: storedProofSessionSchema,
        // Custom operators make the node schema depend on the returned session environment.
        node: z.unknown(),
        receipt: proofCommandReceiptSchema,
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const proofCommandApiResponseSchema = z.union([
  proofCommandApiSuccessSchema,
  apiFailureSchema,
]);
export const commandApiResponseSchema = proofCommandApiResponseSchema;

export type ProofCommandApiResponse = z.infer<typeof proofCommandApiResponseSchema>;

export const proofHistoryEdgeSchema = z
  // The caller validates each edge with createProofEdgeSchema({ operators }).
  .object({ edge: z.unknown(), name: z.string().min(1) })
  .strict();

const proofHistoryApiSuccessSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        session: storedProofSessionSchema,
        // Nodes and edges are dynamically validated against session.operators by the caller.
        nodes: z.array(z.unknown()),
        edges: z.array(proofHistoryEdgeSchema),
      })
      .strict(),
  })
  .strict();

export const proofHistoryApiResponseSchema = z.union([
  proofHistoryApiSuccessSchema,
  apiFailureSchema,
]);

export type ProofHistoryApiResponse = z.infer<typeof proofHistoryApiResponseSchema>;

const backtrackApiSuccessSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        session: storedProofSessionSchema,
        node: z.unknown(),
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const backtrackApiResponseSchema = z.union([backtrackApiSuccessSchema, apiFailureSchema]);

export type BacktrackApiResponse = z.infer<typeof backtrackApiResponseSchema>;
