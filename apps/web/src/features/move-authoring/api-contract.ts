import { stableIdentifierSchema } from "@proof/mathjson-model";
import { z } from "zod";

/**
 * The authored-move views the worker serves (design plan §13.1, roadmap N35). The web boundary
 * checks the shape it renders; the worker owns template validation and review.
 */

export const REVIEW_DECISIONS = ["approved", "rejected", "changes-requested"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const authoredMoveReviewSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    reviewerId: z.string().min(1),
    reviewedAt: z.string().min(1),
    notes: z.string(),
    reviewOf: z.string().min(1),
    definitionDigest: z.string().min(1),
  })
  .passthrough();
export type AuthoredMoveReview = z.infer<typeof authoredMoveReviewSchema>;

export const authoredMoveRevisionSchema = z
  .object({
    draftArtifactId: stableIdentifierSchema,
    reviewArtifactId: stableIdentifierSchema.optional(),
    revision: z.number().int().positive(),
    authorId: z.string().min(1),
    status: z.enum(["draft", ...REVIEW_DECISIONS]),
    definitionDigest: z.string().min(1),
    review: authoredMoveReviewSchema.optional(),
    template: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AuthoredMoveRevision = z.infer<typeof authoredMoveRevisionSchema>;

export const authoredMoveSummarySchema = z
  .object({
    moveId: stableIdentifierSchema,
    name: z.string(),
    revisions: z.array(authoredMoveRevisionSchema),
    activeArtifactId: stableIdentifierSchema.optional(),
    /** Whether the approved version is in the session's retrieval and materialization catalog. */
    retrievable: z.boolean(),
  })
  .strict();
export type AuthoredMoveSummary = z.infer<typeof authoredMoveSummarySchema>;

export const authoredMovesSchema = z
  .object({ sessionId: stableIdentifierSchema, moves: z.array(authoredMoveSummarySchema) })
  .strict();
export type AuthoredMoves = z.infer<typeof authoredMovesSchema>;

export const templateDiagnosticSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
    exampleId: z.string().optional(),
    stepIndex: z.number().int().nonnegative().optional(),
  })
  .strict();
export type TemplateDiagnosticView = z.infer<typeof templateDiagnosticSchema>;

export const exampleReportSchema = z
  .object({
    exampleId: z.string(),
    outcome: z.enum(["applied", "rejected"]),
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]).optional(),
    stepCount: z.number().int().nonnegative(),
  })
  .strict();

export const templateReportSchema = z
  .object({
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
    stepCount: z.number().int().positive(),
    retrievable: z.boolean(),
    examples: z.array(exampleReportSchema),
  })
  .strict();
export type TemplateReport = z.infer<typeof templateReportSchema>;

/** The worker's answer to a dry-run validation: a report, or the diagnostics that refuse it. */
export const templateValidationSchema = z.discriminatedUnion("ok", [
  z
    .object({
      sessionId: stableIdentifierSchema,
      ok: z.literal(true),
      report: templateReportSchema,
    })
    .strict(),
  z
    .object({
      sessionId: stableIdentifierSchema,
      ok: z.literal(false),
      diagnostics: z.array(templateDiagnosticSchema).min(1),
    })
    .strict(),
]);
export type TemplateValidation = z.infer<typeof templateValidationSchema>;

/** The proxy's wrapper around a successful worker answer. */
export const authoredMovesApiResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: authoredMovesSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: z.string().min(1), message: z.string() }).strict(),
    })
    .strict(),
]);

export const templateValidationApiResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: templateValidationSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: z.string().min(1), message: z.string() }).strict(),
    })
    .strict(),
]);

export const validateTemplateRequestSchema = z
  .object({ template: z.record(z.string(), z.unknown()) })
  .strict();
