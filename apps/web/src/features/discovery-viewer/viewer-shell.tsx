import Link from "next/link";
import type { ReactNode } from "react";
import type { ProofArtifact } from "@proof/protocol";
import styles from "./discovery-viewer.module.css";

export type ViewerKind = "tree" | "playback" | "proof";

const VIEWS: readonly Readonly<{ kind: ViewerKind; label: string }>[] = [
  { kind: "tree", label: "Discovery tree" },
  { kind: "playback", label: "Playback" },
  { kind: "proof", label: "Pruned proof" },
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
  const activeLabel = VIEWS.find(({ kind }) => kind === active)?.label ?? "";
  return (
    <div className={styles.viewer}>
      <header className={styles.viewerHeader}>
        <p className={styles.eyebrow}>Stored proof history · {activeLabel}</p>
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
          <span>
            Session <code>{sessionId}</code>
          </span>
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
        <p className={styles.muted}>
          These views read only the stored history: snapshots, displayed suggestion sets, edges and
          records. Nothing on this page is recomputed.
        </p>
      </header>
      {children}
    </div>
  );
}
