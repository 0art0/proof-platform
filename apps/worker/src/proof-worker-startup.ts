import { Pool } from "pg";
import { ensureDevelopmentProofSession } from "./development-session";
import type { LibraryStore } from "./library-repository";
import { MemoryLibraryStore } from "./memory-library-store";
import { postgresLibraryStore } from "./postgres-library-store";
import { postgresProofStore } from "./postgres-proof-store";
import { createProofHttpService, type ProofHttpService } from "./proof-http";
import type { ProofStore } from "./proof-repository";

export type ProofWorkerEnvironment = Readonly<Record<string, string | undefined>>;

export type ProofStoreSelection =
  | Readonly<{
      ok: true;
      kind: "memory" | "postgres";
      store: ProofStore;
      library: LibraryStore;
      close: () => Promise<void>;
    }>
  | Readonly<{ ok: false; message: string }>;

/**
 * `PROOF_STORE=memory` selects the non-persistent in-memory store. Otherwise (`PROOF_STORE`
 * absent or `postgres`) PostgreSQL is required via `PROOF_DATABASE_URL` or `DATABASE_URL`;
 * there is deliberately no silent fallback to memory.
 */
export function selectProofStore(env: ProofWorkerEnvironment): ProofStoreSelection {
  const requested = env.PROOF_STORE === undefined ? undefined : env.PROOF_STORE.trim();
  if (requested === "memory") {
    const store = new MemoryLibraryStore();
    return Object.freeze({
      ok: true as const,
      kind: "memory" as const,
      store,
      library: store,
      close: async () => undefined,
    });
  }
  if (requested !== undefined && requested !== "" && requested !== "postgres") {
    return Object.freeze({
      ok: false as const,
      message: `Unsupported PROOF_STORE=${JSON.stringify(requested)}; use "memory" or "postgres".`,
    });
  }
  const connectionString = nonEmpty(env.PROOF_DATABASE_URL) ?? nonEmpty(env.DATABASE_URL);
  if (connectionString === undefined) {
    return Object.freeze({
      ok: false as const,
      message:
        "No proof store is configured. Set PROOF_DATABASE_URL (or DATABASE_URL) to a migrated " +
        "PostgreSQL database, or set PROOF_STORE=memory for a non-persistent in-memory store.",
    });
  }
  const pool = new Pool({ connectionString });
  return Object.freeze({
    ok: true as const,
    kind: "postgres" as const,
    store: postgresProofStore(pool),
    library: postgresLibraryStore(pool),
    close: () => pool.end(),
  });
}

export type StartedProofWorker = Readonly<{
  kind: "memory" | "postgres";
  origin: string;
  service: ProofHttpService;
  close: () => Promise<void>;
}>;

/** Select the store, seed `session:development` idempotently, and serve the proof HTTP API. */
export async function startProofWorker(env: ProofWorkerEnvironment): Promise<StartedProofWorker> {
  const selection = selectProofStore(env);
  if (!selection.ok) throw new Error(selection.message);
  try {
    const seeded = await ensureDevelopmentProofSession(selection.store);
    if (seeded.status !== "ready") {
      throw new Error(`Development session seeding failed: ${seeded.diagnostics[0].message}`);
    }
    const service = createProofHttpService(selection.store, { library: selection.library });
    const port = parsePort(env.PROOF_HTTP_PORT);
    const { origin } = await service.listen({ host: env.PROOF_HTTP_HOST ?? "127.0.0.1", port });
    return Object.freeze({
      kind: selection.kind,
      origin,
      service,
      close: async () => {
        await service.close();
        await selection.close();
      },
    });
  } catch (error: unknown) {
    await selection.close();
    throw error;
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid PROOF_HTTP_PORT=${JSON.stringify(value)}.`);
  }
  return port;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}
