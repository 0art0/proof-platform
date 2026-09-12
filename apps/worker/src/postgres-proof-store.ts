import type { Pool } from "pg";
import {
  ProofStoreTransactionError,
  type ProofSession,
  type ProofSessionId,
  type ProofStore,
  type ProofStoreTransaction,
} from "./proof-repository";
import type {
  ApplyKernelCommand,
  DisplayedSuggestionSet,
  MovePreview,
  MovePreviewId,
  PrepareProofCommandSuccess,
  ProofEdge,
  ProofNode,
  TransitionEvent,
  SuggestionSetId,
} from "@proof/protocol";

export type SqlQueryResult = Readonly<{
  rows: readonly Readonly<Record<string, unknown>>[];
  rowCount: number | null;
}>;

export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<SqlQueryResult>;
  release(): void;
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
      return result;
    } finally {
      client.release();
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
      `SELECT id, root_node_id, current_node_id, operators
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
      `INSERT INTO proof_sessions (id, root_node_id, current_node_id, operators)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [session.id, session.rootNodeId, session.currentNodeId, JSON.stringify(session.operators)],
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
}
