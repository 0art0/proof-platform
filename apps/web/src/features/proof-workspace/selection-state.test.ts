import { describe, expect, it } from "vitest";
import type { AnchoredProofSelection, StatementAnchor } from "@proof/selections";
import {
  EMPTY_ABSTRACT_SELECTION_STATE,
  EMPTY_SELECTION_GESTURE_STATE,
  abstractSelectionReducer,
  abstractionForRole,
  describeSelectionFeedback,
  isSelectionAbstract,
  proofSelectionKey,
  selectionGestureReducer,
  selectionsOverlap,
  type SelectionGestureOutcome,
  type SelectionGestureState,
} from "./selection-state";

function anchor(
  targetId: string,
  statement: StatementAnchor["statement"] = { kind: "conclusion" },
): StatementAnchor {
  return {
    stateId: "state:workspace" as StatementAnchor["stateId"],
    target: { kind: "goal", id: targetId as StatementAnchor["target"]["id"] },
    statement,
  };
}

function exact(
  targetId: string,
  path: readonly number[],
  statement?: StatementAnchor["statement"],
): AnchoredProofSelection {
  return { kind: "exact", anchor: anchor(targetId, statement), path };
}

function select(
  state: SelectionGestureState,
  selection: AnchoredProofSelection,
  options: Readonly<{ modifier?: boolean; repeatable?: boolean; fallbackReason?: string }> = {},
): SelectionGestureState {
  return selectionGestureReducer(state, {
    type: "select",
    selection,
    modifier: options.modifier ?? false,
    repeatable: options.repeatable ?? true,
    ...(options.fallbackReason === undefined ? {} : { fallbackReason: options.fallbackReason }),
  });
}

describe("proof selection keys", () => {
  it("distinguishes identical fragments by target, statement, and exact path", () => {
    const conclusionLeft = exact("goal:left", [0]);
    const conclusionRight = exact("goal:right", [0]);
    const hypothesisLeft = exact("goal:left", [0], {
      kind: "hypothesis",
      id: "hypothesis:shared" as StatementAnchor["target"]["id"],
    });
    const repeatedOccurrence = exact("goal:left", [1]);

    expect(
      new Set(
        [conclusionLeft, conclusionRight, hypothesisLeft, repeatedOccurrence].map(
          proofSelectionKey,
        ),
      ),
    ).toHaveProperty("size", 4);
  });

  it("keys a supported associative lens independently from its container", () => {
    const targetAnchor = anchor("goal:left");
    expect(
      proofSelectionKey({
        kind: "associative",
        anchor: targetAnchor,
        containerPath: [0],
        startOperand: 1,
        endOperand: 3,
      }),
    ).not.toBe(proofSelectionKey({ kind: "exact", anchor: targetAnchor, path: [0] }));
  });
});

describe("proof selection gestures", () => {
  it("replaces on ordinary gestures and walks semantic parents on repeated clicks", () => {
    const leaf = exact("goal:left", [0, 1]);
    const other = exact("goal:right", [1]);
    const first = select(EMPTY_SELECTION_GESTURE_STATE, leaf);
    const expanded = select(first, leaf);
    const root = select(expanded, leaf);
    const saturated = select(root, leaf);
    const replaced = select(saturated, other);

    expect(first.active).toEqual([leaf]);
    expect(first.feedback).toEqual({ outcome: "replaced", repeatable: true });
    expect(expanded.active).toEqual([exact("goal:left", [0])]);
    expect(expanded.feedback?.outcome).toBe("expanded");
    expect(root.active).toEqual([exact("goal:left", [])]);
    expect(root.feedback?.outcome).toBe("expanded");
    expect(saturated.active).toEqual([exact("goal:left", [])]);
    expect(saturated.feedback).toEqual({ outcome: "saturated", repeatable: false });
    expect(replaced.active).toEqual([other]);
    expect(replaced.feedback?.outcome).toBe("replaced");
  });

  it("expands an associative occurrence to its containing semantic subtree", () => {
    const lens: AnchoredProofSelection = {
      kind: "associative",
      anchor: anchor("goal:left"),
      containerPath: [1],
      startOperand: 0,
      endOperand: 2,
    };
    const first = select(EMPTY_SELECTION_GESTURE_STATE, lens);
    expect(select(first, lens).active).toEqual([exact("goal:left", [1])]);
  });

  it("does not treat a repeated range gesture as a repeated click", () => {
    const subtree = exact("goal:left", [0]);
    const firstRange = select(EMPTY_SELECTION_GESTURE_STATE, subtree, { repeatable: false });
    const secondRange = select(firstRange, subtree, { repeatable: false });

    expect(secondRange.active).toEqual([subtree]);
    expect(secondRange.repetition).toBeUndefined();
    expect(secondRange.feedback).toEqual({ outcome: "replaced", repeatable: false });
  });

  it("does not expand a click that follows a range gesture on the same occurrence", () => {
    const subtree = exact("goal:left", [0]);
    const range = select(EMPTY_SELECTION_GESTURE_STATE, subtree, { repeatable: false });
    const click = select(range, subtree);
    expect(click.active).toEqual([subtree]);
    expect(click.feedback?.outcome).toBe("replaced");
    expect(select(click, subtree).feedback?.outcome).toBe("expanded");
  });

  it("adds and removes independent occurrences only with Ctrl/Cmd gestures", () => {
    const left = exact("goal:left", [0]);
    const right = exact("goal:right", [0]);
    const selectedLeft = select(EMPTY_SELECTION_GESTURE_STATE, left, { modifier: true });
    const selectedBoth = select(selectedLeft, right, { modifier: true });
    const removedLeft = select(selectedBoth, left, { modifier: true });

    expect(selectedBoth.active).toEqual([left, right]);
    expect(selectedBoth.feedback?.outcome).toBe("added");
    expect(removedLeft.active).toEqual([right]);
    expect(removedLeft.feedback?.outcome).toBe("removed");
  });

  it("does not create overlapping modifier selections in one statement", () => {
    const child = exact("goal:left", [0, 1]);
    const parent = exact("goal:left", [0]);
    const selected = select(EMPTY_SELECTION_GESTURE_STATE, child, { modifier: true });
    const rejected = select(selected, parent, { modifier: true });
    expect(rejected.active).toEqual([child]);
    expect(rejected.feedback?.outcome).toBe("overlap-rejected");
  });

  it("rejects exact/associative overlap but permits an adjacent occurrence", () => {
    const lens: AnchoredProofSelection = {
      kind: "associative",
      anchor: anchor("goal:left"),
      containerPath: [0],
      startOperand: 0,
      endOperand: 2,
    };
    const selected = select(EMPTY_SELECTION_GESTURE_STATE, lens, {
      modifier: true,
      repeatable: false,
    });
    const rejected = select(selected, exact("goal:left", [0, 1, 0]), { modifier: true });
    const accepted = select(rejected, exact("goal:left", [0, 2]), { modifier: true });

    expect(rejected.active).toEqual([lens]);
    expect(rejected.feedback?.outcome).toBe("overlap-rejected");
    expect(accepted.active).toEqual([lens, exact("goal:left", [0, 2])]);
    expect(accepted.feedback?.outcome).toBe("added");
  });

  it("uses an ordinary click to replace a modifier-built active set", () => {
    const left = exact("goal:left", [0]);
    const right = exact("goal:right", [0]);
    const both = select(select(EMPTY_SELECTION_GESTURE_STATE, left, { modifier: true }), right, {
      modifier: true,
    });
    const replaced = select(both, right);
    expect(replaced.active).toEqual([right]);
    expect(replaced.feedback).toEqual({ outcome: "replaced", repeatable: true });
  });

  it("clears the active set and records the cleared outcome", () => {
    const selected = select(EMPTY_SELECTION_GESTURE_STATE, exact("goal:left", [0]));
    const cleared = selectionGestureReducer(selected, { type: "clear" });
    expect(cleared.active).toEqual([]);
    expect(cleared.repetition).toBeUndefined();
    expect(cleared.feedback).toEqual({ outcome: "cleared", repeatable: false });
  });

  it("sets the complete active set for a drop and discards repeated-click memory", () => {
    const selected = select(EMPTY_SELECTION_GESTURE_STATE, exact("goal:left", [0]));
    expect(selected.repetition).toBeDefined();
    const source = exact("goal:left", [], { kind: "hypothesis", id: "hypothesis:h" as never });
    const target = exact("goal:left", []);
    const dropped = selectionGestureReducer(selected, {
      type: "set",
      selections: [source, target],
    });
    expect(dropped.active).toEqual([source, target]);
    expect(dropped.repetition).toBeUndefined();
    expect(dropped.feedback).toEqual({ outcome: "set-by-drop", repeatable: false });
  });

  it("carries a fallback reason with the interpreted outcome", () => {
    const snapped = select(EMPTY_SELECTION_GESTURE_STATE, exact("goal:left", []), {
      fallbackReason: "Stale display metadata was snapped to the statement root.",
    });
    expect(snapped.feedback).toEqual({
      outcome: "replaced",
      // The statement root has no parent, so repeating the click cannot expand it.
      repeatable: false,
      fallbackReason: "Stale display metadata was snapped to the statement root.",
    });
  });
});

describe("selection feedback messages", () => {
  it("describes every outcome, distinguishing repeatable replacements", () => {
    const outcomes: readonly SelectionGestureOutcome[] = [
      "replaced",
      "expanded",
      "saturated",
      "added",
      "removed",
      "overlap-rejected",
      "cleared",
      "set-by-drop",
    ];
    const messages = outcomes.map((outcome) =>
      describeSelectionFeedback({ outcome, repeatable: false }),
    );
    expect(new Set(messages).size).toBe(outcomes.length);
    expect(describeSelectionFeedback({ outcome: "expanded", repeatable: true })).toBe(
      "Expanded to parent.",
    );
    expect(describeSelectionFeedback({ outcome: "replaced", repeatable: true })).toMatch(
      /Click it again to expand/,
    );
    expect(describeSelectionFeedback({ outcome: "replaced", repeatable: false })).not.toMatch(
      /again/,
    );
  });

  it("announces a snapped fallback before the outcome", () => {
    expect(
      describeSelectionFeedback({
        outcome: "replaced",
        repeatable: false,
        fallbackReason: "The range was widened to the smallest containing subtree.",
      }),
    ).toBe(
      "Snapped to nearest subtree (The range was widened to the smallest containing subtree). Selected the occurrence.",
    );
  });
});

describe("selection overlap", () => {
  it("detects nested occurrences in one statement and ignores other statements", () => {
    expect(selectionsOverlap(exact("goal:left", [0]), exact("goal:left", [0, 1]))).toBe(true);
    expect(selectionsOverlap(exact("goal:left", [0]), exact("goal:left", [1]))).toBe(false);
    expect(selectionsOverlap(exact("goal:left", []), exact("goal:right", []))).toBe(false);
  });
});

describe("abstract selection flags", () => {
  const first = exact("goal:left", [0]);
  const second = exact("goal:left", [1]);

  it("toggles one occurrence on and off without touching the others", () => {
    const on = abstractSelectionReducer(EMPTY_ABSTRACT_SELECTION_STATE, {
      type: "toggle",
      selection: first,
    });
    expect(isSelectionAbstract(on, first)).toBe(true);
    expect(isSelectionAbstract(on, second)).toBe(false);
    const both = abstractSelectionReducer(on, { type: "toggle", selection: second });
    expect(both).toHaveLength(2);
    const off = abstractSelectionReducer(both, { type: "toggle", selection: first });
    expect(isSelectionAbstract(off, first)).toBe(false);
    expect(isSelectionAbstract(off, second)).toBe(true);
  });

  it("is order-independent so equal flag sets compare by value", () => {
    const ab = [first, second].reduce<readonly string[]>(
      (state, selection) => abstractSelectionReducer(state, { type: "toggle", selection }),
      EMPTY_ABSTRACT_SELECTION_STATE,
    );
    const ba = [second, first].reduce<readonly string[]>(
      (state, selection) => abstractSelectionReducer(state, { type: "toggle", selection }),
      EMPTY_ABSTRACT_SELECTION_STATE,
    );
    expect(ab).toEqual(ba);
  });

  it("retains flags only for occurrences that are still selected", () => {
    const both = [first, second].reduce<readonly string[]>(
      (state, selection) => abstractSelectionReducer(state, { type: "toggle", selection }),
      EMPTY_ABSTRACT_SELECTION_STATE,
    );
    const kept = abstractSelectionReducer(both, { type: "retain", selections: [second] });
    expect(isSelectionAbstract(kept, first)).toBe(false);
    expect(isSelectionAbstract(kept, second)).toBe(true);
    expect(abstractSelectionReducer(kept, { type: "retain", selections: [second] })).toBe(kept);
    expect(abstractSelectionReducer(kept, { type: "retain", selections: [] })).toEqual([]);
  });

  it("clears every flag and keeps the empty state referentially stable", () => {
    const on = abstractSelectionReducer(EMPTY_ABSTRACT_SELECTION_STATE, {
      type: "toggle",
      selection: first,
    });
    expect(abstractSelectionReducer(on, { type: "clear" })).toEqual([]);
    expect(abstractSelectionReducer(EMPTY_ABSTRACT_SELECTION_STATE, { type: "clear" })).toBe(
      EMPTY_ABSTRACT_SELECTION_STATE,
    );
  });

  it("builds sort-preserving wildcards and refuses binders", () => {
    expect(abstractionForRole(0, "proposition")).toEqual({
      id: "wildcard:request-1",
      symbol: "_a1",
      role: "retrieval-wildcard",
      sort: { kind: "proposition" },
    });
    expect(abstractionForRole(1, "term")).toEqual({
      id: "wildcard:request-2",
      symbol: "_a2",
      role: "retrieval-wildcard",
    });
    expect(abstractionForRole(0, "binder")).toBeUndefined();
  });
});
