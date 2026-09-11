import {
  isOperandPathPrefix,
  parentOperandPath,
  type AnchoredProofSelection,
  type OperandPath,
  type StatementAnchor,
} from "@proof/selections";

export type SelectionGestureState = Readonly<{
  active: readonly AnchoredProofSelection[];
  repetition?: Readonly<{
    sourceKey: string;
    activeKey: string;
  }>;
}>;

export type SelectionGestureAction =
  | Readonly<{
      type: "select";
      selection: AnchoredProofSelection;
      modifier: boolean;
    }>
  | Readonly<{ type: "clear" }>;

export const EMPTY_SELECTION_GESTURE_STATE: SelectionGestureState = Object.freeze({
  active: Object.freeze([]),
});

/** A deterministic key for the complete statement anchor and semantic occurrence. */
export function proofSelectionKey(selection: AnchoredProofSelection): string {
  const anchor = stableAnchor(selection.anchor);
  return JSON.stringify({
    anchor,
    occurrence:
      selection.kind === "exact"
        ? { kind: "exact", path: selection.path }
        : {
            kind: "associative",
            containerPath: selection.containerPath,
            startOperand: selection.startOperand,
            endOperand: selection.endOperand,
          },
  });
}

/**
 * Ordinary gestures replace the active set and repeated gestures walk upward.
 * Ctrl/Cmd gestures toggle only independent occurrences in the active set.
 */
export function selectionGestureReducer(
  state: SelectionGestureState,
  action: SelectionGestureAction,
): SelectionGestureState {
  if (action.type === "clear") return EMPTY_SELECTION_GESTURE_STATE;

  const sourceKey = proofSelectionKey(action.selection);
  if (action.modifier) {
    const existingIndex = state.active.findIndex(
      (selection) => proofSelectionKey(selection) === sourceKey,
    );
    if (existingIndex >= 0) {
      return {
        active: state.active.filter((_selection, index) => index !== existingIndex),
      };
    }
    if (state.active.some((selection) => selectionsOverlap(selection, action.selection))) {
      return { active: state.active };
    }
    return { active: [...state.active, action.selection] };
  }

  const previous = state.active.length === 1 ? state.active[0] : undefined;
  const canExpand =
    previous !== undefined &&
    state.repetition?.sourceKey === sourceKey &&
    state.repetition.activeKey === proofSelectionKey(previous);
  const active = canExpand ? (semanticParent(previous) ?? previous) : action.selection;

  return {
    active: [active],
    repetition: { sourceKey, activeKey: proofSelectionKey(active) },
  };
}

function stableAnchor(anchor: StatementAnchor): StatementAnchor {
  return {
    stateId: anchor.stateId,
    target: { kind: anchor.target.kind, id: anchor.target.id },
    statement:
      anchor.statement.kind === "conclusion"
        ? { kind: "conclusion" }
        : { kind: "hypothesis", id: anchor.statement.id },
  };
}

function semanticParent(selection: AnchoredProofSelection): AnchoredProofSelection | undefined {
  if (selection.kind === "associative") {
    return { kind: "exact", anchor: selection.anchor, path: selection.containerPath };
  }
  const path = parentOperandPath(selection.path);
  return path === undefined ? undefined : { kind: "exact", anchor: selection.anchor, path };
}

function selectionsOverlap(left: AnchoredProofSelection, right: AnchoredProofSelection): boolean {
  if (JSON.stringify(stableAnchor(left.anchor)) !== JSON.stringify(stableAnchor(right.anchor))) {
    return false;
  }
  return coveragePaths(left).some((leftPath) =>
    coveragePaths(right).some(
      (rightPath) =>
        isOperandPathPrefix(leftPath, rightPath) || isOperandPathPrefix(rightPath, leftPath),
    ),
  );
}

function coveragePaths(selection: AnchoredProofSelection): readonly OperandPath[] {
  if (selection.kind === "exact") return [selection.path];
  return Array.from({ length: selection.endOperand - selection.startOperand }, (_unused, index) => [
    ...selection.containerPath,
    selection.startOperand + index,
  ]);
}
