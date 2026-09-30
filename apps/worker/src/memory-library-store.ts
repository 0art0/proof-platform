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
import {
  MemoryProofStore,
  MemoryProofStoreConstraintError,
  memoryProofRecordKey,
} from "./memory-proof-store";
import {
  ProofStoreTransactionError,
  type ProofStoreTransaction,
  type ProofSession,
} from "./proof-repository";

const LIBRARY_LAYERS = new Set([
  "global",
  "initial-problem",
  "proof-time-background",
  "derived",
  "move-discovery-draft",
]);

type ArtifactRow = StoredLibraryArtifactRow & Readonly<{ layer: string; decision: string }>;

type LibraryTables = {
  events: Map<string, LibraryAdditionEvent>;
  artifacts: Map<string, ArtifactRow>;
  revisions: Map<string, BackgroundRevisionEvent>;
  operators: Map<string, LibraryOperatorRegistration>;
  sessionMetadata: Map<string, ProofSessionMetadata>;
};

const emptyTables = (): LibraryTables => ({
  events: new Map(),
  artifacts: new Map(),
  revisions: new Map(),
  operators: new Map(),
  sessionMetadata: new Map(),
});

/**
 * The in-memory proof store plus the library tables of `migrations/0005_library.sql`.
 *
 * It shares session and node rows with the proof store, because the library references sessions,
 * checks derived-result proof nodes, and revises `proof_sessions.metadata`. Proof and library
 * transactions are serialized by one store-wide lock, so a background revision can never be lost
 * to a concurrent proof command that rewrites the same session row. Library transactions are
 * all-or-nothing, and the primary-key, unique, check and foreign-key constraints of 0004 are
 * enforced as PostgreSQL would.
 */
export class MemoryLibraryStore extends MemoryProofStore implements LibraryStore {
  private readonly library: LibraryTables = emptyTables();
  private exclusive: Promise<void> = Promise.resolve();

  override async transaction<Result>(
    work: (transaction: ProofStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.serialized(() => super.transaction(work));
  }

  async libraryTransaction<Result>(
    work: (transaction: LibraryStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.serialized(async () => {
      const staged = emptyTables();
      let result: Result;
      try {
        result = await work(this.createTransaction(staged));
      } catch (cause: unknown) {
        throw new ProofStoreTransactionError(
          "rolled-back",
          "The in-memory library transaction was rolled back.",
          cause,
        );
      }
      this.commit(staged);
      return result;
    });
  }

  /** Session deletion removes the session-scoped library rows (`ON DELETE CASCADE` in SQL). */
  protected override sessionsDeleted(sessionIds: ReadonlySet<string>): void {
    for (const table of [this.library.events, this.library.artifacts, this.library.revisions]) {
      for (const [key, row] of table as Map<string, Readonly<{ sessionId?: string | null }>>) {
        if (
          row.sessionId !== undefined &&
          row.sessionId !== null &&
          sessionIds.has(row.sessionId)
        ) {
          table.delete(key);
        }
      }
    }
  }

  private async serialized<Result>(work: () => Promise<Result>): Promise<Result> {
    const previous = this.exclusive;
    let release: () => void = () => undefined;
    this.exclusive = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private commit(staged: LibraryTables): void {
    for (const name of ["events", "artifacts", "revisions", "operators"] as const) {
      const target = this.library[name] as Map<string, unknown>;
      for (const [key, row] of staged[name]) target.set(key, row);
    }
    for (const [sessionId, metadata] of staged.sessionMetadata) {
      const session = this.tables.sessions.get(sessionId);
      if (session !== undefined) {
        this.tables.sessions.set(sessionId, Object.freeze({ ...session, metadata }));
      }
    }
  }

  private createTransaction(staged: LibraryTables): LibraryStoreTransaction {
    const row = <Name extends keyof LibraryTables>(name: Name, key: string) =>
      (staged[name] as Map<string, unknown>).get(key) ??
      (this.library[name] as Map<string, unknown>).get(key);
    const rows = <Name extends Exclude<keyof LibraryTables, "sessionMetadata">>(name: Name) => {
      const merged = new Map([...this.library[name], ...staged[name]] as [string, unknown][]);
      return [...merged.values()] as (LibraryTables[Name] extends Map<string, infer Row>
        ? Row
        : never)[];
    };
    const session = (sessionId: string): ProofSession | undefined => {
      const committed = this.tables.sessions.get(sessionId);
      const metadata = staged.sessionMetadata.get(sessionId);
      return committed === undefined || metadata === undefined
        ? committed
        : { ...committed, metadata };
    };
    const requireSession = (sessionId: string | undefined, table: string) => {
      if (sessionId !== undefined && session(sessionId) === undefined) {
        violation(`${table} session foreign key: session ${sessionId} does not exist.`);
      }
    };
    const scopeRows = <Row extends Readonly<{ sessionId?: string | null | undefined }>>(
      values: readonly Row[],
      sessionId: string | undefined,
    ) => values.filter((value) => (value.sessionId ?? undefined) === sessionId);

    return {
      lockLibrarySession: async (sessionId): Promise<LibrarySessionRow | undefined> => {
        const found = session(sessionId);
        return found === undefined
          ? undefined
          : jsonRow({
              operators: found.operators,
              metadata: found.metadata ?? null,
              readOnly: found.readOnly === true,
            });
      },
      lockGlobalLibrary: async () => undefined,
      proofNodeExists: async (sessionId, nodeId) =>
        this.tables.nodes.has(memoryProofRecordKey(sessionId, nodeId)),
      readAdditionEvent: async (sessionId, eventId) =>
        copy(row("events", recordKey(libraryScopeKey(sessionId), eventId))),
      listAdditionEvents: async (sessionId) =>
        scopeRows(rows("events"), sessionId)
          .sort((left, right) => left.sequence - right.sequence)
          .map(copy),
      readLibraryArtifact: async (sessionId, artifactId) => {
        const found = row("artifacts", recordKey(libraryScopeKey(sessionId), artifactId)) as
          ArtifactRow | undefined;
        return copy(found?.artifact);
      },
      listLibraryArtifacts: async (sessionId) =>
        scopeRows(rows("artifacts"), sessionId)
          .sort(
            (left, right) =>
              left.sequence - right.sequence || compareStrings(artifactId(left), artifactId(right)),
          )
          .map(({ sessionId: rowSession, eventId, sequence, artifact }) =>
            copy({ sessionId: rowSession, eventId, sequence, artifact }),
          ),
      insertAdditionEvent: async (event) => {
        const scope = libraryScopeKey(event.sessionId);
        requireSession(event.sessionId, "library_addition_events");
        if (!LIBRARY_LAYERS.has(event.layer)) violation("library_addition_events layer check.");
        if ((event.layer === "global") !== (event.sessionId === undefined)) {
          violation("library_addition_events scope check: only global events lack a session.");
        }
        if (!Number.isInteger(event.sequence) || event.sequence < 0) {
          violation("library_addition_events sequence check.");
        }
        if (
          event.artifact.layer !== event.layer ||
          !sameJson(event.artifact.classification, event.classification) ||
          !sameJson(event.artifact.approval, event.approval)
        ) {
          violation("library_addition_events record check: the event must restate its artifact.");
        }
        const key = recordKey(scope, event.id);
        if (row("events", key) !== undefined) {
          violation(`library_addition_events primary key: duplicate ${key}.`);
        }
        if (
          scopeRows(rows("events"), event.sessionId).some(
            (existing) => existing.sequence === event.sequence,
          )
        ) {
          violation(`library_addition_events unique sequence: ${event.sequence} in ${scope}.`);
        }
        staged.events.set(key, jsonRow(event));
      },
      insertLibraryArtifact: async (event) => {
        const scope = libraryScopeKey(event.sessionId);
        requireSession(event.sessionId, "library_artifacts");
        const recorded = row("events", recordKey(scope, event.id)) as
          LibraryAdditionEvent | undefined;
        if (
          recorded === undefined ||
          recorded.artifact.id !== event.artifact.id ||
          recorded.layer !== event.layer ||
          recorded.sequence !== event.sequence ||
          recorded.admission.decision !== "admitted" ||
          event.admission.decision !== "admitted"
        ) {
          violation(
            `library_artifacts event foreign key: ${event.id} is not a matching admission.`,
          );
        }
        const key = recordKey(scope, event.artifact.id);
        if (row("artifacts", key) !== undefined) {
          violation(`library_artifacts primary key: duplicate ${key}.`);
        }
        staged.artifacts.set(
          key,
          jsonRow({
            sessionId: event.sessionId ?? null,
            eventId: event.id,
            sequence: event.sequence,
            layer: event.layer,
            decision: event.admission.decision,
            artifact: event.artifact,
          }),
        );
      },
      listBackgroundRevisions: async (sessionId) =>
        rows("revisions")
          .filter((revision) => revision.sessionId === sessionId)
          .sort((left, right) => left.sequence - right.sequence)
          .map(copy),
      insertBackgroundRevision: async (event) => {
        requireSession(event.sessionId, "library_background_revisions");
        const key = recordKey(event.sessionId, event.id);
        if (row("revisions", key) !== undefined) {
          violation(`library_background_revisions primary key: duplicate ${key}.`);
        }
        if (
          rows("revisions").some(
            (existing) =>
              existing.sessionId === event.sessionId && existing.sequence === event.sequence,
          )
        ) {
          violation(`library_background_revisions unique sequence: ${event.sequence}.`);
        }
        if (sameJson(event.previous, event.revised)) {
          violation("library_background_revisions check: a revision must change the profile.");
        }
        staged.revisions.set(key, jsonRow(event));
      },
      updateSessionMetadata: async (sessionId, metadata) => {
        if (session(sessionId) === undefined) return false;
        staged.sessionMetadata.set(sessionId, jsonRow(metadata));
        return true;
      },
      listLibraryOperators: async () =>
        rows("operators")
          .sort((left, right) => compareStrings(left.operator.symbol, right.operator.symbol))
          .map(copy),
      insertLibraryOperator: async (registration) => {
        const { id, symbol } = registration.operator;
        if (row("operators", id) !== undefined) {
          violation(`library_operators primary key: duplicate ${id}.`);
        }
        if (rows("operators").some((existing) => existing.operator.symbol === symbol)) {
          violation(`library_operators unique symbol: ${symbol} is already registered.`);
        }
        staged.operators.set(id, jsonRow(registration));
      },
    };
  }
}

function recordKey(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

function artifactId(row: StoredLibraryArtifactRow): string {
  const { artifact } = row;
  return typeof artifact === "object" && artifact !== null && "id" in artifact
    ? String(artifact.id)
    : "";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** JSONB equality: object key order is irrelevant. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function violation(message: string): never {
  throw new MemoryProofStoreConstraintError(message);
}

function copy<Value>(value: Value): Value {
  return value === undefined ? value : (structuredClone(value) as Value);
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
