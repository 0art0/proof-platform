"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DisplayedSuggestionSet } from "@proof/protocol";
import type { AnchoredProofSelection, StatementAnchor } from "@proof/selections";
import { proofSelectionKey } from "../proof-workspace/selection-state";
import {
  IDLE_DRAG_STATE,
  dragReducer,
  type DragInput,
  type DragOutcome,
  type DragSource,
  type DragState,
} from "./drag-state";
import {
  NO_MOVE_MESSAGE,
  chooseDroppedSuggestion,
  describeDragKind,
  dropTargetFor,
  planDrop,
  suggestionSetMatchesPlan,
  type DropPlan,
} from "./drop-resolution";

/** What the drag controller needs to know about the displayed suggestions. */
export type GestureSuggestions =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; suggestionSet: DisplayedSuggestionSet }>
  | Readonly<{ kind: "empty"; suggestionSet: DisplayedSuggestionSet }>
  | Readonly<{ kind: "rejected"; message: string }>
  | Readonly<{ kind: "stale"; message: string }>;

/** A request for the workspace to make exactly these selections active (a drop's two sides). */
export type SelectionRequest = Readonly<{
  id: number;
  selections: readonly AnchoredProofSelection[];
}>;

/** The surface handles, drop zones, the library drawer and the tray share. */
export type GestureBindings = Readonly<{
  /** False while a command runs, in a read-only session, or outside the formal view. */
  enabled: boolean;
  /** Why dragging is unavailable, when the reason is worth stating (a read-only session). */
  disabledReason?: string | undefined;
  state: DragState;
  carrying: DragSource | undefined;
  pickUp: (source: DragSource, input: DragInput) => void;
  hover: (over: boolean) => void;
  /** Drop what is carried on an occurrence of the statement `anchor`. */
  dropOn: (anchor: StatementAnchor, occurrence: AnchoredProofSelection) => void;
  cancel: () => void;
}>;

type Pending = { plan: DropPlan; requested: boolean };

export type DragGestures = Readonly<{
  bindings: GestureBindings;
  selectionRequest: SelectionRequest | undefined;
  /** Report every selection change: a change that is not the drop's own abandons the drop. */
  notifySelectionChange: (selections: readonly AnchoredProofSelection[]) => void;
  /** Forget everything carried or pending (a new proof snapshot). */
  reset: () => void;
}>;

/**
 * Turns drops into previews through the existing suggestion flow. A drop never sends
 * mathematics and never commits: it makes the source and target the active selections, lets the
 * workspace request suggestions for that selection query, and then previews the displayed
 * suggestion the drop asks for. Applying stays with the preview's Apply button.
 */
export function useDragGestures({
  stateId,
  enabled,
  disabledReason,
  suggestions,
  previewSuggestion,
}: Readonly<{
  stateId: string;
  enabled: boolean;
  disabledReason?: string | undefined;
  suggestions: GestureSuggestions;
  previewSuggestion: (set: DisplayedSuggestionSet, suggestionId: string) => void;
}>): DragGestures {
  const [state, dispatch] = useReducer(dragReducer, IDLE_DRAG_STATE);
  const [selectionRequest, setSelectionRequest] = useState<SelectionRequest>();
  const pending = useRef<Pending | undefined>(undefined);
  const counter = useRef(0);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const settle = useCallback((outcome: DragOutcome) => {
    pending.current = undefined;
    dispatch({ type: "settle", outcome });
  }, []);

  const pickUp = useCallback(
    (source: DragSource, input: DragInput) => {
      if (enabled) dispatch({ type: "pick-up", source, input });
    },
    [enabled],
  );
  const hover = useCallback((over: boolean) => dispatch({ type: "hover", over }), []);
  const cancel = useCallback(() => dispatch({ type: "cancel" }), []);

  const dropOn = useCallback(
    (anchor: StatementAnchor, occurrence: AnchoredProofSelection) => {
      const current = stateRef.current;
      if (!enabled || current.phase !== "carrying") return;
      const target = dropTargetFor(current.source, anchor, occurrence);
      dispatch({ type: "drop", target });
      const planned = planDrop(current.source, target, stateId);
      if (!planned.ok) {
        settle({ kind: "no-move", message: planned.message });
        return;
      }
      pending.current = { plan: planned.plan, requested: false };
      setSelectionRequest({ id: ++counter.current, selections: planned.plan.selections });
    },
    [enabled, settle, stateId],
  );

  const notifySelectionChange = useCallback(
    (selections: readonly AnchoredProofSelection[]) => {
      const current = pending.current;
      if (current === undefined) return;
      const keys = selections.map(proofSelectionKey);
      const expected = current.plan.selections.map(proofSelectionKey);
      if (keys.length === expected.length && keys.every((key, index) => key === expected[index])) {
        current.requested = true;
        return;
      }
      settle({ kind: "cancelled", message: "Drop cancelled: the selection changed." });
    },
    [settle],
  );

  useEffect(() => {
    const current = pending.current;
    if (current === undefined || !current.requested) return;
    if (suggestions.kind === "idle" || suggestions.kind === "loading") return;
    if (suggestions.kind === "rejected" || suggestions.kind === "stale") {
      settle({ kind: "no-move", message: `${NO_MOVE_MESSAGE}: ${suggestions.message}` });
      return;
    }
    if (!suggestionSetMatchesPlan(current.plan, suggestions.suggestionSet)) return;
    const chosen = chooseDroppedSuggestion(current.plan, suggestions.suggestionSet);
    if (chosen === undefined) {
      settle({ kind: "no-move", message: NO_MOVE_MESSAGE });
      return;
    }
    const name =
      suggestions.suggestionSet.suggestions.find(({ id }) => id === chosen.suggestionId)?.name ??
      chosen.suggestionId;
    settle({
      kind: "previewing",
      message: `${chosen.verb} (${describeDragKind(current.plan.kind)}): previewing ${name}. Nothing changes until you choose Apply.`,
    });
    previewSuggestion(suggestions.suggestionSet, chosen.suggestionId);
  }, [previewSuggestion, settle, suggestions]);

  const reset = useCallback(() => {
    pending.current = undefined;
    setSelectionRequest(undefined);
    dispatch({ type: "reset" });
  }, []);

  const bindings = useMemo<GestureBindings>(
    () => ({
      enabled,
      disabledReason: enabled ? undefined : disabledReason,
      state,
      carrying: state.phase === "carrying" ? state.source : undefined,
      pickUp,
      hover,
      dropOn,
      cancel,
    }),
    [cancel, disabledReason, dropOn, enabled, hover, pickUp, state],
  );

  return { bindings, selectionRequest, notifySelectionChange, reset };
}
