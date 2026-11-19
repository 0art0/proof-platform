import Link from "next/link";
import {
  GuidedProblemEntry,
  ProblemEntryForm,
  problemEntryStyles as styles,
} from "../../../features/problem-entry";
import {
  readAiCapabilities,
  readAiPrompts,
  readProblemSetupOptions,
} from "../../../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * New problem. With a background proposer configured the entry is guided: the statement is all a
 * person types, and the background, library and setup are proposed for them to edit and start.
 * Without one, the setup is entered by hand. A statement and title typed on the landing page
 * arrive as `?statement=` and `?title=`.
 */
export default async function NewProblemPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const { statement, title } = await searchParams;
  let options;
  try {
    options = await readProblemSetupOptions();
  } catch {
    options = undefined;
  }
  const [capabilities, prompts] = await Promise.all([readAiCapabilities(), readAiPrompts()]);
  const initialStatement = typeof statement === "string" ? statement : "";
  const initialTitle = typeof title === "string" ? title : "";
  return (
    <main className={`${styles.page} ${styles.entryPage}`}>
      <header className={styles.pageHeader}>
        <Link className={styles.back} href="/">
          ← Home
        </Link>
        <h1 className={styles.pageTitle}>New problem</h1>
      </header>
      {options === undefined ? (
        <p role="alert" className={styles.error}>
          The proof service could not be reached.
        </p>
      ) : capabilities["background-proposer"] ? (
        <GuidedProblemEntry
          options={options}
          capabilities={{
            library: capabilities.librarian,
            formalizer: capabilities["proof-state-formalizer"],
          }}
          prompts={{ background: prompts.background, library: prompts.library }}
          initialStatement={initialStatement}
          initialTitle={initialTitle}
        />
      ) : (
        <ProblemEntryForm
          options={options}
          initialStatement={initialStatement}
          initialTitle={initialTitle}
        />
      )}
    </main>
  );
}
