import { afterEach, describe, expect, it } from "vitest";
import type { ProofArtifact } from "@proof/protocol";
import { importProofArtifact, importedSessionId } from "./artifact-import";
import { ARTIFACT_SESSION_ID, buildArtifactScenario, FIXED_NOW } from "./artifact.testing";
import { DEVELOPMENT_ROOT_NODE } from "./development-session";
import { MemoryLibraryStore } from "./memory-library-store";
import { MemoryProofStore } from "./memory-proof-store";
import {
  PostgresProofStore,
  SESSION_TABLES_IN_DELETION_ORDER,
  type SqlClient,
  type SqlPool,
  type SqlQueryResult,
} from "./postgres-proof-store";
import type { ProofHttpService } from "./proof-http";
import {
  initializeProofSession,
  loadCurrentProofSession,
  proofSessionIdSchema,
  type ProofSessionId,
} from "./proof-repository";
import { deleteProofSession, readSessionVisibility, setSessionVisibility } from "./session-admin";

/** N36: private-by-default sessions and hard deletion of a session's rows in both stores. */

const services: ProofHttpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const id = (value: string) => proofSessionIdSchema.parse(value) as ProofSessionId;

/** The number of rows any memory table, or library table, holds for a session. */
function remainingRows(store: MemoryLibraryStore, sessionId: string): Record<string, number> {
  const internals = store as unknown as {
    tables: Record<string, Map<string, unknown>>;
    library: Record<string, Map<string, { sessionId?: string | null }>>;
  };
  const counts: Record<string, number> = {};
  for (const [name, table] of Object.entries(internals.tables)) {
    counts[name] = [...table.keys()].filter(
      (key) => key === sessionId || key.startsWith(`${sessionId}\u0000`),
    ).length;
  }
  for (const [name, table] of Object.entries(internals.library)) {
    if (name === "sessionMetadata" || name === "operators") continue;
    counts[`library.${name}`] = [...table.values()].filter(
      (row) => row.sessionId === sessionId,
    ).length;
  }
  return counts;
}

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

describe("session privacy", () => {
  async function fresh(store: MemoryProofStore, session: ProofSessionId) {
    expect(
      await initializeProofSession(store, { sessionId: session, rootNode: DEVELOPMENT_ROOT_NODE }),
    ).toMatchObject({ status: "committed" });
  }

  it("defaults a new session to private and reports it without exposing a flag", async () => {
    const store = new MemoryProofStore();
    await fresh(store, id("session:private-default"));

    expect(await readSessionVisibility(store, "session:private-default")).toEqual({
      status: "read",
      sessionId: "session:private-default",
      visibility: "private",
    });
    const loaded = await loadCurrentProofSession(store, id("session:private-default"));
    expect(loaded).toMatchObject({ status: "loaded" });
    expect(loaded.status === "loaded" && "visibility" in loaded.session).toBe(false);
  });

  it("changes visibility in both directions and reports a missing session", async () => {
    const store = new MemoryProofStore();
    await fresh(store, id("session:visibility"));

    expect(await setSessionVisibility(store, "session:visibility", "shared")).toMatchObject({
      status: "read",
      visibility: "shared",
    });
    expect(await readSessionVisibility(store, "session:visibility")).toMatchObject({
      visibility: "shared",
    });
    expect(await setSessionVisibility(store, "session:visibility", "private")).toMatchObject({
      visibility: "private",
    });
    expect(await readSessionVisibility(store, "session:visibility")).toMatchObject({
      visibility: "private",
    });
    expect(await setSessionVisibility(store, "session:absent", "shared")).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "session-not-found" }],
    });
    expect(await readSessionVisibility(store, "not a session id")).toMatchObject({
      status: "rejected",
    });
  });

  it("makes imported sessions private too, and lets a read-only session change visibility", async () => {
    const scenario = await buildArtifactScenario(services);
    const artifact = await scenario.exportArtifact();
    const store = new MemoryLibraryStore();
    const imported = await importProofArtifact(store, artifact, { now: FIXED_NOW });
    if (imported.status !== "imported") throw new Error(JSON.stringify(imported));

    expect(await readSessionVisibility(store, imported.sessionId)).toMatchObject({
      visibility: "private",
    });
    expect(await setSessionVisibility(store, imported.sessionId, "shared")).toMatchObject({
      visibility: "shared",
    });
  });
});

describe("session deletion in the memory store", () => {
  let artifact: ProofArtifact;
  let source: MemoryLibraryStore;

  async function scenarioStore(): Promise<void> {
    const scenario = await buildArtifactScenario(services);
    artifact = await scenario.exportArtifact();
    source = scenario.store;
  }

  it("removes every row of a rich session, and only that session, then answers not found", async () => {
    await scenarioStore();
    const other = importedSessionId(artifact.digest);
    const imported = await importProofArtifact(source, artifact, { now: FIXED_NOW });
    expect(imported).toMatchObject({ status: "imported", sessionId: other });

    const before = remainingRows(source, ARTIFACT_SESSION_ID);
    // The scenario holds rows in every proof table and in the session library layers.
    for (const name of [
      "sessions",
      "nodes",
      "suggestionSets",
      "previews",
      "edges",
      "events",
      "commands",
      "deletions",
      "interactionEvents",
      "replaySteps",
      "inquiryRecords",
      "library.events",
      "library.artifacts",
    ]) {
      expect(before[name], name).toBeGreaterThan(0);
    }
    const importedBefore = remainingRows(source, other);

    expect(await deleteProofSession(source, ARTIFACT_SESSION_ID)).toEqual({
      status: "deleted",
      sessionId: ARTIFACT_SESSION_ID,
    });
    expect(remainingRows(source, ARTIFACT_SESSION_ID)).toEqual(
      Object.fromEntries(Object.keys(before).map((name) => [name, 0])),
    );
    expect(remainingRows(source, other)).toEqual(importedBefore);
    expect(await loadCurrentProofSession(source, id(ARTIFACT_SESSION_ID))).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "session-not-found" }],
    });

    expect(await deleteProofSession(source, ARTIFACT_SESSION_ID)).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "session-not-found" }],
    });
  });

  it("deletes an imported read-only session with its artifact-import record", async () => {
    await scenarioStore();
    const store = new MemoryLibraryStore();
    const imported = await importProofArtifact(store, artifact, { now: FIXED_NOW });
    if (imported.status !== "imported") throw new Error(JSON.stringify(imported));
    const loaded = await loadCurrentProofSession(store, id(imported.sessionId));
    expect(loaded).toMatchObject({ session: { readOnly: true } });
    expect(remainingRows(store, imported.sessionId).artifactImports).toBe(1);

    expect(await deleteProofSession(store, imported.sessionId)).toMatchObject({
      status: "deleted",
    });
    expect(total(remainingRows(store, imported.sessionId))).toBe(0);

    // Nothing of the import survives, so the same artifact imports again as a new session.
    expect(await importProofArtifact(store, artifact, { now: FIXED_NOW })).toMatchObject({
      status: "imported",
      replayed: false,
    });
    expect(await deleteProofSession(store, "not a session id")).toMatchObject({
      status: "rejected",
    });
  });

  it("is atomic: a failing transaction leaves the session intact", async () => {
    await scenarioStore();
    const before = remainingRows(source, ARTIFACT_SESSION_ID);
    await expect(
      source.transaction(async (transaction) => {
        await transaction.deleteSession(id(ARTIFACT_SESSION_ID));
        throw new Error("abort");
      }),
    ).rejects.toThrow();
    expect(remainingRows(source, ARTIFACT_SESSION_ID)).toEqual(before);
  });
});

/**
 * A fake PostgreSQL connection over per-table row lists: it understands only the deletion
 * statements, enforces `FOR UPDATE`, and restores its snapshot on ROLLBACK.
 */
class FakeSessionDatabase {
  tables = new Map<string, { session_id?: string; owner_id?: string }[]>();
  statements: string[] = [];
  releases: (Error | boolean | undefined)[] = [];
  failOn: string | undefined;
  private snapshot: FakeSessionDatabase["tables"] | undefined;

  constructor(sessionIds: readonly string[]) {
    const names = [...SESSION_TABLES_IN_DELETION_ORDER, "proof_sessions"];
    for (const name of names) {
      this.tables.set(
        name,
        sessionIds.flatMap((sessionId) =>
          name === "proof_sessions"
            ? [{ session_id: sessionId }]
            : [{ session_id: sessionId }, { session_id: sessionId }],
        ),
      );
    }
    for (const name of ["llm_calls", "llm_topic_decisions"]) {
      this.tables.set(
        name,
        sessionIds.map((sessionId) => ({ owner_id: sessionId })),
      );
    }
  }

  count(table: string, sessionId: string): number {
    return (this.tables.get(table) ?? []).filter(
      (row) => row.session_id === sessionId || row.owner_id === sessionId,
    ).length;
  }

  pool(): SqlPool {
    const client: SqlClient = {
      query: async (text, values) => this.query(text, values),
      release: (error) => {
        this.releases.push(error);
      },
    };
    return { connect: async () => client };
  }

  private async query(text: string, values?: readonly unknown[]): Promise<SqlQueryResult> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    const result = (rowCount: number): SqlQueryResult => ({
      rows: Array.from({ length: rowCount }, () => ({ id: "x" })),
      rowCount,
    });
    if (sql === "BEGIN") {
      this.snapshot = new Map([...this.tables].map(([name, rows]) => [name, [...rows]]));
      return result(0);
    }
    if (sql === "COMMIT") return result(0);
    if (sql === "ROLLBACK") {
      if (this.snapshot !== undefined) this.tables = this.snapshot;
      return result(0);
    }
    if (this.failOn !== undefined && sql.includes(this.failOn)) throw new Error("forced failure");
    const sessionId = values?.[0] as string;
    if (sql.startsWith("SELECT id FROM proof_sessions") && sql.endsWith("FOR UPDATE")) {
      return result(this.count("proof_sessions", sessionId) > 0 ? 1 : 0);
    }
    const scoped = /^DELETE FROM (\w+) WHERE (session_id|id) = \$1$/.exec(sql);
    if (scoped !== null) {
      return this.remove(scoped[1] as string, (row) => row.session_id === sessionId, result);
    }
    const owned = /^DELETE FROM (\w+) WHERE owner_kind = 'proof-session' AND owner_id = \$1$/.exec(
      sql,
    );
    if (owned !== null) {
      return this.remove(owned[1] as string, (row) => row.owner_id === sessionId, result);
    }
    throw new Error(`Unexpected statement: ${sql}`);
  }

  private remove(
    table: string,
    matches: (row: { session_id?: string; owner_id?: string }) => boolean,
    result: (rowCount: number) => SqlQueryResult,
  ): SqlQueryResult {
    const rows = this.tables.get(table) ?? [];
    const kept = rows.filter((row) => !matches(row));
    this.tables.set(table, kept);
    return result(rows.length - kept.length);
  }
}

describe("session deletion in the PostgreSQL adapter (fake SQL)", () => {
  it("deletes every session table in dependency order and leaves other sessions alone", async () => {
    const database = new FakeSessionDatabase(["session:doomed", "session:kept"]);
    const store = new PostgresProofStore(database.pool());

    expect(await deleteProofSession(store, "session:doomed")).toMatchObject({ status: "deleted" });

    for (const table of database.tables.keys()) {
      expect(database.count(table, "session:doomed"), table).toBe(0);
      expect(database.count(table, "session:kept"), table).toBeGreaterThan(0);
    }
    const deletes = database.statements
      .filter((statement) => statement.startsWith("DELETE FROM"))
      .map((statement) => /^DELETE FROM (\w+)/.exec(statement)?.[1]);
    expect(deletes).toEqual([
      ...SESSION_TABLES_IN_DELETION_ORDER,
      "llm_topic_decisions",
      "llm_calls",
      "proof_sessions",
    ]);
    expect(database.statements[0]).toBe("BEGIN");
    expect(database.statements.at(-1)).toBe("COMMIT");
    expect(database.releases).toEqual([undefined]);
  });

  it("answers not found without deleting anything, and repeats as not found", async () => {
    const database = new FakeSessionDatabase(["session:doomed"]);
    const store = new PostgresProofStore(database.pool());
    expect(await deleteProofSession(store, "session:absent")).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "session-not-found" }],
    });
    expect(database.statements.some((statement) => statement.startsWith("DELETE"))).toBe(false);

    await deleteProofSession(store, "session:doomed");
    expect(await deleteProofSession(store, "session:doomed")).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "session-not-found" }],
    });
  });

  it("rolls everything back when one table fails", async () => {
    const database = new FakeSessionDatabase(["session:doomed"]);
    database.failOn = "DELETE FROM proof_nodes";
    const store = new PostgresProofStore(database.pool());

    expect(await deleteProofSession(store, "session:doomed")).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "storage-failure" }],
    });
    for (const table of database.tables.keys()) {
      expect(database.count(table, "session:doomed"), table).toBeGreaterThan(0);
    }
    expect(database.statements.at(-1)).toBe("ROLLBACK");
  });

  it("sets and reads visibility through parameterized SQL", async () => {
    const calls: { text: string; values: readonly unknown[] | undefined }[] = [];
    const client: SqlClient = {
      query: async (text, values) => {
        calls.push({ text, values });
        return {
          rows: text.includes("SELECT")
            ? [
                {
                  id: "session:doomed",
                  root_node_id: "node:root",
                  current_node_id: "node:root",
                  operators: [],
                  metadata: null,
                  read_only: false,
                  visibility: "shared",
                },
              ]
            : [],
          rowCount: 1,
        };
      },
      release: () => undefined,
    };
    const store = new PostgresProofStore({ connect: async () => client });

    expect(await setSessionVisibility(store, "session:doomed", "shared")).toMatchObject({
      visibility: "shared",
    });
    expect(
      calls.some(
        ({ text, values }) => /SET visibility = \$2/.test(text) && values?.[1] === "shared",
      ),
    ).toBe(true);
    expect(await readSessionVisibility(store, "session:doomed")).toMatchObject({
      visibility: "shared",
    });
  });
});
