"use client";

import type { ComponentProps } from "react";
import type { Presentation } from "@proof/language";
import type { AdditionalAssumption, ContextualSequent, ProofState } from "@proof/mathjson-model";
import type { DisplayedSuggestionSet } from "@proof/protocol";
import type { WorkspaceView } from "../proof-workspace";
import { StatementView } from "../proof-workspace/presentation";
import styles from "./discovery-viewer.module.css";

const VIEW_OPTIONS: readonly Readonly<{ view: WorkspaceView; label: string }>[] = [
  { view: "formal", label: "Formal (LaTeX)" },
  { view: "natural-language", label: "Natural language" },
];

/** The LaTeX / natural-language switch: a segmented control whose pressed segment is a raised pill. */
export function ViewToggle({
  view,
  onChange,
}: Readonly<{ view: WorkspaceView; onChange: (view: WorkspaceView) => void }>) {
  return (
    <div className={styles.viewToggle} role="group" aria-label="Statement view">
      {VIEW_OPTIONS.map((option) => (
        <button
          key={option.view}
          type="button"
          aria-pressed={view === option.view}
          onClick={() => onChange(option.view)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type ViewProps = Readonly<{ presentation: Presentation; view: WorkspaceView }>;

/**
 * One typeset statement in a container that scrolls sideways rather than overflowing the page,
 * so a long formula never widens the viewer.
 */
export function Statement(props: ComponentProps<typeof StatementView>) {
  return (
    <span className={styles.statement} data-view={props.view}>
      <StatementView {...props} />
    </span>
  );
}

/** One stored sequent: its hypotheses (H1, H2, ...) and, below a hairline, the conclusion. */
export function SequentView({
  sequent,
  presentation,
  view,
}: Readonly<{ sequent: ContextualSequent }> & ViewProps) {
  const declarations = sequent.context.declarations;
  return (
    <div className={styles.sequent}>
      {sequent.context.hypotheses.length > 0 ? (
        <ul className={styles.hypotheses} aria-label="Hypotheses">
          {sequent.context.hypotheses.map((hypothesis, position) => (
            <li key={hypothesis.id} data-role="hypothesis">
              <span className={styles.hypothesisTag}>
                <span aria-hidden="true">H{position + 1}</span>
                <span className="visually-hidden">Hypothesis {position + 1}</span>
              </span>
              <Statement
                expression={hypothesis.statement.expression}
                declarations={declarations}
                presentation={presentation}
                view={view}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <div data-role="conclusion" className={styles.conclusion}>
        <span className={styles.turnstile}>
          <span aria-hidden="true">⊢</span>
          <span className="visually-hidden">Conclusion</span>
        </span>
        <Statement
          expression={sequent.conclusion.expression}
          declarations={declarations}
          presentation={presentation}
          view={view}
        />
      </div>
    </div>
  );
}

/** A stored proof-state snapshot: goals, obligations and assumptions, exactly as stored. */
export function StateSnapshotView({
  state,
  presentation,
  view,
}: Readonly<{ state: ProofState }> & ViewProps) {
  return (
    <div className={styles.snapshot} data-testid="state-snapshot">
      {state.goals.length === 0 && state.obligations.length === 0 ? (
        <p className={styles.hint}>No open goals or obligations in this snapshot.</p>
      ) : null}
      {state.goals.map((goal) => (
        <section
          key={goal.id}
          className={styles.target}
          data-kind="goal"
          aria-label={`Goal ${goal.id}`}
        >
          <h4 className={styles.targetHeading}>
            <span>
              <span aria-hidden="true">◎ </span>Goal
            </span>{" "}
            <code className={styles.meta}>{goal.id}</code>
          </h4>
          <SequentView sequent={goal.sequent} presentation={presentation} view={view} />
        </section>
      ))}
      {state.obligations.map((obligation) => (
        <section
          key={obligation.id}
          className={styles.target}
          data-kind="obligation"
          aria-label={`Obligation ${obligation.id}`}
        >
          <h4 className={styles.targetHeading}>
            <span>
              <span aria-hidden="true">◇ </span>Obligation
            </span>{" "}
            <code className={styles.meta}>{obligation.id}</code>
          </h4>
          <SequentView sequent={obligation.sequent} presentation={presentation} view={view} />
        </section>
      ))}
      {(state.assumptions ?? []).length > 0 ? (
        <AssumptionList
          assumptions={state.assumptions ?? []}
          presentation={presentation}
          view={view}
        />
      ) : null}
    </div>
  );
}

/** Closed assumptions (sorries), each with the target that was assumed without proof. */
export function AssumptionList({
  assumptions,
  presentation,
  view,
  label = "Assumptions",
}: Readonly<{ assumptions: readonly AdditionalAssumption[]; label?: string }> & ViewProps) {
  return (
    <ul className={styles.assumptions} aria-label={label}>
      {assumptions.map((assumption) => (
        <li key={assumption.id} data-assumption-id={assumption.id}>
          <span className={styles.sorryTag}>
            <span aria-hidden="true">{assumption.origin.kind === "sorry" ? "⊘ " : "△ "}</span>
            {assumption.origin.kind === "sorry" ? "Sorry, assumed without proof" : "Assumption"}
          </span>
          <Statement
            expression={assumption.statement.expression}
            declarations={assumption.declarations}
            presentation={presentation}
            view={view}
          />
          <span className={styles.assumptionMeta}>
            <code className={styles.meta}>{assumption.id}</code>
            {assumption.origin.kind === "sorry"
              ? ` for ${assumption.origin.sourceTarget.kind} ${assumption.origin.sourceTarget.id}`
              : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A stored displayed suggestion set, in its stored order. The entries are the stored suggestions
 * verbatim; nothing is re-ranked, re-filtered or recomputed.
 */
export function SuggestionSetView({
  set,
  chosenSuggestionIds,
}: Readonly<{ set: DisplayedSuggestionSet; chosenSuggestionIds: ReadonlySet<string> }>) {
  return (
    <section
      className={styles.suggestionSet}
      aria-label={`Displayed suggestion set ${set.id}`}
      data-suggestion-set-id={set.id}
    >
      <h4 className={styles.setHeading}>
        Displayed suggestion set <code className={styles.meta}>{set.id}</code>
      </h4>
      <p className={styles.muted}>
        Stored selection:{" "}
        {set.selection.kind === "selection-query" ? "a selection query" : "one selection"} ·{" "}
        {set.suggestions.length} {set.suggestions.length === 1 ? "suggestion" : "suggestions"}
      </p>
      {set.suggestions.length === 0 ? (
        <p className={styles.hint}>No suggestions were displayed.</p>
      ) : null}
      <ol className={styles.suggestionList}>
        {set.suggestions.map((suggestion) => (
          <li key={suggestion.id} data-suggestion-id={suggestion.id}>
            <span className={styles.suggestionHead}>
              <strong>{suggestion.name}</strong>{" "}
              <span className={styles.chip}>
                {suggestion.source === "move" ? "Move" : "Library result"}
              </span>{" "}
              <span className={styles.chip}>
                {suggestion.applicability === "applicable" ? "Applicable" : "Requires input"}
              </span>{" "}
              <span className={styles.chip}>
                {suggestion.exactRepresentationMatch ? "Exact match" : "Non-exact match"}
              </span>
              {chosenSuggestionIds.has(suggestion.id) ? (
                <>
                  {" "}
                  <span className={styles.chosen}>
                    <span aria-hidden="true">✓ </span>Chosen
                  </span>
                </>
              ) : null}
            </span>
            <ul className={styles.reasons} aria-label={`Reasons for ${suggestion.name}`}>
              {suggestion.reasons.map((reason, position) => (
                <li key={position}>{reason}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}
