import { describe, expect, it } from "vitest";
import { DEVELOPMENT_ROOT_NODE } from "./development-session";
import { libraryResult } from "./artifact.testing";
import { addLibraryArtifact, reviseBackground } from "./library-repository";
import { MemoryLibraryStore } from "./memory-library-store";
import { MemoryProofStore } from "./memory-proof-store";
import { PostgresProofStore, type SqlClient, type SqlQueryResult } from "./postgres-proof-store";
import {
  ProofStoreTransactionError,
  ReadOnlySessionError,
  backtrackProofSession,
  initializeProofSession,
  loadCurrentProofSession,
  proofSessionIdSchema,
  recordInteractionEvent,
  type ProofSessionId,
} from "./proof-repository";

/** N27: read-only (imported) sessions refuse every write at the transaction layer. */

const sessionId = proofSessionIdSchema.parse("session:read-only") as ProofSessionId;
const background = {
  level: "undergraduate",
  summary: "Logic.",
  assumptions: [],
  domains: ["logic"],
  maximumLevel: "undergraduate",
} as const;

async function readOnlyStore<Store extends MemoryProofStore>(store: Store): Promise<Store> {
  expect(
    await initializeProofSession(store, {
      sessionId,
      rootNode: DEVELOPMENT_ROOT_NODE,
      metadata: {
        problem: { title: "Read only", statement: "Nothing changes." },
        background,
        libraryLayerIds: [],
      },
    }),
  ).toMatchObject({ status: "committed" });
  await store.transaction(async (transaction) => {
    expect(await transaction.markSessionReadOnly(sessionId)).toBe(true);
  });
  return store;
}

const child = {
  ...DEVELOPMENT_ROOT_NODE,
  id: "node:read-only-child",
  state: { ...DEVELOPMENT_ROOT_NODE.state, id: "state:read-only-child" },
} as unknown as typeof DEVELOPMENT_ROOT_NODE;

describe("the read-only guard on the memory store", () => {
  it("reports the marker and rolls back any raw write with ReadOnlySessionError", async () => {
    const store = await readOnlyStore(new MemoryProofStore());
    const loaded = await loadCurrentProofSession(store, sessionId);
    expect(loaded).toMatchObject({ status: "loaded", session: { readOnly: true } });

    const writes: readonly ((
      transaction: Parameters<Parameters<MemoryProofStore["transaction"]>[0]>[0],
    ) => Promise<unknown>)[] = [
      (transaction) => transaction.insertNode(sessionId, child),
      (transaction) =>
        transaction.advanceCurrentNode(sessionId, DEVELOPMENT_ROOT_NODE.id, child.id),
      (transaction) =>
        transaction.repointCurrentNode(sessionId, DEVELOPMENT_ROOT_NODE.id, child.id),
      (transaction) =>
        transaction.deleteProofRecords(sessionId, {
          nodeIds: [],
          edgeIds: [],
          commandIds: [],
          chosenPreviewIds: [],
        }),
      (transaction) => transaction.markSessionReadOnly(sessionId),
    ];
    for (const write of writes) {
      const error = await store.transaction(write).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProofStoreTransactionError);
      expect((error as ProofStoreTransactionError).cause).toBeInstanceOf(ReadOnlySessionError);
    }
    expect(await loadCurrentProofSession(store, sessionId)).toEqual(loaded);
  });

  it("refuses writes after the marker within the same transaction, and marked sessions at insert", async () => {
    const store = new MemoryProofStore();
    const error = await store
      .transaction(async (transaction) => {
        await transaction.insertSession({
          id: sessionId,
          rootNodeId: DEVELOPMENT_ROOT_NODE.id,
          currentNodeId: DEVELOPMENT_ROOT_NODE.id,
          operators: [],
        });
        await transaction.insertNode(sessionId, DEVELOPMENT_ROOT_NODE);
        expect(await transaction.markSessionReadOnly(sessionId)).toBe(true);
        await transaction.insertNode(sessionId, child);
      })
      .catch((caught: unknown) => caught);
    expect((error as ProofStoreTransactionError).cause).toBeInstanceOf(ReadOnlySessionError);
    expect(await loadCurrentProofSession(store, sessionId)).toMatchObject({
      diagnostics: [{ code: "session-not-found" }],
    });

    const marked = await store
      .transaction((transaction) =>
        transaction.insertSession({
          id: sessionId,
          rootNodeId: DEVELOPMENT_ROOT_NODE.id,
          currentNodeId: DEVELOPMENT_ROOT_NODE.id,
          operators: [],
          readOnly: true,
        }),
      )
      .catch((caught: unknown) => caught);
    expect((marked as ProofStoreTransactionError).cause).toBeInstanceOf(ReadOnlySessionError);
  });

  it("surfaces repository writes as session-read-only", async () => {
    const store = await readOnlyStore(new MemoryProofStore());
    expect(
      await backtrackProofSession(store, sessionId, {
        expectedCurrentNodeId: DEVELOPMENT_ROOT_NODE.id,
        targetNodeId: DEVELOPMENT_ROOT_NODE.id,
      }),
    ).toMatchObject({ status: "committed", replayed: true });
    expect(
      await recordInteractionEvent(
        store,
        sessionId,
        {
          id: "interaction:read-only",
          nodeId: DEVELOPMENT_ROOT_NODE.id,
          kind: "suggestions-requested",
          suggestionSetId: "suggestion-set:read-only",
        },
        { id: "actor:web", kind: "human" },
      ),
    ).toEqual({
      status: "rejected",
      diagnostics: [
        {
          code: "session-read-only",
          message: `The proof session ${sessionId} is read-only; it was imported from an artifact.`,
        },
      ],
    });
  });

  it("reports an unknown session without marking anything", async () => {
    const store = new MemoryProofStore();
    expect(
      await store.transaction((transaction) => transaction.markSessionReadOnly(sessionId)),
    ).toBe(false);
  });
});

describe("the read-only guard on the library", () => {
  it("refuses additions and background revisions", async () => {
    const store = await readOnlyStore(new MemoryLibraryStore());
    const added = await addLibraryArtifact(store, {
      id: "addition:read-only",
      sessionId,
      occurredAt: "2026-09-29T00:00:00.000Z",
      layer: "proof-time-background",
      origin: { kind: "user", actorId: "user:reader" },
      artifact: libraryResult("result:read-only", { domains: ["logic"], level: "foundational" }),
    });
    expect(added).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "session-read-only" }],
    });
    const revised = await reviseBackground(store, sessionId, {
      id: "revision:read-only",
      occurredAt: "2026-09-29T00:00:00.000Z",
      previous: background,
      revised: { ...background, domains: ["logic", "algebra"] },
      reason: "No.",
      actor: { kind: "user", id: "user:reader" },
    });
    expect(revised).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "session-read-only" }],
    });
  });
});

/** A fake client whose session row is read-only. */
class ReadOnlyClient implements SqlClient {
  calls: string[] = [];

  async query(text: string): Promise<SqlQueryResult> {
    this.calls.push(text.trim().replace(/\s+/g, " "));
    if (text.includes("FROM proof_sessions")) {
      return {
        rows: [
          {
            id: sessionId,
            root_node_id: "node:development-root",
            current_node_id: "node:development-root",
            operators: [],
            metadata: null,
            read_only: true,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  }

  release(): void {}
}

describe("the read-only guard on the PostgreSQL store", () => {
  it("reads the marker with the session lock and issues no write", async () => {
    const client = new ReadOnlyClient();
    const store = new PostgresProofStore({ connect: async () => client });
    expect(await loadCurrentProofSession(store, sessionId)).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "current-node-not-found" }],
    });
    expect(client.calls[1]).toContain("read_only");

    client.calls = [];
    const error = await store
      .transaction((transaction) => transaction.insertNode(sessionId, child))
      .catch((caught: unknown) => caught);
    expect((error as ProofStoreTransactionError).cause).toBeInstanceOf(ReadOnlySessionError);
    expect(client.calls.some((call) => call.startsWith("INSERT"))).toBe(false);
    expect(client.calls.at(-1)).toBe("ROLLBACK");

    client.calls = [];
    await store
      .transaction(async (transaction) => {
        await transaction.lockSession(sessionId);
        await expect(transaction.markSessionReadOnly(sessionId)).rejects.toBeInstanceOf(
          ReadOnlySessionError,
        );
      })
      .catch(() => undefined);
    expect(client.calls.filter((call) => call.startsWith("UPDATE"))).toEqual([]);
  });

  it("marks a session read-only only while it is writable", async () => {
    const calls: { text: string; values: readonly unknown[] | undefined }[] = [];
    const store = new PostgresProofStore({
      connect: async () => ({
        async query(text: string, values?: readonly unknown[]) {
          calls.push({ text, values });
          return text.includes("FROM proof_sessions")
            ? { rows: [{ id: sessionId, read_only: false }], rowCount: 1 }
            : { rows: [], rowCount: 1 };
        },
        release() {},
      }),
    });
    expect(
      await store.transaction((transaction) => transaction.markSessionReadOnly(sessionId)),
    ).toBe(true);
    const update = calls.find(({ text }) => text.includes("UPDATE proof_sessions"));
    expect(update?.text).toContain("SET read_only = true");
    expect(update?.text).toContain("NOT read_only");
    expect(update?.values).toEqual([sessionId]);
  });

  it("lists export rows in ID order and stores import records with parameters only", async () => {
    const calls: { text: string; values: readonly unknown[] | undefined }[] = [];
    const store = new PostgresProofStore({
      connect: async () => ({
        async query(text: string, values?: readonly unknown[]) {
          calls.push({ text, values });
          if (text.includes("FROM proof_sessions")) {
            return { rows: [{ id: sessionId, read_only: false }], rowCount: 1 };
          }
          if (text.includes("FROM proof_nodes")) {
            return {
              rows: [{ session_id: sessionId, id: "node:a", state_id: "state:a", state: {} }],
              rowCount: 1,
            };
          }
          return { rows: [{ record: { id: "row" } }], rowCount: 1 };
        },
        release() {},
      }),
    });
    const record = {
      sessionId,
      digest: `sha256:${"d".repeat(64)}`,
      sourceSessionId: "session:source",
      importedAt: "2026-09-29T00:00:00.000Z",
      library: {},
      llmCalls: [],
    };
    const listed = await store.transaction(async (transaction) => {
      await transaction.insertArtifactImport(record);
      return {
        nodes: await transaction.listNodes(sessionId),
        commands: await transaction.listCommands(sessionId),
        imported: await transaction.readArtifactImport(sessionId),
      };
    });
    expect(listed).toEqual({
      nodes: [
        {
          sessionId,
          nodeId: "node:a",
          stateId: "state:a",
          node: { id: "node:a", state: {} },
        },
      ],
      commands: [{ id: "row" }],
      imported: { id: "row" },
    });
    const insert = calls.find(({ text }) => text.includes("INSERT INTO proof_artifact_imports"));
    expect(insert?.values).toEqual([
      sessionId,
      record.digest,
      "session:source",
      record.importedAt,
      JSON.stringify(record),
    ]);
    expect(insert?.text).not.toContain(sessionId);
    for (const table of ["proof_nodes", "proof_commands"]) {
      const select = calls.find(({ text }) => text.includes(`FROM ${table}`));
      expect(select?.text).toMatch(/ORDER BY (id|command_id)/);
      expect(select?.values).toEqual([sessionId]);
    }
  });
});
