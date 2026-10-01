import Link from "next/link";
import type { ReactNode } from "react";
import type { ProofArtifact } from "@proof/protocol";
import styles from "./discovery-viewer.module.css";

export type ViewerKind = "tree" | "playback" | "proof";

const VIEWS: readonly Readonly<{ kind: ViewerKind; label: string; description: string }>[] = [
  {
    kind: "tree",
    label: "Discovery tree",
    description: "Explore every route tried, including branches set aside along the way.",
  },
  {
    kind: "playback",
    label: "Playback",
    description: "Follow the recorded choices and proof steps in order.",
  },
  {
    kind: "proof",
    label: "Pruned proof",
    description: "Read the successful argument and see any assumptions it depends on.",
  },
];

/** The route of one static viewer of a session. */
export function viewerHref(sessionId: string, kind: ViewerKind): string {
  return `/sessions/${encodeURIComponent(sessionId)}/${kind}`;
}

/** The shared frame of the static viewers: title, status, and links between the three views. */
export function ViewerShell({
  artifact,
  active,
  children,
}: Readonly<{ artifact: ProofArtifact; active: ViewerKind; children: ReactNode }>) {
  const sessionId = artifact.sessionId;
  const title = artifact.problemSetup.metadata?.problem.title ?? sessionId;
  const activeView = VIEWS.find(({ kind }) => kind === active);
  return (
    <div className={styles.viewer}>
      <header className={styles.viewerHeader}>
        <p className={styles.eyebrow}>Proof history</p>
        <h1>{title}</h1>
        <p className={styles.headerFacts}>
          <span data-testid="solved-status" data-solved={artifact.final.solved}>
            <span aria-hidden="true">{artifact.final.solved ? "✓ " : "○ "}</span>
            {artifact.final.solved ? "Solved" : "Not solved"}
          </span>
          {artifact.provenance.kind === "import" ? (
            <span data-testid="read-only-note">
              <span aria-hidden="true">🔒 </span>Imported, read-only session
            </span>
          ) : null}
        </p>
        <nav aria-label="Stored views" className={styles.viewerNav}>
          <Link href={`/sessions/${encodeURIComponent(sessionId)}`}>Back to the workspace</Link>
          {VIEWS.map((view) => (
            <Link
              key={view.kind}
              href={viewerHref(sessionId, view.kind)}
              aria-current={view.kind === active ? "page" : undefined}
            >
              {view.label}
            </Link>
          ))}
        </nav>
        <p className={styles.viewDescription}>{activeView?.description}</p>
        <details className={styles.technicalDetails}>
          <summary>About this record</summary>
          <p>
            Session <code>{sessionId}</code>. These views show stored snapshots, suggestions and
            decisions; they do not recalculate the history.
          </p>
        </details>
      </header>
      {children}
    </div>
  );
}
