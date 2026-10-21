import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { withArtifactSessionId } from "@proof/protocol";
import { exportProofArtifact } from "./artifact-export";
import { importProofArtifact } from "./artifact-import";
import { MemoryLibraryStore } from "./memory-library-store";
import { backtrackProofSession } from "./proof-repository";
import {
  NEEDS,
  RESULT_KEYS,
  SESSION,
  activations,
  agent,
  apply,
  current,
  human,
  scenario,
} from "./constant-activation.testing";

/**
 * Property: whatever sequence of library results a proof applies, with or without constants of
 * their own, by a person or an agent, the session's effective operators are its setup operators
 * followed by the constants the steps activated; they only grow; each constant is activated
 * exactly once, by the first step that needed it; a refused step changes nothing; backtracking
 * keeps them; and exporting the session and importing the artifact reproduces the same
 * activations and states.
 */
describe("constant activation properties", () => {
  const stepArbitrary = fc.record({
    key: fc.constantFrom(...RESULT_KEYS),
    byAgent: fc.boolean(),
    refusedFirst: fc.boolean(),
  });

  it("keeps the effective operators equal to the setup operators plus the activations, monotonically", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArbitrary, { minLength: 1, maxLength: 5 }), async (steps) => {
        const scene = await scenario(steps.length);
        const model: { symbol: string; commandId: string }[] = [];
        let previous = (await current(scene.store)).session.operators.map(({ symbol }) => symbol);
        expect(previous).toEqual(["Divides"]);

        for (const [index, step] of steps.entries()) {
          const goal = index + 1;
          const commandId = `command:step-${goal}`;
          const actor = step.byAgent ? agent : human;
          if (step.refusedFirst) {
            // A step the kernel refuses activates nothing, whatever result it names.
            const refused = await apply(scene, {
              key: step.key,
              goal,
              commandId: `command:refused-${goal}`,
              actor,
              resultId: "result:nobody-knows",
            });
            expect(refused.status).toBe("rejected");
            expect(await activations(scene.store)).toHaveLength(model.length);
          }
          const applied = await apply(scene, { key: step.key, goal, commandId, actor });
          expect(applied.status).toBe("committed");
          for (const constant of NEEDS[step.key]) {
            if (!model.some(({ symbol }) => symbol === constant.symbol)) {
              model.push({ symbol: constant.symbol, commandId });
            }
          }

          const operators = (await current(scene.store)).session.operators.map(
            ({ symbol }) => symbol,
          );
          expect(operators).toEqual(["Divides", ...model.map(({ symbol }) => symbol)]);
          expect(operators.slice(0, previous.length)).toEqual(previous);
          previous = operators;
          const recorded = await activations(scene.store);
          expect(
            recorded.map(({ symbol, commandId: by, sequence }) => [symbol, by, sequence]),
          ).toEqual(model.map(({ symbol, commandId: by }, position) => [symbol, by, position + 1]));
        }

        // Backtracking to the root keeps every constant.
        const tip = (await current(scene.store)).node;
        expect(
          await backtrackProofSession(scene.store, SESSION, {
            expectedCurrentNodeId: tip.id,
            targetNodeId: "node:root",
          }),
        ).toMatchObject({ status: "committed" });
        expect((await current(scene.store)).session.operators.map(({ symbol }) => symbol)).toEqual([
          "Divides",
          ...model.map(({ symbol }) => symbol),
        ]);

        // Export, import: the same activations and the same states.
        const exported = await exportProofArtifact(scene.store, SESSION, { library: scene.store });
        if (exported.status !== "exported") throw new Error(JSON.stringify(exported));
        const fresh = new MemoryLibraryStore();
        const imported = await importProofArtifact(fresh, exported.artifact);
        if (imported.status !== "imported") throw new Error(JSON.stringify(imported));
        const again = await exportProofArtifact(fresh, imported.sessionId, { library: fresh });
        if (again.status !== "exported") throw new Error(JSON.stringify(again));
        expect(again.artifact.constantActivations).toEqual(exported.artifact.constantActivations);
        expect(again.artifact.tree).toEqual(
          withArtifactSessionId(exported.artifact, imported.sessionId).tree,
        );
        expect(
          (await current(fresh, imported.sessionId)).session.operators.map(({ symbol }) => symbol),
        ).toEqual(["Divides", ...model.map(({ symbol }) => symbol)]);
      }),
      { numRuns: 20 },
    );
  }, 120_000);

  it("activates nothing for results that need no library constant", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (count) => {
        const scene = await scenario(count, ["plain", "gcd"]);
        for (let goal = 1; goal <= count; goal += 1) {
          await apply(scene, { key: "plain", goal, commandId: `command:plain-${goal}` });
        }
        expect(await activations(scene.store)).toEqual([]);
        expect((await current(scene.store)).session.operators.map(({ symbol }) => symbol)).toEqual([
          "Divides",
        ]);
      }),
      { numRuns: 6 },
    );
  });
});
