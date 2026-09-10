import { describe, expect, it } from "vitest";
import {
  buildTopicExtractorContext,
  executePreparedLlmCall,
  prepareLlmCall,
  type PreparedLlmCall,
  type TopicManifestProposal,
} from "@proof/llm";
import type { LlmCallOwner, StoredLlmCall, TopicProposalDecision } from "./llm-call-repository";
import { PostgresLlmCallStore } from "./postgres-llm-call-store";
import type { SqlClient, SqlPool, SqlQueryResult } from "./postgres-proof-store";
import type { ProofStoreTransactionError } from "./proof-repository";

type QueryCall = Readonly<{ text: string; values: readonly unknown[] | undefined }>;

class RecordingClient implements SqlClient {
  readonly calls: QueryCall[] = [];
  released = false;
  callRecord: unknown;
  decisionRecord: unknown;
  failCommit = false;

  async query(text: string, values?: readonly unknown[]): Promise<SqlQueryResult> {
    this.calls.push({ text, values });
    if (this.failCommit && text.trim() === "COMMIT") throw new Error("commit failed");
    if (text.includes("FROM llm_calls")) {
      return {
        rows: this.callRecord === undefined ? [] : [{ record: this.callRecord }],
        rowCount: 1,
      };
    }
    if (text.includes("FROM llm_topic_decisions")) {
      return {
        rows: this.decisionRecord === undefined ? [] : [{ record: this.decisionRecord }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: text.includes("UPDATE llm_calls") ? 1 : 0 };
  }

  release(): void {
    this.released = true;
  }
}

function poolFor(client: RecordingClient): SqlPool {
  return { connect: async () => client };
}

const owner = { kind: "construction", id: "construction:one" } as const satisfies LlmCallOwner;
const proposal: TopicManifestProposal = {
  kind: "topic-manifest",
  domains: ["graph theory"],
  objectKinds: ["tree"],
  vocabulary: ["leaf"],
  notation: [],
  backgroundTopics: ["finite graphs"],
  customOperators: [],
};

function preparedCall(): PreparedLlmCall {
  const context = buildTopicExtractorContext({
    id: "llm-call:topic",
    problem: "Every finite tree has a leaf.",
    background: { level: "undergraduate", summary: "Graph theory.", assumptions: [] },
  });
  if (!context.ok) throw new Error(context.diagnostics[0].message);
  const prepared = prepareLlmCall(context.envelope);
  if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
  return prepared.call;
}

function dispatchingRecord(): StoredLlmCall {
  const call = preparedCall();
  return {
    owner,
    id: call.id,
    role: call.role,
    preparedCall: call,
    dispatch: { provider: "test-provider", model: "test-model", promptVersion: "topic-v1" },
    status: "dispatching",
  };
}

describe("PostgresLlmCallStore", () => {
  it("locks owner-scoped records and parameterizes JSONB writes", async () => {
    const client = new RecordingClient();
    const store = new PostgresLlmCallStore(poolFor(client));
    const dispatching = dispatchingRecord();
    const evidence = await executePreparedLlmCall(dispatching.preparedCall, async () => proposal);
    const completed = {
      ...dispatching,
      status: "completed",
      evidence,
    } as const satisfies StoredLlmCall;
    const decision: TopicProposalDecision = {
      id: "decision:topic",
      owner,
      callId: dispatching.id,
      reviewerId: "user:reviewer",
      decidedAt: "2026-09-10T05:00:00+00:00",
      proposal,
      rationale: "Approved after review.",
      decision: "approved",
      approvedManifestId: "manifest:approved",
    };

    await store.transaction(async (transaction) => {
      expect(await transaction.readCallForUpdate(owner, dispatching.id)).toBeUndefined();
      await transaction.insertCall(dispatching);
      expect(await transaction.completeCall(completed)).toBe(true);
      expect(await transaction.readDecisionForUpdate(owner, decision.id)).toBeUndefined();
      await transaction.insertDecision(decision);
    });

    const advisoryLocks = client.calls.filter(({ text }) => text.includes("pg_advisory_xact_lock"));
    expect(advisoryLocks).toHaveLength(2);
    expect(advisoryLocks[0]?.values).toEqual([
      JSON.stringify(["call", "construction", "construction:one", "llm-call:topic"]),
    ]);
    const selects = client.calls.filter(({ text }) => text.includes("SELECT record"));
    expect(selects).toHaveLength(2);
    expect(selects.every(({ text }) => text.includes("FOR UPDATE"))).toBe(true);
    expect(selects[0]?.values).toEqual(["construction", "construction:one", "llm-call:topic"]);
    const insert = client.calls.find(({ text }) => text.includes("INSERT INTO llm_calls"));
    expect(insert?.values).toEqual([
      "construction",
      "construction:one",
      "llm-call:topic",
      "topic-extractor",
      "dispatching",
      JSON.stringify(dispatching),
    ]);
    const update = client.calls.find(({ text }) => text.includes("UPDATE llm_calls"));
    expect(update?.text).toContain("status = 'dispatching'");
    expect(update?.values?.[3]).toBe(JSON.stringify(completed));
    const decisionInsert = client.calls.find(({ text }) =>
      text.includes("INSERT INTO llm_topic_decisions"),
    );
    expect(decisionInsert?.values?.slice(0, 6)).toEqual([
      "construction",
      "construction:one",
      "decision:topic",
      "llm-call:topic",
      "approved",
      "manifest:approved",
    ]);
    expect(client.calls.at(-1)?.text.trim()).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("reports an unknown commit and always releases the client", async () => {
    const client = new RecordingClient();
    client.failCommit = true;
    const store = new PostgresLlmCallStore(poolFor(client));
    await expect(store.transaction(async () => "result")).rejects.toMatchObject({
      outcome: "commit-unknown",
    } satisfies Partial<ProofStoreTransactionError>);
    expect(client.released).toBe(true);
  });
});
