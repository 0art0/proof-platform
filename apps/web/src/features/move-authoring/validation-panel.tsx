"use client";

import type { Outcome } from "./requests";
import type { TemplateDiagnosticView, TemplateValidation } from "./api-contract";
import { groupDiagnostics } from "./diagnostics";
import { DiagnosticItem, Hint, WhyDisabled } from "./help";
import { CLASS_LABELS } from "./template-builder";
import styles from "./move-authoring.module.css";

/** Diagnostics of one validation, grouped by the editor section they belong to. */
export function DiagnosticList({
  diagnostics,
  label = "Validation diagnostics",
}: Readonly<{ diagnostics: readonly TemplateDiagnosticView[]; label?: string }>) {
  return (
    <div aria-label={label} role="group">
      {groupDiagnostics(diagnostics).map((group) => (
        <section key={group.section} data-section={group.section}>
          <h4>{group.label}</h4>
          <ul className={styles.diagnostics}>
            {group.diagnostics.map((diagnostic, index) => (
              <DiagnosticItem key={`${diagnostic.code}:${index}`} diagnostic={diagnostic} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export type ValidationState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "running" }>
  | Readonly<{
      kind: "done";
      /** Whether the template was edited after this validation ran. */
      stale: boolean;
      outcome: Outcome<TemplateValidation>;
    }>;

export type ValidationPanelProps = Readonly<{
  state: ValidationState;
  /** Why validation cannot run now, if it cannot. */
  unavailableReason?: string | undefined;
  onValidate: () => void;
}>;

/**
 * Validate the template by running its examples through the kernel in the session. The proof
 * service computes; this panel only shows the report or the diagnostics, per field and example.
 */
export function ValidationPanel({ state, unavailableReason, onValidate }: ValidationPanelProps) {
  return (
    <section className={styles.panel} aria-label="Validation">
      <h2>4. Check your move</h2>
      <Hint>
        Checking runs every example through the kernel in this session and compares what happens
        with what you expected. Nothing is saved by checking.
      </Hint>
      <div className={styles.inline}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          disabled={state.kind === "running" || unavailableReason !== undefined}
          onClick={onValidate}
        >
          {state.kind === "running" ? "Validating…" : "Validate by running the examples"}
        </button>
        <WhyDisabled reason={unavailableReason} />
      </div>
      {state.kind === "done" ? <ValidationResult state={state} /> : null}
    </section>
  );
}

function ValidationResult({
  state,
}: Readonly<{ state: Extract<ValidationState, { kind: "done" }> }>) {
  const { outcome } = state;
  return (
    <div data-testid="validation-result" data-stale={state.stale}>
      {state.stale ? (
        <p className={styles.muted} role="note">
          You changed the move after this check ran; check again.
        </p>
      ) : null}
      {!outcome.ok ? (
        <p role="alert" className={styles.error}>
          Validation could not run ({outcome.code}): {outcome.message}
        </p>
      ) : outcome.value.ok ? (
        <div className={styles.report} role="status">
          <strong>The template passes validation.</strong>
          <span>
            Class {CLASS_LABELS[outcome.value.report.transitionClass]};{" "}
            {outcome.value.report.stepCount} plan step
            {outcome.value.report.stepCount === 1 ? "" : "s"}.
          </span>
          <span data-testid="validation-retrievable">
            {outcome.value.report.retrievable
              ? "Once approved this move is offered as a suggestion in the workspace."
              : "A multi-step macro is validated and stored but not offered as a suggestion; apply it as a replay."}
          </span>
          <ul className={styles.list}>
            {outcome.value.report.examples.map((example) => (
              <li key={example.exampleId}>
                {example.exampleId}:{" "}
                {example.outcome === "applied"
                  ? `applied as ${CLASS_LABELS[example.transitionClass ?? "equivalence"]}`
                  : "rejected, as expected"}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <p role="alert" className={styles.error}>
            The template does not pass validation ({outcome.value.diagnostics.length} problem
            {outcome.value.diagnostics.length === 1 ? "" : "s"}).
          </p>
          <DiagnosticList diagnostics={outcome.value.diagnostics} />
        </>
      )}
    </div>
  );
}
