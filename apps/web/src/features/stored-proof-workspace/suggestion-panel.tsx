"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { Presentation } from "@proof/language";
import type { DisplayedSuggestionSet, MenuChoices, ProofEdge } from "@proof/protocol";
import type { WorkspaceView } from "../proof-workspace";
import { layoutSuggestions } from "./preview-diff";
import {
  SuggestionCard,
  type DisplayedSuggestion,
  type MoveState,
  type SuggestionCardActions,
} from "./suggestion-card";
import styles from "./suggestion-panel.module.css";

type TransitionClassEntry = Readonly<{
  suggestionId: string;
  transitionClass: ProofEdge["transitionClass"];
}>;

export type SuggestionState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "empty" | "ready";
      suggestionSet: DisplayedSuggestionSet;
      transitionClasses: readonly TransitionClassEntry[];
    }>
  | Readonly<{ kind: "rejected"; message: string }>
  | Readonly<{ kind: "stale"; message: string }>;

/** Panel callbacks, each naming the displayed set and suggestion they act on. */
export type SuggestionPanelActions = Readonly<{
  onPreview: (set: DisplayedSuggestionSet, suggestionId: string) => void;
  onChooseInputs: (set: DisplayedSuggestionSet, suggestionId: string) => void;
  onSubmitChoices: (
    set: DisplayedSuggestionSet,
    suggestionId: string,
    choices: MenuChoices,
  ) => void;
  onCancelChoices: () => void;
  onApply: (set: DisplayedSuggestionSet, suggestionId: string) => void;
  onInputSummaryExpanded: (set: DisplayedSuggestionSet, suggestionId: string) => void;
}>;

export type SuggestionPanelProps = SuggestionPanelActions &
  Readonly<{
    suggestions: SuggestionState;
    move: MoveState;
    mutationPending: boolean;
    presentation: Presentation;
    view: WorkspaceView;
    authorMovesHref?: string | undefined;
  }>;

/**
 * The suggestion panel (design plan §17.3). Suggestions appear in the stored order; related
 * theorem variants from one stored variant group sit behind an expandable control.
 */
export function SuggestionPanel({
  suggestions,
  move,
  mutationPending,
  presentation,
  view,
  authorMovesHref,
  ...actions
}: SuggestionPanelProps) {
  const displayedSet =
    suggestions.kind === "ready" || suggestions.kind === "empty"
      ? suggestions.suggestionSet
      : undefined;
  const classes = new Map(
    suggestions.kind === "ready" || suggestions.kind === "empty"
      ? suggestions.transitionClasses.map((entry) => [entry.suggestionId, entry.transitionClass])
      : [],
  );
  const card = (set: DisplayedSuggestionSet, suggestion: DisplayedSuggestion) => (
    <SuggestionCard
      key={suggestion.id}
      suggestion={suggestion}
      transitionClass={classes.get(suggestion.id)}
      move={move}
      mutationPending={mutationPending}
      presentation={presentation}
      view={view}
      {...bindActions(actions, set, suggestion.id)}
    />
  );
  return (
    <section className={styles.suggestionPanel} aria-label="Available suggestions">
      <div className={styles.suggestionHeading}>
        <div>
          <h2>Suggestions</h2>
          <p className={styles.suggestionMeta}>
            Find a useful next step for the selected mathematics.
          </p>
        </div>
        {displayedSet ? (
          <details className={styles.suggestionRecord}>
            <summary>About this list</summary>
            <code data-testid="suggestion-set-id">{displayedSet.id}</code>
          </details>
        ) : null}
      </div>
      <p className={styles.status} data-state={suggestions.kind} role="status">
        {suggestionStatusText(suggestions)}
      </p>
      {suggestions.kind === "empty" ? (
        <p className={styles.emptyGuide}>
          Try selecting a different part of the statement.
          {authorMovesHref === undefined ? null : (
            <>
              {" "}
              <Link href={authorMovesHref}>Create a reusable move</Link>
            </>
          )}
        </p>
      ) : null}
      {suggestions.kind === "ready" ? (
        <ol className={styles.suggestions} data-testid="suggestion-list">
          {layoutSuggestions(suggestions.suggestionSet).map((entry) =>
            entry.kind === "single" ? (
              card(suggestions.suggestionSet, entry.suggestion)
            ) : (
              <VariantGroup
                key={`variant-group:${entry.familyId}`}
                familyId={entry.familyId}
                name={entry.name}
                lead={card(suggestions.suggestionSet, entry.lead)}
                variants={entry.variants.map((variant) => card(suggestions.suggestionSet, variant))}
                activeInside={entry.variants.some(
                  ({ id }) => move.kind !== "idle" && move.suggestionId === id,
                )}
              />
            ),
          )}
        </ol>
      ) : null}
    </section>
  );
}

function VariantGroup({
  familyId,
  name,
  lead,
  variants,
  activeInside,
}: Readonly<{
  familyId: string;
  name: string;
  lead: ReactNode;
  variants: readonly ReactNode[];
  activeInside: boolean;
}>) {
  const [expanded, setExpanded] = useState(false);
  const listId = `variants-${familyId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  // A variant being previewed or applied stays visible.
  const open = expanded || activeInside;
  const count = variants.length;
  return (
    <li className={styles.variantGroup} data-variant-family={familyId}>
      <ol className={styles.suggestions}>{lead}</ol>
      <button
        type="button"
        className={styles.variantToggle}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setExpanded(!open)}
      >
        <span aria-hidden="true">{open ? "▾ " : "▸ "}</span>
        {open
          ? `Hide related variants of ${name}`
          : `Show ${count} related variant${count === 1 ? "" : "s"} of ${name}`}
      </button>
      {open ? (
        <ol id={listId} className={styles.suggestions} aria-label={`Related variants of ${name}`}>
          {variants}
        </ol>
      ) : null}
    </li>
  );
}

function bindActions(
  actions: SuggestionPanelActions,
  set: DisplayedSuggestionSet,
  suggestionId: string,
): SuggestionCardActions {
  return {
    onPreview: () => actions.onPreview(set, suggestionId),
    onChooseInputs: () => actions.onChooseInputs(set, suggestionId),
    onSubmitChoices: (choices) => actions.onSubmitChoices(set, suggestionId, choices),
    onCancelChoices: actions.onCancelChoices,
    onApply: () => actions.onApply(set, suggestionId),
    onInputSummaryExpanded: () => actions.onInputSummaryExpanded(set, suggestionId),
  };
}

function suggestionStatusText(state: SuggestionState): string {
  if (state.kind === "idle") return "Select a statement or expression to see suggestions.";
  if (state.kind === "loading") return "Finding suggestions for the current selection…";
  if (state.kind === "empty") return "No matching suggestions for this selection.";
  if (state.kind === "stale") return `This selection is out of date: ${state.message}`;
  if (state.kind === "rejected") return `Could not find suggestions: ${state.message}`;
  const count = state.suggestionSet.suggestions.length;
  return `${count} suggestion${count === 1 ? "" : "s"} to explore. Preview a step to inspect its effect before applying.`;
}
