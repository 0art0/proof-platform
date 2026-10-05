import { describe, expect, it } from "vitest";
import {
  DEVELOPMENT_PROOF_SESSION_ID,
  DEVELOPMENT_ROOT_NODE,
  ensureDevelopmentProofSession,
} from "./development-session";
import { MemoryProofStore, MemoryProofStoreConstraintError } from "./memory-proof-store";
import {
  proofSessionIdSchema,
  proofSessionSchema,
  ProofStoreTransactionError,
  type ProofSession,
} from "./proof-repository";
import type { PrepareProofCommandSuccess, ProofEdge } from "@proof/protocol";
import { selectProofStore } from "./proof-worker-startup";

function session(id = "session:memory"): ProofSession {
  return proofSessionSchema.parse({
    id,
    rootNodeId: DEVELOPMENT_ROOT_NODE.id,
    currentNodeId: DEVELOPMENT_ROOT_NODE.id,
    operators: [],
  });
}

async function seeded(id = "session:memory"): Promise<MemoryProofStore> {
  const store = new MemoryProofStore();
  await store.transaction(async (transaction) => {
    await transaction.insertSession(session(id));
    await transaction.insertNode(session(id).id, DEVELOPMENT_ROOT_NODE);
  });
  return store;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const sessionId = proofSessionIdSchema.parse("session:memory");

describe("MemoryProofStore transactions", () => {
  it("rolls back every write when the callback throws", async () => {
    const store = new MemoryProofStore();
    const failure = new Error("work failed");

    const error = await store
      .transaction(async (transaction) => {
        await transaction.insertSession(session());
        await transaction.insertNode(sessionId, DEVELOPMENT_ROOT_NODE);
        expect(await transaction.lockSession(sessionId)).toMatchObject({ id: sessionId });
        throw failure;
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProofStoreTransactionError);
    expect(error).toMatchObject({ outcome: "rolled-back", cause: failure });
    await store.transaction(async (transaction) => {
      expect(await transaction.lockSession(sessionId)).toBeUndefined();
      expect(await transaction.readNode(sessionId, DEVELOPMENT_ROOT_NODE.id)).toBeUndefined();
    });
  });

  it("rolls back a failed pointer update on an existing session", async () => {
    const store = await seeded();
    await expect(
      store.transaction(async (transaction) => {
        await transaction.lockSession(sessionId);
        const child = { ...DEVELOPMENT_ROOT_NODE, id: "node:memory-child" } as const;
        await transaction.insertNode(sessionId, {
          ...child,
          state: { ...child.state, id: "state:memory-child" },
        } as typeof DEVELOPMENT_ROOT_NODE);
        expect(
          await transaction.advanceCurrentNode(
            sessionId,
            DEVELOPMENT_ROOT_NODE.id,
            child.id as typeof DEVELOPMENT_ROOT_NODE.id,
          ),
        ).toBe(true);
        throw new Error("late failure");
      }),
    ).rejects.toMatchObject({ outcome: "rolled-back" });

    await store.transaction(async (transaction) => {
      expect(await transaction.lockSession(sessionId)).toMatchObject({
        currentNodeId: DEVELOPMENT_ROOT_NODE.id,
      });
      expect(
        await transaction.readNode(
          sessionId,
          "node:memory-child" as typeof DEVELOPMENT_ROOT_NODE.id,
        ),
      ).toBeUndefined();
    });
  });

  it("enforces primary keys and deferred root-node foreign keys", async () => {
    const store = await seeded();
    const duplicate = await store
      .transaction(async (transaction) => transaction.insertSession(session()))
      .catch((caught: unknown) => caught);
    expect(duplicate).toMatchObject({ outcome: "rolled-back" });
    expect((duplicate as ProofStoreTransactionError).cause).toBeInstanceOf(
      MemoryProofStoreConstraintError,
    );

    const orphan = await store
      .transaction(async (transaction) => transaction.insertSession(session("session:orphan")))
      .catch((caught: unknown) => caught);
    expect((orphan as ProofStoreTransactionError).cause).toBeInstanceOf(
      MemoryProofStoreConstraintError,
    );
    await store.transaction(async (transaction) => {
      expect(
        await transaction.lockSession(proofSessionIdSchema.parse("session:orphan")),
      ).toBeUndefined();
    });
  });

  it("mirrors the evidence and transition-sequence constraints of migration 0014", async () => {
    const store = await seeded();
    type Work = Parameters<MemoryProofStore["transaction"]>[0];
    type Transaction = Parameters<Work>[0];
    /** Insert a child node, a stub command and an edge with the given stored fields. */
    const addEdge = async (
      transaction: Transaction,
      id: string,
      stored: Record<string, unknown>,
    ) => {
      const child = `node:${id}`;
      await transaction.insertNode(sessionId, {
        id: child,
        state: { ...DEVELOPMENT_ROOT_NODE.state, id: `state:${id}` },
      } as typeof DEVELOPMENT_ROOT_NODE);
      await transaction.insertCommand(sessionId, {
        prepared: { command: { commandId: `command:${id}` } },
      } as unknown as PrepareProofCommandSuccess);
      await transaction.insertEdge(sessionId, {
        id: `edge:${id}`,
        commandId: `command:${id}`,
        parentNodeId: DEVELOPMENT_ROOT_NODE.id,
        childNodeId: child,
        ...stored,
      } as unknown as ProofEdge);
    };
    const rejection = async (work: Work): Promise<string> => {
      const caught: unknown = await store.transaction(work).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ProofStoreTransactionError);
      return String((caught as { cause?: { message?: string } }).cause?.message);
    };
    const last = () =>
      store.transaction((transaction) => transaction.lastTransitionSequence(sessionId));

    expect(await last()).toBe(0);
    // Both columns or neither, and a positive sequence.
    expect(await rejection((t) => addEdge(t, "a", { evidence: "structural" }))).toContain(
      "evidence_sequence_together",
    );
    expect(await rejection((t) => addEdge(t, "a", { sequence: 1 }))).toContain(
      "evidence_sequence_together",
    );
    expect(
      await rejection((t) => addEdge(t, "a", { evidence: "structural", sequence: 0 })),
    ).toContain("must be positive");
    await store.transaction((t) => addEdge(t, "a", { evidence: "structural", sequence: 3 }));
    expect(await last()).toBe(3);
    // A sequence is unique within the session.
    expect(await rejection((t) => addEdge(t, "b", { evidence: "sorry", sequence: 3 }))).toContain(
      "unique transition sequence",
    );
    // Rows written before the migration carry neither and do not count towards the maximum.
    await store.transaction((t) => addEdge(t, "b", {}));
    expect(await last()).toBe(3);
  });

  it("round-trips optional session metadata and enforces the object check", async () => {
    const store = new MemoryProofStore();
    const metadata = {
      problem: { title: "Memory", statement: "A memory-store session." },
      background: { level: "basic", summary: "Basic.", assumptions: [] },
      libraryLayerIds: [],
    };
    const withMetadata = proofSessionSchema.parse({ ...session("session:meta"), metadata });
    await store.transaction(async (transaction) => {
      await transaction.insertSession(withMetadata);
      await transaction.insertNode(withMetadata.id, DEVELOPMENT_ROOT_NODE);
    });
    const loaded = await store.transaction(async (transaction) =>
      transaction.lockSession(withMetadata.id),
    );
    expect(loaded).toEqual(withMetadata);

    const legacy = await (
      await seeded()
    ).transaction(async (transaction) => transaction.lockSession(sessionId));
    expect(legacy).not.toHaveProperty("metadata");

    const invalid = await store
      .transaction(async (transaction) => {
        await transaction.insertSession({
          ...session("session:bad-meta"),
          metadata: [] as unknown as ProofSession["metadata"] & object,
        });
        await transaction.insertNode(
          proofSessionIdSchema.parse("session:bad-meta"),
          DEVELOPMENT_ROOT_NODE,
        );
      })
      .catch((caught: unknown) => caught);
    expect((invalid as ProofStoreTransactionError).cause).toBeInstanceOf(
      MemoryProofStoreConstraintError,
    );
  });

  it("returns detached JSON copies rather than stored references", async () => {
    const store = await seeded();
    const first = await store.transaction(async (transaction) =>
      transaction.readNode(sessionId, DEVELOPMENT_ROOT_NODE.id),
    );
    const second = await store.transaction(async (transaction) =>
      transaction.readNode(sessionId, DEVELOPMENT_ROOT_NODE.id),
    );
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect((first as { node: unknown }).node).not.toBe(DEVELOPMENT_ROOT_NODE);
  });

  it("serializes transactions that lock the same session", async () => {
    const store = await seeded();
    const order: string[] = [];
    const firstLocked = deferred();
    const releaseFirst = deferred();

    const first = store.transaction(async (transaction) => {
      await transaction.lockSession(sessionId);
      order.push("first locked");
      firstLocked.resolve();
      await releaseFirst.promise;
      const child = "node:serialized" as typeof DEVELOPMENT_ROOT_NODE.id;
      await transaction.insertNode(sessionId, {
        id: child,
        state: { ...DEVELOPMENT_ROOT_NODE.state, id: "state:serialized" },
      } as typeof DEVELOPMENT_ROOT_NODE);
      await transaction.advanceCurrentNode(sessionId, DEVELOPMENT_ROOT_NODE.id, child);
      order.push("first done");
    });
    await firstLocked.promise;
    const second = store.transaction(async (transaction) => {
      const locked = await transaction.lockSession(sessionId);
      order.push("second locked");
      return locked;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first locked"]);
    releaseFirst.resolve();
    await first;
    expect(await second).toMatchObject({ currentNodeId: "node:serialized" });
    expect(order).toEqual(["first locked", "first done", "second locked"]);
  });

  it("does not block transactions on different sessions", async () => {
    const store = await seeded();
    await store.transaction(async (transaction) => {
      await transaction.insertSession(session("session:other"));
      await transaction.insertNode(
        proofSessionIdSchema.parse("session:other"),
        DEVELOPMENT_ROOT_NODE,
      );
    });
    const release = deferred();
    const holding = store.transaction(async (transaction) => {
      await transaction.lockSession(sessionId);
      await release.promise;
    });

    const other = await store.transaction(async (transaction) =>
      transaction.lockSession(proofSessionIdSchema.parse("session:other")),
    );
    expect(other).toMatchObject({ id: "session:other" });
    release.resolve();
    await holding;
  });

  it("seeds the development session once under concurrent startup", async () => {
    const store = new MemoryProofStore();
    const results = await Promise.all([
      ensureDevelopmentProofSession(store),
      ensureDevelopmentProofSession(store),
    ]);
    expect(results.map((result) => result.status)).toEqual(["ready", "ready"]);
    expect(results.filter((result) => result.status === "ready" && result.created)).toHaveLength(1);
    expect(await ensureDevelopmentProofSession(store)).toMatchObject({
      status: "ready",
      created: false,
      session: { id: DEVELOPMENT_PROOF_SESSION_ID },
    });
  });
});

describe("selectProofStore", () => {
  it("selects memory only when requested explicitly", () => {
    expect(selectProofStore({ PROOF_STORE: "memory" })).toMatchObject({ ok: true, kind: "memory" });
    expect(
      selectProofStore({ PROOF_STORE: "memory", PROOF_DATABASE_URL: "postgres://unused" }),
    ).toMatchObject({ ok: true, kind: "memory" });
  });

  it("fails clearly without a database URL or with an unknown store", () => {
    expect(selectProofStore({})).toMatchObject({
      ok: false,
      message: expect.stringContaining("PROOF_STORE=memory"),
    });
    expect(selectProofStore({ PROOF_STORE: "postgres", DATABASE_URL: "" })).toMatchObject({
      ok: false,
    });
    expect(selectProofStore({ PROOF_STORE: "sqlite" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("Unsupported PROOF_STORE"),
    });
  });
});
