import Link from "next/link";
import styles from "./problem-entry.module.css";

/** A not-found page with a way back: the start page (recent sessions live there) and a new problem. */
export function NotFoundView({ title, message }: Readonly<{ title: string; message: string }>) {
  return (
    <main className={styles.page}>
      <h1>{title}</h1>
      <p className={styles.lead}>{message}</p>
      <div className={styles.notFoundLinks}>
        <Link className={styles.primary} href="/">
          Back to the start
        </Link>
        <Link href="/problems/new">Enter a new problem</Link>
      </div>
    </main>
  );
}
