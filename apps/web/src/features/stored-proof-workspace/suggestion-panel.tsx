"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { Presentation } from "@proof/language";
import type { DisplayedSuggestionSet, MenuChoices, ProofEdge } from "@proof/protocol";
import type { WorkspaceView } from "../proof-workspace";
import { NO_MACROS, type MacroInfoMap } from "./macro-info";
import { layoutSuggestions, type SuggestionLayoutEntry } from "./preview-diff";
import { suggestionQualifiers } from "./suggestion-qualifiers";
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

/** The fragment that links to the panel (the active-selections card points here). */
export const SUGGESTION_PANEL_ID = "suggestion-panel";

export type SuggestionPanelProps = SuggestionPanelActions &
  Readonly<{
    suggestions: SuggestionState;
    move: MoveState;
    mutationPending: boolean;
    presentation: Presentation;
    view: WorkspaceView;
    authorMovesHref?: string | undefined;
    /** Approved multi-step macros of the session, by move ID. */
    macros?: MacroInfoMap | undefined;
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
  macros = NO_MACROS,
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
  const qualifiers = suggestionQualifiers(displayedSet?.suggestions ?? []);
  const card = (set: DisplayedSuggestionSet, suggestion: DisplayedSuggestion) => (
    <SuggestionCard
      key={suggestion.id}
      suggestion={suggestion}
      transitionClass={classes.get(suggestion.id)}
      macro={suggestion.source === "move" ? macros.get(suggestion.artifactId) : undefined}
      qualifier={qualifiers.get(suggestion.id)}
      move={move}
      mutationPending={mutationPending}
      presentation={presentation}
      view={view}
      {...bindActions(actions, set, suggestion.id)}
    />
  );
  const isActive = (id: string) => move.kind !== "idle" && move.suggestionId === id;
  const entryContains = (entry: SuggestionLayoutEntry, test: (id: string) => boolean) =>
    entry.kind === "single"
      ? test(entry.suggestion.id)
      : [entry.lead, ...entry.variants].some(({ id }) => test(id));
  const entryNode = (set: DisplayedSuggestionSet, entry: SuggestionLayoutEntry) =>
    entry.kind === "single" ? (
      card(set, entry.suggestion)
    ) : (
      <VariantGroup
        key={`variant-group:${entry.familyId}`}
        familyId={entry.familyId}
        lead={card(set, entry.lead)}
        variants={entry.variants.map((variant) => card(set, variant))}
        activeInside={entry.variants.some(({ id }) => isActive(id))}
        showLabel={(count) =>
          `Show ${count} other version${count === 1 ? "" : "s"} of ${entry.name}`
        }
        hideLabel={`Hide other versions of ${entry.name}`}
        listLabel={`Other versions of ${entry.name}`}
      />
    );
  /**
   * Results found only by searching for any expression of the selected kind cannot be previewed:
   * the first stays where it is and the rest sit behind one summary line. Nothing is dropped.
   */
  const renderEntries = (set: DisplayedSuggestionSet) => {
    const entries = layoutSuggestions(set);
    const searchOnly = entries.filter((entry) =>
      entryContains(entry, (id) => abstractionOnly(set, id)),
    );
    const [firstSearchOnly, ...restSearchOnly] = searchOnly;
    return entries.map((entry) => {
      if (firstSearchOnly === undefined || restSearchOnly.length === 0)
        return entryNode(set, entry);
      if (restSearchOnly.includes(entry)) return null;
      if (entry !== firstSearchOnly) return entryNode(set, entry);
      return (
        <VariantGroup
          key="search-only-group"
          familyId="search-only"
          lead={entryNode(set, firstSearchOnly)}
          variants={restSearchOnly.map((rest) => entryNode(set, rest))}
          activeInside={restSearchOnly.some((rest) => entryContains(rest, isActive))}
          showLabel={(count) =>
            `Show ${count} more search-only result${count === 1 ? "" : "s"} (browse only; they cannot be previewed)`
          }
          hideLabel="Hide the other search-only results"
          listLabel="Other search-only results"
        />
      );
    });
  };
  return (
    <section
      id={SUGGESTION_PANEL_ID}
      className={styles.suggestionPanel}
      aria-label="Available suggestions"
    >
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
          {renderEntries(suggestions.suggestionSet)}
        </ol>
      ) : null}
      {suggestions.kind === "ready" ? <LabelKey /> : null}
    </section>
  );
}

function VariantGroup({
  familyId,
  lead,
  variants,
  activeInside,
  showLabel,
  hideLabel,
  listLabel,
}: Readonly<{
  familyId: string;
  lead: ReactNode;
  variants: readonly ReactNode[];
  activeInside: boolean;
  showLabel: (count: number) => string;
  hideLabel: string;
  listLabel: string;
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
        {open ? hideLabel : showLabel(count)}
      </button>
      {open ? (
        <ol id={listId} className={styles.suggestions} aria-label={listLabel}>
          {variants}
        </ol>
      ) : null}
    </li>
  );
}

function abstractionOnly(set: DisplayedSuggestionSet, id: string): boolean {
  return set.suggestions.some(
    (suggestion) => suggestion.id === id && suggestion.abstractionFit !== "not-used",
  );
}

const LABEL_KEY: readonly (readonly [string, string])[] = [
  ["Result application", "Uses a named result from the library on your selection."],
  ["Move", "Runs a built-in or authored proof step on your selection."],
  ["N-step move", "A move that applies several steps in a row as one action."],
  ["Immediate", "Ready to preview now."],
  ["Near miss", "Applies once a few conditions are proved; they become new obligations."],
  ["Needs input", "Choose a value or selection first."],
  [
    "Exact match / Structural match",
    "Whether your selection is written exactly like the pattern or only has its shape.",
  ],
  ["⇔ equivalence", "The new state means the same as the old one."],
  ["⇐ strengthening", "The new state is stronger; solving it proves the original."],
  ["⇒ weakening", "The new state is weaker; solving it alone does not prove the original."],
  ["Sorry", "An unproved assumption, kept visibly separate from proved steps."],
];

/** A collapsed key to the labels on the cards; nothing opens unprompted. */
function LabelKey() {
  return (
    <details className={styles.labelKey}>
      <summary>What do these labels mean?</summary>
      <dl>
        {LABEL_KEY.map(([term, meaning]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
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
