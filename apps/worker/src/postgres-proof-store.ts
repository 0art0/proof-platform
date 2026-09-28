import type { Pool } from "pg";
import {
  ProofStoreTransactionError,
  type InquiryRecordQuery,
  type InteractionEventQuery,
  type ProofRecordDeletionRequest,
  type ProofRecordDeletionResult,
  type ProofSession,
  type ProofSessionId,
  type ProofStore,
  type ProofStoreTransaction,
} from "./proof-repository";
import {
  inquiryRecordNodeIds,
  inquiryRecordReferenceIds,
  type ApplyKernelCommand,
  type DisplayedSuggestionSet,
  type InquiryRecord,
  type InteractionEvent,
  type InteractionEventId,
  type MovePreview,
  type MovePreviewId,
  type PrepareProofCommandSuccess,
  type ProofDeletionRecord,
  type ProofEdge,
  type ProofNode,
  type TransitionEvent,
  type SuggestionSetId,
} from "@proof/protocol";
import type { SemanticReplayStepRecord } from "@proof/protocol";

export type SqlQueryResult = Readonly<{
  rows: readonly Readonly<Record<string, unknown>>[];
  rowCount: number | null;
}>;

export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<SqlQueryResult>;
  release(error?: Error | boolean): void;
}

export interface SqlPool {
  connect(): Promise<SqlClient>;
}

/** Parameterized PostgreSQL adapter. Schema migration is deliberately external. */
export class PostgresProofStore implements ProofStore {
  constructor(private readonly pool: SqlPool) {}

  async transaction<Result>(
    work: (transaction: ProofStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    let reusable = false;
    try {
      try {
        await client.query("BEGIN");
      } catch (cause: unknown) {
        throw new ProofStoreTransactionError(
          "rolled-back",
          "The PostgreSQL proof transaction could not be started.",
          cause,
        );
      }

      let result: Result;
      try {
        result = await work(new PostgresProofStoreTransaction(client));
      } catch (workCause: unknown) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackCause: unknown) {
          throw new ProofStoreTransactionError(
            "commit-unknown",
            "PostgreSQL could not confirm rollback; retry the same command ID.",
            rollbackCause,
          );
        }
        reusable = true;
        throw new ProofStoreTransactionError(
          "rolled-back",
          "The PostgreSQL proof transaction was rolled back.",
          workCause,
        );
      }

      try {
        await client.query("COMMIT");
      } catch (cause: unknown) {
        throw new ProofStoreTransactionError(
          "commit-unknown",
          "PostgreSQL disconnected or failed while committing; retry the same command ID.",
          cause,
        );
      }
      reusable = true;
      return result;
    } finally {
      if (reusable) {
        client.release();
      } else {
        client.release(true);
      }
    }
  }
}

/** Adapt a real pg Pool without exposing pg-specific types to repository tests. */
export function postgresProofStore(pool: Pool): PostgresProofStore {
  return new PostgresProofStore(pool as unknown as SqlPool);
}

class PostgresProofStoreTransaction implements ProofStoreTransaction {
  constructor(private readonly client: SqlClient) {}

  async lockSession(sessionId: ProofSessionId): Promise<unknown | undefined> {
    const result = await this.client.query(
      `SELECT id, root_node_id, current_node_id, operators, metadata
       FROM proof_sessions
       WHERE id = $1
       FOR UPDATE`,
      [sessionId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          id: row.id,
          rootNodeId: row.root_node_id,
          currentNodeId: row.current_node_id,
          operators: row.operators,
          ...(row.metadata === null || row.metadata === undefined
            ? {}
            : { metadata: row.metadata }),
        };
  }

  async readNode(sessionId: ProofSessionId, nodeId: ProofNode["id"]): Promise<unknown | undefined> {
    const result = await this.client.query(
      `SELECT session_id, id, state_id, state
       FROM proof_nodes
       WHERE session_id = $1 AND id = $2`,
      [sessionId, nodeId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          sessionId: row.session_id,
          nodeId: row.id,
          stateId: row.state_id,
          node: { id: row.id, state: row.state },
        };
  }

  async readCommand(
    sessionId: ProofSessionId,
    commandId: ApplyKernelCommand["commandId"],
  ): Promise<unknown | undefined> {
    const result = await this.client.query(
      `SELECT result
       FROM proof_commands
       WHERE session_id = $1 AND command_id = $2`,
      [sessionId, commandId],
    );
    return result.rows[0]?.result;
  }

  async readSuggestionSet(
    sessionId: ProofSessionId,
    suggestionSetId: SuggestionSetId,
  ): Promise<unknown | undefined> {
    const result = await this.client.query(
      `SELECT session_id, id, node_id, state_id, record
       FROM proof_suggestion_sets
       WHERE session_id = $1 AND id = $2`,
      [sessionId, suggestionSetId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          sessionId: row.session_id,
          suggestionSetId: row.id,
          nodeId: row.node_id,
          stateId: row.state_id,
          suggestionSet: row.record,
        };
  }

  async readPreview(
    sessionId: ProofSessionId,
    previewId: MovePreviewId,
  ): Promise<unknown | undefined> {
    const result = await this.client.query(
      `SELECT record
       FROM proof_previews
       WHERE session_id = $1 AND id = $2`,
      [sessionId, previewId],
    );
    return result.rows[0]?.record;
  }

  async listEdges(sessionId: ProofSessionId): Promise<readonly unknown[]> {
    const result = await this.client.query(
      `SELECT session_id, id, parent_node_id, child_node_id, command_id,
              suggestion_set_id, chosen_suggestion_id, preview_id, record
       FROM proof_edges
       WHERE session_id = $1
       ORDER BY id`,
      [sessionId],
    );
    return result.rows.map((row) => ({
      sessionId: row.session_id,
      edgeId: row.id,
      parentNodeId: row.parent_node_id,
      childNodeId: row.child_node_id,
      commandId: row.command_id,
      suggestionSetId: row.suggestion_set_id,
      chosenSuggestionId: row.chosen_suggestion_id,
      previewId: row.preview_id,
      edge: row.record,
    }));
  }

  async insertSession(session: ProofSession): Promise<void> {
    await this.client.query(
      `INSERT INTO proof_sessions (id, root_node_id, current_node_id, operators, metadata)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        session.id,
        session.rootNodeId,
        session.currentNodeId,
        JSON.stringify(session.operators),
        session.metadata === undefined ? null : JSON.stringify(session.metadata),
      ],
    );
  }

  async insertNode(sessionId: ProofSessionId, node: ProofNode): Promise<void> {
    await this.client.query(
      `INSERT INTO proof_nodes (session_id, id, state_id, state)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [sessionId, node.id, node.state.id, JSON.stringify(node.state)],
    );
  }

  async insertSuggestionSet(
    sessionId: ProofSessionId,
    suggestionSet: DisplayedSuggestionSet,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO proof_suggestion_sets (session_id, id, node_id, state_id, record)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        sessionId,
        suggestionSet.id,
        suggestionSet.nodeId,
        suggestionSet.stateId,
        JSON.stringify(suggestionSet),
      ],
    );
  }

  async insertPreview(sessionId: ProofSessionId, preview: MovePreview): Promise<void> {
    await this.client.query(
      `INSERT INTO proof_previews
         (session_id, id, node_id, state_id, suggestion_set_id,
          chosen_suggestion_id, move_id, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        sessionId,
        preview.id,
        preview.nodeId,
        preview.stateId,
        preview.suggestionSetId,
        preview.chosenSuggestionId,
        preview.moveId,
        JSON.stringify(preview),
      ],
    );
  }

  async insertEdge(sessionId: ProofSessionId, edge: ProofEdge): Promise<void> {
    await this.client.query(
      `INSERT INTO proof_edges
          (session_id, id, parent_node_id, child_node_id, command_id,
          suggestion_set_id, chosen_suggestion_id, preview_id, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        sessionId,
        edge.id,
        edge.parentNodeId,
        edge.childNodeId,
        edge.commandId,
        edge.suggestionSetId ?? null,
        edge.chosenSuggestionId ?? null,
        edge.previewId ?? null,
        JSON.stringify(edge),
      ],
    );
  }

  async insertEvent(sessionId: ProofSessionId, event: TransitionEvent): Promise<void> {
    await this.client.query(
      `INSERT INTO proof_events
          (session_id, id, parent_node_id, child_node_id, edge_id, command_id,
          suggestion_set_id, chosen_suggestion_id, preview_id, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        sessionId,
        event.id,
        event.parentNodeId,
        event.childNodeId,
        event.edgeId,
        event.commandId,
        event.suggestionSetId ?? null,
        event.chosenSuggestionId ?? null,
        event.previewId ?? null,
        JSON.stringify(event),
      ],
    );
  }

  async insertCommand(
    sessionId: ProofSessionId,
    result: PrepareProofCommandSuccess,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO proof_commands (session_id, command_id, command, result)
       VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
      [
        sessionId,
        result.prepared.command.commandId,
        JSON.stringify(result.prepared.command),
        JSON.stringify(result),
      ],
    );
  }

  async advanceCurrentNode(
    sessionId: ProofSessionId,
    expectedNodeId: ProofNode["id"],
    nextNodeId: ProofNode["id"],
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE proof_sessions
       SET current_node_id = $3
       WHERE id = $1 AND current_node_id = $2`,
      [sessionId, expectedNodeId, nextNodeId],
    );
    return result.rowCount === 1;
  }

  async repointCurrentNode(
    sessionId: ProofSessionId,
    expectedNodeId: ProofNode["id"],
    targetNodeId: ProofNode["id"],
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE proof_sessions
       SET current_node_id = $3
       WHERE id = $1 AND current_node_id = $2`,
      [sessionId, expectedNodeId, targetNodeId],
    );
    return result.rowCount === 1;
  }

  async readDeletion(
    sessionId: ProofSessionId,
    commandId: ApplyKernelCommand["commandId"],
  ): Promise<unknown | undefined> {
    const result = await this.client.query(
      `SELECT record
       FROM proof_deletions
       WHERE session_id = $1 AND (command_id = $2 OR $2 = ANY (deleted_command_ids))
       ORDER BY (command_id = $2) DESC, id
       LIMIT 1`,
      [sessionId, commandId],
    );
    return result.rows[0]?.record;
  }

  async deleteProofRecords(
    sessionId: ProofSessionId,
    request: ProofRecordDeletionRequest,
  ): Promise<ProofRecordDeletionResult> {
    const ids = async (text: string, values: readonly unknown[]): Promise<readonly string[]> =>
      (await this.client.query(text, [sessionId, ...values])).rows.map((row) => String(row.id));
    // Dependency order: every non-deferred foreign key into a row is removed before the row.
    const interactionEventIds = await ids(
      `DELETE FROM proof_interaction_events
       WHERE session_id = $1
         AND (node_id = ANY ($2::text[])
              OR preview_id = ANY ($3::text[])
              OR stale_preview_id = ANY ($3::text[]))
       RETURNING id`,
      [request.nodeIds, request.chosenPreviewIds],
    );
    // Inquiry records referencing a deleted node, then every record referencing a removed one.
    await ids(
      `DELETE FROM proof_inquiry_records AS record
       WHERE record.session_id = $1
         AND record.id IN (
           WITH RECURSIVE doomed (id) AS (
             SELECT id FROM proof_inquiry_records
             WHERE session_id = $1 AND referenced_node_ids && $2::text[]
             UNION
             SELECT dependent.id
             FROM proof_inquiry_records AS dependent
             JOIN doomed ON doomed.id = ANY (dependent.referenced_record_ids)
             WHERE dependent.session_id = $1
           )
           SELECT id FROM doomed
         )
       RETURNING record.id`,
      [request.nodeIds],
    );
    const eventIds = await ids(
      `DELETE FROM proof_events
       WHERE session_id = $1 AND edge_id = ANY ($2::text[])
       RETURNING id`,
      [request.edgeIds],
    );
    const edgeIds = await ids(
      `DELETE FROM proof_edges
       WHERE session_id = $1 AND id = ANY ($2::text[])
       RETURNING id`,
      [request.edgeIds],
    );
    const previewIds = await ids(
      `DELETE FROM proof_previews AS preview
       WHERE preview.session_id = $1
         AND (preview.node_id = ANY ($2::text[]) OR preview.id = ANY ($3::text[]))
         AND NOT EXISTS (
           SELECT 1 FROM proof_edges AS edge
           WHERE edge.session_id = preview.session_id AND edge.preview_id = preview.id
         )
       RETURNING preview.id`,
      [request.nodeIds, request.chosenPreviewIds],
    );
    const suggestionSetIds = await ids(
      `DELETE FROM proof_suggestion_sets
       WHERE session_id = $1 AND node_id = ANY ($2::text[])
       RETURNING id`,
      [request.nodeIds],
    );
    // Replayed-step records reference their step's command and node.
    await this.client.query(
      `DELETE FROM proof_replay_steps
       WHERE session_id = $1 AND (command_id = ANY ($2::text[]) OR node_id = ANY ($3::text[]))
       RETURNING command_id AS id`,
      [sessionId, request.commandIds, request.nodeIds],
    );
    const commandIds = await ids(
      `DELETE FROM proof_commands
       WHERE session_id = $1 AND command_id = ANY ($2::text[])
       RETURNING command_id AS id`,
      [request.commandIds],
    );
    const nodeIds = await ids(
      `DELETE FROM proof_nodes
       WHERE session_id = $1 AND id = ANY ($2::text[])
       RETURNING id`,
      [request.nodeIds],
    );
    return {
      interactionEventIds,
      eventIds,
      edgeIds,
      previewIds,
      suggestionSetIds,
      commandIds,
      nodeIds,
    };
  }

  async readReplayStep(
    sessionId: ProofSessionId,
    commandId: ApplyKernelCommand["commandId"],
  ): Promise<unknown | undefined> {
    const result = await this.client.query(
      `SELECT record
       FROM proof_replay_steps
       WHERE session_id = $1 AND command_id = $2`,
      [sessionId, commandId],
    );
    return result.rows[0]?.record;
  }

  async insertReplayStep(
    sessionId: ProofSessionId,
    record: SemanticReplayStepRecord,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO proof_replay_steps
         (session_id, command_id, replay_command_id, step_index, step_count, node_id,
          source_edge_id, recorded_at, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
      [
        sessionId,
        record.commandId,
        record.replayCommandId,
        record.index,
        record.count,
        record.nodeId,
        record.sourceEdgeId,
        record.recordedAt,
        JSON.stringify(record),
      ],
    );
  }

  async insertDeletion(sessionId: ProofSessionId, deletion: ProofDeletionRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO proof_deletions
         (session_id, id, command_id, actor_id, actor_kind, reason, parent_node_id,
          deleted_node_ids, deleted_edge_ids, deleted_command_ids, occurred_at, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::text[], $10::text[],
               $11::timestamptz, $12::jsonb)`,
      [
        sessionId,
        deletion.id,
        deletion.commandId,
        deletion.actor.id,
        deletion.actor.kind,
        deletion.reason ?? null,
        deletion.parentNodeId,
        deletion.deletedNodeIds,
        deletion.deletedEdgeIds,
        deletion.deletedCommandIds,
        deletion.occurredAt,
        JSON.stringify(deletion),
      ],
    );
  }

  async readInteractionEvent(
    sessionId: ProofSessionId,
    eventId: InteractionEventId,
  ): Promise<unknown | undefined> {
    const result = await this.client.query(
      `SELECT session_id, id, sequence, node_id, record
       FROM proof_interaction_events
       WHERE session_id = $1 AND id = $2`,
      [sessionId, eventId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : interactionEventRecord(row);
  }

  async lastInteractionSequence(sessionId: ProofSessionId): Promise<number> {
    // The caller holds the session row lock, so no concurrent insert can take the next number.
    const result = await this.client.query(
      `SELECT COALESCE(MAX(sequence), 0) AS sequence
       FROM proof_interaction_events
       WHERE session_id = $1`,
      [sessionId],
    );
    return Number(result.rows[0]?.sequence ?? 0);
  }

  async insertInteractionEvent(sessionId: ProofSessionId, event: InteractionEvent): Promise<void> {
    await this.client.query(
      `INSERT INTO proof_interaction_events
         (session_id, id, sequence, node_id, state_id, kind, actor_id, actor_kind,
          suggestion_set_id, preview_id, stale_preview_id, recorded_at, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::jsonb)`,
      [
        sessionId,
        event.id,
        event.sequence,
        event.nodeId,
        event.stateId,
        event.kind,
        event.actor.id,
        event.actor.kind,
        "suggestionSetId" in event ? (event.suggestionSetId ?? null) : null,
        "previewId" in event ? event.previewId : null,
        "stalePreviewId" in event ? event.stalePreviewId : null,
        event.recordedAt,
        JSON.stringify(event),
      ],
    );
  }

  async listInteractionEvents(
    sessionId: ProofSessionId,
    query: InteractionEventQuery,
  ): Promise<readonly unknown[]> {
    const result = await this.client.query(
      `SELECT session_id, id, sequence, node_id, record
       FROM proof_interaction_events
       WHERE session_id = $1 AND sequence > $2 AND ($3::text IS NULL OR node_id = $3)
       ORDER BY sequence
       LIMIT $4`,
      [sessionId, query.afterSequence, query.nodeId ?? null, query.limit],
    );
    return result.rows.map(interactionEventRecord);
  }

  async readInquiryRecord(
    sessionId: ProofSessionId,
    recordId: string,
  ): Promise<unknown | undefined> {
    const result = await this.client.query(
      `SELECT session_id, id, sequence, command_id, node_id, record
       FROM proof_inquiry_records
       WHERE session_id = $1 AND id = $2`,
      [sessionId, recordId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : inquiryReadRecord(row);
  }

  async lastInquirySequence(sessionId: ProofSessionId): Promise<number> {
    // The caller holds the session row lock, so no concurrent insert can take the next number.
    const result = await this.client.query(
      `SELECT COALESCE(MAX(sequence), 0) AS sequence
       FROM proof_inquiry_records
       WHERE session_id = $1`,
      [sessionId],
    );
    return Number(result.rows[0]?.sequence ?? 0);
  }

  async insertInquiryRecord(sessionId: ProofSessionId, record: InquiryRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO proof_inquiry_records
         (session_id, id, sequence, command_id, kind, node_id, state_id, actor_id, actor_kind,
          recorded_at, referenced_node_ids, referenced_record_ids, record)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::text[], $12::text[],
               $13::jsonb)`,
      [
        sessionId,
        record.id,
        record.sequence,
        record.commandId,
        record.kind,
        record.nodeId,
        record.stateId,
        record.actor.id,
        record.actor.kind,
        record.recordedAt,
        [...new Set([record.nodeId, ...inquiryRecordNodeIds(record)])].sort(),
        [...inquiryRecordReferenceIds(record)],
        JSON.stringify(record),
      ],
    );
  }

  async listInquiryRecords(
    sessionId: ProofSessionId,
    query: InquiryRecordQuery,
  ): Promise<readonly unknown[]> {
    const result = await this.client.query(
      `SELECT session_id, id, sequence, command_id, node_id, record
       FROM proof_inquiry_records
       WHERE session_id = $1
         AND sequence > $2
         AND ($3::text IS NULL OR node_id = $3)
         AND ($4::text IS NULL OR command_id = $4)
         AND ($5::text IS NULL OR $5 = ANY (referenced_record_ids))
       ORDER BY sequence
       LIMIT $6`,
      [
        sessionId,
        query.afterSequence,
        query.nodeId ?? null,
        query.commandId ?? null,
        query.referencing ?? null,
        query.limit,
      ],
    );
    return result.rows.map(inquiryReadRecord);
  }
}

function inquiryReadRecord(row: Readonly<Record<string, unknown>>): unknown {
  return {
    sessionId: row.session_id,
    recordId: row.id,
    sequence: typeof row.sequence === "string" ? Number(row.sequence) : row.sequence,
    commandId: row.command_id,
    nodeId: row.node_id,
    record: row.record,
  };
}

function interactionEventRecord(row: Readonly<Record<string, unknown>>): unknown {
  return {
    sessionId: row.session_id,
    eventId: row.id,
    // node-postgres returns bigint columns as strings; the column is an integer.
    sequence: typeof row.sequence === "string" ? Number(row.sequence) : row.sequence,
    nodeId: row.node_id,
    event: row.record,
  };
}
