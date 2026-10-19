import { afterEach, describe, expect, it } from "vitest";
import {
  closeServices,
  conclusionSelection,
  json,
  libraryOutput,
  post,
  type DisplayedSet,
  PROBLEM,
} from "./ai-library.testing";
import {
  GCD_DIVIDES_AGAIN,
  LCM_GCD,
  SCALING,
  SESSION,
  SESSION_URL,
  applyGcdDivides,
  constants,
  events,
  lcm,
  librarianContext,
  topUp,
  topUpScenario,
  type ConstantsBody,
} from "./ai-library-top-up.testing";
import {
  ANY_PROPOSITION,
  GCD_SYMMETRY,
  OUTSIDE_BACKGROUND,
  scenario,
  startSession,
  wireResult,
} from "./ai-library.testing";

afterEach(closeServices);

/**
 * Library top-ups during a proof (`docs/ai-agents-architecture.md` section 2). The session starts
 * from an approved initial library whose result needs the constant Gcd, so Gcd is declared but
 * dormant until a step applies that result; the librarian is scripted per request kind.
 */

// ---------------------------------------------------------------------------------------------
// Active constants
// ---------------------------------------------------------------------------------------------

describe("active constants", () => {
  it("keeps a constant that only the approved library introduced dormant until a step applies it", async () => {
    const { origin } = await topUpScenario();
    const before = await constants(origin);
    expect(before).toMatchObject({ readOnly: false, dormant: ["Gcd"], activated: [] });
    expect(before.active).toEqual(["Divides", "Coprime"]);

    const { command } = await applyGcdDivides(origin);
    const after = await constants(origin);
    expect(after.dormant).toEqual([]);
    expect(after.active).toEqual(["Divides", "Coprime", "Gcd"]);
    expect(after.activated).toEqual([
      {
        symbol: "Gcd",
        edgeId: expect.any(String),
        nodeId: expect.any(String),
        resultId: "result:library-gcd-divides",
        sequence: 1,
        topUp: null,
      },
    ]);

    // The activating step is the existing record: replaying its command records nothing more.
    const replayed = await post(origin, `${SESSION_URL}/commands`, command);
    expect(replayed.status).toBe(200);
    expect((await constants(origin)).activated).toHaveLength(1);
  });

  it("has no dormant constant when the approved library introduced none", async () => {
    const { origin } = await scenario();
    await startSession(origin, "session:plain");
    const response = await fetch(`${origin}/proof-sessions/session%3Aplain/library/constants`);
    expect(response.status).toBe(200);
    expect(await json<ConstantsBody>(response)).toMatchObject({ dormant: [], activated: [] });
    expect(
      (await fetch(`${origin}/proof-sessions/session%3Amissing/library/constants`)).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------
// new-constants
// ---------------------------------------------------------------------------------------------

describe("new-constants top-up", () => {
  const request = { id: "llm-call:top-up-1", kind: "new-constants" };

  it("refuses until a committed step has activated a constant, without paying for a call", async () => {
    const { origin, topUps } = await topUpScenario();
    const { response, body } = await topUp(origin, request);
    expect(response.status).toBe(409);
    expect(body.diagnostics[0].code).toBe("no-new-constants");
    const named = await topUp(origin, { ...request, constants: ["Gcd"] });
    expect(named.response.status).toBe(409);
    expect(named.body.diagnostics[0].code).toBe("constant-not-activated");
    expect(topUps).toHaveLength(0);
  });

  it("asks about the old and the new constants, then admits what the gate admits, once", async () => {
    const { origin, topUps } = await topUpScenario(() =>
      libraryOutput(
        [GCD_SYMMETRY, SCALING, GCD_DIVIDES_AGAIN, LCM_GCD, OUTSIDE_BACKGROUND],
        [lcm()],
      ),
    );
    const { set: earlier } = await applyGcdDivides(origin);

    const { response, body } = await topUp(origin, request);
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({
      status: "topped-up",
      provenance: { kind: "minimal-context-llm", role: "librarian" },
      callId: "llm-call:top-up-1",
      replayed: false,
      requestKind: "new-constants",
      coveredConstants: ["Gcd"],
      addedCount: 1,
      admittedBy: "service:library-gate",
    });
    expect(body.added.map((entry: { id: string }) => entry.id)).toEqual([
      "result:library-gcd-symmetry",
    ]);
    const reasons = new Map<string, { codes: string[]; reasons: string[] }>(
      body.rejected.map((item: { id: string; codes: string[]; reasons: string[] }) => [
        item.id,
        item,
      ]),
    );
    expect([...reasons.keys()].sort()).toEqual([
      "result:library-divides-scaling",
      "result:library-gcd-divides-again",
      "result:library-graduate-result",
      "result:library-lcm-gcd",
    ]);
    expect(reasons.get("result:library-divides-scaling")?.codes).toEqual([
      "not-about-new-constants",
    ]);
    expect(reasons.get("result:library-gcd-divides-again")).toMatchObject({
      codes: ["duplicate-statement"],
      reasons: [expect.stringContaining("Result gcd-divides")],
    });
    expect(reasons.get("result:library-lcm-gcd")).toMatchObject({
      codes: ["needs-new-constant"],
      reasons: [expect.stringContaining("Lcm")],
    });
    expect(reasons.get("result:library-graduate-result")?.codes).toEqual(
      expect.arrayContaining(["level-above-background"]),
    );
    // The constant the librarian wanted to declare cannot join a proof in progress.
    expect(body.rejectedConstants).toEqual([
      { symbol: "Lcm", reason: expect.stringContaining("cannot declare new constants") },
    ]);

    // The librarian saw the old constants, the newly activated one and the library, nothing else.
    expect(topUps).toHaveLength(1);
    const seen = librarianContext(topUps[0]!);
    if (seen.kind !== "new-constants") throw new Error("Expected a new-constants context.");
    expect(Object.keys(seen).sort()).toEqual([
      "background",
      "constants",
      "existingResults",
      "kind",
      "newConstants",
    ]);
    expect(seen.constants.map(({ symbol }) => symbol)).toEqual(["Divides", "Coprime"]);
    expect(seen.newConstants.map(({ symbol }) => symbol)).toEqual(["Gcd"]);
    expect(seen.existingResults.map(({ id }) => id)).toContain("result:library-gcd-divides");
    expect(seen.existingResults.map(({ id }) => id)).toContain("result:divides-reflexivity");
    expect(seen.existingResults[0]!.id).toBe("result:library-gcd-divides");
    const prompt = topUps[0]!.messages[1].content;
    for (const hidden of [PROBLEM.title, PROBLEM.statement, SESSION, "node:root", "goal:1"]) {
      expect(prompt).not.toContain(hidden);
    }

    // The addition is an ordinary proof-time-background event of the session, admitted by the gate.
    const recorded = (await events(origin)).filter(
      ({ layer }) => layer === "proof-time-background",
    );
    expect(recorded.map(({ artifact }) => artifact.id)).toEqual(["result:library-gcd-symmetry"]);
    expect(recorded[0]).toMatchObject({
      id: "library-addition:session:top-up:top-up:llm-call:top-up-1:result:library-gcd-symmetry",
      origin: { kind: "service", actorId: "llm-call:top-up-1" },
      admission: { decision: "admitted" },
      artifact: { approval: { status: "approved", reviewerId: "service:library-gate" } },
    });

    // The covered constant is reported, so nothing asks again.
    expect((await constants(origin)).activated[0]).toMatchObject({
      symbol: "Gcd",
      topUp: { callId: "llm-call:top-up-1" },
    });
    const again = await topUp(origin, { ...request, id: "llm-call:top-up-2" });
    expect(again.response.status).toBe(409);
    expect(again.body.diagnostics[0].code).toBe("no-new-constants");

    // Earlier suggestion menus are never rewritten; a new request sees the enlarged library.
    const stored = await json<{ suggestionSet: DisplayedSet }>(
      await fetch(`${origin}${SESSION_URL}/suggestion-sets/${encodeURIComponent(earlier.id)}`),
    );
    expect(stored.suggestionSet).toEqual(earlier);
  });

  it("replays by call ID: the provider is not asked again and nothing is added twice", async () => {
    const { origin, topUps } = await topUpScenario();
    await applyGcdDivides(origin);
    const first = await topUp(origin, request);
    expect(first.response.status).toBe(201);
    const before = await events(origin);

    const replay = await topUp(origin, request);
    expect(replay.response.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, addedCount: 1 });
    expect({ ...replay.body, replayed: false }).toEqual(first.body);
    expect(topUps).toHaveLength(1);
    expect(await events(origin)).toEqual(before);

    // Naming the covered constants, or none, is the same request; other constants are another.
    expect((await topUp(origin, { ...request, constants: ["Gcd"] })).response.status).toBe(200);
    expect((await topUp(origin, { ...request, constants: ["Divides"] })).response.status).toBe(409);
    expect(
      (
        await topUp(origin, {
          id: request.id,
          kind: "no-relevant-results",
          selections: [conclusionSelection],
        })
      ).response.status,
    ).toBe(409);
  });

  it("reports a refusal or a context request without adding anything", async () => {
    const { origin } = await topUpScenario(() => ({
      result: { kind: "declined", reason: "The library already covers Gcd." },
    }));
    await applyGcdDivides(origin);
    const { response, body } = await topUp(origin, request);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "declined",
      requestKind: "new-constants",
      result: { reason: "The library already covers Gcd." },
    });
    expect((await events(origin)).filter(({ layer }) => layer === "proof-time-background")).toEqual(
      [],
    );
    // A refusal is a recorded outcome: the constant is covered and is not asked about again.
    expect((await constants(origin)).activated[0]?.topUp).toEqual({ callId: request.id });
  });

  it("finishes an interrupted run with the same call ID, adding each result once", async () => {
    const { origin, store } = await topUpScenario(() =>
      libraryOutput([
        GCD_SYMMETRY,
        wireResult("gcd-extra", {
          statement: ["Equal", ["Gcd", "a", ["Gcd", "b", "c"]], ["Gcd", ["Gcd", "a", "b"], "c"]],
          patterns: [
            {
              expression: ["Gcd", "a", ["Gcd", "b", "c"]],
              direction: "forward",
              ...ANY_PROPOSITION,
              role: "term",
            },
          ],
        }),
      ]),
    );
    await applyGcdDivides(origin);
    // Library transactions of the request: the scoped catalog, the event read, then one per
    // addition. Fail the fourth, which is the second result's.
    store.armFailure(3);
    const interrupted = await topUp(origin, request);
    expect(interrupted.response.status).toBe(503);
    expect(interrupted.body).toMatchObject({
      status: "incomplete",
      diagnostics: [{ code: "top-up-incomplete" }],
    });
    const partial = (await events(origin)).filter(({ layer }) => layer === "proof-time-background");
    expect(partial.length).toBeGreaterThan(0);

    const finished = await topUp(origin, request);
    expect(finished.response.status).toBe(201);
    expect(finished.body.added.map((entry: { id: string }) => entry.id)).toEqual([
      "result:library-gcd-symmetry",
      "result:library-gcd-extra",
    ]);
    const all = (await events(origin)).filter(({ layer }) => layer === "proof-time-background");
    const ids = all.map(({ artifact }) => artifact.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("result:library-gcd-extra");
    // The events written before the interruption are unchanged.
    expect(all.slice(0, partial.length)).toEqual(partial);
    expect((await topUp(origin, request)).body).toMatchObject({ replayed: true });
    expect((await events(origin)).filter(({ layer }) => layer === "proof-time-background")).toEqual(
      all,
    );
  });
});
