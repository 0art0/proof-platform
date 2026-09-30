/**
 * The idempotent migration runner (roadmap N36).
 *
 * Migrations are the numbered `apps/worker/migrations/NNNN_name.sql` files. `schema_migrations`
 * records each applied file by name and the sha256 checksum of its exact bytes:
 *
 * - a fresh database applies every file in name order; a re-run applies nothing;
 * - each file runs in its own transaction together with its `schema_migrations` row, so a failure
 *   rolls that file back completely and leaves earlier files applied;
 * - an applied file whose checksum changed, or an applied name with no file, aborts before any
 *   further change: history is never rewritten silently;
 * - one advisory lock serializes concurrent runners.
 *
 * The migration files carry their own `BEGIN;` / `COMMIT;` envelope so they can still be applied
 * by hand; the runner strips that envelope and supplies its own transaction.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { SqlClient, SqlPool } from "../postgres-proof-store";

export type MigrationFile = Readonly<{ name: string; sql: string; checksum: string }>;

export type MigrationErrorCode =
  | "invalid-name"
  | "duplicate-number"
  | "checksum-mismatch"
  | "missing-file"
  | "unknown-baseline"
  | "failed"
  | "pending";

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  override readonly cause: unknown;

  constructor(code: MigrationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.cause = cause;
  }
}

export type ApplyMigrationsResult = Readonly<{
  applied: readonly string[];
  alreadyApplied: readonly string[];
}>;

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** Arbitrary constant key of the advisory lock that serializes runners. */
const ADVISORY_LOCK_KEY = 7_270_036;

export const CREATE_SCHEMA_MIGRATIONS = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Build migration records from file names and contents, validated and ordered by name. */
export function createMigrations(
  files: readonly Readonly<{ name: string; sql: string }>[],
): readonly MigrationFile[] {
  const numbers = new Map<string, string>();
  for (const { name } of files) {
    const match = MIGRATION_NAME.exec(name);
    if (match === null) {
      throw new MigrationError(
        "invalid-name",
        `Migration file ${JSON.stringify(name)} must be named NNNN_lowercase_words.sql.`,
      );
    }
    const number = match[1] as string;
    const other = numbers.get(number);
    if (other !== undefined) {
      throw new MigrationError(
        "duplicate-number",
        `Migration files ${other} and ${name} share the number ${number}.`,
      );
    }
    numbers.set(number, name);
  }
  return files
    .map(({ name, sql }) => Object.freeze({ name, sql, checksum: migrationChecksum(sql) }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** Read every `*.sql` file of a migrations directory. */
export async function loadMigrations(directory: string | URL): Promise<readonly MigrationFile[]> {
  const entries = await readdir(directory);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".sql"))
      .map(async (name) => ({
        name,
        sql: await readFile(new URL(name, directoryUrl(directory)), "utf8"),
      })),
  );
  return createMigrations(files);
}

function directoryUrl(directory: string | URL): URL {
  const url = typeof directory === "string" ? pathToFileURL(directory) : directory;
  return url.href.endsWith("/") ? url : new URL(`${url.href}/`);
}

/** The default location of the product migrations, next to `src/`. */
export const DEFAULT_MIGRATIONS_DIRECTORY = new URL("../../migrations/", import.meta.url);

/**
 * The statements of a migration without its own `BEGIN;`/`COMMIT;` envelope, so the runner's
 * transaction also covers the `schema_migrations` row. A file without an envelope runs as is.
 */
export function withoutTransactionEnvelope(sql: string): string {
  return sql
    .replace(/^((?:\s*--[^\n]*\n)*\s*)BEGIN\s*;/i, "$1")
    .replace(/COMMIT\s*;(\s*--[^\n]*)*\s*$/i, "");
}

/** Run `work` on one connection holding the runner's advisory lock. */
async function withRunnerLock<Result>(
  pool: SqlPool,
  work: (client: SqlClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  let healthy = true;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      return await work(client);
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
      } catch {
        healthy = false;
      }
    }
  } catch (error: unknown) {
    healthy = false;
    throw error;
  } finally {
    // A connection in an unknown state, possibly still holding the lock, is discarded.
    if (healthy) client.release();
    else client.release(true);
  }
}

async function readApplied(
  client: SqlClient,
  create: boolean,
): Promise<ReadonlyMap<string, string>> {
  if (create) {
    await client.query(CREATE_SCHEMA_MIGRATIONS);
  } else {
    const present = await client.query(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    );
    if (present.rows[0]?.present !== true) return new Map();
  }
  const result = await client.query("SELECT name, checksum FROM schema_migrations ORDER BY name");
  return new Map(result.rows.map((row) => [String(row.name), String(row.checksum)]));
}

/** Abort on a changed or missing applied migration; returns the pending ones in order. */
function checkHistory(
  migrations: readonly MigrationFile[],
  applied: ReadonlyMap<string, string>,
): readonly MigrationFile[] {
  const byName = new Map(migrations.map((migration) => [migration.name, migration]));
  for (const [name, checksum] of applied) {
    const file = byName.get(name);
    if (file === undefined) {
      throw new MigrationError(
        "missing-file",
        `Migration ${name} is recorded as applied but its file is missing.`,
      );
    }
    if (file.checksum !== checksum) {
      throw new MigrationError(
        "checksum-mismatch",
        `Migration ${name} changed after it was applied ` +
          `(recorded sha256 ${checksum}, file sha256 ${file.checksum}). ` +
          "Applied migrations are immutable; add a new migration instead.",
      );
    }
  }
  return migrations.filter((migration) => !applied.has(migration.name));
}

/** Apply every pending migration, each in its own transaction. Safe to run repeatedly. */
export async function applyMigrations(
  pool: SqlPool,
  migrations: readonly MigrationFile[],
  options: Readonly<{ log?: (message: string) => void }> = {},
): Promise<ApplyMigrationsResult> {
  return withRunnerLock(pool, async (client) => {
    const applied = await readApplied(client, true);
    const pending = checkHistory(migrations, applied);
    const done: string[] = [];
    for (const migration of pending) {
      await applyOne(client, migration);
      options.log?.(`applied ${migration.name}`);
      done.push(migration.name);
    }
    return {
      applied: done,
      alreadyApplied: migrations.filter((m) => applied.has(m.name)).map((m) => m.name),
    };
  });
}

async function applyOne(client: SqlClient, migration: MigrationFile): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(withoutTransactionEnvelope(migration.sql));
    await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
      migration.name,
      migration.checksum,
    ]);
    await client.query("COMMIT");
  } catch (cause: unknown) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original failure is the one to report; the connection is discarded by the caller.
    }
    throw new MigrationError(
      "failed",
      `Migration ${migration.name} failed and was rolled back: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    );
  }
}

/**
 * The names of migrations not yet applied. Throws on a changed or missing applied migration.
 * It writes nothing.
 */
export async function pendingMigrations(
  pool: SqlPool,
  migrations: readonly MigrationFile[],
): Promise<readonly string[]> {
  const client = await pool.connect();
  try {
    const applied = await readApplied(client, false);
    return checkHistory(migrations, applied).map((migration) => migration.name);
  } finally {
    client.release();
  }
}

/** Throw `MigrationError("pending")` unless every migration is applied and unchanged. */
export async function verifyMigrations(
  pool: SqlPool,
  migrations: readonly MigrationFile[],
): Promise<void> {
  const pending = await pendingMigrations(pool, migrations);
  if (pending.length > 0) {
    throw new MigrationError(
      "pending",
      `The database is missing ${pending.length} migration(s): ${pending.join(", ")}. ` +
        "Run `npm run migrate` (or start the worker with PROOF_AUTO_MIGRATE=true).",
    );
  }
}

/**
 * Record every migration up to and including `through` as applied without running it, for a
 * database whose schema was created by hand before this runner existed. Migrations already
 * recorded are left alone (their checksums are still verified).
 */
export async function baselineMigrations(
  pool: SqlPool,
  migrations: readonly MigrationFile[],
  through: string,
): Promise<readonly string[]> {
  const index = migrations.findIndex((migration) => migration.name === through);
  if (index < 0) {
    throw new MigrationError("unknown-baseline", `No migration file is named ${through}.`);
  }
  return withRunnerLock(pool, async (client) => {
    const applied = await readApplied(client, true);
    checkHistory(migrations, applied);
    const recorded: string[] = [];
    for (const migration of migrations.slice(0, index + 1)) {
      if (applied.has(migration.name)) continue;
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        migration.name,
        migration.checksum,
      ]);
      recorded.push(migration.name);
    }
    return recorded;
  });
}
