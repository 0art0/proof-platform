import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PROBLEM_SETUP_SORT_CHOICES,
  PROBLEM_SETUP_SORT_IDS,
  problemSetupDiagnosticSchema,
  problemSetupOptionsSchema,
  problemSetupReviewSchema,
} from "@proof/protocol";
import { approvedCatalog } from "./approved-catalog";
import { problemSetupOptions, validateProblemDraft } from "./problem-setup";
import { setDraft } from "./problem-setup.testing";

function diagnosticsOf(input: unknown) {
  const result = validateProblemDraft(input);
  if (result.ok) throw new Error("Expected the draft to be rejected.");
  return result.diagnostics;
}

describe("validateProblemDraft", () => {
  it("builds the root node, operators and metadata approval would store", () => {
    const result = validateProblemDraft(setDraft());
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const { review, rootNode, operators, metadata } = result.value;
    expect(problemSetupReviewSchema.parse(review)).toEqual(review);
    expect(Object.isFrozen(review)).toBe(true);
    expect(operators.map(({ symbol }) => symbol)).toEqual(["Union", "Intersection"]);
    expect(review.activePackIds).toContain("pack:sets");
    expect(review.activePackIds).toContain("pack:elementary-logic");
    expect(review.activePackIds).not.toContain("pack:divisibility");
    expect(review.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(rootNode.id).toBe("node:root");
    expect(rootNode.state.obligations).toEqual([]);
    const [goal] = rootNode.state.goals;
    // The LaTeX is parsed; only the plain MathJSON is kept.
    expect(goal?.sequent.conclusion).toEqual({
      expression: ["Equal", ["Union", "A", "B"], ["Union", "B", "A"]],
    });
    expect(goal?.sequent.context.hypotheses).toEqual([
      { id: "hypothesis:1", statement: { expression: "p" } },
    ]);
    expect(goal?.sequent.context.declarations.map(({ id, symbol }) => [id, symbol])).toEqual([
      ["declaration:A", "A"],
      ["declaration:B", "B"],
      ["declaration:p", "p"],
    ]);
    expect(metadata).toEqual({
      problem: setDraft().problem,
      background: setDraft().background,
      preferences: setDraft().preferences,
      libraryLayerIds: ["layer:global", "layer:initial-problem"],
    });
    // The selected pack's results are in the session catalog.
    expect(approvedCatalog(operators).results.some(({ id }) => id.includes("union"))).toBe(true);
  });

  it("stores the same MathJSON whether a statement is entered as LaTeX or MathJSON", () => {
    const latex = validateProblemDraft(setDraft());
    const mathJson = validateProblemDraft(
      setDraft({
        goals: [
          {
            format: "mathjson",
            expression: ["Equal", ["Union", "A", "B"], ["Union", "B", "A"]],
          },
        ],
      }),
    );
    if (!latex.ok || !mathJson.ok) throw new Error("Expected both drafts to validate.");
    expect(mathJson.value.review.digest).toBe(latex.value.review.digest);
  });

  it("gives every goal the shared declarations and hypotheses", () => {
    const result = validateProblemDraft(
      setDraft({
        packs: [],
        declarations: [
          { symbol: "p", sort: "proposition" },
          { symbol: "q", sort: "proposition" },
        ],
        hypotheses: [{ format: "latex", latex: "p \\land q" }],
        goals: [
          { format: "latex", latex: "q" },
          { format: "latex", latex: "p \\lor q" },
        ],
      }),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const goals = result.value.rootNode.state.goals;
    expect(goals.map(({ id }) => id)).toEqual(["goal:1", "goal:2"]);
    expect(goals[0]?.sequent.context).toEqual(goals[1]?.sequent.context);
    expect(result.value.operators).toEqual([]);
  });

  it.each([
    [
      "an unknown sort",
      setDraft({ declarations: [{ symbol: "A", sort: "matrix" as "real" }] }),
      "invalid-draft",
      ["declarations", 0, "sort"],
    ],
    ["no goals", setDraft({ goals: [] }), "invalid-draft", ["goals"]],
    [
      "a duplicate symbol",
      setDraft({
        declarations: [
          { symbol: "A", sort: "set-of-elements" },
          { symbol: "A", sort: "real" },
        ],
      }),
      "duplicate-symbol",
      ["declarations", 1, "symbol"],
    ],
    [
      "a reserved symbol",
      setDraft({ declarations: [{ symbol: "And", sort: "proposition" }] }),
      "reserved-symbol",
      ["declarations", 0, "symbol"],
    ],
    [
      "a pack operator as a declaration",
      setDraft({
        declarations: [...setDraft().declarations, { symbol: "Union", sort: "real" }],
      }),
      "operator-symbol",
      ["declarations", 3, "symbol"],
    ],
    [
      "unparsable LaTeX",
      setDraft({ goals: [{ format: "latex", latex: "A \\cup" }] }),
      "latex-parse-failed",
      ["goals", 0, "latex"],
    ],
    [
      "an operator of an unselected pack",
      setDraft({ packs: [] }),
      "pack-not-selected",
      ["goals", 0, "latex"],
    ],
    [
      "an undeclared symbol",
      setDraft({ hypotheses: [{ format: "mathjson", expression: ["And", "p", "r"] }] }),
      "undeclared-symbol",
      ["hypotheses", 0, "expression"],
    ],
    [
      "a term where a proposition belongs",
      setDraft({ goals: [{ format: "latex", latex: "A \\cup B" }] }),
      "not-a-proposition",
      ["goals", 0, "latex"],
    ],
    [
      "a pack chosen twice",
      setDraft({ packs: ["pack:sets", "pack:sets"] }),
      "duplicate-choice",
      ["packs", 1],
    ],
  ])("rejects %s with a precise diagnostic", (_label, draft, code, path) => {
    const diagnostics = diagnosticsOf(draft);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code, path }));
    diagnostics.forEach((diagnostic) => problemSetupDiagnosticSchema.parse(diagnostic));
  });

  it("names the pack that provides an unselected operator", () => {
    const [diagnostic] = diagnosticsOf(setDraft({ packs: [] }));
    expect(diagnostic?.message).toContain("pack:sets");
    expect(diagnostic?.message).toContain("Union");
  });

  it("never throws and always explains a rejection (property)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (input) => {
        const result = validateProblemDraft(input);
        if (result.ok) return true;
        expect(result.diagnostics.length).toBeGreaterThan(0);
        result.diagnostics.forEach((diagnostic) => problemSetupDiagnosticSchema.parse(diagnostic));
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("is independent of the order packs are picked in (property)", () => {
    const base = setDraft({
      packs: [],
      declarations: [
        { symbol: "a", sort: "integer" },
        { symbol: "b", sort: "integer" },
        { symbol: "A", sort: "set-of-elements" },
      ],
      hypotheses: [{ format: "latex", latex: "a \\mid b" }],
      goals: [{ format: "mathjson", expression: ["Equal", ["Union", "A", "A"], "A"] }],
    });
    const packs = ["pack:sets", "pack:divisibility", "pack:order", "pack:equality"] as const;
    const reference = validateProblemDraft({ ...base, packs: [...packs] });
    if (!reference.ok) throw new Error(JSON.stringify(reference.diagnostics));
    fc.assert(
      fc.property(fc.shuffledSubarray([...packs], { minLength: 4, maxLength: 4 }), (order) => {
        const result = validateProblemDraft({ ...base, packs: order });
        expect(result.ok && result.value.review.digest).toBe(reference.value.review.digest);
      }),
      { numRuns: 30 },
    );
  });
});

describe("problemSetupOptions", () => {
  it("offers the sort menu, layers and every starter pack", () => {
    const options = problemSetupOptionsSchema.parse(problemSetupOptions());
    expect(options.sorts.map(({ id }) => id)).toEqual([...PROBLEM_SETUP_SORT_IDS]);
    expect(PROBLEM_SETUP_SORT_CHOICES.map(({ id }) => id)).toEqual([...PROBLEM_SETUP_SORT_IDS]);
    expect(options.layers.map(({ id }) => id)).not.toContain("layer:move-discovery-draft");
    const sets = options.packs.find(({ id }) => id === "pack:sets");
    expect(sets).toMatchObject({ alwaysActive: false });
    expect(options.packs.find(({ id }) => id === "pack:elementary-logic")).toMatchObject({
      alwaysActive: true,
    });
  });
});
