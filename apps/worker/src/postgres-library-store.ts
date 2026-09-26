import type { Pool } from "pg";
import type {
  BackgroundRevisionEvent,
  LibraryAdditionEvent,
  LibraryOperatorRegistration,
} from "@proof/library";
import type { ProofSessionMetadata } from "@proof/protocol";
import {
  libraryScopeKey,
  type LibrarySessionRow,
  type LibraryStore,
  type LibraryStoreTransaction,
  type StoredLibraryArtifactRow,
} from "./library-repository";
import { ProofStoreTransactionError } from "./proof-repository";
import type { SqlClient, SqlPool } from "./postgres-proof-store";

/** PostgreSQL/JSONB library storage (`migrations/0005_library.sql`). */
export class PostgresLibraryStore implements LibraryStore {
  constructor(private readonly pool: SqlPool) {}

  async libraryTransaction<Result>(
    work: (transaction: LibraryStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      try {
        await client.query("BEGIN");
      } catch (cause: unknown) {
        throw new ProofStoreTransactionError(
          "rolled-back",
          "The PostgreSQL library transaction could not be started.",
          cause,
        );
      }
      let result: Result;
      try {
        result = await work(new PostgresLibraryStoreTransaction(client));
      } catch (workCause: unknown) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackCause: unknown) {
          throw new ProofStoreTransactionError(
            "commit-unknown",
            "PostgreSQL could not confirm the library rollback.",
            rollbackCause,
          );
        }
        throw new ProofStoreTransactionError(
          "rolled-back",
          "The PostgreSQL library transaction was rolled back.",
          workCause,
        );
      }
      try {
        await client.query("COMMIT");
      } catch (cause: unknown) {
        throw new ProofStoreTransactionError(
          "commit-unknown",
          "PostgreSQL could not confirm the library commit.",
          cause,
        );
      }
      return result;
    } finally {
      client.release();
    }
  }
}

export function postgresLibraryStore(pool: Pool): PostgresLibraryStore {
  return new PostgresLibraryStore(pool as unknown as SqlPool);
}

class PostgresLibraryStoreTransaction implements LibraryStoreTransaction {
  constructor(private readonly client: SqlClient) {}

  async lockLibrarySession(sessionId: string): Promise<LibrarySessionRow | undefined> {
    const result = await this.client.query(
      `SELECT operators, metadata
       FROM proof_sessions
       WHERE id = $1
       FOR UPDATE`,
      [sessionId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { operators: row.operators, metadata: row.metadata };
  }

  async lockGlobalLibrary(): Promise<void> {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      "library:global",
    ]);
  }

  async proofNodeExists(sessionId: string, nodeId: string): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1 FROM proof_nodes WHERE session_id = $1 AND id = $2`,
      [sessionId, nodeId],
    );
    return result.rows.length > 0;
  }

  async readAdditionEvent(
    sessionId: string | undefined,
    eventId: string,
  ): Promise<unknown | undefined> {
    const result = await this.client.query(
      `SELECT record FROM library_addition_events WHERE scope_key = $1 AND id = $2`,
      [libraryScopeKey(sessionId), eventId],
    );
    return result.rows[0]?.record;
  }

  async listAdditionEvents(sessionId: string | undefined): Promise<readonly unknown[]> {
    const result = await this.client.query(
      `SELECT record FROM library_addition_events WHERE scope_key = $1 ORDER BY sequence`,
      [libraryScopeKey(sessionId)],
    );
    return result.rows.map((row) => row.record);
  }

  async readLibraryArtifact(
    sessionId: string | undefined,
    artifactId: string,
  ): Promise<unknown | undefined> {
    const result = await this.client.query(
      `SELECT record FROM library_artifacts WHERE scope_key = $1 AND id = $2`,
      [libraryScopeKey(sessionId), artifactId],
    );
    return result.rows[0]?.record;
  }

  async listLibraryArtifacts(
    sessionId: string | undefined,
  ): Promise<readonly StoredLibraryArtifactRow[]> {
    const result = await this.client.query(
      `SELECT session_id, event_id, sequence, record
       FROM library_artifacts
       WHERE scope_key = $1
       ORDER BY sequence, id COLLATE "C"`,
      [libraryScopeKey(sessionId)],
    );
    return result.rows.map((row) => ({
      sessionId: typeof row.session_id === "string" ? row.session_id : null,
      eventId: String(row.event_id),
      sequence: Number(row.sequence),
      artifact: row.record,
    }));
  }

  async insertAdditionEvent(event: LibraryAdditionEvent): Promise<void> {
    await this.client.query(
      `INSERT INTO library_addition_events
         (scope_key, session_id, id, sequence, layer, decision, artifact_id, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        libraryScopeKey(event.sessionId),
        event.sessionId ?? null,
        event.id,
        event.sequence,
        event.layer,
        event.admission.decision,
        event.artifact.id,
        JSON.stringify(event),
      ],
    );
  }

  async insertLibraryArtifact(event: LibraryAdditionEvent): Promise<void> {
    await this.client.query(
      `INSERT INTO library_artifacts
         (scope_key, session_id, id, layer, event_id, sequence, decision, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        libraryScopeKey(event.sessionId),
        event.sessionId ?? null,
        event.artifact.id,
        event.layer,
        event.id,
        event.sequence,
        event.admission.decision,
        JSON.stringify(event.artifact),
      ],
    );
  }

  async listBackgroundRevisions(sessionId: string): Promise<readonly unknown[]> {
    const result = await this.client.query(
      `SELECT record FROM library_background_revisions WHERE session_id = $1 ORDER BY sequence`,
      [sessionId],
    );
    return result.rows.map((row) => row.record);
  }

  async insertBackgroundRevision(event: BackgroundRevisionEvent): Promise<void> {
    await this.client.query(
      `INSERT INTO library_background_revisions (session_id, id, sequence, record)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [event.sessionId, event.id, event.sequence, JSON.stringify(event)],
    );
  }

  async updateSessionMetadata(sessionId: string, metadata: ProofSessionMetadata): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE proof_sessions SET metadata = $2::jsonb WHERE id = $1`,
      [sessionId, JSON.stringify(metadata)],
    );
    return result.rowCount === 1;
  }

  async listLibraryOperators(): Promise<readonly unknown[]> {
    const result = await this.client.query(
      `SELECT record FROM library_operators ORDER BY symbol COLLATE "C"`,
    );
    return result.rows.map((row) => row.record);
  }

  async insertLibraryOperator(registration: LibraryOperatorRegistration): Promise<void> {
    await this.client.query(
      `INSERT INTO library_operators (id, symbol, record) VALUES ($1, $2, $3::jsonb)`,
      [registration.operator.id, registration.operator.symbol, JSON.stringify(registration)],
    );
  }
}
