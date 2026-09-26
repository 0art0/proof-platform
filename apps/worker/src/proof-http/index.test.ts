import { afterEach, describe, expect, it } from "vitest";
import {
  createProofNodeSchema,
  type DisplayedSuggestionSet,
  type ProofEdge,
} from "@proof/protocol";
import {
  DEVELOPMENT_PROOF_SESSION_ID,
  DEVELOPMENT_ROOT_NODE,
  DEVELOPMENT_SESSION_METADATA,
  ensureDevelopmentProofSession,
} from "../development-session";
import { initializeProofSession, type ProofStore } from "../proof-repository";
import {
  InspectableMemoryProofStore as MemoryProofStore,
  key,
} from "../memory-proof-store.testing";
import { createProofHttpService, type ProofHttpService } from ".";

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function runningService(store: ProofStore): Promise<string> {
  const service = createProofHttpService(store);
  services.push(service);
  return (await service.listen()).origin;
}

function goalAnchor() {
  return {
    stateId: "state:development-root",
    target: { kind: "goal", id: "goal:development-main" },
    statement: { kind: "conclusion" },
  } as const;
}

function exactGoal(path: readonly number[] = []) {
  return { kind: "exact", anchor: goalAnchor(), path } as const;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("proof HTTP service", () => {
  it("initializes the nontrivial development fixture once without resetting later history", async () => {
    const store = new MemoryProofStore();
    const initialized = await ensureDevelopmentProofSession(store);
    expect(initialized).toMatchObject({ status: "ready", created: true });
    const goal = DEVELOPMENT_ROOT_NODE.state.goals[0];
    const obligation = DEVELOPMENT_ROOT_NODE.state.obligations[0];
    expect(goal?.sequent.context.declarations.map(({ symbol }) => symbol)).toEqual(["p", "q"]);
    expect(obligation?.sequent.context.declarations.map(({ symbol }) => symbol)).toEqual([
      "r",
      "s",
    ]);
    expect(goal?.sequent.conclusion.expression).toEqual(["And", "p", "p", "q"]);
    expect(goal?.sequent.context.hypotheses[0]?.statement.expression).toEqual(["And", "p", "q"]);

    const child = createProofNodeSchema().parse({
      ...DEVELOPMENT_ROOT_NODE,
      id: "node:development-child",
      state: { ...DEVELOPMENT_ROOT_NODE.state, id: "state:development-child" },
    });
    store.nodes.set(key(DEVELOPMENT_PROOF_SESSION_ID, child.id), child);
    const session = store.sessions.get(DEVELOPMENT_PROOF_SESSION_ID);
    if (session === undefined) throw new Error("Expected the initialized development session.");
    store.sessions.set(DEVELOPMENT_PROOF_SESSION_ID, {
      ...session,
      currentNodeId: child.id,
    });

    expect(await ensureDevelopmentProofSession(store)).toMatchObject({
      status: "ready",
      created: false,
      session: { currentNodeId: child.id },
      node: { id: child.id },
    });
    expect(store.nodes.size).toBe(2);
  });

  it("exposes the runtime-validated current session with each sequent context intact", async () => {
    const store = new MemoryProofStore();
    expect(await ensureDevelopmentProofSession(store)).toMatchObject({
      status: "ready",
      created: true,
    });
    const origin = await runningService(store);

    const response = await fetch(`${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}`);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({
      session: { id: DEVELOPMENT_PROOF_SESSION_ID, currentNodeId: "node:development-root" },
      node: {
        state: {
          goals: [
            {
              sequent: {
                context: { declarations: [{ symbol: "p" }, { symbol: "q" }] },
              },
            },
          ],
          obligations: [
            {
              sequent: {
                context: { declarations: [{ symbol: "r" }, { symbol: "s" }] },
              },
            },
          ],
        },
      },
    });
  });

  it("returns session metadata only when requested and never inside the session object", async () => {
    const store = new MemoryProofStore();
    await ensureDevelopmentProofSession(store);
    expect(store.sessions.get(DEVELOPMENT_PROOF_SESSION_ID)?.metadata).toEqual(
      DEVELOPMENT_SESSION_METADATA,
    );
    const origin = await runningService(store);
    const url = `${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}`;

    const plain = await json(await fetch(url));
    expect(Object.keys(plain).sort()).toEqual(["node", "session"]);
    expect(plain.session).not.toHaveProperty("metadata");

    const requested = await json(await fetch(`${url}?include=metadata`));
    expect(requested.metadata).toEqual(DEVELOPMENT_SESSION_METADATA);
    expect(requested.session).not.toHaveProperty("metadata");
    expect(requested.metadata).toMatchObject({
      background: { level: "elementary propositional logic" },
    });

    const history = await json(await fetch(`${url}/history`));
    expect(history.session).not.toHaveProperty("metadata");
  });

  it("omits metadata for legacy sessions even when requested", async () => {
    const store = new MemoryProofStore();
    await initializeProofSession(store, {
      sessionId: "session:legacy",
      rootNode: DEVELOPMENT_ROOT_NODE,
    });
    const origin = await runningService(store);
    const body = await json(
      await fetch(`${origin}/proof-sessions/session:legacy?include=metadata`),
    );
    expect(Object.keys(body).sort()).toEqual(["node", "session"]);
  });

  it("records exact and associative selections and replays only an identical anchored request", async () => {
    const store = new MemoryProofStore();
    await ensureDevelopmentProofSession(store);
    const origin = await runningService(store);
    const url = `${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}/suggestion-sets`;
    const request = {
      id: "suggestion-set:http-associative",
      selections: [
        {
          kind: "associative",
          anchor: goalAnchor(),
          containerPath: [],
          startOperand: 0,
          endOperand: 2,
          displayRange: [4, 11],
        },
      ],
    };
    const first = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(first.status).toBe(201);
    expect(await json(first)).toMatchObject({
      replayed: false,
      suggestionSet: {
        selection: {
          kind: "associative",
          fragment: ["And", "p", "p"],
          coveredOperandPaths: [[0], [1]],
        },
      },
    });

    const replay = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(200);
    expect(await json(replay)).toMatchObject({ replayed: true });

    const conflict = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, selections: [exactGoal([1])] }),
    });
    expect(conflict.status).toBe(400);
  });

  it("builds multiselection queries and the approved catalog only on the server", async () => {
    const store = new MemoryProofStore();
    await ensureDevelopmentProofSession(store);
    const origin = await runningService(store);
    const response = await fetch(
      `${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}/suggestion-sets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "suggestion-set:http-two-selection",
          selections: [
            exactGoal(),
            {
              kind: "exact",
              anchor: {
                ...goalAnchor(),
                statement: {
                  kind: "hypothesis",
                  id: "hypothesis:development-conjunction",
                },
              },
              path: [],
            },
          ],
        }),
      },
    );
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body).toMatchObject({
      suggestionSet: { selection: { kind: "selection-query" } },
    });
    expect(
      ((body.suggestionSet as DisplayedSuggestionSet).suggestions ?? []).some(
        ({ artifactId }) => artifactId === "move:expand-hypothesis-conjunction",
      ),
    ).toBe(true);
  });

  it.each([
    ["client-resolved fields", { ...exactGoal(), fragment: "p" }],
    ["selection queries", { kind: "selection-query", selections: [exactGoal()] }],
    ["stale anchors", { ...exactGoal(), anchor: { ...goalAnchor(), stateId: "state:stale" } }],
  ])("rejects %s", async (_caseName, selection) => {
    const store = new MemoryProofStore();
    await ensureDevelopmentProofSession(store);
    const origin = await runningService(store);
    const response = await fetch(
      `${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}/suggestion-sets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "suggestion-set:rejected", selections: [selection] }),
      },
    );
    expect(response.status).toBe(400);
    expect(store.suggestionSets.size).toBe(0);
  });

  it("rejects client options and catalogs and reads the exact persisted order and reasons", async () => {
    const store = new MemoryProofStore();
    await ensureDevelopmentProofSession(store);
    const origin = await runningService(store);
    const collection = `${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}/suggestion-sets`;
    for (const extra of [
      { options: { limit: 100 } },
      { catalog: { results: [], moves: [], variantFamilies: [] } },
    ]) {
      const rejected = await fetch(collection, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "suggestion-set:extra", selections: [exactGoal()], ...extra }),
      });
      expect(rejected.status).toBe(400);
    }

    const recordedResponse = await fetch(collection, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "suggestion-set:persisted", selections: [exactGoal()] }),
    });
    const recorded = await json(recordedResponse);
    const restartedOrigin = await runningService(store);
    const readResponse = await fetch(
      `${restartedOrigin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}/suggestion-sets/suggestion-set%3Apersisted`,
    );
    expect(readResponse.status).toBe(200);
    const read = await json(readResponse);
    expect(read).toEqual({
      suggestionSet: recorded.suggestionSet,
      transitionClasses: recorded.transitionClasses,
    });
  });

  it("previews without advancing, applies, rejects stale apply, and retains sibling branches", async () => {
    const store = new MemoryProofStore();
    const binaryRoot = createProofNodeSchema().parse({
      ...DEVELOPMENT_ROOT_NODE,
      state: {
        ...DEVELOPMENT_ROOT_NODE.state,
        goals: [
          {
            ...DEVELOPMENT_ROOT_NODE.state.goals[0],
            sequent: {
              ...DEVELOPMENT_ROOT_NODE.state.goals[0]?.sequent,
              conclusion: { expression: ["And", "p", "q"] },
            },
          },
        ],
      },
    });
    expect(
      await initializeProofSession(store, {
        sessionId: DEVELOPMENT_PROOF_SESSION_ID,
        rootNode: binaryRoot,
      }),
    ).toMatchObject({ status: "committed" });
    const origin = await runningService(store);
    const sessionUrl = `${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}`;
    const suggestionsUrl = `${sessionUrl}/suggestion-sets`;
    const firstResponse = await fetch(suggestionsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "suggestion-set:http-first-branch",
        selections: [exactGoal()],
      }),
    });
    expect(firstResponse.status).toBe(201);
    const firstBody = await json(firstResponse);
    const firstSet = firstBody.suggestionSet as DisplayedSuggestionSet;
    const split = firstSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:split-goal-conjunction",
    );
    if (split === undefined) {
      throw new Error(
        `Expected split; received ${JSON.stringify(firstSet.suggestions.map(({ artifactId, applicability }) => ({ artifactId, applicability })))}`,
      );
    }
    expect(split).toMatchObject({ applicability: "applicable", reasons: expect.any(Array) });
    expect(firstBody.transitionClasses).toEqual(
      expect.arrayContaining([{ suggestionId: split.id, transitionClass: "equivalence" }]),
    );
    const firstChoice = {
      commandId: "command:http-first-branch",
      suggestionSetId: firstSet.id,
      chosenSuggestionId: split.id,
    };

    const previewResponse = await fetch(`${sessionUrl}/move-previews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(firstChoice),
    });
    expect(previewResponse.status).toBe(201);
    expect(await json(previewResponse)).toMatchObject({
      replayed: false,
      preview: {
        id: "preview:command:http-first-branch",
        nodeId: "node:development-root",
        transitionClass: "equivalence",
        operation: {
          kind: "split-goal-conjunction",
          childIds: [
            "statement:command:http-first-branch:child:1",
            "statement:command:http-first-branch:child:2",
          ],
        },
      },
    });
    expect(await json(await fetch(sessionUrl))).toMatchObject({
      session: { currentNodeId: "node:development-root" },
      node: { id: "node:development-root" },
    });

    const applyResponse = await fetch(`${sessionUrl}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(firstChoice),
    });
    expect(applyResponse.status).toBe(201);
    const applied = await json(applyResponse);
    expect(applied).toMatchObject({
      replayed: false,
      session: { currentNodeId: "node:command:http-first-branch" },
      node: { id: "node:command:http-first-branch" },
      receipt: { commandId: firstChoice.commandId },
    });

    const applyReplay = await fetch(`${sessionUrl}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(firstChoice),
    });
    expect(applyReplay.status).toBe(200);
    expect(await json(applyReplay)).toMatchObject({
      replayed: true,
      session: { currentNodeId: "node:command:http-first-branch" },
    });

    const stalePreviewReplay = await fetch(`${sessionUrl}/move-previews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(firstChoice),
    });
    expect(stalePreviewReplay.status).toBe(409);
    expect(await json(stalePreviewReplay)).toMatchObject({
      diagnostics: [{ code: "preview-rejected" }],
    });

    const staleApply = await fetch(`${sessionUrl}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...firstChoice, commandId: "command:http-stale" }),
    });
    expect(staleApply.status).toBe(400);
    expect(await json(await fetch(sessionUrl))).toMatchObject({
      session: { currentNodeId: "node:command:http-first-branch" },
    });

    const backtrack = await fetch(`${sessionUrl}/backtrack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedCurrentNodeId: "node:command:http-first-branch",
        targetNodeId: "node:development-root",
      }),
    });
    expect(backtrack.status).toBe(200);
    expect(await json(backtrack)).toMatchObject({
      session: { currentNodeId: "node:development-root" },
      node: { id: "node:development-root" },
    });

    const secondResponse = await fetch(suggestionsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "suggestion-set:http-second-branch",
        selections: [
          exactGoal(),
          {
            kind: "exact",
            anchor: {
              ...goalAnchor(),
              statement: {
                kind: "hypothesis",
                id: "hypothesis:development-conjunction",
              },
            },
            path: [],
          },
        ],
      }),
    });
    expect(secondResponse.status).toBe(201);
    const secondSet = (await json(secondResponse)).suggestionSet as DisplayedSuggestionSet;
    const expand = secondSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:expand-hypothesis-conjunction",
    );
    expect(expand).toMatchObject({ applicability: "applicable" });
    if (expand === undefined) throw new Error("Expected an applicable hypothesis expansion.");
    const secondChoice = {
      commandId: "command:http-second-branch",
      suggestionSetId: secondSet.id,
      chosenSuggestionId: expand.id,
    };
    const secondApply = await fetch(`${sessionUrl}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(secondChoice),
    });
    expect(secondApply.status).toBe(201);
    expect(await json(secondApply)).toMatchObject({
      session: { currentNodeId: "node:command:http-second-branch" },
    });

    const historyResponse = await fetch(`${sessionUrl}/history`);
    expect(historyResponse.status).toBe(200);
    const history = await json(historyResponse);
    expect(history).toMatchObject({
      session: { currentNodeId: "node:command:http-second-branch" },
      nodes: [{ id: "node:development-root" }, {}, {}],
    });
    const rootEdges = (history.edges as Array<{ edge: ProofEdge }>).filter(
      ({ edge }) => edge.parentNodeId === "node:development-root",
    );
    expect(rootEdges).toHaveLength(2);
    expect(new Set(rootEdges.map(({ edge }) => edge.childNodeId)).size).toBe(2);
  });

  it("deletes the previous move idempotently and blocks replay of the deleted command", async () => {
    const store = new MemoryProofStore();
    const binaryRoot = createProofNodeSchema().parse({
      ...DEVELOPMENT_ROOT_NODE,
      state: {
        ...DEVELOPMENT_ROOT_NODE.state,
        goals: [
          {
            ...DEVELOPMENT_ROOT_NODE.state.goals[0],
            sequent: {
              ...DEVELOPMENT_ROOT_NODE.state.goals[0]?.sequent,
              conclusion: { expression: ["And", "p", "q"] },
            },
          },
        ],
      },
    });
    expect(
      await initializeProofSession(store, {
        sessionId: DEVELOPMENT_PROOF_SESSION_ID,
        rootNode: binaryRoot,
      }),
    ).toMatchObject({ status: "committed" });
    const origin = await runningService(store);
    const sessionUrl = `${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}`;
    const post = (path: string, body: unknown) =>
      fetch(`${sessionUrl}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const suggestions = await post("suggestion-sets", {
      id: "suggestion-set:http-delete",
      selections: [exactGoal()],
    });
    expect(suggestions.status).toBe(201);
    const set = (await json(suggestions)).suggestionSet as DisplayedSuggestionSet;
    const split = set.suggestions.find(
      ({ artifactId, applicability }) =>
        artifactId === "move:split-goal-conjunction" && applicability === "applicable",
    );
    if (split === undefined) throw new Error("Expected an applicable split.");
    const choice = {
      commandId: "command:http-accident",
      suggestionSetId: set.id,
      chosenSuggestionId: split.id,
    };
    expect((await post("commands", choice)).status).toBe(201);

    const stale = await post("delete-previous-move", {
      commandId: "command:http-delete",
      expectedCurrentNodeId: "node:development-root",
    });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({
      diagnostics: [{ code: "serialized-stale-delete" }],
    });
    const clientActor = await post("delete-previous-move", {
      commandId: "command:http-delete",
      expectedCurrentNodeId: "node:command:http-accident",
      actor: { id: "actor:someone", kind: "agent" },
    });
    expect(clientActor.status).toBe(400);

    const request = {
      commandId: "command:http-delete",
      expectedCurrentNodeId: "node:command:http-accident",
      reason: "Wrong move.",
    };
    const deleted = await post("delete-previous-move", request);
    expect(deleted.status).toBe(200);
    const deletedBody = await json(deleted);
    expect(deletedBody).toEqual({
      session: expect.objectContaining({ currentNodeId: "node:development-root" }),
      node: expect.objectContaining({ id: "node:development-root" }),
      receipt: {
        deletedNodeIds: ["node:command:http-accident"],
        deletedEdgeIds: ["edge:command:http-accident"],
        currentNodeId: "node:development-root",
      },
      replayed: false,
    });
    const retried = await post("delete-previous-move", request);
    expect(retried.status).toBe(200);
    expect(await json(retried)).toEqual({ ...deletedBody, replayed: true });

    const history = await json(await fetch(`${sessionUrl}/history`));
    expect(history).toMatchObject({ nodes: [{ id: "node:development-root" }], edges: [] });

    const replayedApply = await post("commands", choice);
    expect(replayedApply.status).toBe(409);
    expect(await json(replayedApply)).toMatchObject({
      diagnostics: [{ code: "command-deleted" }],
    });

    const atRoot = await post("delete-previous-move", {
      commandId: "command:http-delete-root",
      expectedCurrentNodeId: "node:development-root",
    });
    expect(atRoot.status).toBe(400);
    expect(await json(atRoot)).toMatchObject({ diagnostics: [{ code: "delete-rejected" }] });

    const wrongMethod = await fetch(`${sessionUrl}/delete-previous-move`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
  });
});
