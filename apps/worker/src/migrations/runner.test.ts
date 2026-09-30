import { describe, expect, it } from "vitest";
import type { SqlClient, SqlPool, SqlQueryResult } from "../postgres-proof-store";
import {
  DEFAULT_MIGRATIONS_DIRECTORY,
  MigrationError,
  applyMigrations,
  baselineMigrations,
  createMigrations,
  loadMigrations,
  migrationChecksum,
  pendingMigrations,
  verifyMigrations,
  withoutTransactionEnvelope,
} from "./runner";

/**
 * A fake PostgreSQL connection that understands only the runner's own statements. Migration
 * bodies are recorded; a body containing `FAIL` throws. Writes made between BEGIN and COMMIT are
 * discarded by ROLLBACK, like a transaction.
 */
class FakeDatabase {
  readonly applied = new Map<string, string>();
  readonly executed: string[] = [];
  readonly log: string[] = [];
  tableCreated = false;
  locked = false;
  released: (Error | boolean | undefined)[] = [];
  private staged: [string, string][] | undefined;
  private stagedBodies: string[] = [];

  pool(): SqlPool {
    const client: SqlClient = {
      query: async (text, values) => this.query(text, values),
      release: (error) => {
        this.released.push(error);
      },
    };
    return { connect: async () => client };
  }

  private async query(text: string, values?: readonly unknown[]): Promise<SqlQueryResult> {
    const sql = text.trim();
    const done = (rows: SqlQueryResult["rows"] = []): SqlQueryResult => ({
      rows,
      rowCount: rows.length,
    });
    if (sql === "BEGIN") {
      this.log.push("BEGIN");
      this.staged = [];
      this.stagedBodies = [];
      return done();
    }
    if (sql === "COMMIT") {
      this.log.push("COMMIT");
      for (const [name, checksum] of this.staged ?? []) this.applied.set(name, checksum);
      this.executed.push(...this.stagedBodies);
      this.staged = undefined;
      return done();
    }
    if (sql === "ROLLBACK") {
      this.log.push("ROLLBACK");
      this.staged = undefined;
      return done();
    }
    if (sql.startsWith("SELECT pg_advisory_lock")) {
      this.locked = true;
      return done();
    }
    if (sql.startsWith("SELECT pg_advisory_unlock")) {
      this.locked = false;
      return done();
    }
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
      this.tableCreated = true;
      return done();
    }
    if (sql.includes("to_regclass")) return done([{ present: this.tableCreated }]);
    if (sql.startsWith("SELECT name, checksum FROM schema_migrations")) {
      return done([...this.applied].map(([name, checksum]) => ({ name, checksum })));
    }
    if (sql.startsWith("INSERT INTO schema_migrations")) {
      const [name, checksum] = values as [string, string];
      if (this.staged === undefined) this.applied.set(name, checksum);
      else this.staged.push([name, checksum]);
      return done();
    }
    // A migration body.
    if (this.staged === undefined) throw new Error("A migration ran outside a transaction.");
    if (sql.includes("FAIL")) throw new Error("forced migration failure");
    this.stagedBodies.push(sql);
    return done();
  }
}

const files = [
  { name: "0002_second.sql", sql: "BEGIN;\nCREATE TABLE second (id int);\nCOMMIT;\n" },
  { name: "0001_first.sql", sql: "BEGIN;\n-- first\nCREATE TABLE first (id int);\nCOMMIT;\n" },
  { name: "0003_third.sql", sql: "CREATE TABLE third (id int);\n" },
];

describe("createMigrations", () => {
  it("orders by name, checksums the exact bytes, and validates names", () => {
    const migrations = createMigrations(files);
    expect(migrations.map(({ name }) => name)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
      "0003_third.sql",
    ]);
    expect(migrations[0]?.checksum).toBe(migrationChecksum(files[1]?.sql ?? ""));
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(() => createMigrations([{ name: "first.sql", sql: "" }])).toThrow(MigrationError);
    expect(() =>
      createMigrations([
        { name: "0001_a.sql", sql: "" },
        { name: "0001_b.sql", sql: "" },
      ]),
    ).toThrow(/share the number 0001/);
  });

  it("strips only the BEGIN/COMMIT envelope", () => {
    expect(withoutTransactionEnvelope("BEGIN;\n-- c\nCREATE TABLE a (id int);\nCOMMIT;\n")).toBe(
      "\n-- c\nCREATE TABLE a (id int);\n",
    );
    expect(withoutTransactionEnvelope("CREATE TABLE a (id int);\n")).toBe(
      "CREATE TABLE a (id int);\n",
    );
  });
});

describe("applyMigrations", () => {
  it("applies a fresh database in order, each file in its own transaction", async () => {
    const database = new FakeDatabase();
    const migrations = createMigrations(files);
    const result = await applyMigrations(database.pool(), migrations);

    expect(result.applied).toEqual(["0001_first.sql", "0002_second.sql", "0003_third.sql"]);
    expect(result.alreadyApplied).toEqual([]);
    expect([...database.applied]).toEqual(migrations.map((m) => [m.name, m.checksum]));
    expect(database.executed).toEqual([
      "-- first\nCREATE TABLE first (id int);",
      "CREATE TABLE second (id int);",
      "CREATE TABLE third (id int);",
    ]);
    expect(database.log).toEqual(["BEGIN", "COMMIT", "BEGIN", "COMMIT", "BEGIN", "COMMIT"]);
    expect(database.locked).toBe(false);
    expect(database.released).toEqual([undefined]);
  });

  it("is idempotent: a second run applies nothing", async () => {
    const database = new FakeDatabase();
    const migrations = createMigrations(files);
    await applyMigrations(database.pool(), migrations);
    const executed = database.executed.length;

    const again = await applyMigrations(database.pool(), migrations);

    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toHaveLength(3);
    expect(database.executed).toHaveLength(executed);
  });

  it("applies only migrations added since the last run", async () => {
    const database = new FakeDatabase();
    await applyMigrations(database.pool(), createMigrations(files.slice(0, 2)));
    const result = await applyMigrations(database.pool(), createMigrations(files));
    expect(result).toEqual({
      applied: ["0003_third.sql"],
      alreadyApplied: ["0001_first.sql", "0002_second.sql"],
    });
  });

  it("aborts, without applying anything, when an applied migration's checksum changed", async () => {
    const database = new FakeDatabase();
    await applyMigrations(database.pool(), createMigrations(files.slice(0, 2)));
    const executed = database.executed.length;
    const edited = createMigrations([
      { name: "0001_first.sql", sql: "BEGIN;\nCREATE TABLE first (id bigint);\nCOMMIT;\n" },
      files[0] as (typeof files)[number],
      files[2] as (typeof files)[number],
    ]);

    const error = await applyMigrations(database.pool(), edited).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).code).toBe("checksum-mismatch");
    expect((error as MigrationError).message).toContain(
      "0001_first.sql changed after it was applied",
    );
    expect(database.executed).toHaveLength(executed);
    expect(database.applied.has("0003_third.sql")).toBe(false);
    expect(database.locked).toBe(false);
  });

  it("aborts when an applied migration's file is missing", async () => {
    const database = new FakeDatabase();
    await applyMigrations(database.pool(), createMigrations(files));
    await expect(
      applyMigrations(database.pool(), createMigrations(files.slice(0, 1))),
    ).rejects.toMatchObject({ code: "missing-file" });
  });

  it("rolls a failing migration back completely and keeps earlier ones applied", async () => {
    const database = new FakeDatabase();
    const migrations = createMigrations([
      files[1] as (typeof files)[number],
      { name: "0002_broken.sql", sql: "BEGIN;\nCREATE TABLE ok (id int);\nFAIL;\nCOMMIT;\n" },
      files[2] as (typeof files)[number],
    ]);

    const error = await applyMigrations(database.pool(), migrations).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ name: "MigrationError", code: "failed" });
    expect((error as MigrationError).message).toContain(
      "0002_broken.sql failed and was rolled back",
    );
    expect([...database.applied.keys()]).toEqual(["0001_first.sql"]);
    expect(database.log).toEqual(["BEGIN", "COMMIT", "BEGIN", "ROLLBACK"]);
    expect(database.executed).toEqual(["-- first\nCREATE TABLE first (id int);"]);
    expect(database.locked).toBe(false);

    // A corrected, still-unapplied file applies on the next run.
    const fixed = createMigrations([
      files[1] as (typeof files)[number],
      { name: "0002_broken.sql", sql: "BEGIN;\nCREATE TABLE ok (id int);\nCOMMIT;\n" },
    ]);
    expect((await applyMigrations(database.pool(), fixed)).applied).toEqual(["0002_broken.sql"]);
  });
});

describe("verifyMigrations and pendingMigrations", () => {
  it("report pending migrations without writing and pass once everything is applied", async () => {
    const database = new FakeDatabase();
    const migrations = createMigrations(files);

    expect(await pendingMigrations(database.pool(), migrations)).toHaveLength(3);
    expect(database.tableCreated).toBe(false);
    await expect(verifyMigrations(database.pool(), migrations)).rejects.toMatchObject({
      code: "pending",
    });

    await applyMigrations(database.pool(), migrations);
    await expect(verifyMigrations(database.pool(), migrations)).resolves.toBeUndefined();
  });

  it("rejects a changed applied migration", async () => {
    const database = new FakeDatabase();
    await applyMigrations(database.pool(), createMigrations(files));
    const edited = createMigrations([
      { name: "0001_first.sql", sql: "SELECT 1;" },
      ...files.slice(0, 1),
      files[2] as (typeof files)[number],
    ]);
    await expect(verifyMigrations(database.pool(), edited)).rejects.toMatchObject({
      code: "checksum-mismatch",
    });
  });
});

describe("baselineMigrations", () => {
  it("records migrations up to a name without running them, then applies the rest", async () => {
    const database = new FakeDatabase();
    const migrations = createMigrations(files);

    expect(await baselineMigrations(database.pool(), migrations, "0002_second.sql")).toEqual([
      "0001_first.sql",
      "0002_second.sql",
    ]);
    expect(database.executed).toEqual([]);
    expect((await applyMigrations(database.pool(), migrations)).applied).toEqual([
      "0003_third.sql",
    ]);
    await expect(
      baselineMigrations(database.pool(), migrations, "0009_nothing.sql"),
    ).rejects.toMatchObject({ code: "unknown-baseline" });
  });
});

describe("the product migrations", () => {
  it("load, are numbered contiguously from 0001, and carry a transaction envelope", async () => {
    const migrations = await loadMigrations(DEFAULT_MIGRATIONS_DIRECTORY);
    expect(migrations.length).toBeGreaterThanOrEqual(12);
    migrations.forEach((migration, index) => {
      expect(migration.name.startsWith(String(index + 1).padStart(4, "0"))).toBe(true);
      expect(migration.checksum).toBe(migrationChecksum(migration.sql));
      const body = withoutTransactionEnvelope(migration.sql);
      expect(body).not.toMatch(/^\s*BEGIN\s*;/i);
      expect(body).not.toMatch(/COMMIT\s*;\s*$/i);
    });
  });

  it("apply on a fresh fake database and then re-run idempotently", async () => {
    const database = new FakeDatabase();
    const migrations = await loadMigrations(DEFAULT_MIGRATIONS_DIRECTORY);
    expect((await applyMigrations(database.pool(), migrations)).applied).toHaveLength(
      migrations.length,
    );
    expect((await applyMigrations(database.pool(), migrations)).applied).toEqual([]);
  });
});
