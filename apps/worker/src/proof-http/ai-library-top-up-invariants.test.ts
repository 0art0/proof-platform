import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ANY_PROPOSITION,
  OUTSIDE_BACKGROUND,
  closeServices,
  conclusionSelection,
  json,
  libraryOutput,
  post,
  suggest,
  wireResult,
  type DisplayedSet,
} from "./ai-library.testing";
import { SESSION, SESSION_URL, events, topUp, topUpScenario } from "./ai-library-top-up.testing";

afterEach(closeServices);

/**
 * Invariants of top-up admission: whatever the librarian proposes, a repeated request records
 * nothing twice, a second call proposing the same results adds nothing, the library never holds
 * an identifier twice, and the suggestion menus displayed before the top-up are left exactly as
 * they were (design plan section 12.4).
 */

const BACKWARD_GOAL = {
  direction: "backward",
  section: "goal",
  polarity: "positive",
  role: "proposition",
} as const;

/** Equal integers divide each other. */
const FROM_EQUAL = wireResult("divides-from-equal", {
  premises: [["Equal", "a", "b"]],
  statement: ["Divides", "a", "b"],
  applicationDirections: ["backward"],
  patterns: [{ expression: ["Divides", "a", "b"], ...BACKWARD_GOAL }],
});
const SELF_MULTIPLE = wireResult("divides-self-multiple", {
  statement: ["Divides", "a", ["Multiply", "a", "b"]],
  applicationDirections: ["backward"],
  patterns: [{ expression: ["Divides", "a", ["Multiply", "a", "b"]], ...BACKWARD_GOAL }],
});
const DOUBLE = wireResult("divides-double", {
  premises: [["Divides", "a", "b"]],
  statement: ["Divides", "a", ["Add", "b", "b"]],
  patterns: [{ expression: ["Divides", "a", "b"], direction: "forward", ...ANY_PROPOSITION }],
});
/** Rejected: the packs hold it already. */
const KNOWN = wireResult("known-transitivity", {
  premises: [
    ["Divides", "a", "b"],
    ["Divides", "b", "c"],
  ],
  statement: ["Divides", "a", "c"],
  patterns: [{ expression: ["Divides", "a", "b"], direction: "forward", ...ANY_PROPOSITION }],
});
/** Rejected: an operator nobody declared. */
const UNKNOWN_OPERATOR = wireResult("unknown-operator", {
  statement: ["Equal", ["Foo", "a"], 1],
  patterns: [{ expression: ["Foo", "a"], direction: "forward", ...ANY_PROPOSITION, role: "term" }],
});
const POOL = [FROM_EQUAL, SELF_MULTIPLE, DOUBLE, KNOWN, UNKNOWN_OPERATOR, OUTSIDE_BACKGROUND];

const proofTime = (all: Awaited<ReturnType<typeof events>>) =>
  all.filter(({ layer }) => layer === "proof-time-background");

describe("top-up admission invariants", () => {
  it("is idempotent under replay, never duplicates an identifier, and leaves earlier menus alone", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(POOL, { minLength: 1 }),
        fc.integer({ min: 1, max: 3 }),
        async (proposed, replays) => {
          const { origin, topUps } = await topUpScenario(() => libraryOutput(proposed));
          const earlier = await suggest(origin, SESSION, "suggestion-set:earlier");
          const request = {
            id: "llm-call:find-1",
            kind: "no-relevant-results",
            selections: [conclusionSelection],
          };

          const first = await topUp(origin, request);
          expect([200, 201]).toContain(first.response.status);
          const recorded = proofTime(await events(origin));

          for (let replay = 0; replay < replays; replay += 1) {
            const again = await topUp(origin, request);
            expect(again.response.status).toBe(200);
            expect({ ...again.body, replayed: false }).toEqual(first.body);
            expect(proofTime(await events(origin))).toEqual(recorded);
          }
          expect(topUps).toHaveLength(1);

          // A second call proposing the same results adds nothing: each is a duplicate now.
          const second = await topUp(origin, { ...request, id: "llm-call:find-2" });
          expect(second.body.addedCount).toBe(0);
          expect(proofTime(await events(origin))).toEqual(recorded);

          const ids = (await events(origin))
            .filter(({ admission }) => admission.decision === "admitted")
            .map(({ artifact }) => artifact.id);
          expect(new Set(ids).size).toBe(ids.length);
          expect(first.body.added.map((entry: { id: string }) => entry.id)).toEqual(
            recorded.map(({ artifact }) => artifact.id).filter((id) => !id.includes("/")),
          );

          const stored = await json<{ suggestionSet: DisplayedSet }>(
            await fetch(
              `${origin}${SESSION_URL}/suggestion-sets/${encodeURIComponent(earlier.id)}`,
            ),
          );
          expect(stored.suggestionSet).toEqual(earlier);
          // And the proof still works: a new request displays a valid set.
          const later = await post(origin, `${SESSION_URL}/suggestion-sets`, {
            id: "suggestion-set:later",
            selections: [conclusionSelection],
          });
          expect(later.status).toBe(201);
        },
      ),
      { numRuns: 8 },
    );
  }, 60_000);
});

describe("a session that used top-up results", () => {
  it("exports and imports with the top-up's events and call, replaying the step that applied it", async () => {
    const { origin } = await topUpScenario(() => libraryOutput([FROM_EQUAL]));
    const request = {
      id: "llm-call:find-1",
      kind: "no-relevant-results",
      selections: [conclusionSelection],
    };
    expect((await topUp(origin, request)).response.status).toBe(201);

    // Apply the added result to the goal: the step the importing side has to replay.
    const set = await suggest(origin, SESSION, "suggestion-set:use");
    const chosen = set.suggestions.find(
      ({ artifactId }) => artifactId === "result:library-divides-from-equal",
    );
    expect(chosen).toBeDefined();
    const applied = await post(origin, `${SESSION_URL}/commands`, {
      commandId: "command:use-top-up-result",
      suggestionSetId: set.id,
      chosenSuggestionId: chosen!.id,
    });
    expect(applied.status, JSON.stringify(await applied.clone().json())).toBe(201);

    const exported = await fetch(`${origin}${SESSION_URL}/export?confirmPrivateExport=true`);
    expect(exported.status).toBe(200);
    const artifact = await json<{
      library: { additionEvents: { origin: { kind: string } }[] };
      llmCalls: { id: string; role: string }[];
    }>(exported);
    expect(
      artifact.library.additionEvents.filter(({ origin }) => origin.kind === "service"),
    ).toHaveLength(2);
    expect(artifact.llmCalls.map(({ id, role }) => [id, role])).toContainEqual([
      "llm-call:find-1",
      "librarian",
    ]);

    const imported = await post(origin, "/artifacts", artifact);
    expect(imported.status, JSON.stringify(await imported.clone().json())).toBe(201);
    expect(await json<{ readOnly: boolean }>(imported)).toMatchObject({ readOnly: true });
    expect((await post(origin, "/artifacts", artifact)).status).toBe(200);
  });
});
