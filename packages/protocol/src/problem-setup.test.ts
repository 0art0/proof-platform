import { sortSchema } from "@proof/mathjson-model";
import { describe, expect, it } from "vitest";
import {
  PROBLEM_SETUP_LAYER_CHOICES,
  PROBLEM_SETUP_LAYER_IDS,
  PROBLEM_SETUP_SORT_CHOICES,
  PROBLEM_SETUP_SORT_IDS,
  problemApprovalRequestSchema,
  problemDraftSchema,
  problemDraftValidationResponseSchema,
  problemSetupSort,
  problemStatementInputSchema,
} from "./problem-setup";

const draft = {
  problem: { title: "t", statement: "s" },
  background: { level: "school", summary: "Logic.", assumptions: [] },
  libraryLayerIds: ["layer:global"],
  packs: [],
  declarations: [{ symbol: "p", sort: "proposition" }],
  hypotheses: [],
  goals: [{ format: "latex", latex: "p" }],
};

describe("problem setup schemas", () => {
  it("keeps the sort and layer menus in step with their ID enums", () => {
    expect(PROBLEM_SETUP_SORT_CHOICES.map(({ id }) => id)).toEqual([...PROBLEM_SETUP_SORT_IDS]);
    expect(PROBLEM_SETUP_LAYER_CHOICES.map(({ id }) => id)).toEqual([...PROBLEM_SETUP_LAYER_IDS]);
    PROBLEM_SETUP_SORT_CHOICES.forEach(({ sort }) => expect(sortSchema.parse(sort)).toEqual(sort));
    expect(Object.isFrozen(PROBLEM_SETUP_SORT_CHOICES)).toBe(true);
    expect(problemSetupSort("set-of-elements")).toEqual({
      kind: "named",
      id: "sort:set",
      arguments: [{ kind: "named", id: "sort:element" }],
    });
  });

  it("accepts a minimal draft and rejects unknown fields strictly", () => {
    expect(problemDraftSchema.parse(draft)).toEqual(draft);
    expect(problemDraftSchema.safeParse({ ...draft, rootNode: {} }).success).toBe(false);
    expect(
      problemDraftSchema.safeParse({ ...draft, declarations: [{ symbol: "p", sort: "matrix" }] })
        .success,
    ).toBe(false);
    expect(
      problemDraftSchema.safeParse({ ...draft, declarations: [{ symbol: "1p", sort: "real" }] })
        .success,
    ).toBe(false);
    expect(problemDraftSchema.safeParse({ ...draft, goals: [] }).success).toBe(false);
    expect(
      problemDraftSchema.safeParse({ ...draft, libraryLayerIds: ["layer:move-discovery-draft"] })
        .success,
    ).toBe(false);
  });

  it("takes statements as LaTeX or plain MathJSON only", () => {
    expect(problemStatementInputSchema.safeParse({ format: "latex", latex: "" }).success).toBe(
      false,
    );
    expect(
      problemStatementInputSchema.safeParse({ format: "mathjson", expression: ["And", "p", "q"] })
        .success,
    ).toBe(true);
    expect(
      problemStatementInputSchema.safeParse({ format: "mathjson", expression: { bad: 1 } }).success,
    ).toBe(false);
  });

  it("requires a digest to approve and diagnostics to reject", () => {
    expect(problemApprovalRequestSchema.safeParse({ sessionId: "session:x", draft }).success).toBe(
      false,
    );
    expect(
      problemApprovalRequestSchema.safeParse({
        sessionId: "session:x",
        draft,
        reviewedDigest: `sha256:${"0".repeat(64)}`,
      }).success,
    ).toBe(true);
    expect(
      problemDraftValidationResponseSchema.safeParse({ ok: false, diagnostics: [] }).success,
    ).toBe(false);
  });
});
