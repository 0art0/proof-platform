import { retrievalWildcardSchema } from "@proof/protocol";
import type { z } from "zod";
import {
  isOperandPathPrefix,
  parentOperandPath,
  type AnchoredProofSelection,
  type OperandPath,
  type StatementAnchor,
} from "@proof/selections";

/** How the reducer interpreted the most recent gesture. */
export type SelectionGestureOutcome =
  | "replaced"
  | "expanded"
  | "saturated"
  | "added"
  | "removed"
  | "overlap-rejected"
  | "cleared"
  | "set-by-drop";

export type SelectionGestureFeedback = Readonly<{
  outcome: SelectionGestureOutcome;
  /** True when repeating the same primary collapsed click would walk to a semantic parent. */
  repeatable: boolean;
  /** Present when the display gesture was snapped to the nearest semantic subtree. */
  fallbackReason?: string;
}>;

export type SelectionGestureState = Readonly<{
  active: readonly AnchoredProofSelection[];
  repetition?: Readonly<{
    sourceKey: string;
    activeKey: string;
  }>;
  feedback?: SelectionGestureFeedback;
}>;

export type SelectionGestureAction =
  | Readonly<{
      type: "select";
      selection: AnchoredProofSelection;
      modifier: boolean;
      /** Only a primary, collapsed click can participate in repeated-click expansion. */
      repeatable: boolean;
      fallbackReason?: string;
    }>
  | Readonly<{ type: "clear" }>
  /** A drag-and-drop or "drop on selection" gesture chooses the complete active set. */
  | Readonly<{ type: "set"; selections: readonly AnchoredProofSelection[] }>;

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
 * Ordinary gestures replace the active set and repeated primary clicks walk upward.
 * Ctrl/Cmd gestures toggle only independent occurrences in the active set.
 * Every transition records a feedback outcome so the UI can explain its interpretation.
 */
export function selectionGestureReducer(
  state: SelectionGestureState,
  action: SelectionGestureAction,
): SelectionGestureState {
  if (action.type === "clear") {
    return {
      active: EMPTY_SELECTION_GESTURE_STATE.active,
      feedback: { outcome: "cleared", repeatable: false },
    };
  }

  if (action.type === "set") {
    return {
      active: [...action.selections],
      feedback: { outcome: "set-by-drop", repeatable: false },
    };
  }

  const fallback =
    action.fallbackReason === undefined ? {} : { fallbackReason: action.fallbackReason };
  const sourceKey = proofSelectionKey(action.selection);
  if (action.modifier) {
    const existingIndex = state.active.findIndex(
      (selection) => proofSelectionKey(selection) === sourceKey,
    );
    if (existingIndex >= 0) {
      return {
        active: state.active.filter((_selection, index) => index !== existingIndex),
        feedback: { outcome: "removed", repeatable: false, ...fallback },
      };
    }
    if (state.active.some((selection) => selectionsOverlap(selection, action.selection))) {
      return {
        active: state.active,
        feedback: { outcome: "overlap-rejected", repeatable: false, ...fallback },
      };
    }
    return {
      active: [...state.active, action.selection],
      feedback: { outcome: "added", repeatable: false, ...fallback },
    };
  }

  const previous = state.active.length === 1 ? state.active[0] : undefined;
  const canExpand =
    action.repeatable &&
    previous !== undefined &&
    state.repetition?.sourceKey === sourceKey &&
    state.repetition.activeKey === proofSelectionKey(previous);
  const parent = canExpand ? semanticParent(previous) : undefined;
  const active = parent ?? (canExpand ? previous : action.selection);
  const outcome: SelectionGestureOutcome = canExpand
    ? parent === undefined
      ? "saturated"
      : "expanded"
    : "replaced";

  return {
    active: [active],
    ...(action.repeatable
      ? { repetition: { sourceKey, activeKey: proofSelectionKey(active) } }
      : {}),
    feedback: {
      outcome,
      repeatable: action.repeatable && semanticParent(active) !== undefined,
      ...fallback,
    },
  };
}

/**
 * The selections the user marked "abstract": a retrieval-only flag kept beside, never inside, the
 * selection set. It is a sorted list of `proofSelectionKey`s so equal states compare by value.
 */
export type AbstractSelectionState = readonly string[];

export type AbstractSelectionAction =
  | Readonly<{ type: "toggle"; selection: AnchoredProofSelection }>
  /** A selection change keeps the flag only for occurrences that are still selected. */
  | Readonly<{ type: "retain"; selections: readonly AnchoredProofSelection[] }>
  | Readonly<{ type: "clear" }>;

export const EMPTY_ABSTRACT_SELECTION_STATE: AbstractSelectionState = Object.freeze([]);

export function abstractSelectionReducer(
  state: AbstractSelectionState,
  action: AbstractSelectionAction,
): AbstractSelectionState {
  if (action.type === "clear") {
    return state.length === 0 ? state : EMPTY_ABSTRACT_SELECTION_STATE;
  }
  if (action.type === "retain") {
    const selected = new Set(action.selections.map(proofSelectionKey));
    const kept = state.filter((key) => selected.has(key));
    return kept.length === state.length ? state : kept;
  }
  const key = proofSelectionKey(action.selection);
  return state.includes(key) ? state.filter((entry) => entry !== key) : [...state, key].sort();
}

export function isSelectionAbstract(
  state: AbstractSelectionState,
  selection: AnchoredProofSelection,
): boolean {
  return state.includes(proofSelectionKey(selection));
}

/**
 * The typed wildcard for an abstract selection at request position `position` (0-based). It
 * preserves the occurrence's sort where it is knowable: a proposition occurrence is abstracted by
 * a proposition wildcard; a term keeps an unsorted wildcard because the selection does not carry
 * the term's sort. A binder declaration, or an unresolved occurrence, cannot be abstracted.
 */
export function abstractionForRole(
  position: number,
  role: "proposition" | "term" | "binder" | undefined,
): z.infer<typeof retrievalWildcardSchema> | undefined {
  if (role === undefined || role === "binder") return undefined;
  return retrievalWildcardSchema.parse({
    id: `wildcard:request-${position + 1}`,
    symbol: `_a${position + 1}`,
    role: "retrieval-wildcard",
    ...(role === "proposition" ? { sort: { kind: "proposition" } } : {}),
  });
}

const OUTCOME_MESSAGES: Readonly<Record<SelectionGestureOutcome, string>> = Object.freeze({
  replaced: "Selected the occurrence.",
  expanded: "Expanded to parent.",
  saturated: "Already at the statement root; the selection cannot expand further.",
  added: "Added the occurrence to the selection set.",
  removed: "Removed the occurrence from the selection set.",
  "overlap-rejected": "Not added: the occurrence overlaps an active selection.",
  cleared: "Selections cleared.",
  "set-by-drop": "Selected the drop source and target to preview a move.",
});

/** A short, screen-reader-friendly description of how the last gesture was interpreted. */
export function describeSelectionFeedback(feedback: SelectionGestureFeedback): string {
  const base =
    feedback.outcome === "replaced" && feedback.repeatable
      ? "Selected the occurrence. Click it again to expand to its parent."
      : OUTCOME_MESSAGES[feedback.outcome];
  return feedback.fallbackReason === undefined
    ? base
    : `Snapped to nearest subtree (${feedback.fallbackReason.replace(/\.$/, "")}). ${base}`;
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

export function selectionsOverlap(
  left: AnchoredProofSelection,
  right: AnchoredProofSelection,
): boolean {
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
