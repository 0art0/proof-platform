/**
 * `npm run migrate [-- --status | --baseline <migration-file>]` applies the pending product
 * migrations to the database in `PROOF_DATABASE_URL` (or `DATABASE_URL`). It is idempotent.
 *
 * - `--status` prints applied and pending migrations and changes nothing.
 * - `--baseline <file>` records every migration up to `<file>` as already applied without running
 *   it, for a database whose schema was applied by hand before the runner existed.
 */
import { Pool } from "pg";
import type { SqlPool } from "../postgres-proof-store";
import {
  DEFAULT_MIGRATIONS_DIRECTORY,
  applyMigrations,
  baselineMigrations,
  loadMigrations,
  pendingMigrations,
} from "./runner";

const args = process.argv.slice(2);
const connectionString = process.env.PROOF_DATABASE_URL || process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === "") {
  console.error("Set PROOF_DATABASE_URL (or DATABASE_URL) to the PostgreSQL database to migrate.");
  process.exit(1);
}

const pool = new Pool({ connectionString });
try {
  const sqlPool = pool as unknown as SqlPool;
  const migrations = await loadMigrations(DEFAULT_MIGRATIONS_DIRECTORY);
  if (args[0] === "--status") {
    const pending = await pendingMigrations(sqlPool, migrations);
    console.log(pending.length === 0 ? "Up to date." : `Pending: ${pending.join(", ")}`);
  } else if (args[0] === "--baseline") {
    const through = args[1];
    if (through === undefined) throw new Error("--baseline needs a migration file name.");
    const recorded = await baselineMigrations(sqlPool, migrations, through);
    console.log(`Recorded as applied: ${recorded.join(", ") || "nothing new"}`);
  } else if (args.length > 0) {
    throw new Error(`Unknown arguments: ${args.join(" ")}`);
  } else {
    const result = await applyMigrations(sqlPool, migrations, { log: console.log });
    console.log(
      result.applied.length === 0
        ? "Up to date; nothing applied."
        : `Applied ${result.applied.length} migration(s).`,
    );
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
