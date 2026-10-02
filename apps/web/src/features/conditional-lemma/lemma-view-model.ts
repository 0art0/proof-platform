import type { LibraryArtifactView, LibraryEntry } from "../library-drawer/api-contract";
import type { ExistingLemmaView, LemmaPreview, ReadyLemmaPreview } from "./api-contract";

/** One plain-language line saying what a lemma is, shown wherever the action is offered. */
export const LEMMA_EXPLANATION =
  "A lemma is a result you proved here and keep for later. Once a step of your proof is finished, you can save it as a lemma; it is offered as a suggestion only after you approve it in the Library.";

/** Why a step cannot be saved yet, in ordinary language. */
export function refusalExplanation(preview: Exclude<LemmaPreview, { status: "ready" }>): string {
  switch (preview.code) {
    case "lemma-not-closed":
      return "This step is not finished yet: some part of the proof below it is still open.";
    case "lemma-uses-sorry":
      return "This step was closed with a sorry (an unproved assumption), so it cannot become a lemma.";
    case "lemma-local-dependency":
      return `This step depends on an object introduced inside the proof, which a lemma cannot generalize. ${preview.message}`;
    case "lemma-target-not-found":
      return "This part of the proof is no longer in the record.";
    default:
      return preview.message;
  }
}

export function existingLabel(existing: ExistingLemmaView): string {
  switch (existing.status) {
    case "approved":
      return "Already saved and approved";
    case "rejected":
      return "Already saved; you rejected it";
    default:
      return "Already saved as a draft; review it in the Library";
  }
}

/** The one-line summary of which hypotheses a lemma keeps. */
export function keptSummary(preview: ReadyLemmaPreview): string {
  const kept = preview.premises.length;
  const dropped = preview.unusedHypotheses.length;
  const keptText =
    kept === 0
      ? "It needs no hypotheses."
      : `It keeps ${kept} hypothes${kept === 1 ? "is" : "es"} the proof used.`;
  const droppedText =
    dropped === 0
      ? ""
      : ` ${dropped} unused hypothes${dropped === 1 ? "is is" : "es are"} left out.`;
  return keptText + droppedText;
}

export type LemmaReviewState =
  | Readonly<{ kind: "not-a-lemma-draft" }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{
      kind: "reviewed";
      decision: "approved" | "rejected" | "changes-requested";
      reviewerId: string;
      notes: string;
      reviewArtifactId: string;
    }>;

/** Whether a library entry is an unreviewed lemma draft, or a draft with its recorded review. */
export function lemmaReviewState(
  artifact: LibraryArtifactView,
  entries: readonly LibraryEntry[],
): LemmaReviewState {
  if (
    artifact.kind !== "result" ||
    artifact.layer !== "derived" ||
    artifact.review !== undefined ||
    artifact.approval.status !== "draft" ||
    artifact.provenance.kind !== "derived"
  ) {
    return { kind: "not-a-lemma-draft" };
  }
  const review = entries.find(({ artifact: other }) => other.review?.reviewOf === artifact.id);
  if (review?.artifact.review === undefined) return { kind: "pending" };
  const { decision, reviewerId, notes } = review.artifact.review;
  return { kind: "reviewed", decision, reviewerId, notes, reviewArtifactId: review.artifact.id };
}
