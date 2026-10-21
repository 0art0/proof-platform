"use client";

import { useId, useState } from "react";
import type { TemplateDiagnosticView } from "./api-contract";
import { diagnosticsForExample } from "./diagnostics";
import { DiagnosticItem, Hint, WhyDisabled } from "./help";
import type { ExtensionKind, MoveProposal } from "./proposal-contract";
import { CLASS_LABELS } from "./template-builder";
import { DiagnosticList } from "./validation-panel";
import styles from "./move-authoring.module.css";

/** What each honest classification means, in plain words (refinement section 7.3). */
const EXTENSION_MEANING: Readonly<Record<ExtensionKind, { label: string; meaning: string }>> =
  Object.freeze({
    macro: {
      label: "A macro",
      meaning: "It packages steps that already exist; their expansion stays visible.",
    },
    heuristic: {
      label: "A new heuristic",
      meaning: "It is a reusable way to choose what to do. Its success is not guaranteed.",
    },
    principle: {
      label: "A new mathematical principle",
      meaning:
        "It would add knowledge that is not available. A move cannot add a result by being approved, so this cannot be saved as a move.",
    },
  });

type ExampleLine = Readonly<{
  id: string;
  description: string;
  expectation: string;
  diagnostics: readonly TemplateDiagnosticView[];
}>;

/** The proposal's examples, each with what the kernel said about it. */
function exampleLines(proposal: MoveProposal): readonly ExampleLine[] {
  const examples = Array.isArray(proposal.template["examples"])
    ? (proposal.template["examples"] as Record<string, unknown>[])
    : [];
  const diagnostics = proposal.validation.ok ? [] : proposal.validation.diagnostics;
  return examples.map((example, index) => {
    const id = String(example["id"] ?? `example-${index + 1}`);
    const expected = example["expected"] as { outcome?: string } | undefined;
    return {
      id,
      description: String(example["description"] ?? ""),
      expectation: expected?.outcome === "rejected" ? "should be refused" : "should be applied",
      diagnostics: diagnosticsForExample(diagnostics, id, index),
    };
  });
}

export type ProposalPanelProps = Readonly<{
  proposal: MoveProposal;
  /** Why a revision cannot be requested now (no model configured, read-only), if so. */
  reviseBlocked?: string | undefined;
  revising: boolean;
  /** The reason the last revision request failed, if it did. */
  revisionFailure?: string | undefined;
  onRevise: (feedback: string) => void;
}>;

/**
 * The model's proposal beside the existing authoring form: how the step motivated it, what kind of
 * extension it honestly is, and what the kernel made of each example. Everything here is read-only
 * evidence; the form below it is where the move is edited, and saving and review stay the
 * ordinary, human steps.
 */
export function ProposalPanel({
  proposal,
  reviseBlocked,
  revising,
  revisionFailure,
  onRevise,
}: ProposalPanelProps) {
  const feedbackId = useId();
  const [feedback, setFeedback] = useState("");
  const kind = EXTENSION_MEANING[proposal.classification.kind];
  const lines = exampleLines(proposal);
  const failed = proposal.validation.ok ? [] : proposal.validation.diagnostics;
  const general = failed.filter((diagnostic) => diagnostic.exampleId === undefined);
  const reviseReason =
    reviseBlocked ??
    (revising
      ? "The model is working on it."
      : feedback.trim() === ""
        ? "Say what to change first."
        : undefined);

  return (
    <section
      className={styles.panel}
      aria-label="The model's proposal"
      data-testid="move-proposal"
      data-valid={proposal.validation.ok}
    >
      <h2>The model&apos;s proposal</h2>
      <Hint>
        A model wrote this move from the step you took. The kernel has run its examples below. You
        can edit anything in the form underneath; nothing is saved until you save a draft, and a
        move is added only after a person approves it.
      </Hint>

      <div>
        <h3>How your step led to it</h3>
        <p data-testid="proposal-motivation">{proposal.motivation}</p>
      </div>

      <div data-testid="proposal-classification" data-kind={proposal.classification.kind}>
        <h3>What kind of extension this is</h3>
        <p>
          <strong>{kind.label}.</strong> {kind.meaning}
        </p>
        <p className={styles.muted}>The model says: {proposal.classification.rationale}</p>
      </div>
      {proposal.blocked === undefined ? null : (
        <p role="alert" className={styles.error} data-testid="proposal-blocked">
          {proposal.blocked.message}
        </p>
      )}

      <div data-testid="proposal-validation">
        <h3>What the kernel made of the examples</h3>
        {proposal.validation.ok ? (
          <p role="status">
            <strong>Every example behaves as stated.</strong> The move is a{" "}
            {CLASS_LABELS[proposal.validation.report.transitionClass].toLowerCase()} in{" "}
            {proposal.validation.report.stepCount} step
            {proposal.validation.report.stepCount === 1 ? "" : "s"}.
          </p>
        ) : (
          <p role="alert" className={styles.error}>
            The move does not pass validation yet ({failed.length} problem
            {failed.length === 1 ? "" : "s"}). You can edit it by hand or ask for a revision.
          </p>
        )}
        <ul className={styles.list} aria-label="Examples of the proposal">
          {lines.map((line) => (
            <li key={line.id} data-example={line.id} data-ok={line.diagnostics.length === 0}>
              <strong>{line.id}</strong>: {line.description} ({line.expectation}).{" "}
              {line.diagnostics.length === 0
                ? proposal.validation.ok
                  ? "As expected."
                  : "No problem found."
                : "Problem:"}
              {line.diagnostics.length === 0 ? null : (
                <ul className={styles.diagnostics}>
                  {line.diagnostics.map((diagnostic, index) => (
                    <DiagnosticItem key={`${diagnostic.code}:${index}`} diagnostic={diagnostic} />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {general.length === 0 ? null : (
          <DiagnosticList diagnostics={general} label="Problems with the move as a whole" />
        )}
        {proposal.generality.length === 0 ? null : (
          <div data-testid="proposal-generality">
            <h4>Worth checking for generality</h4>
            <ul className={styles.list}>
              {proposal.generality.map((note) => (
                <li key={`${note.code}:${note.message}`}>{note.message}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <form
        aria-label="Revise the proposal"
        onSubmit={(event) => {
          event.preventDefault();
          if (reviseReason === undefined) {
            onRevise(feedback.trim());
            setFeedback("");
          }
        }}
      >
        <label htmlFor={feedbackId}>What should change?</label>
        <Hint>
          For example: “Also handle the case where the antecedent is a conjunction.” The revision
          replaces the form below, so save what you want to keep first.
        </Hint>
        <textarea
          id={feedbackId}
          rows={2}
          maxLength={4000}
          value={feedback}
          disabled={reviseBlocked !== undefined || revising}
          onChange={(event) => setFeedback(event.target.value)}
        />
        <div className={styles.inline}>
          <button type="submit" className={styles.button} disabled={reviseReason !== undefined}>
            {revising ? "Asking the model…" : "Revise with feedback"}
          </button>
          <WhyDisabled reason={reviseReason} />
        </div>
        {revisionFailure === undefined ? null : (
          <p role="alert" className={styles.error} data-testid="revision-failure">
            {revisionFailure}
          </p>
        )}
      </form>
    </section>
  );
}
