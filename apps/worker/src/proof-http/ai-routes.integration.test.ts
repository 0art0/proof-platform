import { afterEach, describe, expect, it } from "vitest";
import type { LlmTransport } from "@proof/llm";
import {
  DEVELOPMENT_PROOF_SESSION_ID,
  DEVELOPMENT_ROOT_NODE,
  ensureDevelopmentProofSession,
} from "../development-session";
import { MemoryLlmCallStore } from "../memory-llm-call-store";
import type { ProofStore } from "../proof-repository";
import { InspectableMemoryProofStore, key } from "../memory-proof-store.testing";
import type { AiRoleRuntime } from "../ai-runtime";
import { createProofNodeSchema } from "@proof/protocol";
import { createProofHttpService, type ProofHttpService } from ".";

const services: ProofHttpService[] = [];
const dispatch = {
  provider: "fixture",
  model: "fixture-jev",
  promptVersion: "ai-routes-integration-v1",
  minimumConfidence: 0.55,
} as const;

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function json<Value>(response: Response): Promise<Value> {
  return (await response.json()) as Value;
}

async function createScenario(transport: LlmTransport) {
  const store = new InspectableMemoryProofStore();
  const llmCalls = new MemoryLlmCallStore();
  await ensureDevelopmentProofSession(store);
  const ai: AiRoleRuntime = { transport, dispatch };
  const service = createProofHttpService(store as ProofStore, {
    env: {},
    llmCalls,
    ai: { "move-shortlister": ai },
  });
  services.push(service);
  const origin = (await service.listen()).origin;
  const sessionPath = `/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}`;
  const current = await json<{
    node: { id: string; state: unknown };
    session: { currentNodeId: string };
  }>(await fetch(`${origin}${sessionPath}`));
  const setResponse = await fetch(`${origin}${sessionPath}/suggestion-sets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "suggestion-set:ai-route-test",
      selections: [
        {
          kind: "exact",
          anchor: {
            stateId: "state:development-root",
            target: { kind: "goal", id: "goal:development-main" },
            statement: { kind: "conclusion" },
          },
          path: [],
        },
      ],
    }),
  });
  expect(setResponse.status).toBe(201);
  const { suggestionSet } = await json<{
    suggestionSet: { id: string; suggestions: readonly { id: string }[] };
  }>(setResponse);
  expect(suggestionSet.suggestions.length).toBeGreaterThan(0);
  const candidateIds = suggestionSet.suggestions.map(({ id }) => id);
  return {
    store,
    llmCalls,
    origin,
    sessionPath,
    suggestionSet,
    candidateIds,
    initialNodeId: current.session.currentNodeId,
    shortlist: () =>
      fetch(`${origin}${sessionPath}/ai/shortlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "llm-call:ai-route-test",
          expectedCurrentNodeId: current.session.currentNodeId,
          suggestionSetId: suggestionSet.id,
          candidateIds,
          trigger: "explicit-user",
        }),
      }),
  };
}

function jevTransport(): LlmTransport {
  return async (call) => {
    if (call.envelope.role !== "move-shortlister") return null;
    const candidates = call.envelope.context.candidates;
    const choice = candidates[0];
    if (choice === undefined) return null;
    return {
      kind: "jev-choice",
      minimumConfidence: dispatch.minimumConfidence,
      providerRequest: {
        model: "typesafe-ai/jev",
        state: call.envelope,
        questions: {
          shortlist: {
            type: "choice",
            instructions: "Choose the strongest displayed candidate.",
            criteria: Object.fromEntries(candidates.map(({ id, name }) => [id, name])),
          },
        },
      },
      providerOutput: {
        type: "choice",
        choice: choice.id,
        probabilities: Object.fromEntries(
          candidates.map(({ id }) => [id, id === choice.id ? 1 : 0]),
        ),
        confidence: 0.99,
      },
    };
  };
}

describe("AI routes over the proof HTTP service", () => {
  it("stores a valid shortlist call and does not mutate the proof session", async () => {
    const scenario = await createScenario(jevTransport());
    const before = await json<{ session: { currentNodeId: string }; node: { id: string } }>(
      await fetch(`${scenario.origin}${scenario.sessionPath}`),
    );
    const response = await scenario.shortlist();
    expect(response.status).toBe(200);
    const result = await json<{ status: string; callId: string; choices: unknown[] }>(response);
    expect(result).toMatchObject({
      status: "shortlisted",
      choices: [{ suggestionId: expect.any(String) }],
    });

    const after = await json<{ session: { currentNodeId: string }; node: { id: string } }>(
      await fetch(`${scenario.origin}${scenario.sessionPath}`),
    );
    expect(after.session.currentNodeId).toBe(scenario.initialNodeId);
    expect(after.node.id).toBe(before.node.id);
    const history = await json<{ edges: unknown[] }>(
      await fetch(`${scenario.origin}${scenario.sessionPath}/history`),
    );
    expect(history.edges).toHaveLength(0);

    const evidence = await json<{
      records: Array<{ id: string; role: string; status: string; evidence: { status: string } }>;
    }>(await fetch(`${scenario.origin}${scenario.sessionPath}/llm-calls`));
    expect(evidence.records).toHaveLength(1);
    expect(evidence.records[0]).toMatchObject({
      id: result.callId,
      role: "move-shortlister",
      status: "completed",
      evidence: { status: "validated" },
    });
  });

  it.each([
    ["malformed", async () => ({ invalid: true }), "rejected"],
    ["declined", async () => ({ kind: "declined", reason: "Insufficient context." }), "validated"],
  ] as const)(
    "uses deterministic fallback for a %s response without proof mutation",
    async (_label, transport, evidenceStatus) => {
      const scenario = await createScenario(transport);
      const response = await scenario.shortlist();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "deterministic-fallback",
        provenance: "deterministic",
        choices: [],
        fallbackCandidateIds: scenario.candidateIds,
      });
      const state = await json<{ session: { currentNodeId: string } }>(
        await fetch(`${scenario.origin}${scenario.sessionPath}`),
      );
      expect(state.session.currentNodeId).toBe(scenario.initialNodeId);
      const calls = await json<{ records: Array<{ evidence: { status: string } }> }>(
        await fetch(`${scenario.origin}${scenario.sessionPath}/llm-calls`),
      );
      expect(calls.records).toHaveLength(1);
      expect(calls.records[0]?.evidence.status).toBe(evidenceStatus);
    },
  );

  it("includes session-owned LLM evidence in the exported artifact", async () => {
    const scenario = await createScenario(jevTransport());
    const shortlist = await scenario.shortlist();
    expect(shortlist.status).toBe(200);
    const exported = await fetch(
      `${scenario.origin}${scenario.sessionPath}/export?confirmPrivateExport=true`,
    );
    expect(exported.status).toBe(200);
    const artifact = await json<{
      llmCalls: Array<{ role: string; evidence: { status: string } }>;
    }>(exported);
    expect(artifact.llmCalls).toHaveLength(1);
    expect(artifact.llmCalls[0]).toMatchObject({
      role: "move-shortlister",
      evidence: { status: "validated" },
    });
  });

  it("rejects a shortlist as stale if the proof node changes while the model is responding", async () => {
    let startDispatch!: () => void;
    let resumeDispatch!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      startDispatch = resolve;
    });
    const dispatchPaused = new Promise<void>((resolve) => {
      resumeDispatch = resolve;
    });
    const responseTransport = jevTransport();
    const transport: LlmTransport = async (call) => {
      startDispatch();
      await dispatchPaused;
      return responseTransport(call);
    };
    const scenario = await createScenario(transport);
    const pending = scenario.shortlist();
    await dispatchStarted;

    const child = createProofNodeSchema().parse({
      ...DEVELOPMENT_ROOT_NODE,
      id: "node:development-ai-race-child",
      state: { ...DEVELOPMENT_ROOT_NODE.state, id: "state:development-ai-race-child" },
    });
    scenario.store.nodes.set(key(DEVELOPMENT_PROOF_SESSION_ID, child.id), child);
    const session = scenario.store.sessions.get(DEVELOPMENT_PROOF_SESSION_ID);
    if (session === undefined) throw new Error("The test session was not initialized.");
    scenario.store.sessions.set(DEVELOPMENT_PROOF_SESSION_ID, {
      ...session,
      currentNodeId: child.id,
    });

    resumeDispatch();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "stale",
      provenance: "deterministic",
      choices: [],
      stale: true,
      fallbackCandidateIds: [],
    });
  });

  it("uses deterministic fallback for a read-only session without dispatching the model", async () => {
    let dispatchCount = 0;
    const responseTransport = jevTransport();
    const scenario = await createScenario(async (call) => {
      dispatchCount += 1;
      return responseTransport(call);
    });
    const session = scenario.store.sessions.get(DEVELOPMENT_PROOF_SESSION_ID);
    if (session === undefined) throw new Error("The test session was not initialized.");
    scenario.store.sessions.set(DEVELOPMENT_PROOF_SESSION_ID, { ...session, readOnly: true });

    const response = await scenario.shortlist();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "deterministic-fallback",
      provenance: "deterministic",
      choices: [],
      fallbackCandidateIds: scenario.candidateIds,
    });
    expect(dispatchCount).toBe(0);
    expect(
      await scenario.llmCalls.listCallsForOwner({
        kind: "proof-session",
        id: DEVELOPMENT_PROOF_SESSION_ID,
      }),
    ).toEqual([]);
  });
});
