import type { DisplayedSuggestionSet } from "@proof/protocol";
import type { AnchoredProofSelection, StatementAnchor } from "@proof/selections";
import { proofSelectionKey, selectionsOverlap } from "../proof-workspace/selection-state";
import type { DragSource } from "./drag-state";

/** The three drag gestures of design plan §8.3. */
export type DragKind = "result-on-expression" | "hypothesis-on-goal" | "term-on-slot";

export type DropPlan = Readonly<{
  kind: DragKind;
  source: DragSource;
  target: AnchoredProofSelection;
  /** The selections the suggestion request names, in order: the source first, then the target. */
  selections: readonly AnchoredProofSelection[];
}>;

export type PlanDropResult =
  Readonly<{ ok: true; plan: DropPlan }> | Readonly<{ ok: false; message: string }>;

export const NO_MOVE_MESSAGE = "No move applies here";

const refuse = (detail: string): PlanDropResult => ({
  ok: false,
  message: `${NO_MOVE_MESSAGE}: ${detail}`,
});

/** A hypothesis drag starts from a whole hypothesis; any other occurrence is a term. */
export function dragSourceForSelection(
  selection: AnchoredProofSelection,
  label: string,
): Exclude<DragSource, { kind: "result" }> {
  const wholeHypothesis =
    selection.anchor.statement.kind === "hypothesis" &&
    selection.kind === "exact" &&
    selection.path.length === 0;
  return { kind: wholeHypothesis ? "hypothesis" : "term", selection, label };
}

/**
 * The occurrence a drop names. Dropping a hypothesis onto a goal always targets the whole
 * conclusion; other drops target the occurrence under the pointer (or the active selection).
 */
export function dropTargetFor(
  source: DragSource,
  anchor: StatementAnchor,
  occurrence: AnchoredProofSelection,
): AnchoredProofSelection {
  return source.kind === "hypothesis" ? { kind: "exact", anchor, path: [] } : occurrence;
}

function sameTarget(left: StatementAnchor, right: StatementAnchor): boolean {
  return left.target.kind === right.target.kind && left.target.id === right.target.id;
}

/** Decide whether a source and target can form a two-selection (or result) query. */
export function planDrop(
  source: DragSource,
  target: AnchoredProofSelection,
  stateId: string,
): PlanDropResult {
  if (target.anchor.stateId !== stateId) {
    return refuse("the target belongs to an older proof snapshot.");
  }
  if (source.kind === "result") {
    return {
      ok: true,
      plan: { kind: "result-on-expression", source, target, selections: [target] },
    };
  }
  if (source.selection.anchor.stateId !== stateId) {
    return refuse("the dragged occurrence belongs to an older proof snapshot.");
  }
  if (!sameTarget(source.selection.anchor, target.anchor)) {
    return refuse("the source and target belong to different goals or obligations.");
  }
  if (source.kind === "hypothesis") {
    if (target.anchor.statement.kind !== "conclusion") {
      return refuse("a hypothesis can only be dropped on a goal or obligation conclusion.");
    }
    return {
      ok: true,
      plan: {
        kind: "hypothesis-on-goal",
        source,
        target,
        selections: [source.selection, target],
      },
    };
  }
  if (selectionsOverlap(source.selection, target)) {
    return refuse("the term and the slot overlap.");
  }
  return {
    ok: true,
    plan: { kind: "term-on-slot", source, target, selections: [source.selection, target] },
  };
}

export type DroppedSuggestion = Readonly<{ suggestionId: string; verb: string }>;
type DisplayedSuggestion = DisplayedSuggestionSet["suggestions"][number];

/** The move slots (see `@proof/moves`) that receive the goal side, and those that receive a term. */
const TARGET_SLOTS: ReadonlySet<string> = new Set(["target", "occurrence"]);
const TERM_SLOTS: ReadonlySet<string> = new Set(["term", "witness"]);

function slotOf(suggestion: DisplayedSuggestion, position: number): string | undefined {
  return suggestion.selectionMatches.find(
    ({ selectionId }) => selectionId === `selection:request-${position}`,
  )?.selectionSlotId;
}

/**
 * A two-selection query makes every displayed suggestion account for both selections, so the
 * slots they are assigned to decide what the drop means: a hypothesis goes to a hypothesis slot
 * and the goal to the target (or rewrite-occurrence) slot; a term goes to a term slot and the
 * other occurrence to any other slot.
 */
function fitsDrop(plan: DropPlan, suggestion: DisplayedSuggestion): boolean {
  const from = slotOf(suggestion, 1);
  const to = slotOf(suggestion, 2);
  if (from === undefined || to === undefined) return false;
  if (plan.kind === "hypothesis-on-goal") {
    return !TARGET_SLOTS.has(from) && !TERM_SLOTS.has(from) && TARGET_SLOTS.has(to);
  }
  return TERM_SLOTS.has(from) && !TERM_SLOTS.has(to);
}

function verbFor(plan: DropPlan, suggestion: DisplayedSuggestion): string {
  if (suggestion.source === "result") return "Apply result";
  if (plan.kind === "term-on-slot") return "Instantiate";
  if (/rewrite/i.test(suggestion.artifactId)) return "Rewrite";
  if (/instantiat|specializ/i.test(suggestion.artifactId)) return "Specialize";
  return "Use hypothesis";
}

/**
 * Pick, from the displayed set, the suggestion the drop asks for: the dragged result for a result
 * drag; otherwise the first displayed suggestion whose slot assignment fits the drop. Only a
 * displayed suggestion is ever chosen; nothing is invented, and a drop no suggestion fits is
 * reported as having no move.
 */
export function chooseDroppedSuggestion(
  plan: DropPlan,
  set: DisplayedSuggestionSet,
): DroppedSuggestion | undefined {
  const source = plan.source;
  const chosen =
    plan.kind === "result-on-expression"
      ? set.suggestions.find(
          (suggestion) =>
            source.kind === "result" &&
            suggestion.source === "result" &&
            suggestion.artifactId === source.artifactId,
        )
      : set.suggestions.find((suggestion) => fitsDrop(plan, suggestion));
  return chosen === undefined
    ? undefined
    : { suggestionId: chosen.id, verb: verbFor(plan, chosen) };
}

/** A stable identity for a source, so a handle can show that it is the one being carried. */
export function dragSourceKey(source: DragSource): string {
  return source.kind === "result"
    ? `result:${source.artifactId}`
    : `${source.kind}:${proofSelectionKey(source.selection)}`;
}

/**
 * Whether a displayed set answers this drop: its resolved selection is exactly the plan's
 * selections, in order. A set requested for something else (an earlier selection, a later click)
 * is never used to preview the drop.
 */
export function suggestionSetMatchesPlan(plan: DropPlan, set: DisplayedSuggestionSet): boolean {
  const resolved = set.selection;
  const keys =
    resolved.kind === "selection-query"
      ? resolved.selections.map(({ selection }) => proofSelectionKey(selection))
      : [proofSelectionKey(resolved)];
  const expected = plan.selections.map(proofSelectionKey);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

const KIND_LABELS: Readonly<Record<DragKind, string>> = {
  "result-on-expression": "result onto expression",
  "hypothesis-on-goal": "hypothesis onto goal",
  "term-on-slot": "term onto slot",
};

export function describeDragKind(kind: DragKind): string {
  return KIND_LABELS[kind];
}
