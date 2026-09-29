import type { ProblemDraft } from "@proof/protocol";

/** A valid draft over the sets pack; tests override single fields. */
export function setDraft(overrides: Partial<ProblemDraft> = {}): ProblemDraft {
  return {
    problem: { title: "Union commutes", statement: "Show that A ∪ B = B ∪ A for sets A and B." },
    background: {
      level: "first-year undergraduate",
      summary: "Elementary set algebra.",
      assumptions: [],
      domains: ["sets"],
      maximumLevel: "undergraduate",
    },
    preferences: { domains: ["sets"], notation: ["\\cup for union"] },
    libraryLayerIds: ["layer:global", "layer:initial-problem"],
    packs: ["pack:sets"],
    declarations: [
      { symbol: "A", sort: "set-of-elements" },
      { symbol: "B", sort: "set-of-elements" },
      { symbol: "p", sort: "proposition" },
    ],
    hypotheses: [{ format: "mathjson", expression: "p" }],
    goals: [{ format: "latex", latex: "A \\cup B = B \\cup A" }],
    ...overrides,
  };
}
