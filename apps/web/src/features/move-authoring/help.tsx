"use client";

import type { ReactNode } from "react";
import type { TemplateDiagnosticView } from "./api-contract";
import {
  diagnosticAdvice,
  diagnosticTitle,
  formatDiagnosticPath,
  SECTION_LABELS,
  sectionOf,
  type DiagnosticSection,
} from "./diagnostics";
import styles from "./move-authoring.module.css";

/** A one-line explanation under a heading or field. */
export function Hint({ children }: Readonly<{ children: ReactNode }>) {
  return <p className={styles.hint}>{children}</p>;
}

/** Optional longer help: collapsed until the reader opens it, never a popup. */
export function Help({ summary, children }: Readonly<{ summary: string; children: ReactNode }>) {
  return (
    <details className={styles.help}>
      <summary>{summary}</summary>
      <div className={styles.helpBody}>{children}</div>
    </details>
  );
}

/** Why a control is disabled, shown beside it. Renders nothing when the control is usable. */
export function WhyDisabled({ reason }: Readonly<{ reason: string | undefined }>) {
  return reason === undefined ? null : (
    <span className={styles.muted} data-testid="why-disabled">
      {reason}
    </span>
  );
}

/** One diagnostic in plain words: what is wrong, where, and what to do about it. */
export function DiagnosticItem({ diagnostic }: Readonly<{ diagnostic: TemplateDiagnosticView }>) {
  const advice = diagnosticAdvice(diagnostic.code);
  return (
    <li className={styles.diagnostic} data-code={diagnostic.code}>
      <strong>{diagnosticTitle(diagnostic.code)}</strong>
      {diagnostic.message}
      {diagnostic.exampleId === undefined ? null : (
        <span className={styles.muted}> (example {diagnostic.exampleId})</span>
      )}
      {diagnostic.stepIndex === undefined ? null : (
        <span className={styles.muted}> (plan step {diagnostic.stepIndex + 1})</span>
      )}
      {formatDiagnosticPath(diagnostic.path) === "" ? null : (
        <span className={styles.muted}> at {formatDiagnosticPath(diagnostic.path)}</span>
      )}
      {advice === undefined ? null : <span className={styles.advice}>What to do: {advice}</span>}
    </li>
  );
}

/**
 * The validation diagnostics of one editor section, shown next to the fields they concern.
 * Examples show their own diagnostics, so that section is not rendered here.
 */
export function InlineDiagnostics({
  diagnostics,
  section,
}: Readonly<{ diagnostics: readonly TemplateDiagnosticView[]; section: DiagnosticSection }>) {
  const here = diagnostics.filter((diagnostic) => sectionOf(diagnostic) === section);
  if (here.length === 0) return null;
  return (
    <ul
      className={styles.diagnostics}
      aria-label={`Problems found in: ${SECTION_LABELS[section]}`}
      data-section-diagnostics={section}
    >
      {here.map((diagnostic, index) => (
        <DiagnosticItem key={`${diagnostic.code}:${index}`} diagnostic={diagnostic} />
      ))}
    </ul>
  );
}
