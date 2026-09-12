import { afterEach, describe, expect, it } from "vitest";
import {
  createProofNodeSchema,
  type DisplayedSuggestionSet,
  type MovePreview,
  type PrepareProofCommandSuccess,
  type ProofEdge,
  type ProofNode,
} from "@proof/protocol";
import {
  DEVELOPMENT_PROOF_SESSION_ID,
  DEVELOPMENT_ROOT_NODE,
  ensureDevelopmentProofSession,
} from "../development-session";
import {
  initializeProofSession,
  type ProofSession,
  type ProofStore,
  type ProofStoreTransaction,
} from "../proof-repository";
import { createProofHttpService, type ProofHttpService } from ".";

class MemoryProofStore implements ProofStore {
  readonly sessions = new Map<string, ProofSession>();
  readonly nodes = new Map<string, ProofNode>();
  readonly suggestionSets = new Map<string, DisplayedSuggestionSet>();
  readonly previews = new Map<string, MovePreview>();
  readonly edges = new Map<string, ProofEdge>();
  readonly commands = new Map<string, PrepareProofCommandSuccess>();

  async transaction<Result>(
    work: (transaction: ProofStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    const transaction: ProofStoreTransaction = {
      lockSession: async (sessionId) => this.sessions.get(sessionId),
      readNode: async (sessionId, nodeId) => {
        const node = this.nodes.get(key(sessionId, nodeId));
        return node === undefined
          ? undefined
          : { sessionId, nodeId: node.id, stateId: node.state.id, node };
      },
      readCommand: async (sessionId, commandId) => this.commands.get(key(sessionId, commandId)),
      readSuggestionSet: async (sessionId, suggestionSetId) => {
        const suggestionSet = this.suggestionSets.get(key(sessionId, suggestionSetId));
        return suggestionSet === undefined
          ? undefined
          : {
              sessionId,
              suggestionSetId: suggestionSet.id,
              nodeId: suggestionSet.nodeId,
              stateId: suggestionSet.stateId,
              suggestionSet,
            };
      },
      readPreview: async (sessionId, previewId) => this.previews.get(key(sessionId, previewId)),
      listEdges: async (sessionId) =>
        [...this.edges.values()]
          .filter((edge) => this.nodes.has(key(sessionId, edge.parentNodeId)))
          .map((edge) => ({
            sessionId,
            edgeId: edge.id,
            parentNodeId: edge.parentNodeId,
            childNodeId: edge.childNodeId,
            commandId: edge.commandId,
            suggestionSetId: edge.suggestionSetId ?? null,
            chosenSuggestionId: edge.chosenSuggestionId ?? null,
            previewId: edge.previewId ?? null,
            edge,
          })),
      insertSession: async (session) => {
        this.sessions.set(session.id, structuredClone(session));
      },
      insertNode: async (sessionId, node) => {
        this.nodes.set(key(sessionId, node.id), structuredClone(node));
      },
      insertSuggestionSet: async (sessionId, suggestionSet) => {
        this.suggestionSets.set(key(sessionId, suggestionSet.id), structuredClone(suggestionSet));
      },
      insertPreview: async (sessionId, preview) => {
        this.previews.set(key(sessionId, preview.id), structuredClone(preview));
      },
      insertEdge: async (sessionId, edge) => {
        this.edges.set(key(sessionId, edge.id), structuredClone(edge));
      },
      insertEvent: async () => undefined,
      insertCommand: async (sessionId, result) => {
        this.commands.set(
          key(sessionId, result.prepared.command.commandId),
          structuredClone(result),
        );
      },
      advanceCurrentNode: async (sessionId, expectedNodeId, nextNodeId) => {
        const session = this.sessions.get(sessionId);
        if (session?.currentNodeId !== expectedNodeId) return false;
        this.sessions.set(sessionId, { ...session, currentNodeId: nextNodeId });
        return true;
      },
      repointCurrentNode: async (sessionId, expectedNodeId, targetNodeId) => {
        const session = this.sessions.get(sessionId);
        if (session?.currentNodeId !== expectedNodeId) return false;
        this.sessions.set(sessionId, { ...session, currentNodeId: targetNodeId });
        return true;
      },
    };
    return work(transaction);
  }
}

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function runningService(store: ProofStore): Promise<string> {
  const service = createProofHttpService(store);
  services.push(service);
  return (await service.listen()).origin;
}

function key(sessionId: string, recordId: string): string {
  return `${sessionId}\u0000${recordId}`;
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
});
