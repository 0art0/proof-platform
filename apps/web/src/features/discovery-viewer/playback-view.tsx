"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import type { ProofArtifact } from "@proof/protocol";
import type { WorkspaceView } from "../proof-workspace";
import { usePresentation } from "../proof-workspace/presentation";
import { indexArtifact } from "./artifact-data";
import styles from "./discovery-viewer.module.css";
import { InquiryRecordExplanation, useInquiryExplanations } from "./inquiry-record-item";
import {
  PLAYBACK_KIND_LABELS,
  buildPlaybackTimeline,
  type PlaybackEntry,
} from "./playback-timeline";
import { StateSnapshotView, ViewToggle } from "./statement-views";
import { humanizeMoveId } from "../macro-labels";
import { ViewerShell } from "./viewer-shell";

function EntryDetail({
  entry,
  artifact,
  explain,
}: Readonly<{
  entry: PlaybackEntry;
  artifact: ProofArtifact;
  explain: ReturnType<typeof useInquiryExplanations>;
}>) {
  if (entry.kind === "transition") {
    const { edge } = entry;
    return (
      <>
        <p>{edge.label}</p>
        {edge.macro === undefined || edge.moveId === undefined ? null : (
          <p className={styles.muted}>
            One step of a multi-step move; this step applies {humanizeMoveId(edge.moveId)}.
          </p>
        )}
        <details className={styles.technicalDetails}>
          <summary>Recorded step details</summary>
          <dl className={styles.facts} aria-label="Transition">
            <dt>Operation</dt>
            <dd>
              <code>{edge.operationKind}</code>
            </dd>
            <dt>Transition class</dt>
            <dd>{edge.transitionClass}</dd>
            <dt>From node</dt>
            <dd>
              <code>{edge.parentNodeId}</code>
            </dd>
            <dt>To node</dt>
            <dd>
              <code>{edge.childNodeId}</code>
            </dd>
          </dl>
        </details>
      </>
    );
  }
  if (entry.kind === "inquiry") {
    return <InquiryRecordExplanation record={entry.record} explain={explain} />;
  }
  const { event } = entry;
  const set =
    "suggestionSetId" in event
      ? artifact.tree.suggestionSets.find(({ id }) => id === event.suggestionSetId)
      : undefined;
  const displayed =
    event.kind === "suggestions-displayed" && set !== undefined
      ? event.suggestionIds.flatMap((id) =>
          set.suggestions.filter((suggestion) => suggestion.id === id),
        )
      : [];
  return (
    <>
      <p>
        Recorded by <code>{event.actor.id}</code> ({event.actor.kind}) at{" "}
        <time dateTime={event.recordedAt}>{event.recordedAt}</time>.
      </p>
      {event.kind === "suggestions-displayed" ? (
        <>
          <p>
            Displayed from stored suggestion set <code>{event.suggestionSetId}</code>, in this
            order:
          </p>
          <ol aria-label="Displayed suggestions" data-testid="displayed-suggestions">
            {displayed.map((suggestion) => (
              <li key={suggestion.id} data-suggestion-id={suggestion.id}>
                {suggestion.name}
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <details>
        <summary>Stored event payload</summary>
        <pre>{JSON.stringify(event, null, 2)}</pre>
      </details>
    </>
  );
}

/** Step-by-step playback over the stored transitions, interaction events and inquiry records. */
export function PlaybackView({ artifact }: Readonly<{ artifact: ProofArtifact }>) {
  const timeline = useMemo(() => buildPlaybackTimeline(artifact), [artifact]);
  const index = useMemo(() => indexArtifact(artifact), [artifact]);
  const presentation = usePresentation(artifact.initialState.operators);
  const explain = useInquiryExplanations(artifact);
  const [view, setView] = useState<WorkspaceView>("formal");
  const total = timeline.entries.length;
  const [position, setPosition] = useState(0);
  const at = Math.min(position, Math.max(0, total - 1));
  const entry = timeline.entries[at];
  const node = entry === undefined ? undefined : index.nodes.get(entry.nodeId);

  const go = (target: number) => setPosition(Math.min(total - 1, Math.max(0, target)));
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const keys: Readonly<Record<string, number>> = {
      ArrowRight: at + 1,
      ArrowLeft: at - 1,
      Home: 0,
      End: total - 1,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    go(next);
  };

  return (
    <ViewerShell artifact={artifact} active="playback">
      <details className={styles.technicalDetails} data-testid="playback-order-note">
        <summary>How this playback is ordered</summary>
        <p>
          {timeline.counts.transitions} proof steps, {timeline.counts.interactions} interaction
          events and {timeline.counts.inquiries} inquiry records. Transitions carry no timestamp, so
          they are played in causal order (parents before children); interaction events and inquiry
          records follow the step they belong to, by recorded time.
        </p>
      </details>
      <div className={styles.toolbarRow}>
        <ViewToggle view={view} onChange={setView} />
      </div>
      {entry === undefined ? (
        <p>The stored history has nothing to play back.</p>
      ) : (
        <section
          className={styles.playback}
          aria-label="Playback"
          onKeyDown={onKeyDown}
          data-testid="playback"
        >
          <div className={styles.controls} role="group" aria-label="Step controls">
            <button type="button" onClick={() => go(0)} disabled={at === 0}>
              First
            </button>
            <button type="button" onClick={() => go(at - 1)} disabled={at === 0}>
              Previous
            </button>
            <button type="button" onClick={() => go(at + 1)} disabled={at === total - 1}>
              Next
            </button>
            <button type="button" onClick={() => go(total - 1)} disabled={at === total - 1}>
              Last
            </button>
            <span aria-live="polite" data-testid="step-status">
              Step {at + 1} of {total}
            </span>
            <span className={styles.muted}>Keyboard: left and right arrows, Home, End.</span>
          </div>
          <div className={styles.treeLayout}>
            <nav aria-label="Playback steps" className={styles.outline}>
              <ol data-testid="step-list">
                {timeline.entries.map((item, itemIndex) => (
                  <li key={item.key} data-kind={item.kind}>
                    <button
                      type="button"
                      aria-current={itemIndex === at ? "step" : undefined}
                      onClick={() => go(itemIndex)}
                    >
                      <span className={styles.chip}>{PLAYBACK_KIND_LABELS[item.kind]}</span>{" "}
                      {item.title}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            <section className={styles.detail} aria-label="Step detail" data-testid="step-detail">
              <h2>
                {PLAYBACK_KIND_LABELS[entry.kind]}: {entry.title}
              </h2>
              <EntryDetail entry={entry} artifact={artifact} explain={explain} />
              <h3>Proof state at this point</h3>
              {node === undefined ? (
                <p>This node is not retained in the artifact.</p>
              ) : (
                <StateSnapshotView state={node.state} presentation={presentation} view={view} />
              )}
            </section>
          </div>
        </section>
      )}
    </ViewerShell>
  );
}
