import Link from "next/link";
import { ArtifactDownload, ArtifactUpload } from "./artifact-actions";
import { OpenSessionForm } from "./open-session-form";
import { RecentSessionsList } from "./recent-sessions-list";
import styles from "./problem-entry.module.css";

/**
 * The landing page's three actions (design plan §4.1): a new problem, uploading an exported
 * artifact as a read-only session (roadmap N27), and fetching a stored proof by session ID (or
 * downloading it as an artifact).
 */
export function LandingActions({
  developmentSessionId,
}: Readonly<{ developmentSessionId: string }>) {
  return (
    <>
      <RecentSessionsList />
      <div className={styles.actionsGrid}>
        <section className={styles.actionCard} aria-labelledby="action-new-problem">
          <h2 id="action-new-problem">New problem</h2>
          <p>Set out a problem and its assumptions, then explore possible proofs.</p>
          <Link className={styles.primary} href="/problems/new">
            Start a new problem
          </Link>
        </section>

        <section className={styles.actionCard} aria-labelledby="action-upload">
          <h2 id="action-upload">Open a proof file</h2>
          <p>Explore a proof you exported earlier. Imported proofs open in read-only mode.</p>
          <ArtifactUpload />
        </section>

        <section className={styles.actionCard} aria-labelledby="action-fetch">
          <h2 id="action-fetch">Resume a saved proof</h2>
          <p>Enter the ID from a saved proof link to continue exploring it.</p>
          <OpenSessionForm />
          <div className={styles.secondaryActions}>
            <details>
              <summary>Open an example proof</summary>
              <p>Explore a prepared session to see how the workspace works.</p>
              <Link href={`/sessions/${encodeURIComponent(developmentSessionId)}`}>
                Explore the example proof
              </Link>
            </details>
            <details>
              <summary>Download a saved proof</summary>
              <p>Enter its ID to save a portable copy.</p>
              <ArtifactDownload />
            </details>
          </div>
        </section>
      </div>
    </>
  );
}
