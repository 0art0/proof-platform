import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_LEVELS,
  backgroundClassificationSchema,
  backgroundProfileSchema,
  checkBackgroundAdmission,
  compareBackgroundLevels,
  isWithinBackground,
  type BackgroundClassification,
  type BackgroundLevel,
  type BackgroundProfile,
} from "./index";

function profile(overrides: Partial<BackgroundProfile> = {}): BackgroundProfile {
  return backgroundProfileSchema.parse({
    level: "undergraduate",
    summary: "Elementary logic and set theory.",
    assumptions: [],
    domains: ["logic", "set theory"],
    maximumLevel: "undergraduate",
    ...overrides,
  });
}

function classification(domains: string[], level: BackgroundLevel): BackgroundClassification {
  return backgroundClassificationSchema.parse({ domains, level });
}

describe("background profile and classification contracts", () => {
  it("keeps free-text-only profiles valid and adds optional structured fields", () => {
    expect(
      backgroundProfileSchema.safeParse({ level: "basic", summary: "Basic.", assumptions: [] })
        .success,
    ).toBe(true);
    expect(backgroundProfileSchema.safeParse(profile()).success).toBe(true);
    expect(
      backgroundProfileSchema.safeParse({ ...profile(), maximumLevel: "expert" }).success,
    ).toBe(false);
    expect(backgroundProfileSchema.safeParse({ ...profile(), domains: ["a", "a"] }).success).toBe(
      false,
    );
    expect(
      backgroundProfileSchema.safeParse({ ...profile(), assumptions: ["x", "x"] }).success,
    ).toBe(false);
    expect(backgroundProfileSchema.safeParse({ ...profile(), approved: true }).success).toBe(false);
  });

  it("classifies artifacts with the shared ordered level enum", () => {
    expect(
      backgroundClassificationSchema.safeParse({ domains: ["logic"], level: "graduate" }).success,
    ).toBe(true);
    expect(
      backgroundClassificationSchema.safeParse({ domains: ["logic"], level: "hard" }).success,
    ).toBe(false);
    expect(
      backgroundClassificationSchema.safeParse({ domains: [], level: "graduate" }).success,
    ).toBe(false);
    expect(compareBackgroundLevels("foundational", "research")).toBeLessThan(0);
    expect(compareBackgroundLevels("graduate", "graduate")).toBe(0);
  });
});

describe("deterministic background admission", () => {
  it("admits artifacts whose domains and level lie within the profile", () => {
    expect(isWithinBackground(classification(["logic"], "foundational"), profile())).toBe(true);
    expect(
      isWithinBackground(classification(["logic", "set theory"], "undergraduate"), profile()),
    ).toBe(true);
    const result = checkBackgroundAdmission(classification(["logic"], "foundational"), profile());
    expect(result).toEqual({ ok: true, diagnostics: [] });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects out-of-domain and above-level artifacts with specific diagnostics", () => {
    expect(
      checkBackgroundAdmission(classification(["logic", "topology"], "graduate"), profile()),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "domain-outside-background" }, { code: "level-above-background" }],
    });
  });

  it("admits nothing deterministically when the profile lacks structured fields", () => {
    const freeText = backgroundProfileSchema.parse({
      level: "basic",
      summary: "Basic.",
      assumptions: [],
    });
    expect(
      checkBackgroundAdmission(classification(["logic"], "foundational"), freeText),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "profile-domains-unspecified" }, { code: "profile-level-unspecified" }],
    });
  });

  it("is monotone: widening a profile never rejects an admitted artifact", () => {
    const domain = fc.constantFrom("logic", "set theory", "algebra", "topology");
    const level = fc.constantFrom(...BACKGROUND_LEVELS);
    fc.assert(
      fc.property(
        fc.uniqueArray(domain, { minLength: 1 }),
        level,
        fc.uniqueArray(domain),
        level,
        fc.uniqueArray(domain),
        level,
        (domains, artifactLevel, profileDomains, profileLevel, extraDomains, widerLevel) => {
          const artifact = classification(domains, artifactLevel);
          const narrow = profile({ domains: profileDomains, maximumLevel: profileLevel });
          const wide = profile({
            domains: [...new Set([...profileDomains, ...extraDomains])],
            maximumLevel:
              compareBackgroundLevels(widerLevel, profileLevel) >= 0 ? widerLevel : profileLevel,
          });
          const expected =
            domains.every((candidate) => profileDomains.includes(candidate)) &&
            compareBackgroundLevels(artifactLevel, profileLevel) <= 0;
          expect(isWithinBackground(artifact, narrow)).toBe(expected);
          if (expected) expect(isWithinBackground(artifact, wide)).toBe(true);
        },
      ),
    );
  });
});
