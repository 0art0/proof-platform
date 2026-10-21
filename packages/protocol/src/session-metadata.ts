import { backgroundProfileSchema, libraryLayerIdSchema } from "@proof/library";
import { plainMathJsonSchema } from "@proof/mathjson-model";
import { z } from "zod";

export {
  BACKGROUND_LEVELS,
  backgroundClassificationSchema,
  backgroundLevelSchema,
  backgroundProfileSchema,
  checkBackgroundAdmission,
  compareBackgroundLevels,
  isWithinBackground,
  libraryLayerIdSchema,
} from "@proof/library";
export type {
  BackgroundAdmissionDiagnostic,
  BackgroundAdmissionDiagnosticCode,
  BackgroundAdmissionResult,
  BackgroundClassification,
  BackgroundLevel,
  BackgroundProfile,
  LibraryLayerId,
} from "@proof/library";

const boundedTextSchema = z.string().min(1).max(20_000);
const shortTextSchema = z.string().min(1).max(500);

function uniqueArray<Element extends z.ZodType<string>>(element: Element, label: string) {
  return z
    .array(element)
    .max(64)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            message: `Each ${label} must be unique.`,
            path: [index],
          });
        }
        seen.add(value);
      });
    });
}

/**
 * Session-level mathematical context (design plan §7): the problem as entered, the reader's
 * declared background, presentation preferences and the active library layers. It is documentary
 * session configuration; proof state never depends on it.
 */
export const proofSessionMetadataSchema = z
  .object({
    problem: z
      .object({
        title: shortTextSchema,
        statement: boundedTextSchema,
        statementMathJson: plainMathJsonSchema.optional(),
      })
      .strict(),
    background: backgroundProfileSchema,
    preferences: z
      .object({
        domains: uniqueArray(shortTextSchema, "preferred domain").optional(),
        notation: uniqueArray(shortTextSchema, "notation preference").optional(),
      })
      .strict()
      .optional(),
    libraryLayerIds: uniqueArray(libraryLayerIdSchema, "library layer ID"),
  })
  .strict();
export type ProofSessionMetadata = z.infer<typeof proofSessionMetadataSchema>;
