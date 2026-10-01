"use client";

import { useMemo } from "react";
import type { LatexRenderer } from "@proof/language";
import { parseMathJsonText, type StatementFormat, type StatementRow } from "./draft-form";
import styles from "./problem-entry.module.css";

export type StatementFeedback =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "parsed"; mathJson: string }>
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
      ? { kind: "parsed", mathJson: JSON.stringify(parsed.expression) }
      : { kind: "error", message: parsed.message };
  }
  const parsed = latex.parse(row.text);
  return parsed.ok
    ? { kind: "parsed", mathJson: JSON.stringify(parsed.expression) }
    : { kind: "error", message: parsed.diagnostics.map(({ message }) => message).join(" ") };
}

export function StatementField({
  label,
  row,
  latex,
  onChange,
  onRemove,
  required,
}: Readonly<{
  label: string;
  required?: boolean;
  row: StatementRow;
  latex: LatexRenderer;
  onChange: (row: StatementRow) => void;
  onRemove?: (() => void) | undefined;
}>) {
  const feedback = useMemo(() => statementFeedback(row, latex), [row, latex]);
  const feedbackId = `statement-feedback-${row.key}`;
  return (
    <div className={styles.statementRow}>
      <div className={styles.statementHeader}>
        <label
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
          <button type="button" className={styles.linkButton} onClick={onRemove}>
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
    </div>
  );
}
