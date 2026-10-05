import { describe, expect, it } from "vitest";
import type { DisplayedSuggestionSet, MovePreview } from "@proof/protocol";
import {
  layoutSuggestions,
  previewDiff,
  suggestionCategory,
  transitionEvidenceOf,
} from "./preview-diff";

type Operation = MovePreview["operation"];
const operation = (value: Record<string, unknown>) => value as unknown as Operation;

const target = (id: string, conclusion: unknown, hypotheses: unknown[] = []) => ({
  id,
  sequent: { context: { declarations: [], hypotheses }, conclusion: { expression: conclusion } },
});

describe("previewDiff", () => {
  it("reads removed, updated and added targets and new assumptions from the stored delta", () => {
    const diff = previewDiff({
      beforeState: {
        id: "state:before",
        goals: [
          target("goal:a", "p", [{ id: "h:1", statement: { expression: "r" } }]),
          target("goal:b", "q"),
        ],
        obligations: [],
      },
      afterState: {
        id: "state:after",
        goals: [target("goal:a", "p", [{ id: "h:2", statement: { expression: "s" } }])],
        obligations: [target("obligation:c", "t")],
        assumptions: [
          {
            id: "assumption:1",
            declarations: [],
            statement: { expression: "q" },
            origin: { kind: "sorry", sourceTarget: { kind: "goal", id: "goal:b" } },
          },
        ],
      },
      delta: {
        goals: { added: [], removed: ["goal:b"], updated: ["goal:a"] },
        obligations: { added: ["obligation:c"], removed: [], updated: [] },
      },
    } as unknown as MovePreview);
    expect(diff.changes.map((change) => [change.kind, change.collection])).toEqual([
      ["removed", "goal"],
      ["updated", "goal"],
      ["added", "obligation"],
    ]);
    const updated = diff.changes[1];
    expect(updated?.kind === "updated" && updated.conclusionChanged).toBe(false);
    expect(updated?.kind === "updated" && updated.hypothesesRemoved.map(({ id }) => id)).toEqual([
      "h:1",
    ]);
    expect(updated?.kind === "updated" && updated.hypothesesAdded.map(({ id }) => id)).toEqual([
      "h:2",
    ]);
    expect(diff.assumptionsAdded.map(({ id }) => id)).toEqual(["assumption:1"]);
  });
});

describe("transitionEvidenceOf", () => {
  it("keeps sorry, background inference, library results and structural rules distinct", () => {
    expect(transitionEvidenceOf(operation({ kind: "mark-sorry", assumptionId: "a" }))).toBe(
      "sorry",
    );
    expect(
      transitionEvidenceOf(operation({ kind: "close-by-accepted-inference", attestationId: "a" })),
    ).toBe("background-inference");
    expect(
      transitionEvidenceOf(operation({ kind: "apply-result-forward", resultId: "result:r" })),
    ).toBe("library-result");
    expect(
      transitionEvidenceOf(
        operation({
          kind: "rewrite-with-equivalence",
          source: { kind: "result", resultId: "result:r", instantiation: {} },
        }),
      ),
    ).toBe("library-result");
    expect(
      transitionEvidenceOf(
        operation({
          kind: "rewrite-with-equivalence",
          source: { kind: "hypothesis", hypothesisId: "h:1" },
        }),
      ),
    ).toBe("structural");
    expect(transitionEvidenceOf(operation({ kind: "split-goal-conjunction" }))).toBe("structural");
  });

  it("returns the stored kernel evidence when present instead of deriving it", () => {
    // The operation is consulted only for records without stored evidence.
    expect(transitionEvidenceOf(operation({ kind: "split-goal-conjunction" }), "sorry")).toBe(
      "sorry",
    );
    expect(
      transitionEvidenceOf(operation({ kind: "mark-sorry", assumptionId: "a" }), "structural"),
    ).toBe("structural");
    expect(transitionEvidenceOf(operation({ kind: "split-goal-conjunction" }), undefined)).toBe(
      "structural",
    );
  });
});

type Suggestion = DisplayedSuggestionSet["suggestions"][number];
const suggestion = (id: string, extra: Partial<Suggestion> = {}) =>
  ({ id, applicability: "applicable", ...extra }) as unknown as Suggestion;

describe("layoutSuggestions and suggestionCategory", () => {
  it("places each variant group at its first member and keeps the stored order", () => {
    const layout = layoutSuggestions({
      suggestions: [
        suggestion("s:1"),
        suggestion("s:2"),
        suggestion("s:3"),
        suggestion("s:4"),
        suggestion("s:5"),
      ],
      variantGroups: [
        { familyId: "f:a", name: "A", suggestionIds: ["s:2", "s:4"] },
        { familyId: "f:b", name: "B", suggestionIds: ["s:3", "s:5"] },
      ],
    } as unknown as DisplayedSuggestionSet);
    expect(
      layout.map((entry) =>
        entry.kind === "single"
          ? entry.suggestion.id
          : `${entry.familyId}:${entry.lead.id}+${entry.variants.map(({ id }) => id).join(",")}`,
      ),
    ).toEqual(["s:1", "f:a:s:2+s:4", "f:b:s:3+s:5"]);
  });

  it("names the stored retrieval category", () => {
    expect(suggestionCategory(suggestion("s:1"))).toBe("immediate");
    expect(
      suggestionCategory(
        suggestion("s:2", {
          predictedObligations: [{ kind: "premise", index: 0, description: "p" }],
        }),
      ),
    ).toBe("near-miss");
    expect(suggestionCategory(suggestion("s:3", { applicability: "requires-input" }))).toBe(
      "requires-input",
    );
  });
});
