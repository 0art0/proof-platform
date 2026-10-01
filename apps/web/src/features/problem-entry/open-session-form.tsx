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
      className={styles.fetchForm}
      action="/sessions"
      method="get"
      onSubmit={(event) => {
        const id = new FormData(event.currentTarget).get("id");
        if (typeof id === "string" && id.trim().length > 0) recordRecentSession({ id: id.trim() });
      }}
    >
      <input
        name="id"
        aria-label="Saved proof ID"
        placeholder="session:…"
        required
        pattern="[A-Za-z0-9][A-Za-z0-9._:/\-]*"
      />
      <button type="submit">Resume proof</button>
    </form>
  );
}
