import { describe, expect, it } from "vitest";
import { buildTopicExtractorContext, prepareLlmCall, type PreparedLlmCall } from "@proof/llm";
import { runDurableLlmCall, type LlmCallOwner, type StoredLlmCall } from "./llm-call-repository";
import { MemoryLlmCallStore } from "./memory-llm-call-store";

const dispatch = { provider: "test", model: "test-model", promptVersion: "test-v1" } as const;
const proposal = {
  kind: "topic-manifest",
  domains: [],
  objectKinds: [],
  vocabulary: [],
  notation: [],
  backgroundTopics: [],
  customOperators: [],
} as const;

function call(id: string): PreparedLlmCall {
  const built = buildTopicExtractorContext({
    id,
    problem: "Show that p implies p.",
    background: { level: "basic", summary: "Basic logic.", assumptions: [] },
  });
  if (!built.ok) throw new Error(built.diagnostics[0].message);
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
  return prepared.call;
}

describe("MemoryLlmCallStore", () => {
  it("isolates owners and call IDs that contain slash separators", async () => {
    const store = new MemoryLlmCallStore();
    const firstOwner = { kind: "construction", id: "owner/a" } as const satisfies LlmCallOwner;
    const secondOwner = { kind: "construction", id: "owner" } as const satisfies LlmCallOwner;
    const firstCall = call("b/c");
    const secondCall = call("a/b/c");
    await runDurableLlmCall(
      store,
      { owner: firstOwner, call: firstCall, dispatch },
      async () => proposal,
    );
    await runDurableLlmCall(
      store,
      { owner: secondOwner, call: secondCall, dispatch },
      async () => proposal,
    );

    expect(await store.listCallsForOwner(firstOwner)).toHaveLength(1);
    expect(await store.listCallsForOwner(secondOwner)).toHaveLength(1);
    expect((await store.listCallsForOwner(firstOwner))[0]).toMatchObject({ id: "b/c" });
    expect((await store.listCallsForOwner(secondOwner))[0]).toMatchObject({ id: "a/b/c" });
  });

  it("rolls back staged transaction writes when the callback fails", async () => {
    const store = new MemoryLlmCallStore();
    const owner = { kind: "construction", id: "owner" } as const satisfies LlmCallOwner;
    await expect(
      store.transaction(async (transaction) => {
        const prepared = call("llm-call:rollback");
        await transaction.insertCall({
          owner,
          id: prepared.id,
          role: prepared.role,
          preparedCall: prepared,
          dispatch,
          status: "dispatching",
        } satisfies StoredLlmCall);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await store.listCallsForOwner(owner)).toEqual([]);
  });
});
