/**
 * The initial library a person approved (`docs/ai-agents-architecture.md` section 2).
 *
 * A person keeps results of a librarian proposal by recording a library decision on the stored
 * call. Everything downstream (the formalizer, the setup check, the session approval) names that
 * decision and lets the worker resolve the results from storage: the decision names result IDs,
 * the artifacts come from the stored call and the admission gate runs again, so a client never
 * supplies mathematics of its own.
 *
 * Approved results reach a new session as library additions in `layer:initial-problem`, origin
 * `setup`. The session and the additions cannot share one transaction (the proof store and the
 * library store expose separate transaction interfaces, and in PostgreSQL run on separate pool
 * connections), so `recordInitialLibrary` is idempotent instead: each addition has a
 * deterministic event ID derived from the session, the decision and the artifact, and a time
 * fixed by the decision. The session approval runs it for a new session and again for a replay
 * of the same approval, so an interrupted run is finished by repeating the request.
 */
import { MAX_FORMALIZER_LIBRARY_RESULTS } from "@proof/llm";
import type { LibraryPack, LibraryResult } from "@proof/library";
import { stableIdentifierSchema } from "@proof/protocol";
import { z } from "zod";
import {
  readLibraryProposalDecision,
  type LlmCallStore,
  type LlmCallRepositoryDiagnosticCode,
} from "./llm-call-repository";
import { addLibraryArtifact, type LibraryStore } from "./library-repository";
import {
  evaluateLibraryProposal,
  selectApprovedResults,
  type ApprovedInitialLibrary,
} from "./library-proposal";

/** Names an approved library decision of the request's own construction (formalizer). */
export const approvedLibraryReferenceSchema = z
  .object({ decisionId: stableIdentifierSchema })
  .strict();

/** Names an approved library decision of a construction (setup check and session approval). */
export const constructionApprovedLibrarySchema = z
  .object({ constructionId: stableIdentifierSchema, decisionId: stableIdentifierSchema })
  .strict();

export type LoadedApprovedLibrary =
  | Readonly<{ ok: true; library: ApprovedInitialLibrary }>
  | Readonly<{
      ok: false;
      status: 400 | 404 | 409 | 503;
      diagnostics: readonly [Readonly<{ code: string; message: string }>];
    }>;

/** Resolve an approved library decision from storage, re-running the deterministic gate. */
export async function loadApprovedLibrary(
  llmCalls: LlmCallStore | undefined,
  constructionId: string,
  decisionId: string,
): Promise<LoadedApprovedLibrary> {
  if (llmCalls === undefined) {
    return {
      ok: false,
      status: 503,
      diagnostics: [{ code: "ai-disabled", message: "LLM evidence storage is unavailable." }],
    };
  }
  const read = await readLibraryProposalDecision(
    llmCalls,
    { kind: "construction", id: constructionId },
    decisionId,
  );
  if (read.status !== "found") {
    const [diagnostic] = read.diagnostics;
    return {
      ok: false,
      status: read.status === "uncertain" ? 503 : statusOf(diagnostic.code),
      diagnostics: [diagnostic],
    };
  }
  const { decision, proposal } = read;
  const evaluation = evaluateLibraryProposal({
    callId: proposal.callId,
    context: proposal.context,
    proposal: proposal.proposal,
  });
  const kept = selectApprovedResults(evaluation, decision.approvedResultIds, decision.reviewerId);
  if (!kept.ok) {
    return {
      ok: false,
      status: 409,
      diagnostics: [
        {
          code: "approved-library-stale",
          message: `The approved library no longer passes the checks (${kept.unknown.join(", ")}). Build the library again.`,
        },
      ],
    };
  }
  return {
    ok: true,
    library: {
      constructionId,
      decisionId,
      decidedAt: decision.decidedAt,
      profile: proposal.context.background,
      ...kept.kept,
    },
  };
}

/**
 * The library results the formalizer is shown: the selected packs' results, then the approved
 * initial library's results and their variants. The formalizer's context holds at most
 * `MAX_FORMALIZER_LIBRARY_RESULTS` of them. Within the cap all are shown in that order. Beyond it
 * originals come before variants (a variant only reshapes a result already shown), and among
 * originals the person's approved results come before the packs' generic ones; each group keeps
 * its order, and the rest are left out.
 */
export function formalizerLibraryResults(
  packs: readonly LibraryPack[],
  library: ApprovedInitialLibrary | undefined,
): readonly Readonly<{
  id: string;
  name: string;
  description: string;
  statement: LibraryResult["statement"]["expression"];
  premises: readonly LibraryResult["statement"]["expression"][];
}>[] {
  const fromPacks = packs.flatMap((pack) => pack.results);
  const all = [...fromPacks, ...(library?.results ?? []), ...(library?.variants ?? [])];
  const shown =
    all.length <= MAX_FORMALIZER_LIBRARY_RESULTS
      ? all
      : [
          ...(library?.results ?? []),
          ...fromPacks.filter((result) => !isVariant(result)),
          ...(library?.variants ?? []),
          ...fromPacks.filter(isVariant),
        ].slice(0, MAX_FORMALIZER_LIBRARY_RESULTS);
  return shown.map(({ id, name, description, statement, premises }) => ({
    id,
    name,
    description,
    statement: statement.expression,
    premises: premises.map((premise) => premise.expression),
  }));
}

function isVariant(result: LibraryResult): boolean {
  return result.provenance.kind === "derived-variant";
}

function statusOf(code: LlmCallRepositoryDiagnosticCode): 400 | 404 | 409 {
  if (code === "decision-not-found") return 404;
  if (code === "proposal-not-reviewable") return 409;
  return 400;
}

/** The ID of the addition that records an artifact for a session; stable across retries. */
export function initialLibraryEventId(
  sessionId: string,
  decisionId: string,
  artifactId: string,
): string {
  return `library-addition:${sessionId}:${decisionId}:${artifactId}`;
}

export type RecordInitialLibraryResult =
  | Readonly<{ ok: true; recorded: number; replayed: number }>
  | Readonly<{
      ok: false;
      status: 409 | 503;
      diagnostics: readonly [Readonly<{ code: string; message: string }>];
    }>;

/**
 * Record the approved results, then their variants, as `initial-problem` additions of the session.
 * Each addition goes through the repository's gate and is idempotent (see the module comment), so
 * calling this again after a partial failure, or for a replayed approval, only adds what is
 * missing. A rejection by the gate is reported, never silently skipped.
 */
export async function recordInitialLibrary(
  library: LibraryStore,
  sessionId: string,
  approved: ApprovedInitialLibrary,
): Promise<RecordInitialLibraryResult> {
  let recorded = 0;
  let replayed = 0;
  for (const artifact of [...approved.results, ...approved.variants]) {
    const added = await addLibraryArtifact(library, {
      id: initialLibraryEventId(sessionId, approved.decisionId, artifact.id),
      sessionId,
      occurredAt: approved.decidedAt,
      layer: "initial-problem",
      origin: { kind: "setup", actorId: approved.reviewerId },
      artifact,
    });
    if (added.status !== "recorded") {
      return {
        ok: false,
        status: added.status === "uncertain" ? 503 : 409,
        diagnostics: [
          {
            code: "initial-library-incomplete",
            message: `The session exists, but its initial library could not be recorded completely (${added.diagnostics[0].message}). Approving again with the same request finishes it.`,
          },
        ],
      };
    }
    if (!added.admitted) {
      return {
        ok: false,
        status: 409,
        diagnostics: [
          {
            code: "initial-library-incomplete",
            message: `The library gate rejected the approved result ${artifact.id}. Check the setup again.`,
          },
        ],
      };
    }
    if (added.replayed) replayed += 1;
    else recorded += 1;
  }
  return { ok: true, recorded, replayed };
}
