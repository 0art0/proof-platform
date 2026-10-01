import type { ProofEdge } from "@proof/protocol";
import type { SuggestionCategory, TransitionEvidence } from "./preview-diff";
import styles from "./suggestion-panel.module.css";

/**
 * Badges for the suggestion panel. Following the workspace chrome (N29), no badge is
 * distinguished by colour alone: each carries a glyph (hidden from assistive technology) and a
 * text label, and exposes its stored value as a data attribute.
 */

type TransitionClass = ProofEdge["transitionClass"];

const TRANSITION_CLASSES: Readonly<Record<TransitionClass, Readonly<{ glyph: string }>>> = {
  equivalence: { glyph: "⇔" },
  strengthening: { glyph: "⇐" },
  weakening: { glyph: "⇒" },
};

const TRANSITION_MEANINGS: Readonly<Record<TransitionClass, string>> = {
  equivalence: "This step preserves the goal: the old and new states mean the same thing.",
  strengthening: "The new state is stronger. Solving it proves the original goal.",
  weakening: "The new state is weaker. Solving it alone does not prove the original goal.",
};

export function transitionMeaning(transitionClass: TransitionClass): string {
  return TRANSITION_MEANINGS[transitionClass];
}

const EVIDENCE: Readonly<Record<TransitionEvidence, Readonly<{ glyph: string; label: string }>>> = {
  structural: { glyph: "⊢", label: "Structural rule" },
  "library-result": { glyph: "§", label: "Library result cited" },
  "background-inference": { glyph: "∴", label: "Background inference" },
  sorry: { glyph: "⊘", label: "Sorry (unproved assumption)" },
};

const CATEGORIES: Readonly<Record<SuggestionCategory, Readonly<{ glyph: string; label: string }>>> =
  {
    immediate: { glyph: "✓", label: "Immediate" },
    "near-miss": { glyph: "≈", label: "Near miss" },
    "requires-input": { glyph: "✎", label: "Needs input" },
  };

function Glyph({ glyph }: Readonly<{ glyph: string }>) {
  return (
    <span className={styles.badgeGlyph} aria-hidden="true">
      {glyph}
    </span>
  );
}

/** Equivalence, strengthening or weakening, as stored by the proof service. */
export function TransitionClassBadge({
  transitionClass,
}: Readonly<{ transitionClass: TransitionClass }>) {
  return (
    <span
      className={styles.badge}
      data-badge="transition-class"
      data-transition-class={transitionClass}
      title={transitionMeaning(transitionClass)}
      aria-label={`${transitionClass}: ${transitionMeaning(transitionClass)}`}
    >
      <Glyph glyph={TRANSITION_CLASSES[transitionClass].glyph} />
      <span>{transitionClass}</span>
    </span>
  );
}

/** Structural, library-result, background-inference or sorry evidence of a recorded preview. */
export function EvidenceBadge({ evidence }: Readonly<{ evidence: TransitionEvidence }>) {
  return (
    <span className={styles.badge} data-badge="evidence" data-evidence={evidence} title="Evidence">
      <Glyph glyph={EVIDENCE[evidence].glyph} />
      <span>{EVIDENCE[evidence].label}</span>
    </span>
  );
}

/** The retrieval category: immediate, near miss (creates obligations), or needs input. */
export function CategoryBadge({ category }: Readonly<{ category: SuggestionCategory }>) {
  return (
    <span
      className={styles.badge}
      data-badge="category"
      data-category={category}
      title={
        category === "near-miss"
          ? "This step needs additional premises or conditions to be proved."
          : category === "requires-input"
            ? "Choose an available value or selection before previewing this step."
            : "This step is ready to preview."
      }
    >
      <Glyph glyph={CATEGORIES[category].glyph} />
      <span>{CATEGORIES[category].label}</span>
    </span>
  );
}

/**
 * Who produced the suggestion. Displayed suggestions come only from deterministic retrieval;
 * LLM-assisted and stateful-agent suggestions have no stored provenance field yet.
 */
export function ProvenanceBadge() {
  return (
    <span className={styles.badge} data-badge="provenance" data-provenance="deterministic">
      <Glyph glyph="◆" />
      <span>Deterministic</span>
    </span>
  );
}

/** Whether the suggestion applies a library result or runs a move. */
export function SourceBadge({ source }: Readonly<{ source: "result" | "move" }>) {
  return (
    <span className={styles.badge} data-badge="source" data-source={source}>
      <Glyph glyph={source === "result" ? "§" : "↦"} />
      <span>{source === "result" ? "Result application" : "Move"}</span>
    </span>
  );
}

/** How the stored pattern matched the selection. */
export function MatchBadge({
  exact,
  abstractionFit,
}: Readonly<{ exact: boolean; abstractionFit: "not-used" | "compatible" | "unknown" }>) {
  const kind = exact ? "exact" : abstractionFit === "not-used" ? "structural" : "abstraction";
  const label =
    kind === "exact" ? "Exact match" : kind === "structural" ? "Structural match" : "Abstraction";
  return (
    <span className={styles.badge} data-badge="match" data-match={kind}>
      <Glyph glyph={kind === "exact" ? "=" : kind === "structural" ? "≅" : "?"} />
      <span>{label}</span>
    </span>
  );
}
