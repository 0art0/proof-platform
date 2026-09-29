import { LandingActions, problemEntryStyles as styles } from "../features/problem-entry";
import { configuredProofSessionId } from "../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Landing page (design plan §4.1): new problem, upload artifact, fetch stored proof. */
export default function HomePage() {
  return (
    <main className={styles.page}>
      <h1>Proof Platform</h1>
      <p className={styles.lead}>Interactive mathematical discovery.</p>
      <LandingActions developmentSessionId={configuredProofSessionId()} />
    </main>
  );
}
