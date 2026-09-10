import { describe, expect, it } from "vitest";
import {
  buildTopicExtractorContext,
  prepareLlmCall,
  type LlmTransport,
  type PreparedLlmCall,
  type TopicManifestProposal,
} from "@proof/llm";
import {
  readLlmCall,
  recordTopicProposalDecision,
  runDurableLlmCall,
  type LlmCallOwner,
  type LlmCallStore,
  type LlmCallStoreTransaction,
  type StoredLlmCall,
  type TopicProposalDecision,
} from "./llm-call-repository";

const owner = { kind: "construction", id: "construction:one" } as const satisfies LlmCallOwner;
const dispatch = {
  provider: "test-provider",
  model: "test-model",
  promptVersion: "topic-v1",
} as const;
const proposal: TopicManifestProposal = {
  kind: "topic-manifest",
  domains: ["graph theory"],
  objectKinds: ["finite graph", "tree"],
  vocabulary: ["leaf"],
  notation: [{ symbol: "V", meaning: "vertex set" }],
  backgroundTopics: ["finite graphs"],
  customOperators: [],
};

function topicCall(id = "llm-call:topic"): PreparedLlmCall {
  const context = buildTopicExtractorContext({
    id,
    problem: "Show that every finite tree has a leaf.",
    background: {
      level: "undergraduate",
      summary: "Elementary graph theory.",
      assumptions: ["Finite graph definitions"],
    },
  });
  if (!context.ok) throw new Error(context.diagnostics[0].message);
  const prepared = prepareLlmCall(context.envelope);
  if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
  return prepared.call;
}

class MemoryLlmCallStore implements LlmCallStore {
  readonly calls = new Map<string, unknown>();
  readonly decisions = new Map<string, unknown>();
  proofState = { currentNodeId: "node:untouched" };

  async transaction<Result>(
    work: (transaction: LlmCallStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    return work({
      readCallForUpdate: async (recordOwner, callId) => this.calls.get(key(recordOwner, callId)),
      insertCall: async (record) => {
        this.calls.set(key(record.owner, record.id), structuredClone(record));
      },
      completeCall: async (record) => {
        const recordKey = key(record.owner, record.id);
        const existing = this.calls.get(recordKey) as StoredLlmCall | undefined;
        if (existing?.status !== "dispatching") return false;
        this.calls.set(recordKey, structuredClone(record));
        return true;
      },
      readDecisionForUpdate: async (recordOwner, decisionId) =>
        this.decisions.get(key(recordOwner, decisionId)),
      insertDecision: async (decision) => {
        this.decisions.set(key(decision.owner, decision.id), structuredClone(decision));
      },
    });
  }
}

function key(recordOwner: LlmCallOwner, id: string): string {
  return `${recordOwner.kind}/${recordOwner.id}/${id}`;
}

function runInput(call = topicCall()) {
  return { owner, call, dispatch };
}

function approval(overrides: Partial<TopicProposalDecision> = {}) {
  return {
    id: "decision:topic",
    owner,
    callId: "llm-call:topic",
    reviewerId: "user:reviewer",
    decidedAt: "2026-09-10T05:00:00+00:00",
    proposal,
    rationale: "The manifest is broad and contains no disguised solution.",
    decision: "approved",
    approvedManifestId: "manifest:approved",
    ...overrides,
  };
}

describe("durable LLM calls", () => {
  it("records the exact request before transport and replays a completed call", async () => {
    const store = new MemoryLlmCallStore();
    let calls = 0;
    const transport: LlmTransport = async (call) => {
      calls += 1;
      expect(store.calls.get(key(owner, call.id))).toMatchObject({
        status: "dispatching",
        preparedCall: call,
      });
      return proposal;
    };
    const first = await runDurableLlmCall(store, runInput(), transport);
    expect(first).toMatchObject({
      status: "completed",
      replayed: false,
      record: { status: "completed", evidence: { status: "validated", output: proposal } },
    });
    const replay = await runDurableLlmCall(store, runInput(), async () => {
      throw new Error("Replay must not invoke transport.");
    });
    expect(replay).toMatchObject({ status: "completed", replayed: true });
    expect(calls).toBe(1);
    expect(store.proofState).toEqual({ currentNodeId: "node:untouched" });
  });

  it("rejects a changed request under the same call ID", async () => {
    const store = new MemoryLlmCallStore();
    await runDurableLlmCall(store, runInput(), async () => proposal);
    const changed = structuredClone(topicCall());
    if (changed.envelope.role !== "topic-extractor") throw new Error("Expected topic call.");
    changed.envelope.context.problem = "A different problem.";
    changed.messages[1].content = JSON.stringify(changed.envelope);
    expect(await runDurableLlmCall(store, runInput(changed), async () => proposal)).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "call-id-conflict" }],
    });
  });

  it("does not redispatch an unresolved claim after a crash", async () => {
    const store = new MemoryLlmCallStore();
    const call = topicCall();
    store.calls.set(key(owner, call.id), {
      owner,
      id: call.id,
      role: call.role,
      preparedCall: call,
      dispatch,
      status: "dispatching",
    });
    let invoked = false;
    const result = await runDurableLlmCall(store, runInput(call), async () => {
      invoked = true;
      return proposal;
    });
    expect(result).toMatchObject({
      status: "uncertain",
      diagnostics: [{ code: "call-in-progress-or-uncertain" }],
    });
    expect(invoked).toBe(false);
  });

  it("allows only one concurrent caller to dispatch", async () => {
    const store = new MemoryLlmCallStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invocations = 0;
    const transport: LlmTransport = async () => {
      invocations += 1;
      await gate;
      return proposal;
    };
    const first = runDurableLlmCall(store, runInput(), transport);
    await Promise.resolve();
    const second = await runDurableLlmCall(store, runInput(), transport);
    expect(second).toMatchObject({ status: "uncertain" });
    expect(invocations).toBe(1);
    release();
    expect(await first).toMatchObject({ status: "completed" });
  });

  it("durably records transport failures and malformed output", async () => {
    const failedStore = new MemoryLlmCallStore();
    const failed = await runDurableLlmCall(failedStore, runInput(), async () => {
      throw new Error("offline");
    });
    expect(failed).toMatchObject({
      status: "completed",
      record: { evidence: { status: "transport-failed" } },
    });

    const rejectedStore = new MemoryLlmCallStore();
    const rejected = await runDurableLlmCall(rejectedStore, runInput(), async () => ({
      solution: "hidden",
    }));
    expect(rejected).toMatchObject({
      status: "completed",
      record: { evidence: { status: "rejected" } },
    });
  });

  it("reads static evidence without a transport", async () => {
    const store = new MemoryLlmCallStore();
    await runDurableLlmCall(store, runInput(), async () => proposal);
    expect(await readLlmCall(store, owner, "llm-call:topic")).toMatchObject({
      status: "found",
      record: { evidence: { output: proposal } },
    });
  });
});

describe("topic proposal review", () => {
  it("records explicit approval of the exact proposal and derives an artifact", async () => {
    const store = new MemoryLlmCallStore();
    await runDurableLlmCall(store, runInput(), async () => proposal);
    const result = await recordTopicProposalDecision(store, approval());
    expect(result).toMatchObject({
      status: "recorded",
      replayed: false,
      approvedManifest: {
        id: "manifest:approved",
        sourceCallId: "llm-call:topic",
        manifest: proposal,
      },
    });
    expect(await recordTopicProposalDecision(store, approval())).toMatchObject({
      status: "recorded",
      replayed: true,
    });
    expect(store.proofState.currentNodeId).toBe("node:untouched");
  });

  it("rejects altered, superseded, and conflicting decisions", async () => {
    const store = new MemoryLlmCallStore();
    await runDurableLlmCall(store, runInput(), async () => proposal);
    expect(
      await recordTopicProposalDecision(
        store,
        approval({ proposal: { ...proposal, vocabulary: ["leaf", "root"] } }),
      ),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "proposal-not-reviewable" }],
    });

    await recordTopicProposalDecision(store, approval());
    expect(
      await recordTopicProposalDecision(store, approval({ rationale: "A different review." })),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "decision-id-conflict" }],
    });

    const callKey = key(owner, "llm-call:topic");
    const corrupted = structuredClone(store.calls.get(callKey)) as {
      evidence: { output: TopicManifestProposal };
    };
    corrupted.evidence.output = { ...proposal, vocabulary: ["root"] };
    store.calls.set(callKey, corrupted);
    expect(await recordTopicProposalDecision(store, approval())).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "proposal-not-reviewable" }],
    });
  });
});
