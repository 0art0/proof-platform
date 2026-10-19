import { afterEach, describe, expect, it } from "vitest";
import { createAiLimiter } from "./ai-rate-limit";
import {
  ANY_PROPOSITION,
  PROBLEM,
  backgroundRuntime,
  closeServices,
  conclusionSelection,
  json,
  libraryOutput,
  post,
  running,
  suggest,
  wireResult,
  type DisplayedSet,
} from "./ai-library.testing";
import {
  SESSION,
  SESSION_URL,
  events,
  librarianContext,
  topUp,
  topUpScenario,
} from "./ai-library-top-up.testing";

afterEach(closeServices);

/**
 * The `no-relevant-results` top-up and the behaviour every top-up shares: the abstracted
 * description of the user's selections (design plan section 15.3), the cost guard, disabled and
 * read-only refusals, and recorded provider failures.
 */

/** Equal integers divide each other: a backward result for the goal that the library did not have. */
const DIVIDES_FROM_EQUAL = wireResult("divides-from-equal", {
  premises: [["Equal", "a", "b"]],
  statement: ["Divides", "a", "b"],
  applicationDirections: ["backward"],
  patterns: [
    {
      expression: ["Divides", "a", "b"],
      direction: "backward",
      section: "goal",
      polarity: "positive",
      role: "proposition",
    },
  ],
});
/** The packs already hold this one, under other parameter names. */
const TRANSITIVITY_AGAIN = wireResult("transitivity-again", {
  parameters: ["x", "y", "z"].map((symbol) => ({ symbol, sort: "integer" })),
  premises: [
    ["Divides", "x", "y"],
    ["Divides", "y", "z"],
  ],
  statement: ["Divides", "x", "z"],
  patterns: [{ expression: ["Divides", "x", "y"], direction: "forward", ...ANY_PROPOSITION }],
});
/** Reuses the identifier of the result in the session library. */
const SAME_SLUG = wireResult("gcd-divides", { statement: ["Divides", "a", "a"] });

const request = {
  id: "llm-call:find-1",
  kind: "no-relevant-results",
  selections: [conclusionSelection],
};

const proofTime = (all: Awaited<ReturnType<typeof events>>) =>
  all.filter(({ layer }) => layer === "proof-time-background");

describe("no-relevant-results top-up", () => {
  it("sees only the abstracted selection, admits what the gate admits, and offers it next time", async () => {
    const { origin, topUps } = await topUpScenario(() =>
      libraryOutput([DIVIDES_FROM_EQUAL, TRANSITIVITY_AGAIN, SAME_SLUG]),
    );
    const earlier = await suggest(origin, SESSION, "suggestion-set:earlier");
    expect(earlier.suggestions.map(({ artifactId }) => artifactId)).not.toContain(
      "result:library-divides-from-equal",
    );

    const { response, body } = await topUp(origin, request);
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ status: "topped-up", requestKind: "no-relevant-results" });
    expect(body).not.toHaveProperty("coveredConstants");
    expect(body.added.map((entry: { id: string }) => entry.id)).toEqual([
      "result:library-divides-from-equal",
    ]);
    const codes = new Map<string, string[]>(
      body.rejected.map((item: { id: string; codes: string[] }) => [item.id, item.codes]),
    );
    expect(codes.get("result:library-transitivity-again")).toEqual(["duplicate-statement"]);
    expect(codes.get("result:library-gcd-divides")).toEqual(["duplicate-id"]);

    // The context holds the active constants, the library, and the shape of the selection.
    expect(topUps).toHaveLength(1);
    const seen = librarianContext(topUps[0]!);
    if (seen.kind !== "no-relevant-results") throw new Error("Expected a situation context.");
    expect(Object.keys(seen).sort()).toEqual([
      "background",
      "constants",
      "existingResults",
      "kind",
      "situation",
    ]);
    expect(seen.constants.map(({ symbol }) => symbol)).toEqual(["Divides", "Coprime"]);
    expect(seen.situation).toEqual({
      selections: [
        {
          expression: ["Divides", "x1", "x2"],
          variables: [
            { symbol: "x1", sort: { kind: "named", id: "sort:integer" } },
            { symbol: "x2", sort: { kind: "named", id: "sort:integer" } },
          ],
          position: { polarity: "positive", role: "proposition" },
        },
      ],
    });
    expect(Object.keys(seen.situation.selections[0]!).sort()).toEqual([
      "expression",
      "position",
      "variables",
    ]);
    // Never the problem, the proof's identifiers, its history, its other goals or any suggestion.
    const prompt = topUps[0]!.messages[1].content;
    for (const hidden of [
      PROBLEM.title,
      PROBLEM.statement,
      SESSION,
      "node:root",
      "state:root",
      "goal:1",
      "suggestion",
      "hypothes",
      "history",
      "obligation",
    ]) {
      expect(prompt, hidden).not.toContain(hidden);
    }
    expect(JSON.stringify(seen.situation)).not.toMatch(/"(m|n)"/);

    // Earlier menus are stored exactly as displayed; asking again uses the enlarged library.
    const stored = await json<{ suggestionSet: DisplayedSet }>(
      await fetch(`${origin}${SESSION_URL}/suggestion-sets/${encodeURIComponent(earlier.id)}`),
    );
    expect(stored.suggestionSet).toEqual(earlier);
    const later = await suggest(origin, SESSION, "suggestion-set:later");
    expect(later.suggestions.map(({ artifactId }) => artifactId)).toContain(
      "result:library-divides-from-equal",
    );
    // The result and its generated variant are recorded as ordinary additions of the session.
    const recorded = proofTime(await events(origin));
    expect(recorded.map(({ artifact }) => artifact.id)).toEqual([
      "result:library-divides-from-equal",
      "result:library-divides-from-equal/contrapositive",
    ]);
    for (const event of recorded) {
      expect(event.origin).toEqual({ kind: "service", actorId: "llm-call:find-1" });
      expect(event.artifact.approval).toEqual({
        status: "approved",
        reviewerId: "service:library-gate",
      });
    }
  });

  it("describes related fragments with one set of neutral names", async () => {
    const { origin, topUps } = await topUpScenario(
      () => libraryOutput([DIVIDES_FROM_EQUAL]),
      {},
      { goals: [{ format: "latex", latex: String.raw`m \mid n \land n \mid m` }] },
    );
    const first = { ...conclusionSelection, path: [0] };
    const second = { ...conclusionSelection, path: [1] };
    const { response } = await topUp(origin, { ...request, selections: [second, first] });
    expect(response.status).toBe(201);
    const seen = librarianContext(topUps[0]!);
    if (seen.kind !== "no-relevant-results") throw new Error("Expected a situation context.");
    // `n | m` is selected first, so n becomes x1 in both fragments.
    expect(seen.situation.selections.map(({ expression }) => expression)).toEqual([
      ["Divides", "x1", "x2"],
      ["Divides", "x2", "x1"],
    ]);
  });

  it("refuses stale, moved, malformed and forbidden requests before any provider call", async () => {
    const { origin, topUps, store } = await topUpScenario();
    const wildcard = { id: "wildcard:w", symbol: "w", role: "retrieval-wildcard" };
    const oldSnapshot = {
      ...conclusionSelection,
      anchor: { ...conclusionSelection.anchor, stateId: "state:old" },
    };
    const refusals: [string, Record<string, unknown>, number][] = [
      ["a selection of another snapshot", { ...request, selections: [oldSnapshot] }, 409],
      ["a proof that moved on", { ...request, expectedCurrentNodeId: "node:elsewhere" }, 409],
      [
        "an abstraction",
        { ...request, selections: [{ ...conclusionSelection, abstraction: wildcard }] },
        400,
      ],
      ["no selection", { id: request.id, kind: request.kind }, 400],
      ["an empty selection list", { ...request, selections: [] }, 400],
      ["constants on a situation request", { ...request, constants: ["Gcd"] }, 400],
      [
        "a client-supplied constant",
        { id: "llm-call:x", kind: "new-constants", newConstants: [] },
        400,
      ],
      [
        "a declaration instead of a symbol",
        { id: "llm-call:x", kind: "new-constants", constants: [{ symbol: "Gcd" }] },
        400,
      ],
      ["the initial kind", { ...request, kind: "initial" }, 400],
      ["an extra field", { ...request, problem: PROBLEM.statement }, 400],
      [
        "a selection outside the proof",
        { ...request, selections: [{ ...conclusionSelection, path: [9] }] },
        400,
      ],
    ];
    for (const [label, body, status] of refusals) {
      const refused = await topUp(origin, body);
      expect(refused.response.status, `${label}: ${JSON.stringify(refused.body)}`).toBe(status);
    }
    expect(topUps).toHaveLength(0);

    const missing = await post(origin, "/proof-sessions/session%3Anone/ai/library/top-up", request);
    expect(missing.status).toBe(404);

    // A read-only session's library cannot grow.
    await store.transaction(async (transaction) => {
      expect(await transaction.markSessionReadOnly(SESSION as never)).toBe(true);
    });
    const readOnly = await topUp(origin, request);
    expect(readOnly.response.status).toBe(409);
    expect(readOnly.body).toMatchObject({
      status: "read-only",
      diagnostics: [{ code: "session-read-only" }],
    });
    expect(topUps).toHaveLength(0);
  });

  it("asks for nothing when the session's background cannot admit a result", async () => {
    const { origin, topUps } = await topUpScenario(
      undefined,
      {},
      {
        background: {
          level: "first-year undergraduate",
          summary: "Number theory.",
          assumptions: [],
        },
      },
    );
    const { response, body } = await topUp(origin, request);
    expect(response.status).toBe(409);
    expect(body.diagnostics[0].code).toBe("background-undeclared");
    expect(topUps).toHaveLength(0);
  });
});

describe("top-up provider and cost guard", () => {
  it("answers 503 when the librarian, evidence or library storage is not available", async () => {
    const url = "/proof-sessions/session%3Anone/ai/library/top-up";
    const withoutRole = await running({});
    const disabled = await post(withoutRole.origin, url, request);
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({
      status: "disabled",
      diagnostics: [{ code: "ai-disabled" }],
    });
    const runtime = backgroundRuntime(async () => libraryOutput());
    const withoutEvidence = await running({ ai: runtime, calls: null });
    expect((await post(withoutEvidence.origin, url, request)).status).toBe(503);
    const withoutLibrary = await running({ ai: runtime, library: false });
    expect((await post(withoutLibrary.origin, url, request)).status).toBe(503);
  });

  it("shares the cost guard: 429 with Retry-After, replays free, recovery with the clock", async () => {
    let now = 1_000_000;
    // The background proposal and the initial library spent two of the three tokens.
    const { origin, topUps } = await topUpScenario(() => libraryOutput([DIVIDES_FROM_EQUAL]), {
      aiLimiter: createAiLimiter({ maxConcurrent: 2, ratePerMinute: 3, nowMs: () => now }),
    });
    expect((await topUp(origin, request)).response.status).toBe(201);
    const limited = await topUp(origin, { ...request, id: "llm-call:find-2" });
    expect(limited.response.status).toBe(429);
    expect(Number(limited.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(limited.body).toMatchObject({
      status: "rate-limited",
      diagnostics: [{ code: "ai-rate-limited" }],
    });
    expect(topUps).toHaveLength(1);
    const replay = await topUp(origin, request);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true });
    expect(topUps).toHaveLength(1);
    now += 120_000;
    expect((await topUp(origin, { ...request, id: "llm-call:find-2" })).response.status).toBe(200);
    expect(topUps).toHaveLength(2);
  });

  it("records a provider failure as 503 and an invalid answer as 422, adding nothing", async () => {
    let attempt = 0;
    const { origin } = await topUpScenario(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("provider down");
      return { result: { kind: "library-proposal", results: "not a list" } };
    });
    const failed = await topUp(origin, request);
    expect(failed.response.status).toBe(503);
    const invalid = await topUp(origin, { ...request, id: "llm-call:find-2" });
    expect(invalid.response.status).toBe(422);
    expect(invalid.body).toMatchObject({ status: "rejected" });
    expect(proofTime(await events(origin))).toEqual([]);
    const evidence = await json<{ records: { id: string; evidence: { status: string } }[] }>(
      await fetch(`${origin}${SESSION_URL}/llm-calls`),
    );
    expect(evidence.records.map(({ id, evidence: { status } }) => [id, status])).toEqual([
      ["llm-call:find-1", "transport-failed"],
      ["llm-call:find-2", "rejected"],
    ]);
  });
});
