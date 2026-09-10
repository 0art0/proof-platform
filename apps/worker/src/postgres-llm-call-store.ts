import type { Pool } from "pg";
import {
  type LlmCallOwner,
  type LlmCallStore,
  type LlmCallStoreTransaction,
  type StoredLlmCall,
  type TopicProposalDecision,
} from "./llm-call-repository";
import { ProofStoreTransactionError } from "./proof-repository";
import type { LlmCallId } from "@proof/llm";
import type { SqlClient, SqlPool } from "./postgres-proof-store";

/** PostgreSQL/JSONB storage for exact LLM requests, outcomes, and proposal review. */
export class PostgresLlmCallStore implements LlmCallStore {
  constructor(private readonly pool: SqlPool) {}

  async transaction<Result>(
    work: (transaction: LlmCallStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      try {
        await client.query("BEGIN");
      } catch (cause: unknown) {
        throw new ProofStoreTransactionError(
          "rolled-back",
          "The PostgreSQL LLM-call transaction could not be started.",
          cause,
        );
      }
      let result: Result;
      try {
        result = await work(new PostgresLlmCallStoreTransaction(client));
      } catch (workCause: unknown) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackCause: unknown) {
          throw new ProofStoreTransactionError(
            "commit-unknown",
            "PostgreSQL could not confirm the LLM-call rollback.",
            rollbackCause,
          );
        }
        throw new ProofStoreTransactionError(
          "rolled-back",
          "The PostgreSQL LLM-call transaction was rolled back.",
          workCause,
        );
      }
      try {
        await client.query("COMMIT");
      } catch (cause: unknown) {
        throw new ProofStoreTransactionError(
          "commit-unknown",
          "PostgreSQL could not confirm the LLM-call commit.",
          cause,
        );
      }
      return result;
    } finally {
      client.release();
    }
  }
}

export function postgresLlmCallStore(pool: Pool): PostgresLlmCallStore {
  return new PostgresLlmCallStore(pool as unknown as SqlPool);
}

class PostgresLlmCallStoreTransaction implements LlmCallStoreTransaction {
  constructor(private readonly client: SqlClient) {}

  async readCallForUpdate(owner: LlmCallOwner, callId: LlmCallId): Promise<unknown | undefined> {
    await this.lockIdentity("call", owner, callId);
    const result = await this.client.query(
      `SELECT record
       FROM llm_calls
       WHERE owner_kind = $1 AND owner_id = $2 AND id = $3
       FOR UPDATE`,
      [owner.kind, owner.id, callId],
    );
    return result.rows[0]?.record;
  }

  async insertCall(record: StoredLlmCall): Promise<void> {
    await this.client.query(
      `INSERT INTO llm_calls (owner_kind, owner_id, id, role, status, record)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        record.owner.kind,
        record.owner.id,
        record.id,
        record.role,
        record.status,
        JSON.stringify(record),
      ],
    );
  }

  async completeCall(record: StoredLlmCall): Promise<boolean> {
    if (record.status !== "completed") return false;
    const result = await this.client.query(
      `UPDATE llm_calls
       SET status = 'completed', record = $4::jsonb
       WHERE owner_kind = $1 AND owner_id = $2 AND id = $3 AND status = 'dispatching'`,
      [record.owner.kind, record.owner.id, record.id, JSON.stringify(record)],
    );
    return result.rowCount === 1;
  }

  async readDecisionForUpdate(
    owner: LlmCallOwner,
    decisionId: string,
  ): Promise<unknown | undefined> {
    await this.lockIdentity("decision", owner, decisionId);
    const result = await this.client.query(
      `SELECT record
       FROM llm_topic_decisions
       WHERE owner_kind = $1 AND owner_id = $2 AND id = $3
       FOR UPDATE`,
      [owner.kind, owner.id, decisionId],
    );
    return result.rows[0]?.record;
  }

  async insertDecision(decision: TopicProposalDecision): Promise<void> {
    await this.client.query(
      `INSERT INTO llm_topic_decisions
         (owner_kind, owner_id, id, call_id, decision, approved_manifest_id, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        decision.owner.kind,
        decision.owner.id,
        decision.id,
        decision.callId,
        decision.decision,
        decision.decision === "approved" ? decision.approvedManifestId : null,
        JSON.stringify(decision),
      ],
    );
  }

  private async lockIdentity(
    recordKind: "call" | "decision",
    owner: LlmCallOwner,
    id: string,
  ): Promise<void> {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      JSON.stringify([recordKind, owner.kind, owner.id, id]),
    ]);
  }
}
