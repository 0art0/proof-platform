import { afterEach, describe, expect, it } from "vitest";
import {
  createProofNodeSchema,
  type DisplayedSuggestionSet,
  type ProofNode,
} from "@proof/protocol";
import {
  DEVELOPMENT_PROOF_SESSION_ID,
  DEVELOPMENT_ROOT_NODE,
  ensureDevelopmentProofSession,
} from "../development-session";
import type { ProofSession, ProofStore, ProofStoreTransaction } from "../proof-repository";
import { createProofHttpService, type ProofHttpService } from ".";

class MemoryProofStore implements ProofStore {
  readonly sessions = new Map<string, ProofSession>();
  readonly nodes = new Map<string, ProofNode>();
  readonly suggestionSets = new Map<string, DisplayedSuggestionSet>();

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
      readCommand: async () => undefined,
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
      readPreview: async () => undefined,
      insertSession: async (session) => {
        this.sessions.set(session.id, structuredClone(session));
      },
      insertNode: async (sessionId, node) => {
        this.nodes.set(key(sessionId, node.id), structuredClone(node));
      },
      insertSuggestionSet: async (sessionId, suggestionSet) => {
        this.suggestionSets.set(key(sessionId, suggestionSet.id), structuredClone(suggestionSet));
      },
      insertPreview: async () => undefined,
      insertEdge: async () => undefined,
      insertEvent: async () => undefined,
      insertCommand: async () => undefined,
      advanceCurrentNode: async (sessionId, expectedNodeId, nextNodeId) => {
        const session = this.sessions.get(sessionId);
        if (session?.currentNodeId !== expectedNodeId) return false;
        this.sessions.set(sessionId, { ...session, currentNodeId: nextNodeId });
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
    expect(read).toEqual({ suggestionSet: recorded.suggestionSet });
  });
});
