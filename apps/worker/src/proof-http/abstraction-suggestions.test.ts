import { afterEach, describe, expect, it } from "vitest";
import { createProofNodeSchema, type DisplayedSuggestionSet } from "@proof/protocol";
import { initializeProofSession } from "../proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore } from "../memory-proof-store.testing";
import { createProofHttpService, type ProofHttpService } from ".";

/** N33: an abstract selection is a typed, retrieval-only wildcard on the suggestion request. */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const SESSION_ID = "session:abstraction";
const STATE_ID = "state:abstraction-root";
const PROPOSITION = { kind: "proposition" } as const;
const NATURAL = { kind: "named", id: "sort:natural" } as const;

async function start() {
  const store = new MemoryProofStore();
  const rootNode = createProofNodeSchema().parse({
    id: "node:abstraction-root",
    state: {
      id: STATE_ID,
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: ["p", "q"].map((symbol) => ({
                id: `declaration:${symbol}`,
                symbol,
                sort: PROPOSITION,
                role: "universal-parameter",
              })),
              hypotheses: [{ id: "hypothesis:p", statement: { expression: "p" } }],
            },
            conclusion: { expression: "q" },
          },
        },
      ],
      obligations: [],
    },
  });
  expect(await initializeProofSession(store, { sessionId: SESSION_ID, rootNode })).toMatchObject({
    status: "committed",
  });
  const service = createProofHttpService(store);
  services.push(service);
  const { origin } = await service.listen();
  const url = `${origin}/proof-sessions/${SESSION_ID}/suggestion-sets`;
  return {
    store,
    post: (body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    get: (id: string) => fetch(`${url}/${encodeURIComponent(id)}`),
  };
}

function at(statement: "conclusion" | string, extra: Record<string, unknown> = {}) {
  return {
    kind: "exact",
    anchor: {
      stateId: STATE_ID,
      target: { kind: "goal", id: "goal:main" },
      statement:
        statement === "conclusion" ? { kind: "conclusion" } : { kind: "hypothesis", id: statement },
    },
    path: [],
    ...extra,
  };
}

const wildcard = (sort?: unknown) => ({
  id: "wildcard:request-1",
  symbol: "_a1",
  role: "retrieval-wildcard",
  ...(sort === undefined ? {} : { sort }),
});

type SetBody = Readonly<{ suggestionSet: DisplayedSuggestionSet }>;

describe("abstract selections on suggestion requests", () => {
  it("matches only the abstract query, records it, and re-reads it faithfully", async () => {
    const h = await start();
    const concrete = await h.post({
      id: "suggestion-set:concrete",
      selections: [at("hypothesis:p"), at("conclusion")],
    });
    expect(concrete.status).toBe(201);
    const concreteSet = ((await concrete.json()) as SetBody).suggestionSet;
    expect(
      concreteSet.suggestions.filter(({ abstractionFit }) => abstractionFit !== "not-used"),
    ).toEqual([]);

    const abstract = await h.post({
      id: "suggestion-set:abstract",
      selections: [at("hypothesis:p"), at("conclusion", { abstraction: wildcard(PROPOSITION) })],
    });
    expect(abstract.status).toBe(201);
    const set = ((await abstract.json()) as SetBody).suggestionSet;
    const abstractMatches = set.suggestions.filter(
      ({ abstractionFit }) => abstractionFit !== "not-used",
    );
    expect(abstractMatches.map(({ artifactId }) => artifactId)).toContain(
      "move:close-by-hypothesis",
    );
    expect(set.selection).toMatchObject({
      kind: "selection-query",
      selections: [
        { id: "selection:request-1", selection: { fragment: "p" } },
        {
          id: "selection:request-2",
          selection: { fragment: "q" },
          abstraction: { id: "wildcard:request-1", sort: PROPOSITION },
        },
      ],
    });

    // History is static: the stored set records the abstraction and re-reads identically.
    const reread = await h.get("suggestion-set:abstract");
    expect(reread.status).toBe(200);
    expect(((await reread.json()) as SetBody).suggestionSet).toEqual(set);
  });

  it("records a single sorted abstract selection as a selection query with compatible matches", async () => {
    const h = await start();
    const response = await h.post({
      id: "suggestion-set:single",
      selections: [at("conclusion", { abstraction: wildcard(PROPOSITION) })],
    });
    expect(response.status).toBe(201);
    const set = ((await response.json()) as SetBody).suggestionSet;
    expect(set.suggestions.length).toBeGreaterThan(0);
    expect(set.suggestions.every(({ abstractionFit }) => abstractionFit === "compatible")).toBe(
      true,
    );
    expect(set.suggestions.every(({ applicability }) => applicability === "requires-input")).toBe(
      true,
    );
    expect(set.selection).toMatchObject({
      kind: "selection-query",
      selections: [{ id: "selection:request-1", abstraction: { symbol: "_a1" } }],
    });
  });

  it("rejects an abstraction whose sort differs from the occurrence", async () => {
    const h = await start();
    const response = await h.post({
      id: "suggestion-set:mismatch",
      selections: [at("conclusion", { abstraction: wildcard(NATURAL) })],
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { diagnostics: { message: string }[] };
    expect(body.diagnostics[0]?.message).toMatch(/does not match the selected proposition/);
    expect(h.store.suggestionSets.size).toBe(0);
  });

  it("rejects a malformed abstraction", async () => {
    const h = await start();
    const response = await h.post({
      id: "suggestion-set:malformed",
      selections: [at("conclusion", { abstraction: { id: "wildcard:x", role: "universal" } })],
    });
    expect(response.status).toBe(400);
  });
});
