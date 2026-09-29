import { afterEach, describe, expect, it } from "vitest";
import { parseProofArtifact, withArtifactSessionId, type ProofArtifact } from "@proof/protocol";
import { artifactDigest, exportProofArtifact } from "./artifact-export";
import { importProofArtifact, importedSessionId, validateProofArtifact } from "./artifact-import";
import {
  ARTIFACT_SESSION_ID,
  FIXED_NOW,
  buildArtifactScenario,
  comparableContent,
  type ArtifactScenario,
} from "./artifact.testing";
import { MemoryLibraryStore } from "./memory-library-store";
import { loadProofHistory } from "./proof-repository";
import type { ProofHttpService } from "./proof-http";

/** Tamper tests edit arbitrary artifact JSON. */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * N27 acceptance: an artifact exported from a benchmark-corpus session with deletions, a
 * backtrack with information, a replay, inquiry records, a sorry and library additions is
 * revalidated and imported as a read-only session whose re-export equals the original up to the
 * documented session-ID fields; tampered artifacts are rejected with a precise diagnostic and
 * nothing is written.
 */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

let cached: Promise<Readonly<{ scenario: ArtifactScenario; artifact: ProofArtifact }>> | undefined;

/** The scenario is built once; tests only read it or import into fresh stores. */
async function source(): Promise<
  Readonly<{ scenario: ArtifactScenario; artifact: ProofArtifact }>
> {
  cached ??= (async () => {
    const scenario = await buildArtifactScenario([]);
    const exported = await exportProofArtifact(scenario.store, ARTIFACT_SESSION_ID, {
      library: scenario.store,
    });
    if (exported.status !== "exported") throw new Error(JSON.stringify(exported));
    await scenario.service.close();
    return { scenario, artifact: exported.artifact };
  })();
  return cached;
}

function clone(artifact: ProofArtifact): Json {
  return structuredClone(artifact) as Json;
}

/** Recompute the digest of a tampered artifact, as an attacker could. */
function redigest(artifact: Json): Json {
  return { ...artifact, digest: artifactDigest(artifact) };
}

describe("artifact export", () => {
  it("covers every populated section and is deterministic", async () => {
    const { scenario, artifact } = await source();
    expect(parseProofArtifact(artifact).ok).toBe(true);
    expect(artifact.digest).toBe(artifactDigest(artifact));
    expect(artifact.provenance).toEqual({ kind: "session" });
    expect(artifact.problemSetup.metadata?.problem.title).toBe("Contraposition");
    expect(artifact.tree.deletions).toHaveLength(1);
    expect(artifact.tree.replaySteps.length).toBeGreaterThan(0);
    expect(artifact.tree.suggestionSets.length).toBeGreaterThan(0);
    expect(artifact.tree.previews.length).toBeGreaterThan(0);
    expect(artifact.inquiryRecords.map(({ id }) => id)).toEqual([
      "question:main",
      "objective:main",
      "attempt:introduce",
    ]);
    expect(artifact.interactionEvents.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["suggestions-requested", "backtracked-with-information"]),
    );
    expect(artifact.library.additionEvents.map(({ admission }) => admission.decision)).toEqual([
      "admitted",
      "rejected",
      "admitted",
    ]);
    expect(artifact.library.backgroundRevisions).toHaveLength(1);
    expect(artifact.library.finalLibrary.map(({ id }) => id)).toEqual([
      "result:logic",
      "result:analysis-2",
    ]);
    expect(artifact.final.solved).toBe(true);
    expect(artifact.final.prunedProof).not.toBeNull();
    expect(artifact.final.sorryAssumptions).toHaveLength(1);
    expect(artifact.llmCalls).toEqual([]);

    // Static history: exporting the same stored state again gives the same artifact.
    const again = await exportProofArtifact(scenario.store, ARTIFACT_SESSION_ID, {
      library: scenario.store,
    });
    expect(again).toEqual({ status: "exported", artifact });
  });
});

describe("artifact import", () => {
  it("round-trips through a read-only session equal up to the session-ID fields", async () => {
    const { artifact } = await source();
    const target = new MemoryLibraryStore();
    const imported = await importProofArtifact(target, artifact, { now: FIXED_NOW });
    expect(imported).toEqual({
      status: "imported",
      sessionId: importedSessionId(artifact.digest),
      digest: artifact.digest,
      sourceSessionId: ARTIFACT_SESSION_ID,
      replayed: false,
    });
    if (imported.status !== "imported") throw new Error("not imported");

    const reexported = await exportProofArtifact(target, imported.sessionId, { library: target });
    if (reexported.status !== "exported") throw new Error(JSON.stringify(reexported));
    const again = reexported.artifact;
    expect(again.provenance).toEqual({
      kind: "import",
      sourceSessionId: ARTIFACT_SESSION_ID,
      sourceDigest: artifact.digest,
    });
    expect(comparableContent(withArtifactSessionId(again, ARTIFACT_SESSION_ID))).toEqual(
      comparableContent(artifact),
    );
    expect(again.final).toEqual(artifact.final);

    const history = await loadProofHistory(target, imported.sessionId);
    expect(history).toMatchObject({ status: "loaded" });
  });

  it("is idempotent: the same artifact finds the same session", async () => {
    const { artifact } = await source();
    const target = new MemoryLibraryStore();
    const first = await importProofArtifact(target, artifact);
    const second = await importProofArtifact(target, artifact);
    expect(first).toMatchObject({ status: "imported", replayed: false });
    expect(second).toMatchObject({
      status: "imported",
      replayed: true,
      sessionId: first.status === "imported" ? first.sessionId : "",
    });
  });

  it("validates the untampered artifact", async () => {
    const { artifact } = await source();
    expect(validateProofArtifact(artifact)).toMatchObject({ ok: true });
  });
});

type Tamper = (artifact: Json) => void;

function nodeWith(artifact: Json, predicate: (node: Json) => boolean): Json {
  const found = artifact.tree.nodes.find(predicate);
  if (found === undefined) throw new Error("No such node in the fixture.");
  return found;
}

type TamperCase = readonly [string, Tamper, string, ((string | number)[] | undefined)?];

const tampering: readonly TamperCase[] = [
  [
    "an altered snapshot",
    (artifact) => {
      // The node the replay created: no suggestion set is anchored at it.
      const node = nodeWith(artifact, (candidate) =>
        candidate.id.startsWith("node:command:replay-first"),
      );
      node.state.goals[0].sequent.conclusion.expression = ["Not", "q"];
    },
    "transition-not-reproduced",
  ],
  [
    "an altered snapshot with a displayed preview",
    (artifact) => {
      const node = nodeWith(
        artifact,
        (candidate) => candidate.id === "node:command:contraposition-1",
      );
      node.state.goals[0].sequent.conclusion.expression = ["Not", "q"];
    },
    "preview-not-reproduced",
  ],
  [
    "a suggestion set moved to another node",
    (artifact) => {
      artifact.tree.suggestionSets[0].nodeId = "node:command:contraposition-1";
    },
    "suggestion-set-mismatch",
    ["tree", "suggestionSets", 0],
  ],
  [
    "an altered edge operation",
    (artifact) => {
      const edge = artifact.tree.edges.find(
        (candidate: Json) => candidate.commandId === "command:contraposition-1",
      );
      edge.operation.hypothesisId = "hypothesis:forged";
    },
    "transition-not-reproduced",
  ],
  [
    "an edge operation altered consistently in the edge, event and command record",
    (artifact) => {
      const forge = (operation: Json) => {
        operation.hypothesisId = "hypothesis:forged";
      };
      const edge = artifact.tree.edges.find(
        (candidate: Json) => candidate.commandId === "command:contraposition-1",
      );
      forge(edge.operation);
      forge(artifact.tree.events.find((event: Json) => event.edgeId === edge.id).operation);
      const command = artifact.tree.commands.find(
        (record: Json) => record.prepared.command.commandId === "command:contraposition-1",
      );
      forge(command.prepared.command.operation);
      forge(command.prepared.edge.operation);
      forge(command.prepared.event.operation);
    },
    "transition-not-reproduced",
  ],
  [
    "a dangling node ID",
    (artifact) => {
      artifact.interactionEvents[0].nodeId = "node:missing";
    },
    "dangling-reference",
    ["interactionEvents", 0, "nodeId"],
  ],
  [
    "a dangling suggestion-set ID",
    (artifact) => {
      artifact.tree.previews[0].suggestionSetId = "suggestion-set:missing";
    },
    "dangling-reference",
  ],
  [
    "a forged solved status",
    (artifact) => {
      artifact.final.solved = false;
    },
    "final-material-mismatch",
    ["final"],
  ],
  [
    "a forged admission decision",
    (artifact) => {
      const rejected = artifact.library.additionEvents[1];
      rejected.admission = { decision: "admitted", diagnostics: [] };
    },
    "library-admission-mismatch",
    ["library", "additionEvents", 1],
  ],
  [
    "a final library missing an admitted artifact",
    (artifact) => {
      artifact.library.finalLibrary.pop();
    },
    "final-library-mismatch",
  ],
  [
    "an inquiry attempt naming an unapproved method",
    (artifact) => {
      artifact.inquiryRecords[2].method.moveId = "move:forged";
    },
    "inquiry-record-invalid",
    ["inquiryRecords", 0],
  ],
  [
    "an inquiry objective focused on a target the node does not have",
    (artifact) => {
      artifact.inquiryRecords[1].focus.target.id = "goal:forged";
    },
    "inquiry-record-invalid",
  ],
  [
    "a forged preview",
    (artifact) => {
      artifact.tree.previews[0].transitionClass =
        artifact.tree.previews[0].transitionClass === "weakening" ? "equivalence" : "weakening";
    },
    "preview-not-reproduced",
  ],
  [
    "a revived deleted node",
    (artifact) => {
      artifact.tree.deletions[0].deletedNodeIds = ["node:command:sorry-kept"];
      artifact.tree.deletions[0].expectedCurrentNodeId = "node:command:sorry-kept";
    },
    "deletion-invalid",
  ],
  [
    "a forged translation dictionary",
    (artifact) => {
      artifact.translationDictionary.activePackIds = ["pack:forged"];
    },
    "translation-dictionary-mismatch",
  ],
];

describe("tampered artifacts", () => {
  it.each(tampering)(
    "rejects %s even with a recomputed digest, writing nothing",
    async (_label, tamper, code, path) => {
      const { artifact } = await source();
      const forged = clone(artifact);
      (tamper as Tamper)(forged);
      const target = new MemoryLibraryStore();

      // The digest alone detects the change.
      const stale = await importProofArtifact(target, forged);
      expect(stale).toMatchObject({
        status: "invalid",
        diagnostics: [{ code: "digest-mismatch" }],
      });

      // A recomputed digest does not help: revalidation rejects the content.
      const redigested = redigest(forged);
      const result = await importProofArtifact(target, redigested);
      expect(result).toMatchObject({ status: "invalid", diagnostics: [{ code }] });
      if (path !== undefined) {
        expect(result.status === "invalid" && result.diagnostics[0].path).toEqual(path);
      }
      expect(await loadProofHistory(target, importedSessionId(redigested.digest))).toMatchObject({
        status: "rejected",
        diagnostics: [{ code: "session-not-found" }],
      });
    },
  );

  it("rejects an altered digest", async () => {
    const { artifact } = await source();
    const forged = { ...clone(artifact), digest: `sha256:${"0".repeat(64)}` };
    expect(validateProofArtifact(forged)).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "digest-mismatch",
          message: "The artifact content does not match its digest.",
          path: ["digest"],
        },
      ],
    });
  });

  it("rejects another artifact version before reading any section", async () => {
    const { artifact } = await source();
    const forged = redigest({ ...clone(artifact), artifactVersion: 2 });
    expect(validateProofArtifact(forged)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "unsupported-version", path: ["artifactVersion"] }],
    });
    expect(validateProofArtifact({ artifactVersion: 1 })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-artifact" }],
    });
    expect(validateProofArtifact([])).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-artifact" }],
    });
  });

  it("rejects an unknown extra field anywhere through the strict schema", async () => {
    const { artifact } = await source();
    const forged = clone(artifact);
    forged.tree.edges[0].forged = true;
    expect(validateProofArtifact(redigest(forged))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-artifact", path: ["tree", "edges", 0] }],
    });
  });
});
