import { displayedSuggestionSetSchema, suggestionSetIdSchema } from "@proof/protocol";
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

export const suggestionApiSuccessSchema = z
  .object({
    ok: z.literal(true),
    data: z.object({ suggestionSet: displayedSuggestionSetSchema, replayed: z.boolean() }).strict(),
  })
  .strict();

export const suggestionApiFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
  })
  .strict();

export const suggestionApiResponseSchema = z.discriminatedUnion("ok", [
  suggestionApiSuccessSchema,
  suggestionApiFailureSchema,
]);

export type SuggestionApiResponse = z.infer<typeof suggestionApiResponseSchema>;
