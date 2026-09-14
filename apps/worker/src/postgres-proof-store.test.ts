import { describe, expect, it } from "vitest";
import {
  proofNodeSchema,
  type DisplayedSuggestionSet,
  type MovePreview,
  type MovePreviewId,
  type ProofEdge,
  type ProofNode,
  type SuggestionSetId,
  type TransitionEvent,
} from "@proof/protocol";
import {
  PostgresProofStore,
  type SqlClient,
  type SqlPool,
  type SqlQueryResult,
} from "./postgres-proof-store";
import {
  ProofStoreTransactionError,
  proofSessionSchema,
  type ProofSessionId,
} from "./proof-repository";

type QueryCall = Readonly<{ text: string; values: readonly unknown[] | undefined }>;

class RecordingClient implements SqlClient {
  calls: QueryCall[] = [];
  releases: (Error | boolean | undefined)[] = [];
  failOn: "BEGIN" | "COMMIT" | "ROLLBACK" | undefined;
  failureCause: unknown = new Error("forced control-statement failure");

  async query(text: string, values?: readonly unknown[]): Promise<SqlQueryResult> {
    this.calls.push({ text, values });
    const normalized = text.trim();
    if (this.failOn !== undefined && normalized === this.failOn) {
      throw this.failureCause;
    }
    if (text.includes("FROM proof_sessions")) {
      return {
        rows: [
          {
            id: "session:one",
            root_node_id: "node:root",
            current_node_id: "node:root",
            operators: [],
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("FROM proof_nodes")) {
      return {
        rows: [
          {
            session_id: "session:one",
            id: "node:root",
            state_id: "state:root",
            state: rootNode().state,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("FROM proof_commands")) {
      return { rows: [{ result: { ok: true } }], rowCount: 1 };
    }
    if (text.includes("FROM proof_suggestion_sets")) {
      return {
        rows: [
          {
            session_id: "session:one",
            id: "suggestion-set:one",
            node_id: "node:root",
            state_id: "state:root",
            record: { id: "suggestion-set:one" },
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("FROM proof_previews")) {
      return { rows: [{ record: { id: "preview:one" } }], rowCount: 1 };
    }
    if (text.includes("FROM proof_edges")) {
      return {
        rows: [
          {
            session_id: "session:one",
            id: "edge:one",
            parent_node_id: "node:root",
            child_node_id: "node:child",
            command_id: "command:one",
            suggestion_set_id: "suggestion-set:one",
            chosen_suggestion_id: "suggestion:one",
            preview_id: "preview:one",
            record: { id: "edge:one" },
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: text.includes("UPDATE proof_sessions") ? 1 : 0 };
  }

  release(error?: Error | boolean): void {
    this.releases.push(error);
  }
}

function poolFor(client: RecordingClient): SqlPool {
  return { connect: async () => client };
}

function rootNode() {
  return proofNodeSchema.parse({
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
}

const sessionId = "session:one" as ProofSessionId;

describe("PostgresProofStore", () => {
  it("uses one client, locks before reads, commits, and releases unconditionally", async () => {
    const client = new RecordingClient();
    const store = new PostgresProofStore(poolFor(client));

    const result = await store.transaction(async (transaction) => {
      const session = await transaction.lockSession(sessionId);
      const node = await transaction.readNode(sessionId, rootNode().id);
      const previous = await transaction.readCommand(
        sessionId,
        "command:one" as Parameters<typeof transaction.readCommand>[1],
      );
      return { session, node, previous };
    });

    expect(result).toMatchObject({
      session: { id: "session:one", currentNodeId: "node:root" },
      node: {
        sessionId: "session:one",
        nodeId: "node:root",
        stateId: "state:root",
        node: { id: "node:root" },
      },
      previous: { ok: true },
    });
    expect(client.calls.map(({ text }) => text.trim().split(/\s+/)[0])).toEqual([
      "BEGIN",
      "SELECT",
      "SELECT",
      "SELECT",
      "COMMIT",
    ]);
    expect(client.calls[1]?.text).toContain("FOR UPDATE");
    expect(client.releases).toEqual([undefined]);
  });

  it("keeps identifiers and JSONB payloads in parameters", async () => {
    const client = new RecordingClient();
    const store = new PostgresProofStore(poolFor(client));
    const session = proofSessionSchema.parse({
      id: "session:one",
      rootNodeId: "node:root",
      currentNodeId: "node:root",
      operators: [],
    });

    await store.transaction(async (transaction) => {
      await transaction.insertSession(session);
      await transaction.insertNode(session.id, rootNode());
      expect(
        await transaction.advanceCurrentNode(
          session.id,
          rootNode().id,
          "node:child" as ProofNode["id"],
        ),
      ).toBe(true);
    });

    const inserts = client.calls.filter(({ text }) => text.includes("INSERT INTO"));
    expect(inserts).toHaveLength(2);
    for (const call of inserts) {
      expect(call.text).not.toContain("session:one");
      expect(call.text).toMatch(/\$1/);
    }
    expect(inserts[0]?.values).toEqual(["session:one", "node:root", "node:root", "[]"]);
    expect(inserts[1]?.values?.[3]).toBe(JSON.stringify(rootNode().state));
    const update = client.calls.find(({ text }) => text.includes("UPDATE proof_sessions"));
    expect(update?.values).toEqual(["session:one", "node:root", "node:child"]);
  });

  it("reads and inserts suggestion evidence with snapshot identities in parameters", async () => {
    const client = new RecordingClient();
    const store = new PostgresProofStore(poolFor(client));
    const suggestionSet = {
      id: "suggestion-set:one",
      nodeId: "node:root",
      stateId: "state:root",
      selection: {},
      suggestions: [],
      variantGroups: [],
    } as unknown as DisplayedSuggestionSet;

    const read = await store.transaction(async (transaction) => {
      const existing = await transaction.readSuggestionSet(
        sessionId,
        "suggestion-set:one" as SuggestionSetId,
      );
      await transaction.insertSuggestionSet(sessionId, suggestionSet);
      return existing;
    });

    expect(read).toEqual({
      sessionId: "session:one",
      suggestionSetId: "suggestion-set:one",
      nodeId: "node:root",
      stateId: "state:root",
      suggestionSet: { id: "suggestion-set:one" },
    });
    const select = client.calls.find(({ text }) => text.includes("FROM proof_suggestion_sets"));
    expect(select?.values).toEqual(["session:one", "suggestion-set:one"]);
    const insert = client.calls.find(({ text }) => text.includes("INTO proof_suggestion_sets"));
    expect(insert?.values).toEqual([
      "session:one",
      "suggestion-set:one",
      "node:root",
      "state:root",
      JSON.stringify(suggestionSet),
    ]);
  });

  it("reads and inserts concrete preview evidence with all link identities", async () => {
    const client = new RecordingClient();
    const store = new PostgresProofStore(poolFor(client));
    const preview = {
      id: "preview:one",
      nodeId: "node:root",
      stateId: "state:root",
      suggestionSetId: "suggestion-set:one",
      chosenSuggestionId: "suggestion:one",
      moveId: "move:close-true",
    } as unknown as MovePreview;

    const read = await store.transaction(async (transaction) => {
      const existing = await transaction.readPreview(sessionId, "preview:one" as MovePreviewId);
      await transaction.insertPreview(sessionId, preview);
      return existing;
    });

    expect(read).toEqual({ id: "preview:one" });
    const select = client.calls.find(({ text }) => text.includes("FROM proof_previews"));
    expect(select?.values).toEqual(["session:one", "preview:one"]);
    const insert = client.calls.find(({ text }) => text.includes("INTO proof_previews"));
    expect(insert?.values).toEqual([
      "session:one",
      "preview:one",
      "node:root",
      "state:root",
      "suggestion-set:one",
      "suggestion:one",
      "move:close-true",
      JSON.stringify(preview),
    ]);
  });

  it("writes suggestion and preview links as edge and event columns", async () => {
    const client = new RecordingClient();
    const store = new PostgresProofStore(poolFor(client));
    const evidence = {
      suggestionSetId: "suggestion-set:one",
      chosenSuggestionId: "suggestion:one",
      previewId: "preview:one",
    };
    const edge = {
      id: "edge:one",
      commandId: "command:one",
      parentNodeId: "node:root",
      childNodeId: "node:child",
      ...evidence,
    } as unknown as ProofEdge;
    const event = {
      id: "event:one",
      commandId: "command:one",
      parentNodeId: "node:root",
      childNodeId: "node:child",
      edgeId: "edge:one",
      ...evidence,
    } as unknown as TransitionEvent;

    await store.transaction(async (transaction) => {
      await transaction.insertEdge(sessionId, edge);
      await transaction.insertEvent(sessionId, event);
    });

    const edgeInsert = client.calls.find(({ text }) => text.includes("INTO proof_edges"));
    expect(edgeInsert?.values).toEqual([
      "session:one",
      "edge:one",
      "node:root",
      "node:child",
      "command:one",
      "suggestion-set:one",
      "suggestion:one",
      "preview:one",
      JSON.stringify(edge),
    ]);
    const eventInsert = client.calls.find(({ text }) => text.includes("INTO proof_events"));
    expect(eventInsert?.values).toEqual([
      "session:one",
      "event:one",
      "node:root",
      "node:child",
      "edge:one",
      "command:one",
      "suggestion-set:one",
      "suggestion:one",
      "preview:one",
      JSON.stringify(event),
    ]);
  });

  it("lists session-scoped edge envelopes and compare-and-swap repoints the cursor", async () => {
    const client = new RecordingClient();
    const store = new PostgresProofStore(poolFor(client));
    const result = await store.transaction(async (transaction) => ({
      edges: await transaction.listEdges(sessionId),
      repointed: await transaction.repointCurrentNode(
        sessionId,
        "node:child" as ProofNode["id"],
        "node:root" as ProofNode["id"],
      ),
    }));

    expect(result).toEqual({
      edges: [
        {
          sessionId: "session:one",
          edgeId: "edge:one",
          parentNodeId: "node:root",
          childNodeId: "node:child",
          commandId: "command:one",
          suggestionSetId: "suggestion-set:one",
          chosenSuggestionId: "suggestion:one",
          previewId: "preview:one",
          edge: { id: "edge:one" },
        },
      ],
      repointed: true,
    });
    const select = client.calls.find(({ text }) => text.includes("FROM proof_edges"));
    expect(select?.text).toContain("WHERE session_id = $1");
    expect(select?.text).toContain("ORDER BY id");
    expect(select?.values).toEqual(["session:one"]);
    const update = client.calls.find(({ text }) => text.includes("UPDATE proof_sessions"));
    expect(update?.values).toEqual(["session:one", "node:child", "node:root"]);
  });

  it("rolls back work failures and releases the client normally exactly once", async () => {
    const client = new RecordingClient();
    const store = new PostgresProofStore(poolFor(client));
    const cause = new Error("insert failed");

    const error = await store
      .transaction(async () => {
        throw cause;
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProofStoreTransactionError);
    expect(error).toMatchObject({ outcome: "rolled-back" });
    expect((error as ProofStoreTransactionError).cause).toBe(cause);
    expect(client.calls.map(({ text }) => text.trim())).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.releases).toEqual([undefined]);
  });

  it("rolls back even when the callback throws an uncertainty-shaped error", async () => {
    const client = new RecordingClient();
    const store = new PostgresProofStore(poolFor(client));
    const cause = new ProofStoreTransactionError("commit-unknown", "untrusted callback outcome");

    const error = await store
      .transaction(async () => {
        throw cause;
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ outcome: "rolled-back" });
    expect((error as ProofStoreTransactionError).cause).toBe(cause);
    expect(client.calls.map(({ text }) => text.trim())).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.releases).toEqual([undefined]);
  });

  it("reports commit and rollback connection failures as uncertain and evicts once", async () => {
    for (const failure of ["COMMIT", "ROLLBACK"] as const) {
      const client = new RecordingClient();
      client.failOn = failure;
      const cause = new Error(`forced ${failure} failure`);
      client.failureCause = cause;
      const store = new PostgresProofStore(poolFor(client));
      const operation =
        failure === "COMMIT"
          ? store.transaction(async () => "done")
          : store.transaction(async () => {
              throw new Error("work failed");
            });

      const error = await operation.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProofStoreTransactionError);
      expect(error).toMatchObject({ outcome: "commit-unknown" });
      expect((error as ProofStoreTransactionError).cause).toBe(cause);
      expect(client.releases).toEqual([true]);
      if (failure === "COMMIT") {
        expect(client.calls.some(({ text }) => text.trim() === "ROLLBACK")).toBe(false);
      }
    }
  });

  it("evicts the client exactly once when BEGIN itself fails", async () => {
    const client = new RecordingClient();
    client.failOn = "BEGIN";
    const cause = new Error("forced BEGIN failure");
    client.failureCause = cause;
    let worked = false;

    const error = await new PostgresProofStore(poolFor(client))
      .transaction(async () => {
        worked = true;
        return true;
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProofStoreTransactionError);
    expect(error).toMatchObject({ outcome: "rolled-back" });
    expect((error as ProofStoreTransactionError).cause).toBe(cause);
    expect(client.calls.map(({ text }) => text.trim())).toEqual(["BEGIN"]);
    expect(worked).toBe(false);
    expect(client.releases).toEqual([true]);
  });
});
