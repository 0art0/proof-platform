"use client";

import { useEffect, useRef, type DragEvent, type KeyboardEvent } from "react";
import { formatOperandPath, type AnchoredProofSelection } from "@proof/selections";
import {
  isSelectionAbstract,
  type AbstractSelectionState,
} from "../proof-workspace/selection-state";
import type { DragSource } from "./drag-state";
import { dragSourceForSelection, dragSourceKey } from "./drop-resolution";
import type { GestureBindings } from "./use-drag-gestures";
import styles from "./gestures.module.css";

export const DRAG_MEDIA_TYPE = "text/plain";

/**
 * A grab handle for a drag source. Pointer users drag it; keyboard users press Enter or Space to
 * pick it up (again to put it down) and then choose "Drop on selection" in the gesture tray.
 */
export function DragHandle({
  source,
  label,
  bindings,
}: Readonly<{ source: DragSource; label: string; bindings: GestureBindings }>) {
  const { enabled, carrying } = bindings;
  const pickUpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = carrying !== undefined && dragSourceKey(carrying) === dragSourceKey(source);
  const toggle = () => {
    if (!enabled) return;
    if (held) bindings.cancel();
    else bindings.pickUp(source, "keyboard");
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  };
  const handleDragStart = (event: DragEvent<HTMLElement>) => {
    if (!enabled) {
      event.preventDefault();
      return;
    }
    if (event.dataTransfer) {
      // Only a human-readable label travels with the drag; the source itself stays in the state.
      event.dataTransfer.setData(DRAG_MEDIA_TYPE, source.label);
      event.dataTransfer.effectAllowed = "copy";
    }
    // Changing the page while `dragstart` runs makes Chromium end the drag at once (the drop
    // cues shift the layout under the pointer), so the pick-up waits for the drag to begin.
    pickUpTimer.current = setTimeout(() => bindings.pickUp(source, "pointer"), 0);
  };
  const handleDragEnd = () => {
    clearTimeout(pickUpTimer.current);
    bindings.cancel();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className={styles.handle}
      draggable={enabled}
      aria-pressed={held}
      aria-disabled={!enabled}
      data-drag-handle={dragSourceKey(source)}
      onClick={toggle}
      onKeyDown={handleKeyDown}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <span aria-hidden="true">⠿</span>
      {held ? "Carrying " : "Drag "}
      {/* The name comes from content, so `getByLabel` of a statement never matches a handle. */}
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

function describeOccurrence(selection: AnchoredProofSelection): string {
  const statement =
    selection.anchor.statement.kind === "conclusion"
      ? "conclusion"
      : `hypothesis ${selection.anchor.statement.id}`;
  const where =
    selection.kind === "exact"
      ? `path ${formatOperandPath(selection.path)}`
      : `range ${formatOperandPath(selection.containerPath)} [${selection.startOperand}, ${selection.endOperand})`;
  return `${where} of ${statement} in ${selection.anchor.target.kind} ${selection.anchor.target.id}`;
}

const SOURCE_NAMES = {
  hypothesis: "Hypothesis",
  term: "Term",
  result: "Result",
} as const;

/**
 * Abstract-selection controls (roadmap N33). An abstract selection becomes a typed wildcard for
 * retrieval only: it never changes the stored occurrence, the preview, or what Apply commits.
 */
export type AbstractionControls = Readonly<{
  abstractKeys: AbstractSelectionState;
  /** The occurrence role, or undefined while unknown; a binder declaration cannot be abstracted. */
  roleOf: (selection: AnchoredProofSelection) => "proposition" | "term" | "binder" | undefined;
  toggle: (selection: AnchoredProofSelection) => void;
  disabled: boolean;
}>;

function AbstractionToggles({
  controls,
  selections,
}: Readonly<{ controls: AbstractionControls; selections: readonly AnchoredProofSelection[] }>) {
  if (selections.length === 0) return null;
  return (
    <ul className={styles.abstractList} aria-label="Abstract selections" data-testid="abstraction">
      {selections.map((selection, index) => {
        const abstract = isSelectionAbstract(controls.abstractKeys, selection);
        const role = controls.roleOf(selection);
        const binder = role === "binder";
        const name = selections.length === 1 ? "this selection" : `selection ${index + 1}`;
        return (
          <li key={JSON.stringify(selection)} className={styles.abstractItem}>
            <button
              type="button"
              className={styles.trayButton}
              aria-pressed={abstract}
              disabled={controls.disabled || binder}
              data-abstract-toggle={abstract ? "on" : "off"}
              onClick={() => controls.toggle(selection)}
            >
              Abstract {name}
            </button>
            <span
              className={abstract ? styles.abstractOn : styles.help}
              data-testid="abstraction-indicator"
            >
              {binder
                ? "A binder declaration cannot be abstracted."
                : abstract
                  ? `Abstract (${role === "proposition" ? "any proposition" : "any term"}): used for retrieval only. Previews and Apply use the concrete selection.`
                  : "Concrete: retrieval matches this exact occurrence."}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export type GestureTrayProps = Readonly<{
  bindings: GestureBindings;
  /** The active selections: a single one can be dragged, picked up, or be the drop target. */
  selections: readonly AnchoredProofSelection[];
  view: "formal" | "natural-language";
  abstraction?: AbstractionControls;
}>;

/**
 * The home of the keyboard alternative and the gesture status. A single active selection can be
 * dragged or picked up; once something is carried, "Drop on selection" drops it on the single
 * active selection. Every drop only produces a preview.
 */
export function GestureTray({ bindings, selections, view, abstraction }: GestureTrayProps) {
  const { state, carrying } = bindings;
  const only = selections.length === 1 ? selections[0] : undefined;

  useEffect(() => {
    if (carrying === undefined) return;
    // Capture phase: Escape puts the carried item down and is not also a "clear selections".
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      bindings.cancel();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [bindings, carrying]);

  const selectionSource =
    only === undefined ? undefined : dragSourceForSelection(only, describeOccurrence(only));

  return (
    <section className={styles.tray} aria-label="Drag gestures" data-gesture-tray>
      <h2 className={styles.trayHeading}>Drag gestures</h2>
      <p className={styles.help} data-testid="gesture-help">
        {bindings.disabledReason !== undefined
          ? `Drag gestures are unavailable: ${bindings.disabledReason}.`
          : view === "formal"
            ? "Drag a hypothesis onto a goal, a term onto another occurrence, or a library result onto an expression. Every drop shows a preview first. Keyboard: pick something up, select the target, then choose Drop on selection."
            : "Switch to the formal view to drag and drop."}
      </p>
      <div className={styles.trayActions}>
        {selectionSource === undefined ? null : (
          <>
            <DragHandle
              source={selectionSource}
              label="the selected occurrence"
              bindings={bindings}
            />
            <span className={styles.help}>{SOURCE_NAMES[selectionSource.kind]} selected</span>
          </>
        )}
        <button
          type="button"
          className={styles.trayButton}
          disabled={!bindings.enabled || carrying === undefined || only === undefined}
          onClick={() => only !== undefined && bindings.dropOn(only.anchor, only)}
        >
          Drop on selection
        </button>
        <button
          type="button"
          className={styles.trayButton}
          disabled={carrying === undefined}
          aria-keyshortcuts="Escape"
          onClick={() => bindings.cancel()}
        >
          Cancel drag
        </button>
      </div>
      {abstraction === undefined ? null : (
        <AbstractionToggles controls={abstraction} selections={selections} />
      )}
      {/* A fixed-height area: cues that appear at pick-up must not shift the page under a drag. */}
      <div className={styles.statusArea}>
        {carrying === undefined ? null : (
          <p className={styles.carrying} role="status" data-testid="carrying">
            Carrying {SOURCE_NAMES[carrying.kind].toLowerCase()}: {carrying.label}.{" "}
            {only === undefined
              ? "Select exactly one target, or drop on a highlighted statement."
              : "Choose Drop on selection to preview."}
          </p>
        )}
        {state.phase === "idle" && state.outcome !== undefined ? (
          <p
            className={styles.outcome}
            role="status"
            data-testid="drag-outcome"
            data-outcome={state.outcome.kind}
          >
            {state.outcome.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
