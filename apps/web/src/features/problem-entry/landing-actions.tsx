import Link from "next/link";
import { ArtifactDownload, ArtifactUpload } from "./artifact-actions";
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
    <div className={styles.actionsGrid}>
      <section className={styles.actionCard} aria-labelledby="action-new-problem">
        <h2 id="action-new-problem">New problem</h2>
        <p>
          Enter a problem, its background and an initial proof state. Nothing is stored until you
          review and approve it.
        </p>
        <Link className={styles.primary} href="/problems/new">
          Enter a new problem
        </Link>
      </section>

      <section className={styles.actionCard} aria-labelledby="action-upload">
        <h2 id="action-upload">Upload artifact</h2>
        <p>
          Open a previously exported proof artifact. It is revalidated in full and opens as a
          read-only session.
        </p>
        <ArtifactUpload />
      </section>

      <section className={styles.actionCard} aria-labelledby="action-fetch">
        <h2 id="action-fetch">Fetch stored proof</h2>
        <p>Open a stored proof session by its ID.</p>
        <form className={styles.fetchForm} action="/sessions" method="get">
          <input
            name="id"
            aria-label="Session ID"
            placeholder="session:…"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._:/\-]*"
          />
          <button type="submit">Open session</button>
        </form>
        <Link href={`/sessions/${encodeURIComponent(developmentSessionId)}`}>
          Open the development session
        </Link>
        <p>Or download a stored session as a proof artifact.</p>
        <ArtifactDownload />
      </section>
    </div>
  );
}
