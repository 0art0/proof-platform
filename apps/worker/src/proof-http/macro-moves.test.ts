import { afterEach, describe, expect, it } from "vitest";
import type { ProofNode } from "@proof/protocol";
import {
  MACRO_ID,
  ROOT_ID,
  choiceOf,
  macroTemplate,
  startMacroSession,
  type Json,
} from "../macro-move.testing";
import type { ProofHttpService } from ".";

/** N35: approved multi-step macros are retrievable, previewable and applicable over HTTP. */

const services: ProofHttpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("approved multi-step macros", () => {
  it("offers a macro only when approved, previews every step and applies them atomically", async () => {
    const client = await startMacroSession(services);
    const { drafted, approve } = await client.approve(macroTemplate());
    expect(drafted.body.result.validation).toMatchObject({ ok: true });

    // A draft is never offered.
    expect((await client.macroChoice("command:draft-probe")).choice).toBeUndefined();

    const approved = await approve();
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.result.retrievable).toBe(true);
    expect((await client.get("authored-moves")).body.moves[0]).toMatchObject({
      moveId: MACRO_ID,
      retrievable: true,
    });

    const { body, choice } = await client.macroChoice("command:macro-apply");
    if (choice === undefined) throw new Error("The approved macro was not offered.");
    const offered = (body.suggestionSet.suggestions as Json[]).find(
      ({ artifactId }) => artifactId === MACRO_ID,
    );
    expect(offered).toMatchObject({ source: "move", applicability: "applicable" });
    // The class the card shows is the composed class, not the first primitive's.
    expect(body.transitionClasses).toEqual(
      expect.arrayContaining([{ suggestionId: offered?.id, transitionClass: "equivalence" }]),
    );

    // Preview: the final state, the composed class and per-step outcomes; nothing advances.
    const previewed = await client.post("move-previews", choice);
    expect(previewed.status, JSON.stringify(previewed.body)).toBe(201);
    const { preview } = previewed.body;
    expect(preview).toMatchObject({
      moveId: MACRO_ID,
      nodeId: ROOT_ID,
      transitionClass: "equivalence",
      macro: {
        steps: [
          { index: 1, id: "step-1", moveId: "move:introduce-implication" },
          { index: 2, id: "step-2", moveId: "move:introduce-implication" },
        ],
      },
    });
    expect(preview.afterState.goals[0].sequent.conclusion.expression).toBe("r");
    expect(preview.afterState.goals[0].sequent.context.hypotheses).toHaveLength(2);
    expect(preview.delta.goals.updated).toEqual(["goal:main"]);
    expect((await client.get("")).body.session.currentNodeId).toBe(ROOT_ID);
    expect(((await client.get("history")).body.nodes as Json[]).length).toBe(1);

    // Apply: two ordinary nodes, cursor at the last, receipt of the last step.
    const applied = await client.post("commands", choice);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const lastNodeId = "node:command:macro-apply:macro:2";
    expect(applied.body).toMatchObject({
      replayed: false,
      session: { currentNodeId: lastNodeId },
      node: { id: lastNodeId },
      receipt: { commandId: "command:macro-apply:macro:2" },
    });
    expect(applied.body.node.state).toEqual(preview.afterState);

    // History: both edges are labelled with the macro and their step index.
    const history = (await client.get("history")).body;
    expect((history.nodes as Json[]).map(({ id }) => id)).toEqual([
      ROOT_ID,
      "node:command:macro-apply:macro:1",
      lastNodeId,
    ]);
    const edges = (history.edges as Json[]).map(({ edge }) => edge);
    expect(
      edges.map(({ moveId, macro }) => [moveId, macro.moveId, macro.stepIndex, macro.stepCount]),
    ).toEqual([
      ["move:introduce-implication", MACRO_ID, 1, 2],
      ["move:introduce-implication", MACRO_ID, 2, 2],
    ]);
    expect(edges[0]?.macro.previewId).toBe(preview.id);
    expect(edges.map(({ transitionClass }) => transitionClass)).toEqual([
      "equivalence",
      "equivalence",
    ]);

    // Idempotent by command ID.
    const replayed = await client.post("commands", choice);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ replayed: true, session: { currentNodeId: lastNodeId } });
    expect(((await client.get("history")).body.nodes as Json[]).length).toBe(3);

    // A retry after the cursor moved on is a stale-command conflict, and writes nothing.
    const back = await client.post("backtrack", {
      expectedCurrentNodeId: lastNodeId,
      targetNodeId: ROOT_ID,
    });
    expect(back.status).toBe(200);
    const stale = await client.post("commands", choice);
    expect(stale.status).toBe(409);
    expect(stale.body.diagnostics[0].code).toBe("serialized-stale-command");
    expect(((await client.get("history")).body.nodes as Json[]).length).toBe(3);
  });

  it("reports the step that fails to re-match and writes nothing", async () => {
    // A looser first-step pattern offers the macro on `p implies q`, whose second step cannot match.
    const client = await startMacroSession(services, ["Implies", "p", "q"]);
    const { approve } = await client.approve(macroTemplate({ generic: true }));
    const approved = await approve();
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const { choice } = await client.macroChoice("command:macro-mismatch");
    if (choice === undefined) throw new Error("The macro was not offered.");

    for (const path of ["move-previews", "commands"]) {
      const refused = await client.post(path, choice);
      expect(refused.status, `${path}: ${JSON.stringify(refused.body)}`).toBe(422);
      expect(refused.body.diagnostics[0].code).toBe("macro-step-failed");
      expect(refused.body.diagnostics[0].message).toMatch(/Macro step 2 of 2 \(step-2\)/);
    }
    const history = (await client.get("history")).body;
    expect((history.nodes as Json[]).length).toBe(1);
    expect((await client.get("")).body.session.currentNodeId).toBe(ROOT_ID);
  });

  it("deletes the whole macro application with one delete-previous-move", async () => {
    const client = await startMacroSession(services);
    const { approve } = await client.approve(macroTemplate());
    await approve();
    const { choice } = await client.macroChoice("command:macro-delete");
    if (choice === undefined) throw new Error("The macro was not offered.");
    expect((await client.post("commands", choice)).status).toBe(201);

    const lastNodeId = "node:command:macro-delete:macro:2";
    const deleted = await client.post("delete-previous-move", {
      commandId: "command:delete-macro",
      expectedCurrentNodeId: lastNodeId,
    });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.receipt).toMatchObject({
      deletedNodeIds: [lastNodeId, "node:command:macro-delete:macro:1"],
      currentNodeId: ROOT_ID,
    });
    const history = (await client.get("history")).body;
    expect((history.nodes as ProofNode[]).map(({ id }) => id)).toEqual([ROOT_ID]);
    expect((await client.get("")).body.session.currentNodeId).toBe(ROOT_ID);

    // The deleted command stays deleted; a new command ID applies the macro again.
    const again = await client.post("commands", choice);
    expect(again.status).toBe(409);
    expect(again.body.diagnostics[0].code).toBe("command-deleted");
    const fresh = await client.macroChoice("command:macro-delete-again");
    expect(fresh.choice).toBeDefined();
    expect((await client.post("commands", fresh.choice)).status).toBe(201);
  });

  it("asks for confirmation only for work branched off a macro application", async () => {
    const client = await startMacroSession(services);
    const { approve } = await client.approve(macroTemplate());
    await approve();
    const { choice } = await client.macroChoice("command:macro-branch");
    if (choice === undefined) throw new Error("The macro was not offered.");
    expect((await client.post("commands", choice)).status).toBe(201);
    const first = "node:command:macro-branch:macro:1";
    const last = "node:command:macro-branch:macro:2";

    // Branch from the macro's intermediate node with an ordinary move.
    expect(
      (await client.post("backtrack", { expectedCurrentNodeId: last, targetNodeId: first })).status,
    ).toBe(200);
    const body = await client.suggest();
    const intro = (body.suggestionSet.suggestions as Json[]).find(
      ({ artifactId }) => artifactId === "move:introduce-implication",
    );
    expect(intro).toBeDefined();
    const branched = await client.post("commands", choiceOf(body, intro as Json, "command:branch"));
    expect(branched.status, JSON.stringify(branched.body)).toBe(201);
    const branchNode = branched.body.node.id as string;
    // Delete the branch (a single ordinary move, nothing to confirm).
    const deleted = await client.post("delete-previous-move", {
      commandId: "command:delete-branch",
      expectedCurrentNodeId: branchNode,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.receipt.currentNodeId).toBe(first);

    // Back at the macro's end, deleting removes both steps without confirmation.
    expect(
      (await client.post("backtrack", { expectedCurrentNodeId: first, targetNodeId: last })).status,
    ).toBe(200);
    const whole = await client.post("delete-previous-move", {
      commandId: "command:delete-whole",
      expectedCurrentNodeId: last,
    });
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    expect(whole.body.receipt.currentNodeId).toBe(ROOT_ID);
  });
});
