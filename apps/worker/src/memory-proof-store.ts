import type {
  ApplyKernelCommand,
  DisplayedSuggestionSet,
  MovePreview,
  MovePreviewId,
  PrepareProofCommandSuccess,
  ProofEdge,
  ProofNode,
  SuggestionSetId,
  TransitionEvent,
} from "@proof/protocol";
import {
  ProofStoreTransactionError,
  type ProofSession,
  type ProofSessionId,
  type ProofStore,
  type ProofStoreTransaction,
} from "./proof-repository";

/**
 * Committed rows of the in-memory store, mirroring the PostgreSQL tables in
 * `migrations/0001_proof_commands.sql` (plus the nullable `proof_sessions.metadata` object from
 * `0003_session_metadata.sql`). Sessions are keyed by session ID; every other table is
 * keyed by `memoryProofRecordKey(sessionId, recordId)`, matching its `(session_id, id)` primary key.
 */
export type MemoryProofTables = Readonly<{
  sessions: Map<string, ProofSession>;
  nodes: Map<string, ProofNode>;
  suggestionSets: Map<string, DisplayedSuggestionSet>;
  previews: Map<string, MovePreview>;
  edges: Map<string, ProofEdge>;
  events: Map<string, TransitionEvent>;
  commands: Map<string, PrepareProofCommandSuccess>;
}>;

type TableName = keyof MemoryProofTables;
type RowOf<Name extends TableName> =
  MemoryProofTables[Name] extends Map<string, infer Row> ? Row : never;
type StagedTables = { [Name in TableName]: Map<string, RowOf<Name>> };

const TABLE_NAMES = [
  "sessions",
  "nodes",
  "suggestionSets",
  "previews",
  "edges",
  "events",
  "commands",
] as const satisfies readonly TableName[];

/** The composite `(session_id, id)` key used by every session-scoped memory table. */
export function memoryProofRecordKey(sessionId: string, recordId: string): string {
  return `${sessionId}\u0000${recordId}`;
}

function sessionOfKey(recordKey: string): string {
  return recordKey.slice(0, recordKey.indexOf("\u0000"));
}

/** A constraint violation raised where PostgreSQL would raise one, aborting the transaction. */
export class MemoryProofStoreConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryProofStoreConstraintError";
  }
}

/**
 * A process-local `ProofStore` for development, tests, and database-free e2e runs.
 *
 * It follows the PostgreSQL adapter's observable semantics: transactions are all-or-nothing and
 * callback failures surface as `ProofStoreTransactionError("rolled-back")`; `lockSession` holds a
 * per-session lock until the transaction ends (like `SELECT ... FOR UPDATE`), and every write to a
 * session's rows takes the same lock (as PostgreSQL's foreign-key row locks conflict with it);
 * reads see committed rows plus the transaction's own writes; primary-key, unique, check, and
 * foreign-key constraints are enforced, with the schema's deferred constraints checked at commit;
 * and stored records are JSON-normalized, so reads return fresh copies as a JSONB round trip would.
 * Nothing survives the process.
 */
export class MemoryProofStore implements ProofStore {
  protected readonly tables: MemoryProofTables = {
    sessions: new Map(),
    nodes: new Map(),
    suggestionSets: new Map(),
    previews: new Map(),
    edges: new Map(),
    events: new Map(),
    commands: new Map(),
  };
  private readonly sessionLocks = new Map<string, Promise<void>>();

  async transaction<Result>(
    work: (transaction: ProofStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    const context = new MemoryTransactionContext(this.tables, (sessionId) =>
      this.acquireSessionLock(sessionId),
    );
    try {
      let result: Result;
      try {
        result = await work(this.instrument(context.transaction));
        context.checkDeferredConstraints();
      } catch (cause: unknown) {
        throw new ProofStoreTransactionError(
          "rolled-back",
          "The in-memory proof transaction was rolled back.",
          cause,
        );
      }
      context.commit();
      return result;
    } finally {
      context.close();
    }
  }

  /** Test seam for fault injection; production returns the transaction unchanged. */
  protected instrument(transaction: ProofStoreTransaction): ProofStoreTransaction {
    return transaction;
  }

  private async acquireSessionLock(sessionId: string): Promise<() => void> {
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.sessionLocks.set(sessionId, tail);
    await previous;
    return () => {
      release();
      if (this.sessionLocks.get(sessionId) === tail) this.sessionLocks.delete(sessionId);
    };
  }
}

class MemoryTransactionContext {
  private readonly staged: StagedTables = {
    sessions: new Map(),
    nodes: new Map(),
    suggestionSets: new Map(),
    previews: new Map(),
    edges: new Map(),
    events: new Map(),
    commands: new Map(),
  };
  private readonly locks = new Map<string, Promise<() => void>>();
  private closed = false;
  readonly transaction: ProofStoreTransaction;

  constructor(
    private readonly committed: MemoryProofTables,
    private readonly acquire: (sessionId: string) => Promise<() => void>,
  ) {
    this.transaction = this.createTransaction();
  }

  checkDeferredConstraints(): void {
    this.assertOpen();
    for (const [sessionId, session] of this.staged.sessions) {
      if (this.row("nodes", memoryProofRecordKey(sessionId, session.rootNodeId)) === undefined) {
        violation(`proof_sessions_root_node_fk: session ${sessionId} has no root node.`);
      }
      if (this.row("nodes", memoryProofRecordKey(sessionId, session.currentNodeId)) === undefined) {
        violation(`proof_sessions_current_node_fk: session ${sessionId} has no current node.`);
      }
    }
    for (const table of ["edges", "events"] as const) {
      for (const [recordKey, record] of this.staged[table]) {
        const commandKey = memoryProofRecordKey(sessionOfKey(recordKey), record.commandId);
        if (this.row("commands", commandKey) === undefined) {
          violation(`proof_${table} command foreign key: ${record.commandId} does not exist.`);
        }
      }
    }
  }

  /** Apply every staged row synchronously, so no other transaction observes a partial commit. */
  commit(): void {
    this.assertOpen();
    for (const name of TABLE_NAMES) this.applyStaged(name);
  }

  private applyStaged<Name extends TableName>(name: Name): void {
    const target = this.committed[name] as Map<string, RowOf<Name>>;
    for (const [recordKey, row] of this.staged[name]) target.set(recordKey, row);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const lock of this.locks.values()) void lock.then((release) => release());
    this.locks.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The in-memory proof transaction has already ended.");
  }

  private async lock(sessionId: string): Promise<void> {
    this.assertOpen();
    let lock = this.locks.get(sessionId);
    if (lock === undefined) {
      lock = this.acquire(sessionId);
      this.locks.set(sessionId, lock);
    }
    const release = await lock;
    // A transaction that ended while waiting must not keep the lock it was granted.
    if (this.closed) {
      release();
      throw new Error("The in-memory proof transaction has already ended.");
    }
  }

  private row<Name extends TableName>(name: Name, recordKey: string): RowOf<Name> | undefined {
    return (this.staged[name].get(recordKey) ??
      (this.committed[name] as Map<string, RowOf<Name>>).get(recordKey)) as RowOf<Name> | undefined;
  }

  private read<Name extends TableName>(name: Name, recordKey: string): RowOf<Name> | undefined {
    this.assertOpen();
    const found = this.row(name, recordKey);
    return found === undefined ? undefined : (structuredClone(found) as RowOf<Name>);
  }

  private async insert<Name extends TableName>(
    name: Name,
    sessionId: string,
    recordKey: string,
    value: RowOf<Name>,
    check: (row: RowOf<Name>) => void,
  ): Promise<void> {
    await this.lock(sessionId);
    if (name !== "sessions" && this.row("sessions", sessionId) === undefined) {
      violation(`${name} session foreign key: session ${sessionId} does not exist.`);
    }
    if (this.row(name, recordKey) !== undefined) {
      violation(`${name} primary key: duplicate key ${JSON.stringify(recordKey)}.`);
    }
    const row = jsonRow(value);
    check(row);
    this.staged[name].set(recordKey, row);
  }

  private async updateCurrentNode(
    sessionId: ProofSessionId,
    expectedNodeId: ProofNode["id"],
    nextNodeId: ProofNode["id"],
  ): Promise<boolean> {
    await this.lock(sessionId);
    const session = this.row("sessions", sessionId);
    if (session === undefined || session.currentNodeId !== expectedNodeId) return false;
    this.staged.sessions.set(sessionId, Object.freeze({ ...session, currentNodeId: nextNodeId }));
    return true;
  }

  private createTransaction(): ProofStoreTransaction {
    return {
      lockSession: async (sessionId) => {
        await this.lock(sessionId);
        const session = this.read("sessions", sessionId);
        return session === undefined
          ? undefined
          : {
              id: session.id,
              rootNodeId: session.rootNodeId,
              currentNodeId: session.currentNodeId,
              operators: session.operators,
              ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
            };
      },
      readNode: async (sessionId, nodeId) => {
        const node = this.read("nodes", memoryProofRecordKey(sessionId, nodeId));
        return node === undefined
          ? undefined
          : { sessionId, nodeId: node.id, stateId: node.state.id, node };
      },
      readCommand: async (sessionId, commandId: ApplyKernelCommand["commandId"]) =>
        this.read("commands", memoryProofRecordKey(sessionId, commandId)),
      readSuggestionSet: async (sessionId, suggestionSetId: SuggestionSetId) => {
        const suggestionSet = this.read(
          "suggestionSets",
          memoryProofRecordKey(sessionId, suggestionSetId),
        );
        return suggestionSet === undefined
          ? undefined
          : {
              sessionId,
              suggestionSetId: suggestionSet.id,
              nodeId: suggestionSet.nodeId,
              stateId: suggestionSet.stateId,
              suggestionSet,
            };
      },
      readPreview: async (sessionId, previewId: MovePreviewId) =>
        this.read("previews", memoryProofRecordKey(sessionId, previewId)),
      listEdges: async (sessionId) => {
        this.assertOpen();
        const keys = new Set([...this.committed.edges.keys(), ...this.staged.edges.keys()]);
        return [...keys]
          .filter((recordKey) => sessionOfKey(recordKey) === sessionId)
          .flatMap((recordKey) => {
            const edge = this.read("edges", recordKey);
            return edge === undefined ? [] : [edge];
          })
          .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
          .map((edge) => ({
            sessionId,
            edgeId: edge.id,
            parentNodeId: edge.parentNodeId,
            childNodeId: edge.childNodeId,
            commandId: edge.commandId,
            suggestionSetId: edge.suggestionSetId ?? null,
            chosenSuggestionId: edge.chosenSuggestionId ?? null,
            previewId: edge.previewId ?? null,
            edge,
          }));
      },
      insertSession: async (session) =>
        this.insert("sessions", session.id, session.id, session, (row) => {
          const metadata: unknown = row.metadata;
          if (
            metadata !== undefined &&
            (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
          ) {
            violation("proof_sessions metadata check: metadata must be a JSON object.");
          }
        }),
      insertNode: async (sessionId, node) =>
        this.insert("nodes", sessionId, memoryProofRecordKey(sessionId, node.id), node, (row) => {
          const duplicateState = this.sessionRows("nodes", sessionId).some(
            (existing) => existing.state.id === row.state.id,
          );
          if (duplicateState) violation(`proof_nodes unique state: ${row.state.id} exists.`);
        }),
      insertSuggestionSet: async (sessionId, suggestionSet) =>
        this.insert(
          "suggestionSets",
          sessionId,
          memoryProofRecordKey(sessionId, suggestionSet.id),
          suggestionSet,
          (row) => this.requireNode(sessionId, row.nodeId, row.stateId),
        ),
      insertPreview: async (sessionId, preview) =>
        this.insert(
          "previews",
          sessionId,
          memoryProofRecordKey(sessionId, preview.id),
          preview,
          (row) => {
            this.requireNode(sessionId, row.nodeId, row.stateId);
            this.requireSuggestionSet(sessionId, row.suggestionSetId, row.nodeId);
          },
        ),
      insertEdge: async (sessionId, edge) =>
        this.insert("edges", sessionId, memoryProofRecordKey(sessionId, edge.id), edge, (row) => {
          this.checkTransitionLinks(sessionId, row);
          const duplicateChild = this.sessionRows("edges", sessionId).some(
            (existing) => existing.childNodeId === row.childNodeId,
          );
          if (duplicateChild) violation(`proof_edges unique child: ${row.childNodeId} exists.`);
        }),
      insertEvent: async (sessionId, event) =>
        this.insert(
          "events",
          sessionId,
          memoryProofRecordKey(sessionId, event.id),
          event,
          (row) => {
            this.checkTransitionLinks(sessionId, row);
            const edge = this.row("edges", memoryProofRecordKey(sessionId, row.edgeId));
            if (
              edge === undefined ||
              edge.parentNodeId !== row.parentNodeId ||
              edge.childNodeId !== row.childNodeId ||
              edge.commandId !== row.commandId
            ) {
              violation(`proof_events edge foreign key: ${row.edgeId} does not match.`);
            }
            const fullyLinked =
              row.suggestionSetId !== undefined &&
              row.chosenSuggestionId !== undefined &&
              row.previewId !== undefined;
            if (
              fullyLinked &&
              (edge.suggestionSetId !== row.suggestionSetId ||
                edge.chosenSuggestionId !== row.chosenSuggestionId ||
                edge.previewId !== row.previewId)
            ) {
              violation(`proof_events edge provenance foreign key: ${row.edgeId} does not match.`);
            }
          },
        ),
      insertCommand: async (sessionId, result: PrepareProofCommandSuccess) =>
        this.insert(
          "commands",
          sessionId,
          memoryProofRecordKey(sessionId, result.prepared.command.commandId),
          result,
          () => undefined,
        ),
      advanceCurrentNode: async (sessionId, expectedNodeId, nextNodeId) =>
        this.updateCurrentNode(sessionId, expectedNodeId, nextNodeId),
      repointCurrentNode: async (sessionId, expectedNodeId, targetNodeId) =>
        this.updateCurrentNode(sessionId, expectedNodeId, targetNodeId),
    };
  }

  private sessionRows<Name extends TableName>(name: Name, sessionId: string): RowOf<Name>[] {
    const keys = new Set([...this.committed[name].keys(), ...this.staged[name].keys()]);
    return [...keys]
      .filter((recordKey) => sessionOfKey(recordKey) === sessionId)
      .flatMap((recordKey) => {
        const found = this.row(name, recordKey);
        return found === undefined ? [] : [found];
      });
  }

  private requireNode(sessionId: string, nodeId: string, stateId?: string): void {
    const node = this.row("nodes", memoryProofRecordKey(sessionId, nodeId));
    if (node === undefined || (stateId !== undefined && node.state.id !== stateId)) {
      violation(`proof node foreign key: ${nodeId} does not exist with the recorded state.`);
    }
  }

  private requireSuggestionSet(sessionId: string, suggestionSetId: string, nodeId: string): void {
    const suggestionSet = this.row(
      "suggestionSets",
      memoryProofRecordKey(sessionId, suggestionSetId),
    );
    if (suggestionSet?.nodeId !== nodeId) {
      violation(`suggestion-set foreign key: ${suggestionSetId} does not belong to ${nodeId}.`);
    }
  }

  /** Checks and immediate foreign keys shared by `proof_edges` and `proof_events`. */
  private checkTransitionLinks(sessionId: string, row: ProofEdge | TransitionEvent): void {
    if (row.parentNodeId === row.childNodeId) violation("A transition cannot be a self-loop.");
    if ((row.suggestionSetId === undefined) !== (row.chosenSuggestionId === undefined)) {
      violation("A suggestion set and chosen suggestion must be recorded together.");
    }
    if (row.previewId !== undefined && row.suggestionSetId === undefined) {
      violation("A preview requires its suggestion set.");
    }
    this.requireNode(sessionId, row.parentNodeId);
    this.requireNode(sessionId, row.childNodeId);
    if (row.suggestionSetId !== undefined) {
      this.requireSuggestionSet(sessionId, row.suggestionSetId, row.parentNodeId);
    }
    if (
      row.previewId !== undefined &&
      row.suggestionSetId !== undefined &&
      row.chosenSuggestionId !== undefined
    ) {
      const preview = this.row("previews", memoryProofRecordKey(sessionId, row.previewId));
      if (
        preview === undefined ||
        preview.nodeId !== row.parentNodeId ||
        preview.suggestionSetId !== row.suggestionSetId ||
        preview.chosenSuggestionId !== row.chosenSuggestionId
      ) {
        violation(`preview foreign key: ${row.previewId} does not match the transition.`);
      }
    }
  }
}

function violation(message: string): never {
  throw new MemoryProofStoreConstraintError(message);
}

/** Normalize like a JSONB column: drop undefined properties and detach from the caller. */
function jsonRow<Row>(value: Row): Row {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as Row);
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((child: unknown) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}
