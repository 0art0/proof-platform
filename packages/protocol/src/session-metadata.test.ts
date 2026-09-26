import { describe, expect, it } from "vitest";
import { backgroundProfileSchema, isWithinBackground, proofSessionMetadataSchema } from "./index";

const metadata = {
  problem: {
    title: "Excluded middle",
    statement: "Show that p or not p.",
    statementMathJson: ["Or", "p", ["Not", "p"]],
  },
  background: {
    level: "elementary propositional logic",
    summary: "Truth-functional connectives and natural deduction.",
    assumptions: [],
    domains: ["logic"],
    maximumLevel: "foundational",
  },
  preferences: { domains: ["logic"], notation: ["Use \\lnot for negation"] },
  libraryLayerIds: ["layer:global"],
} as const;

describe("proof-session metadata", () => {
  it("accepts complete and minimal metadata", () => {
    expect(proofSessionMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      proofSessionMetadataSchema.safeParse({
        problem: { title: "T", statement: "S" },
        background: { level: "basic", summary: "Basic.", assumptions: [] },
        libraryLayerIds: [],
      }).success,
    ).toBe(true);
  });

  it("rejects unknown fields, duplicates and invalid layer ids", () => {
    expect(proofSessionMetadataSchema.safeParse({ ...metadata, approved: true }).success).toBe(
      false,
    );
    expect(
      proofSessionMetadataSchema.safeParse({
        ...metadata,
        libraryLayerIds: ["layer:global", "layer:global"],
      }).success,
    ).toBe(false);
    expect(
      proofSessionMetadataSchema.safeParse({ ...metadata, libraryLayerIds: ["not an id"] }).success,
    ).toBe(false);
    expect(
      proofSessionMetadataSchema.safeParse({
        ...metadata,
        preferences: { notation: ["x", "x"] },
      }).success,
    ).toBe(false);
    expect(
      proofSessionMetadataSchema.safeParse({ ...metadata, problem: { title: "", statement: "S" } })
        .success,
    ).toBe(false);
  });

  it("re-exports the library background profile and admission helper", () => {
    const profile = backgroundProfileSchema.parse(metadata.background);
    expect(isWithinBackground({ domains: ["logic"], level: "foundational" }, profile)).toBe(true);
    expect(isWithinBackground({ domains: ["logic"], level: "graduate" }, profile)).toBe(false);
  });
});
