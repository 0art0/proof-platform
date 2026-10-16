import { afterEach, describe, expect, it } from "vitest";
import type { LlmTransport } from "@proof/llm";
import { createProofNodeSchema } from "@proof/protocol";
import { artifactDigest } from "../artifact-export";
import { importProofArtifact, validateProofArtifact } from "../artifact-import";
import { MemoryLibraryStore } from "../memory-library-store";
import { MemoryLlmCallStore } from "../memory-llm-call-store";
import { InspectableMemoryProofStore } from "../memory-proof-store.testing";
import { initializeProofSession, type ProofStore } from "../proof-repository";
import type { AiRoleRuntime } from "../ai-runtime";
import { createProofHttpService, type ProofHttpService } from ".";
import { createAiLimiter } from "./ai-rate-limit";

const SESSION_ID = "session:execute";
const ROOT_ID = "node:execute-root";
const ROOT_STATE_ID = "state:execute-root";
const goal = { kind: "goal", id: "goal:main" } as const;

const dispatch = {
  provider: "fixture",
  model: "fixture-executor",
  promptVersion: "ai-execute-test-v1",
} as const;

const services: ProofHttpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const proposition = (symbol: string, index: number) => ({
  id: `declaration:${index}`,
  symbol,
  sort: { kind: "proposition" },
  role: "universal-parameter",
});

/** `p implies (p and q)` with the fact `q`, and a second goal that must never reach the model. */
function rootNode() {
  return createProofNodeSchema().parse({
    id: ROOT_ID,
    state: {
      id: ROOT_STATE_ID,
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: [proposition("p", 0), proposition("q", 1)],
              hypotheses: [{ id: "hypothesis:q", statement: { expression: "q" } }],
            },
            conclusion: { expression: ["Implies", "p", ["And", "p", "q"]] },
          },
        },
        {
          id: "goal:elsewhere",
          sequent: {
            context: { declarations: [proposition("remote-secret", 2)], hypotheses: [] },
            conclusion: { expression: "remote-secret" },
          },
        },
      ],
      obligations: [],
    },
  });
}

/** Assume the antecedent, split the conjunction, close the left half: three equivalences. */
const GOOD_STEPS = [
  { kind: "introduce-implication", target: goal, hypothesisId: "assume-p" },
  { kind: "split-goal-conjunction", target: goal, childIds: ["left", "right"] },
  {
    kind: "close-by-hypothesis",
    target: { kind: "goal", id: "left" },
    hypothesisId: "assume-p",
  },
];

const planOutput = (steps: readonly unknown[] = GOOD_STEPS) => ({
  result: { kind: "plan", steps, explanation: "Assume p, split the conjunction, close p." },
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function startScenario(
  options: {
    transport?: LlmTransport | undefined;
    aiLimiter?: ReturnType<typeof createAiLimiter>;
    readOnly?: boolean;
  } = {},
) {
  const store = new InspectableMemoryProofStore();
  const llmCalls = new MemoryLlmCallStore();
  await initializeProofSession(store, {
    sessionId: SESSION_ID,
    rootNode: rootNode(),
    metadata: {
      problem: { title: "Execute", statement: "Show p implies p and q." },
      background: {
        level: "undergraduate",
        summary: "Logic.",
        assumptions: [],
        domains: ["logic"],
        maximumLevel: "undergraduate",
      },
      libraryLayerIds: [],
    },
  });
  if (options.readOnly === true) {
    await store.transaction(async (transaction) => {
      await transaction.markSessionReadOnly(SESSION_ID as never);
    });
  }
  const executor: AiRoleRuntime | undefined =
    options.transport === undefined ? undefined : { transport: options.transport, dispatch };
  const service = createProofHttpService(store as ProofStore, {
    llmCalls,
    ...(options.aiLimiter === undefined ? {} : { aiLimiter: options.aiLimiter }),
    ...(executor === undefined ? {} : { ai: { "move-executor": executor } }),
  });
  services.push(service);
  const { origin } = await service.listen();
  const base = `${origin}/proof-sessions/${SESSION_ID}`;
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: (await response.json()) as Json };
  };
  const post = async (path: string, body: unknown, headers: HeadersInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json()) as Json,
    };
  };
  const describeStep = (overrides: Json = {}) => ({
    id: "llm-call:execute-1",
    expectedCurrentNodeId: ROOT_ID,
    instruction: "assume p, split the conjunction and close the p half",
    source: "user-instruction",
    target: goal,
    selections: [
      {
        kind: "exact",
        anchor: { stateId: ROOT_STATE_ID, target: goal, statement: { kind: "conclusion" } },
        path: [],
      },
    ],
    ...overrides,
  });
  return {
    store,
    llmCalls,
    origin,
    get,
    post,
    preview: (overrides: Json = {}) => post("/ai/execute", describeStep(overrides)),
    apply: (overrides: Json = {}) =>
      post("/ai/execute/apply", {
        callId: "llm-call:execute-1",
        expectedCurrentNodeId: ROOT_ID,
        ...overrides,
      }),
    current: async () => (await get("")).body,
    history: async () => (await get("/history")).body as { edges: { edge: Json; name: string }[] },
  };
}

function counting(output: unknown = planOutput()) {
  const calls: Parameters<LlmTransport>[0][] = [];
  const transport: LlmTransport = async (call) => {
    calls.push(call);
    return typeof output === "function" ? (output as (c: unknown) => unknown)(call) : output;
  };
  return { transport, calls };
}

describe("POST /proof-sessions/:id/ai/execute (preview)", () => {
  it("previews a plan through the kernel and commits nothing", async () => {
    const { transport, calls } = counting();
    const scenario = await startScenario({ transport });
    const before = await scenario.current();

    const answer = await scenario.preview();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      status: "previewed",
      provenance: { kind: "user-proposal", role: "move-executor" },
      callId: "llm-call:execute-1",
      replayed: false,
      nodeId: ROOT_ID,
      explanation: "Assume p, split the conjunction, close p.",
      transitionClass: "equivalence",
      evidence: "structural",
      diagnostics: [],
    });
    expect(answer.body.steps).toHaveLength(3);
    expect(answer.body.steps.map((step: Json) => step.operation.kind)).toEqual([
      "introduce-implication",
      "split-goal-conjunction",
      "close-by-hypothesis",
    ]);
    // The preview shows the state the plan leads to: the right half of the conjunction remains.
    const { preview } = answer.body;
    expect(preview.transitionClass).toBe("equivalence");
    expect(preview.beforeState.id).toBe(ROOT_STATE_ID);
    const remaining = preview.afterState.goals.map((entry: Json) => entry.sequent.conclusion);
    expect(remaining).toEqual([{ expression: "q" }, { expression: "remote-secret" }]);
    expect(preview.delta.goals.added).toHaveLength(1);
    expect(preview.delta.goals.removed).toEqual(["goal:main"]);

    // Nothing was committed.
    const after = await scenario.current();
    expect(after.session.currentNodeId).toBe(before.session.currentNodeId);
    expect((await scenario.history()).edges).toHaveLength(0);
    expect(calls).toHaveLength(1);

    // The call is session-owned evidence.
    const evidence = await scenario.get("/llm-calls");
    expect(evidence.body.records).toHaveLength(1);
    expect(evidence.body.records[0]).toMatchObject({
      id: "llm-call:execute-1",
      role: "move-executor",
      status: "completed",
      evidence: { status: "validated", output: { kind: "plan" } },
    });
  });

  it("sends the model only the target, the selection and the instruction", async () => {
    const { transport, calls } = counting();
    const scenario = await startScenario({ transport });
    await scenario.preview();
    const [call] = calls;
    expect(call?.role).toBe("move-executor");
    const serialized = JSON.stringify(call?.envelope);
    expect(serialized).not.toContain("remote-secret");
    expect(serialized).not.toContain("goal:elsewhere");
    expect(serialized).not.toContain("Show p implies p and q");
    const context = (call?.envelope as { context: Json }).context;
    expect(context.instruction).toBe("assume p, split the conjunction and close the p half");
    expect(context.sequent.hypotheses).toEqual([{ id: "hypothesis:q", expression: "q" }]);
    expect(context.selections).toHaveLength(1);
  });

  it("labels a technique as minimal-context-llm", async () => {
    const scenario = await startScenario({ transport: counting().transport });
    const answer = await scenario.preview({ source: "shortlisted-technique" });
    expect(answer.body).toMatchObject({
      status: "previewed",
      provenance: { kind: "minimal-context-llm", role: "move-executor" },
    });
  });

  it("reports a weakening composed from its steps", async () => {
    const scenario = await startScenario({
      transport: counting(
        planOutput([
          { kind: "introduce-implication", target: goal, hypothesisId: "assume-p" },
          { kind: "assume-hypothesis", target: goal, hypothesisId: "extra", proposition: "q" },
        ]),
      ).transport,
    });
    const answer = await scenario.preview();
    expect(answer.body).toMatchObject({ status: "previewed", transitionClass: "weakening" });
    expect(answer.body.steps.map((step: Json) => step.transitionClass)).toEqual([
      "equivalence",
      "weakening",
    ]);
  });

  it("names the first step the kernel rejects, with its reason, and commits nothing", async () => {
    const scenario = await startScenario({
      transport: counting(
        planOutput([
          GOOD_STEPS[0],
          { kind: "close-by-hypothesis", target: goal, hypothesisId: "hypothesis:q" },
        ]),
      ).transport,
    });
    const answer = await scenario.preview();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      status: "plan-failed",
      provenance: { kind: "user-proposal" },
      callId: "llm-call:execute-1",
      explanation: expect.any(String),
      failure: {
        stepIndex: 2,
        stepCount: 2,
        code: "rule-not-applicable",
        message: expect.stringContaining("does not match the conclusion"),
      },
    });
    expect(answer.body.preview).toBeUndefined();
    expect((await scenario.history()).edges).toHaveLength(0);
    expect((await scenario.current()).session.currentNodeId).toBe(ROOT_ID);
  });

  it("answers a context request or a refusal as such", async () => {
    const insufficient = await startScenario({
      transport: counting({
        result: {
          kind: "insufficient-context",
          requestedCategories: ["local-hypothesis"],
          rationale: "Which fact should I use?",
        },
      }).transport,
    });
    expect((await insufficient.preview()).body).toMatchObject({
      status: "insufficient-context",
      result: { rationale: "Which fact should I use?" },
    });
    const declined = await startScenario({
      transport: counting({ result: { kind: "declined", reason: "Not a proof step." } }).transport,
    });
    const answer = await declined.preview();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      status: "declined",
      result: { reason: "Not a proof step." },
    });
  });

  it.each([
    ["mark-sorry", { kind: "mark-sorry", target: goal, assumptionId: "assumption:x" }],
    [
      "close-by-accepted-inference",
      { kind: "close-by-accepted-inference", target: goal, attestationId: "attestation:x" },
    ],
  ])("records and rejects a plan that uses %s", async (_name, forbidden) => {
    const scenario = await startScenario({
      transport: counting(planOutput([forbidden])).transport,
    });
    const answer = await scenario.preview();
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-output" }],
    });
    expect((await scenario.history()).edges).toHaveLength(0);
    const evidence = await scenario.get("/llm-calls");
    expect(evidence.body.records[0].evidence.status).toBe("rejected");
  });

  it("answers 503 ai-disabled without a configured provider", async () => {
    const scenario = await startScenario();
    const answer = await scenario.preview();
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({
      status: "disabled",
      diagnostics: [{ code: "ai-disabled" }],
    });
    const capabilities = await (await fetch(`${scenario.origin}/ai/capabilities`)).json();
    expect(capabilities.roles["move-executor"]).toBe(false);
  });

  it("reports the role in capabilities when configured", async () => {
    const scenario = await startScenario({ transport: counting().transport });
    const capabilities = await (await fetch(`${scenario.origin}/ai/capabilities`)).json();
    expect(capabilities.roles["move-executor"]).toBe(true);
  });

  it("applies the cost guard with 429 and Retry-After, before dispatching", async () => {
    const { transport, calls } = counting();
    const scenario = await startScenario({
      transport,
      aiLimiter: createAiLimiter({ ratePerMinute: 1, maxConcurrent: 4 }),
    });
    expect((await scenario.preview()).status).toBe(200);
    const limited = await scenario.preview({ id: "llm-call:execute-2" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited.body).toMatchObject({
      status: "rate-limited",
      diagnostics: [{ code: "ai-rate-limited" }],
    });
    expect(calls).toHaveLength(1);
    // A replay of the stored call costs nothing.
    expect((await scenario.preview()).body).toMatchObject({ status: "previewed", replayed: true });
    expect(calls).toHaveLength(1);
  });

  it("is stale, without dispatching, when the session is not at the expected node", async () => {
    const { transport, calls } = counting();
    const scenario = await startScenario({ transport });
    const answer = await scenario.preview({ expectedCurrentNodeId: "node:somewhere-else" });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({
      status: "stale",
      diagnostics: [{ code: "stale-evidence" }],
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a read-only session without dispatching", async () => {
    const { transport, calls } = counting();
    const scenario = await startScenario({ transport, readOnly: true });
    const answer = await scenario.preview();
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ diagnostics: [{ code: "session-read-only" }] });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["an empty instruction", { instruction: "   " }],
    ["an unknown source", { source: "background-proposer" }],
    ["a target outside the state", { target: { kind: "goal", id: "goal:missing" } }],
    ["extra fields", { steps: [] }],
    [
      "an abstraction",
      {
        selections: [
          {
            kind: "exact",
            anchor: { stateId: ROOT_STATE_ID, target: goal, statement: { kind: "conclusion" } },
            path: [],
            abstraction: {
              id: "wildcard:one",
              symbol: "_one",
              role: "retrieval-wildcard",
              sort: { kind: "proposition" },
            },
          },
        ],
      },
    ],
  ])("rejects %s without dispatching", async (_name, overrides) => {
    const { transport, calls } = counting();
    const scenario = await startScenario({ transport });
    expect((await scenario.preview(overrides)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("is idempotent by call ID: a replay does not dispatch again, a changed request conflicts", async () => {
    const { transport, calls } = counting();
    const scenario = await startScenario({ transport });
    await scenario.preview();
    const replay = await scenario.preview();
    expect(replay.body).toMatchObject({ status: "previewed", replayed: true });
    expect(calls).toHaveLength(1);
    const changed = await scenario.preview({ instruction: "do something different" });
    expect(changed.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("includes the call in the exported artifact", async () => {
    const scenario = await startScenario({ transport: counting().transport });
    await scenario.preview();
    const exported = await fetch(
      `${scenario.origin}/proof-sessions/${SESSION_ID}/export?confirmPrivateExport=true`,
    );
    expect(exported.status).toBe(200);
    const artifact = (await exported.json()) as { llmCalls: { role: string }[] };
    expect(artifact.llmCalls.map(({ role }) => role)).toEqual(["move-executor"]);
  });

  it("round-trips an applied plan through artifact export and import, keeping its provenance", async () => {
    const scenario = await startScenario({ transport: counting().transport });
    await scenario.preview();
    await scenario.apply();
    const exported = await fetch(
      `${scenario.origin}/proof-sessions/${SESSION_ID}/export?confirmPrivateExport=true`,
    );
    const artifact = (await exported.json()) as Json;
    expect(artifact.llmCalls.map(({ role }: Json) => role)).toEqual(["move-executor"]);
    expect(artifact.tree.edges.map(({ proposal }: Json) => proposal.callId)).toEqual([
      "llm-call:execute-1",
      "llm-call:execute-1",
      "llm-call:execute-1",
    ]);

    const target = new MemoryLibraryStore();
    const imported = await importProofArtifact(target, artifact);
    expect(imported, JSON.stringify(imported)).toMatchObject({ status: "imported" });

    // Provenance cannot be stripped from an edge without the replay noticing.
    const forged = structuredClone(artifact);
    delete forged.tree.edges[0].proposal;
    forged.digest = artifactDigest(forged);
    const rejected = validateProofArtifact(forged);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.diagnostics[0].code).toBe("transition-not-reproduced");
  });
});

describe("POST /proof-sessions/:id/ai/execute/apply", () => {
  it("commits the previewed steps as ordinary commands that name the call", async () => {
    const scenario = await startScenario({ transport: counting().transport });
    const previewed = await scenario.preview();
    const applied = await scenario.apply();
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({
      status: "applied",
      provenance: { kind: "user-proposal", role: "move-executor" },
      callId: "llm-call:execute-1",
      replayed: false,
      transitionClass: "equivalence",
    });
    expect(applied.body.steps).toHaveLength(3);

    const history = await scenario.history();
    expect(history.edges).toHaveLength(3);
    history.edges.forEach(({ edge }, position) => {
      expect(edge.proposal).toEqual({
        source: "user-proposal",
        role: "move-executor",
        callId: "llm-call:execute-1",
        stepIndex: position + 1,
        stepCount: 3,
      });
      expect(edge.moveId).toBeUndefined();
      expect(edge.macro).toBeUndefined();
    });

    // The committed state is exactly the state the preview showed.
    const current = await scenario.current();
    expect(current.node.state).toEqual(previewed.body.preview.afterState);
    expect(current.node.id).toBe(applied.body.nodeId);

    // The edges are the kernel operations of the preview, in order.
    expect(history.edges.map(({ edge }) => edge.operation)).toEqual(
      previewed.body.steps.map((step: Json) => step.operation),
    );
    // The commands are recorded as raw operations by the confirming human.
    const events = [...scenario.store.events.values()] as Json[];
    expect(events.map((event) => event.actor ?? event.event?.actor)).toEqual(
      expect.arrayContaining([{ id: "actor:web", kind: "human" }]),
    );
  });

  it("labels a technique's steps minimal-context-llm", async () => {
    const scenario = await startScenario({ transport: counting().transport });
    await scenario.preview({ source: "shortlisted-technique" });
    const applied = await scenario.apply();
    expect(applied.body).toMatchObject({ provenance: { kind: "minimal-context-llm" } });
    const edges = (await scenario.history()).edges;
    expect(edges.every(({ edge }) => edge.proposal.source === "minimal-context-llm")).toBe(true);
  });

  it("replays a retry without committing again", async () => {
    const scenario = await startScenario({ transport: counting().transport });
    await scenario.preview();
    const first = await scenario.apply();
    const retry = await scenario.apply();
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      status: "applied",
      replayed: true,
      nodeId: first.body.nodeId,
    });
    expect((await scenario.history()).edges).toHaveLength(3);
  });

  it("is stale when the session moved since the preview", async () => {
    const scenario = await startScenario({ transport: counting().transport });
    await scenario.preview();
    const moved = await scenario.post("/protocol-commands", {
      commandId: "command:manual-move",
      actor: { id: "actor:human", kind: "human" },
      basis: { nodeId: ROOT_ID },
      command: {
        kind: "kernel-operation",
        operation: {
          kind: "introduce-implication",
          target: goal,
          hypothesisId: "hypothesis:manual",
        },
      },
    });
    expect(moved.status).toBe(201);
    const applied = await scenario.apply();
    expect(applied.status).toBe(409);
    expect(applied.body).toMatchObject({ diagnostics: [{ code: "serialized-stale-command" }] });
    expect((await scenario.history()).edges).toHaveLength(1);
  });

  it("is stale when the user names a different node than the one previewed", async () => {
    const scenario = await startScenario({ transport: counting().transport });
    await scenario.preview();
    const applied = await scenario.apply({ expectedCurrentNodeId: "node:other" });
    expect(applied.status).toBe(409);
    expect((await scenario.history()).edges).toHaveLength(0);
  });

  it("never takes a plan from the client", async () => {
    const scenario = await startScenario({ transport: counting().transport });
    await scenario.preview();
    const forged = await scenario.apply({
      steps: [{ kind: "close-true", target: goal }],
      operations: [],
    });
    expect(forged.status).toBe(400);
    expect((await scenario.history()).edges).toHaveLength(0);
    // Only a call that exists, in this session, with a validated plan, can be applied.
    expect((await scenario.apply({ callId: "llm-call:never-made" })).status).toBe(404);
  });

  it("refuses a call that did not produce a plan", async () => {
    const scenario = await startScenario({
      transport: counting({ result: { kind: "declined", reason: "No." } }).transport,
    });
    await scenario.preview();
    const applied = await scenario.apply();
    expect(applied.status).toBe(409);
    expect(applied.body).toMatchObject({ diagnostics: [{ code: "plan-not-applicable" }] });
  });

  it("records nothing when a step is rejected at apply time", async () => {
    const scenario = await startScenario({
      transport: counting(
        planOutput([
          GOOD_STEPS[0],
          { kind: "close-by-hypothesis", target: goal, hypothesisId: "hypothesis:q" },
        ]),
      ).transport,
    });
    await scenario.preview();
    const applied = await scenario.apply();
    expect(applied.status).toBe(422);
    expect(applied.body).toMatchObject({
      status: "plan-failed",
      diagnostics: [{ code: "plan-step-failed", message: expect.stringContaining("Step 2 of 2") }],
    });
    expect((await scenario.history()).edges).toHaveLength(0);
    expect((await scenario.current()).session.currentNodeId).toBe(ROOT_ID);
  });

  it("does not apply into a read-only session", async () => {
    const scenario = await startScenario({ transport: counting().transport });
    await scenario.preview();
    await scenario.store.transaction(async (transaction) => {
      await transaction.markSessionReadOnly(SESSION_ID as never);
    });
    const applied = await scenario.apply();
    expect(applied.status).toBe(409);
    expect((await scenario.history()).edges).toHaveLength(0);
  });
});
