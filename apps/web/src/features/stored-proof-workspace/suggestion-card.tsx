"use client";

import type { Presentation } from "@proof/language";
import type { DisplayedSuggestionSet, MenuChoices, MovePreview, ProofEdge } from "@proof/protocol";
import type { WorkspaceView } from "../proof-workspace";
import { InlineLatex, NaturalLanguageText } from "../proof-workspace/presentation";
import { ParameterMenu, type DisplayedParameterMenu } from "./parameter-menu";
import { PreviewDetails } from "./preview-details";
import { suggestionCategory } from "./preview-diff";
import {
  CategoryBadge,
  MatchBadge,
  ProvenanceBadge,
  SourceBadge,
  TransitionClassBadge,
} from "./suggestion-badges";
import styles from "./suggestion-panel.module.css";

export type DisplayedSuggestion = DisplayedSuggestionSet["suggestions"][number];

/** Menus returned for a move that needs input, with the choices submitted so far. */
export type PendingMenus = Readonly<{
  menus: readonly DisplayedParameterMenu[];
  missingParameters: readonly string[];
  choices: MenuChoices;
}>;

/** The panel's transient preview/apply state; at most one suggestion is active at a time. */
export type MoveState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "previewing"; suggestionId: string; menu?: PendingMenus | undefined }>
  | Readonly<{ kind: "applying"; suggestionId: string }>
  | Readonly<{ kind: "choosing"; suggestionId: string; menu: PendingMenus }>
  | Readonly<{
      kind: "previewed";
      suggestionId: string;
      commandId: string;
      preview: MovePreview;
      choices: MenuChoices;
    }>
  | Readonly<{ kind: "rejected"; suggestionId: string; message: string }>;

export type SuggestionCardActions = Readonly<{
  onPreview: () => void;
  onChooseInputs: () => void;
  onSubmitChoices: (choices: MenuChoices) => void;
  onCancelChoices: () => void;
  onApply: () => void;
  /** The missing-input summary was expanded (an interaction event, refinement §12). */
  onInputSummaryExpanded: () => void;
}>;

export type SuggestionCardProps = SuggestionCardActions &
  Readonly<{
    suggestion: DisplayedSuggestion;
    transitionClass?: ProofEdge["transitionClass"] | undefined;
    move: MoveState;
    mutationPending: boolean;
    presentation: Presentation;
    view: WorkspaceView;
  }>;

/**
 * One displayed suggestion (design plan §17.3): name, applicability reasons, matched
 * selections, instantiation, predicted obligations, classification, provenance, and the
 * preview/apply actions. Everything shown is read from the stored suggestion and preview.
 */
export function SuggestionCard({
  suggestion,
  transitionClass,
  move,
  mutationPending,
  presentation,
  view,
  ...actions
}: SuggestionCardProps) {
  const active = move.kind !== "idle" && move.suggestionId === suggestion.id;
  const preview = active && move.kind === "previewed" ? move.preview : undefined;
  const menu =
    active && move.kind === "choosing"
      ? move.menu
      : active && move.kind === "previewing"
        ? move.menu
        : undefined;
  const category = suggestionCategory(suggestion);
  // Retrieval marks moves with menu parameters as requiring input; the menus resolve them.
  // Unresolved selection slots or a retrieval abstraction need a new selection instead.
  const menuResolvable =
    suggestion.applicability === "requires-input" &&
    suggestion.unresolvedSelectionSlots.length === 0 &&
    suggestion.abstractionFit === "not-used";
  const previewable = suggestion.applicability === "applicable";
  const busy = active && (move.kind === "previewing" || move.kind === "applying");
  return (
    <li
      className={styles.suggestionCard}
      data-applicability={suggestion.applicability}
      data-artifact-id={suggestion.artifactId}
      data-suggestion-id={suggestion.id}
      data-source={suggestion.source}
      data-category={category}
    >
      <header className={styles.cardHeader}>
        <div>
          <h3>{suggestion.name}</h3>
          <code>{suggestion.artifactId}</code>
        </div>
        <span className={styles.applicability} data-applicability={suggestion.applicability}>
          {suggestion.applicability === "applicable" ? "Applicable" : "Needs input"}
        </span>
      </header>
      <div
        className={styles.badgeRow}
        aria-label={`Classification of ${suggestion.name}`}
        role="group"
      >
        <SourceBadge source={suggestion.source} />
        <ProvenanceBadge />
        <MatchBadge
          exact={suggestion.exactRepresentationMatch}
          abstractionFit={suggestion.abstractionFit}
        />
        <CategoryBadge category={category} />
        {transitionClass === undefined ? null : (
          <TransitionClassBadge transitionClass={transitionClass} />
        )}
      </div>
      <div className={styles.cardSection}>
        <strong>Why it applies</strong>
        <ul aria-label={`Reasons for ${suggestion.name}`}>
          {suggestion.reasons.map((reason, index) => (
            <li key={`${suggestion.id}:reason:${index}`}>{reason}</li>
          ))}
        </ul>
      </div>
      <div className={styles.cardSection}>
        <strong>Matched selections</strong>
        <ul aria-label={`Matched selections for ${suggestion.name}`}>
          {suggestion.selectionMatches.map((match) => (
            <li key={`${match.selectionId}:${match.selectionSlotId ?? match.patternId}`}>
              {match.selectionId} → {match.selectionSlotId ?? match.patternId}
            </li>
          ))}
        </ul>
      </div>
      {suggestion.substitutions.length > 0 ? (
        <div className={styles.cardSection}>
          <strong>Instantiation</strong>
          <ul aria-label={`Instantiation for ${suggestion.name}`}>
            {suggestion.substitutions.map(({ symbol, expression }) => (
              <li key={symbol}>
                <InlineLatex
                  latex={`${presentation.latex(symbol)} \\mapsto ${presentation.latex(expression)}`}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {suggestion.predictedObligations === undefined ? null : (
        <div className={styles.nearMiss} role="note">
          <strong>
            <span aria-hidden="true">≈ </span>Near miss: applies once these are proved
          </strong>
          <ul aria-label={`Predicted obligations for ${suggestion.name}`}>
            {suggestion.predictedObligations.map((obligation) => (
              <li
                key={`${obligation.kind}:${obligation.index}`}
                data-obligation-kind={obligation.kind}
              >
                <span className={styles.obligationKind}>
                  {obligation.kind === "premise" ? "Premise" : "Side condition"}
                </span>{" "}
                <NaturalLanguageText text={obligation.description} />
              </li>
            ))}
          </ul>
          <span>Each becomes a new obligation when the result is applied.</span>
        </div>
      )}
      {suggestion.applicability === "requires-input" ? (
        <div className={styles.missingInput} role="note">
          <strong>Additional input required</strong>
          <span>{missingInputText(suggestion)}</span>
          <details
            onToggle={(event) => {
              if (event.currentTarget.open) actions.onInputSummaryExpanded();
            }}
          >
            <summary>Input menus</summary>
            <ul aria-label={`Input menus for ${suggestion.name}`}>
              {[...suggestion.unresolvedSelectionSlots, ...suggestion.unresolvedParameters].map(
                (input) => (
                  <li key={input}>{`Choose ${input}`}</li>
                ),
              )}
            </ul>
          </details>
          {menuResolvable ? (
            <button
              type="button"
              className={styles.chooseInputs}
              disabled={mutationPending || busy || menu !== undefined}
              onClick={actions.onChooseInputs}
            >
              Choose inputs
            </button>
          ) : null}
        </div>
      ) : null}
      {menu === undefined ? null : (
        <ParameterMenu
          key={JSON.stringify(menu.choices) + menu.missingParameters.join("|")}
          suggestionName={suggestion.name}
          menus={menu.menus}
          missingParameters={menu.missingParameters}
          choices={menu.choices}
          pending={busy || mutationPending}
          onSubmit={actions.onSubmitChoices}
          onCancel={actions.onCancelChoices}
          presentation={presentation}
          view={view}
        />
      )}
      <div className={styles.cardActions}>
        <button
          type="button"
          disabled={mutationPending || !previewable || (active && move.kind !== "rejected")}
          onClick={actions.onPreview}
        >
          {active && move.kind === "previewing" && menu === undefined ? "Previewing…" : "Preview"}
        </button>
        <button
          type="button"
          disabled={mutationPending || preview === undefined}
          onClick={actions.onApply}
        >
          {active && move.kind === "applying" ? "Applying…" : "Apply"}
        </button>
      </div>
      {active && move.kind === "rejected" ? (
        <p className={styles.status} data-state="rejected" role="alert">
          Move rejected: {move.message}
        </p>
      ) : null}
      {preview ? (
        <PreviewDetails preview={preview} presentation={presentation} view={view} />
      ) : null}
    </li>
  );
}

function missingInputText(suggestion: DisplayedSuggestion): string {
  const inputs = [...suggestion.unresolvedSelectionSlots, ...suggestion.unresolvedParameters];
  if (suggestion.abstractionFit !== "not-used")
    inputs.push("a concrete replacement for the abstraction");
  return inputs.length === 0 ? "This suggestion cannot yet be executed." : inputs.join(", ");
}
