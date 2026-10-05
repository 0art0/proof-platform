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
import { createAiLimiter, type AiLimiter } from "./ai-rate-limit";

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

async function createScenario(transport: LlmTransport, aiLimiter?: AiLimiter) {
  const store = new InspectableMemoryProofStore();
  const llmCalls = new MemoryLlmCallStore();
  await ensureDevelopmentProofSession(store);
  const ai: AiRoleRuntime = { transport, dispatch };
  const service = createProofHttpService(store as ProofStore, {
    llmCalls,
    ...(aiLimiter === undefined ? {} : { aiLimiter }),
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

  describe("adversarial Jev output", () => {
    function jevWith(
      pick: (ids: readonly string[]) => {
        choice: string;
        probabilities: Record<string, number>;
        confidence?: number;
      },
    ): LlmTransport {
      const honest = jevTransport();
      return async (call) => {
        const base = (await honest(call)) as {
          providerOutput: Record<string, unknown>;
        } | null;
        if (base === null || call.envelope.role !== "move-shortlister") return base;
        const ids = call.envelope.context.candidates.map(({ id }) => id);
        return {
          ...base,
          providerOutput: { type: "choice", confidence: 0.99, ...pick(ids) },
        };
      };
    }
    const spread = (ids: readonly string[], total = 1) =>
      Object.fromEntries(ids.map((id) => [id, total / ids.length]));

    it.each([
      [
        "a choice outside the candidate set",
        jevWith((ids) => ({
          choice: "suggestion:forged-outside",
          probabilities: { ...spread(ids), "suggestion:forged-outside": 0 },
        })),
      ],
      [
        "a probability keyed by an undisplayed candidate",
        jevWith((ids) => ({
          choice: ids[0] ?? "",
          probabilities: { ...spread(ids, 0.5), "suggestion:not-displayed": 0.5 },
        })),
      ],
      [
        "probabilities that are not a distribution",
        jevWith((ids) => ({
          choice: ids[0] ?? "",
          probabilities: Object.fromEntries(ids.map((id) => [id, 0.9])),
        })),
      ],
      [
        "a choice that is not the most probable candidate",
        jevWith((ids) => ({
          choice: ids[0] ?? "",
          probabilities: Object.fromEntries(ids.map((id, index) => [id, index === 0 ? 0 : 1])),
        })),
      ],
    ] as const)(
      "rejects, records and leaves the proof untouched for %s",
      async (_label, transport) => {
        const scenario = await createScenario(transport);
        expect(scenario.candidateIds.length).toBeGreaterThan(1);
        const beforeNodes = [...scenario.store.nodes.keys()];
        const response = await scenario.shortlist();
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          status: "deterministic-fallback",
          provenance: "deterministic",
          choices: [],
          fallbackCandidateIds: scenario.candidateIds,
        });
        const calls = await json<{ records: Array<{ evidence: { status: string } }> }>(
          await fetch(`${scenario.origin}${scenario.sessionPath}/llm-calls`),
        );
        expect(calls.records).toHaveLength(1);
        expect(calls.records[0]?.evidence.status).toBe("rejected");
        const after = await json<{ session: { currentNodeId: string }; node: { id: string } }>(
          await fetch(`${scenario.origin}${scenario.sessionPath}`),
        );
        expect(after.session.currentNodeId).toBe(scenario.initialNodeId);
        expect([...scenario.store.nodes.keys()]).toEqual(beforeNodes);
        const history = await json<{ edges: unknown[] }>(
          await fetch(`${scenario.origin}${scenario.sessionPath}/history`),
        );
        expect(history.edges).toHaveLength(0);
      },
    );

    it("refuses a request candidate that was not displayed, without dispatching", async () => {
      let dispatchCount = 0;
      const honest = jevTransport();
      const scenario = await createScenario(async (call) => {
        dispatchCount += 1;
        return honest(call);
      });
      const response = await fetch(`${scenario.origin}${scenario.sessionPath}/ai/shortlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "llm-call:undisplayed",
          expectedCurrentNodeId: scenario.initialNodeId,
          suggestionSetId: scenario.suggestionSet.id,
          candidateIds: [...scenario.candidateIds, "suggestion:not-displayed"],
          trigger: "explicit-user",
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ status: "deterministic-fallback" });
      expect(dispatchCount).toBe(0);
    });
  });

  describe("cost guard", () => {
    it("answers 429 with Retry-After once the budget is spent, then recovers with the clock", async () => {
      let now = 1_000_000;
      let dispatchCount = 0;
      const honest = jevTransport();
      const scenario = await createScenario(
        async (call) => {
          dispatchCount += 1;
          return honest(call);
        },
        createAiLimiter({ maxConcurrent: 2, ratePerMinute: 1, nowMs: () => now }),
      );
      const post = (id: string) =>
        fetch(`${scenario.origin}${scenario.sessionPath}/ai/shortlist`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id,
            expectedCurrentNodeId: scenario.initialNodeId,
            suggestionSetId: scenario.suggestionSet.id,
            candidateIds: scenario.candidateIds,
            trigger: "explicit-user",
          }),
        });
      expect((await post("llm-call:budget-1")).status).toBe(200);
      const limited = await post("llm-call:budget-2");
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      expect(await limited.json()).toMatchObject({
        status: "deterministic-fallback",
        fallbackCandidateIds: scenario.candidateIds,
        diagnostics: [{ code: "ai-rate-limited" }],
      });
      expect(dispatchCount).toBe(1);
      // A replay never reaches the provider, so it spends no budget.
      const replay = await post("llm-call:budget-1");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ replayed: true });
      expect(dispatchCount).toBe(1);
      now += 60_000;
      expect((await post("llm-call:budget-2")).status).toBe(200);
      expect(dispatchCount).toBe(2);
    });

    it("does not spend budget on deterministic fallbacks and caps concurrency", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = 0;
      const honest = jevTransport();
      const scenario = await createScenario(
        async (call) => {
          started += 1;
          await gate;
          return honest(call);
        },
        createAiLimiter({ maxConcurrent: 1, ratePerMinute: 100, nowMs: () => 0 }),
      );
      const post = (id: string, candidateIds: readonly string[]) =>
        fetch(`${scenario.origin}${scenario.sessionPath}/ai/shortlist`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id,
            expectedCurrentNodeId: scenario.initialNodeId,
            suggestionSetId: scenario.suggestionSet.id,
            candidateIds,
            trigger: "explicit-user",
          }),
        });
      const first = post("llm-call:concurrent-1", scenario.candidateIds);
      while (started === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      // A single-candidate request is deterministic and is served even while the cap is full.
      const single = await post("llm-call:single", scenario.candidateIds.slice(0, 1));
      expect(single.status).toBe(200);
      const busy = await post("llm-call:concurrent-2", scenario.candidateIds);
      expect(busy.status).toBe(429);
      expect(busy.headers.get("retry-after")).toBe("1");
      expect(await busy.json()).toMatchObject({
        diagnostics: [{ code: "ai-concurrency-limited" }],
      });
      release();
      expect((await first).status).toBe(200);
      expect((await post("llm-call:concurrent-3", scenario.candidateIds)).status).toBe(200);
    });
  });
});
