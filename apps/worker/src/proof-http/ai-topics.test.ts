import { afterEach, describe, expect, it } from "vitest";
import type { LlmTransport, PreparedLlmCall } from "@proof/llm";
import { setDraft } from "../problem-setup.testing";
import { InspectableMemoryProofStore } from "../memory-proof-store.testing";
import { MemoryLlmCallStore } from "../memory-llm-call-store";
import { createProofHttpService, type ProofHttpService } from ".";
import type { AiRuntime } from "../ai-runtime";

const services: ProofHttpService[] = [];
const dispatch = {
  provider: "test-provider",
  model: "test-topics",
  promptVersion: "topic-test-v1",
} as const;

const MANIFEST = {
  kind: "topic-manifest",
  domains: ["set theory"],
  objectKinds: ["sets"],
  vocabulary: ["union", "commutativity"],
  notation: [{ symbol: "∪", meaning: "set union" }],
  backgroundTopics: ["basic set operations"],
  customOperators: [],
} as const;

async function running(
  options: { ai?: AiRuntime; calls?: MemoryLlmCallStore | null } = {},
): Promise<{ origin: string; store: InspectableMemoryProofStore; calls: MemoryLlmCallStore }> {
  const store = new InspectableMemoryProofStore();
  const calls = options.calls ?? new MemoryLlmCallStore();
  const service = createProofHttpService(store, {
    ...(options.calls === null ? {} : { llmCalls: calls }),
    ...(options.ai === undefined ? {} : { ai: options.ai }),
  });
  services.push(service);
  return { origin: (await service.listen()).origin, store, calls };
}

function topicRuntime(transport: LlmTransport): AiRuntime {
  return { "topic-extractor": { transport, dispatch } };
}

async function post(origin: string, path: string, body: unknown) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function topicRequest(overrides: Record<string, unknown> = {}) {
  return {
    constructionId: "construction:topics",
    id: "llm-call:topics",
    problem: {
      title: "Union commutes",
      statement: "Show that A union B = B union A for sets A and B.",
    },
    background: setDraft().background,
    preferences: { domains: ["sets"] },
    ...overrides,
  };
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    constructionId: "construction:topics",
    decisionId: "topic-decision:1",
    callId: "llm-call:topics",
    decision: "approved",
    rationale: "Matches the problem.",
    decidedAt: "2026-10-13T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("AI capabilities endpoint", () => {
  it("reports every supported role as unavailable without a runtime", async () => {
    const { origin } = await running();
    const response = await fetch(`${origin}/ai/capabilities`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      roles: {
        "topic-extractor": false,
        "proof-state-formalizer": false,
        "move-shortlister": false,
      },
    });
  });

  it("reports only configured roles, and none without evidence storage", async () => {
    const transport: LlmTransport = async () => ({ result: MANIFEST });
    const configured = await running({ ai: topicRuntime(transport) });
    expect(await (await fetch(`${configured.origin}/ai/capabilities`)).json()).toEqual({
      roles: {
        "topic-extractor": true,
        "proof-state-formalizer": false,
        "move-shortlister": false,
      },
    });
    const unstored = await running({ ai: topicRuntime(transport), calls: null });
    const roles = (
      (await (await fetch(`${unstored.origin}/ai/capabilities`)).json()) as {
        roles: Record<string, boolean>;
      }
    ).roles;
    expect(Object.values(roles).every((value) => !value)).toBe(true);
    expect((await post(configured.origin, "/ai/capabilities", {})).status).toBe(405);
  });
});

describe("topic extractor endpoint", () => {
  it("returns a recorded manifest proposal from problem and background only", async () => {
    const seen: PreparedLlmCall[] = [];
    const { origin, store } = await running({
      ai: topicRuntime(async (call) => {
        seen.push(call);
        return { result: MANIFEST };
      }),
    });
    const response = await post(origin, "/ai/topics", topicRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "proposed",
      provenance: { kind: "minimal-context-llm", role: "topic-extractor" },
      callId: "llm-call:topics",
      replayed: false,
      proposal: MANIFEST,
    });
    expect(seen).toHaveLength(1);
    const envelope = seen[0]!.envelope;
    expect(envelope.role).toBe("topic-extractor");
    if (envelope.role !== "topic-extractor") return;
    expect(Object.keys(envelope.context).sort()).toEqual(["background", "preferences", "problem"]);
    expect(envelope.context.problem).toContain("A union B = B union A");
    expect(envelope.context.preferences).toEqual({ domains: ["sets"], notation: [] });
    expect(store.sessions.size).toBe(0);
    expect(store.nodes.size).toBe(0);
  });

  it("replays a repeated call ID without contacting the provider again", async () => {
    let count = 0;
    const { origin } = await running({
      ai: topicRuntime(async () => {
        count += 1;
        return { result: MANIFEST };
      }),
    });
    await post(origin, "/ai/topics", topicRequest());
    const replay = await post(origin, "/ai/topics", topicRequest());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: "proposed", replayed: true });
    expect(count).toBe(1);
  });

  it("answers 503 when the role is not configured", async () => {
    const { origin } = await running();
    const response = await post(origin, "/ai/topics", topicRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "disabled",
      diagnostics: [{ code: "ai-disabled" }],
    });
  });

  it("rejects invalid requests before any provider call", async () => {
    let count = 0;
    const { origin } = await running({
      ai: topicRuntime(async () => {
        count += 1;
        return { result: MANIFEST };
      }),
    });
    expect((await post(origin, "/ai/topics", topicRequest({ solution: "x" }))).status).toBe(400);
    expect(
      (await post(origin, "/ai/topics", topicRequest({ preferences: { domains: [7] } }))).status,
    ).toBe(400);
    expect(
      (await post(origin, "/ai/topics", topicRequest({ background: { level: "x" } }))).status,
    ).toBe(400);
    expect(count).toBe(0);
  });

  it.each([
    ["an extra field carrying a solution", { ...MANIFEST, solution: "By extensionality." }],
    ["a non-manifest kind", { kind: "formalization", draft: {} }],
    ["duplicate vocabulary", { ...MANIFEST, vocabulary: ["union", "union"] }],
  ])("records and rejects %s without creating anything", async (_name, output) => {
    const { origin, store, calls } = await running({
      ai: topicRuntime(async () => ({ result: output })),
    });
    const response = await post(origin, "/ai/topics", topicRequest());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ status: "rejected", callId: "llm-call:topics" });
    expect(
      (await calls.listCallsForOwner({ kind: "construction", id: "construction:topics" })).length,
    ).toBe(1);
    expect(store.sessions.size).toBe(0);
    const approve = await post(origin, "/ai/topics/decisions", decision());
    expect(approve.status).toBe(409);
  });

  it("relays a context request or refusal as a non-proposal", async () => {
    const { origin } = await running({
      ai: topicRuntime(async () => ({
        result: { kind: "declined", reason: "Not a mathematics problem." },
      })),
    });
    const response = await post(origin, "/ai/topics", topicRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "declined",
      result: { kind: "declined", reason: "Not a mathematics problem." },
    });
  });
});

describe("topic decision endpoint", () => {
  async function proposed() {
    const running_ = await running({ ai: topicRuntime(async () => ({ result: MANIFEST })) });
    expect((await post(running_.origin, "/ai/topics", topicRequest())).status).toBe(200);
    return running_;
  }

  it("records an approval of the stored proposal idempotently", async () => {
    const { origin, store } = await proposed();
    const first = await post(origin, "/ai/topics/decisions", decision());
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(body).toMatchObject({
      status: "recorded",
      replayed: false,
      decision: {
        id: "topic-decision:1",
        reviewerId: "actor:web",
        decision: "approved",
        proposal: MANIFEST,
        approvedManifestId: "topic-manifest:topic-decision:1",
      },
      approvedManifest: {
        id: "topic-manifest:topic-decision:1",
        sourceCallId: "llm-call:topics",
        manifest: MANIFEST,
      },
    });
    const retry = await post(origin, "/ai/topics/decisions", decision());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ replayed: true });
    expect(store.sessions.size).toBe(0);
  });

  it("records a rejection without an approved manifest", async () => {
    const { origin } = await proposed();
    const response = await post(
      origin,
      "/ai/topics/decisions",
      decision({ decision: "rejected", rationale: "Too narrow." }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ decision: { decision: "rejected" } });
    expect(body.approvedManifest).toBeUndefined();
  });

  it("refuses a reused decision ID, an unknown call, and a client-supplied proposal", async () => {
    const { origin } = await proposed();
    await post(origin, "/ai/topics/decisions", decision());
    const conflict = await post(
      origin,
      "/ai/topics/decisions",
      decision({ decision: "rejected", rationale: "Changed my mind." }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      diagnostics: [{ code: "decision-id-conflict" }],
    });
    const unknown = await post(
      origin,
      "/ai/topics/decisions",
      decision({ decisionId: "topic-decision:2", callId: "llm-call:missing" }),
    );
    expect(unknown.status).toBe(404);
    const forged = await post(
      origin,
      "/ai/topics/decisions",
      decision({ decisionId: "topic-decision:3", proposal: { ...MANIFEST, domains: ["x"] } }),
    );
    expect(forged.status).toBe(400);
  });

  it("refuses a call owned by another construction", async () => {
    const { origin } = await proposed();
    const response = await post(
      origin,
      "/ai/topics/decisions",
      decision({ constructionId: "construction:other" }),
    );
    expect(response.status).toBe(404);
  });
});
