import { afterEach, describe, expect, it } from "vitest";
import { PROPOSITION_SORT, type PlainMathJson } from "@proof/mathjson-model";
import { createProofNodeSchema, type DisplayedSuggestionSet } from "@proof/protocol";
import { initializeProofSession } from "../proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore } from "../memory-proof-store.testing";
import {
  createProofHttpService,
  proofHttpReplayFailedResponseSchema,
  proofHttpReplayPreviewResponseSchema,
  proofHttpReplayResponseSchema,
  type ProofHttpService,
} from ".";

/** N21 over HTTP: replay preview (a dry run) and commit (fresh nodes, idempotent). */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const SESSION_ID = "session:replay-http";
const swap = (left: string, right: string): PlainMathJson => [
  "Implies",
  ["And", left, right],
  ["And", right, left],
];

type Session = Readonly<{
  store: MemoryProofStore;
  sessionUrl: string;
  post(path: string, body: unknown): Promise<Response>;
}>;

async function startSession(): Promise<Session> {
  const store = new MemoryProofStore();
  const rootNode = createProofNodeSchema().parse({
    id: "node:root",
    state: {
      id: "state:root",
      goals: [
        ["goal:main", swap("p", "q")],
        ["goal:second", swap("r", "s")],
      ].map(([id, conclusion]) => ({
        id,
        sequent: {
          context: {
            declarations: ["p", "q", "r", "s"].map((symbol) => ({
              id: `declaration:${symbol}`,
              symbol,
              sort: PROPOSITION_SORT,
              role: "universal-parameter",
            })),
            hypotheses: [],
          },
          conclusion: { expression: conclusion },
        },
      })),
      obligations: [],
    },
  });
  expect(await initializeProofSession(store, { sessionId: SESSION_ID, rootNode })).toMatchObject({
    status: "committed",
  });
  const service = createProofHttpService(store);
  services.push(service);
  const { origin } = await service.listen();
  const sessionUrl = `${origin}/proof-sessions/${SESSION_ID}`;
  return {
    store,
    sessionUrl,
    post: (path, body) =>
      fetch(`${sessionUrl}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

async function json<Value = Record<string, unknown>>(response: Response): Promise<Value> {
  return (await response.json()) as Value;
}

/** Display suggestions for one selection and apply the named move through the command route. */
async function applyMove(
  session: Session,
  commandId: string,
  moveId: string,
  stateId: string,
  selection: Readonly<{ target: string; statement?: string }>,
): Promise<void> {
  const displayed = await session.post("suggestion-sets", {
    id: `set:${commandId}`,
    selections: [
      {
        kind: "exact",
        anchor: {
          stateId,
          target: { kind: "goal", id: selection.target },
          statement:
            selection.statement === undefined
              ? { kind: "conclusion" }
              : { kind: "hypothesis", id: selection.statement },
        },
        path: [],
      },
    ],
  });
  expect(displayed.status).toBe(201);
  const set = (await json(displayed)).suggestionSet as DisplayedSuggestionSet;
  const chosen = set.suggestions.find(({ artifactId }) => artifactId === moveId);
  if (chosen === undefined) throw new Error(`${moveId} was not displayed`);
  const applied = await session.post("commands", {
    commandId,
    suggestionSetId: set.id,
    chosenSuggestionId: chosen.id,
  });
  expect(applied.status).toBe(201);
}

/** Introduce the implication and expand the conjunction on `goal:main`. */
async function sourceBranch(session: Session): Promise<void> {
  await applyMove(session, "main:1", "move:introduce-implication", "state:root", {
    target: "goal:main",
  });
  await applyMove(session, "main:2", "move:expand-hypothesis-conjunction", "state:main:1", {
    target: "goal:main",
    statement: "statement:main:1:hypothesis:1",
  });
}

const SOURCE = { fromNodeId: "node:root", toNodeId: "node:main:2" };

describe("semantic replay through the proof HTTP service", () => {
  it("previews without recording and commits fresh nodes idempotently", async () => {
    const session = await startSession();
    await sourceBranch(session);
    const nodeCount = session.store.nodes.size;

    const previewed = await session.post("replay-preview", {
      source: SOURCE,
      commandId: "command:replay",
    });
    expect(previewed.status).toBe(200);
    const preview = await json(previewed);
    expect(proofHttpReplayPreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(preview).toMatchObject({
      report: {
        complete: true,
        targetNodeId: "node:main:2",
        steps: [{ status: "adapted" }, { status: "exact" }],
        substitutions: [
          { symbol: "p", expression: "r" },
          { symbol: "q", expression: "s" },
        ],
        finalNodeId: "node:command:replay:replay:2",
      },
      finalNode: { id: "node:command:replay:replay:2" },
    });
    expect(session.store.nodes.size).toBe(nodeCount);

    const request = {
      commandId: "command:replay",
      expectedCurrentNodeId: "node:main:2",
      source: SOURCE,
    };
    const committed = await session.post("replay", request);
    expect(committed.status).toBe(201);
    const body = await json(committed);
    expect(proofHttpReplayResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      session: { currentNodeId: "node:command:replay:replay:2" },
      node: { id: "node:command:replay:replay:2" },
      receipts: [
        { commandId: "command:replay:replay:1", transitionClass: "equivalence" },
        { commandId: "command:replay:replay:2", transitionClass: "equivalence" },
      ],
      report: (preview as { report: unknown }).report,
      replayed: false,
    });
    expect(session.store.nodes.size).toBe(nodeCount + 2);

    const retried = await session.post("replay", request);
    expect(retried.status).toBe(200);
    expect(await json(retried)).toMatchObject({ replayed: true, receipts: body.receipts });

    // The replayed steps are ordinary history edges.
    const history = await json(await fetch(`${session.sessionUrl}/history`));
    expect(
      (history.edges as { edge: { commandId: string; moveId?: string } }[])
        .map(({ edge }) => [edge.commandId, edge.moveId])
        .filter(([commandId]) => commandId?.startsWith("command:replay")),
    ).toEqual([
      ["command:replay:replay:1", "move:introduce-implication"],
      ["command:replay:replay:2", "move:expand-hypothesis-conjunction"],
    ]);
  });

  it("answers 422 with the report when a step fails, and 409 for a stale cursor", async () => {
    const session = await startSession();
    await sourceBranch(session);
    const failed = await session.post("replay", {
      commandId: "command:replay",
      expectedCurrentNodeId: "node:main:2",
      source: SOURCE,
      overrides: [{ stepIndex: 2, slotId: "conjunction", candidateId: "goal:goal:second/nowhere" }],
    });
    expect(failed.status).toBe(422);
    const body = await json(failed);
    expect(proofHttpReplayFailedResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      status: "replay-failed",
      report: {
        complete: false,
        steps: [{ status: "adapted" }, { status: "failed" }],
        firstFailure: { index: 2, diagnostic: { code: "invalid-override" } },
      },
      diagnostics: [{ code: "replay-failed" }],
    });
    const current = await json(await fetch(session.sessionUrl));
    expect(current).toMatchObject({ session: { currentNodeId: "node:main:2" } });

    const stale = await session.post("replay", {
      commandId: "command:replay",
      expectedCurrentNodeId: "node:root",
      source: SOURCE,
    });
    expect(stale.status).toBe(409);
  });

  it("rejects malformed requests and unknown paths", async () => {
    const session = await startSession();
    await sourceBranch(session);
    expect((await session.post("replay", { source: SOURCE })).status).toBe(400);
    expect(
      (await session.post("replay-preview", { source: SOURCE, actor: { id: "x", kind: "human" } }))
        .status,
    ).toBe(400);
    const backwards = await session.post("replay-preview", {
      source: { fromNodeId: "node:main:2", toNodeId: "node:root" },
    });
    expect(backwards.status).toBe(400);
    expect(await json(backwards)).toMatchObject({ diagnostics: [{ code: "replay-rejected" }] });
    const get = await fetch(`${session.sessionUrl}/replay`);
    expect(get.status).toBe(405);
  });
});
