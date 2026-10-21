import { describe, expect, it } from "vitest";
import { mergeLibraryOperators } from "@proof/library";
import type { ProofStoreTransaction } from "./proof-repository";
import {
  backtrackProofSession,
  deletePreviousMove,
  executeProofCommand,
  executeProposalPlan,
  loadProofHistory,
  loadSession,
  type ProofSession,
} from "./proof-repository";
import { MemoryLibraryStore } from "./memory-library-store";
import { sessionDefinitions } from "./move-authoring";
import { APPROVED_DEFINITIONS } from "./approved-catalog";
import {
  DIVIDES,
  GCD,
  LCM,
  ROOT_NODE_ID,
  SESSION,
  activations,
  agent,
  apply,
  applyCommand,
  current,
  human,
  libraryResult,
  scenario,
} from "./constant-activation.testing";

const NOW = () => new Date("2026-10-19T10:00:00.000Z");
const symbols = (session: ProofSession) => session.operators.map(({ symbol }) => symbol);

describe("activating a library constant", () => {
  it("records one activation with the step that applied the result, and uses the constant afterwards", async () => {
    const scene = await scenario(3);
    expect(symbols((await current(scene.store)).session)).toEqual(["Divides"]);

    const applied = await apply(scene, { key: "gcd", goal: 1, commandId: "command:one" }, NOW);
    expect(applied).toMatchObject({ status: "committed", replayed: false });
    const recorded = await activations(scene.store);
    expect(recorded).toEqual([
      {
        sequence: 1,
        symbol: "Gcd",
        declaration: GCD,
        commandId: "command:one",
        edgeId: "edge:command-one",
        nodeId: "node:command-one",
        resultId: "result:test-gcd",
        transitionSequence: 1,
        activatedAt: "2026-10-19T10:00:00.000Z",
      },
    ]);
    // The step's own state mentions Gcd (an obligation about it), and the session now accepts it.
    const { session, node } = await current(scene.store);
    expect(symbols(session)).toEqual(["Divides", "Gcd"]);
    expect(JSON.stringify(node.state)).toContain("Gcd");
  });

  it("replays a committed command without activating anything again", async () => {
    const scene = await scenario(2);
    const command = await applyCommand(scene.store, {
      key: "gcd",
      goal: 1,
      commandId: "command:once",
    });
    const run = () => executeProofCommand(scene.store, SESSION, command, human, scene.definitions);
    expect(await run()).toMatchObject({ status: "committed", replayed: false });
    expect(await activations(scene.store)).toHaveLength(1);
    expect(await run()).toMatchObject({ status: "committed", replayed: true });
    expect(await activations(scene.store)).toHaveLength(1);
  });

  it("activates each constant once, in the order results declare them, and nothing for a result without one", async () => {
    const scene = await scenario(4);
    expect(await apply(scene, { key: "plain", goal: 1, commandId: "command:plain" })).toMatchObject(
      { status: "committed" },
    );
    expect(await activations(scene.store)).toEqual([]);
    expect(symbols((await current(scene.store)).session)).toEqual(["Divides"]);

    await apply(scene, { key: "both", goal: 2, commandId: "command:both" });
    expect(
      (await activations(scene.store)).map(({ symbol, sequence }) => [symbol, sequence]),
    ).toEqual([
      ["Gcd", 1],
      ["Lcm", 2],
    ]);
    // Both are active now: applying a result that needs either activates nothing more.
    await apply(scene, { key: "gcd", goal: 3, commandId: "command:gcd" });
    await apply(scene, { key: "lcm", goal: 4, commandId: "command:lcm" });
    expect(await activations(scene.store)).toHaveLength(2);
    expect(symbols((await current(scene.store)).session)).toEqual(["Divides", "Gcd", "Lcm"]);
  });

  it("records the activation before the step, in the step's own transaction", async () => {
    const calls: string[] = [];
    class Spying extends MemoryLibraryStore {
      protected override instrument(transaction: ProofStoreTransaction): ProofStoreTransaction {
        return {
          ...transaction,
          insertConstantActivation: async (...args) => {
            calls.push("activation");
            return transaction.insertConstantActivation(...args);
          },
          insertNode: async (...args) => {
            calls.push("node");
            return transaction.insertNode(...args);
          },
          insertEdge: async (...args) => {
            calls.push("edge");
            return transaction.insertEdge(...args);
          },
        };
      }
    }
    const scene = await scenario(2, undefined, SESSION, new Spying());
    calls.length = 0;
    await apply(scene, { key: "gcd", goal: 1, commandId: "command:order" });
    expect(calls).toEqual(["activation", "node", "edge"]);
  });

  it("records nothing when the step fails, whether the kernel or the store refuses it", async () => {
    const scene = await scenario(2);
    // The kernel refuses: the instantiation does not match the goal.
    const bad = await apply(scene, {
      key: "gcd",
      goal: 1,
      commandId: "command:bad",
      mismatchedGoal: 2,
    });
    expect(bad).toMatchObject({ status: "rejected" });
    // An unknown result is refused too.
    const unknown = await apply(scene, {
      key: "gcd",
      goal: 1,
      commandId: "command:unknown",
      resultId: "result:nobody-knows",
    });
    expect(unknown).toMatchObject({ status: "rejected" });
    expect(await activations(scene.store)).toEqual([]);
    expect(symbols((await current(scene.store)).session)).toEqual(["Divides"]);

    // The store fails after the activation was written: the whole transaction rolls back.
    class Failing extends MemoryLibraryStore {
      protected override instrument(transaction: ProofStoreTransaction): ProofStoreTransaction {
        return {
          ...transaction,
          insertCommand: async () => {
            throw new Error("injected failure");
          },
        };
      }
    }
    const broken = await scenario(1, undefined, SESSION, new Failing());
    expect(await apply(broken, { key: "gcd", goal: 1, commandId: "command:broken" })).toMatchObject(
      { status: "rejected" },
    );
    expect(await activations(broken.store)).toEqual([]);
    expect(symbols((await current(broken.store)).session)).toEqual(["Divides"]);
  });

  it("keeps the constant after backtracking and after deleting the step", async () => {
    const scene = await scenario(2);
    const root = (await current(scene.store)).node;
    await apply(scene, { key: "gcd", goal: 1, commandId: "command:first" });
    const first = (await current(scene.store)).node;

    expect(
      await backtrackProofSession(scene.store, SESSION, {
        expectedCurrentNodeId: first.id,
        targetNodeId: root.id,
      }),
    ).toMatchObject({ status: "committed" });
    expect(symbols((await current(scene.store)).session)).toEqual(["Divides", "Gcd"]);
    expect(await activations(scene.store)).toHaveLength(1);

    // Back at the root, the step is a child to delete: the constant stays.
    await backtrackProofSession(scene.store, SESSION, {
      expectedCurrentNodeId: root.id,
      targetNodeId: first.id,
    });
    const deleted = await deletePreviousMove(
      scene.store,
      SESSION,
      { commandId: "command:delete", actor: human, expectedCurrentNodeId: first.id },
      human,
    );
    expect(deleted).toMatchObject({ status: "committed" });
    const after = await current(scene.store);
    expect(after.node.id).toBe(ROOT_NODE_ID);
    expect(symbols(after.session)).toEqual(["Divides", "Gcd"]);
    expect((await activations(scene.store)).map(({ symbol, edgeId }) => [symbol, edgeId])).toEqual([
      ["Gcd", "edge:command-first"],
    ]);

    // Another step that needs Gcd activates nothing: it is already part of the proof.
    expect(await apply(scene, { key: "gcd", goal: 2, commandId: "command:second" })).toMatchObject({
      status: "committed",
    });
    expect(await activations(scene.store)).toHaveLength(1);
    const history = await loadProofHistory(scene.store, SESSION);
    expect(history.status).toBe("loaded");
  });

  it("treats human and agent commands alike", async () => {
    const byHuman = await scenario(2);
    const byAgent = await scenario(2);
    for (const [scene, actor] of [
      [byHuman, human],
      [byAgent, agent],
    ] as const) {
      await apply(scene, { key: "both", goal: 1, commandId: "command:both", actor }, NOW);
      await apply(scene, { key: "gcd", goal: 2, commandId: "command:gcd", actor }, NOW);
    }
    expect(await activations(byAgent.store)).toEqual(await activations(byHuman.store));
    expect(symbols((await current(byAgent.store)).session)).toEqual(
      symbols((await current(byHuman.store)).session),
    );
  });

  it("activates the constants of the steps of a confirmed plan, step by step", async () => {
    const scene = await scenario(3);
    const root = (await current(scene.store)).node;
    const step = (index: number, key: "gcd" | "lcm" | "plain", goal: number) => ({
      kind: "apply-result-backward",
      expectedStateId: index === 1 ? root.state.id : `state:plan:${index - 1}`,
      resultStateId: `state:plan:${index}`,
      target: { kind: "goal", id: `goal:${goal}` },
      resultId: `result:test-${key}`,
      instantiation: { a: `p${goal}`, b: "q" },
      premiseTargetIds: key === "plain" ? [] : [`statement:plan:${index}:premise`],
    });
    const planned = await executeProposalPlan(
      scene.store,
      SESSION,
      {
        commandIdPrefix: "command:plan",
        expectedCurrentNodeId: root.id,
        operations: [step(1, "plain", 1), step(2, "lcm", 2), step(3, "gcd", 3)],
        proposal: { source: "user-proposal", callId: "llm-call:plan" },
      },
      human,
      scene.definitions,
      { now: NOW },
    );
    expect(planned).toMatchObject({ status: "committed", replayed: false });
    // Step 1 needs no constant, step 2 activates Lcm, step 3 activates Gcd.
    expect(
      (await activations(scene.store)).map(({ symbol, commandId, sequence }) => [
        symbol,
        commandId,
        sequence,
      ]),
    ).toEqual([
      ["Lcm", "command:plan:step:2", 1],
      ["Gcd", "command:plan:step:3", 2],
    ]);
    expect(symbols((await current(scene.store)).session)).toEqual(["Divides", "Lcm", "Gcd"]);

    // A retry of the same plan replays it and records no further activation.
    const retried = await executeProposalPlan(
      scene.store,
      SESSION,
      {
        commandIdPrefix: "command:plan",
        expectedCurrentNodeId: root.id,
        operations: [step(1, "plain", 1), step(2, "lcm", 2), step(3, "gcd", 3)],
        proposal: { source: "user-proposal", callId: "llm-call:plan" },
      },
      human,
      scene.definitions,
      { now: NOW },
    );
    expect(retried).toMatchObject({ status: "committed", replayed: true });
    expect(await activations(scene.store)).toHaveLength(2);
  });

  it("offers a result that would activate a constant in retrieval, and not an unrelated one", async () => {
    const scene = await scenario(1, ["plain", "gcd"]);
    const loaded = await sessionDefinitions(APPROVED_DEFINITIONS, scene.store, SESSION);
    expect(loaded.libraryConstants?.map(({ symbol }) => symbol)).toEqual(["Gcd"]);
    // Neither the base catalog nor a session without such a library knows library constants.
    expect(APPROVED_DEFINITIONS.libraryConstants).toBeUndefined();
    const inEffect = loaded.catalog([DIVIDES]).results.map(({ id }) => id);
    expect(inEffect).toContain("result:test-plain");
    expect(inEffect).not.toContain("result:test-gcd");
    const merged = mergeLibraryOperators([[DIVIDES], [GCD]]);
    if (!merged.ok) throw new Error(merged.message);
    expect(loaded.catalog(merged.operators).results.map(({ id }) => id)).toContain(
      "result:test-gcd",
    );
  });

  it("reads the effective operators from the activations alone", async () => {
    const scene = await scenario(1);
    await apply(scene, { key: "both", goal: 1, commandId: "command:both" });
    const loaded = await scene.store.transaction((transaction) =>
      loadSession(transaction, SESSION as never, scene.definitions),
    );
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.failure));
    expect(loaded.setupOperators.map(({ symbol }) => symbol)).toEqual(["Divides"]);
    expect(loaded.activations.map(({ declaration }) => declaration)).toEqual([GCD, LCM]);
    expect(loaded.session.operators.map(({ symbol }) => symbol)).toEqual(["Divides", "Gcd", "Lcm"]);
    expect(libraryResult("both").operators).toEqual([GCD, LCM]);
  });
});
