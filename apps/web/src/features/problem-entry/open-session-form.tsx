import styles from "./problem-entry.module.css";

export function OpenSessionForm() {
  return (
    <form className={styles.cardForm} action="/sessions" method="get">
      <label className={styles.label} htmlFor="resume-session-id">
        Saved proof ID
      </label>
      <input
        id="resume-session-id"
        className={styles.idInput}
        name="id"
        placeholder="session:…"
        required
        pattern="\s*[A-Za-z0-9][A-Za-z0-9._:\/\-]*\s*"
      />
      <div className={styles.formActions}>
        <button type="submit" className={styles.secondary}>
          Resume proof
        </button>
      </div>
    </form>
  );
}
