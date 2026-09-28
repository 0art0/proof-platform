import { afterEach, describe, expect, it } from "vitest";
import {
  createProofNodeSchema,
  inquiryRecordListSchema,
  type DisplayedSuggestionSet,
  type InquiryRecord,
  type ProofNode,
} from "@proof/protocol";
import { DEVELOPMENT_PROOF_SESSION_ID, DEVELOPMENT_ROOT_NODE } from "../development-session";
import { listInquiryRecords, recordInquiryCommand } from "../inquiry-repository";
import { initializeProofSession } from "../proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore } from "../memory-proof-store.testing";
import { createProofHttpService, type ProofHttpService } from ".";

/**
 * N22 acceptance (refinement §3–§4): inquiry records go through one validated, idempotent command
 * path, reference stored proof nodes instead of copying mathematics, keep logical claims
 * supported, and never present a later interpretation as a contemporaneous reason.
 */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const SPLIT = "move:split-goal-conjunction";
const ROOT_NODE_ID = "node:development-root";
const MAIN_GOAL = { kind: "goal", id: "goal:development-main" } as const;
const FIXED_NOW = () => new Date("2026-09-27T12:00:00.000Z");

const binaryRoot = createProofNodeSchema().parse({
  ...DEVELOPMENT_ROOT_NODE,
  state: {
    ...DEVELOPMENT_ROOT_NODE.state,
    goals: [
      {
        ...DEVELOPMENT_ROOT_NODE.state.goals[0],
        sequent: {
          ...DEVELOPMENT_ROOT_NODE.state.goals[0]?.sequent,
          conclusion: { expression: ["And", "p", "q"] },
        },
      },
    ],
  },
});

type Harness = Readonly<{
  store: MemoryProofStore;
  post(path: string, body: unknown): Promise<Response>;
  get(path: string): Promise<Response>;
}>;

async function harness(): Promise<Harness> {
  const store = new MemoryProofStore();
  expect(
    await initializeProofSession(store, {
      sessionId: DEVELOPMENT_PROOF_SESSION_ID,
      rootNode: binaryRoot,
    }),
  ).toMatchObject({ status: "committed" });
  const service = createProofHttpService(store, { now: FIXED_NOW });
  services.push(service);
  const { origin } = await service.listen();
  const sessionUrl = `${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}`;
  return {
    store,
    post: (path, body) =>
      fetch(`${sessionUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    get: (path) => fetch(`${sessionUrl}${path}`),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function displayedSplit(h: Harness): Promise<Readonly<{ setId: string; splitId: string }>> {
  const response = await h.post("/suggestion-sets", {
    id: "suggestion-set:inquiry",
    selections: [
      {
        kind: "exact",
        anchor: {
          stateId: "state:development-root",
          target: MAIN_GOAL,
          statement: { kind: "conclusion" },
        },
        path: [],
      },
    ],
  });
  expect(response.status).toBe(201);
  const set = (await json(response)).suggestionSet as DisplayedSuggestionSet;
  const split = set.suggestions.find(({ artifactId }) => artifactId === SPLIT);
  if (split === undefined) throw new Error("Expected the split suggestion to be displayed.");
  return { setId: set.id, splitId: split.id };
}

async function records(h: Harness, query = ""): Promise<InquiryRecord[]> {
  const response = await h.get(`/inquiry-records${query}`);
  expect(response.status).toBe(200);
  const body = await json(response);
  expect(inquiryRecordListSchema.safeParse(body.records).success).toBe(true);
  return body.records as InquiryRecord[];
}

const target = (nodeId: string, reference: Readonly<{ kind: string; id: string }>) => ({
  kind: "target",
  nodeId,
  target: reference,
});

/** Establish the main goal, pursue it as a required objective, and try the displayed split. */
async function openingCommand(h: Harness) {
  const { setId, splitId } = await displayedSplit(h);
  const command = {
    commandId: "inquiry:opening",
    nodeId: ROOT_NODE_ID,
    records: [
      {
        id: "question:main",
        kind: "question",
        question: { form: "establish", proposition: target(ROOT_NODE_ID, MAIN_GOAL) },
      },
      {
        id: "objective:main",
        kind: "objective",
        questionId: "question:main",
        necessity: "required",
        focus: { nodeId: ROOT_NODE_ID, target: MAIN_GOAL },
      },
      {
        id: "attempt:split",
        kind: "attempt",
        objectiveId: "objective:main",
        method: { kind: "move", moveId: SPLIT },
        suggestion: { suggestionSetId: setId, suggestionId: splitId },
      },
      {
        id: "decision:split",
        kind: "decision",
        subjectId: "objective:main",
        selected: { kind: "record", recordId: "attempt:split" },
        reason: { provenance: "explicit-user", note: "Conjunctions split cleanly." },
      },
    ],
  };
  const choice = {
    commandId: "command:inquiry-split",
    suggestionSetId: setId,
    chosenSuggestionId: splitId,
  };
  return { command, choice };
}

async function appliedSplit(h: Harness, choice: unknown): Promise<ProofNode> {
  const applied = await h.post("/commands", choice);
  expect(applied.status).toBe(201);
  return (await json(applied)).node as ProofNode;
}

describe("inquiry commands over HTTP", () => {
  it("records a command atomically with worker-assigned sequence, anchor and actor", async () => {
    const h = await harness();
    const { command } = await openingCommand(h);
    const response = await h.post("/inquiry-commands", command);
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.replayed).toBe(false);
    const recorded = body.records as InquiryRecord[];
    expect(recorded.map(({ id, sequence, kind }) => [id, sequence, kind])).toEqual([
      ["question:main", 1, "question"],
      ["objective:main", 2, "objective"],
      ["attempt:split", 3, "attempt"],
      ["decision:split", 4, "decision"],
    ]);
    for (const record of recorded) {
      expect(record).toMatchObject({
        commandId: "inquiry:opening",
        nodeId: ROOT_NODE_ID,
        stateId: "state:development-root",
        actor: { id: "actor:web", kind: "human" },
        recordedAt: "2026-09-27T12:00:00.000Z",
      });
    }
    // The question refers to the goal; no MathJSON is copied into the record.
    expect(JSON.stringify(recorded)).not.toContain('"And"');
    expect(await records(h)).toEqual(recorded);
  });

  it("replays an identical retry and rejects different content under the same IDs", async () => {
    const h = await harness();
    const { command } = await openingCommand(h);
    expect((await h.post("/inquiry-commands", command)).status).toBe(201);
    const replay = await h.post("/inquiry-commands", command);
    expect(replay.status).toBe(200);
    expect((await json(replay)).replayed).toBe(true);

    const changed = await h.post("/inquiry-commands", {
      ...command,
      records: command.records.slice(0, 3),
    });
    expect(changed.status).toBe(409);
    expect(await json(changed)).toMatchObject({
      diagnostics: [{ code: "inquiry-command-conflict" }],
    });
    const reusedId = await h.post("/inquiry-commands", {
      commandId: "inquiry:other",
      nodeId: ROOT_NODE_ID,
      records: [{ id: "question:main", kind: "observation", note: "Reused ID." }],
    });
    expect(reusedId.status).toBe(409);
    expect(await records(h)).toHaveLength(4);
  });

  it("validates references against stored data and records nothing on rejection", async () => {
    const h = await harness();
    const rejected = async (records: unknown[], code = "inquiry-command-rejected") => {
      const response = await h.post("/inquiry-commands", {
        commandId: "inquiry:bad",
        nodeId: ROOT_NODE_ID,
        records,
      });
      expect(response.status).toBe(400);
      expect(await json(response)).toMatchObject({ diagnostics: [{ code }] });
    };
    await rejected([
      {
        id: "question:x",
        kind: "question",
        question: { form: "establish", proposition: target("node:missing", MAIN_GOAL) },
      },
    ]);
    await rejected([
      {
        id: "question:x",
        kind: "question",
        question: {
          form: "establish",
          proposition: target(ROOT_NODE_ID, { kind: "obligation", id: "goal:development-main" }),
        },
      },
    ]);
    await rejected([
      {
        id: "question:x",
        kind: "question",
        question: { form: "determine", proposition: target(ROOT_NODE_ID, MAIN_GOAL) },
      },
      // Determine is elective: it never becomes something the proof requires.
      {
        id: "objective:x",
        kind: "objective",
        questionId: "question:x",
        necessity: "required",
        focus: { nodeId: ROOT_NODE_ID, target: MAIN_GOAL },
      },
    ]);
    await rejected([
      { id: "objective:x", kind: "objective", questionId: "question:none", necessity: "elective" },
    ]);
    const unknownAnchor = await h.post("/inquiry-commands", {
      commandId: "inquiry:bad",
      nodeId: "node:missing",
      records: [{ id: "observation:x", kind: "observation", note: "Nowhere." }],
    });
    expect(unknownAnchor.status).toBe(400);
    const malformed = await h.post("/inquiry-commands", {
      commandId: "inquiry:bad",
      nodeId: ROOT_NODE_ID,
      records: [
        {
          id: "relationship:x",
          kind: "relationship",
          relation: "wouldSufficeFor",
          from: ["a"],
          to: "b",
        },
      ],
    });
    expect(malformed.status).toBe(400);
    expect(await records(h)).toEqual([]);
  });

  it("accepts wouldSufficeFor only with evidence that really establishes it", async () => {
    const h = await harness();
    const { command, choice } = await openingCommand(h);
    expect((await h.post("/inquiry-commands", command)).status).toBe(201);
    const child = await appliedSplit(h, choice);
    const childGoals = child.state.goals.map(({ id }) => id);
    expect(childGoals.length).toBe(2);
    const premises = childGoals.map((id, index) => ({
      id: `question:premise-${index}`,
      kind: "question",
      question: { form: "establish", proposition: target(child.id, { kind: "goal", id }) },
    }));
    const suffices = (from: string[]) => ({
      id: "relationship:suffices",
      kind: "relationship",
      relation: "wouldSufficeFor",
      from,
      to: "question:main",
      support: { kind: "transition", childNodeId: child.id },
    });
    const partial = await h.post("/inquiry-commands", {
      commandId: "inquiry:premises",
      nodeId: child.id,
      records: [...premises, suffices(["question:premise-0"])],
    });
    expect(partial.status).toBe(400);
    expect(await json(partial)).toMatchObject({
      diagnostics: [{ message: expect.stringContaining("every target the transition created") }],
    });
    const complete = await h.post("/inquiry-commands", {
      commandId: "inquiry:premises",
      nodeId: child.id,
      records: [...premises, suffices(["question:premise-0", "question:premise-1"])],
    });
    expect(complete.status).toBe(201);
    expect((await records(h, `?nodeId=${child.id}`)).map(({ id }) => id)).toEqual([
      "question:premise-0",
      "question:premise-1",
      "relationship:suffices",
    ]);
  });

  it("records later interpretations only about earlier commands", async () => {
    const h = await harness();
    const { command } = await openingCommand(h);
    expect((await h.post("/inquiry-commands", command)).status).toBe(201);
    const observation = {
      id: "observation:and",
      kind: "observation",
      references: [target(ROOT_NODE_ID, MAIN_GOAL)],
      note: "The goal is a conjunction.",
    };
    const motivated = (provenance: string) => ({
      id: "relationship:why",
      kind: "relationship",
      relation: "motivatedBy",
      from: ["attempt:split"],
      to: "observation:and",
      reason: { provenance, basisIds: ["observation:and"] },
    });
    const backdated = await h.post("/inquiry-commands", {
      commandId: "inquiry:why",
      nodeId: ROOT_NODE_ID,
      records: [observation, motivated("explicit-user")],
    });
    expect(backdated.status).toBe(400);
    expect(await json(backdated)).toMatchObject({
      diagnostics: [{ message: expect.stringContaining("later interpretation") }],
    });
    const interpreted = await h.post("/inquiry-commands", {
      commandId: "inquiry:why",
      nodeId: ROOT_NODE_ID,
      records: [observation, motivated("later-interpretation")],
    });
    expect(interpreted.status).toBe(201);
    // The web actor is human; it cannot record an agent's reason.
    const agentReason = await h.post("/inquiry-commands", {
      commandId: "inquiry:agent",
      nodeId: ROOT_NODE_ID,
      records: [
        {
          id: "status:1",
          kind: "status-change",
          subjectId: "attempt:split",
          status: "blocked",
          reason: { provenance: "agent" },
        },
      ],
    });
    expect(agentReason.status).toBe(400);
  });

  it("changes status only by explicit transitions and lists records by query", async () => {
    const h = await harness();
    const { command } = await openingCommand(h);
    expect((await h.post("/inquiry-commands", command)).status).toBe(201);
    const status = (id: string, value: string) => ({
      commandId: `inquiry:${id}`,
      nodeId: ROOT_NODE_ID,
      records: [{ id, kind: "status-change", subjectId: "attempt:split", status: value }],
    });
    expect((await h.post("/inquiry-commands", status("status:1", "blocked"))).status).toBe(201);
    expect((await h.post("/inquiry-commands", status("status:2", "blocked"))).status).toBe(400);
    expect((await h.post("/inquiry-commands", status("status:2", "achieved"))).status).toBe(400);
    expect((await h.post("/inquiry-commands", status("status:2", "abandoned"))).status).toBe(201);

    expect((await records(h, "?after=4")).map(({ id }) => id)).toEqual(["status:1", "status:2"]);
    expect((await records(h, "?limit=1")).map(({ id }) => id)).toEqual(["question:main"]);
    expect((await records(h, "?commandId=inquiry:status:2")).map(({ id }) => id)).toEqual([
      "status:2",
    ]);
    for (const query of ["?after=-1", "?limit=0", "?other=1", "?after=1&after=2"]) {
      expect((await h.get(`/inquiry-records${query}`)).status).toBe(400);
    }
    const wrongMethod = await h.get("/inquiry-commands");
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    const wrongListMethod = await h.post("/inquiry-records", {});
    expect(wrongListMethod.status).toBe(405);
    expect(wrongListMethod.headers.get("allow")).toBe("GET");
  });

  it("removes records of deleted work and their dependents with the deleted move", async () => {
    const h = await harness();
    const { command, choice } = await openingCommand(h);
    expect((await h.post("/inquiry-commands", command)).status).toBe(201);
    const child = await appliedSplit(h, choice);
    const [left] = child.state.goals;
    if (left === undefined) throw new Error("Expected a child goal.");
    expect(
      (
        await h.post("/inquiry-commands", {
          commandId: "inquiry:child",
          nodeId: ROOT_NODE_ID,
          records: [
            {
              id: "observation:left",
              kind: "observation",
              references: [target(child.id, { kind: "goal", id: left.id })],
            },
            {
              id: "obstruction:left",
              kind: "obstruction",
              attemptId: "attempt:split",
              cause: { kind: "observation", observationId: "observation:left" },
            },
          ],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await h.post("/inquiry-commands", {
          commandId: "inquiry:root-note",
          nodeId: ROOT_NODE_ID,
          records: [{ id: "observation:root", kind: "observation", note: "Still relevant." }],
        })
      ).status,
    ).toBe(201);
    const deleted = await h.post("/delete-previous-move", {
      commandId: "command:inquiry-undo",
      expectedCurrentNodeId: child.id,
    });
    expect(deleted.status).toBe(200);
    expect((await records(h)).map(({ id }) => id)).toEqual([
      "question:main",
      "objective:main",
      "attempt:split",
      "decision:split",
      "observation:root",
    ]);
    expect([...h.store.inquiryRecords.values()].map(({ id }) => id)).not.toContain(
      "obstruction:left",
    );
  });
});

describe("inquiry commands through the repository", () => {
  it("stores agent-provenance records with the agent actor and no model involvement", async () => {
    const h = await harness();
    const agent = { id: "actor:agent", kind: "agent" } as const;
    const request = {
      commandId: "inquiry:agent",
      nodeId: ROOT_NODE_ID,
      records: [
        {
          id: "question:agent",
          kind: "question",
          question: {
            form: "explore",
            objects: [target(ROOT_NODE_ID, MAIN_GOAL)],
            aspect: "structure",
          },
        },
        {
          id: "decision:agent",
          kind: "decision",
          selected: { kind: "record", recordId: "question:agent" },
          reason: { provenance: "agent" },
        },
      ],
    };
    const recorded = await recordInquiryCommand(
      h.store,
      DEVELOPMENT_PROOF_SESSION_ID,
      request,
      agent,
      { now: FIXED_NOW },
    );
    expect(recorded).toMatchObject({ status: "committed", replayed: false });
    // The same records under a human actor are a conflicting retry, not a replay.
    expect(
      await recordInquiryCommand(h.store, DEVELOPMENT_PROOF_SESSION_ID, request, {
        id: "actor:web",
        kind: "human",
      }),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "inquiry-command-conflict" }] });
    const listed = await listInquiryRecords(h.store, DEVELOPMENT_PROOF_SESSION_ID);
    expect(listed.status === "loaded" && listed.records.map(({ actor }) => actor)).toEqual([
      agent,
      agent,
    ]);
    expect(
      await recordInquiryCommand(
        h.store,
        DEVELOPMENT_PROOF_SESSION_ID,
        {
          ...request,
          commandId: "inquiry:agent-2",
          records: [
            { ...request.records[1], id: "decision:2", reason: { provenance: "explicit-user" } },
          ],
        },
        agent,
      ),
    ).toMatchObject({ status: "rejected", diagnostics: [{ code: "inquiry-command-rejected" }] });
  });

  it("rejects stored records that fail validation instead of trusting them", async () => {
    const h = await harness();
    const { command } = await openingCommand(h);
    expect((await h.post("/inquiry-commands", command)).status).toBe(201);
    const [key, record] = [...h.store.inquiryRecords.entries()][0]!;
    h.store.inquiryRecords.set(key, { ...record, extra: true } as unknown as InquiryRecord);
    const listed = await h.get("/inquiry-records");
    expect(listed.status).toBe(500);
    expect(await json(listed)).toMatchObject({ diagnostics: [{ code: "invalid-inquiry-record" }] });
  });
});
