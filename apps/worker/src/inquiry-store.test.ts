import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inquiryRecordSchema, type ProofNode } from "@proof/protocol";
import { DEVELOPMENT_PROOF_SESSION_ID, DEVELOPMENT_ROOT_NODE } from "./development-session";
import { MemoryProofStore } from "./memory-proof-store";
import { PostgresProofStore, type SqlClient, type SqlQueryResult } from "./postgres-proof-store";
import { initializeProofSession, type ProofSessionId } from "./proof-repository";

const sessionId = "session:one" as ProofSessionId;

const relationship = inquiryRecordSchema.parse({
  id: "relationship:one",
  sequence: 7,
  commandId: "inquiry:one",
  nodeId: "node:root",
  stateId: "state:root",
  actor: { id: "actor:web", kind: "human" },
  recordedAt: "2026-09-27T12:00:00.000Z",
  kind: "relationship",
  relation: "wouldSufficeFor",
  from: ["question:b", "question:a"],
  to: "question:main",
  support: { kind: "transition", childNodeId: "node:child" },
  reason: { provenance: "explicit-user", basisIds: ["observation:one"] },
});

type QueryCall = Readonly<{ text: string; values: readonly unknown[] | undefined }>;

class InquiryClient implements SqlClient {
  calls: QueryCall[] = [];
  released = false;
  rows: Readonly<Record<string, unknown>>[] = [];

  async query(text: string, values?: readonly unknown[]): Promise<SqlQueryResult> {
    this.calls.push({ text, values });
    if (text.includes("MAX(sequence)")) return { rows: [{ sequence: "6" }], rowCount: 1 };
    if (text.includes("FROM proof_inquiry_records")) {
      return { rows: this.rows, rowCount: this.rows.length };
    }
    return { rows: [], rowCount: 1 };
  }

  release(): void {
    this.released = true;
  }
}

describe("PostgresProofStore inquiry records", () => {
  it("inserts relational identities and reference arrays beside the JSONB record", async () => {
    const client = new InquiryClient();
    const store = new PostgresProofStore({ connect: async () => client });
    const last = await store.transaction(async (transaction) => {
      const sequence = await transaction.lastInquirySequence(sessionId);
      await transaction.insertInquiryRecord(sessionId, relationship);
      return sequence;
    });
    expect(last).toBe(6);
    const insert = client.calls.find(({ text }) => text.includes("INSERT INTO"));
    expect(insert?.text).toContain("proof_inquiry_records");
    expect(insert?.values).toEqual([
      "session:one",
      "relationship:one",
      7,
      "inquiry:one",
      "relationship",
      "node:root",
      "state:root",
      "actor:web",
      "human",
      "2026-09-27T12:00:00.000Z",
      ["node:child", "node:root"],
      ["observation:one", "question:a", "question:b", "question:main"],
      JSON.stringify(relationship),
    ]);
    expect(insert?.text).not.toContain("relationship:one");
    expect(client.released).toBe(true);
  });

  it("reads and lists records in the repository shape with parameterized filters", async () => {
    const client = new InquiryClient();
    client.rows = [
      {
        session_id: "session:one",
        id: "relationship:one",
        sequence: "7",
        command_id: "inquiry:one",
        node_id: "node:root",
        record: relationship,
      },
    ];
    const store = new PostgresProofStore({ connect: async () => client });
    const [read, listed] = await store.transaction(async (transaction) => [
      await transaction.readInquiryRecord(sessionId, relationship.id),
      await transaction.listInquiryRecords(sessionId, {
        nodeId: "node:root" as ProofNode["id"],
        referencing: "question:main",
        afterSequence: 2,
        limit: 10,
      }),
    ]);
    const expected = {
      sessionId: "session:one",
      recordId: "relationship:one",
      sequence: 7,
      commandId: "inquiry:one",
      nodeId: "node:root",
      record: relationship,
    };
    expect(read).toEqual(expected);
    expect(listed).toEqual([expected]);
    const list = client.calls.find(({ text }) => text.includes("ORDER BY sequence"));
    expect(list?.text).toContain("$5 = ANY (referenced_record_ids)");
    expect(list?.values).toEqual(["session:one", 2, "node:root", null, "question:main", 10]);
  });
});

describe("MemoryProofStore inquiry-record constraints", () => {
  async function store(): Promise<MemoryProofStore> {
    const memory = new MemoryProofStore();
    expect(
      await initializeProofSession(memory, {
        sessionId: DEVELOPMENT_PROOF_SESSION_ID,
        rootNode: DEVELOPMENT_ROOT_NODE,
      }),
    ).toMatchObject({ status: "committed" });
    return memory;
  }
  const record = inquiryRecordSchema.parse({
    id: "observation:one",
    sequence: 1,
    commandId: "inquiry:one",
    nodeId: DEVELOPMENT_ROOT_NODE.id,
    stateId: DEVELOPMENT_ROOT_NODE.state.id,
    actor: { id: "actor:web", kind: "human" },
    recordedAt: "2026-09-27T12:00:00.000Z",
    kind: "observation",
    note: "Noted.",
  });
  const session = DEVELOPMENT_PROOF_SESSION_ID as ProofSessionId;

  it("enforces the primary key, unique sequence and anchor snapshot like PostgreSQL", async () => {
    const memory = await store();
    await memory.transaction(async (transaction) => {
      await transaction.insertInquiryRecord(session, record);
    });
    for (const conflicting of [
      record,
      { ...record, id: "observation:two" },
      { ...record, id: "observation:two", sequence: 2, stateId: "state:other" },
      { ...record, id: "observation:two", sequence: 2, nodeId: "node:missing" },
      { ...record, id: "observation:two", sequence: 2, kind: "unknown" },
    ]) {
      await expect(
        memory.transaction(async (transaction) => {
          await transaction.insertInquiryRecord(session, conflicting as typeof record);
        }),
      ).rejects.toMatchObject({ outcome: "rolled-back" });
    }
    const listed = await memory.transaction(async (transaction) => ({
      last: await transaction.lastInquirySequence(session),
      rows: await transaction.listInquiryRecords(session, { afterSequence: 0, limit: 10 }),
    }));
    expect(listed.last).toBe(1);
    expect(listed.rows).toEqual([
      {
        sessionId: session,
        recordId: record.id,
        sequence: 1,
        commandId: "inquiry:one",
        nodeId: record.nodeId,
        record,
      },
    ]);
  });
});

describe("inquiry-record migration", () => {
  const sql = readFileSync(
    new URL("../migrations/0009_inquiry_records.sql", import.meta.url),
    "utf8",
  )
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  it("keys records by ID, orders them per session, and anchors them to a node snapshot", () => {
    expect(sql).toContain("create table proof_inquiry_records (");
    expect(sql).toContain("primary key (session_id, id)");
    expect(sql).toContain("unique (session_id, sequence)");
    expect(sql).toContain(
      "foreign key (session_id, node_id, state_id) references proof_nodes (session_id, id, state_id)",
    );
    for (const [path, column] of [
      ["->> 'id'", "id"],
      ["->> 'commandid'", "command_id"],
      ["->> 'kind'", "kind"],
      ["->> 'nodeid'", "node_id"],
      ["->> 'stateid'", "state_id"],
      ["#>> '{actor,kind}'", "actor_kind"],
    ]) {
      expect(sql).toContain(`check ((record ${path}) is not distinct from ${column})`);
    }
    expect(sql).toContain("check (node_id = any (referenced_node_ids))");
  });

  it("runs atomically without rewriting existing data", () => {
    expect(sql.startsWith("begin;")).toBe(true);
    expect(sql.endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/\b(?:insert into|update \w+ set|delete from|alter table)\b/);
  });
});
