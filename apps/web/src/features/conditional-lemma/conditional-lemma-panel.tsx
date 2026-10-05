"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { WorkspaceView } from "../proof-workspace";
import {
  describeCommandFailure,
  postProtocolCommand,
} from "../stored-proof-workspace/toolbar-requests";
import { READ_ONLY_REASON } from "../stored-proof-workspace/toolbar-actions";
import type { LemmaCandidate, LemmaCandidates, ReadyLemmaPreview } from "./api-contract";
import { RenderedStatement } from "./rendered-statement";
import {
  LEMMA_EXPLANATION,
  existingLabel,
  keptSummary,
  refusalExplanation,
} from "./lemma-view-model";
import { extractLemmaEnvelope, fetchLemmaCandidates, newLemmaCommandId } from "./requests";
import styles from "./conditional-lemma.module.css";

type LoadState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; data: LemmaCandidates }>
  | Readonly<{ kind: "failed"; message: string }>;

type Feedback = Readonly<{ state: "committed" | "rejected"; message: string }>;

export type ConditionalLemmaPanelProps = Readonly<{
  sessionId: string;
  view: WorkspaceView;
  /** The session is an imported artifact: lemmas can be read about but not saved. */
  readOnly: boolean;
  /** Another proof command is running. */
  busy: boolean;
  /** Changes whenever the stored proof history does, so an open list is refreshed. */
  refreshKey: unknown;
}>;

function candidateKey(candidate: Pick<LemmaCandidate, "nodeId" | "target">): string {
  return `${candidate.nodeId}|${candidate.target.kind}|${candidate.target.id}`;
}

/**
 * "Save a finished step as a lemma" (roadmap N44). It lists the steps of the proof that could
 * become lemmas, each with the statement the worker would save and the hypotheses it keeps, or
 * the reason it cannot be saved yet. Saving records a draft; the Library's review makes it
 * available. The list loads only when the person opens it, and nothing opens on its own.
 */
export function ConditionalLemmaPanel({
  sessionId,
  view,
  readOnly,
  busy,
  refreshKey,
}: ConditionalLemmaPanelProps) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const [expanded, setExpanded] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [reload, setReload] = useState(0);
  const pendingIds = useRef(new Map<string, string>());

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoad((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void fetchLemmaCandidates(sessionId, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      setLoad(
        outcome.ok
          ? { kind: "ready", data: outcome.value }
          : { kind: "failed", message: outcome.message },
      );
    });
    return () => controller.abort();
  }, [open, sessionId, refreshKey, reload]);

  const save = useCallback(
    async (candidate: LemmaCandidate) => {
      const key = candidateKey(candidate);
      const commandId = pendingIds.current.get(key) ?? newLemmaCommandId("save");
      pendingIds.current.set(key, commandId);
      setSaving(key);
      setFeedback(undefined);
      const outcome = await postProtocolCommand(
        sessionId,
        extractLemmaEnvelope(commandId, candidate.nodeId, candidate.target),
      );
      setSaving(undefined);
      if (!outcome.ok) {
        setFeedback({
          state: "rejected",
          message: describeCommandFailure("Saving the lemma", outcome),
        });
        return;
      }
      pendingIds.current.delete(key);
      setExpanded(undefined);
      setFeedback({
        state: "committed",
        message:
          "Saved as a draft lemma. Open the Library to review it: it is offered as a suggestion only after you approve it.",
      });
      setReload((count) => count + 1);
    },
    [sessionId],
  );

  const candidates = load.kind === "ready" ? load.data.candidates : [];
  const saveable = candidates.filter(
    ({ preview }) => preview.status === "ready" && preview.existing.length === 0,
  ).length;

  return (
    <section className={styles.panel} aria-label="Save a lemma" data-testid="lemma-panel">
      <div className={styles.heading}>
        <h2>Save a finished step as a lemma</h2>
        <p className={styles.meta}>{LEMMA_EXPLANATION}</p>
      </div>
      <details
        className={styles.collapse}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          {open
            ? "Hide the steps"
            : "Show the steps you could save (finished steps can be previewed first)"}
        </summary>
        {load.kind === "loading" ? (
          <p className={styles.status} role="status">
            Looking for finished steps…
          </p>
        ) : null}
        {load.kind === "failed" ? (
          <p className={styles.error} role="alert">
            The steps could not be loaded: {load.message}
          </p>
        ) : null}
        {load.kind === "ready" ? (
          candidates.length === 0 ? (
            <p className={styles.empty}>
              No steps yet. Apply a few proof steps; a step you finish can then be saved here.
            </p>
          ) : (
            <>
              <p className={styles.meta} role="status">
                {saveable} of {candidates.length} step{candidates.length === 1 ? "" : "s"} can be
                saved now.
              </p>
              <ul className={styles.list}>
                {candidates.map((candidate) => (
                  <CandidateItem
                    key={candidateKey(candidate)}
                    candidate={candidate}
                    view={view}
                    readOnly={readOnly || load.data.readOnly}
                    busy={busy || saving !== undefined}
                    saving={saving === candidateKey(candidate)}
                    expanded={expanded === candidateKey(candidate)}
                    onToggle={() =>
                      setExpanded(
                        expanded === candidateKey(candidate) ? undefined : candidateKey(candidate),
                      )
                    }
                    onSave={() => void save(candidate)}
                  />
                ))}
              </ul>
            </>
          )
        ) : null}
      </details>
      {feedback === undefined ? null : (
        <p
          className={feedback.state === "rejected" ? styles.error : styles.status}
          role={feedback.state === "rejected" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      )}
    </section>
  );
}

function CandidateItem({
  candidate,
  view,
  readOnly,
  busy,
  saving,
  expanded,
  onToggle,
  onSave,
}: Readonly<{
  candidate: LemmaCandidate;
  view: WorkspaceView;
  readOnly: boolean;
  busy: boolean;
  saving: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSave: () => void;
}>) {
  const reasonId = useId();
  const { preview } = candidate;
  const existing = preview.status === "ready" ? preview.existing[0] : undefined;
  return (
    <li
      className={styles.item}
      data-lemma-node={candidate.nodeId}
      data-lemma-status={preview.status}
    >
      <div className={styles.itemHeader}>
        <span>
          Step proving <RenderedStatement statement={candidate.goal} view={view} />
        </span>
        {preview.status === "ready" && existing === undefined ? (
          <span className={styles.action}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={onToggle}
              disabled={busy}
              aria-label={`${expanded ? "Hide" : "Preview"} the lemma for ${candidate.goal.latex}`}
            >
              {expanded ? "Hide preview" : "Preview as a lemma"}
            </button>
          </span>
        ) : (
          <span className={styles.action}>
            <button type="button" disabled aria-describedby={reasonId}>
              Save as a lemma
            </button>
            <span id={reasonId} className={styles.reason}>
              {existing !== undefined
                ? existingLabel(existing)
                : preview.status === "refused"
                  ? refusalExplanation(preview)
                  : ""}
            </span>
          </span>
        )}
      </div>
      {preview.status === "ready" && existing === undefined && expanded ? (
        <LemmaPreviewDetails
          preview={preview}
          view={view}
          readOnly={readOnly}
          busy={busy}
          saving={saving}
          onSave={onSave}
        />
      ) : null}
    </li>
  );
}

function LemmaPreviewDetails({
  preview,
  view,
  readOnly,
  busy,
  saving,
  onSave,
}: Readonly<{
  preview: ReadyLemmaPreview;
  view: WorkspaceView;
  readOnly: boolean;
  busy: boolean;
  saving: boolean;
  onSave: () => void;
}>) {
  const reasonId = useId();
  return (
    <div className={styles.preview} data-testid="lemma-preview">
      <p>This lemma says:</p>
      <p className={styles.statement} data-lemma-statement>
        <RenderedStatement statement={preview.statement} view={view} />
      </p>
      <p className={styles.meta}>{keptSummary(preview)}</p>
      {preview.premises.length === 0 ? null : (
        <div>
          <h3>Hypotheses it keeps (the proof used them)</h3>
          <ul className={styles.hypotheses} data-kept>
            {preview.premises.map((premise) => (
              <li key={premise.id}>
                <RenderedStatement statement={premise} view={view} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.unusedHypotheses.length === 0 ? null : (
        <div className={styles.unused}>
          <h3>Left out (never used by the proof)</h3>
          <ul className={styles.hypotheses} data-unused>
            {preview.unusedHypotheses.map((hypothesis) => (
              <li key={hypothesis.id}>
                <RenderedStatement statement={hypothesis} view={view} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.conservative.length === 0 ? null : (
        <p className={styles.meta} data-conservative>
          Every hypothesis is kept to be safe:{" "}
          {preview.conservative.map(({ reason }) => reason).join("; ")}.
        </p>
      )}
      {preview.backgroundInferences === 0 ? null : (
        <p className={styles.meta}>
          This step relies on {preview.backgroundInferences} accepted background inference
          {preview.backgroundInferences === 1 ? "" : "s"}, which the lemma inherits.
        </p>
      )}
      <span className={styles.action}>
        <button
          type="button"
          disabled={readOnly || busy}
          {...(readOnly ? { "aria-describedby": reasonId } : {})}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save as a lemma"}
        </button>
        {readOnly ? (
          <span id={reasonId} className={styles.reason}>
            {READ_ONLY_REASON}
          </span>
        ) : (
          <span className={styles.reason}>
            This saves a draft. It is not offered as a suggestion until you approve it in the
            Library.
          </span>
        )}
      </span>
    </div>
  );
}
