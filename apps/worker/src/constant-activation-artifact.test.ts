import { describe, expect, it } from "vitest";
import { parseProofArtifact, withArtifactSessionId, type ProofArtifact } from "@proof/protocol";
import { artifactDigest, exportProofArtifact } from "./artifact-export";
import { importProofArtifact, importedSessionId, validateProofArtifact } from "./artifact-import";
import { MemoryLibraryStore } from "./memory-library-store";
import { deletePreviousMove, executeProofCommand } from "./proof-repository";
import {
  GCD,
  LCM,
  SESSION,
  activations,
  apply,
  applyCommand,
  current,
  human,
  scenario,
  type Scenario,
} from "./constant-activation.testing";

/** Tamper tests edit arbitrary artifact JSON. */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const NOW = () => new Date("2026-10-19T10:00:00.000Z");

/** Two steps: the first activates Gcd, the second Lcm. */
async function twoSteps(): Promise<Scenario> {
  const scene = await scenario(3);
  await apply(scene, { key: "gcd", goal: 1, commandId: "command:first" }, NOW);
  await apply(scene, { key: "lcm", goal: 2, commandId: "command:second" }, NOW);
  return scene;
}

async function exported(scene: Scenario): Promise<ProofArtifact> {
  const result = await exportProofArtifact(scene.store, SESSION, { library: scene.store });
  if (result.status !== "exported") throw new Error(JSON.stringify(result));
  return result.artifact;
}

function redigest(artifact: Json): Json {
  return { ...artifact, digest: artifactDigest(artifact) };
}

function tampered(artifact: ProofArtifact, change: (copy: Json) => void): Json {
  const copy = structuredClone(artifact) as Json;
  change(copy);
  return redigest(copy);
}

describe("exporting a session with activated constants", () => {
  it("carries the setup operators, the activations and an environment that declares both", async () => {
    const artifact = await exported(await twoSteps());
    expect(parseProofArtifact(artifact).ok).toBe(true);
    expect(artifact.initialState.operators.map(({ symbol }) => symbol)).toEqual(["Divides"]);
    expect(
      artifact.constantActivations.map(({ symbol, sequence, commandId, resultId }) => [
        symbol,
        sequence,
        commandId,
        resultId,
      ]),
    ).toEqual([
      ["Gcd", 1, "command:first", "result:test-gcd"],
      ["Lcm", 2, "command:second", "result:test-lcm"],
    ]);
    expect(artifact.library.operators.map(({ symbol }) => symbol)).toEqual([
      "Divides",
      "Gcd",
      "Lcm",
    ]);
    expect(artifact.translationDictionary.entries.map(({ symbol }) => symbol)).toEqual([
      "Divides",
      "Gcd",
      "Lcm",
    ]);
    // The library results that need the constants carry their declarations.
    expect(
      artifact.library.finalLibrary.flatMap((entry) =>
        entry.kind === "result" ? [[entry.id, (entry.operators ?? []).map((o) => o.symbol)]] : [],
      ),
    ).toEqual(
      expect.arrayContaining([
        ["result:test-gcd", ["Gcd"]],
        ["result:test-both", ["Gcd", "Lcm"]],
      ]),
    );
  });
});

describe("importing a session with activated constants", () => {
  it("reproduces the activations, the states and the artifact", async () => {
    const original = await exported(await twoSteps());
    expect(validateProofArtifact(original).ok).toBe(true);
    const fresh = new MemoryLibraryStore();
    const imported = await importProofArtifact(fresh, original);
    expect(imported).toMatchObject({ status: "imported", replayed: false });
    if (imported.status !== "imported") return;

    expect((await activations(fresh, imported.sessionId)).map(({ symbol }) => symbol)).toEqual([
      "Gcd",
      "Lcm",
    ]);
    const { session } = await current(fresh, imported.sessionId);
    expect(session.operators.map(({ symbol }) => symbol)).toEqual(["Divides", "Gcd", "Lcm"]);

    // Re-exporting the read-only session gives the same artifact up to the session ID.
    const again = await exportProofArtifact(fresh, imported.sessionId, { library: fresh });
    if (again.status !== "exported") throw new Error(JSON.stringify(again));
    const rebased = withArtifactSessionId(original, imported.sessionId);
    expect(again.artifact.constantActivations).toEqual(original.constantActivations);
    expect(again.artifact.tree).toEqual(rebased.tree);
    expect(again.artifact.initialState).toEqual(original.initialState);
    expect(importedSessionId(original.digest)).toBe(imported.sessionId);
    expect(await importProofArtifact(fresh, original)).toMatchObject({ replayed: true });
  });

  it("refuses a write to the imported, read-only session", async () => {
    const original = await exported(await twoSteps());
    const fresh = new MemoryLibraryStore();
    const imported = await importProofArtifact(fresh, original);
    if (imported.status !== "imported") throw new Error(JSON.stringify(imported));
    const scene = await scenario(1, undefined, "session:other", new MemoryLibraryStore());
    const command = await applyCommand(scene.store, {
      key: "gcd",
      goal: 1,
      commandId: "command:late",
      sessionId: "session:other",
    });
    expect(
      await executeProofCommand(
        fresh,
        imported.sessionId,
        { ...command, parentNodeId: (await current(fresh, imported.sessionId)).node.id },
        human,
      ),
    ).toMatchObject({ status: "rejected" });
    expect(await activations(fresh, imported.sessionId)).toHaveLength(2);
  });

  it("accepts an artifact written before activations existed", async () => {
    const scene = await scenario(2);
    await apply(scene, { key: "plain", goal: 1, commandId: "command:plain" }, NOW);
    const artifact = await exported(scene);
    expect(artifact.constantActivations).toEqual([]);
    const legacy = tampered(artifact, (copy) => {
      delete copy.constantActivations;
    });
    expect(validateProofArtifact(legacy).ok).toBe(true);
    expect(await importProofArtifact(new MemoryLibraryStore(), legacy)).toMatchObject({
      status: "imported",
    });
  });

  it("keeps the constant of a deleted step, and the steps that rely on it, importable", async () => {
    const scene = await scenario(3);
    await apply(scene, { key: "gcd", goal: 1, commandId: "command:first" }, NOW);
    const first = (await current(scene.store)).node;
    expect(
      await deletePreviousMove(
        scene.store,
        SESSION,
        { commandId: "command:delete", actor: human, expectedCurrentNodeId: first.id },
        human,
      ),
    ).toMatchObject({ status: "committed" });
    // Gcd stays active, so this step needs no activation of its own.
    await apply(scene, { key: "gcd", goal: 2, commandId: "command:second" }, NOW);
    const artifact = await exported(scene);
    expect(artifact.constantActivations).toHaveLength(1);
    expect(artifact.tree.deletions).toHaveLength(1);
    expect(artifact.constantActivations[0]).toMatchObject({
      symbol: "Gcd",
      commandId: "command:first",
    });
    expect(artifact.tree.commands.map(({ prepared }) => prepared.command.commandId)).toEqual([
      "command:second",
    ]);

    const fresh = new MemoryLibraryStore();
    const imported = await importProofArtifact(fresh, artifact);
    expect(imported).toMatchObject({ status: "imported" });
    if (imported.status !== "imported") return;
    expect(
      (await current(fresh, imported.sessionId)).session.operators.map((o) => o.symbol),
    ).toEqual(["Divides", "Gcd"]);
  });
});

describe("tampering with the activations of an artifact", () => {
  const codeOf = (artifact: unknown) => {
    const result = validateProofArtifact(artifact);
    return result.ok ? undefined : result.diagnostics[0].code;
  };

  it("detects a removed activation, even when the rest is renumbered", async () => {
    const artifact = await exported(await twoSteps());
    const withoutFirst = tampered(artifact, (copy) => {
      copy.constantActivations = [{ ...copy.constantActivations[1], sequence: 1 }];
    });
    expect(codeOf(withoutFirst)).toBe("invalid-artifact");
    const withoutLast = tampered(artifact, (copy) => {
      copy.constantActivations = [copy.constantActivations[0]];
    });
    expect(codeOf(withoutLast)).toBe("invalid-artifact");
    const none = tampered(artifact, (copy) => {
      copy.constantActivations = [];
    });
    expect(codeOf(none)).toBe("invalid-artifact");
    const fresh = new MemoryLibraryStore();
    expect(await importProofArtifact(fresh, none)).toMatchObject({ status: "invalid" });
    expect(await fresh.transaction((t) => t.lockSession(importedSessionId(none.digest)))).toBe(
      undefined,
    );
  });

  it("detects an activation attributed to another step", async () => {
    const artifact = await exported(await twoSteps());
    const first = artifact.constantActivations[0]!;
    const moved = tampered(artifact, (copy) => {
      // Lcm is claimed by the first step instead of the second.
      copy.constantActivations[1] = {
        ...copy.constantActivations[1],
        commandId: first.commandId,
        edgeId: first.edgeId,
        nodeId: first.nodeId,
        transitionSequence: first.transitionSequence,
      };
    });
    expect(codeOf(moved)).toBe("constant-activation-mismatch");
  });

  it("detects an activation that no step explains", async () => {
    const scene = await scenario(2);
    await apply(scene, { key: "gcd", goal: 1, commandId: "command:first" }, NOW);
    const artifact = await exported(scene);
    const first = artifact.constantActivations[0]!;
    // The library holds a result that needs Lcm, so the declaration is a library constant, but
    // the step that "activated" it applied a result that does not use it.
    const extra = tampered(artifact, (copy) => {
      copy.constantActivations.push({
        ...first,
        sequence: 2,
        symbol: LCM.symbol,
        declaration: LCM,
        resultId: "result:test-lcm",
      });
      copy.library.operators = [...copy.library.operators, LCM];
    });
    expect(codeOf(extra)).toBe("constant-activation-mismatch");
    // An activation for a step that is neither in the artifact nor recorded as deleted.
    const ghost = tampered(artifact, (copy) => {
      copy.constantActivations[0] = {
        ...first,
        commandId: "command:ghost",
        edgeId: "edge:ghost",
        nodeId: "node:ghost",
      };
    });
    expect(codeOf(ghost)).toBe("constant-activation-mismatch");
  });

  it("detects another declaration of an activated constant", async () => {
    const artifact = await exported(await twoSteps());
    const renamed = tampered(artifact, (copy) => {
      copy.constantActivations[0].declaration = { ...GCD, id: "operator:other-gcd" };
      copy.constantActivations[0].symbol = GCD.symbol;
    });
    expect(codeOf(renamed)).toBe("invalid-artifact");
  });
});

describe("the constants of a session in its artifact", () => {
  it("lists exactly the setup operators and the activations", async () => {
    const scene = await twoSteps();
    const { session } = await current(scene.store);
    const artifact = await exported(scene);
    expect([
      ...artifact.initialState.operators,
      ...artifact.constantActivations.map((a) => a.declaration),
    ]).toEqual(session.operators);
  });
});
