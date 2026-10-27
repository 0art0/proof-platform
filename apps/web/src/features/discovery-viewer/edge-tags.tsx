import type { DiscoveryEvidence, ProofEdge } from "@proof/protocol";
import styles from "./discovery-viewer.module.css";

export const EVIDENCE_LABELS: Readonly<Record<DiscoveryEvidence, string>> = Object.freeze({
  structural: "Structural",
  "library-result": "Library result",
  "background-inference": "Background inference",
  sorry: "Sorry",
});

const EVIDENCE_GLYPHS: Readonly<Record<DiscoveryEvidence, string>> = Object.freeze({
  structural: "⊢",
  "library-result": "§",
  "background-inference": "∴",
  sorry: "⊘",
});

const TRANSITION_GLYPHS: Readonly<Record<ProofEdge["transitionClass"], string>> = Object.freeze({
  equivalence: "⇔",
  strengthening: "⇐",
  weakening: "⇒",
});

/** How the new goal relates to the old one: equivalence, strengthening or weakening stay distinct. */
export function TransitionTag({
  transitionClass,
}: Readonly<{ transitionClass: ProofEdge["transitionClass"] }>) {
  return (
    <span className={styles.transitionTag} data-transition-class={transitionClass}>
      <span aria-hidden="true">{TRANSITION_GLYPHS[transitionClass]}</span>
      {transitionClass}
    </span>
  );
}

/** What justified the step: structural, library, background inference or an assumed sorry. */
export function EvidenceTag({ evidence }: Readonly<{ evidence: DiscoveryEvidence }>) {
  return (
    <span className={styles.evidenceTag} data-evidence={evidence}>
      <span aria-hidden="true">{EVIDENCE_GLYPHS[evidence]}</span>
      {EVIDENCE_LABELS[evidence]}
    </span>
  );
}
