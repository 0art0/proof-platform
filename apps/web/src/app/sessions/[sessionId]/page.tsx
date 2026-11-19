import { notFound } from "next/navigation";
import { StoredProofWorkspace } from "../../../features/stored-proof-workspace";
import styles from "./page.module.css";
import {
  ProofServiceError,
  readAiCapabilities,
  readAiPrompts,
  readCurrentProofSession,
  readProofSessionMetadata,
} from "../../../server/proof-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** One stored proof session in the workspace. */
export default async function SessionPage({
  params,
}: Readonly<{ params: Promise<{ sessionId: string }> }>) {
  const { sessionId } = await params;
  let loaded;
  try {
    loaded = await readCurrentProofSession(decodedSegment(sessionId));
  } catch (error) {
    if (
      error instanceof ProofServiceError &&
      (error.status === 404 || error.code === "invalid_request")
    ) {
      notFound();
    }
    throw error;
  }
  const [metadata, capabilities, prompts] = await Promise.all([
    readProofSessionMetadata(loaded.session.id),
    readAiCapabilities(),
    readAiPrompts(),
  ]);
  // A name the person gave the session comes first; the approved problem title is the fallback.
  const session =
    metadata === undefined
      ? loaded.session
      : {
          ...loaded.session,
          title: loaded.session.title ?? metadata.problem.title,
          problemTitle: metadata.problem.title,
          statement: metadata.problem.statement,
          background: metadata.background.summary,
        };
  return (
    <main className={styles.workspacePage}>
      <StoredProofWorkspace
        session={session}
        node={loaded.node}
        aiShortlist={capabilities["move-shortlister"]}
        aiExecutor={capabilities["move-executor"]}
        aiLibrarian={capabilities.librarian}
        aiMoveAuthor={capabilities["move-author"]}
        aiDraft={capabilities["proof-draft"]}
        aiPlanner={capabilities["proof-planner"]}
        aiTranslator={capabilities["step-translator"]}
        draftPrompt={prompts.proofDraft}
        blueprintPrompt={prompts.proofPlanner}
      />
    </main>
  );
}

/** Session IDs never contain `%`, so decoding an already decoded segment is harmless. */
function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
