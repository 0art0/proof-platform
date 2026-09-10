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
  released = false;
  failOn: "BEGIN" | "COMMIT" | "ROLLBACK" | undefined;

  async query(text: string, values?: readonly unknown[]): Promise<SqlQueryResult> {
    this.calls.push({ text, values });
    const normalized = text.trim();
    if (this.failOn !== undefined && normalized === this.failOn) {
      throw new Error(`forced ${this.failOn} failure`);
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
        rows: [{ id: "node:root", state: rootNode().state }],
        rowCount: 1,
      };
    }
    if (text.includes("FROM proof_commands")) {
      return { rows: [{ result: { ok: true } }], rowCount: 1 };
    }
    if (text.includes("FROM proof_suggestion_sets")) {
      return { rows: [{ record: { id: "suggestion-set:one" } }], rowCount: 1 };
    }
    if (text.includes("FROM proof_previews")) {
      return { rows: [{ record: { id: "preview:one" } }], rowCount: 1 };
    }
    return { rows: [], rowCount: text.includes("UPDATE proof_sessions") ? 1 : 0 };
  }

  release(): void {
    this.released = true;
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
      node: { id: "node:root" },
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
    expect(client.released).toBe(true);
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

    expect(read).toEqual({ id: "suggestion-set:one" });
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

  it("rolls back work failures and releases the client", async () => {
    const client = new RecordingClient();
    const store = new PostgresProofStore(poolFor(client));

    await expect(
      store.transaction(async () => {
        throw new Error("insert failed");
      }),
    ).rejects.toMatchObject({ outcome: "rolled-back" });
    expect(client.calls.map(({ text }) => text.trim())).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.released).toBe(true);
  });

  it("rolls back even when the callback throws an uncertainty-shaped error", async () => {
    const client = new RecordingClient();
    const store = new PostgresProofStore(poolFor(client));

    await expect(
      store.transaction(async () => {
        throw new ProofStoreTransactionError("commit-unknown", "untrusted callback outcome");
      }),
    ).rejects.toMatchObject({ outcome: "rolled-back" });
    expect(client.calls.map(({ text }) => text.trim())).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.released).toBe(true);
  });

  it("reports commit and rollback connection failures as uncertain", async () => {
    for (const failure of ["COMMIT", "ROLLBACK"] as const) {
      const client = new RecordingClient();
      client.failOn = failure;
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
      expect(client.released).toBe(true);
      if (failure === "COMMIT") {
        expect(client.calls.some(({ text }) => text.trim() === "ROLLBACK")).toBe(false);
      }
    }
  });

  it("releases the client when BEGIN itself fails", async () => {
    const client = new RecordingClient();
    client.failOn = "BEGIN";
    await expect(
      new PostgresProofStore(poolFor(client)).transaction(async () => true),
    ).rejects.toMatchObject({ outcome: "rolled-back" });
    expect(client.calls.map(({ text }) => text.trim())).toEqual(["BEGIN"]);
    expect(client.released).toBe(true);
  });
});
