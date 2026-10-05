import type { ProofArtifact } from "@proof/protocol";
import raw from "./fixtures/proof-artifact.json";
import rawV2 from "./fixtures/proof-artifact-v2.json";

/**
 * A real export of the worker's N27 artifact scenario (the `corpus:contraposition` solve plus a
 * kept and a deleted sorry, a case split by backtracking with information, a semantic replay, an
 * inquiry command and interaction events). It is stored JSON: nothing here is recomputed.
 */
export const fixtureArtifactJson: unknown = raw;
/** A version-1 export: no stored transition evidence or sequence (the viewers' fallback). */
export const fixtureArtifact = raw as unknown as ProofArtifact;

/**
 * The same session exported at version 2 (N40): every edge, event and command record stores the
 * kernel's evidence and the per-session transition sequence, which here differs from the order
 * of the stored events (events are listed by ID).
 */
export const fixtureArtifactV2Json: unknown = rawV2;
export const fixtureArtifactV2 = rawV2 as unknown as ProofArtifact;

/** A copy of the fixture with the stored solved status, pruned proof and route removed. */
export function unsolvedFixture(): ProofArtifact {
  return {
    ...fixtureArtifact,
    final: {
      ...fixtureArtifact.final,
      solved: false,
      prunedProof: null,
      analysis: {
        ...(fixtureArtifact.final.analysis as Record<string, unknown>),
        solved: false,
        openTargets: [{ kind: "goal", id: "goal:main" }],
      } as never,
    },
  };
}

/** The fixture presented as an imported, read-only session. */
export function importedFixture(): ProofArtifact {
  return {
    ...fixtureArtifact,
    provenance: {
      kind: "import",
      sourceSessionId: "session:elsewhere",
      sourceDigest: `sha256:${"0".repeat(64)}`,
    },
  };
}
