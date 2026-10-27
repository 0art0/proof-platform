import { LandingActions, problemEntryStyles as styles } from "../features/problem-entry";
import { configuredProofSessionId } from "../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Landing page (design plan §4.1): new problem, upload artifact, fetch stored proof. */
export default function HomePage() {
  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>Proof Platform</p>
        <h1>Explore a proof, or begin a new one.</h1>
        <p className={styles.lead}>
          Describe a problem, open an exported proof, or pick up where you left off.
        </p>
      </header>
      <LandingActions developmentSessionId={configuredProofSessionId()} />
    </main>
  );
}
