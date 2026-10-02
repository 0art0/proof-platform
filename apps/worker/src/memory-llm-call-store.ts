import type {
  LlmCallOwner,
  LlmCallStore,
  LlmCallStoreTransaction,
  StoredLlmCall,
  TopicProposalDecision,
} from "./llm-call-repository";
import type { LlmCallId } from "@proof/llm";

/** In-process owner-scoped LLM evidence store for local development and tests. */
export class MemoryLlmCallStore implements LlmCallStore {
  private calls = new Map<string, StoredLlmCall>();
  private decisions = new Map<string, TopicProposalDecision>();
  private queue: Promise<void> = Promise.resolve();

  async transaction<Result>(
    work: (transaction: LlmCallStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    let release = (): void => undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const calls = new Map(this.calls);
      const decisions = new Map(this.decisions);
      const result = await work({
        readCallForUpdate: async (owner, callId) => clone(calls.get(callKey(owner, callId))),
        insertCall: async (record) => {
          calls.set(callKey(record.owner, record.id), clone(record));
        },
        completeCall: async (record) => {
          if (record.status !== "completed") return false;
          const key = callKey(record.owner, record.id);
          if (calls.get(key)?.status !== "dispatching") return false;
          calls.set(key, clone(record));
          return true;
        },
        readDecisionForUpdate: async (owner, id) => clone(decisions.get(decisionKey(owner, id))),
        insertDecision: async (decision) => {
          decisions.set(decisionKey(decision.owner, decision.id), clone(decision));
        },
      });
      this.calls = calls;
      this.decisions = decisions;
      return result;
    } finally {
      release();
    }
  }

  async listCallsForOwner(owner: LlmCallOwner): Promise<readonly unknown[]> {
    await this.queue;
    return Object.freeze(
      [...this.calls.entries()]
        .filter(([, record]) => record.owner.kind === owner.kind && record.owner.id === owner.id)
        .map(([, record]) => clone(record)),
    );
  }
}

function callKey(owner: LlmCallOwner, id: LlmCallId): string {
  return JSON.stringify([owner.kind, owner.id, id]);
}

function decisionKey(owner: LlmCallOwner, id: string): string {
  return JSON.stringify([owner.kind, owner.id, id]);
}

function clone<Value>(value: Value): Value {
  return value === undefined ? value : (structuredClone(value) as Value);
}
