import { afterEach, describe, expect, it } from "vitest";
import { PROPOSITION_SORT } from "@proof/mathjson-model";
import { actorSchema, commandIdSchema, createProofNodeSchema } from "@proof/protocol";
import {
  derivedMoveRecordIds,
  executeProofCommand,
  initializeProofSession,
} from "../proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore } from "../memory-proof-store.testing";
import {
  createProofHttpService,
  proofHttpBacktrackAnalysisResponseSchema,
  proofHttpBacktrackWithInformationResponseSchema,
  type ProofHttpService,
} from ".";

/** N20 over HTTP: analysis, the backtracking command, replay, and its failure statuses. */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const SESSION = "session:http-backtrack";
const WEB_ACTOR = actorSchema.parse({ id: "actor:web", kind: "human" });
const ids = (commandId: string) => derivedMoveRecordIds(commandIdSchema.parse(commandId));
const INTRO_P = ids("command:intro-p").resultNodeId;
const CURSOR = ids("command:intro-hp").resultNodeId;

/** root ⊢ q ⇒ ∀p. (p ⇒ r), then introduce q, p and the hypothesis p (the cursor). */
async function harness() {
  const store = new MemoryProofStore();
  const declarations = ["p", "q", "r", "s"].map((symbol, index) => ({
    id: `declaration:${index}`,
    symbol,
    sort: PROPOSITION_SORT,
    role: "universal-parameter" as const,
  }));
  const root = createProofNodeSchema().parse({
    id: "node:root",
    state: {
      id: "state:root",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: { declarations, hypotheses: [] },
            conclusion: {
              expression: ["Implies", "q", ["ForAll", "p", ["Implies", "p", "r"]]],
            },
          },
        },
      ],
      obligations: [],
    },
  });
  expect(await initializeProofSession(store, { sessionId: SESSION, rootNode: root })).toMatchObject(
    { status: "committed" },
  );
  const steps = [
    ["command:intro-q", { kind: "introduce-implication", hypothesisId: "hyp:q" }],
    ["command:intro-p", { kind: "introduce-universal" }],
    ["command:intro-hp", { kind: "introduce-implication", hypothesisId: "hyp:p" }],
  ] as const;
  let parent: Readonly<{ nodeId: string; stateId: string }> = {
    nodeId: "node:root",
    stateId: "state:root",
  };
  for (const [commandId, operation] of steps) {
    const own = ids(commandId);
    expect(
      await executeProofCommand(
        store,
        SESSION,
        {
          commandId,
          kind: "apply-kernel-operation",
          actor: WEB_ACTOR,
          parentNodeId: parent.nodeId,
          resultNodeId: own.resultNodeId,
          edgeId: own.edgeId,
          eventId: own.eventId,
          operation: {
            ...operation,
            target: { kind: "goal", id: "goal:main" },
            expectedStateId: parent.stateId,
            resultStateId: own.resultStateId,
          },
        },
        WEB_ACTOR,
      ),
    ).toMatchObject({ status: "committed" });
    parent = { nodeId: own.resultNodeId, stateId: own.resultStateId };
  }

  const service = createProofHttpService(store, {
    now: () => new Date("2026-09-27T12:00:00.000Z"),
  });
  services.push(service);
  const { origin } = await service.listen();
  const post = (path: string, body: unknown) =>
    fetch(`${origin}/proof-sessions/${SESSION}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = (path: string) => fetch(`${origin}/proof-sessions/${SESSION}${path}`);
  return { store, post, get };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

const request = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  commandId: "command:backtrack",
  expectedCurrentNodeId: CURSOR,
  sourceNodeId: CURSOR,
  proposition: ["Implies", "p", "r"],
  ...overrides,
});

describe("POST /proof-sessions/:id/backtrack-analysis", () => {
  it("returns the ancestors closest first", async () => {
    const h = await harness();
    const response = await h.post("/backtrack-analysis", {
      sourceNodeId: CURSOR,
      proposition: "p",
    });
    expect(response.status).toBe(200);
    const body = proofHttpBacktrackAnalysisResponseSchema.parse(await json(response));
    expect(body.analysis.closestEligibleAncestorNodeId).toBe(INTRO_P);
    expect(body.analysis.ancestors.map(({ nodeId, eligible }) => [nodeId, eligible])).toEqual([
      [INTRO_P, true],
      [ids("command:intro-q").resultNodeId, false],
      ["node:root", false],
    ]);

    expect((await h.post("/backtrack-analysis", { proposition: "p" })).status).toBe(400);
    expect(
      (await h.post("/backtrack-analysis", { sourceNodeId: "node:root", proposition: "p" })).status,
    ).toBe(400);
  });
});

describe("POST /proof-sessions/:id/backtrack-with-information", () => {
  it("adds the case split under the ancestor, auto-closes P, and replays a retry", async () => {
    const h = await harness();
    const created = await h.post("/backtrack-with-information", request());
    expect(created.status).toBe(201);
    const body = proofHttpBacktrackWithInformationResponseSchema.parse(await json(created));
    const close = ids("command:backtrack:auto-close");
    expect(body.session.currentNodeId).toBe(close.resultNodeId);
    expect(body.receipts.map(({ commandId }) => commandId)).toEqual([
      "command:backtrack",
      "command:backtrack:auto-close",
    ]);
    expect(body.backtrack).toMatchObject({
      kind: "backtracked-with-information",
      actor: WEB_ACTOR,
      ancestorNodeId: INTRO_P,
      autoClosedTarget: { kind: "goal", id: "statement:command:backtrack:child:1" },
      focusTarget: { kind: "goal", id: "statement:command:backtrack:child:2" },
    });
    expect(body.node).toMatchObject({
      id: close.resultNodeId,
      state: { goals: [{ id: "statement:command:backtrack:child:2" }] },
    });

    const history = await json(await h.get("/history"));
    const edges = (history.edges as { edge: { id: string; parentNodeId: string } }[]).map(
      ({ edge }) => [edge.id, edge.parentNodeId],
    );
    expect(edges).toEqual(
      expect.arrayContaining([
        [ids("command:intro-hp").edgeId, INTRO_P],
        [ids("command:backtrack").edgeId, INTRO_P],
        [close.edgeId, ids("command:backtrack").resultNodeId],
      ]),
    );
    expect(history.nodes).toHaveLength(6);

    const replayed = await h.post("/backtrack-with-information", request());
    expect(replayed.status).toBe(200);
    expect(await json(replayed)).toMatchObject({ replayed: true, receipts: body.receipts });

    const conflict = await h.post("/backtrack-with-information", request({ proposition: "s" }));
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({
      diagnostics: [{ code: "backtrack-with-information-conflict" }],
    });
    const stale = await h.post(
      "/backtrack-with-information",
      request({ commandId: "command:again" }),
    );
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({
      diagnostics: [{ code: "serialized-stale-command" }],
    });
  });

  it("answers 422 for unavailable symbols and 400 for invalid requests", async () => {
    const h = await harness();
    const unavailable = await h.post(
      "/backtrack-with-information",
      request({ proposition: ["And", "p", "s"], ancestorNodeId: "node:root" }),
    );
    expect(unavailable.status).toBe(422);
    expect(await json(unavailable)).toMatchObject({
      diagnostics: [{ code: "backtrack-symbols-unavailable" }],
    });

    expect(
      (await h.post("/backtrack-with-information", { ...request(), actor: WEB_ACTOR })).status,
    ).toBe(400);
    expect(
      (await h.post("/backtrack-with-information", request({ proposition: "t" }))).status,
    ).toBe(400);
    const session = await json(await h.get(""));
    expect(session.session).toMatchObject({ currentNodeId: CURSOR });

    const wrongMethod = await h.get("/backtrack-with-information");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
  });
});
