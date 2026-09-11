import { describe, expect, it } from "vitest";
import type { AnchoredProofSelection, StatementAnchor } from "@proof/selections";
import {
  EMPTY_SELECTION_GESTURE_STATE,
  proofSelectionKey,
  selectionGestureReducer,
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
    const first = selectionGestureReducer(EMPTY_SELECTION_GESTURE_STATE, {
      type: "select",
      selection: leaf,
      modifier: false,
    });
    const expanded = selectionGestureReducer(first, {
      type: "select",
      selection: leaf,
      modifier: false,
    });
    const root = selectionGestureReducer(expanded, {
      type: "select",
      selection: leaf,
      modifier: false,
    });
    const replaced = selectionGestureReducer(root, {
      type: "select",
      selection: other,
      modifier: false,
    });

    expect(first.active).toEqual([leaf]);
    expect(expanded.active).toEqual([exact("goal:left", [0])]);
    expect(root.active).toEqual([exact("goal:left", [])]);
    expect(replaced.active).toEqual([other]);
  });

  it("expands an associative occurrence to its containing semantic subtree", () => {
    const lens: AnchoredProofSelection = {
      kind: "associative",
      anchor: anchor("goal:left"),
      containerPath: [1],
      startOperand: 0,
      endOperand: 2,
    };
    const first = selectionGestureReducer(EMPTY_SELECTION_GESTURE_STATE, {
      type: "select",
      selection: lens,
      modifier: false,
    });
    expect(
      selectionGestureReducer(first, {
        type: "select",
        selection: lens,
        modifier: false,
      }).active,
    ).toEqual([exact("goal:left", [1])]);
  });

  it("adds and removes independent occurrences only with Ctrl/Cmd gestures", () => {
    const left = exact("goal:left", [0]);
    const right = exact("goal:right", [0]);
    const selectedLeft = selectionGestureReducer(EMPTY_SELECTION_GESTURE_STATE, {
      type: "select",
      selection: left,
      modifier: true,
    });
    const selectedBoth = selectionGestureReducer(selectedLeft, {
      type: "select",
      selection: right,
      modifier: true,
    });
    const removedLeft = selectionGestureReducer(selectedBoth, {
      type: "select",
      selection: left,
      modifier: true,
    });

    expect(selectedBoth.active).toEqual([left, right]);
    expect(removedLeft.active).toEqual([right]);
  });

  it("does not create overlapping modifier selections in one statement", () => {
    const child = exact("goal:left", [0, 1]);
    const parent = exact("goal:left", [0]);
    const selected = selectionGestureReducer(EMPTY_SELECTION_GESTURE_STATE, {
      type: "select",
      selection: child,
      modifier: true,
    });
    expect(
      selectionGestureReducer(selected, {
        type: "select",
        selection: parent,
        modifier: true,
      }).active,
    ).toEqual([child]);
  });
});
