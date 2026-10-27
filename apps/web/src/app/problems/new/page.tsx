import Link from "next/link";
import { ProblemEntryForm, problemEntryStyles as styles } from "../../../features/problem-entry";
import { readAiCapabilities, readProblemSetupOptions } from "../../../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * New problem: AI-assisted or manual entry, review and approval (roadmap N26). A statement typed
 * on the landing page arrives as `?statement=`.
 */
export default async function NewProblemPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const { statement } = await searchParams;
  let options;
  try {
    options = await readProblemSetupOptions();
  } catch {
    options = undefined;
  }
  const capabilities = await readAiCapabilities();
  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <Link className={styles.back} href="/">
          ← Home
        </Link>
        <h1 className={styles.pageTitle}>New problem</h1>
        <p className={styles.lead}>
          Type the problem statement. Where AI is available, a background is suggested and the setup
          is drafted for you; otherwise enter what is known and what you want to prove. Your proof
          session is created only after you approve the checked setup.
        </p>
      </header>
      {options === undefined ? (
        <p role="alert" className={styles.error}>
          The proof service could not be reached.
        </p>
      ) : (
        <ProblemEntryForm
          options={options}
          initialStatement={typeof statement === "string" ? statement : ""}
          ai={{
            background: capabilities["background-proposer"],
            library: capabilities.librarian,
            formalizer: capabilities["proof-state-formalizer"],
          }}
        />
      )}
    </main>
  );
}
