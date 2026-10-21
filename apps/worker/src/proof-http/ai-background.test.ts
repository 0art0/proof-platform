import { afterEach, describe, expect, it } from "vitest";
import type { LlmTransport, PreparedLlmCall } from "@proof/llm";
import { starterLibraryPacks } from "@proof/library";
import { setDraft } from "../problem-setup.testing";
import { InspectableMemoryProofStore } from "../memory-proof-store.testing";
import { MemoryLlmCallStore } from "../memory-llm-call-store";
import { createProofHttpService, type ProofHttpService } from ".";
import { createAiLimiter, type AiLimiter } from "./ai-rate-limit";
import type { AiRuntime } from "../ai-runtime";

const services: ProofHttpService[] = [];
const dispatch = {
  provider: "test-provider",
  model: "test-background",
  promptVersion: "background-test-v1",
} as const;

const CONSTRUCTION = "construction:background";
const PROBLEM = {
  title: "Consecutive integers",
  statement: "Show that m and n are coprime when m = n + 1.",
};

function wireOperator(overrides: Record<string, unknown> = {}) {
  return {
    id: "operator:coprime",
    symbol: "Coprime",
    displayName: "coprime",
    parameters: ["integer", "integer"],
    result: "proposition",
    latex: {
      template: String.raw`#1\perp #2`,
      precedence: "relation",
      parse: { trigger: String.raw`\perp`, notation: "infix" },
    },
    naturalLanguage: { template: "#1 and #2 are coprime", negated: "#1 and #2 are not coprime" },
    ...overrides,
  };
}

function proposalOutput(
  constants: readonly Record<string, unknown>[] = [wireOperator()],
  level = "first-year undergraduate",
) {
  return {
    result: {
      kind: "background-proposal",
      background: {
        level,
        summary: "Elementary number theory.",
        assumptions: ["Divisibility of integers"],
        domains: ["number theory"],
        maximumLevel: "undergraduate",
      },
      constants: constants.map((operator) => ({ operator, rationale: "The goal uses it." })),
    },
  };
}

type Running = { origin: string; store: InspectableMemoryProofStore; calls: MemoryLlmCallStore };

async function running(
  options: { ai?: AiRuntime; calls?: MemoryLlmCallStore | null; aiLimiter?: AiLimiter } = {},
): Promise<Running> {
  const store = new InspectableMemoryProofStore();
  const calls = options.calls ?? new MemoryLlmCallStore();
  const service = createProofHttpService(store, {
    ...(options.calls === null ? {} : { llmCalls: calls }),
    ...(options.ai === undefined ? {} : { ai: options.ai }),
    ...(options.aiLimiter === undefined ? {} : { aiLimiter: options.aiLimiter }),
  });
  services.push(service);
  return { origin: (await service.listen()).origin, store, calls };
}

function backgroundRuntime(transport: LlmTransport): AiRuntime {
  return { "background-proposer": { transport, dispatch } };
}

async function post(origin: string, path: string, body: unknown) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function backgroundRequest(overrides: Record<string, unknown> = {}) {
  return {
    constructionId: CONSTRUCTION,
    id: "llm-call:background",
    problem: PROBLEM,
    preferences: { domains: ["number theory"] },
    ...overrides,
  };
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    constructionId: CONSTRUCTION,
    decisionId: "background-decision:1",
    callId: "llm-call:background",
    decision: "approved",
    rationale: "Matches the problem.",
    decidedAt: "2026-10-15T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("background proposer endpoint", () => {
  it("returns a recorded proposal from the problem and preferences only", async () => {
    const seen: PreparedLlmCall[] = [];
    const { origin, store, calls } = await running({
      ai: backgroundRuntime(async (call) => {
        seen.push(call);
        return proposalOutput();
      }),
    });
    const response = await post(origin, "/ai/background", backgroundRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { proposal: { constants: { operator: unknown }[] } };
    expect(body).toMatchObject({
      status: "proposed",
      provenance: { kind: "minimal-context-llm", role: "background-proposer" },
      callId: "llm-call:background",
      replayed: false,
      proposal: {
        kind: "background-proposal",
        background: { level: "first-year undergraduate", domains: ["number theory"] },
        constants: [
          {
            operator: { symbol: "Coprime", signature: { result: { kind: "proposition" } } },
            rationale: "The goal uses it.",
          },
        ],
      },
    });
    expect(body).not.toHaveProperty("revisedCallId");
    expect(seen).toHaveLength(1);
    const envelope = seen[0]!.envelope;
    expect(envelope.role).toBe("background-proposer");
    if (envelope.role !== "background-proposer") return;
    expect(Object.keys(envelope.context).sort()).toEqual(["operators", "preferences", "problem"]);
    expect(envelope.context.problem).toContain("m = n + 1");
    expect(envelope.context.preferences).toEqual({ domains: ["number theory"], notation: [] });
    expect(seen[0]!.messages[0].content).toContain("must suffice to formalize the problem");
    // The registry's operators are offered so that a constant can reference one with its exact
    // signature: symbol, display name and sort-name signature, and nothing about notation.
    const operators = envelope.context.operators ?? [];
    expect(operators.map(({ symbol }) => symbol).sort()).toEqual(
      starterLibraryPacks()
        .flatMap((pack) => pack.operators.map(({ symbol }) => symbol))
        .sort(),
    );
    expect(operators.find(({ symbol }) => symbol === "Divides")).toEqual({
      symbol: "Divides",
      displayName: "divides",
      parameters: ["integer", "integer"],
      result: "proposition",
    });
    expect(seen[0]!.messages[0].content).toContain("context.operators");
    expect(store.sessions.size).toBe(0);
    expect(store.nodes.size).toBe(0);

    const evidence = await fetch(
      `${origin}/constructions/construction%3Abackground/llm-calls/llm-call%3Abackground`,
    );
    expect(await evidence.json()).toMatchObject({
      record: {
        role: "background-proposer",
        status: "completed",
        dispatch: { promptVersion: "background-test-v1" },
        evidence: { status: "validated", output: { kind: "background-proposal" } },
      },
    });
    expect((await calls.listCallsForOwner({ kind: "construction", id: CONSTRUCTION })).length).toBe(
      1,
    );
  });

  it("proposes from the problem alone, without preferences", async () => {
    const seen: PreparedLlmCall[] = [];
    const { origin } = await running({
      ai: backgroundRuntime(async (call) => {
        seen.push(call);
        return proposalOutput([]);
      }),
    });
    const response = await post(origin, "/ai/background", {
      constructionId: CONSTRUCTION,
      id: "llm-call:bare",
      problem: PROBLEM,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ proposal: { constants: [] } });
    const envelope = seen[0]!.envelope;
    if (envelope.role !== "background-proposer") throw new Error("Expected a background call.");
    expect(Object.keys(envelope.context).sort()).toEqual(["operators", "problem"]);
  });

  it("replays a repeated call ID without contacting the provider again", async () => {
    let count = 0;
    const { origin } = await running({
      ai: backgroundRuntime(async () => {
        count += 1;
        return proposalOutput();
      }),
    });
    await post(origin, "/ai/background", backgroundRequest());
    const replay = await post(origin, "/ai/background", backgroundRequest());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "proposed", replayed: true });
    expect(count).toBe(1);
    const changed = await post(
      origin,
      "/ai/background",
      backgroundRequest({ problem: { title: "Other", statement: "Show something else." } }),
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ diagnostics: [{ code: "call-id-conflict" }] });
    expect(count).toBe(1);
  });

  it("answers 503 ai-disabled when the role is not configured or evidence is not stored", async () => {
    const unconfigured = await running();
    const response = await post(unconfigured.origin, "/ai/background", backgroundRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "disabled",
      diagnostics: [{ code: "ai-disabled" }],
    });
    const unstored = await running({
      ai: backgroundRuntime(async () => proposalOutput()),
      calls: null,
    });
    expect((await post(unstored.origin, "/ai/background", backgroundRequest())).status).toBe(503);
    expect((await post(unstored.origin, "/ai/background/decisions", decision())).status).toBe(503);
  });

  it("rejects invalid requests before any provider call", async () => {
    let count = 0;
    const { origin } = await running({
      ai: backgroundRuntime(async () => {
        count += 1;
        return proposalOutput();
      }),
    });
    const invalid: readonly Record<string, unknown>[] = [
      { solution: "By Euclid." },
      { background: { level: "x", summary: "y", assumptions: [] } },
      { preferences: { domains: [7] } },
      { problem: { title: "T" } },
      { revision: { previousCallId: "llm-call:x" } },
      { revision: { previousCallId: "llm-call:x", feedback: "   " } },
      {
        revision: {
          previousCallId: "llm-call:x",
          feedback: "Add gcd.",
          previousProposal: proposalOutput().result,
        },
      },
    ];
    for (const overrides of invalid) {
      const response = await post(origin, "/ai/background", backgroundRequest(overrides));
      expect(response.status, JSON.stringify(overrides)).toBe(400);
    }
    expect(count).toBe(0);
    expect((await fetch(`${origin}/ai/background`)).status).toBe(405);
    expect((await fetch(`${origin}/ai/background/decisions`)).status).toBe(405);
  });

  const rejectedOutputs: ReadonlyArray<readonly [string, unknown]> = [
    ["a reserved built-in symbol", proposalOutput([wireOperator({ symbol: "Add" })])],
    [
      "a duplicate symbol",
      proposalOutput([
        wireOperator(),
        wireOperator({
          id: "operator:other",
          latex: { template: String.raw`#1\sim #2`, precedence: "relation", parse: null },
        }),
      ]),
    ],
    ["an unknown sort", proposalOutput([wireOperator({ parameters: ["matrix", "integer"] })])],
    [
      "an extra field carrying a solution",
      { result: { ...proposalOutput().result, solution: "By Euclid." } },
    ],
    ["a topic manifest", { result: { kind: "topic-manifest", domains: [] } }],
  ];
  it.each(rejectedOutputs)(
    "records and rejects %s without creating anything",
    async (_name, output) => {
      const { origin, store, calls } = await running({
        ai: backgroundRuntime(async () => output),
      });
      const response = await post(origin, "/ai/background", backgroundRequest());
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        status: "rejected",
        callId: "llm-call:background",
        diagnostics: [{ code: "invalid-output" }],
      });
      expect(
        (await calls.listCallsForOwner({ kind: "construction", id: CONSTRUCTION })).length,
      ).toBe(1);
      expect(store.sessions.size).toBe(0);
      expect((await post(origin, "/ai/background/decisions", decision())).status).toBe(409);
    },
  );

  it("relays a context request or a refusal as a non-proposal", async () => {
    const { origin } = await running({
      ai: backgroundRuntime(async () => ({
        result: {
          kind: "insufficient-context",
          requestedCategories: ["problem-detail"],
          rationale: "Which integers are meant?",
        },
      })),
    });
    const response = await post(origin, "/ai/background", backgroundRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "insufficient-context",
      result: { kind: "insufficient-context", requestedCategories: ["problem-detail"] },
    });
    const refusal = await running({
      ai: backgroundRuntime(async () => ({ kind: "declined", reason: "Not mathematics." })),
    });
    expect(
      await (await post(refusal.origin, "/ai/background", backgroundRequest())).json(),
    ).toMatchObject({ status: "declined", result: { kind: "declined" } });
    expect((await post(refusal.origin, "/ai/background/decisions", decision())).status).toBe(409);
  });

  it("answers 503 and records a transport failure", async () => {
    const { origin, calls } = await running({
      ai: backgroundRuntime(async () => {
        throw new Error("offline");
      }),
    });
    const response = await post(origin, "/ai/background", backgroundRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "transport-failed",
      diagnostics: [{ code: "transport-failed" }],
    });
    expect((await calls.listCallsForOwner({ kind: "construction", id: CONSTRUCTION })).length).toBe(
      1,
    );
  });

  it("shares the cost guard: 429 with Retry-After, replays free, and recovery with the clock", async () => {
    let now = 1_000_000;
    let count = 0;
    const { origin } = await running({
      aiLimiter: createAiLimiter({ maxConcurrent: 2, ratePerMinute: 1, nowMs: () => now }),
      ai: backgroundRuntime(async () => {
        count += 1;
        return proposalOutput();
      }),
    });
    expect(
      (await post(origin, "/ai/background", backgroundRequest({ id: "llm-call:b1" }))).status,
    ).toBe(200);
    const limited = await post(origin, "/ai/background", backgroundRequest({ id: "llm-call:b2" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toMatchObject({
      status: "rate-limited",
      diagnostics: [{ code: "ai-rate-limited" }],
    });
    expect(count).toBe(1);
    const replay = await post(origin, "/ai/background", backgroundRequest({ id: "llm-call:b1" }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(count).toBe(1);
    now += 60_000;
    expect(
      (await post(origin, "/ai/background", backgroundRequest({ id: "llm-call:b2" }))).status,
    ).toBe(200);
    expect(count).toBe(2);
  });

  it("does not spend budget on a revision that cannot be dispatched", async () => {
    let count = 0;
    const { origin } = await running({
      aiLimiter: createAiLimiter({ maxConcurrent: 1, ratePerMinute: 1, nowMs: () => 0 }),
      ai: backgroundRuntime(async () => {
        count += 1;
        return proposalOutput();
      }),
    });
    const missing = await post(
      origin,
      "/ai/background",
      backgroundRequest({
        id: "llm-call:revision",
        revision: { previousCallId: "llm-call:missing", feedback: "More." },
      }),
    );
    expect(missing.status).toBe(404);
    expect(count).toBe(0);
    expect((await post(origin, "/ai/background", backgroundRequest())).status).toBe(200);
  });
});

describe("background revision", () => {
  it("chains revisions, reading each previous proposal from storage", async () => {
    const seen: PreparedLlmCall[] = [];
    const levels = ["first-year undergraduate", "second-year undergraduate", "graduate"];
    const { origin, calls } = await running({
      ai: backgroundRuntime(async (call) => {
        seen.push(call);
        return proposalOutput([wireOperator()], levels[seen.length - 1] ?? "graduate");
      }),
    });
    expect((await post(origin, "/ai/background", backgroundRequest())).status).toBe(200);
    const first = (await (
      await fetch(
        `${origin}/constructions/construction%3Abackground/llm-calls/llm-call%3Abackground`,
      )
    ).json()) as { record: { evidence: { output: unknown } } };

    const second = await post(
      origin,
      "/ai/background",
      backgroundRequest({
        id: "llm-call:background-2",
        revision: { previousCallId: "llm-call:background", feedback: "Assume a bit more." },
      }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      status: "proposed",
      callId: "llm-call:background-2",
      revisedCallId: "llm-call:background",
      proposal: { background: { level: "second-year undergraduate" } },
    });
    const third = await post(
      origin,
      "/ai/background",
      backgroundRequest({
        id: "llm-call:background-3",
        revision: { previousCallId: "llm-call:background-2", feedback: "Now graduate level." },
      }),
    );
    expect(third.status).toBe(200);
    expect(await third.json()).toMatchObject({ revisedCallId: "llm-call:background-2" });

    const second_ = seen[1]!.envelope;
    const third_ = seen[2]!.envelope;
    if (second_.role !== "background-proposer" || third_.role !== "background-proposer") {
      throw new Error("Expected background calls.");
    }
    expect(second_.context.revision).toEqual({
      previousCallId: "llm-call:background",
      previousProposal: first.record.evidence.output,
      feedback: "Assume a bit more.",
    });
    expect(third_.context.revision?.previousProposal.background.level).toBe(
      "second-year undergraduate",
    );
    expect(third_.context.revision?.feedback).toBe("Now graduate level.");
    expect(seen[1]!.messages[1].content).toContain("Assume a bit more.");
    expect((await calls.listCallsForOwner({ kind: "construction", id: CONSTRUCTION })).length).toBe(
      3,
    );
  });

  it("replays a repeated revision and conflicts when its feedback changes under the same ID", async () => {
    let count = 0;
    const { origin } = await running({
      ai: backgroundRuntime(async () => {
        count += 1;
        return proposalOutput();
      }),
    });
    await post(origin, "/ai/background", backgroundRequest());
    const revision = (feedback: string) =>
      backgroundRequest({
        id: "llm-call:background-2",
        revision: { previousCallId: "llm-call:background", feedback },
      });
    expect((await post(origin, "/ai/background", revision("Add gcd."))).status).toBe(200);
    const replay = await post(origin, "/ai/background", revision("Add gcd."));
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(count).toBe(2);
    const changed = await post(origin, "/ai/background", revision("Remove gcd."));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ diagnostics: [{ code: "call-id-conflict" }] });
    expect(count).toBe(2);
  });

  it("answers 404 for an unknown call or a call owned by another construction", async () => {
    let count = 0;
    const { origin } = await running({
      ai: backgroundRuntime(async () => {
        count += 1;
        return proposalOutput();
      }),
    });
    await post(origin, "/ai/background", backgroundRequest());
    expect(count).toBe(1);
    const unknown = await post(
      origin,
      "/ai/background",
      backgroundRequest({
        id: "llm-call:revision",
        revision: { previousCallId: "llm-call:missing", feedback: "More." },
      }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ diagnostics: [{ code: "call-not-found" }] });
    const foreign = await post(
      origin,
      "/ai/background",
      backgroundRequest({
        constructionId: "construction:other",
        id: "llm-call:revision",
        revision: { previousCallId: "llm-call:background", feedback: "More." },
      }),
    );
    expect(foreign.status).toBe(404);
    const malformedId = await post(
      origin,
      "/ai/background",
      backgroundRequest({
        id: "llm-call:revision",
        revision: { previousCallId: "not a stable id!", feedback: "More." },
      }),
    );
    expect(malformedId.status).toBe(400);
    expect(count).toBe(1);
  });

  it("answers 409 when the referenced call is not a validated background proposal", async () => {
    const outputs: unknown[] = [
      { result: { kind: "topic-manifest", domains: [] } },
      { kind: "declined", reason: "Not mathematics." },
    ];
    let index = 0;
    const { origin } = await running({
      ai: backgroundRuntime(async () => outputs[index++] ?? proposalOutput()),
    });
    await post(origin, "/ai/background", backgroundRequest({ id: "llm-call:rejected" }));
    await post(origin, "/ai/background", backgroundRequest({ id: "llm-call:declined" }));
    for (const previousCallId of ["llm-call:rejected", "llm-call:declined"]) {
      const response = await post(
        origin,
        "/ai/background",
        backgroundRequest({
          id: `llm-call:revision-of-${previousCallId.split(":")[1]}`,
          revision: { previousCallId, feedback: "Try again." },
        }),
      );
      expect(response.status, previousCallId).toBe(409);
      expect(await response.json()).toMatchObject({
        diagnostics: [{ code: "proposal-not-revisable" }],
      });
    }
    expect(index).toBe(2);
  });

  it("refuses to revise a call of another role in the same construction", async () => {
    const { origin, calls } = await running({
      ai: {
        ...backgroundRuntime(async () => proposalOutput()),
        "topic-extractor": {
          transport: async () => ({
            result: {
              kind: "topic-manifest",
              domains: ["sets"],
              objectKinds: [],
              vocabulary: [],
              notation: [],
              backgroundTopics: [],
              customOperators: [],
            },
          }),
          dispatch,
        },
      },
    });
    const topics = await post(origin, "/ai/topics", {
      constructionId: CONSTRUCTION,
      id: "llm-call:topics",
      problem: PROBLEM,
      background: setDraft().background,
    });
    expect(topics.status).toBe(200);
    const response = await post(
      origin,
      "/ai/background",
      backgroundRequest({
        id: "llm-call:revision",
        revision: { previousCallId: "llm-call:topics", feedback: "More." },
      }),
    );
    expect(response.status).toBe(409);
    expect((await calls.listCallsForOwner({ kind: "construction", id: CONSTRUCTION })).length).toBe(
      1,
    );
  });
});

describe("background decision endpoint", () => {
  async function proposed(constants?: readonly Record<string, unknown>[]) {
    const scenario = await running({
      ai: backgroundRuntime(async () => proposalOutput(constants)),
    });
    expect((await post(scenario.origin, "/ai/background", backgroundRequest())).status).toBe(200);
    return scenario;
  }

  it("records an approval of the stored proposal idempotently", async () => {
    const { origin, store } = await proposed();
    const first = await post(origin, "/ai/background/decisions", decision());
    expect(first.status).toBe(201);
    const body = (await first.json()) as {
      decision: { proposal: { kind: string; constants: unknown[] } };
    };
    expect(body).toMatchObject({
      status: "recorded",
      replayed: false,
      decision: {
        id: "background-decision:1",
        reviewerId: "actor:web",
        decision: "approved",
        approvedManifestId: "background-approval:background-decision:1",
        proposal: { kind: "background-proposal" },
      },
      approvedBackground: {
        id: "background-approval:background-decision:1",
        sourceCallId: "llm-call:background",
        decisionId: "background-decision:1",
        proposal: { kind: "background-proposal" },
      },
    });
    expect(body.decision.proposal.constants).toHaveLength(1);
    const retry = await post(origin, "/ai/background/decisions", decision());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ replayed: true });
    expect(store.sessions.size).toBe(0);
  });

  it("records a rejection without an approved background", async () => {
    const { origin } = await proposed();
    const response = await post(
      origin,
      "/ai/background/decisions",
      decision({ decision: "rejected", rationale: "Too narrow." }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ decision: { decision: "rejected" } });
    expect(body.approvedBackground).toBeUndefined();
  });

  it("refuses a reused decision ID, an unknown call, a forged proposal and a foreign construction", async () => {
    const { origin } = await proposed();
    await post(origin, "/ai/background/decisions", decision());
    const conflict = await post(
      origin,
      "/ai/background/decisions",
      decision({ decision: "rejected", rationale: "Changed my mind." }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      diagnostics: [{ code: "decision-id-conflict" }],
    });
    const unknown = await post(
      origin,
      "/ai/background/decisions",
      decision({ decisionId: "background-decision:2", callId: "llm-call:missing" }),
    );
    expect(unknown.status).toBe(404);
    const forged = await post(
      origin,
      "/ai/background/decisions",
      decision({
        decisionId: "background-decision:3",
        proposal: proposalOutput([]).result,
      }),
    );
    expect(forged.status).toBe(400);
    const foreign = await post(
      origin,
      "/ai/background/decisions",
      decision({ decisionId: "background-decision:4", constructionId: "construction:other" }),
    );
    expect(foreign.status).toBe(404);
  });

  it("does not let a topic decision ID be reused for a background decision", async () => {
    const { origin } = await running({
      ai: {
        ...backgroundRuntime(async () => proposalOutput()),
        "topic-extractor": {
          transport: async () => ({
            result: {
              kind: "topic-manifest",
              domains: ["sets"],
              objectKinds: [],
              vocabulary: [],
              notation: [],
              backgroundTopics: [],
              customOperators: [],
            },
          }),
          dispatch,
        },
      },
    });
    await post(origin, "/ai/background", backgroundRequest());
    await post(origin, "/ai/topics", {
      constructionId: CONSTRUCTION,
      id: "llm-call:topics",
      problem: PROBLEM,
      background: setDraft().background,
    });
    const topicDecision = await post(origin, "/ai/topics/decisions", {
      ...decision({ callId: "llm-call:topics", decisionId: "shared-decision:1" }),
    });
    expect(topicDecision.status).toBe(201);
    const crossed = await post(
      origin,
      "/ai/background/decisions",
      decision({ decisionId: "shared-decision:1" }),
    );
    expect(crossed.status).toBe(409);
    expect(await crossed.json()).toMatchObject({ diagnostics: [{ code: "decision-id-conflict" }] });
    // And a topic call cannot be decided as a background proposal.
    const wrongRole = await post(
      origin,
      "/ai/background/decisions",
      decision({ decisionId: "background-decision:9", callId: "llm-call:topics" }),
    );
    expect(wrongRole.status).toBe(409);
    expect(await wrongRole.json()).toMatchObject({
      diagnostics: [{ code: "proposal-not-reviewable" }],
    });
  });

  it("refuses to approve a constant that clashes with the global operator registry, but allows rejecting", async () => {
    const wrongSignature = wireOperator({
      id: "operator:my-divides",
      symbol: "Divides",
      parameters: ["natural", "natural"],
      latex: { template: String.raw`#1\mid #2`, precedence: "relation", parse: null },
    });
    const { origin } = await proposed([wrongSignature]);
    const approve = await post(origin, "/ai/background/decisions", decision());
    expect(approve.status).toBe(409);
    expect(await approve.json()).toMatchObject({
      diagnostics: [
        {
          code: "approved-constant-conflict",
          message: expect.stringContaining("Divides is already an operator of the pack"),
        },
      ],
    });
    const reject = await post(
      origin,
      "/ai/background/decisions",
      decision({ decision: "rejected", rationale: "It clashes." }),
    );
    expect(reject.status).toBe(201);
  });

  it("also refuses a constant that reuses another registry operator's ID or LaTeX trigger", async () => {
    const { origin } = await proposed([
      wireOperator({ id: "operator:divides" }),
      wireOperator({
        id: "operator:second",
        symbol: "Second",
        latex: {
          template: String.raw`#1\mid #2`,
          precedence: "relation",
          parse: { trigger: String.raw`\mid`, notation: "infix" },
        },
      }),
    ]);
    const approve = await post(origin, "/ai/background/decisions", decision());
    expect(approve.status).toBe(409);
    const message = ((await approve.json()) as { diagnostics: [{ message: string }] })
      .diagnostics[0].message;
    expect(message).toContain("ID operator:divides");
    expect(message).toContain("LaTeX trigger \\mid");
  });

  it("accepts a constant that repeats a registry operator's symbol and signature", async () => {
    const reference = wireOperator({
      id: "operator:my-divides",
      symbol: "Divides",
      latex: { template: String.raw`#1\mid #2`, precedence: "relation", parse: null },
      naturalLanguage: { template: "#1 divides #2", negated: null },
    });
    const { origin } = await proposed([reference]);
    expect((await post(origin, "/ai/background/decisions", decision())).status).toBe(201);
  });
});

describe("background-proposer capability", () => {
  it("is reported only when the role has a transport and evidence storage", async () => {
    const roles = async (scenario: Running) =>
      (
        (await (await fetch(`${scenario.origin}/ai/capabilities`)).json()) as {
          roles: Record<string, boolean>;
        }
      ).roles;
    expect(await roles(await running())).toMatchObject({ "background-proposer": false });
    const configured = await running({ ai: backgroundRuntime(async () => proposalOutput()) });
    expect(await roles(configured)).toEqual({
      "topic-extractor": false,
      "background-proposer": true,
      librarian: false,
      "proof-state-formalizer": false,
      "move-shortlister": false,
      "move-executor": false,
      "move-author": false,
    });
    const unstored = await running({
      ai: backgroundRuntime(async () => proposalOutput()),
      calls: null,
    });
    expect(await roles(unstored)).toMatchObject({ "background-proposer": false });
  });
});

describe("formalizer with an approved background", () => {
  const FORMALIZER_CALL = "llm-call:formalize";

  function formalizeRequest(overrides: Record<string, unknown> = {}) {
    return {
      constructionId: CONSTRUCTION,
      id: FORMALIZER_CALL,
      problem: PROBLEM,
      background: setDraft().background,
      preferences: setDraft().preferences,
      libraryLayerIds: ["layer:global", "layer:initial-problem"],
      packs: [],
      approvedBackground: { decisionId: "background-decision:1" },
      ...overrides,
    };
  }

  function draftFor(call: PreparedLlmCall, overrides: Record<string, unknown> = {}) {
    if (call.envelope.role !== "proof-state-formalizer") throw new Error("Expected formalizer.");
    const { context } = call.envelope;
    const draft = setDraft({
      problem: context.problem,
      background: context.background,
      ...(context.preferences === undefined ? {} : { preferences: context.preferences }),
      libraryLayerIds: context.libraryLayerIds,
      packs: context.packs,
      declarations: [
        { symbol: "m", sort: "integer" },
        { symbol: "n", sort: "integer" },
      ],
      hypotheses: [],
      goals: [{ format: "latex", latex: String.raw`m \perp n` }],
      ...overrides,
    });
    return {
      result: {
        kind: "formalization",
        draft: {
          ...draft,
          background: {
            ...draft.background,
            domains: draft.background.domains ?? null,
            maximumLevel: draft.background.maximumLevel ?? null,
          },
          preferences: {
            domains: draft.preferences?.domains ?? null,
            notation: draft.preferences?.notation ?? null,
          },
        },
      },
    };
  }

  async function approvedScenario(
    formalizer: LlmTransport,
    constants: readonly Record<string, unknown>[] = [wireOperator()],
  ) {
    const scenario = await running({
      ai: {
        "background-proposer": { transport: async () => proposalOutput(constants), dispatch },
        "proof-state-formalizer": { transport: formalizer, dispatch },
      },
    });
    expect((await post(scenario.origin, "/ai/background", backgroundRequest())).status).toBe(200);
    expect((await post(scenario.origin, "/ai/background/decisions", decision())).status).toBe(201);
    return scenario;
  }

  it("gives the formalizer the approved constants from storage and admits a draft that uses them", async () => {
    const seen: PreparedLlmCall[] = [];
    const { origin, store } = await approvedScenario(async (call) => {
      seen.push(call);
      return draftFor(call);
    });
    const response = await post(
      origin,
      "/ai/formalize",
      formalizeRequest({ packs: ["pack:sets"] }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      review: { operators: { symbol: string }[]; digest: string };
      proofState: unknown;
    };
    expect(body.status).toBe("ready-for-review");
    expect(body.review.operators.map(({ symbol }) => symbol)).toEqual([
      "Union",
      "Intersection",
      "Coprime",
    ]);
    const envelope = seen[0]!.envelope;
    if (envelope.role !== "proof-state-formalizer") throw new Error("Expected formalizer.");
    expect(envelope.context.approvedLibrary.operators.map(({ symbol }) => symbol)).toEqual([
      "Union",
      "Intersection",
      "Coprime",
    ]);
    expect(seen[0]!.messages[0].content).toContain("only the operators listed");
    expect(JSON.stringify(envelope)).not.toContain("approvedBackground");
    expect(store.sessions.size).toBe(0);
  });

  it("passes only the selected packs' operators when nothing was approved", async () => {
    const seen: PreparedLlmCall[] = [];
    const { origin } = await running({
      ai: {
        "proof-state-formalizer": {
          transport: async (call) => {
            seen.push(call);
            return { result: { kind: "declined", reason: "Stop after the context." } };
          },
          dispatch,
        },
      },
    });
    const response = await post(
      origin,
      "/ai/formalize",
      formalizeRequest({ approvedBackground: undefined, packs: ["pack:sets"] }),
    );
    expect(response.status).toBe(200);
    const envelope = seen[0]!.envelope;
    if (envelope.role !== "proof-state-formalizer") throw new Error("Expected formalizer.");
    expect(envelope.context.approvedLibrary.operators.map(({ symbol }) => symbol)).toEqual([
      "Union",
      "Intersection",
    ]);
  });

  it("resolves the constants by decision ID only: unknown, rejected, foreign and client-supplied are refused", async () => {
    let calls = 0;
    const scenario = await approvedScenario(async (call) => {
      calls += 1;
      return draftFor(call);
    });
    const { origin } = scenario;
    const unknown = await post(
      origin,
      "/ai/formalize",
      formalizeRequest({ approvedBackground: { decisionId: "background-decision:missing" } }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ diagnostics: [{ code: "decision-not-found" }] });
    const foreign = await post(
      origin,
      "/ai/formalize",
      formalizeRequest({ constructionId: "construction:other" }),
    );
    expect(foreign.status).toBe(404);
    // A rejected decision grants nothing.
    await post(
      origin,
      "/ai/background/decisions",
      decision({ decisionId: "background-decision:rejected", decision: "rejected" }),
    );
    const rejected = await post(
      origin,
      "/ai/formalize",
      formalizeRequest({ approvedBackground: { decisionId: "background-decision:rejected" } }),
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      diagnostics: [{ code: "decision-not-approved" }],
    });
    // Declarations supplied by the client are refused outright.
    for (const smuggled of [
      { operators: [wireOperator()] },
      { approvedBackground: { decisionId: "background-decision:1", operators: [] } },
      { approvedBackground: { constants: [wireOperator()] } },
    ]) {
      const response = await post(origin, "/ai/formalize", formalizeRequest(smuggled));
      expect(response.status, JSON.stringify(smuggled)).toBe(400);
    }
    expect(calls).toBe(0);
  });

  it("returns needs-review with an unapproved-constant diagnostic for an operator outside the approved set", async () => {
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
      [
        "an invented operator",
        { goals: [{ format: "mathjson", expression: ["Gcd", "m", "n"] }] },
        /Goal 1 applies the operator Gcd, which is not an approved constant/,
      ],
      [
        "an operator applied inside a hypothesis",
        {
          hypotheses: [{ format: "mathjson", expression: ["Equal", ["Lcm", "m", "n"], "m"] }],
          goals: [{ format: "latex", latex: String.raw`m \perp n` }],
        },
        /Hypothesis 1 applies the operator Lcm/,
      ],
      [
        "a registry operator whose pack is not selected",
        { goals: [{ format: "mathjson", expression: ["Divides", "m", "n"] }] },
        /Divides.*belongs to the pack pack:divisibility, which is not selected/,
      ],
    ];
    for (const [label, overrides, message] of cases) {
      const { origin, store } = await approvedScenario(async (call) => draftFor(call, overrides));
      const response = await post(origin, "/ai/formalize", formalizeRequest());
      expect(response.status, label).toBe(422);
      const body = (await response.json()) as {
        status: string;
        proofState?: unknown;
        diagnostics: { code: string; message: string; path: unknown[] }[];
      };
      expect(body.status, label).toBe("needs-review");
      expect(body.proofState).toBeUndefined();
      expect(body.diagnostics, label).toHaveLength(1);
      expect(body.diagnostics[0]).toMatchObject({ code: "unapproved-constant" });
      expect(body.diagnostics[0]!.message, label).toMatch(message);
      expect(store.sessions.size).toBe(0);
    }
  });

  it("reports an approved constant as unapproved when no background was approved", async () => {
    const { origin } = await running({
      ai: {
        "proof-state-formalizer": {
          transport: async (call) =>
            draftFor(call, {
              goals: [{ format: "mathjson", expression: ["Coprime", "m", "n"] }],
            }),
          dispatch,
        },
      },
    });
    const response = await post(
      origin,
      "/ai/formalize",
      formalizeRequest({ approvedBackground: undefined }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      status: "needs-review",
      diagnostics: [{ code: "unapproved-constant" }],
    });
  });

  it("uses a registry operator's own declaration when a constant references it", async () => {
    const reference = wireOperator({
      id: "operator:my-divides",
      symbol: "Divides",
      latex: { template: String.raw`#1\mid #2`, precedence: "relation", parse: null },
      naturalLanguage: { template: "#1 divides #2", negated: null },
    });
    const { origin } = await approvedScenario(
      async (call) =>
        draftFor(call, { goals: [{ format: "mathjson", expression: ["Divides", "m", "n"] }] }),
      [reference],
    );
    const response = await post(origin, "/ai/formalize", formalizeRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      review: { operators: unknown[]; activePackIds: string[] };
    };
    const registry = starterLibraryPacks()
      .find(({ id }) => id === "pack:divisibility")!
      .operators.filter(({ symbol }) => symbol === "Divides");
    expect(body.review.operators).toEqual(registry);
    expect(body.review.activePackIds).toContain("pack:divisibility");
  });

  it("checks and approves a setup that uses the constants only when the decision is named", async () => {
    const { origin, store } = await approvedScenario(async (call) => draftFor(call));
    const formalized = await post(origin, "/ai/formalize", formalizeRequest());
    const { draft } = (await formalized.json()) as { draft: unknown };
    const reference = { constructionId: CONSTRUCTION, decisionId: "background-decision:1" };

    // Without the reference the constants are unknown to the setup check.
    const bare = await post(origin, "/problem-drafts/validate", { draft });
    expect(bare.status).toBe(422);

    const checked = await post(origin, "/problem-drafts/validate", {
      draft,
      approvedBackground: reference,
    });
    expect(checked.status).toBe(200);
    const review = (
      (await checked.json()) as {
        review: { digest: string; operators: { symbol: string }[] };
      }
    ).review;
    expect(review.operators.map(({ symbol }) => symbol)).toContain("Coprime");

    const withoutReference = await post(origin, "/proof-sessions", {
      sessionId: "session:coprime",
      draft,
      reviewedDigest: review.digest,
    });
    expect(withoutReference.status).toBe(422);
    expect(store.sessions.size).toBe(0);

    const approved = await post(origin, "/proof-sessions", {
      sessionId: "session:coprime",
      draft,
      reviewedDigest: review.digest,
      approvedBackground: reference,
    });
    expect(approved.status).toBe(201);
    const created = (await approved.json()) as { session: { operators: { symbol: string }[] } };
    expect(created.session.operators.map(({ symbol }) => symbol)).toContain("Coprime");
    expect(store.sessions.size).toBe(1);
    const replay = await post(origin, "/proof-sessions", {
      sessionId: "session:coprime",
      draft,
      reviewedDigest: review.digest,
      approvedBackground: reference,
    });
    expect(replay.status).toBe(200);
  });

  it("refuses an unresolvable or malformed approved background on the setup routes", async () => {
    const { origin, store } = await approvedScenario(async (call) => draftFor(call));
    const { draft } = (await (await post(origin, "/ai/formalize", formalizeRequest())).json()) as {
      draft: unknown;
    };
    const missing = { constructionId: CONSTRUCTION, decisionId: "background-decision:missing" };
    expect(
      (await post(origin, "/problem-drafts/validate", { draft, approvedBackground: missing }))
        .status,
    ).toBe(404);
    expect(
      (
        await post(origin, "/proof-sessions", {
          sessionId: "session:x",
          draft,
          reviewedDigest: `sha256:${"0".repeat(64)}`,
          approvedBackground: missing,
        })
      ).status,
    ).toBe(404);
    for (const malformed of [
      { constructionId: CONSTRUCTION },
      { constructionId: CONSTRUCTION, decisionId: "background-decision:1", operators: [] },
      "background-decision:1",
    ]) {
      expect(
        (await post(origin, "/problem-drafts/validate", { draft, approvedBackground: malformed }))
          .status,
      ).toBe(400);
      expect(
        (
          await post(origin, "/proof-sessions", {
            sessionId: "session:x",
            draft,
            reviewedDigest: `sha256:${"0".repeat(64)}`,
            approvedBackground: malformed,
          })
        ).status,
      ).toBe(400);
    }
    expect(store.sessions.size).toBe(0);
  });

  it("treats another set of constants than the reviewed one as a stale review", async () => {
    const extra = wireOperator({
      id: "operator:other",
      symbol: "Other",
      latex: { template: String.raw`#1\sim #2`, precedence: "relation", parse: null },
    });
    const { origin, store } = await running({
      ai: {
        "background-proposer": {
          transport: async (call) =>
            proposalOutput(
              call.id === "llm-call:background-b" ? [wireOperator(), extra] : [wireOperator()],
            ),
          dispatch,
        },
        "proof-state-formalizer": { transport: async (call) => draftFor(call), dispatch },
      },
    });
    await post(origin, "/ai/background", backgroundRequest());
    await post(origin, "/ai/background/decisions", decision());
    // A second approved background adds a constant the draft does not use.
    await post(origin, "/ai/background", backgroundRequest({ id: "llm-call:background-b" }));
    await post(
      origin,
      "/ai/background/decisions",
      decision({ decisionId: "background-decision:2", callId: "llm-call:background-b" }),
    );
    const { draft } = (await (await post(origin, "/ai/formalize", formalizeRequest())).json()) as {
      draft: unknown;
    };
    const first = { constructionId: CONSTRUCTION, decisionId: "background-decision:1" };
    const second = { constructionId: CONSTRUCTION, decisionId: "background-decision:2" };
    const { review } = (await (
      await post(origin, "/problem-drafts/validate", { draft, approvedBackground: first })
    ).json()) as { review: { digest: string } };
    const stale = await post(origin, "/proof-sessions", {
      sessionId: "session:stale",
      draft,
      reviewedDigest: review.digest,
      approvedBackground: second,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ diagnostics: [{ code: "review-stale" }] });
    expect(store.sessions.size).toBe(0);
    const approved = await post(origin, "/proof-sessions", {
      sessionId: "session:stale",
      draft,
      reviewedDigest: review.digest,
      approvedBackground: first,
    });
    expect(approved.status).toBe(201);
  });
});
