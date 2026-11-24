"use client";

import type { MathfieldElement as MathfieldElementType } from "mathlive";
import { useContext, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { renderMathJson, type PlainMathJson } from "@proof/mathjson-model";
import type {
  AnchoredProofSelection,
  OperandPath,
  SelectionPosition,
  StatementAnchor,
} from "@proof/selections";
import {
  readAnchoredMathLiveSelection,
  renderInteractiveLatex,
  type MathLiveSelectionPort,
} from "./mathlive-selection";
import { readAnchoredOccurrenceAtPoint, type MathLivePointPort } from "./mathlive-point";
import {
  occurrenceAtPoint,
  occurrenceBox,
  readOccurrenceTable,
  type HoverBox,
} from "./mathlive-hover";
import gestureStyles from "../gestures/gestures.module.css";
import styles from "./proof-workspace.module.css";

import { RewriteInspectionContext, type RewriteInspection } from "./rewrite-inspection";

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

export const POLARITY_LABELS: Readonly<Record<SelectionPolarity, string>> = Object.freeze({
  positive: "Positive position (goal-like)",
  negative: "Negative position (hypothesis-like)",
  mixed: "Mixed polarity",
  neutral: "Neutral (term) position",
});

const POLARITY_SIGNS: Readonly<Record<SelectionPolarity, string>> = Object.freeze({
  positive: "+",
  negative: "−",
  mixed: "±",
  neutral: "·",
});

/** The proposition under the pointer and where it is drawn, relative to the statement. */
type HoveredPosition = Readonly<{ polarity: SelectionPolarity; path: OperandPath; box: HoverBox }>;

function sameHover(left: HoveredPosition | undefined, right: HoveredPosition): boolean {
  return (
    left?.polarity === right.polarity &&
    left.path.join(".") === right.path.join(".") &&
    left.box.left === right.box.left &&
    left.box.right === right.box.right &&
    left.box.top === right.box.top &&
    left.box.bottom === right.box.bottom
  );
}

type MathLiveStatementProps = Readonly<{
  anchor: StatementAnchor;
  expression: PlainMathJson;
  /** The proposition governing an operand path, which is what hovering that path reports. */
  governingProposition: (
    path: OperandPath,
  ) => Readonly<{ path: OperandPath; position: SelectionPosition }>;
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
  governingProposition,
  label,
  selected,
  selectionPolarity,
  onGesture,
  dropZone,
}: MathLiveStatementProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const governingRef = useRef(governingProposition);
  const [hovered, setHovered] = useState<HoveredPosition>();
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
    governingRef.current = governingProposition;
  }, [anchor, governingProposition, onGesture]);

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
        const modifier = event.ctrlKey || event.metaKey;
        const hit = repeatable
          ? occurrenceAtPoint(readOccurrenceTable(field.shadowRoot), {
              x: event.clientX,
              y: event.clientY,
            })
          : undefined;
        if (hit !== undefined) {
          onGestureRef.current({
            selection: { kind: "exact", anchor: anchorRef.current, path: hit.path },
            modifier,
            repeatable,
          });
          return;
        }
        const { selection, interpretation } = readAnchoredMathLiveSelection(
          field as unknown as MathLiveSelectionPort,
          expression,
          anchorRef.current,
        );
        onGestureRef.current({
          selection,
          modifier,
          repeatable,
          ...(interpretation.kind === "fallback" ? { fallbackReason: interpretation.reason } : {}),
        });
      };

      // Touch has no hover, and a held button means a selection or a drag is under way.
      const handlePointerMove = (event: PointerEvent) => {
        const frame = frameRef.current;
        if (!field || !frame || event.pointerType === "touch" || event.buttons !== 0) {
          setHovered(undefined);
          return;
        }
        const table = readOccurrenceTable(field.shadowRoot);
        const hit = occurrenceAtPoint(table, { x: event.clientX, y: event.clientY });
        if (hit === undefined) {
          setHovered(undefined);
          return;
        }
        const node = governingRef.current(hit.path);
        const box = occurrenceBox(table, node.path, hit.entry);
        const origin = frame.getBoundingClientRect();
        const next: HoveredPosition = {
          polarity: node.position.polarity,
          path: hit.path,
          box: {
            left: box.left - origin.left,
            right: box.right - origin.left,
            top: box.top - origin.top,
            bottom: box.bottom - origin.top,
          },
        };
        setHovered((current) => (sameHover(current, next) ? current : next));
      };
      const handlePointerLeave = () => setHovered(undefined);

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
      field.addEventListener("pointermove", handlePointerMove);
      field.addEventListener("pointerleave", handlePointerLeave);
      host.replaceChildren(field);
      fieldRef.current = field;
      setReady(true);
    });

    return () => {
      active = false;
      fieldRef.current = undefined;
      field?.remove();
      setHovered(undefined);
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
          const table = readOccurrenceTable(fieldRef.current?.shadowRoot ?? null);
          const point = { x: event.clientX, y: event.clientY };
          const hit = occurrenceAtPoint(table, point);
          // Empty space inside the drop zone names the entire statement.
          dropZone.onDrop(
            table.length > 0
              ? { kind: "exact", anchor: anchorRef.current, path: hit?.path ?? [] }
              : readAnchoredOccurrenceAtPoint(
                  fieldRef.current as unknown as MathLivePointPort | undefined,
                  expression,
                  anchorRef.current,
                  point,
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
      <div className={styles.hoverFrame} ref={frameRef}>
        <div
          className={styles.mathProjection}
          data-ready={ready}
          data-selected={selected}
          data-selection-polarity={selected ? selectionPolarity : undefined}
          data-selection-anchor={serializedAnchor}
          ref={hostRef}
        >
          <span aria-hidden="true">
            {rendered.ok ? rendered.latex : "Unable to render MathJSON"}
          </span>
        </div>
        {hovered === undefined ? null : (
          <HoveredPositionMark
            key={serializedAnchor + "#" + hovered.path.join(".")}
            anchor={anchorRef.current}
            hovered={hovered}
          />
        )}
      </div>
      {dropReady ? (
        <span className={gestureStyles.dropHint}>Drop here to preview a move</span>
      ) : null}
    </div>
  );
}

/** Outlines the hovered proposition and names its position. Neither takes pointer events. */
function HoveredPositionMark({
  anchor,
  hovered: { polarity, box, path },
}: Readonly<{ anchor: StatementAnchor; hovered: HoveredPosition }>) {
  const inspect = useContext(RewriteInspectionContext);
  const [result, setResult] = useState<RewriteInspection | "unavailable">();
  // The parent keys this tooltip by snapshot, statement and exact operand path.
  const [occurrence] = useState<AnchoredProofSelection>(() => ({ kind: "exact", anchor, path }));
  useEffect(() => {
    setResult(undefined);
    if (inspect === undefined) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      const found = await inspect(occurrence, controller.signal);
      if (!controller.signal.aborted) setResult(found ?? "unavailable");
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [inspect, occurrence]);
  return (
    <>
      <span
        className={styles.hoverOccurrence}
        data-polarity={polarity}
        aria-hidden="true"
        style={{
          left: box.left,
          top: box.top,
          width: box.right - box.left,
          height: box.bottom - box.top,
        }}
      />
      <span
        className={styles.hoverLabel}
        data-polarity={polarity}
        role="tooltip"
        style={{ left: box.left, top: box.top }}
      >
        <span aria-hidden="true">{POLARITY_SIGNS[polarity]}</span> {POLARITY_LABELS[polarity]}
        {result === "unavailable" ? (
          <small>Move lookup unavailable</small>
        ) : result ? (
          <>
            {result.names.length === 0 ? (
              <small>No matching rewrites</small>
            ) : (
              result.names.map((name, index) => <small key={index}>{name}</small>)
            )}
            {result.remaining > 0 ? <small>{result.remaining} more rewrites</small> : null}
          </>
        ) : null}
      </span>
    </>
  );
}
