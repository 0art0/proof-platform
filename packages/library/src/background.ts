import { z } from "zod";

/**
 * Ordered mathematical background levels shared by library classifications and session background
 * profiles. The array order is the admission order: a result is within a profile's level when its
 * level appears no later than the profile's `maximumLevel`.
 */
export const BACKGROUND_LEVELS = [
  "foundational",
  "secondary",
  "undergraduate",
  "graduate",
  "research",
] as const;
export const backgroundLevelSchema = z.enum(BACKGROUND_LEVELS);
export type BackgroundLevel = z.infer<typeof backgroundLevelSchema>;

/** Compare two background levels by their position in `BACKGROUND_LEVELS`. */
export function compareBackgroundLevels(left: BackgroundLevel, right: BackgroundLevel): number {
  return BACKGROUND_LEVELS.indexOf(left) - BACKGROUND_LEVELS.indexOf(right);
}

const backgroundDomainSchema = z.string().min(1).max(500);

export const backgroundClassificationSchema = z
  .object({
    domains: z.array(backgroundDomainSchema).min(1),
    level: backgroundLevelSchema,
  })
  .strict()
  .superRefine((classification, context) => {
    addDuplicateIssues(classification.domains, "domain", context, ["domains"]);
  });
export type BackgroundClassification = z.infer<typeof backgroundClassificationSchema>;

const boundedTextSchema = z.string().min(1).max(20_000);
const shortTextSchema = z.string().min(1).max(500);

/**
 * The declared mathematical background of a proof session's reader.
 *
 * `level`, `summary` and `assumptions` are free text shown to people and model roles. The optional
 * `domains` and `maximumLevel` are the structured part used for deterministic admission; a profile
 * without them admits nothing deterministically.
 */
export const backgroundProfileSchema = z
  .object({
    level: shortTextSchema,
    summary: boundedTextSchema,
    assumptions: z.array(shortTextSchema).max(64),
    domains: z.array(backgroundDomainSchema).max(64).optional(),
    maximumLevel: backgroundLevelSchema.optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    addDuplicateIssues(profile.assumptions, "assumption", context, ["assumptions"]);
    if (profile.domains !== undefined) {
      addDuplicateIssues(profile.domains, "domain", context, ["domains"]);
    }
  });
export type BackgroundProfile = z.infer<typeof backgroundProfileSchema>;

export type BackgroundAdmissionDiagnosticCode =
  | "profile-domains-unspecified"
  | "profile-level-unspecified"
  | "domain-outside-background"
  | "level-above-background";

export type BackgroundAdmissionDiagnostic = Readonly<{
  code: BackgroundAdmissionDiagnosticCode;
  message: string;
}>;

export type BackgroundAdmissionResult =
  | Readonly<{ ok: true; diagnostics: readonly [] }>
  | Readonly<{
      ok: false;
      diagnostics: readonly [BackgroundAdmissionDiagnostic, ...BackgroundAdmissionDiagnostic[]];
    }>;

/**
 * Deterministically decide whether a classified artifact lies within a background profile: every
 * classified domain must be a profile domain and the classified level must not exceed the profile's
 * maximum level. Unspecified structured profile fields admit nothing.
 */
export function checkBackgroundAdmission(
  classification: BackgroundClassification,
  profile: BackgroundProfile,
): BackgroundAdmissionResult {
  const diagnostics: BackgroundAdmissionDiagnostic[] = [];
  if (profile.domains === undefined) {
    diagnostics.push({
      code: "profile-domains-unspecified",
      message: "The background profile does not declare its domains.",
    });
  } else {
    const profileDomains = new Set(profile.domains);
    classification.domains
      .filter((domain) => !profileDomains.has(domain))
      .forEach((domain) =>
        diagnostics.push({
          code: "domain-outside-background",
          message: `The domain ${domain} is outside the background profile.`,
        }),
      );
  }
  if (profile.maximumLevel === undefined) {
    diagnostics.push({
      code: "profile-level-unspecified",
      message: "The background profile does not declare a maximum level.",
    });
  } else if (compareBackgroundLevels(classification.level, profile.maximumLevel) > 0) {
    diagnostics.push({
      code: "level-above-background",
      message: `The level ${classification.level} exceeds the background level ${profile.maximumLevel}.`,
    });
  }

  const [first, ...rest] = diagnostics.map((diagnostic) => Object.freeze(diagnostic));
  return first === undefined
    ? Object.freeze({ ok: true as const, diagnostics: Object.freeze([]) as readonly [] })
    : Object.freeze({ ok: false as const, diagnostics: Object.freeze([first, ...rest] as const) });
}

export function isWithinBackground(
  classification: BackgroundClassification,
  profile: BackgroundProfile,
): boolean {
  return checkBackgroundAdmission(classification, profile).ok;
}

function addDuplicateIssues(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `Each ${label} must be unique.`,
        path: [...path, index],
      });
    }
    seen.add(value);
  });
}
