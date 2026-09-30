import { describe, expect, it } from "vitest";
import type { DisplayedSuggestionSet } from "@proof/protocol";
import type { AnchoredProofSelection, StatementAnchor } from "@proof/selections";
import type { DragSource } from "./drag-state";
import {
  NO_MOVE_MESSAGE,
  chooseDroppedSuggestion,
  dragSourceForSelection,
  dragSourceKey,
  dropTargetFor,
  planDrop,
  suggestionSetMatchesPlan,
} from "./drop-resolution";

const STATE = "state:a";

function anchor(
  statement: StatementAnchor["statement"] = { kind: "conclusion" },
  targetId = "goal:a",
  stateId = STATE,
): StatementAnchor {
  return {
    stateId,
    target: { kind: "goal", id: targetId },
    statement,
  } as StatementAnchor;
}

const hypothesisAnchor = anchor({ kind: "hypothesis", id: "hypothesis:h1" } as never);

function exact(at: StatementAnchor, path: readonly number[] = []): AnchoredProofSelection {
  return { kind: "exact", anchor: at, path };
}

const hypothesis = dragSourceForSelection(exact(hypothesisAnchor), "H1");
const term = dragSourceForSelection(exact(hypothesisAnchor, [0]), "a term");
const result: DragSource = { kind: "result", artifactId: "result:lemma", label: "Lemma" };

function suggestion(
  id: string,
  artifactId: string,
  source: "move" | "result",
  /** The slot each request selection is assigned to, in request order (undefined: a result). */
  slots: readonly (string | undefined)[],
  name = id,
) {
  return {
    id,
    source,
    artifactId,
    name,
    selectionMatches: slots.map((selectionSlotId, index) => ({
      selectionId: `selection:request-${index + 1}`,
      ...(selectionSlotId === undefined ? {} : { selectionSlotId }),
    })),
  };
}

function setOf(...suggestions: unknown[]): DisplayedSuggestionSet {
  return { suggestions } as unknown as DisplayedSuggestionSet;
}

describe("drag sources", () => {
  it("treats a whole hypothesis as a hypothesis drag and anything else as a term", () => {
    expect(hypothesis.kind).toBe("hypothesis");
    expect(term.kind).toBe("term");
    expect(dragSourceForSelection(exact(anchor(), []), "conclusion").kind).toBe("term");
  });

  it("identifies sources stably", () => {
    expect(dragSourceKey(result)).toBe("result:result:lemma");
    expect(dragSourceKey(hypothesis)).toBe(dragSourceKey({ ...hypothesis, label: "renamed" }));
    expect(dragSourceKey(hypothesis)).not.toBe(dragSourceKey(term));
  });

  it("drops a hypothesis on the whole conclusion and other sources on the occurrence", () => {
    const occurrence = exact(anchor(), [1]);
    expect(dropTargetFor(hypothesis, anchor(), occurrence)).toEqual(exact(anchor(), []));
    expect(dropTargetFor(term, anchor(), occurrence)).toBe(occurrence);
    expect(dropTargetFor(result, anchor(), occurrence)).toBe(occurrence);
  });
});

describe("planning a drop", () => {
  it("plans the three drag kinds with the source first", () => {
    const goal = exact(anchor());
    expect(planDrop(hypothesis, goal, STATE)).toMatchObject({
      ok: true,
      plan: { kind: "hypothesis-on-goal", selections: [hypothesis.selection, goal] },
    });
    const slot = exact(anchor(), [1]);
    const withTerm = dragSourceForSelection(exact(anchor(), [0]), "term");
    expect(planDrop(withTerm, slot, STATE)).toMatchObject({
      ok: true,
      plan: { kind: "term-on-slot", selections: [withTerm.selection, slot] },
    });
    expect(planDrop(result, slot, STATE)).toMatchObject({
      ok: true,
      plan: { kind: "result-on-expression", selections: [slot] },
    });
  });

  it("refuses every unsupported combination with a no-move message", () => {
    const refusals = [
      planDrop(
        hypothesis,
        exact(anchor({ kind: "hypothesis", id: "hypothesis:h2" } as never)),
        STATE,
      ),
      planDrop(hypothesis, exact(anchor(undefined, "goal:other")), STATE),
      planDrop(hypothesis, exact(anchor(undefined, "goal:a", "state:old")), STATE),
      planDrop(result, exact(anchor(undefined, "goal:a", "state:old")), STATE),
      planDrop(term, exact(hypothesisAnchor, [0, 1]), STATE),
      planDrop(term, exact(hypothesisAnchor, [0]), STATE),
      planDrop(
        dragSourceForSelection(exact(anchor(undefined, "goal:a", "state:old"), [0]), "old"),
        exact(anchor(), [1]),
        STATE,
      ),
    ];
    for (const refusal of refusals) {
      expect(refusal.ok).toBe(false);
      if (!refusal.ok) expect(refusal.message.startsWith(NO_MOVE_MESSAGE)).toBe(true);
    }
  });
});

describe("choosing the dropped suggestion", () => {
  const goal = exact(anchor());
  const hypothesisPlan = (() => {
    const planned = planDrop(hypothesis, goal, STATE);
    if (!planned.ok) throw new Error("expected a plan");
    return planned.plan;
  })();

  it("takes the first suggestion putting the hypothesis in a hypothesis slot and the goal in the target", () => {
    const set = setOf(
      suggestion("s:swapped", "move:odd", "move", ["target", "fact"]),
      suggestion("s:close", "move:close-by-hypothesis", "move", ["fact", "target"]),
      suggestion("s:rewrite", "move:rewrite-with-equality", "move", ["equality", "target"]),
    );
    expect(chooseDroppedSuggestion(hypothesisPlan, set)).toEqual({
      suggestionId: "s:close",
      verb: "Use hypothesis",
    });
  });

  it("names rewrites and specializations, and invents no match", () => {
    expect(
      chooseDroppedSuggestion(
        hypothesisPlan,
        setOf(suggestion("s:r", "move:rewrite-with-equality", "move", ["equality", "occurrence"])),
      )?.verb,
    ).toBe("Rewrite");
    expect(
      chooseDroppedSuggestion(
        hypothesisPlan,
        setOf(
          suggestion("s:i", "move:instantiate-universal-hypothesis", "move", [
            "universal",
            "target",
          ]),
        ),
      )?.verb,
    ).toBe("Specialize");
    expect(
      chooseDroppedSuggestion(
        hypothesisPlan,
        setOf(suggestion("s:term", "move:x", "move", ["term", "target"])),
      ),
    ).toBeUndefined();
    expect(chooseDroppedSuggestion(hypothesisPlan, setOf())).toBeUndefined();
  });

  it("requires the dragged term to fill a term slot for a term drag", () => {
    const planned = planDrop(
      dragSourceForSelection(exact(anchor(), [0]), "term"),
      exact(anchor(), [1]),
      STATE,
    );
    if (!planned.ok) throw new Error("expected a plan");
    expect(
      chooseDroppedSuggestion(
        planned.plan,
        setOf(
          suggestion("s:rewrite", "move:rewrite-with-equality", "move", ["equality", "target"]),
        ),
      ),
    ).toBeUndefined();
    expect(
      chooseDroppedSuggestion(
        planned.plan,
        setOf(
          suggestion("s:rewrite", "move:rewrite-with-equality", "move", ["equality", "target"]),
          suggestion("s:inst", "move:instantiate-universal-hypothesis", "move", [
            "term",
            "universal",
          ]),
        ),
      ),
    ).toEqual({ suggestionId: "s:inst", verb: "Instantiate" });
  });

  it("takes the dragged result and no other result for a result drag", () => {
    const planned = planDrop(result, goal, STATE);
    if (!planned.ok) throw new Error("expected a plan");
    const set = setOf(
      suggestion("s:other", "result:other", "result", [undefined]),
      suggestion("s:move", "result:lemma", "move", ["target"]),
      suggestion("s:lemma", "result:lemma", "result", [undefined]),
    );
    expect(chooseDroppedSuggestion(planned.plan, set)).toEqual({
      suggestionId: "s:lemma",
      verb: "Apply result",
    });
    expect(chooseDroppedSuggestion(planned.plan, setOf(set.suggestions[0]!))).toBeUndefined();
  });
});

describe("matching a displayed set to a plan", () => {
  const goal = exact(anchor());
  const planned = planDrop(hypothesis, goal, STATE);
  if (!planned.ok) throw new Error("expected a plan");

  it("matches only a query over exactly the plan's selections in order", () => {
    const query = (selections: readonly AnchoredProofSelection[]) =>
      ({
        selection: {
          kind: "selection-query",
          selections: selections.map((selection) => ({ selection })),
        },
      }) as unknown as DisplayedSuggestionSet;
    expect(suggestionSetMatchesPlan(planned.plan, query([hypothesis.selection, goal]))).toBe(true);
    expect(suggestionSetMatchesPlan(planned.plan, query([goal, hypothesis.selection]))).toBe(false);
    expect(suggestionSetMatchesPlan(planned.plan, query([goal]))).toBe(false);
    const single = planDrop(result, goal, STATE);
    if (!single.ok) throw new Error("expected a plan");
    expect(
      suggestionSetMatchesPlan(single.plan, {
        selection: goal,
      } as unknown as DisplayedSuggestionSet),
    ).toBe(true);
  });
});
