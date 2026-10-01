"use client";

import type { MathfieldElement as MathfieldElementType } from "mathlive";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { renderMathJson, type PlainMathJson } from "@proof/mathjson-model";
import type { AnchoredProofSelection, StatementAnchor } from "@proof/selections";
import {
  readAnchoredMathLiveSelection,
  renderInteractiveLatex,
  type MathLiveSelectionPort,
} from "./mathlive-selection";
import { readAnchoredOccurrenceAtPoint, type MathLivePointPort } from "./mathlive-point";
import gestureStyles from "../gestures/gestures.module.css";
import styles from "./proof-workspace.module.css";

let mathfieldElementCtor: Promise<typeof MathfieldElementType> | undefined;

function loadMathfieldElement(): Promise<typeof MathfieldElementType> {
  mathfieldElementCtor ??= import("mathlive").then(({ MathfieldElement }) => {
    MathfieldElement.fontsDirectory = null;
    return MathfieldElement;
  });
  return mathfieldElementCtor;
}

export type MathLiveStatementGesture = Readonly<{
  selection: AnchoredProofSelection;
  modifier: boolean;
  /** Only a primary, collapsed click can take part in repeated-click expansion. */
  repeatable: boolean;
  fallbackReason?: string;
}>;

/** The logical polarity of the selected sub-expression, used for its bevel treatment. */
export type SelectionPolarity = "positive" | "negative" | "mixed" | "neutral";

type MathLiveStatementProps = Readonly<{
  anchor: StatementAnchor;
  expression: PlainMathJson;
  label: string;
  selected: boolean;
  /** Polarity of the active selection inside this statement, when one exists. */
  selectionPolarity?: SelectionPolarity | undefined;
  onGesture: (gesture: MathLiveStatementGesture) => void;
  /** Present while something is being carried: the statement accepts a drop of it. */
  dropZone?: MathLiveDropZone | undefined;
}>;

export type MathLiveDropZone = Readonly<{
  onHover: (over: boolean) => void;
  /** The occurrence under the pointer (the whole statement when it cannot be told). */
  onDrop: (occurrence: AnchoredProofSelection) => void;
}>;

export function MathLiveStatement({
  anchor,
  expression,
  label,
  selected,
  selectionPolarity,
  onGesture,
  dropZone,
}: MathLiveStatementProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<MathfieldElementType | undefined>(undefined);
  const [dropOver, setDropOver] = useState(false);
  const onGestureRef = useRef(onGesture);
  const anchorRef = useRef(anchor);
  const [ready, setReady] = useState(false);
  const rendered = useMemo(() => renderMathJson(expression), [expression]);
  const interactiveLatex = useMemo(() => renderInteractiveLatex(expression), [expression]);
  const serializedAnchor = JSON.stringify(anchor);

  useEffect(() => {
    onGestureRef.current = onGesture;
    anchorRef.current = anchor;
  }, [anchor, onGesture]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    let field: MathfieldElementType | undefined;

    void loadMathfieldElement().then((MathfieldElement) => {
      if (!active) return;
      field = new MathfieldElement();
      field.readOnly = true;
      field.className = styles.mathField ?? "";
      field.value = interactiveLatex;
      field.setAttribute("aria-label", label);
      field.dataset.statementAnchor = serializedAnchor;

      const handlePointerUp = (event: PointerEvent) => {
        if (!field || event.button !== 0) return;
        const repeatable = field.selectionIsCollapsed;
        const interpreted = readAnchoredMathLiveSelection(
          field as unknown as MathLiveSelectionPort,
          expression,
          anchorRef.current,
        );
        onGestureRef.current({
          selection: interpreted.selection,
          modifier: event.ctrlKey || event.metaKey,
          repeatable,
          ...(interpreted.interpretation.kind === "fallback"
            ? { fallbackReason: interpreted.interpretation.reason }
            : {}),
        });
      };

      // The field is read-only, but MathLive consumes Tab to move through the expression, which
      // made one statement take several tab stops. Let Tab leave the field instead.
      field.addEventListener(
        "keydown",
        (event) => {
          if (event.key === "Tab") event.stopImmediatePropagation();
        },
        true,
      );
      field.addEventListener("pointerup", handlePointerUp);
      host.replaceChildren(field);
      fieldRef.current = field;
      setReady(true);
    });

    return () => {
      active = false;
      fieldRef.current = undefined;
      field?.remove();
    };
  }, [expression, interactiveLatex, label, serializedAnchor]);

  const dropReady = dropZone !== undefined;
  const dropHandlers = dropReady
    ? {
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          setDropOver(true);
          dropZone.onHover(true);
        },
        onDragLeave: (event: DragEvent<HTMLDivElement>) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropOver(false);
          dropZone.onHover(false);
        },
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          setDropOver(false);
          dropZone.onDrop(
            readAnchoredOccurrenceAtPoint(
              fieldRef.current as unknown as MathLivePointPort | undefined,
              expression,
              anchorRef.current,
              { x: event.clientX, y: event.clientY },
            ),
          );
        },
      }
    : {};

  return (
    <div
      className={gestureStyles.dropZone}
      data-drop-ready={dropReady}
      data-drop-over={dropReady && dropOver}
      data-drop-anchor={dropReady ? serializedAnchor : undefined}
      {...dropHandlers}
    >
      <div
        className={styles.mathProjection}
        data-ready={ready}
        data-selected={selected}
        data-selection-polarity={selected ? selectionPolarity : undefined}
        data-selection-anchor={serializedAnchor}
        ref={hostRef}
      >
        <span aria-hidden="true">{rendered.ok ? rendered.latex : "Unable to render MathJSON"}</span>
      </div>
      {dropReady ? (
        <span className={gestureStyles.dropHint}>Drop here to preview a move</span>
      ) : null}
    </div>
  );
}
