import { afterEach, describe, expect, it } from "vitest";
import { PROPOSITION_SORT, executableProofStateSchema } from "@proof/mathjson-model";
import { createProofNodeSchema } from "@proof/protocol";
import { MemoryLibraryStore } from "../memory-library-store";
import {
  initializeProofSession,
  proofSessionIdSchema,
  type ProofSessionId,
} from "../proof-repository";
import { createProofHttpService, type ProofHttpService } from ".";

/**
 * N44: conditional lemmas over HTTP. A subtree that closes `p` from `p` while `q` and `r` sit in
 * the context unused is saved as a draft lemma keeping only `p`, rendered server-side, approved by
 * a human, and only then offered to retrieval.
 */

const services: ProofHttpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const HUMAN = { id: "actor:human-1", kind: "human" } as const;
const AGENT = { id: "actor:agent-1", kind: "agent" } as const;
const SESSION = proofSessionIdSchema.parse("session:lemma-http") as ProofSessionId;
const ROOT = "node:lemma-root";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const declarations = ["p", "q", "r"].map((symbol) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
}));

async function start(options: Readonly<{ library?: boolean }> = {}) {
  const store = new MemoryLibraryStore();
  const rootNode = createProofNodeSchema({ operators: [] }).parse({
    id: ROOT,
    state: executableProofStateSchema.parse({
      id: "state:lemma-root",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations,
              hypotheses: ["p", "q", "r"].map((symbol) => ({
                id: `hyp:${symbol}`,
                statement: { expression: symbol },
              })),
            },
            conclusion: { expression: "p" },
          },
        },
      ],
      obligations: [],
    }),
  });
  expect(
    await initializeProofSession(store, {
      sessionId: SESSION,
      rootNode,
      operators: [],
      metadata: {
        problem: { title: "Lemma", statement: "p from p" },
        background: {
          level: "undergraduate",
          summary: "Logic.",
          assumptions: [],
          domains: ["logic"],
          maximumLevel: "undergraduate",
        },
        libraryLayerIds: [],
      },
    }),
  ).toMatchObject({ status: "committed" });
  const service = createProofHttpService(
    store,
    options.library === false ? {} : { library: store },
  );
  services.push(service);
  const { origin } = await service.listen();
  const base = `${origin}/proof-sessions/${SESSION}`;
  const send = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}/${path}`, init);
    return { status: response.status, body: (await response.json()) as Json };
  };
  return {
    store,
    command: (envelope: Json) =>
      send("protocol-commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      }),
    preview: (nodeId = ROOT, target = { kind: "goal", id: "goal:main" }) =>
      send("conditional-lemmas/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId, target }),
      }),
    get: (path: string) => send(path),
  };
}

type Client = Awaited<ReturnType<typeof start>>;

async function closeGoal(client: Client): Promise<void> {
  const closed = await client.command({
    commandId: "command:close",
    actor: HUMAN,
    basis: { nodeId: ROOT },
    command: {
      kind: "kernel-operation",
      operation: {
        kind: "close-by-hypothesis",
        target: "goal:main",
        hypothesisId: "hyp:p",
      },
    },
  });
  expect(closed.status, JSON.stringify(closed.body)).toBe(201);
}

const extract = (commandId: string, actor: Json = HUMAN, name?: string) => ({
  commandId,
  actor,
  command: {
    kind: "extract-conditional-lemma",
    nodeId: ROOT,
    target: "goal:main",
    ...(name === undefined ? {} : { lemma: { name } }),
  },
});

const review = (
  commandId: string,
  draftArtifactId: string,
  decision: string,
  notes = "",
  actor: Json = HUMAN,
) => ({
  commandId,
  actor,
  command: { kind: "review-conditional-lemma", draftArtifactId, decision, notes },
});

describe("conditional lemmas over HTTP", () => {
  it("refuses a target that is not closed, with the reason", async () => {
    const client = await start();
    const preview = await client.preview();
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toMatchObject({ status: "refused", code: "lemma-not-closed" });
    const extracted = await client.command(extract("command:early"));
    expect(extracted.status).toBe(422);
    expect(extracted.body.diagnostics[0].code).toBe("lemma-not-closed");
  });

  it("lists the steps that could be saved, with their status", async () => {
    const client = await start();
    expect((await client.get("conditional-lemmas")).body).toMatchObject({
      candidates: [],
      readOnly: false,
    });
    await closeGoal(client);
    const listed = (await client.get("conditional-lemmas")).body;
    expect(listed.candidates).toHaveLength(1);
    expect(listed.candidates[0]).toMatchObject({
      nodeId: ROOT,
      target: { kind: "goal", id: "goal:main" },
      goal: { latex: "p" },
      preview: { status: "ready", premises: [{ id: "hyp:p" }] },
    });
  });

  it("refuses a closure that goes through a sorry", async () => {
    const client = await start();
    const sorry = await client.command({
      commandId: "command:sorry",
      actor: HUMAN,
      basis: { nodeId: ROOT },
      command: { kind: "sorry", target: "goal:main" },
    });
    expect(sorry.status, JSON.stringify(sorry.body)).toBe(201);
    expect((await client.preview()).body.preview).toMatchObject({
      status: "refused",
      code: "lemma-uses-sorry",
    });
    const extracted = await client.command(extract("command:save"));
    expect(extracted.status).toBe(422);
    expect(extracted.body.diagnostics[0].code).toBe("lemma-uses-sorry");
  });

  it("previews the lemma with only the hypotheses the subtree used, rendered server-side", async () => {
    const client = await start();
    await closeGoal(client);
    const { body } = await client.preview();
    expect(body.preview).toMatchObject({
      status: "ready",
      premises: [{ id: "hyp:p", latex: "p" }],
      unusedHypotheses: [{ id: "hyp:q" }, { id: "hyp:r" }],
      conservative: [],
      existing: [],
    });
    expect(body.preview.statement.latex).toContain("\\implies");
    expect(body.preview.statement.naturalLanguage.length).toBeGreaterThan(0);
    // Unknown request fields are refused: the caller cannot supply renderings.
    const forged = await client.command({
      ...extract("command:forged"),
      command: {
        kind: "extract-conditional-lemma",
        target: "goal:main",
        nodeId: ROOT,
        lemma: { renderings: { latex: "x", naturalLanguage: "x" } },
      },
    });
    expect(forged.status).toBe(400);
  });

  it("saves a draft, keeps it out of retrieval, and offers it only after a human approves it", async () => {
    const client = await start();
    await closeGoal(client);

    const saved = await client.command(extract("command:save", AGENT, "p from p"));
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const { lemma, keptHypothesisIds, unusedHypothesisIds } = saved.body.result;
    expect(lemma).toMatchObject({
      id: "result:lemma.command:save",
      name: "p from p",
      layer: "derived",
      approval: { status: "draft" },
      premises: [{ expression: "p" }],
      statement: { expression: "p" },
    });
    expect(lemma.renderings.latex).toContain("\\implies");
    expect(keptHypothesisIds).toEqual(["hyp:p"]);
    expect(unusedHypothesisIds).toEqual(["hyp:q", "hyp:r"]);

    // Idempotent: the same command replays; a new command for the same lemma is refused.
    const replay = await client.command(extract("command:save", AGENT, "p from p"));
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const duplicate = await client.command(extract("command:save-again"));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.diagnostics[0].code).toBe("lemma-already-saved");
    expect((await client.preview()).body.preview.existing).toEqual([
      { artifactId: lemma.id, status: "draft" },
    ]);

    // A draft is stored, but it is not a retrievable result.
    const catalogIds = async () =>
      ((await client.get("library")).body.entries as Json[])
        .filter((entry) => entry.source === "approved-catalog")
        .map((entry) => entry.artifact.id);
    const stored = (await client.get("library")).body.entries as Json[];
    expect(stored.filter((entry) => entry.artifact.id === lemma.id)).toHaveLength(1);
    expect(await catalogIds()).not.toContain(lemma.id);

    // Only a human can decide, and a rejection needs notes.
    const byAgent = await client.command(
      review("command:agent-review", lemma.id, "approved", "", AGENT),
    );
    expect(byAgent.status).toBe(422);
    const noNotes = await client.command(review("command:no-notes", lemma.id, "rejected"));
    expect(noNotes.status).toBe(400);
    expect(noNotes.body.diagnostics[0].code).toBe("review-notes-required");
    const missing = await client.command(review("command:missing", "result:nope", "approved"));
    expect(missing.status).toBe(404);

    const approved = await client.command(review("command:approve", lemma.id, "approved", "Fine."));
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.result).toMatchObject({
      draftArtifactId: lemma.id,
      decision: "approved",
      retrievable: true,
      review: { reviewerId: HUMAN.id, notes: "Fine.", reviewOf: lemma.id },
    });
    const replayed = await client.command(review("command:approve", lemma.id, "approved", "Fine."));
    expect(replayed.status).toBe(200);
    expect(replayed.body.replayed).toBe(true);
    const again = await client.command(review("command:approve-2", lemma.id, "rejected", "No."));
    expect(again.status).toBe(409);
    expect(again.body.diagnostics[0].code).toBe("draft-already-reviewed");

    // The approved lemma is listed once, as the stored (reviewed) artifact, and the draft stays a draft.
    const approvedId = approved.body.result.artifactId as string;
    const after = (await client.get("library")).body.entries as Json[];
    expect(after.filter((entry) => entry.artifact.id === approvedId)).toEqual([
      expect.objectContaining({
        source: "stored-library",
        artifact: expect.objectContaining({
          approval: { status: "approved", reviewerId: HUMAN.id },
        }),
      }),
    ]);
    expect(after.find((entry) => entry.artifact.id === lemma.id)?.artifact.approval).toEqual({
      status: "draft",
    });
    expect((await client.preview()).body.preview.existing).toEqual([
      { artifactId: lemma.id, status: "approved" },
    ]);
  });

  it("records a rejection without making the lemma retrievable", async () => {
    const client = await start();
    await closeGoal(client);
    const saved = await client.command(extract("command:save"));
    const id = saved.body.result.lemma.id as string;
    const rejected = await client.command(review("command:reject", id, "rejected", "Too trivial."));
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(201);
    expect(rejected.body.result).toMatchObject({ decision: "rejected", retrievable: false });
    const entries = (await client.get("library")).body.entries as Json[];
    expect(entries.filter((entry) => entry.source === "approved-catalog")).not.toContainEqual(
      expect.objectContaining({
        artifact: expect.objectContaining({ premises: [{ expression: "p" }] }),
      }),
    );
    expect(
      entries.find((entry) => entry.artifact.id === rejected.body.result.artifactId)?.artifact,
    ).toMatchObject({ approval: { status: "draft" }, review: { decision: "rejected" } });
  });

  it("offers an approved lemma as a suggestion at another node of the session", async () => {
    const client = await start();
    await closeGoal(client);
    const saved = await client.command(extract("command:save"));
    const back = await client.command({
      commandId: "command:back",
      actor: HUMAN,
      basis: { nodeId: "node:command:close" },
      command: { kind: "backtrack", targetNodeId: ROOT },
    });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    const offered = async (setId: string) => {
      const suggested = await client.command({
        commandId: setId,
        actor: HUMAN,
        basis: { nodeId: ROOT },
        command: {
          kind: "request-suggestions",
          selections: [{ target: "g1", statement: "conclusion", path: [] }],
        },
      });
      expect(suggested.status, JSON.stringify(suggested.body)).toBe(201);
      return (suggested.body.result.displayed.suggestions as Json[]).map(
        (suggestion) => suggestion.artifactId,
      );
    };
    expect(await offered("command:before")).not.toContain(
      "result:lemma.command:save.review.command:approve",
    );
    const approved = await client.command(
      review("command:approve", saved.body.result.lemma.id, "approved"),
    );
    expect(approved.status).toBe(201);
    expect(await offered("command:after")).toContain(approved.body.result.artifactId);
  });

  it("refuses without a library store and in a read-only session", async () => {
    const without = await start({ library: false });
    await closeGoal(without);
    expect((await without.command(extract("command:save"))).status).toBe(503);

    const client = await start();
    await closeGoal(client);
    const saved = await client.command(extract("command:save"));
    expect(saved.status).toBe(201);
    await client.store.transaction(async (transaction) => {
      expect(await transaction.markSessionReadOnly(SESSION)).toBe(true);
    });
    const blocked = await client.command(extract("command:save-2"));
    expect(blocked.status).toBe(409);
    expect(blocked.body.diagnostics[0].code).toBe("session-read-only");
    const reviewed = await client.command(
      review("command:approve", saved.body.result.lemma.id, "approved"),
    );
    expect(reviewed.status).toBe(409);
    expect(reviewed.body.diagnostics[0].code).toBe("session-read-only");
    // Reading the preview is still allowed.
    expect((await client.preview()).status).toBe(200);
  });
});
