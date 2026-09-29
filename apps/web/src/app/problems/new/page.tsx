import Link from "next/link";
import { ProblemEntryForm, problemEntryStyles as styles } from "../../../features/problem-entry";
import { readProblemSetupOptions } from "../../../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** New problem: manual entry, review and approval (roadmap N26). */
export default async function NewProblemPage() {
  let options;
  try {
    options = await readProblemSetupOptions();
  } catch {
    options = undefined;
  }
  return (
    <main className={styles.page}>
      <p>
        <Link href="/">← Back</Link>
      </p>
      <h1>New problem</h1>
      <p className={styles.lead}>
        State the problem and its background, choose library layers and packs, and enter the initial
        proof state. Declarations take their sort from a menu; hypotheses and goals are LaTeX or
        MathJSON.
      </p>
      {options === undefined ? (
        <p role="alert" className={styles.warning}>
          The proof service could not be reached.
        </p>
      ) : (
        <ProblemEntryForm options={options} />
      )}
    </main>
  );
}
