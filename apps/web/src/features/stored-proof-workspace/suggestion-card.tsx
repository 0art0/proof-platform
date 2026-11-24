"use client";

import type { Presentation } from "@proof/language";
import type { DisplayedSuggestionSet, MenuChoices, MovePreview, ProofEdge } from "@proof/protocol";
import type { WorkspaceView } from "../proof-workspace";
import { InlineLatex, NaturalLanguageText, StatementView } from "../proof-workspace/presentation";
import type { MacroInfo } from "./macro-info";
import { ParameterMenu, type DisplayedParameterMenu } from "./parameter-menu";
import { PreviewDetails } from "./preview-details";
import { suggestionCategory } from "./preview-diff";
import {
  CategoryBadge,
  EvidenceBadge,
  MacroBadge,
  MatchBadge,
  ProvenanceBadge,
  SourceBadge,
  SORRY_MEANING,
  TransitionClassBadge,
  transitionMeaning,
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
    /** Set when this suggestion is an approved multi-step macro. */
    macro?: MacroInfo | undefined;
    /** What tells this card from another with the same name (for example a direction). */
    qualifier?: string | undefined;
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
  macro,
  qualifier,
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
  // The preview's own step list is authoritative; before it, the stored macro template says.
  const macroStepCount = preview?.macro?.steps.length ?? macro?.stepCount;
  // Retrieval marks moves with menu parameters as requiring input; the menus resolve them.
  // Unresolved selection slots or a retrieval abstraction need a new selection instead.
  const menuResolvable =
    suggestion.applicability === "requires-input" &&
    suggestion.unresolvedSelectionSlots.length === 0 &&
    suggestion.abstractionFit === "not-used";
  const previewable = suggestion.applicability === "applicable";
  const busy = active && (move.kind === "previewing" || move.kind === "applying");
  // A sorry is an unproved assumption, whatever transition class is stored beside it.
  const sorry = suggestion.source === "move" && suggestion.artifactId === "move:mark-sorry";
  return (
    <li
      className={styles.suggestionCard}
      data-applicability={suggestion.applicability}
      data-artifact-id={suggestion.artifactId}
      data-rewrite-relation={suggestion.rewriteRelation}
      data-suggestion-id={suggestion.id}
      data-source={suggestion.source}
      data-category={category}
      data-active={active ? "true" : undefined}
    >
      <h3>
        {suggestion.name}
        {qualifier === undefined ? null : (
          <span className={styles.cardQualifier} data-testid="card-qualifier">
            {" "}
            ({qualifier})
          </span>
        )}
      </h3>
      {suggestion.rewrite ? (
        <p>
          Replace with{" "}
          <StatementView
            expression={suggestion.rewrite.replacement}
            presentation={presentation}
            view={view}
          />
          {suggestion.rewrite.obligations.length > 0
            ? ` · ${suggestion.rewrite.obligations.length} side goal${suggestion.rewrite.obligations.length === 1 ? "" : "s"}`
            : null}
        </p>
      ) : null}
      <div
        className={styles.badgeRow}
        aria-label={`Classification of ${suggestion.name}`}
        role="group"
      >
        <SourceBadge source={suggestion.source} />
        {macroStepCount === undefined ? null : <MacroBadge stepCount={macroStepCount} />}
        <CategoryBadge category={category} />
        {sorry ? (
          <EvidenceBadge evidence="sorry" />
        ) : transitionClass === undefined ? null : (
          <TransitionClassBadge transitionClass={transitionClass} />
        )}
      </div>
      {sorry ? (
        <p className={styles.transitionMeaning} data-testid="sorry-meaning">
          {SORRY_MEANING}
        </p>
      ) : null}
      <details className={styles.explanationDetails}>
        <summary>Why this was suggested</summary>
        {!sorry && transitionClass !== undefined ? (
          <p className={styles.transitionMeaning}>{transitionMeaning(transitionClass)}</p>
        ) : null}
        {suggestion.reasons.length === 0 ? null : (
          <ul aria-label={`Reasons for ${suggestion.name}`}>
            {suggestion.reasons.map((reason, index) => (
              <li key={`${suggestion.id}:reason:${index}`} data-suggestion-reason>
                <NaturalLanguageText text={reason} />
              </li>
            ))}
          </ul>
        )}
        <div
          className={styles.badgeRow}
          aria-label={`Provenance and match for ${suggestion.name}`}
          role="group"
        >
          <ProvenanceBadge />
          <MatchBadge
            exact={suggestion.exactRepresentationMatch}
            abstractionFit={suggestion.abstractionFit}
          />
        </div>
        <code>{suggestion.artifactId}</code>
        <ul aria-label={`Matched selections for ${suggestion.name}`}>
          {suggestion.selectionMatches.map((match) => (
            <li key={`${match.selectionId}:${match.selectionSlotId ?? match.patternId}`}>
              {match.selectionId} → {match.selectionSlotId ?? match.patternId}
            </li>
          ))}
        </ul>
        {suggestion.substitutions.length === 0 ? null : (
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
        )}
      </details>
      {suggestion.predictedObligations === undefined ? null : (
        <details className={styles.nearMiss}>
          <summary>
            Can apply after proving {suggestion.predictedObligations.length} condition
            {suggestion.predictedObligations.length === 1 ? "" : "s"}
          </summary>
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
          <span>Each condition becomes a new obligation when the result is applied.</span>
        </details>
      )}
      {!previewable && !menuResolvable ? (
        <p className={styles.previewReason}>
          {suggestion.abstractionFit !== "not-used"
            ? "Search-only result. Select a concrete expression to use it."
            : "Select the other parts this step needs."}
        </p>
      ) : null}
      {menuResolvable &&
      menu === undefined &&
      preview === undefined &&
      !(active && move.kind === "applying") ? (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.chooseInputs}
            disabled={mutationPending || busy}
            onClick={actions.onChooseInputs}
          >
            {busy ? "Finding choices…" : "Choose values"}
          </button>
          <details
            className={styles.explanationDetails}
            onToggle={(event) => {
              if (event.currentTarget.open) actions.onInputSummaryExpanded();
            }}
          >
            <summary>Why input is needed</summary>
            <p>Choose the missing value from the current proof.</p>
          </details>
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
      {previewable && !preview && !(active && move.kind === "applying") ? (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.previewButton}
            disabled={mutationPending || busy}
            onClick={actions.onPreview}
          >
            {busy ? "Preparing preview…" : "Preview changes"}
          </button>
        </div>
      ) : null}
      {active && move.kind === "rejected" ? (
        <p className={styles.status} data-state="rejected" role="alert">
          Move rejected: {move.message}
        </p>
      ) : null}
      {preview ? (
        <PreviewDetails preview={preview} presentation={presentation} view={view} />
      ) : null}
      {preview || (active && move.kind === "applying") ? (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.applyButton}
            disabled={mutationPending || preview === undefined}
            onClick={actions.onApply}
          >
            {active && move.kind === "applying" ? "Applying…" : "Apply this step"}
          </button>
        </div>
      ) : null}
    </li>
  );
}
