import Link from "next/link";
import { ArtifactDownload, ArtifactUpload } from "./artifact-actions";
import { OpenSessionForm } from "./open-session-form";
import { RecentSessionsList } from "./recent-sessions-list";
import styles from "./problem-entry.module.css";

/**
 * The landing page (design plan §4.1): the problem statement first and large, since entering a
 * problem is what most visits are for. Opening an exported proof file, resuming a saved proof by
 * its ID, and the example proof sit quietly below it, then the proofs opened lately.
 */
export function LandingActions({
  developmentSessionId,
}: Readonly<{ developmentSessionId: string }>) {
  return (
    <>
      {/* A plain GET form, so it works before hydration. */}
      <form className={styles.heroForm} action="/problems/new" method="get">
        <label className="visually-hidden" htmlFor="landing-statement">
          Problem statement
        </label>
        <textarea
          id="landing-statement"
          className={styles.heroInput}
          name="statement"
          aria-label="New problem statement"
          placeholder="Show that any two consecutive integers are coprime."
          rows={4}
          required
          autoFocus
        />
        <div className={styles.heroFooter}>
          <details className={styles.titleDisclosure}>
            <summary className={styles.quietButton}>+ Add title</summary>
            <input
              className={styles.titleInput}
              name="title"
              aria-label="Title"
              placeholder="Title"
              maxLength={200}
            />
          </details>
          <button type="submit" className={styles.primary}>
            Start a new problem
          </button>
        </div>
      </form>

      <nav className={styles.otherWays} aria-label="Other ways to begin">
        <ArtifactUpload />
        <details className={styles.inlineDisclosure}>
          <summary className={styles.quietLink}>Resume a saved proof</summary>
          <div className={styles.inlineDisclosureBody}>
            <OpenSessionForm />
            <details>
              <summary className={styles.quietLink}>Download a saved proof</summary>
              <ArtifactDownload />
            </details>
          </div>
        </details>
        <Link
          className={styles.quietLink}
          href={`/sessions/${encodeURIComponent(developmentSessionId)}`}
        >
          Explore an example
        </Link>
      </nav>

      <RecentSessionsList />
    </>
  );
}
