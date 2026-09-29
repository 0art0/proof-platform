"use client";

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

/** The LaTeX / natural-language switch, with the pressed state shown by a check mark and a label. */
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

/** One stored sequent: its hypotheses and conclusion. */
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
          {sequent.context.hypotheses.map((hypothesis) => (
            <li key={hypothesis.id} data-role="hypothesis">
              <span className={styles.roleTag}>Hypothesis</span>{" "}
              <StatementView
                expression={hypothesis.statement.expression}
                declarations={declarations}
                presentation={presentation}
                view={view}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <p data-role="conclusion">
        <span className={styles.roleTag}>Conclusion</span>{" "}
        <StatementView
          expression={sequent.conclusion.expression}
          declarations={declarations}
          presentation={presentation}
          view={view}
        />
      </p>
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
        <p>No open goals or obligations in this snapshot.</p>
      ) : null}
      {state.goals.map((goal) => (
        <section
          key={goal.id}
          className={styles.target}
          data-kind="goal"
          aria-label={`Goal ${goal.id}`}
        >
          <h4>
            <span aria-hidden="true">◎ </span>Goal <code>{goal.id}</code>
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
          <h4>
            <span aria-hidden="true">◇ </span>Obligation <code>{obligation.id}</code>
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
          <span className={styles.roleTag}>
            <span aria-hidden="true">△ </span>
            {assumption.origin.kind === "sorry" ? "Sorry, assumed without proof" : "Assumption"}
          </span>{" "}
          <StatementView
            expression={assumption.statement.expression}
            declarations={assumption.declarations}
            presentation={presentation}
            view={view}
          />
          <br />
          <small>
            <code>{assumption.id}</code>
            {assumption.origin.kind === "sorry"
              ? ` for ${assumption.origin.sourceTarget.kind} ${assumption.origin.sourceTarget.id}`
              : null}
          </small>
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
      <h4>
        Displayed suggestion set <code>{set.id}</code>
      </h4>
      <p className={styles.muted}>
        Stored selection:{" "}
        {set.selection.kind === "selection-query" ? "a selection query" : "one selection"} ·{" "}
        {set.suggestions.length} {set.suggestions.length === 1 ? "suggestion" : "suggestions"}
      </p>
      {set.suggestions.length === 0 ? <p>No suggestions were displayed.</p> : null}
      <ol>
        {set.suggestions.map((suggestion) => (
          <li key={suggestion.id} data-suggestion-id={suggestion.id}>
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
