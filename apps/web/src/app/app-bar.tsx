import styles from "./app-bar.module.css";

/** The one header shared by every page: the wordmark home link and the global entry points. */
export function AppBar() {
  return (
    <header className={styles.bar}>
      <div className={styles.inner}>
        <a className={styles.wordmark} href="/">
          <span className={styles.mark} aria-hidden="true">
            ⊢
          </span>
          Proof Platform
        </a>
        <nav className={styles.nav} aria-label="Site">
          <a href="/problems/new">New problem</a>
        </nav>
      </div>
    </header>
  );
}
