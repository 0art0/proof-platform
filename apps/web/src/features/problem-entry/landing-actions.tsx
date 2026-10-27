import Link from "next/link";
import { ArtifactDownload, ArtifactUpload } from "./artifact-actions";
import { OpenSessionForm } from "./open-session-form";
import { RecentSessionsList } from "./recent-sessions-list";
import styles from "./problem-entry.module.css";

/**
 * The landing page's three actions (design plan §4.1): a new problem, uploading an exported
 * artifact as a read-only session (roadmap N27), and fetching a stored proof by session ID (or
 * downloading it as an artifact). Recent proofs follow below the actions.
 */
export function LandingActions({
  developmentSessionId,
}: Readonly<{ developmentSessionId: string }>) {
  return (
    <>
      <section className={styles.newProblemCard} aria-labelledby="action-new-problem">
        <div className={styles.cardHeader}>
          <h2 id="action-new-problem">New problem</h2>
          <p className={styles.hint}>
            Type the statement. A background is suggested for you, and the setup is drafted once you
            accept it.
          </p>
        </div>
        {/* A plain GET form, so it works before hydration. */}
        <form className={styles.statementForm} action="/problems/new" method="get">
          <label className={styles.label} htmlFor="landing-statement">
            Problem statement
          </label>
          <textarea
            id="landing-statement"
            name="statement"
            aria-label="New problem statement"
            placeholder="e.g. Show that any two consecutive integers are coprime."
            rows={3}
            required
          />
          <div className={styles.formActions}>
            <button type="submit" className={styles.primary}>
              Start a new problem
            </button>
          </div>
        </form>
      </section>

      <div className={styles.otherWays}>
        <section className={styles.actionCard} aria-labelledby="action-upload">
          <div className={styles.cardHeader}>
            <h2 id="action-upload">Open a proof file</h2>
            <p className={styles.hint}>
              Explore a proof you exported earlier. Imported proofs open in read-only mode.
            </p>
          </div>
          <ArtifactUpload />
          <details className={styles.cardMore}>
            <summary className={styles.disclosure}>Open an example proof</summary>
            <div className={styles.moreBody}>
              <p className={styles.hint}>
                Explore a prepared session to see how the workspace works.
              </p>
              <Link
                className={`${styles.secondary} ${styles.small}`}
                href={`/sessions/${encodeURIComponent(developmentSessionId)}`}
              >
                Explore the example proof
              </Link>
            </div>
          </details>
        </section>

        <section className={styles.actionCard} aria-labelledby="action-fetch">
          <div className={styles.cardHeader}>
            <h2 id="action-fetch">Resume a saved proof</h2>
            <p className={styles.hint}>
              Enter the ID from a saved proof link to continue exploring it.
            </p>
          </div>
          <OpenSessionForm />
          <details className={styles.cardMore}>
            <summary className={styles.disclosure}>Download a saved proof</summary>
            <div className={styles.moreBody}>
              <p className={styles.hint}>Enter its ID to save a portable copy.</p>
              <ArtifactDownload />
            </div>
          </details>
        </section>
      </div>

      <RecentSessionsList />
    </>
  );
}
