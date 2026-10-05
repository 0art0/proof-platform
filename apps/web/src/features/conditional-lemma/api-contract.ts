import { stableIdentifierSchema } from "@proof/mathjson-model";
import { z } from "zod";

/**
 * The conditional-lemma views the worker serves (roadmap N44). The web boundary checks the shape
 * it renders; the worker derives the lemma, its hypotheses and its renderings from stored data.
 */

const renderedSchema = z.object({ latex: z.string(), naturalLanguage: z.string() }).strict();
export type RenderedStatementView = z.infer<typeof renderedSchema>;

const hypothesisViewSchema = z
  .object({ id: stableIdentifierSchema, latex: z.string(), naturalLanguage: z.string() })
  .strict();
export type HypothesisView = z.infer<typeof hypothesisViewSchema>;

export const lemmaTargetSchema = z
  .object({ kind: z.enum(["goal", "obligation"]), id: stableIdentifierSchema })
  .strict();
export type LemmaTarget = z.infer<typeof lemmaTargetSchema>;

export const LEMMA_REFUSAL_CODES = [
  "lemma-target-not-found",
  "lemma-not-closed",
  "lemma-uses-sorry",
  "lemma-local-dependency",
  "lemma-invalid",
] as const;

const existingLemmaSchema = z
  .object({
    artifactId: stableIdentifierSchema,
    status: z.enum(["draft", "approved", "rejected"]),
  })
  .strict();
export type ExistingLemmaView = z.infer<typeof existingLemmaSchema>;

export const lemmaPreviewSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      nodeId: stableIdentifierSchema,
      target: lemmaTargetSchema,
      name: z.string(),
      statement: renderedSchema,
      conclusion: renderedSchema,
      premises: z.array(hypothesisViewSchema),
      unusedHypotheses: z.array(hypothesisViewSchema),
      conservative: z.array(
        z.object({ edgeId: z.string(), operationKind: z.string(), reason: z.string() }).strict(),
      ),
      parameters: z.array(z.string()),
      establishingSteps: z.number().int().nonnegative(),
      backgroundInferences: z.number().int().nonnegative(),
      existing: z.array(existingLemmaSchema),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      code: z.enum(LEMMA_REFUSAL_CODES),
      message: z.string(),
    })
    .strict(),
]);
export type LemmaPreview = z.infer<typeof lemmaPreviewSchema>;
export type ReadyLemmaPreview = Extract<LemmaPreview, { status: "ready" }>;

export const lemmaCandidateSchema = z
  .object({
    nodeId: stableIdentifierSchema,
    target: lemmaTargetSchema,
    goal: renderedSchema,
    preview: lemmaPreviewSchema,
  })
  .strict();
export type LemmaCandidate = z.infer<typeof lemmaCandidateSchema>;

export const lemmaCandidatesSchema = z
  .object({
    sessionId: stableIdentifierSchema,
    readOnly: z.boolean(),
    candidates: z.array(lemmaCandidateSchema),
  })
  .strict();
export type LemmaCandidates = z.infer<typeof lemmaCandidatesSchema>;

export const lemmaPreviewResponseSchema = z
  .object({ sessionId: stableIdentifierSchema, preview: lemmaPreviewSchema })
  .strict();
export type LemmaPreviewResponse = z.infer<typeof lemmaPreviewResponseSchema>;

export const previewLemmaRequestSchema = z
  .object({ nodeId: stableIdentifierSchema, target: lemmaTargetSchema })
  .strict();

/** The proxy's wrapper around a worker answer. */
export const apiResponse = <Data extends z.ZodType>(data: Data) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }).strict(),
    z
      .object({
        ok: z.literal(false),
        error: z.object({ code: z.string().min(1), message: z.string() }).strict(),
      })
      .strict(),
  ]);
