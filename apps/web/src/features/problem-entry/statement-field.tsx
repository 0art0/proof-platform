"use client";

import { useMemo } from "react";
import type { LatexRenderer } from "@proof/language";
import type { PlainMathJson } from "@proof/protocol";
import { splitNaturalLanguage } from "../proof-workspace/presentation";
import { parseMathJsonText, type StatementFormat, type StatementRow } from "./draft-form";
import styles from "./problem-entry.module.css";
import { Formula } from "./typeset";

export type StatementFeedback =
  | Readonly<{ kind: "empty" }>
  /** `latex` is the recognized statement written back out, which is what the preview typesets. */
  | Readonly<{ kind: "parsed"; mathJson: string; latex: string }>
  | Readonly<{ kind: "error"; message: string }>;

/**
 * Live feedback only: the worker parses the LaTeX again on review, with the same Compute Engine
 * dictionary and the selected packs' parse triggers, and that result is what is stored.
 */
export function statementFeedback(
  row: Pick<StatementRow, "format" | "text">,
  latex: LatexRenderer,
): StatementFeedback {
  if (row.text.trim().length === 0) return { kind: "empty" };
  if (row.format === "mathjson") {
    const parsed = parseMathJsonText(row.text);
    return parsed.ok
      ? recognized(parsed.expression, latex)
      : { kind: "error", message: parsed.message };
  }
  const parsed = latex.parse(row.text);
  return parsed.ok
    ? recognized(parsed.expression, latex)
    : { kind: "error", message: parsed.diagnostics.map(({ message }) => message).join(" ") };
}

const rowFeedbackCache = new WeakMap<LatexRenderer, WeakMap<StatementRow, StatementFeedback>>();

/**
 * `statementFeedback` of a form row, remembered per row object and renderer. The form replaces a
 * row when it is edited, so a keystroke parses only the edited row again.
 */
export function cachedStatementFeedback(
  row: StatementRow,
  latex: LatexRenderer,
): StatementFeedback {
  let rows = rowFeedbackCache.get(latex);
  if (rows === undefined) {
    rows = new WeakMap();
    rowFeedbackCache.set(latex, rows);
  }
  let feedback = rows.get(row);
  if (feedback === undefined) {
    feedback = statementFeedback(row, latex);
    rows.set(row, feedback);
  }
  return feedback;
}

function recognized(expression: PlainMathJson, latex: LatexRenderer): StatementFeedback {
  const mathJson = JSON.stringify(expression);
  try {
    return { kind: "parsed", mathJson, latex: latex.serialize(expression) };
  } catch {
    // The statement is recognized even if it cannot be written back out; show its structure.
    return { kind: "parsed", mathJson, latex: mathJson };
  }
}

/**
 * The problem statement is prose, so the preview typesets the `$…$` pieces of it that parse, as
 * the proof service will read them, and leaves the rest as typed. It appears only when at least
 * one piece parses. What is typeset is always LaTeX written back out from the parsed statement,
 * never the typed text itself.
 */
export function StatementPreview({
  text,
  latex,
}: Readonly<{ text: string; latex: LatexRenderer }>) {
  const parts = useMemo(
    () =>
      splitNaturalLanguage(text).map((part) => {
        if (part.kind === "text") return { ...part, typeset: undefined };
        const feedback = statementFeedback({ format: "latex", text: part.value }, latex);
        return { ...part, typeset: feedback.kind === "parsed" ? feedback.latex : undefined };
      }),
    [text, latex],
  );
  if (!parts.some(({ typeset }) => typeset !== undefined)) return null;
  return (
    <div className={styles.preview} data-preview="">
      <span className={styles.previewLabel}>Preview</span>
      <p className={styles.previewProse}>
        {parts.map(({ kind, value, typeset }, index) =>
          typeset !== undefined ? (
            <Formula key={index} latex={typeset} />
          ) : (
            <span key={index}>{kind === "math" ? `$${value}$` : value}</span>
          ),
        )}
      </p>
    </div>
  );
}

export function StatementField({
  label,
  row,
  feedback,
  onChange,
  onRemove,
  required,
  family,
}: Readonly<{
  label: string;
  required?: boolean;
  /** Tints the row in its proof family's colour; the label always names the family too. */
  family?: "goal" | "hypothesis";
  row: StatementRow;
  /** How the row reads, from `statementFeedback`; the form also reads it for the setup progress. */
  feedback: StatementFeedback;
  onChange: (row: StatementRow) => void;
  onRemove?: (() => void) | undefined;
}>) {
  const feedbackId = `statement-feedback-${row.key}`;
  const line = (
    <p id={feedbackId} className={styles.feedback} data-kind={feedback.kind}>
      {feedback.kind === "parsed" ? (
        <>
          <span aria-hidden="true">✓ </span>Notation recognized.
        </>
      ) : feedback.kind === "error" ? (
        <>
          <span aria-hidden="true">✗ </span>
          {feedback.message}
        </>
      ) : (
        "Enter the statement."
      )}
    </p>
  );
  return (
    <div className={styles.statementRow} data-family={family}>
      <div className={styles.statementHeader}>
        <label
          className={styles.label}
          htmlFor={`statement-${row.key}`}
          data-marker={required === true ? "required" : undefined}
        >
          {label}
        </label>
        <select
          aria-label={`${label} format`}
          value={row.format}
          onChange={(event) =>
            onChange({ ...row, format: event.currentTarget.value as StatementFormat })
          }
        >
          <option value="latex">LaTeX</option>
          <option value="mathjson">Structured notation (advanced)</option>
        </select>
        {onRemove === undefined ? null : (
          <button type="button" className={styles.removeButton} onClick={onRemove}>
            Remove {label.toLowerCase()}
          </button>
        )}
      </div>
      <textarea
        id={`statement-${row.key}`}
        className={styles.mathInput}
        rows={2}
        spellCheck={false}
        placeholder={row.format === "latex" ? "A \\cup B = B \\cup A" : '["Equal", "x", "y"]'}
        aria-describedby={feedbackId}
        aria-invalid={feedback.kind === "error"}
        value={row.text}
        onChange={(event) => onChange({ ...row, text: event.currentTarget.value })}
      />
      {feedback.kind === "parsed" ? (
        // The recognized statement, typeset: what the setup will actually read.
        <div className={styles.preview} data-preview="">
          <span className={styles.previewLabel}>Preview</span>
          <div className={styles.previewBody}>
            <Formula latex={feedback.latex} />
            {line}
          </div>
        </div>
      ) : (
        line
      )}
    </div>
  );
}
