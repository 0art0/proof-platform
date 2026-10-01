import { describe, expect, it } from "vitest";
import { applyKernelCommandSchema, macroLinkSchema, proofEdgeSchema } from "./index";

/** N35: the macro link that labels the commands and edges of a macro application. */

const link = {
  moveId: "authored:intro-twice",
  previewId: "preview:macro",
  stepIndex: 1,
  stepCount: 2,
  stepId: "step-1",
};

const operation = {
  expectedStateId: "state:a",
  resultStateId: "state:b",
  target: { kind: "goal", id: "goal:main" },
  kind: "introduce-implication",
  hypothesisId: "statement:h",
};

const command = {
  commandId: "command:macro:macro:1",
  kind: "apply-kernel-operation",
  actor: { id: "actor:human", kind: "human" },
  parentNodeId: "node:a",
  resultNodeId: "node:b",
  edgeId: "edge:b",
  eventId: "event:b",
  moveId: "move:introduce-implication",
  operation,
  macro: link,
};

describe("macro link", () => {
  it("accepts a step index within the step count only", () => {
    expect(macroLinkSchema.safeParse(link).success).toBe(true);
    expect(macroLinkSchema.safeParse({ ...link, stepIndex: 3 }).success).toBe(false);
    expect(macroLinkSchema.safeParse({ ...link, stepCount: 1 }).success).toBe(false);
    expect(macroLinkSchema.safeParse({ ...link, extra: true }).success).toBe(false);
  });

  it("labels a primitive command and edge, and carries no per-step suggestion evidence", () => {
    expect(applyKernelCommandSchema.safeParse(command).success).toBe(true);
    for (const extra of [
      { suggestionSetId: "suggestion-set:a", chosenSuggestionId: "suggestion:a" },
      { previewId: "preview:macro" },
    ]) {
      expect(applyKernelCommandSchema.safeParse({ ...command, ...extra }).success).toBe(false);
    }
    // The command's own move is the primitive, never the macro itself.
    expect(applyKernelCommandSchema.safeParse({ ...command, moveId: link.moveId }).success).toBe(
      false,
    );
    expect(applyKernelCommandSchema.safeParse({ ...command, moveId: undefined }).success).toBe(
      false,
    );
  });

  it("keeps an edge without a link valid and carries the link when present", () => {
    const edge = {
      id: "edge:b",
      commandId: "command:macro:macro:1",
      parentNodeId: "node:a",
      childNodeId: "node:b",
      moveId: "move:introduce-implication",
      operation,
      transitionClass: "equivalence",
    };
    expect(proofEdgeSchema.safeParse(edge).success).toBe(true);
    const labelled = proofEdgeSchema.safeParse({ ...edge, macro: link });
    expect(labelled.success && labelled.data.macro).toEqual(link);
  });
});
