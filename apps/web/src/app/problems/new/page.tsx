import Link from "next/link";
import { ProblemEntryForm, problemEntryStyles as styles } from "../../../features/problem-entry";
import { readAiCapabilities, readProblemSetupOptions } from "../../../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** New problem: manual or AI-assisted entry, review and approval (roadmap N26). */
export default async function NewProblemPage() {
  let options;
  try {
    options = await readProblemSetupOptions();
  } catch {
    options = undefined;
  }
  const capabilities = await readAiCapabilities();
  return (
    <main className={styles.page}>
      <p>
        <Link href="/">← Home</Link>
      </p>
      <h1>New problem</h1>
      <p className={styles.lead}>
        Give the problem a name, then enter what is known and what you want to prove. You can check
        the mathematical setup before starting; your proof session is created only after you approve
        it.
      </p>
      {options === undefined ? (
        <p role="alert" className={styles.warning}>
          The proof service could not be reached.
        </p>
      ) : (
        <ProblemEntryForm
          options={options}
          ai={{
            background: capabilities["background-proposer"],
            formalizer: capabilities["proof-state-formalizer"],
          }}
        />
      )}
    </main>
  );
}
