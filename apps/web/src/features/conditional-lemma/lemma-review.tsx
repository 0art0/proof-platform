"use client";

import { useId, useState } from "react";
import { READ_ONLY_REASON } from "../stored-proof-workspace/toolbar-actions";
import type { LibraryArtifactView, LibraryEntry } from "../library-drawer/api-contract";
import { lemmaReviewState } from "./lemma-view-model";
import type { LemmaReviewDecision } from "./requests";
import styles from "./conditional-lemma.module.css";

export type LemmaReviewHandler = (
  draftArtifactId: string,
  decision: LemmaReviewDecision,
  notes: string,
) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>>;

/**
 * The review of a saved lemma draft, shown in the library drawer's detail view: approve (it is
 * then offered as a suggestion) or reject with notes (kept as a record, never offered). Once
 * decided, the recorded decision is shown instead.
 */
export function LemmaReviewSection({
  artifact,
  entries,
  readOnly,
  onReview,
}: Readonly<{
  artifact: LibraryArtifactView;
  entries: readonly LibraryEntry[];
  readOnly: boolean;
  onReview: LemmaReviewHandler;
}>) {
  const state = lemmaReviewState(artifact, entries);
  if (state.kind === "not-a-lemma-draft") {
    return artifact.review === undefined ? null : <RecordedReview review={artifact.review} />;
  }
  if (state.kind === "reviewed") {
    return (
      <section
        className={styles.reviewSection}
        aria-label="Lemma review"
        data-review-state="reviewed"
      >
        <h5>Review</h5>
        <p>
          {state.decision === "approved"
            ? "You approved this lemma; the approved copy is offered as a suggestion."
            : "This lemma was rejected and is not offered as a suggestion."}
        </p>
        {state.notes.length === 0 ? null : <p className={styles.meta}>Notes: {state.notes}</p>}
      </section>
    );
  }
  return <PendingReview artifact={artifact} readOnly={readOnly} onReview={onReview} />;
}

function RecordedReview({
  review,
}: Readonly<{ review: NonNullable<LibraryArtifactView["review"]> }>) {
  return (
    <section className={styles.reviewSection} aria-label="Lemma review" data-review-state="record">
      <h5>Review</h5>
      <p>
        {review.decision === "approved" ? "Approved" : "Rejected"} by {review.reviewerId}.
        {review.decision === "approved"
          ? " This lemma is offered as a suggestion in this proof."
          : " It is kept as a record and never offered."}
      </p>
      {review.notes.length === 0 ? null : <p className={styles.meta}>Notes: {review.notes}</p>}
    </section>
  );
}

function PendingReview({
  artifact,
  readOnly,
  onReview,
}: Readonly<{
  artifact: LibraryArtifactView;
  readOnly: boolean;
  onReview: LemmaReviewHandler;
}>) {
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const notesId = useId();
  const reasonId = useId();
  const needsNotes = notes.trim().length === 0;

  const decide = async (decision: LemmaReviewDecision) => {
    setPending(true);
    setError(undefined);
    const outcome = await onReview(artifact.id, decision, notes);
    setPending(false);
    if (!outcome.ok) setError(outcome.message);
  };

  return (
    <section className={styles.reviewSection} aria-label="Lemma review" data-review-state="pending">
      <h5>Review this lemma</h5>
      <p className={styles.meta}>
        This is a draft saved from your proof. Approve it to have it offered as a suggestion here;
        reject it to keep a record without ever offering it.
      </p>
      <label htmlFor={notesId}>Notes (required to reject)</label>
      <textarea id={notesId} value={notes} onChange={(event) => setNotes(event.target.value)} />
      <div className={styles.buttons}>
        <button
          type="button"
          disabled={readOnly || pending}
          {...(readOnly ? { "aria-describedby": reasonId } : {})}
          onClick={() => void decide("approved")}
        >
          Approve lemma
        </button>
        <button
          type="button"
          disabled={readOnly || pending || needsNotes}
          aria-describedby={reasonId}
          onClick={() => void decide("rejected")}
        >
          Reject lemma
        </button>
      </div>
      <span id={reasonId} className={styles.reason}>
        {readOnly
          ? READ_ONLY_REASON
          : needsNotes
            ? "Add a note to enable rejecting."
            : "Your decision is recorded with these notes."}
      </span>
      {error === undefined ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
