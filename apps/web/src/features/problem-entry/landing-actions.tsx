import Link from "next/link";
import styles from "./problem-entry.module.css";

/**
 * The landing page's three actions (design plan §4.1). Upload is not available yet (roadmap
 * N27); fetching a stored proof opens an existing session by ID.
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

      <section className={styles.actionCard} aria-labelledby="action-upload" aria-disabled="true">
        <h2 id="action-upload">Upload artifact</h2>
        <p>Open a previously exported proof artifact. Available in a later version.</p>
        <button type="button" className={styles.secondary} disabled>
          Upload artifact
        </button>
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
      </section>
    </div>
  );
}
