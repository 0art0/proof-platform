import { describe, expect, it } from "vitest";
import { protocolCommandEnvelopeSchema } from "@proof/protocol";
import { lemmaDraft, lemmaReviewed, READY_PREVIEW } from "./lemma-fixtures.testing";
import {
  existingLabel,
  keptSummary,
  lemmaReviewState,
  refusalExplanation,
} from "./lemma-view-model";
import { extractLemmaEnvelope, newLemmaCommandId, reviewLemmaEnvelope } from "./requests";

describe("lemma view model", () => {
  it("summarizes which hypotheses are kept and left out", () => {
    expect(keptSummary(READY_PREVIEW)).toBe(
      "It keeps 1 hypothesis the proof used. 2 unused hypotheses are left out.",
    );
    expect(keptSummary({ ...READY_PREVIEW, premises: [], unusedHypotheses: [] })).toBe(
      "It needs no hypotheses.",
    );
  });

  it("explains every refusal in plain language", () => {
    const refusal = (code: string) =>
      refusalExplanation({ status: "refused", code, message: "server text" } as never);
    expect(refusal("lemma-not-closed")).toMatch(/not finished yet/);
    expect(refusal("lemma-uses-sorry")).toMatch(/sorry/);
    expect(refusal("lemma-local-dependency")).toMatch(/server text/);
    expect(existingLabel({ artifactId: "x", status: "draft" })).toMatch(/review it in the Library/);
  });

  it("tells an unreviewed draft from a reviewed one and from other artifacts", () => {
    const draft = lemmaDraft();
    expect(lemmaReviewState(draft.artifact, [draft])).toEqual({ kind: "pending" });
    const approved = lemmaReviewed("approved");
    expect(lemmaReviewState(draft.artifact, [draft, approved])).toMatchObject({
      kind: "reviewed",
      decision: "approved",
    });
    expect(lemmaReviewState(approved.artifact, [draft, approved])).toEqual({
      kind: "not-a-lemma-draft",
    });
    const global = lemmaDraft({ layer: "global", provenance: { kind: "curated", source: "x" } });
    expect(lemmaReviewState(global.artifact, [global])).toEqual({ kind: "not-a-lemma-draft" });
  });
});

describe("lemma envelopes", () => {
  it("carries no mathematics, renderings or classification from the browser", () => {
    const save = extractLemmaEnvelope("command:lemma-save-1", "node:root", {
      kind: "goal",
      id: "goal:main",
    });
    expect(save).toEqual({
      commandId: "command:lemma-save-1",
      actor: { id: "actor:web", kind: "human" },
      command: {
        kind: "extract-conditional-lemma",
        nodeId: "node:root",
        target: { kind: "goal", id: "goal:main" },
      },
    });
    const review = reviewLemmaEnvelope("command:lemma-review-1", "result:x", "rejected", "No.");
    expect(protocolCommandEnvelopeSchema.safeParse(review).success).toBe(true);
    expect(review.command).toEqual({
      kind: "review-conditional-lemma",
      draftArtifactId: "result:x",
      decision: "rejected",
      notes: "No.",
    });
    expect(newLemmaCommandId("save")).toMatch(/^command:lemma-save-[0-9a-f-]{36}$/);
  });
});
