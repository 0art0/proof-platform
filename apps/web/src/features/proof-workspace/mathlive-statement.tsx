"use client";

import type { MathfieldElement as MathfieldElementType } from "mathlive";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderMathJson, type PlainMathJson } from "@proof/mathjson-model";
import type { AnchoredProofSelection, StatementAnchor } from "@proof/selections";
import {
  readAnchoredMathLiveSelection,
  renderInteractiveLatex,
  type MathLiveSelectionPort,
} from "./mathlive-selection";
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
  fallbackReason?: string;
}>;

type MathLiveStatementProps = Readonly<{
  anchor: StatementAnchor;
  expression: PlainMathJson;
  label: string;
  selected: boolean;
  onGesture: (gesture: MathLiveStatementGesture) => void;
}>;

export function MathLiveStatement({
  anchor,
  expression,
  label,
  selected,
  onGesture,
}: MathLiveStatementProps) {
  const hostRef = useRef<HTMLDivElement>(null);
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
        if (!field) return;
        const interpreted = readAnchoredMathLiveSelection(
          field as unknown as MathLiveSelectionPort,
          expression,
          anchorRef.current,
        );
        onGestureRef.current({
          selection: interpreted.selection,
          modifier: event.ctrlKey || event.metaKey,
          ...(interpreted.interpretation.kind === "fallback"
            ? { fallbackReason: interpreted.interpretation.reason }
            : {}),
        });
      };

      field.addEventListener("pointerup", handlePointerUp);
      host.replaceChildren(field);
      setReady(true);
    });

    return () => {
      active = false;
      field?.remove();
    };
  }, [expression, interactiveLatex, label, serializedAnchor]);

  return (
    <div
      className={styles.mathProjection}
      data-ready={ready}
      data-selected={selected}
      data-selection-anchor={serializedAnchor}
      ref={hostRef}
    >
      <span aria-hidden="true">{rendered.ok ? rendered.latex : "Unable to render MathJSON"}</span>
    </div>
  );
}
