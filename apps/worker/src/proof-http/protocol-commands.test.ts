import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ELEMENTARY_CORPUS,
  corpusRootState,
  type CorpusProblem,
  type CorpusSelection,
} from "@proof/library";
import {
  analyzeDiscoveryTree,
  createProofNodeSchema,
  type ProofEdge,
  type ProofNode,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { MemoryLibraryStore } from "../memory-library-store";
import { initializeProofSession } from "../proof-repository";
import { createProofHttpService, type ProofHttpService } from ".";

/**
 * N25: the command envelope and observations over HTTP. The scripted agent below uses only
 * `observe` and `protocol-commands` with aliases; it never sends an ID it did not observe, nor any
 * MathJSON.
 */

const services: ProofHttpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const AGENT = { id: "actor:agent-1", kind: "agent" } as const;
const HUMAN = { id: "actor:human-1", kind: "human" } as const;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

type Client = Readonly<{
  sessionId: string;
  command(envelope: Json): Promise<{ status: number; body: Json }>;
  observe(query?: string): Promise<{ status: number; body: Json }>;
  get(path: string): Promise<Json>;
}>;

async function startProblem(
  problem: CorpusProblem,
  options: Readonly<{ library?: boolean }> = {},
): Promise<Client> {
  const store = new MemoryLibraryStore();
  const operators = problem.operators as NonNullable<ProtocolEnvironment["operators"]>;
  const slug = problem.id.replace(/^corpus:/, "");
  const rootNode = createProofNodeSchema({ operators }).parse({
    id: `node:${slug}-root`,
    state: corpusRootState(problem, `state:${slug}-root`),
  });
  const sessionId = `session:${slug}`;
  expect(await initializeProofSession(store, { sessionId, rootNode, operators })).toMatchObject({
    status: "committed",
  });
  const service = createProofHttpService(
    store,
    options.library === false ? {} : { library: store },
  );
  services.push(service);
  const { origin } = await service.listen();
  const base = `${origin}/proof-sessions/${sessionId}`;
  return {
    sessionId,
    async command(envelope) {
      const response = await fetch(`${base}/protocol-commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      return { status: response.status, body: (await response.json()) as Json };
    },
    async observe(query = "") {
      const response = await fetch(`${base}/observe${query}`);
      return { status: response.status, body: (await response.json()) as Json };
    },
    async get(path) {
      return (await (await fetch(`${base}/${path}`)).json()) as Json;
    },
  };
}

function problem(id: string): CorpusProblem {
  const found = ELEMENTARY_CORPUS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No corpus problem ${id}.`);
  return found;
}

/** The agent's only translation step: a scripted selection to aliases of the observed snapshot. */
function selectionAliases(observed: Json, selection: CorpusSelection): Json {
  const node = observed.node as ProofNode;
  const entries = selection.target.kind === "goal" ? node.state.goals : node.state.obligations;
  const target = entries.find((entry) =>
    isDeepStrictEqual(entry.sequent.conclusion.expression, selection.target.conclusion),
  );
  if (target === undefined) throw new Error("The scripted target is not open.");
  const targetAlias = (observed.targets as Json[]).find((entry) => entry.id === target.id)?.alias;
  let statement = "conclusion";
  if (selection.statement !== "conclusion") {
    const wanted = selection.statement.hypothesis;
    const hypothesis = target.sequent.context.hypotheses.find((entry) =>
      isDeepStrictEqual(entry.statement.expression, wanted),
    );
    statement = (observed.aliases.hypotheses as Json[]).find(
      (entry) => entry.id === hypothesis?.id,
    )?.alias;
  }
  return { target: targetAlias, statement, path: [...(selection.path ?? [])] };
}

async function solveAsAgent(client: Client, corpus: CorpusProblem): Promise<void> {
  for (const [index, step] of corpus.steps.entries()) {
    const observed = await client.observe("?view=full");
    expect(observed.status).toBe(200);
    const basis = { nodeId: observed.body.cursor.nodeId };

    const suggested = await client.command({
      commandId: `command:agent-${index + 1}-suggest`,
      actor: AGENT,
      basis,
      command: {
        kind: "request-suggestions",
        selections: step.selections.map((selection) => selectionAliases(observed.body, selection)),
      },
    });
    expect(suggested.status).toBe(201);
    const displayed = suggested.body.result.displayed as Json;
    const chosen = (displayed.suggestions as Json[]).find(
      (suggestion) =>
        suggestion.source === step.suggestion.source &&
        suggestion.artifactId === step.suggestion.artifactId &&
        (step.suggestion.patternId === undefined ||
          suggestion.patternId === step.suggestion.patternId),
    );
    expect(chosen?.alias).toMatch(/^s[0-9]+$/);

    // The same aliases come back from observing the snapshot again.
    const again = await client.observe("?view=full");
    expect(again.body.displayed.suggestions).toEqual(displayed.suggestions);
    expect(again.body.aliases).toEqual(observed.body.aliases);

    const menuChoices: Record<string, string> = {};
    const apply = () =>
      client.command({
        commandId: `command:agent-${index + 1}`,
        actor: AGENT,
        basis: { nodeId: basis.nodeId, suggestionSetId: displayed.suggestionSetId },
        command: {
          kind: "apply",
          suggestion: chosen?.alias,
          ...(Object.keys(menuChoices).length === 0 ? {} : { menuChoices }),
        },
      });
    let applied = await apply();
    for (let round = 0; applied.status === 422 && round < 8; round += 1) {
      expect(applied.body.status).toBe("requires-input");
      for (const parameterId of applied.body.missingParameters as string[]) {
        const menu = (applied.body.menus as Json[]).find(
          (entry) => entry.parameterId === parameterId,
        );
        const item = (menu?.items as Json[] | undefined)?.find((candidate) =>
          isDeepStrictEqual(candidate.value, step.menu?.[parameterId]),
        );
        expect(item?.alias).toMatch(/^m[0-9]+$/);
        menuChoices[parameterId] = item?.alias as string;
      }
      applied = await apply();
    }
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(applied.body).toMatchObject({
      kind: "apply",
      actor: AGENT,
      replayed: false,
      cursor: { nodeId: `node:command:agent-${index + 1}` },
      result: { receipt: { commandId: `command:agent-${index + 1}` } },
    });
  }
}

describe("agent-style scripted session over HTTP", () => {
  it.each(["corpus:modus-tollens", "corpus:equality-chain"])(
    "solves %s with observe and aliased envelope commands only",
    async (id) => {
      const corpus = problem(id);
      const client = await startProblem(corpus);
      await solveAsAgent(client, corpus);

      const summary = await client.observe("?view=summary");
      expect(summary.body.lines).toContain("no open targets");
      const history = await client.get("history");
      const analysis = analyzeDiscoveryTree({
        nodes: history.nodes as ProofNode[],
        edges: history.edges as { edge: ProofEdge }[],
        rootId: history.session.rootNodeId,
      });
      expect(analysis).toMatchObject({ ok: true, solved: true });

      // Every mutation and display is recorded with the agent as actor.
      const events = await client.get("interaction-events");
      expect((events.events as Json[]).every((event) => event.actor.id === AGENT.id)).toBe(true);
    },
  );
});

describe("POST /proof-sessions/:id/protocol-commands", () => {
  const corpus = problem("corpus:modus-tollens");

  it("rejects stale and unknown aliases with diagnostics", async () => {
    const client = await startProblem(corpus);
    const root = (await client.observe()).body;
    const unknown = await client.command({
      commandId: "command:unknown",
      actor: AGENT,
      basis: { nodeId: root.cursor.nodeId },
      command: { kind: "sorry", target: "g7" },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.diagnostics[0].code).toBe("unknown-alias");

    const sorry = await client.command({
      commandId: "command:sorry",
      actor: AGENT,
      basis: { nodeId: root.cursor.nodeId },
      command: { kind: "sorry", target: "g1" },
    });
    expect(sorry.status).toBe(201);
    expect(sorry.body.delta.goals.removed).toEqual([root.aliases.goals[0].id]);
    expect(sorry.body.delta.assumptionsAdded).toHaveLength(1);

    // An identical retry replays; a different command on the old basis is stale.
    expect(
      (
        await client.command({
          commandId: "command:sorry",
          actor: AGENT,
          basis: { nodeId: root.cursor.nodeId },
          command: { kind: "sorry", target: "g1" },
        })
      ).status,
    ).toBe(200);
    const stale = await client.command({
      commandId: "command:stale",
      actor: AGENT,
      basis: { nodeId: root.cursor.nodeId },
      command: { kind: "sorry", target: "g1" },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.diagnostics[0].code).toBe("stale-alias");

    const missingBasis = await client.command({
      commandId: "command:no-basis",
      actor: AGENT,
      command: { kind: "delete-previous-move" },
    });
    expect(missingBasis.status).toBe(400);
    expect(missingBasis.body.diagnostics[0].code).toBe("basis-required");
  });

  it("enforces payload sources for raw mathematics", async () => {
    const client = await startProblem(corpus);
    const root = (await client.observe()).body;
    const basis = { nodeId: root.cursor.nodeId };
    const split = (proposition: Json, actor: Json = AGENT, commandId = "command:split") =>
      client.command({
        commandId,
        actor,
        basis,
        command: { kind: "case-split", target: "g1", proposition },
      });

    const unsourced = await client.command({
      commandId: "command:raw",
      actor: AGENT,
      basis,
      command: {
        kind: "kernel-operation",
        operation: { kind: "split-classical-cases", target: "g1", proposition: "r" },
      },
    });
    expect(unsourced.status).toBe(422);
    expect(unsourced.body.diagnostics[0]).toMatchObject({ code: "payload-source-required" });

    for (const [proposition, code] of [
      [{ expression: ["Not", "r"], source: "validated-operation" }, "payload-source-rejected"],
      [{ expression: "p", source: "reviewed-authoring" }, "payload-source-rejected"],
      [{ expression: "p", source: "approved-generator" }, "payload-source-rejected"],
      [{ expression: "p", source: "setup" }, "payload-source-rejected"],
    ] as const) {
      const rejected = await split(proposition);
      expect(rejected.status).toBe(422);
      expect(rejected.body.diagnostics[0].code).toBe(code);
    }

    // An occurrence of the stored snapshot is a validated operation's output.
    const byOccurrence = await split({ occurrence: { target: "g1", statement: "h2", path: [0] } });
    expect(byOccurrence.status, JSON.stringify(byOccurrence.body)).toBe(201);
    expect(byOccurrence.body.delta.goals.added).toHaveLength(2);
    expect(byOccurrence.body.delta.goals.added[0].conclusion).toBe("Not(p)");
  });

  it("records agent-provenance inquiry and deletes through the envelope", async () => {
    const client = await startProblem(corpus);
    const root = (await client.observe()).body;
    const investigated = await client.command({
      commandId: "command:investigate",
      actor: AGENT,
      basis: { nodeId: root.cursor.nodeId },
      command: { kind: "investigate-hypothesis", target: "g1", hypothesis: "h2" },
    });
    expect(investigated.status, JSON.stringify(investigated.body)).toBe(201);
    expect(
      (investigated.body.result.records as Json[]).every((record) => record.actor.id === AGENT.id),
    ).toBe(true);
    expect(investigated.body.cursor.inquirySequence).toBeGreaterThan(0);

    const sorry = await client.command({
      commandId: "command:sorry",
      actor: AGENT,
      basis: { nodeId: root.cursor.nodeId },
      command: { kind: "sorry", target: "g1" },
    });
    const deleted = await client.command({
      commandId: "command:delete",
      actor: AGENT,
      basis: { nodeId: sorry.body.cursor.nodeId },
      command: { kind: "delete-previous-move" },
    });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(201);
    expect(deleted.body.cursor.nodeId).toBe(root.cursor.nodeId);
    expect(deleted.body.delta.goals.added.map((goal: Json) => goal.alias)).toEqual(["g1"]);
  });

  it("backtracks the cursor and with information from an occurrence", async () => {
    const client = await startProblem(corpus);
    const root = (await client.observe()).body;
    const sorry = await client.command({
      commandId: "command:sorry",
      actor: AGENT,
      basis: { nodeId: root.cursor.nodeId },
      command: { kind: "sorry", target: "g1" },
    });
    const back = await client.command({
      commandId: "command:back",
      actor: AGENT,
      basis: { nodeId: sorry.body.cursor.nodeId },
      command: { kind: "backtrack", targetNodeId: root.cursor.nodeId },
    });
    expect(back.status).toBe(201);
    expect(back.body.cursor.nodeId).toBe(root.cursor.nodeId);

    const rawByAgent = await client.command({
      commandId: "command:bwi",
      actor: AGENT,
      basis: { nodeId: root.cursor.nodeId },
      command: {
        kind: "backtrack-with-information",
        sourceNodeId: sorry.body.cursor.nodeId,
        proposition: { expression: "q", source: "reviewed-authoring" },
      },
    });
    expect(rawByAgent.status).toBe(422);
    expect(rawByAgent.body.diagnostics[0].code).toBe("payload-source-rejected");
  });

  it("gates library additions by payload source and store availability", async () => {
    const withoutLibrary = await startProblem(corpus, { library: false });
    const lemma = await withoutLibrary.command({
      commandId: "command:lemma",
      actor: AGENT,
      command: {
        kind: "add-library-result",
        layer: "proof-time-background",
        artifact: { approval: { status: "approved", reviewerId: HUMAN.id } },
        payloadSource: "reviewed-authoring",
      },
    });
    expect(lemma.status).toBe(503);

    const client = await startProblem(corpus);
    for (const [actor, payloadSource, reviewerId, code] of [
      [AGENT, "reviewed-authoring", AGENT.id, "payload-source-rejected"],
      [HUMAN, "reviewed-authoring", "actor:someone-else", "payload-source-rejected"],
      [HUMAN, "validated-operation", HUMAN.id, "payload-source-rejected"],
      [HUMAN, undefined, HUMAN.id, "payload-source-required"],
    ] as const) {
      const rejected = await client.command({
        commandId: "command:add",
        actor,
        command: {
          kind: "add-library-result",
          layer: "proof-time-background",
          artifact: { approval: { status: "approved", reviewerId } },
          ...(payloadSource === undefined ? {} : { payloadSource }),
        },
      });
      expect(rejected.status).toBe(422);
      expect(rejected.body.diagnostics[0].code).toBe(code);
    }
  });

  it("rejects envelopes outside the strict schema", async () => {
    const client = await startProblem(corpus);
    const response = await client.command({
      commandId: "command:x",
      actor: { id: "actor:x", kind: "robot" },
      command: { kind: "sorry", target: "g1" },
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /proof-sessions/:id/observe", () => {
  const corpus = problem("corpus:modus-tollens");

  it("reports full, summary and delta views from stored records", async () => {
    const client = await startProblem(corpus);
    const full = await client.observe();
    expect(full.status).toBe(200);
    expect(full.body).toMatchObject({
      view: "full",
      aliases: { goals: [{ alias: "g1" }], hypotheses: [{ alias: "h1" }, { alias: "h2" }] },
      targets: [{ alias: "g1", conclusion: "Not(p)", hypotheses: ["h1", "h2"] }],
      cursor: { eventSequence: 0, inquirySequence: 0 },
    });
    expect(full.body.displayed).toBeUndefined();

    const summary = await client.observe("?view=summary");
    expect(summary.body.lines).toContain(
      "h1 " + full.body.aliases.hypotheses[0].id + ": Implies(p, q)",
    );
    expect(summary.body.lines.join("\n")).not.toContain("\\");

    const cursor = full.body.cursor;
    await client.command({
      commandId: "command:sorry",
      actor: AGENT,
      basis: { nodeId: cursor.nodeId },
      command: { kind: "sorry", target: "g1" },
    });
    const delta = await client.observe(
      `?view=delta&sinceNode=${encodeURIComponent(cursor.nodeId)}&afterEvent=${cursor.eventSequence}&afterInquiry=${cursor.inquirySequence}`,
    );
    expect(delta.status).toBe(200);
    expect(delta.body).toMatchObject({
      view: "delta",
      relation: "descendant",
      path: [{ commandId: "command:sorry", transitionClass: "equivalence" }],
      delta: { goals: { removed: [full.body.aliases.goals[0].id] } },
    });

    expect((await client.observe("?view=delta")).status).toBe(400);
    expect((await client.observe("?view=full&sinceNode=node:x")).status).toBe(400);
    expect((await client.observe("?view=delta&sinceNode=node:missing")).status).toBe(404);
  });
});
