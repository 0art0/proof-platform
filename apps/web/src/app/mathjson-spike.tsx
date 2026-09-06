"use client";

import type { MathfieldElement as MathfieldElementType } from "mathlive";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderMathJson, type PlainMathJson } from "@proof/mathjson-model";
import {
  createAssociativeSelection,
  expressionAtPath,
  formatOperandPath,
  operandPathEquals,
  parentOperandPath,
  replaceSelection,
  resolveSelection,
  type OperandPath,
  type ResolvedSelection,
} from "@proof/selections";
import {
  readMathLiveSelection,
  renderInteractiveLatex,
  type MathLiveSelectionPort,
} from "./mathlive-selection";

export const INITIAL_STATEMENT = [
  "Equal",
  ["Add", ["Power", "x", 2], ["Multiply", 3, "y"], "z", "y"],
  12,
] as const satisfies PlainMathJson;

const replacements: ReadonlyArray<Readonly<{ label: string; value: PlainMathJson }>> = [
  { label: "u", value: "u" },
  { label: "p + q", value: ["Add", "p", "q"] },
  { label: "0", value: 0 },
];

function exactSelection(
  expression: PlainMathJson,
  path: OperandPath,
): ResolvedSelection | undefined {
  const fragment = expressionAtPath(expression, path);
  return fragment === undefined ? undefined : { kind: "exact", path, fragment };
}

function selectionPath(selection: ResolvedSelection): OperandPath {
  return selection.kind === "associative" ? selection.containerPath : selection.path;
}

function selectionLabel(selection: ResolvedSelection): string {
  if (selection.kind === "associative") return "Associative virtual selection";
  if (selection.kind === "fallback") return "Snapped fallback selection";
  return "Exact subtree selection";
}

export function MathJsonSpike() {
  const [statement, setStatement] = useState<PlainMathJson>(INITIAL_STATEMENT);
  const [selection, setSelection] = useState<ResolvedSelection>();
  const [replacementIndex, setReplacementIndex] = useState(0);
  const [message, setMessage] = useState(
    "Select part of the rendered statement or use a target below.",
  );
  const [mathLiveReady, setMathLiveReady] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<MathfieldElementType | undefined>(undefined);

  const rendered = useMemo(() => renderMathJson(statement), [statement]);
  const interactiveLatex = useMemo(() => renderInteractiveLatex(statement), [statement]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let active = true;
    let field: MathfieldElementType | undefined;

    void import("mathlive").then(({ MathfieldElement }) => {
      if (!active) return;
      MathfieldElement.fontsDirectory = null;
      field = new MathfieldElement();
      field.readOnly = true;
      field.className = "math-field";
      field.value = interactiveLatex;
      field.setAttribute("aria-label", "Interactive MathJSON statement");

      const readSelection = () => {
        if (!field) return;
        const interpreted = readMathLiveSelection(
          field as unknown as MathLiveSelectionPort,
          statement,
        );
        setSelection(interpreted);
        setMessage(
          interpreted.kind === "fallback"
            ? interpreted.reason
            : "The display selection was recovered as an operand-path selection.",
        );
      };
      const handleSelectionChange = () => {
        if (field && !field.selectionIsCollapsed) readSelection();
      };
      const handlePointerUp = () => {
        if (!field || !field.selectionIsCollapsed) return;
        const interpreted = readMathLiveSelection(
          field as unknown as MathLiveSelectionPort,
          statement,
        );
        setSelection((previous) => {
          if (
            previous?.kind === "exact" &&
            interpreted.kind === "exact" &&
            operandPathEquals(previous.path, interpreted.path)
          ) {
            const parent = parentOperandPath(previous.path);
            return parent === undefined ? previous : exactSelection(statement, parent);
          }
          return interpreted;
        });
        setMessage("Click the same occurrence again to expand to its semantic parent.");
      };

      field.addEventListener("selection-change", handleSelectionChange);
      field.addEventListener("pointerup", handlePointerUp);
      host.replaceChildren(field);
      fieldRef.current = field;
      setMathLiveReady(true);
    });

    return () => {
      active = false;
      field?.remove();
      if (fieldRef.current === field) fieldRef.current = undefined;
    };
  }, [interactiveLatex, statement]);

  const chooseExact = (path: OperandPath) => {
    const next = exactSelection(statement, path);
    if (!next) return;
    setSelection(next);
    setMessage("Exact occurrence recovered from its zero-based operand path.");
  };

  const chooseVirtual = () => {
    const next = createAssociativeSelection(statement, [0], 1, 3);
    if (!next) return;
    setSelection(next);
    setMessage("The two middle Add operands are represented by a deterministic splice lens.");
  };

  const chooseFallback = () => {
    const next = resolveSelection(statement, ["Add", 2, ["Multiply", 3, "y"]], {
      paths: [
        [0, 0, 1],
        [0, 1, 1],
      ],
    });
    setSelection(next);
    setMessage(next.kind === "fallback" ? next.reason : "Selection resolved without fallback.");
  };

  const expandSelection = () => {
    if (!selection) return;
    const parent = parentOperandPath(selectionPath(selection));
    if (parent === undefined) return;
    const expanded = exactSelection(statement, parent);
    if (expanded) {
      setSelection(expanded);
      setMessage("Selection expanded to its semantic parent.");
    }
  };

  const applyReplacement = () => {
    const replacement = replacements[replacementIndex]?.value;
    if (!selection || replacement === undefined) return;
    const result = replaceSelection(statement, selection, replacement);
    if (!result.ok) {
      setMessage(result.diagnostics[0]?.message ?? "Replacement failed.");
      return;
    }
    setStatement(result.expression);
    setSelection(undefined);
    setMessage("Replacement applied to plain MathJSON; MathLive rerendered the new projection.");
  };

  const reset = () => {
    setStatement(INITIAL_STATEMENT);
    setSelection(undefined);
    setMessage("The authoritative MathJSON statement was reset.");
  };

  return (
    <section className="spike" aria-labelledby="spike-heading">
      <div className="spike-intro">
        <p className="eyebrow">Stage 1 · interaction spike</p>
        <h1 id="spike-heading">Point at structure, not pixels.</h1>
        <p className="lede">
          MathJSON stays authoritative. MathLive renders it, selection lenses recover semantic
          occurrences, and every replacement produces a new plain tree.
        </p>
      </div>

      <div className="workspace-grid">
        <div className="formula-panel panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">Rendered projection</p>
              <h2>Interactive statement</h2>
            </div>
            <span className="status-pill" data-ready={mathLiveReady}>
              {mathLiveReady ? "MathLive ready" : "Loading MathLive"}
            </span>
          </div>
          <div className="math-shell" ref={hostRef} data-testid="mathlive-host">
            <span aria-hidden="true">{rendered.ok ? rendered.latex : "Render error"}</span>
          </div>
          <p className="gesture-hint">
            Click a leaf, click it again to expand, or drag across a visible range.
          </p>

          <div className="target-row" aria-label="Deterministic selection targets">
            <button type="button" onClick={() => chooseExact([0, 0])}>
              Select x²
            </button>
            <button type="button" onClick={() => chooseExact([0, 3])}>
              Select second y
            </button>
            <button type="button" onClick={chooseVirtual}>
              Select 3y + z
            </button>
            <button type="button" onClick={chooseFallback}>
              Try cross-branch range
            </button>
          </div>
        </div>

        <aside className="selection-panel panel" aria-live="polite">
          <p className="panel-kicker">Interpreted selection</p>
          {selection ? (
            <>
              <div className={`selection-kind selection-kind--${selection.kind}`}>
                {selectionLabel(selection)}
              </div>
              <dl className="selection-facts">
                <div>
                  <dt>Operand path</dt>
                  <dd data-testid="selection-path">
                    {formatOperandPath(selectionPath(selection))}
                  </dd>
                </div>
                {selection.kind === "associative" ? (
                  <div>
                    <dt>Covered operands</dt>
                    <dd>{selection.coveredOperandPaths.map(formatOperandPath).join(", ")}</dd>
                  </div>
                ) : null}
              </dl>
              <pre className="selected-fragment" data-testid="selection-fragment">
                {JSON.stringify(selection.fragment, null, 2)}
              </pre>
              {selection.kind === "fallback" ? (
                <p className="fallback-notice" role="status">
                  Fallback applied: the highlighted card is the actual subtree that will be used.
                </p>
              ) : null}
              <button className="quiet-button" type="button" onClick={expandSelection}>
                Expand to parent
              </button>
            </>
          ) : (
            <p className="empty-selection">No semantic selection yet.</p>
          )}
          <p className="interaction-message">{message}</p>
        </aside>
      </div>

      <div className="transform-panel panel">
        <div>
          <p className="panel-kicker">Deterministic transformation</p>
          <h2>Replace the interpreted selection</h2>
        </div>
        <div className="replacement-controls">
          <label htmlFor="replacement">Replacement MathJSON</label>
          <select
            id="replacement"
            value={replacementIndex}
            onChange={(event) => setReplacementIndex(Number(event.target.value))}
          >
            {replacements.map((replacement, index) => (
              <option value={index} key={replacement.label}>
                {replacement.label} · {JSON.stringify(replacement.value)}
              </option>
            ))}
          </select>
          <button
            className="primary-button"
            type="button"
            onClick={applyReplacement}
            disabled={!selection}
          >
            Replace selection
          </button>
          <button className="quiet-button" type="button" onClick={reset}>
            Reset statement
          </button>
        </div>
      </div>

      <div className="source-panel panel">
        <div className="panel-heading">
          <div>
            <p className="panel-kicker">Ground truth</p>
            <h2>Current plain MathJSON</h2>
          </div>
          <span className="source-badge">authoritative</span>
        </div>
        <pre data-testid="authoritative-mathjson">{JSON.stringify(statement, null, 2)}</pre>
      </div>
    </section>
  );
}
