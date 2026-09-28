import { afterEach, describe, expect, it } from "vitest";
import { CORE_LOGIC_RESULTS, libraryResultSchema } from "@proof/library";
import { PROPOSITION_SORT } from "@proof/mathjson-model";
import { HAND_AUTHORED_MOVES } from "@proof/moves";
import {
  createProofNodeSchema,
  inquiryRecordListSchema,
  type DisplayedSuggestionSet,
  type InquiryRecord,
} from "@proof/protocol";
import { adaptApprovedCatalog, type DefinitionCatalog } from "../approved-catalog";
import { initializeProofSession } from "../proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore } from "../memory-proof-store.testing";
import { createProofHttpService, type ProofHttpService } from ".";

/**
 * N24 over HTTP: `POST /commands` with `inquiryMethod: "try-result"` applies a result suggestion
 * as "Try this theorem" and returns the inquiry records recorded with it; `POST
 * /hypothesis-investigations` records "Investigate this hypothesis".
 */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const SESSION = "session:http-methods";
const MAIN = { kind: "goal", id: "goal:main" } as const;
const RESULT_ID = "result:test-conjunction-introduction";

const proposition = (symbol: string) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
});

const DEFINITIONS: DefinitionCatalog = {
  moves: HAND_AUTHORED_MOVES,
  catalog: (operators) =>
    adaptApprovedCatalog(operators, [
      ...CORE_LOGIC_RESULTS,
      libraryResultSchema.parse({
        kind: "result",
        id: RESULT_ID,
        name: "Conjunction introduction",
        description: "Both conjuncts establish the conjunction.",
        renderings: { latex: String.raw`p,\ q\vdash p\land q`, naturalLanguage: "p, q give p∧q." },
        classification: { domains: ["logic"], level: "foundational" },
        provenance: { kind: "curated", source: "unit test" },
        approval: { status: "approved", reviewerId: "reviewer:test" },
        layer: "global",
        related: [],
        priority: 1,
        parameters: [proposition("p"), proposition("q")],
        statement: { expression: ["And", "p", "q"] },
        premises: [{ expression: "p" }, { expression: "q" }],
        sideConditions: [],
        applicationDirections: ["backward"],
        patterns: [
          {
            id: "pattern:test-conjunction-introduction",
            expression: ["And", "p", "q"],
            direction: "backward",
            requirement: { section: "goal", polarity: "any", role: "proposition" },
          },
        ],
      }),
    ]),
};

type Harness = Readonly<{
  post(path: string, body: unknown): Promise<Response>;
  get(path: string): Promise<Response>;
}>;

async function harness(): Promise<Harness> {
  const store = new MemoryProofStore();
  const root = createProofNodeSchema().parse({
    id: "node:root",
    state: {
      id: "state:root",
      goals: [
        {
          id: MAIN.id,
          sequent: {
            context: {
              declarations: [proposition("p"), proposition("q")],
              hypotheses: [{ id: "hyp:p", statement: { expression: "p" } }],
            },
            conclusion: { expression: ["And", "p", "q"] },
          },
        },
      ],
      obligations: [],
    },
  });
  expect(await initializeProofSession(store, { sessionId: SESSION, rootNode: root })).toMatchObject(
    { status: "committed" },
  );
  const service = createProofHttpService(store, {
    definitions: DEFINITIONS,
    now: () => new Date("2026-09-28T12:00:00.000Z"),
  });
  services.push(service);
  const { origin } = await service.listen();
  const sessionUrl = `${origin}/proof-sessions/${SESSION}`;
  return {
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

async function displayed(h: Harness): Promise<DisplayedSuggestionSet> {
  const response = await h.post("/suggestion-sets", {
    id: "set:main",
    selections: [
      {
        kind: "exact",
        anchor: { stateId: "state:root", target: MAIN, statement: { kind: "conclusion" } },
        path: [],
      },
    ],
  });
  expect(response.status).toBe(201);
  return (await json(response)).suggestionSet as DisplayedSuggestionSet;
}

function suggestionId(set: DisplayedSuggestionSet, artifactId: string): string {
  const found = set.suggestions.find((suggestion) => suggestion.artifactId === artifactId);
  if (found === undefined) throw new Error(`${artifactId} was not displayed`);
  return found.id;
}

describe("Try this theorem over HTTP", () => {
  it("applies the result and returns the attempt, objectives and obstruction; a retry replays", async () => {
    const h = await harness();
    const set = await displayed(h);
    const body = {
      commandId: "command:try",
      suggestionSetId: set.id,
      chosenSuggestionId: suggestionId(set, RESULT_ID),
      inquiryMethod: "try-result",
    };
    const response = await h.post("/commands", body);
    expect(response.status).toBe(201);
    const applied = await json(response);
    const records = applied.inquiryRecords as InquiryRecord[];
    expect(inquiryRecordListSchema.safeParse(records).success).toBe(true);
    expect(records.map(({ kind }) => kind)).toEqual([
      "question",
      "objective",
      "attempt",
      "question",
      "objective",
      "relationship",
      "question",
      "objective",
      "relationship",
      "relationship",
      "observation",
      "obstruction",
      "relationship",
    ]);
    expect(records.find(({ kind }) => kind === "obstruction")).toMatchObject({
      attemptId: "command:try:try-result:attempt",
    });

    const retried = await h.post("/commands", body);
    expect(retried.status).toBe(200);
    expect((await json(retried)).inquiryRecords).toEqual(records);
    const listed = await json(await h.get("/inquiry-records"));
    expect(listed.records).toEqual(records);
  });

  it("omits inquiry records for ordinary commands and rejects a non-result try atomically", async () => {
    const h = await harness();
    const set = await displayed(h);
    const split = {
      commandId: "command:split",
      suggestionSetId: set.id,
      chosenSuggestionId: suggestionId(set, "move:split-goal-conjunction"),
    };
    const rejected = await h.post("/commands", { ...split, inquiryMethod: "try-result" });
    expect(rejected.status).toBe(400);
    expect(await json(rejected)).toMatchObject({
      diagnostics: [{ code: "inquiry-command-rejected" }],
    });
    const history = await json(await h.get("/history"));
    expect(history.edges).toEqual([]);

    const applied = await h.post("/commands", split);
    expect(applied.status).toBe(201);
    expect(await json(applied)).not.toHaveProperty("inquiryRecords");
    expect(await h.post("/commands", { ...split, inquiryMethod: "other" })).toHaveProperty(
      "status",
      400,
    );
  });
});

describe("Investigate this hypothesis over HTTP", () => {
  it("records a Determine question for the target without the hypothesis", async () => {
    const h = await harness();
    const body = {
      commandId: "command:hyp",
      nodeId: "node:root",
      target: MAIN,
      hypothesisId: "hyp:p",
    };
    const response = await h.post("/hypothesis-investigations", body);
    expect(response.status).toBe(201);
    const recorded = await json(response);
    expect(recorded).toMatchObject({
      replayed: false,
      records: [
        {
          kind: "question",
          question: {
            form: "determine",
            proposition: {
              kind: "target",
              nodeId: "node:root",
              target: MAIN,
              withoutHypotheses: ["hyp:p"],
            },
          },
        },
        { kind: "objective", necessity: "elective" },
      ],
    });
    const retried = await h.post("/hypothesis-investigations", body);
    expect(retried.status).toBe(200);
    expect((await json(retried)).records).toEqual(recorded.records);

    const missing = await h.post("/hypothesis-investigations", {
      ...body,
      commandId: "command:missing",
      hypothesisId: "hyp:none",
    });
    expect(missing.status).toBe(400);
    expect((await h.post("/hypothesis-investigations", { ...body, extra: true })).status).toBe(400);
    expect((await h.get("/hypothesis-investigations")).status).toBe(405);
  });
});
