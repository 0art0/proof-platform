import { describe, expect, it } from "vitest";
import { extractDerivedResult, libraryResultSchema, type LibraryResult } from "@proof/library";
import { createProofNodeSchema, type ProofNode } from "@proof/protocol";
import {
  addLibraryArtifact,
  listLibrary,
  listLibraryOperators,
  readAdditionEvents,
  readBackgroundRevisions,
  registerLibraryOperator,
  reviseBackground,
  type LibraryStore,
} from "./library-repository";
import { MemoryLibraryStore } from "./memory-library-store";
import { MemoryProofStoreConstraintError } from "./memory-proof-store";
import { PostgresLibraryStore } from "./postgres-library-store";
import type { SqlClient, SqlPool, SqlQueryResult } from "./postgres-proof-store";
import { initializeProofSession, loadCurrentProofSession } from "./proof-repository";

const SESSION = "session:one";
const AT = "2026-09-26T00:00:00.000Z";
const background = {
  level: "undergraduate",
  summary: "Elementary logic.",
  assumptions: [],
  domains: ["logic"],
  maximumLevel: "undergraduate",
} as const;
const widened = { ...background, domains: ["logic", "analysis"], maximumLevel: "graduate" };
const metadata = {
  problem: { title: "Excluded middle", statement: "Show p or not p." },
  background,
  libraryLayerIds: ["layer:global"],
};

const rootNode: ProofNode = createProofNodeSchema().parse({
  id: "node:root",
  state: {
    id: "state:root",
    goals: [
      {
        id: "goal:main",
        sequent: {
          context: { declarations: [], hypotheses: [] },
          conclusion: { expression: "True" },
        },
      },
    ],
    obligations: [],
  },
});

function result(id: string, overrides: Record<string, unknown> = {}): LibraryResult {
  return libraryResultSchema.parse({
    kind: "result",
    id,
    name: "Test result",
    description: "A test-only result.",
    renderings: { latex: "p", naturalLanguage: "p" },
    classification: { domains: ["logic"], level: "foundational" },
    provenance: { kind: "curated", source: "unit test" },
    approval: { status: "approved", reviewerId: "reviewer:test" },
    layer: "proof-time-background",
    related: [],
    priority: 1,
    parameters: [
      {
        id: "declaration:p",
        symbol: "p",
        sort: { kind: "proposition" },
        role: "universal-parameter",
      },
    ],
    statement: { expression: ["Or", "p", ["Not", "p"]] },
    premises: [],
    sideConditions: [],
    applicationDirections: ["backward"],
    patterns: [
      {
        id: "pattern:test",
        expression: ["Or", "p", ["Not", "p"]],
        direction: "backward",
        requirement: { section: "goal", polarity: "any", role: "proposition" },
      },
    ],
    ...overrides,
  });
}

const analysis = { classification: { domains: ["analysis"], level: "graduate" } };

function addition(id: string, artifact: LibraryResult, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: SESSION,
    occurredAt: AT,
    layer: artifact.layer,
    origin: { kind: "user", actorId: "user:reader" },
    artifact,
    ...overrides,
  };
}

function divides(id = "operator:divides", symbol = "Divides") {
  const nat = { kind: "named", id: "sort:nat" };
  return {
    operator: {
      id,
      symbol,
      signature: { parameters: [nat, nat], result: { kind: "proposition" } },
    },
    reviewerId: "reviewer:core",
    registeredAt: AT,
  };
}

/**
 * A fake PostgreSQL client that interprets exactly the statements `PostgresLibraryStore` issues,
 * over plain in-process tables, with BEGIN/COMMIT/ROLLBACK snapshots.
 */
class FakeLibrarySqlClient implements SqlClient {
  readonly calls: string[] = [];
  failCommit = false;
  private tables = FakeLibrarySqlClient.empty();
  private snapshot: typeof this.tables | undefined;

  private static empty() {
    return {
      sessions: new Map<string, { operators: unknown; metadata: unknown }>(),
      nodes: new Set<string>(),
      events: [] as { scope: string; id: string; sequence: number; record: unknown }[],
      artifacts: [] as {
        scope: string;
        sessionId: string | null;
        id: string;
        eventId: string;
        sequence: number;
        record: unknown;
      }[],
      revisions: [] as { sessionId: string; id: string; sequence: number; record: unknown }[],
      operators: [] as { id: string; symbol: string; record: unknown }[],
    };
  }

  seedSession(id: string, sessionMetadata: unknown, nodeIds: readonly string[]): void {
    this.tables.sessions.set(id, { operators: [], metadata: sessionMetadata });
    nodeIds.forEach((nodeId) => this.tables.nodes.add(`${id}\u0000${nodeId}`));
  }

  metadataOf(id: string): unknown {
    return this.tables.sessions.get(id)?.metadata;
  }

  async query(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult> {
    const sql = text.replace(/\s+/g, " ").trim();
    this.calls.push(sql);
    const [a, b, c, d, e, , , h] = values as unknown[];
    const t = this.tables;
    const rows = (list: readonly Record<string, unknown>[]) => ({
      rows: list,
      rowCount: list.length,
    });
    const json = (value: unknown) => JSON.parse(String(value)) as unknown;
    if (sql === "BEGIN") {
      this.snapshot = structuredClone(t);
      return rows([]);
    }
    if (sql === "COMMIT") {
      if (this.failCommit) throw new Error("commit failed");
      return rows([]);
    }
    if (sql === "ROLLBACK") {
      if (this.snapshot !== undefined) this.tables = this.snapshot;
      return rows([]);
    }
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return rows([]);
    if (sql.startsWith("SELECT operators, metadata FROM proof_sessions")) {
      const session = t.sessions.get(String(a));
      return rows(session === undefined ? [] : [structuredClone(session)]);
    }
    if (sql.startsWith("SELECT 1 FROM proof_nodes")) {
      return rows(t.nodes.has(`${String(a)}\u0000${String(b)}`) ? [{ exists: 1 }] : []);
    }
    if (sql.startsWith("SELECT record FROM library_addition_events WHERE scope_key = $1 AND id")) {
      return rows(t.events.filter((row) => row.scope === a && row.id === b));
    }
    if (sql.startsWith("SELECT record FROM library_addition_events")) {
      return rows(
        t.events.filter((row) => row.scope === a).sort((x, y) => x.sequence - y.sequence),
      );
    }
    if (sql.startsWith("SELECT record FROM library_artifacts")) {
      return rows(t.artifacts.filter((row) => row.scope === a && row.id === b));
    }
    if (sql.startsWith("SELECT session_id, event_id, sequence, record FROM library_artifacts")) {
      return rows(
        t.artifacts
          .filter((row) => row.scope === a)
          .sort((x, y) => x.sequence - y.sequence)
          .map((row) => ({
            session_id: row.sessionId,
            event_id: row.eventId,
            sequence: String(row.sequence),
            record: row.record,
          })),
      );
    }
    if (sql.startsWith("INSERT INTO library_addition_events")) {
      if (t.events.some((row) => row.scope === a && (row.id === c || row.sequence === d))) {
        throw new Error("duplicate key value violates unique constraint");
      }
      t.events.push({ scope: String(a), id: String(c), sequence: Number(d), record: json(h) });
      return rows([]);
    }
    if (sql.startsWith("INSERT INTO library_artifacts")) {
      t.artifacts.push({
        scope: String(a),
        sessionId: b === null ? null : String(b),
        id: String(c),
        eventId: String(e),
        sequence: Number(values[5]),
        record: json(h),
      });
      return rows([]);
    }
    if (sql.startsWith("SELECT record FROM library_background_revisions")) {
      return rows(
        t.revisions.filter((row) => row.sessionId === a).sort((x, y) => x.sequence - y.sequence),
      );
    }
    if (sql.startsWith("INSERT INTO library_background_revisions")) {
      t.revisions.push({
        sessionId: String(a),
        id: String(b),
        sequence: Number(c),
        record: json(d),
      });
      return rows([]);
    }
    if (sql.startsWith("UPDATE proof_sessions SET metadata")) {
      const session = t.sessions.get(String(a));
      if (session === undefined) return { rows: [], rowCount: 0 };
      session.metadata = json(b);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT record FROM library_operators")) {
      return rows([...t.operators].sort((x, y) => (x.symbol < y.symbol ? -1 : 1)));
    }
    if (sql.startsWith("INSERT INTO library_operators")) {
      if (t.operators.some((row) => row.id === a || row.symbol === b)) {
        throw new Error("duplicate key value violates unique constraint");
      }
      t.operators.push({ id: String(a), symbol: String(b), record: json(c) });
      return rows([]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }

  release(): void {}
}

type Harness = Readonly<{
  store: LibraryStore;
  background: () => Promise<unknown>;
}>;

async function memoryHarness(): Promise<Harness> {
  const store = new MemoryLibraryStore();
  const initialized = await initializeProofSession(store, {
    sessionId: SESSION,
    rootNode,
    metadata,
  });
  expect(initialized.status).toBe("committed");
  return {
    store,
    background: async () => {
      const loaded = await loadCurrentProofSession(store, SESSION);
      return loaded.status === "loaded" ? loaded.session.metadata?.background : undefined;
    },
  };
}

async function postgresHarness(): Promise<Harness> {
  const client = new FakeLibrarySqlClient();
  client.seedSession(SESSION, structuredClone(metadata), ["node:root"]);
  const pool: SqlPool = { connect: async () => client };
  return {
    store: new PostgresLibraryStore(pool),
    background: async () => (client.metadataOf(SESSION) as typeof metadata).background,
  };
}

describe.each([
  ["memory", memoryHarness],
  ["postgres (fake SQL client)", postgresHarness],
])("library repository against the %s store", (_name, harness) => {
  it("records an out-of-background rejection, then admits after a recorded revision", async () => {
    const { store, background: currentBackground } = await harness();
    const outside = result("result:analysis", analysis);

    const rejected = await addLibraryArtifact(store, addition("addition:1", outside));
    expect(rejected).toMatchObject({
      status: "recorded",
      admitted: false,
      event: {
        sequence: 0,
        admission: {
          decision: "rejected",
          diagnostics: [{ code: "domain-outside-background" }, { code: "level-above-background" }],
        },
      },
    });
    expect(await listLibrary(store, { sessionId: SESSION })).toEqual({
      status: "found",
      artifacts: [],
    });

    const stale = await reviseBackground(store, SESSION, {
      id: "revision:stale",
      occurredAt: AT,
      previous: widened,
      revised: background,
      reason: "Wrong starting point.",
      actor: { kind: "user", id: "user:reader" },
    });
    expect(stale).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "stale-background" }],
    });

    const revision = {
      id: "revision:1",
      occurredAt: AT,
      previous: background,
      revised: widened,
      reason: "The reader knows graduate analysis.",
      actor: { kind: "user", id: "user:reader" },
    };
    const revised = await reviseBackground(store, SESSION, revision);
    expect(revised).toMatchObject({
      status: "recorded",
      replayed: false,
      event: { sequence: 0, sessionId: SESSION },
      metadata: { background: widened },
    });
    expect(await currentBackground()).toEqual(widened);
    expect(await reviseBackground(store, SESSION, revision)).toMatchObject({ replayed: true });
    expect(await readBackgroundRevisions(store, SESSION)).toMatchObject({
      status: "found",
      revisions: [{ id: "revision:1" }],
    });

    const admitted = await addLibraryArtifact(store, addition("addition:2", outside));
    expect(admitted).toMatchObject({ status: "recorded", admitted: true, event: { sequence: 1 } });
    const listed = await listLibrary(store, { sessionId: SESSION });
    expect(listed.status === "found" && listed.artifacts.map(({ id }) => id)).toEqual([
      "result:analysis",
    ]);
    expect(listed.status === "found" && Object.isFrozen(listed.artifacts)).toBe(true);

    const events = await readAdditionEvents(store, SESSION);
    expect(
      events.status === "found" &&
        events.events.map(({ id, admission }) => [id, admission.decision]),
    ).toEqual([
      ["addition:1", "rejected"],
      ["addition:2", "admitted"],
    ]);
  });

  it("replays identical additions and rejects conflicting IDs", async () => {
    const { store } = await harness();
    const artifact = result("result:lem");
    expect(await addLibraryArtifact(store, addition("addition:1", artifact))).toMatchObject({
      admitted: true,
      replayed: false,
    });
    expect(await addLibraryArtifact(store, addition("addition:1", artifact))).toMatchObject({
      admitted: true,
      replayed: true,
    });
    expect(
      await addLibraryArtifact(
        store,
        addition("addition:1", artifact, { origin: { kind: "agent", actorId: "agent:one" } }),
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "event-id-conflict" }] });
    expect(await addLibraryArtifact(store, addition("addition:2", artifact))).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "artifact-id-conflict" }],
    });
    expect(
      await addLibraryArtifact(
        store,
        addition("addition:3", artifact, { sessionId: "session:none" }),
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "session-not-found" }] });
    expect(
      await addLibraryArtifact(store, addition("addition:4", artifact, { layer: "derived" })),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "invalid-request" }] });
  });

  it("admits derived results only with provenance to an existing proof node", async () => {
    const { store } = await harness();
    const extract = (proofNodeId: string, id: string) => {
      const extraction = extractDerivedResult({
        sessionId: SESSION,
        proofNodeId,
        id,
        name: "Derived excluded middle",
        context: {
          declarations: [
            {
              id: "declaration:q",
              symbol: "q",
              sort: { kind: "proposition" },
              role: "universal-parameter",
            },
          ],
          hypotheses: [],
        },
        conclusion: { expression: ["Or", "q", ["Not", "q"]] },
        usedHypothesisIds: [],
        classification: { domains: ["logic"], level: "foundational" },
        renderings: { latex: "q\\lor\\neg q", naturalLanguage: "q or not q" },
        approval: { status: "draft" },
      } as unknown as Parameters<typeof extractDerivedResult>[0]);
      if (!extraction.ok) throw new Error(extraction.diagnostics[0].message);
      return extraction.result;
    };
    expect(
      await addLibraryArtifact(
        store,
        addition("addition:1", extract("node:root", "result:derived"), {
          origin: { kind: "derived" },
        }),
      ),
    ).toMatchObject({ admitted: true });
    expect(
      await addLibraryArtifact(store, addition("addition:2", extract("node:gone", "result:gone"))),
    ).toMatchObject({
      admitted: false,
      event: { admission: { diagnostics: [{ code: "derived-node-not-found" }] } },
    });
    expect(
      await addLibraryArtifact(
        store,
        addition("addition:3", result("result:claimed", { layer: "derived" })),
      ),
    ).toMatchObject({
      admitted: false,
      event: { admission: { diagnostics: [{ code: "derived-provenance-required" }] } },
    });
  });

  it("lists global and session layers in deterministic layer and addition order", async () => {
    const { store } = await harness();
    const add = async (id: string, artifact: LibraryResult, sessionId: string | undefined) => {
      const outcome = await addLibraryArtifact(
        store,
        addition(id, artifact, sessionId === undefined ? { sessionId: undefined } : {}),
      );
      expect(outcome).toMatchObject({ admitted: true });
    };
    await add("addition:b", result("result:b"), SESSION);
    await add(
      "addition:draft",
      result("result:draft", { layer: "move-discovery-draft", approval: { status: "draft" } }),
      SESSION,
    );
    await add("addition:initial", result("result:initial", { layer: "initial-problem" }), SESSION);
    await add("addition:a", result("result:a"), SESSION);
    await add("addition:global", result("result:global", { layer: "global" }), undefined);

    const all = await listLibrary(store, { sessionId: SESSION });
    expect(all.status === "found" && all.artifacts.map(({ id }) => id)).toEqual([
      "result:global",
      "result:initial",
      "result:b",
      "result:a",
      "result:draft",
    ]);
    const filtered = await listLibrary(store, {
      sessionId: SESSION,
      layers: ["global", "move-discovery-draft"],
    });
    expect(filtered.status === "found" && filtered.artifacts.map(({ id }) => id)).toEqual([
      "result:global",
      "result:draft",
    ]);
    const globalOnly = await listLibrary(store, {});
    expect(globalOnly.status === "found" && globalOnly.artifacts.map(({ id }) => id)).toEqual([
      "result:global",
    ]);
    expect(await readAdditionEvents(store)).toMatchObject({
      status: "found",
      events: [{ id: "addition:global", sequence: 0 }],
    });
    expect(
      await addLibraryArtifact(
        store,
        addition("addition:shadow", result("result:global", { layer: "initial-problem" })),
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "artifact-id-conflict" }] });
  });

  it("registers approved operators globally with unique symbols", async () => {
    const { store } = await harness();
    expect(await registerLibraryOperator(store, divides())).toMatchObject({
      status: "registered",
      replayed: false,
    });
    expect(await registerLibraryOperator(store, divides())).toMatchObject({ replayed: true });
    expect(await registerLibraryOperator(store, divides("operator:other"))).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "operator-symbol-conflict" }],
    });
    expect(
      await registerLibraryOperator(store, divides("operator:divides", "DividesAlso")),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "operator-id-conflict" }] });
    expect(await registerLibraryOperator(store, divides("operator:apart", "Apart"))).toMatchObject({
      status: "registered",
    });
    const listed = await listLibraryOperators(store);
    expect(
      listed.status === "found" && listed.registrations.map(({ operator }) => operator.symbol),
    ).toEqual(["Apart", "Divides"]);
  });
});

describe("memory library store constraints", () => {
  it("enforces the operator symbol uniqueness constraint and rolls back", async () => {
    const store = new MemoryLibraryStore();
    const [first, second] = [divides(), divides("operator:other")];
    const error = await store
      .libraryTransaction(async (transaction) => {
        await transaction.insertLibraryOperator(first as never);
        await transaction.insertLibraryOperator(second as never);
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ outcome: "rolled-back" });
    expect((error as { cause: unknown }).cause).toBeInstanceOf(MemoryProofStoreConstraintError);
    expect(await listLibraryOperators(store)).toEqual({ status: "found", registrations: [] });
  });

  it("rejects artifact rows without a matching admitted event", async () => {
    const { store } = await memoryHarness();
    const artifact = result("result:lem");
    const outcome = await addLibraryArtifact(store, addition("addition:1", artifact));
    if (outcome.status !== "recorded") throw new Error("expected a recorded addition");
    const error = await (store as MemoryLibraryStore)
      .libraryTransaction(async (transaction) => {
        await transaction.insertLibraryArtifact({
          ...outcome.event,
          id: "addition:missing",
        } as typeof outcome.event);
      })
      .catch((caught: unknown) => caught);
    expect((error as { cause: unknown }).cause).toBeInstanceOf(MemoryProofStoreConstraintError);
  });
});

describe("PostgresLibraryStore", () => {
  it("locks the session row and reports an unconfirmed commit as uncertain", async () => {
    const client = new FakeLibrarySqlClient();
    client.seedSession(SESSION, structuredClone(metadata), ["node:root"]);
    const store = new PostgresLibraryStore({ connect: async () => client });
    client.failCommit = true;
    expect(await addLibraryArtifact(store, addition("addition:1", result("result:lem")))).toEqual({
      status: "uncertain",
      diagnostics: [expect.objectContaining({ code: "commit-unknown" })],
    });
    expect(client.calls).toContain(
      "SELECT operators, metadata FROM proof_sessions WHERE id = $1 FOR UPDATE",
    );
  });

  it("rolls back a failed statement without recording anything", async () => {
    const client = new FakeLibrarySqlClient();
    const store = new PostgresLibraryStore({ connect: async () => client });
    expect(await registerLibraryOperator(store, divides())).toMatchObject({ status: "registered" });
    const error = await store
      .libraryTransaction(async (transaction) => {
        await transaction.insertLibraryOperator(divides("operator:apart", "Apart") as never);
        await transaction.insertLibraryOperator(divides("operator:x") as never);
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ outcome: "rolled-back" });
    expect(client.calls.at(-1)).toBe("ROLLBACK");
    const listed = await listLibraryOperators(store);
    expect(listed.status === "found" && listed.registrations.length).toBe(1);
  });
});
