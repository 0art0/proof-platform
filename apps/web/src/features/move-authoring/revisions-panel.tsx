"use client";

import { useId, useState } from "react";
import type { AuthoredMoveRevision, AuthoredMoveSummary, ReviewDecision } from "./api-contract";
import { describeAuthoringFailure, type AuthoringFailureView } from "./diagnostics";
import { authoringCommandId, postReview, reviewEnvelope } from "./requests";
import { DiagnosticList } from "./validation-panel";
import { Help, Hint, WhyDisabled } from "./help";
import styles from "./move-authoring.module.css";

const DECISION_LABELS: Readonly<Record<ReviewDecision, string>> = Object.freeze({
  approved: "Approve",
  rejected: "Reject",
  "changes-requested": "Request changes",
});

const STATUS_LABELS: Readonly<Record<AuthoredMoveRevision["status"], string>> = Object.freeze({
  draft: "Draft, awaiting review",
  approved: "Approved",
  rejected: "Rejected",
  "changes-requested": "Changes requested",
});

/** Approving needs no explanation; rejecting or requesting changes must say why. */
export function reviewNotesRequired(decision: ReviewDecision): boolean {
  return decision !== "approved";
}

export type RevisionsPanelProps = Readonly<{
  /** Number the heading as the last step; false while no draft is being edited above. */
  numbered?: boolean | undefined;
  sessionId: string;
  moves: readonly AuthoredMoveSummary[];
  /** Why drafts cannot be reviewed (a read-only session), if so. */
  disabledReason?: string | undefined;
  /** Load a saved revision's template into the editor to revise it. */
  onRevise: (template: Readonly<Record<string, unknown>>) => void;
  /** A review was recorded: the list must be read again. */
  onReviewed: (message: string) => void;
}>;

/**
 * The session's authored moves: each revision with its status and recorded review, whether the
 * approved version is retrievable, and a review form for revisions still awaiting a decision.
 */
export function RevisionsPanel({
  numbered = true,
  sessionId,
  moves,
  disabledReason,
  onRevise,
  onReviewed,
}: RevisionsPanelProps) {
  return (
    <section className={styles.panel} aria-label="Authored moves">
      <h2>{numbered ? "6. Review and approve" : "Review and approve saved moves"}</h2>
      <Hint>
        A saved draft is never offered as a suggestion. A reviewer approves it, rejects it, or asks
        for changes; the decision and notes are recorded. Only an approved move (one step, or a
        macro of several) appears as a suggestion in the workspace.
      </Hint>
      <Help summary="What happens after approval?">
        <p>
          An approved move is added to this session&apos;s suggestions for matching selections, and
          every use is still checked by the kernel. Approving a changed version replaces the old
          one; earlier previews stay as they were.
        </p>
        <p>
          To change a move, press “Revise in the editor” on a revision, edit, check, and save: that
          makes a new revision.
        </p>
      </Help>
      {moves.length === 0 ? (
        <p className={styles.empty}>
          No move has been saved yet: start one above, check it, and save it as a draft. It will
          appear here for review.
        </p>
      ) : (
        moves.map((move) => (
          <article key={move.moveId} aria-label={`Move ${move.moveId}`} className={styles.revision}>
            <div className={styles.inline}>
              <strong>{move.name}</strong>
              <span className={styles.code}>{move.moveId}</span>
              <span
                className={styles.badge}
                data-retrievable={move.retrievable}
                data-testid={`retrievable-${move.moveId}`}
              >
                {move.retrievable
                  ? "Retrievable: offered as a suggestion"
                  : move.activeArtifactId === undefined
                    ? "Not retrievable: no approved version"
                    : "Approved but not offered as a suggestion"}
              </span>
            </div>
            <ol className={styles.list}>
              {move.revisions.map((revision) => (
                <li key={revision.draftArtifactId} className={styles.revision}>
                  <div className={styles.inline}>
                    <span>Revision {revision.revision}</span>
                    <span className={styles.badge} data-status={revision.status}>
                      {STATUS_LABELS[revision.status]}
                    </span>
                    <span className={styles.muted}>by {revision.authorId}</span>
                    {revision.reviewArtifactId !== undefined &&
                    revision.reviewArtifactId === move.activeArtifactId ? (
                      <span className={styles.badge} data-status="approved">
                        Active version
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => onRevise(revision.template)}
                      aria-label={`Revise revision ${revision.revision} of ${move.moveId} in the editor`}
                    >
                      Revise in the editor
                    </button>
                  </div>
                  <span className={`${styles.muted} ${styles.code}`}>
                    {revision.definitionDigest}
                  </span>
                  {revision.review === undefined ? null : (
                    <p data-testid="recorded-review">
                      {DECISION_LABELS[revision.review.decision]} by {revision.review.reviewerId} on{" "}
                      {revision.review.reviewedAt}
                      {revision.review.notes === "" ? "." : `: “${revision.review.notes}”`}
                    </p>
                  )}
                  {revision.status === "draft" ? (
                    <ReviewForm
                      sessionId={sessionId}
                      revision={revision}
                      moveId={move.moveId}
                      disabledReason={disabledReason}
                      onReviewed={onReviewed}
                    />
                  ) : null}
                </li>
              ))}
            </ol>
          </article>
        ))
      )}
    </section>
  );
}

function ReviewForm({
  sessionId,
  revision,
  moveId,
  disabledReason,
  onReviewed,
}: Readonly<{
  sessionId: string;
  revision: AuthoredMoveRevision;
  moveId: string;
  disabledReason: string | undefined;
  onReviewed: (message: string) => void;
}>) {
  const notesId = useId();
  const [decision, setDecision] = useState<ReviewDecision>("approved");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AuthoringFailureView>();
  const [commandId, setCommandId] = useState(() => authoringCommandId("review"));
  const needsNotes = reviewNotesRequired(decision);
  const reason =
    disabledReason ??
    (needsNotes && notes.trim() === ""
      ? `Say why in the notes before you ${decision === "rejected" ? "reject" : "request changes"}.`
      : undefined);
  const blocked = pending || reason !== undefined;

  const submit = async () => {
    setPending(true);
    setFailure(undefined);
    const outcome = await postReview(
      sessionId,
      reviewEnvelope(commandId, revision.draftArtifactId, decision, notes.trim()),
    );
    setPending(false);
    if (!outcome.ok) {
      setFailure(describeAuthoringFailure(DECISION_LABELS[decision], outcome));
      return;
    }
    setCommandId(authoringCommandId("review"));
    setNotes("");
    onReviewed(
      outcome.result.decision === "approved"
        ? `Approved revision ${revision.revision} of ${moveId}; ${
            outcome.result.retrievable
              ? "it is now offered as a suggestion."
              : "it is stored but cannot be offered as a suggestion."
          }`
        : `${DECISION_LABELS[outcome.result.decision]} recorded for revision ${revision.revision} of ${moveId}.`,
    );
  };

  return (
    <form
      className={styles.reviewForm}
      aria-label={`Review revision ${revision.revision} of ${moveId}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) void submit();
      }}
    >
      <fieldset>
        <legend className={styles.muted}>Decision</legend>
        {(Object.keys(DECISION_LABELS) as ReviewDecision[]).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name={`decision-${revision.draftArtifactId}`}
              value={value}
              checked={decision === value}
              onChange={() => setDecision(value)}
            />{" "}
            {DECISION_LABELS[value]}
          </label>
        ))}
      </fieldset>
      <label htmlFor={notesId}>
        Review notes{needsNotes ? " (required to reject or request changes)" : " (optional)"}
      </label>
      <Hint>
        Example: “Add a negative example where the selection is an atom.” Notes are shown with the
        revision.
      </Hint>
      <textarea id={notesId} value={notes} onChange={(event) => setNotes(event.target.value)} />
      <div className={styles.inline}>
        <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={blocked}>
          {pending ? "Recording…" : `Record: ${DECISION_LABELS[decision]}`}
        </button>
        <WhyDisabled reason={reason} />
      </div>
      {failure === undefined ? null : (
        <div role="alert" data-testid="review-refusal">
          <p className={styles.error}>{failure.message}</p>
          {failure.diagnostics.length === 0 ? null : (
            <DiagnosticList diagnostics={failure.diagnostics} label="Why it was refused" />
          )}
        </div>
      )}
    </form>
  );
}
