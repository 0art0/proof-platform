import { LandingActions, problemEntryStyles as styles } from "../features/problem-entry";
import { configuredProofSessionId } from "../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Landing page (design plan §4.1): new problem, upload artifact, fetch stored proof. */
export default function HomePage() {
  return (
    <main className={`${styles.page} ${styles.landing}`}>
      <header className={styles.heroHeader}>
        <h1 className={styles.heroTitle}>What would you like to prove?</h1>
        <p className={styles.lead}>
          Develop a proof one step at a time and keep a record of the paths you explore.
        </p>
      </header>
      <LandingActions developmentSessionId={configuredProofSessionId()} />
    </main>
  );
}
