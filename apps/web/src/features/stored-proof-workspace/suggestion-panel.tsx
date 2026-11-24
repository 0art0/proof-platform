"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { Presentation } from "@proof/language";
import type { DisplayedSuggestionSet, MenuChoices, ProofEdge } from "@proof/protocol";
import {
  ALL_REWRITES,
  COMMON_REWRITE_RELATIONS,
  relationName,
} from "../proof-workspace/rewrite-inspection";
import type { WorkspaceView } from "../proof-workspace";
import { AiShortlist } from "./ai-shortlist";
import { TopUpNotice, type TopUpStatus } from "./library-top-up";
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

const SOURCE_FILTERS = [
  { value: "all", label: "All" },
  { value: "move", label: "Moves" },
  { value: "result", label: "Library results" },
] as const;

const FIND_MORE_REASON_ID = "find-more-results-reason";

/** The fragment that links to the panel (the active-selections card points here and focuses it). */
export const SUGGESTION_PANEL_ID = "suggestion-panel";

export type SuggestionPanelProps = SuggestionPanelActions &
  Readonly<{
    suggestions: SuggestionState;
    relation?: string;
    relationSymbols?: readonly string[];
    onRelationChange?: (relation: string) => void;
    move: MoveState;
    mutationPending: boolean;
    presentation: Presentation;
    view: WorkspaceView;
    authorMovesHref?: string | undefined;
    /** Approved multi-step macros of the session, by move ID. */
    macros?: MacroInfoMap | undefined;
    /** Where AI ranking may be requested; absent when it is unavailable or read-only. */
    aiShortlist?: Readonly<{ sessionId: string; nodeId: string }> | undefined;
    /**
     * "Describe a move" on the none-relevant notice (architecture §5: it focuses the move
     * instructions box). The button is shown only when this is provided.
     */
    onDescribeMove?: (() => void) | undefined;
    /**
     * "Find more results" on the none-relevant notice and on the empty-suggestions state
     * (architecture §2: a library top-up). The button is shown only when this is provided.
     */
    onFindMoreResults?: (() => void) | undefined;
    /**
     * Why "Find more results" cannot be used (a read-only session, or the library assistant is
     * not configured). The buttons are then disabled and the reason is shown beside them.
     */
    findMoreDisabledReason?: string | undefined;
    /** The inline status of a library top-up: working, done, or why it did not happen. */
    findMoreStatus?: TopUpStatus | undefined;
    /** Asks for suggestions again once a top-up added results. */
    onAskAgain?: (() => void) | undefined;
  }>;

/**
 * The suggestion panel (design plan §17.3). Suggestions appear in the stored order; related
 * theorem variants from one stored variant group sit behind an expandable control.
 */
export function SuggestionPanel({
  suggestions,
  relation = "",
  relationSymbols = [],
  onRelationChange,
  move,
  mutationPending,
  presentation,
  view,
  authorMovesHref,
  macros = NO_MACROS,
  aiShortlist,
  onDescribeMove,
  onFindMoreResults,
  findMoreDisabledReason,
  findMoreStatus,
  onAskAgain,
  ...actions
}: SuggestionPanelProps) {
  const [source, setSource] = useState<(typeof SOURCE_FILTERS)[number]["value"]>("all");
  const findMoreBusy = findMoreStatus?.kind === "working";
  const displayedSet =
    suggestions.kind === "ready" || suggestions.kind === "empty"
      ? suggestions.suggestionSet
      : undefined;
  const items = displayedSet?.suggestions ?? [];
  const mixedSources =
    items.some(({ source }) => source === "move") &&
    items.some(({ source }) => source === "result");
  const relations = new Set(
    items.flatMap((item) => (item.rewriteRelation ? [item.rewriteRelation] : [])),
  );
  for (const symbol of [...COMMON_REWRITE_RELATIONS, ...relationSymbols]) relations.add(symbol);
  if (relation && relation !== ALL_REWRITES) relations.add(relation);
  const visible = items.filter(
    (item) =>
      ((!mixedSources || source === "all" || item.source === source) &&
        (!relation ||
          item.rewriteRelation === relation ||
          (relation === ALL_REWRITES && item.rewriteRelation !== undefined))) ||
      (move.kind !== "idle" && item.id === move.suggestionId),
  );
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
      transitionClass={suggestion.rewrite?.transitionClass ?? classes.get(suggestion.id)}
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
    const entries = layoutSuggestions({ suggestions: visible, variantGroups: set.variantGroups });
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
      // Focusable by script and by the "N suggestions" link, not a Tab stop of its own.
      tabIndex={-1}
    >
      <div className={styles.suggestionHeading}>
        <h2>Suggestions</h2>
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
      {findMoreStatus === undefined ? null : (
        <TopUpNotice status={findMoreStatus} onAskAgain={onAskAgain} />
      )}
      {suggestions.kind === "empty" ? (
        <p className={styles.emptyGuide}>
          Try selecting a different part of the statement.
          {authorMovesHref === undefined ? null : (
            <>
              {" "}
              <Link href={authorMovesHref}>Create a reusable move</Link>
            </>
          )}
          {onFindMoreResults === undefined ? null : (
            <>
              {" "}
              <button
                type="button"
                className={styles.emptyGuideButton}
                disabled={findMoreBusy || findMoreDisabledReason !== undefined}
                aria-describedby={
                  findMoreDisabledReason === undefined ? undefined : FIND_MORE_REASON_ID
                }
                onClick={onFindMoreResults}
              >
                Find more results
              </button>
              {findMoreDisabledReason === undefined ? null : (
                <span id={FIND_MORE_REASON_ID} className={styles.findMoreReason}>
                  {" "}
                  {findMoreDisabledReason}
                </span>
              )}
            </>
          )}
        </p>
      ) : null}
      {suggestions.kind === "ready" &&
      aiShortlist !== undefined &&
      suggestions.suggestionSet.suggestions.length > 1 ? (
        <AiShortlist
          key={suggestions.suggestionSet.id}
          sessionId={aiShortlist.sessionId}
          nodeId={aiShortlist.nodeId}
          suggestionSet={suggestions.suggestionSet}
          disabled={mutationPending}
          onDescribeMove={onDescribeMove}
          onFindMoreResults={onFindMoreResults}
          findMoreBusy={findMoreBusy}
          findMoreDisabledReason={findMoreDisabledReason}
        />
      ) : null}
      {onRelationChange && (displayedSet !== undefined || relation !== "") ? (
        <label className={styles.relationFilter}>
          Rewrites
          <select
            aria-label="Relation focus"
            value={relation}
            disabled={move.kind === "applying"}
            onChange={(event) => onRelationChange(event.target.value)}
          >
            <option value="">All moves</option>
            <option value={ALL_REWRITES}>All rewrites</option>
            {[...relations].sort().map((symbol) => (
              <option key={symbol} value={symbol}>
                {relationName(symbol)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {suggestions.kind === "ready" && mixedSources ? (
        <div role="group" aria-label="Filter suggestions" className={styles.sourceFilters}>
          {SOURCE_FILTERS.map(({ value, label }) => (
            <button
              type="button"
              key={value}
              aria-pressed={source === value}
              onClick={() => setSource(value)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {suggestions.kind === "ready" && visible.length === 0 ? (
        <p>No suggestions match the current filters.</p>
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
  if (state.kind === "idle") return "Select a goal, hypothesis or part of a formula.";
  if (state.kind === "loading") return "Finding suggestions for the current selection…";
  if (state.kind === "empty") return "No matching suggestions for this selection.";
  if (state.kind === "stale") return `This selection is out of date: ${state.message}`;
  if (state.kind === "rejected") return `Could not find suggestions: ${state.message}`;
  const count = state.suggestionSet.suggestions.length;
  return `${count} suggestion${count === 1 ? "" : "s"}`;
}
