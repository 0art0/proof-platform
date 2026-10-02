import { afterEach, describe, expect, it } from "vitest";
import {
  deriveArtifactFinalMaterial,
  parseProofArtifact,
  previewWithoutStoredEvidence,
  withArtifactSessionId,
  withoutEvidenceFields,
  withoutStoredTransitionEvidence,
  type ProofArtifact,
} from "@proof/protocol";
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
    expect(artifact.artifactVersion).toBe(2);
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

describe("stored transition evidence and sequence (version 2)", () => {
  it("stores the kernel's evidence and a chronological sequence on every transition", async () => {
    const { artifact } = await source();
    const { edges, events, commands, previews } = artifact.tree;
    expect(edges.length).toBeGreaterThan(5);
    for (const edge of edges) {
      expect(edge.evidence, edge.id).toBeDefined();
      expect(edge.sequence, edge.id).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(edges.map(({ sequence }) => sequence)).size).toBe(edges.length);
    for (const event of events) {
      const edge = edges.find(({ id }) => id === event.edgeId);
      expect([event.evidence, event.sequence]).toEqual([edge?.evidence, edge?.sequence]);
    }
    for (const { prepared, receipt } of commands) {
      expect([receipt.evidence, receipt.sequence]).toEqual([
        prepared.edge.evidence,
        prepared.edge.sequence,
      ]);
    }
    for (const preview of previews) expect(preview.evidence).toBeDefined();
    // A transition follows the one that produced its parent.
    const incoming = new Map(edges.map((edge) => [edge.childNodeId, edge.sequence as number]));
    for (const edge of edges) {
      const parent = incoming.get(edge.parentNodeId);
      if (parent !== undefined) expect(edge.sequence as number).toBeGreaterThan(parent);
    }
    // The sorry the scenario keeps is recorded as sorry evidence, not derived later.
    expect(edges.map(({ evidence }) => evidence)).toEqual(
      expect.arrayContaining(["structural", "sorry"]),
    );
  });
});

describe("version-1 artifacts", () => {
  /** What an exporter before N40 wrote: no evidence or sequence anywhere. */
  function legacy(artifact: ProofArtifact): Json {
    const tree = {
      ...artifact.tree,
      edges: artifact.tree.edges.map((edge) => withoutEvidenceFields(edge)),
      events: artifact.tree.events.map((event) => withoutEvidenceFields(event)),
      commands: artifact.tree.commands.map(withoutStoredTransitionEvidence),
      previews: artifact.tree.previews.map(previewWithoutStoredEvidence),
    };
    return redigest({
      ...(structuredClone(artifact) as Json),
      artifactVersion: 1,
      tree: structuredClone(tree),
      final: structuredClone(deriveArtifactFinalMaterial(tree)),
    });
  }

  it("are still accepted, imported unchanged, and re-exported as version 1", async () => {
    const { artifact } = await source();
    const v1 = legacy(artifact);
    expect(validateProofArtifact(v1)).toMatchObject({ ok: true });
    const target = new MemoryLibraryStore();
    const imported = await importProofArtifact(target, v1, { now: FIXED_NOW });
    expect(imported).toMatchObject({ status: "imported", replayed: false });
    if (imported.status !== "imported") throw new Error("not imported");
    const reexported = await exportProofArtifact(target, imported.sessionId, { library: target });
    if (reexported.status !== "exported") throw new Error(JSON.stringify(reexported));
    // Nothing is derived into the stored rows: the import keeps what the artifact stored.
    expect(reexported.artifact.artifactVersion).toBe(1);
    for (const edge of reexported.artifact.tree.edges) {
      expect(edge).not.toHaveProperty("evidence");
      expect(edge).not.toHaveProperty("sequence");
    }
    expect(
      comparableContent(withArtifactSessionId(reexported.artifact, ARTIFACT_SESSION_ID)),
    ).toEqual(comparableContent(v1 as unknown as ProofArtifact));
  });

  it("must not carry stored evidence or a sequence", async () => {
    const { artifact } = await source();
    const forged = legacy(artifact);
    forged.tree.edges[0].evidence = "structural";
    expect(validateProofArtifact(redigest(forged))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-artifact", path: ["tree", "edges", 0] }],
    });
    const preview = legacy(artifact);
    preview.tree.previews[0].evidence = "structural";
    expect(validateProofArtifact(redigest(preview))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-artifact", path: ["tree", "previews", 0] }],
    });
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
    "evidence altered consistently in the edge, event and command record",
    (artifact) => {
      const edge = artifact.tree.edges.find(
        (candidate: Json) => candidate.commandId === "command:contraposition-1",
      );
      const forged = edge.evidence === "sorry" ? "structural" : "sorry";
      edge.evidence = forged;
      artifact.tree.events.find((event: Json) => event.edgeId === edge.id).evidence = forged;
      const command = artifact.tree.commands.find(
        (record: Json) => record.prepared.command.commandId === "command:contraposition-1",
      );
      command.prepared.edge.evidence = forged;
      command.prepared.event.evidence = forged;
      command.receipt.evidence = forged;
    },
    "transition-not-reproduced",
  ],
  [
    "a transition sequence altered consistently in the edge, event and command record",
    (artifact) => {
      const edge = artifact.tree.edges.find(
        (candidate: Json) => candidate.commandId === "command:contraposition-1",
      );
      // Later than every transition, so it stays distinct and causally ordered for its own
      // children only if they were reordered too; the schema checks catch the rest.
      const forged = 9999;
      edge.sequence = forged;
      artifact.tree.events.find((event: Json) => event.edgeId === edge.id).sequence = forged;
      const command = artifact.tree.commands.find(
        (record: Json) => record.prepared.command.commandId === "command:contraposition-1",
      );
      command.prepared.edge.sequence = forged;
      command.prepared.event.sequence = forged;
      command.receipt.sequence = forged;
    },
    "invalid-artifact",
  ],
  [
    "an edge sequence that differs from its event's",
    (artifact) => {
      artifact.tree.edges[0].sequence += 1000;
    },
    "invalid-artifact",
  ],
  [
    "two transitions with the same sequence",
    (artifact) => {
      artifact.tree.edges[1].sequence = artifact.tree.edges[0].sequence;
    },
    "invalid-artifact",
  ],
  [
    "a missing stored evidence on a version-2 edge",
    (artifact) => {
      delete artifact.tree.edges[0].evidence;
    },
    "invalid-artifact",
    ["tree", "edges", 0],
  ],
  [
    "a missing stored sequence on a version-2 event",
    (artifact) => {
      delete artifact.tree.events[0].sequence;
    },
    "invalid-artifact",
    ["tree", "events", 0],
  ],
  [
    "a forged preview evidence",
    (artifact) => {
      const preview = artifact.tree.previews[0];
      preview.evidence = preview.evidence === "sorry" ? "structural" : "sorry";
    },
    "preview-not-reproduced",
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

  it("rejects a transition sequenced before the transition that produced its parent", async () => {
    const { artifact } = await source();
    const forged = clone(artifact);
    const edges = forged.tree.edges as Json[];
    const child = edges.find((edge) =>
      edges.some((other) => other.childNodeId === edge.parentNodeId),
    ) as Json;
    const parent = edges.find((edge) => edge.childNodeId === child.parentNodeId) as Json;
    // Swap the two sequences everywhere they are stored, so only the ordering is wrong.
    const sequenceOf = new Map<string, number>([
      [child.id, parent.sequence],
      [parent.id, child.sequence],
    ]);
    const restamp = (record: Json, edgeId: string) => {
      const sequence = sequenceOf.get(edgeId);
      if (sequence !== undefined) record.sequence = sequence;
    };
    for (const edge of edges) restamp(edge, edge.id);
    for (const event of forged.tree.events as Json[]) restamp(event, event.edgeId);
    for (const command of forged.tree.commands as Json[]) {
      const edgeId = command.prepared.edge.id as string;
      for (const record of [command.prepared.edge, command.prepared.event, command.receipt]) {
        restamp(record, edgeId);
      }
    }
    expect(validateProofArtifact(redigest(forged))).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "invalid-artifact",
          message: "A transition must be sequenced after the transition that produced its parent.",
        },
      ],
    });
  });

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
    const forged = redigest({ ...clone(artifact), artifactVersion: 3 });
    expect(validateProofArtifact(forged)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "unsupported-version", path: ["artifactVersion"] }],
    });
    expect(validateProofArtifact({ artifactVersion: 2 })).toMatchObject({
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
