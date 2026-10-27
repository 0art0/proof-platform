"use client";

import styles from "./problem-entry.module.css";
import { recordRecentSession } from "./recent-sessions";

/**
 * A plain GET form (it works before hydration); once hydrated it also remembers the ID in the
 * recent list. The submit is never intercepted.
 */
export function OpenSessionForm() {
  return (
    <form
      className={styles.cardForm}
      action="/sessions"
      method="get"
      onSubmit={(event) => {
        const id = new FormData(event.currentTarget).get("id");
        if (typeof id === "string" && id.trim().length > 0) recordRecentSession({ id: id.trim() });
      }}
    >
      <label className={styles.label} htmlFor="resume-session-id">
        Saved proof ID
      </label>
      <input
        id="resume-session-id"
        className={styles.idInput}
        name="id"
        placeholder="session:…"
        required
        pattern="[A-Za-z0-9][A-Za-z0-9._:/\-]*"
      />
      <div className={styles.formActions}>
        <button type="submit" className={styles.secondary}>
          Resume proof
        </button>
      </div>
    </form>
  );
}
