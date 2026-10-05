import {
  inquiryRecordNodeIds,
  inquiryRecordReferenceIds,
  type ApplyKernelCommand,
  type DisplayedSuggestionSet,
  type InquiryRecord,
  type InteractionEvent,
  type MovePreview,
  type MovePreviewId,
  type PrepareProofCommandSuccess,
  type ProofArtifactImportRecord,
  type ProofDeletionRecord,
  type ProofEdge,
  type ProofNode,
  type SuggestionSetId,
  type TransitionEvent,
} from "@proof/protocol";
import type { SemanticReplayStepRecord } from "@proof/protocol";
import {
  ProofStoreTransactionError,
  guardReadOnlySessions,
  type ProofRecordDeletionRequest,
  type ProofRecordDeletionResult,
  type ProofSession,
  type ProofSessionId,
  type ProofStore,
  type ProofStoreTransaction,
} from "./proof-repository";

/**
 * Committed rows of the in-memory store, mirroring the PostgreSQL tables in
 * `migrations/0001_proof_commands.sql` (plus the nullable `proof_sessions.metadata` object from
 * `0004_session_metadata.sql`), the `proof_deletions` tombstones of `0006_proof_deletions.sql`,
 * and the `proof_interaction_events` log of `0007_interaction_events.sql` (kinds widened by
 * `0008_backtrack_interaction_event.sql`), and the `proof_inquiry_records` of
 * `0009_inquiry_records.sql`, and the `proof_sessions.read_only` marker and
 * `proof_artifact_imports` records of `0011_artifact_imports.sql`.
 * Sessions are keyed by session ID; every other table is
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
  deletions: Map<string, ProofDeletionRecord>;
  interactionEvents: Map<string, InteractionEvent>;
  /** `proof_replay_steps` of `0010_semantic_replay_steps.sql`, keyed by step command ID. */
  replaySteps: Map<string, SemanticReplayStepRecord>;
  inquiryRecords: Map<string, InquiryRecord>;
  /** `proof_artifact_imports` of `0011_artifact_imports.sql`, keyed by the imported session. */
  artifactImports: Map<string, ProofArtifactImportRecord>;
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
  "deletions",
  "interactionEvents",
  "replaySteps",
  "inquiryRecords",
  "artifactImports",
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
    deletions: new Map(),
    interactionEvents: new Map(),
    replaySteps: new Map(),
    inquiryRecords: new Map(),
    artifactImports: new Map(),
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
        result = await work(this.instrument(guardReadOnlySessions(context.transaction)));
        context.checkDeferredConstraints();
      } catch (cause: unknown) {
        throw new ProofStoreTransactionError(
          "rolled-back",
          "The in-memory proof transaction was rolled back.",
          cause,
        );
      }
      context.commit();
      if (context.deletedSessions.size > 0) this.sessionsDeleted(context.deletedSessions);
      return result;
    } finally {
      context.close();
    }
  }

  /** Called synchronously after a commit that deleted sessions; subclasses purge their own rows. */
  protected sessionsDeleted(sessionIds: ReadonlySet<string>): void {
    void sessionIds;
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
    deletions: new Map(),
    interactionEvents: new Map(),
    replaySteps: new Map(),
    inquiryRecords: new Map(),
    artifactImports: new Map(),
  };
  /** Keys deleted by this transaction; a later insert of the same key re-stages the row. */
  private readonly deleted: { [Name in TableName]: Set<string> } = {
    sessions: new Set(),
    nodes: new Set(),
    suggestionSets: new Set(),
    previews: new Set(),
    edges: new Set(),
    events: new Set(),
    commands: new Set(),
    deletions: new Set(),
    interactionEvents: new Set(),
    replaySteps: new Set(),
    inquiryRecords: new Set(),
    artifactImports: new Set(),
  };
  private readonly locks = new Map<string, Promise<() => void>>();
  private closed = false;
  /** Sessions this transaction deleted, so the store can purge dependent rows it owns. */
  readonly deletedSessions = new Set<string>();
  readonly transaction: ProofStoreTransaction;

  constructor(
    private readonly committed: MemoryProofTables,
    private readonly acquire: (sessionId: string) => Promise<() => void>,
  ) {
    this.transaction = this.createTransaction();
  }

  checkDeferredConstraints(): void {
    this.assertOpen();
    const touchedSessions = new Set([
      ...this.staged.sessions.keys(),
      ...[...this.deleted.nodes].map(sessionOfKey),
    ]);
    for (const sessionId of touchedSessions) {
      const session = this.row("sessions", sessionId);
      if (session === undefined) continue;
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
    for (const commandKey of this.deleted.commands) {
      const sessionId = sessionOfKey(commandKey);
      const referenced = (["edges", "events"] as const).some((table) =>
        this.sessionRows(table, sessionId).some(
          (record) => memoryProofRecordKey(sessionId, record.commandId) === commandKey,
        ),
      );
      if (referenced) violation(`proof_commands: deleted command ${commandKey} is referenced.`);
    }
  }

  /** Apply every staged row synchronously, so no other transaction observes a partial commit. */
  commit(): void {
    this.assertOpen();
    for (const name of TABLE_NAMES) this.applyStaged(name);
  }

  private applyStaged<Name extends TableName>(name: Name): void {
    const target = this.committed[name] as Map<string, RowOf<Name>>;
    for (const recordKey of this.deleted[name]) target.delete(recordKey);
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
    const staged = this.staged[name].get(recordKey);
    if (staged !== undefined) return staged as RowOf<Name>;
    if (this.deleted[name].has(recordKey)) return undefined;
    return (this.committed[name] as Map<string, RowOf<Name>>).get(recordKey) as
      RowOf<Name> | undefined;
  }

  /** Delete matching session rows of one table, like `DELETE ... RETURNING id`. */
  private remove<Name extends TableName>(
    name: Name,
    sessionId: string,
    matches: (row: RowOf<Name>) => boolean,
    idOf: (row: RowOf<Name>) => string,
  ): string[] {
    const removed: string[] = [];
    for (const row of this.sessionRows(name, sessionId)) {
      if (!matches(row)) continue;
      const recordKey = memoryProofRecordKey(sessionId, idOf(row));
      this.staged[name].delete(recordKey);
      this.deleted[name].add(recordKey);
      removed.push(idOf(row));
    }
    return removed;
  }

  /** Mirrors `PostgresProofStore.deleteSession`: every row of every session-scoped table. */
  private removeSession(sessionId: string): void {
    for (const name of TABLE_NAMES) {
      const keys = new Set([...this.staged[name].keys(), ...this.committed[name].keys()]);
      for (const recordKey of keys) {
        const owner = name === "sessions" ? recordKey : sessionOfKey(recordKey);
        if (owner !== sessionId) continue;
        this.staged[name].delete(recordKey);
        this.deleted[name].add(recordKey);
      }
    }
    this.deletedSessions.add(sessionId);
  }

  /** Mirrors `PostgresProofStore.deleteProofRecords`, checking each immediate foreign key. */
  private async deleteProofRecords(
    sessionId: ProofSessionId,
    request: ProofRecordDeletionRequest,
  ): Promise<ProofRecordDeletionResult> {
    await this.lock(sessionId);
    const nodeIds = new Set<string>(request.nodeIds);
    const edgeIds = new Set<string>(request.edgeIds);
    const commandIds = new Set<string>(request.commandIds);
    const chosenPreviewIds = new Set<string>(request.chosenPreviewIds);

    const interactionEventIds = this.remove(
      "interactionEvents",
      sessionId,
      (row) =>
        nodeIds.has(row.nodeId) ||
        interactionPreviewIds(row).some((previewId) => chosenPreviewIds.has(previewId)),
      idOf,
    );
    this.removeInquiryRecords(sessionId, nodeIds);
    const eventIds = this.remove("events", sessionId, (row) => edgeIds.has(row.edgeId), idOf);
    const removedEdgeIds = this.remove("edges", sessionId, (row) => edgeIds.has(row.id), idOf);
    const removedEdges = new Set(removedEdgeIds);
    if (this.sessionRows("events", sessionId).some((event) => removedEdges.has(event.edgeId))) {
      violation("proof_events edge foreign key: a deleted edge is still referenced.");
    }
    const referencedPreviews = new Set(
      this.sessionRows("edges", sessionId).flatMap(({ previewId }) =>
        previewId === undefined ? [] : [previewId],
      ),
    );
    const previewIds = this.remove(
      "previews",
      sessionId,
      (row) =>
        (nodeIds.has(row.nodeId) || chosenPreviewIds.has(row.id)) &&
        !referencedPreviews.has(row.id),
      idOf,
    );
    this.requireUnreferenced(sessionId, "previewId", new Set(previewIds), "proof_previews");
    const suggestionSetIds = this.remove(
      "suggestionSets",
      sessionId,
      (row) => nodeIds.has(row.nodeId),
      idOf,
    );
    const removedSets = new Set(suggestionSetIds);
    if (
      this.sessionRows("previews", sessionId).some((row) => removedSets.has(row.suggestionSetId))
    ) {
      violation("proof_previews suggestion-set foreign key: a deleted set is still referenced.");
    }
    this.requireUnreferenced(sessionId, "suggestionSetId", removedSets, "proof_suggestion_sets");
    // Replayed-step records reference their step's command and node.
    this.remove(
      "replaySteps",
      sessionId,
      (row) => commandIds.has(row.commandId) || nodeIds.has(row.nodeId),
      (row) => row.commandId,
    );
    const removedCommandIds = this.remove(
      "commands",
      sessionId,
      (row) => commandIds.has(row.prepared.command.commandId),
      (row) => row.prepared.command.commandId,
    );
    const removedNodeIds = this.remove("nodes", sessionId, (row) => nodeIds.has(row.id), idOf);
    const removedNodes = new Set(removedNodeIds);
    const nodeReferenced =
      this.sessionRows("interactionEvents", sessionId).some((row) =>
        removedNodes.has(row.nodeId),
      ) ||
      this.sessionRows("inquiryRecords", sessionId).some((row) => removedNodes.has(row.nodeId)) ||
      this.sessionRows("suggestionSets", sessionId).some((row) => removedNodes.has(row.nodeId)) ||
      this.sessionRows("previews", sessionId).some((row) => removedNodes.has(row.nodeId)) ||
      (["edges", "events"] as const).some((table) =>
        this.sessionRows(table, sessionId).some(
          (row) => removedNodes.has(row.parentNodeId) || removedNodes.has(row.childNodeId),
        ),
      );
    if (nodeReferenced) violation("proof_nodes foreign key: a deleted node is still referenced.");
    const removedCommands = new Set(removedCommandIds);
    if (
      this.sessionRows("replaySteps", sessionId).some(
        (row) => removedNodes.has(row.nodeId) || removedCommands.has(row.commandId),
      )
    ) {
      violation("proof_replay_steps foreign key: a deleted command or node is still referenced.");
    }
    return {
      interactionEventIds,
      eventIds,
      edgeIds: removedEdgeIds,
      previewIds,
      suggestionSetIds,
      commandIds: removedCommandIds,
      nodeIds: removedNodeIds,
    };
  }

  /**
   * Mirrors the inquiry-record step of `PostgresProofStore.deleteProofRecords`: records that
   * reference a deleted node, then transitively every record that references a removed record.
   */
  private removeInquiryRecords(sessionId: string, nodeIds: ReadonlySet<string>): string[] {
    const doomed = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of this.sessionRows("inquiryRecords", sessionId)) {
        if (doomed.has(row.id)) continue;
        if (
          inquiryNodeIds(row).some((nodeId) => nodeIds.has(nodeId)) ||
          inquiryRecordReferenceIds(row).some((recordId) => doomed.has(recordId))
        ) {
          doomed.add(row.id);
          changed = true;
        }
      }
    }
    return this.remove("inquiryRecords", sessionId, (row) => doomed.has(row.id), idOf);
  }

  private requireUnreferenced(
    sessionId: string,
    column: "previewId" | "suggestionSetId",
    removed: ReadonlySet<string>,
    table: string,
  ): void {
    const referenced = (["edges", "events"] as const).some((name) =>
      this.sessionRows(name, sessionId).some((row) => {
        const value = row[column];
        return value !== undefined && removed.has(value);
      }),
    );
    if (referenced) violation(`${table} foreign key: a deleted row is still referenced.`);
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
              ...(session.readOnly === true ? { readOnly: true } : {}),
              ...(session.visibility === "shared" ? { visibility: "shared" } : {}),
            };
      },
      setSessionVisibility: async (sessionId, visibility) => {
        await this.lock(sessionId);
        const session = this.row("sessions", sessionId);
        if (session === undefined) return false;
        // Only the non-default `shared` is stored; absent means private.
        const next: { -readonly [Key in keyof ProofSession]: ProofSession[Key] } = { ...session };
        if (visibility === "shared") next.visibility = "shared";
        else delete next.visibility;
        this.staged.sessions.set(sessionId, Object.freeze(next));
        return true;
      },
      deleteSession: async (sessionId) => {
        await this.lock(sessionId);
        if (this.row("sessions", sessionId) === undefined) return false;
        this.removeSession(sessionId);
        return true;
      },
      markSessionReadOnly: async (sessionId) => {
        await this.lock(sessionId);
        const session = this.row("sessions", sessionId);
        if (session === undefined || session.readOnly === true) return false;
        this.staged.sessions.set(sessionId, Object.freeze({ ...session, readOnly: true }));
        return true;
      },
      listNodes: async (sessionId) =>
        this.sortedSessionRows("nodes", sessionId, idOf).map((node) => ({
          sessionId,
          nodeId: node.id,
          stateId: node.state.id,
          node,
        })),
      listSuggestionSets: async (sessionId) =>
        this.sortedSessionRows("suggestionSets", sessionId, idOf).map((suggestionSet) => ({
          sessionId,
          suggestionSetId: suggestionSet.id,
          nodeId: suggestionSet.nodeId,
          stateId: suggestionSet.stateId,
          suggestionSet,
        })),
      listPreviews: async (sessionId) => this.sortedSessionRows("previews", sessionId, idOf),
      listEvents: async (sessionId) => this.sortedSessionRows("events", sessionId, idOf),
      listCommands: async (sessionId) =>
        this.sortedSessionRows("commands", sessionId, (row) => row.prepared.command.commandId),
      listReplaySteps: async (sessionId) =>
        this.sortedSessionRows("replaySteps", sessionId, (row) => row.commandId),
      listDeletions: async (sessionId) => this.sortedSessionRows("deletions", sessionId, idOf),
      readArtifactImport: async (sessionId) =>
        this.read("artifactImports", memoryProofRecordKey(sessionId, sessionId)),
      insertArtifactImport: async (record) =>
        this.insert(
          "artifactImports",
          record.sessionId,
          memoryProofRecordKey(record.sessionId, record.sessionId),
          record,
          (row) => {
            if (!/^sha256:[0-9a-f]{64}$/.test(row.digest)) {
              violation("proof_artifact_imports check: the digest is malformed.");
            }
            const duplicate = [
              ...this.committed.artifactImports.values(),
              ...this.staged.artifactImports.values(),
            ].some(
              (existing) => existing.digest === row.digest && existing.sessionId !== row.sessionId,
            );
            if (duplicate) violation(`proof_artifact_imports unique digest: ${row.digest}.`);
          },
        ),
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
          checkEvidenceColumns("proof_edges", row);
          const duplicateChild = this.sessionRows("edges", sessionId).some(
            (existing) => existing.childNodeId === row.childNodeId,
          );
          if (duplicateChild) violation(`proof_edges unique child: ${row.childNodeId} exists.`);
          if (
            row.sequence !== undefined &&
            this.sessionRows("edges", sessionId).some(
              (existing) => existing.sequence === row.sequence,
            )
          ) {
            violation(`proof_edges unique transition sequence: ${row.sequence} exists.`);
          }
        }),
      insertEvent: async (sessionId, event) =>
        this.insert(
          "events",
          sessionId,
          memoryProofRecordKey(sessionId, event.id),
          event,
          (row) => {
            this.checkTransitionLinks(sessionId, row);
            checkEvidenceColumns("proof_events", row);
            if (
              row.sequence !== undefined &&
              this.sessionRows("events", sessionId).some(
                (existing) => existing.sequence === row.sequence,
              )
            ) {
              violation(`proof_events unique transition sequence: ${row.sequence} exists.`);
            }
            const edge = this.row("edges", memoryProofRecordKey(sessionId, row.edgeId));
            if (
              edge === undefined ||
              edge.parentNodeId !== row.parentNodeId ||
              edge.childNodeId !== row.childNodeId ||
              edge.commandId !== row.commandId
            ) {
              violation(`proof_events edge foreign key: ${row.edgeId} does not match.`);
            }
            if (
              row.evidence !== undefined &&
              (edge.evidence !== row.evidence || edge.sequence !== row.sequence)
            ) {
              violation(
                `proof_events edge evidence foreign key: ${row.edgeId} stores other evidence.`,
              );
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
      readDeletion: async (sessionId, commandId) => {
        this.assertOpen();
        const rows = this.sessionRows("deletions", sessionId);
        const found =
          rows.find((row) => row.commandId === commandId) ??
          rows
            .filter((row) => row.deletedCommandIds.includes(commandId))
            .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0];
        return found === undefined ? undefined : structuredClone(found);
      },
      deleteProofRecords: async (sessionId, request) => this.deleteProofRecords(sessionId, request),
      readReplayStep: async (sessionId, commandId) =>
        this.read("replaySteps", memoryProofRecordKey(sessionId, commandId)),
      insertReplayStep: async (sessionId, record) =>
        this.insert(
          "replaySteps",
          sessionId,
          memoryProofRecordKey(sessionId, record.commandId),
          record,
          (row) => {
            if (
              row.index < 1 ||
              row.count < row.index ||
              row.commandId !== `${row.replayCommandId}:replay:${row.index}`
            ) {
              violation("proof_replay_steps check: the step identities are inconsistent.");
            }
            if (
              this.row("commands", memoryProofRecordKey(sessionId, row.commandId)) === undefined
            ) {
              violation(`proof_replay_steps command foreign key: ${row.commandId} does not exist.`);
            }
            this.requireNode(sessionId, row.nodeId);
            if (
              this.sessionRows("replaySteps", sessionId).some(
                (existing) =>
                  existing.replayCommandId === row.replayCommandId && existing.index === row.index,
              )
            ) {
              violation(`proof_replay_steps unique step: ${row.commandId} exists.`);
            }
          },
        ),
      readInteractionEvent: async (sessionId, eventId) => {
        const event = this.read("interactionEvents", memoryProofRecordKey(sessionId, eventId));
        return event === undefined
          ? undefined
          : {
              sessionId,
              eventId: event.id,
              sequence: event.sequence,
              nodeId: event.nodeId,
              event,
            };
      },
      lastInteractionSequence: async (sessionId) => {
        await this.lock(sessionId);
        return Math.max(
          0,
          ...this.sessionRows("interactionEvents", sessionId).map(({ sequence }) => sequence),
        );
      },
      lastTransitionSequence: async (sessionId) => {
        await this.lock(sessionId);
        return Math.max(
          0,
          ...this.sessionRows("edges", sessionId).map(({ sequence }) => sequence ?? 0),
        );
      },
      insertInteractionEvent: async (sessionId, event) =>
        this.insert(
          "interactionEvents",
          sessionId,
          memoryProofRecordKey(sessionId, event.id),
          event,
          (row) => {
            if (!Number.isInteger(row.sequence) || row.sequence < 1) {
              violation("proof_interaction_events check: sequence must be positive.");
            }
            if (!INTERACTION_EVENT_KINDS.has(row.kind)) {
              violation(`proof_interaction_events_kind_check: ${String(row.kind)} is not a kind.`);
            }
            if (
              this.sessionRows("interactionEvents", sessionId).some(
                (existing) => existing.sequence === row.sequence,
              )
            ) {
              violation(`proof_interaction_events unique sequence: ${row.sequence} exists.`);
            }
            this.requireNode(sessionId, row.nodeId, row.stateId);
          },
        ),
      listInteractionEvents: async (sessionId, query) => {
        this.assertOpen();
        return this.sessionRows("interactionEvents", sessionId)
          .filter(
            (event) =>
              event.sequence > query.afterSequence &&
              (query.nodeId === undefined || event.nodeId === query.nodeId),
          )
          .sort((left, right) => left.sequence - right.sequence)
          .slice(0, query.limit)
          .map((event) => ({
            sessionId,
            eventId: event.id,
            sequence: event.sequence,
            nodeId: event.nodeId,
            event: structuredClone(event),
          }));
      },
      readInquiryRecord: async (sessionId, recordId) => {
        const record = this.read("inquiryRecords", memoryProofRecordKey(sessionId, recordId));
        return record === undefined ? undefined : inquiryReadRecord(sessionId, record);
      },
      lastInquirySequence: async (sessionId) => {
        await this.lock(sessionId);
        return Math.max(
          0,
          ...this.sessionRows("inquiryRecords", sessionId).map(({ sequence }) => sequence),
        );
      },
      insertInquiryRecord: async (sessionId, record) =>
        this.insert(
          "inquiryRecords",
          sessionId,
          memoryProofRecordKey(sessionId, record.id),
          record,
          (row) => {
            if (!Number.isInteger(row.sequence) || row.sequence < 1) {
              violation("proof_inquiry_records check: sequence must be positive.");
            }
            if (!INQUIRY_RECORD_KINDS.has(row.kind)) {
              violation(`proof_inquiry_records_kind_check: ${String(row.kind)} is not a kind.`);
            }
            if (inquiryRecordReferenceIds(row).includes(row.id)) {
              violation("proof_inquiry_records check: a record cannot reference itself.");
            }
            if (
              this.sessionRows("inquiryRecords", sessionId).some(
                (existing) => existing.sequence === row.sequence,
              )
            ) {
              violation(`proof_inquiry_records unique sequence: ${row.sequence} exists.`);
            }
            this.requireNode(sessionId, row.nodeId, row.stateId);
          },
        ),
      listInquiryRecords: async (sessionId, query) => {
        this.assertOpen();
        return this.sessionRows("inquiryRecords", sessionId)
          .filter(
            (record) =>
              record.sequence > query.afterSequence &&
              (query.nodeId === undefined || record.nodeId === query.nodeId) &&
              (query.commandId === undefined || record.commandId === query.commandId) &&
              (query.referencing === undefined ||
                inquiryRecordReferenceIds(record).includes(query.referencing)),
          )
          .sort((left, right) => left.sequence - right.sequence)
          .slice(0, query.limit)
          .map((record) => inquiryReadRecord(sessionId, structuredClone(record)));
      },
      insertDeletion: async (sessionId, deletion) =>
        this.insert(
          "deletions",
          sessionId,
          memoryProofRecordKey(sessionId, deletion.id),
          deletion,
          (row) => {
            if (
              this.sessionRows("deletions", sessionId).some(
                (existing) => existing.commandId === row.commandId,
              )
            ) {
              violation(`proof_deletions unique command: ${row.commandId} exists.`);
            }
            if (
              row.deletedNodeIds.length < 1 ||
              row.deletedEdgeIds.length !== row.deletedNodeIds.length ||
              row.deletedCommandIds.length !== row.deletedNodeIds.length ||
              row.deletedNodeIds.includes(row.parentNodeId) ||
              row.deletedCommandIds.includes(row.commandId)
            ) {
              violation("proof_deletions check: the tombstone identities are inconsistent.");
            }
            const keys = Object.keys(row);
            if (
              ["state", "node", "nodes", "edge", "edges", "event", "events"].some((key) =>
                keys.includes(key),
              )
            ) {
              violation("proof_deletions check: a tombstone cannot hold deleted snapshots.");
            }
          },
        ),
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

  /** Detached copies of a session's rows of one table, ordered by `keyOf` (like `ORDER BY`). */
  private sortedSessionRows<Name extends TableName>(
    name: Name,
    sessionId: string,
    keyOf: (row: RowOf<Name>) => string,
  ): RowOf<Name>[] {
    this.assertOpen();
    return this.sessionRows(name, sessionId)
      .map((row) => structuredClone(row) as RowOf<Name>)
      .sort((left, right) => {
        const leftKey = keyOf(left);
        const rightKey = keyOf(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
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

/** The evidence and sequence checks that `0014_transition_evidence.sql` puts on edges and events. */
function checkEvidenceColumns(
  table: "proof_edges" | "proof_events",
  row: Readonly<{ evidence?: string | undefined; sequence?: number | undefined }>,
): void {
  if ((row.evidence === undefined) !== (row.sequence === undefined)) {
    violation(
      `${table}_evidence_sequence_together: a row has both evidence and sequence or neither.`,
    );
  }
  if (row.sequence !== undefined && (!Number.isInteger(row.sequence) || row.sequence < 1)) {
    violation(`${table} check: transition_sequence must be positive.`);
  }
}

/** The `kind` check of `0007_interaction_events.sql`, as widened by migration `0008`. */
const INTERACTION_EVENT_KINDS: ReadonlySet<string> = new Set<InteractionEvent["kind"]>([
  "selection-changed",
  "suggestions-requested",
  "suggestions-displayed",
  "preview-requested",
  "preview-rejected",
  "menu-expanded",
  "focus-changed",
  "objective-changed",
  "interaction-ended-without-action",
  "preview-regenerated",
  "backtracked-with-information",
]);

/** The `kind` check of `0009_inquiry_records.sql`. */
const INQUIRY_RECORD_KINDS: ReadonlySet<string> = new Set<InquiryRecord["kind"]>([
  "question",
  "objective",
  "attempt",
  "requirement",
  "observation",
  "obstruction",
  "decision",
  "relationship",
  "status-change",
]);

/** The `referenced_node_ids` column: the anchor and every referenced proof node. */
function inquiryNodeIds(record: InquiryRecord): string[] {
  return [record.nodeId, ...inquiryRecordNodeIds(record)];
}

function inquiryReadRecord(sessionId: string, record: InquiryRecord): unknown {
  return {
    sessionId,
    recordId: record.id,
    sequence: record.sequence,
    commandId: record.commandId,
    nodeId: record.nodeId,
    record,
  };
}

/** The preview IDs an interaction event names (`preview_id` and `stale_preview_id`). */
function interactionPreviewIds(event: InteractionEvent): string[] {
  if (event.kind === "preview-rejected") return [event.previewId];
  if (event.kind === "preview-regenerated") return [event.previewId, event.stalePreviewId];
  return [];
}

function idOf(row: Readonly<{ id: string }>): string {
  return row.id;
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
