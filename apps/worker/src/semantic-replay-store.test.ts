import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProofNodeSchema, type SemanticReplayStepRecord } from "@proof/protocol";
import { MemoryProofStore } from "./memory-proof-store";
import { PostgresProofStore, type SqlClient, type SqlQueryResult } from "./postgres-proof-store";
import { initializeProofSession, type ProofSessionId } from "./proof-repository";

const migration = readFileSync(
  new URL("../migrations/0010_semantic_replay_steps.sql", import.meta.url),
  "utf8",
);

function normalizedSql(sql: string): string {
  return sql.replace(/--.*$/gm, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

describe("semantic replay migration", () => {
  const sql = normalizedSql(migration);

  it("keys replayed steps by command and orders them per replay command", () => {
    expect(sql).toContain("create table proof_replay_steps (");
    expect(sql).toContain("primary key (session_id, command_id)");
    expect(sql).toContain("unique (session_id, replay_command_id, step_index)");
    expect(sql).toContain(
      "check (command_id = replay_command_id || ':replay:' || step_index::text)",
    );
  });

  it("references the step's command and node and mirrors JSONB identities", () => {
    expect(sql).toContain(
      "foreign key (session_id, command_id) references proof_commands (session_id, command_id)",
    );
    expect(sql).toContain(
      "foreign key (session_id, node_id) references proof_nodes (session_id, id)",
    );
    for (const [path, column] of [
      ["->> 'commandid'", "command_id"],
      ["->> 'replaycommandid'", "replay_command_id"],
      ["->> 'nodeid'", "node_id"],
      ["->> 'sourceedgeid'", "source_edge_id"],
    ]) {
      expect(sql).toContain(`check ((record ${path}) is not distinct from ${column})`);
    }
    expect(sql).toContain("check ((record -> 'index') is not distinct from to_jsonb(step_index))");
  });

  it("runs atomically without rewriting existing data", () => {
    expect(sql.startsWith("begin;")).toBe(true);
    expect(sql.endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/\b(?:insert into|update \w+ set|delete from|alter table)\b/);
  });
});

type QueryCall = Readonly<{ text: string; values: readonly unknown[] | undefined }>;

class ReplayClient implements SqlClient {
  calls: QueryCall[] = [];
  record: unknown = undefined;

  async query(text: string, values?: readonly unknown[]): Promise<SqlQueryResult> {
    this.calls.push({ text, values });
    if (text.includes("FROM proof_replay_steps") && this.record !== undefined) {
      return { rows: [{ record: this.record }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

describe("PostgresProofStore replayed steps", () => {
  const sessionId = "session:one" as ProofSessionId;
  const record = {
    commandId: "command:replay:replay:2",
    replayCommandId: "command:replay",
    index: 2,
    count: 3,
    nodeId: "node:command:replay:replay:2",
    sourceEdgeId: "edge:source",
    recordedAt: "2026-09-27T12:00:00.000Z",
  } as unknown as SemanticReplayStepRecord;

  it("inserts the relational identities beside the JSONB record, all as parameters", async () => {
    const client = new ReplayClient();
    const store = new PostgresProofStore({ connect: async () => client });
    await store.transaction(async (transaction) => transaction.insertReplayStep(sessionId, record));
    const insert = client.calls.find(({ text }) => text.includes("INSERT INTO proof_replay_steps"));
    expect(insert?.values).toEqual([
      "session:one",
      "command:replay:replay:2",
      "command:replay",
      2,
      3,
      "node:command:replay:replay:2",
      "edge:source",
      "2026-09-27T12:00:00.000Z",
      JSON.stringify(record),
    ]);
    expect(insert?.text).not.toContain("command:replay");
  });

  it("reads one replayed step by its command ID", async () => {
    const client = new ReplayClient();
    client.record = { commandId: "command:replay:replay:2" };
    const store = new PostgresProofStore({ connect: async () => client });
    const read = await store.transaction(async (transaction) =>
      transaction.readReplayStep(sessionId, "command:replay:replay:2" as never),
    );
    expect(read).toEqual({ commandId: "command:replay:replay:2" });
    const select = client.calls.find(({ text }) => text.includes("FROM proof_replay_steps"));
    expect(select?.values).toEqual(["session:one", "command:replay:replay:2"]);
    client.record = undefined;
    expect(
      await store.transaction(async (transaction) =>
        transaction.readReplayStep(sessionId, "command:missing" as never),
      ),
    ).toBeUndefined();
  });
});

describe("MemoryProofStore replayed steps", () => {
  it("requires the step's command and consistent step identities", async () => {
    const store = new MemoryProofStore();
    const root = createProofNodeSchema().parse({
      id: "node:root",
      state: { id: "state:root", goals: [], obligations: [] },
    });
    expect(
      await initializeProofSession(store, { sessionId: "session:one", rootNode: root }),
    ).toMatchObject({ status: "committed" });
    const record = {
      commandId: "command:replay:replay:1",
      replayCommandId: "command:replay",
      index: 1,
      count: 1,
      nodeId: "node:root",
      sourceEdgeId: "edge:source",
    } as unknown as SemanticReplayStepRecord;
    await expect(
      store.transaction(async (transaction) =>
        transaction.insertReplayStep("session:one" as ProofSessionId, record),
      ),
    ).rejects.toMatchObject({
      cause: { message: expect.stringContaining("command foreign key") },
    });
    await expect(
      store.transaction(async (transaction) =>
        transaction.insertReplayStep(
          "session:one" as ProofSessionId,
          {
            ...record,
            commandId: "command:other",
          } as SemanticReplayStepRecord,
        ),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining("check") } });
  });
});
