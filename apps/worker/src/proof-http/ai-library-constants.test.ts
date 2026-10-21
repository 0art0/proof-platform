import { afterEach, describe, expect, it } from "vitest";
import {
  closeServices,
  conclusionSelection,
  gcd,
  json,
  libraryOutput,
  post,
  suggest,
  wireOperator,
} from "./ai-library.testing";
import {
  LCM_GCD,
  SCALING,
  SESSION,
  SESSION_URL,
  applyGcdDivides,
  constants,
  events,
  lcm,
  topUp,
  topUpScenario,
  type ConstantsBody,
} from "./ai-library-top-up.testing";

afterEach(closeServices);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const GCD_RESULT = "result:library-gcd-divides";

/** The suggestion that applies the library result, and the request to preview or apply it. */
async function choose(origin: string, setId: string, commandId: string) {
  const set = await suggest(origin, SESSION, setId);
  const chosen = set.suggestions.find(({ artifactId }) => artifactId === GCD_RESULT);
  expect(chosen, JSON.stringify(set.suggestions.map((s) => s.artifactId))).toBeDefined();
  return { set, request: { commandId, suggestionSetId: set.id, chosenSuggestionId: chosen!.id } };
}

describe("suggestions and previews of a result that needs an available constant", () => {
  it("offers the result and says in its preview that applying it adds the constant", async () => {
    const { origin } = await topUpScenario();
    const { request } = await choose(origin, "suggestion-set:one", "command:preview-gcd");

    const response = await post(origin, `${SESSION_URL}/move-previews`, request);
    expect(response.status).toBe(201);
    const { preview } = await json<{ preview: Json }>(response);
    expect(preview.constants).toMatchObject([{ symbol: "Gcd", id: "operator:gcd" }]);
    expect(JSON.stringify(preview.afterState)).toContain("Gcd");
    // Previewing activates nothing: the constant is still only available.
    const before = await constants(origin);
    expect(before.activated).toEqual([]);
    expect(before.available.map(({ symbol }) => symbol)).toEqual(["Gcd"]);

    // Applying the previewed step activates it, and then the same step needs nothing more.
    const applied = await post(origin, `${SESSION_URL}/commands`, request);
    expect(applied.status).toBe(201);
    const after = await constants(origin);
    expect(after.activated.map(({ symbol, commandId }) => [symbol, commandId])).toEqual([
      ["Gcd", "command:preview-gcd"],
    ]);
    expect(after.available).toEqual([]);
    const session = await json<{ session: { operators: { symbol: string }[] } }>(applied);
    expect(session.session.operators.map(({ symbol }) => symbol)).toEqual([
      "Divides",
      "Coprime",
      "Gcd",
    ]);
  });

  it("exports and imports a session whose preview names a constant nobody activated", async () => {
    const { origin } = await topUpScenario();
    const { request } = await choose(origin, "suggestion-set:one", "command:preview-only");
    expect((await post(origin, `${SESSION_URL}/move-previews`, request)).status).toBe(201);

    const exported = await fetch(`${origin}${SESSION_URL}/export?confirmPrivateExport=true`);
    expect(exported.status).toBe(200);
    const artifact = await json<Json>(exported);
    expect(artifact.constantActivations).toEqual([]);
    expect(artifact.tree.previews[0].constants[0].symbol).toBe("Gcd");
    const imported = await post(origin, "/artifacts", artifact);
    expect(imported.status, JSON.stringify(await imported.clone().json())).toBe(201);

    // A preview that claims a constant its result does not declare is not reproduced.
    const forged = structuredClone(artifact);
    forged.tree.previews[0].constants = [lcm().operator].map(() => ({
      ...forged.tree.previews[0].constants[0],
      id: "operator:forged",
      symbol: "Forged",
    }));
    const rejected = await post(origin, "/artifacts", forged);
    expect(rejected.status).toBe(422);
  });
});

describe("the constants of a session that is read only", () => {
  it("lists the activated constants and refuses to change them", async () => {
    const { origin } = await topUpScenario();
    await applyGcdDivides(origin);
    const artifact = await json<Json>(
      await fetch(`${origin}${SESSION_URL}/export?confirmPrivateExport=true`),
    );
    expect(artifact.constantActivations).toHaveLength(1);
    const imported = await json<{ sessionId: string }>(await post(origin, "/artifacts", artifact));
    const url = `/proof-sessions/${encodeURIComponent(imported.sessionId)}`;

    const listed = await json<ConstantsBody>(await fetch(`${origin}${url}/library/constants`));
    expect(listed.readOnly).toBe(true);
    expect(listed.active.map(({ symbol, origin: from }) => [symbol, from])).toEqual([
      ["Divides", "setup"],
      ["Coprime", "setup"],
      ["Gcd", "activated"],
    ]);
    expect(listed.activated).toMatchObject([{ symbol: "Gcd", resultId: GCD_RESULT }]);

    const session = await json<{ session: { operators: { symbol: string }[] } }>(
      await fetch(`${origin}${url}`),
    );
    expect(session.session.operators.map(({ symbol }) => symbol)).toEqual([
      "Divides",
      "Coprime",
      "Gcd",
    ]);
    const refused = await post(origin, `${url}/ai/library/top-up`, {
      id: "llm-call:read-only",
      kind: "new-constants",
    });
    expect([409, 503]).toContain(refused.status);
  });
});

describe("agents and people activate constants alike", () => {
  it("activates the constant for an agent's aliased command, and reports it in the answer", async () => {
    const { origin } = await topUpScenario();
    const base = `${origin}${SESSION_URL}`;
    const observed = (await (await fetch(`${base}/observe?view=full`)).json()) as Json;
    const target = (observed.targets as Json[])[0]!.alias as string;
    const agent = { id: "actor:agent-1", kind: "agent" };
    const command = async (body: Json) => {
      const response = await post(origin, `${SESSION_URL}/protocol-commands`, body);
      return { status: response.status, body: (await response.json()) as Json };
    };
    const suggested = await command({
      commandId: "command:agent-suggest",
      actor: agent,
      basis: { nodeId: observed.cursor.nodeId },
      command: {
        kind: "request-suggestions",
        selections: [{ target, statement: "conclusion", path: [] }],
      },
    });
    expect(suggested.status).toBe(201);
    const displayed = suggested.body.result.displayed as Json;
    const chosen = (displayed.suggestions as Json[]).find(
      ({ artifactId }) => artifactId === GCD_RESULT,
    );
    expect(chosen?.alias).toMatch(/^s[0-9]+$/);

    const applied = await command({
      commandId: "command:agent-apply",
      actor: agent,
      basis: { nodeId: observed.cursor.nodeId, suggestionSetId: displayed.suggestionSetId },
      command: { kind: "apply", suggestion: chosen!.alias },
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(applied.body.result.constantActivations).toMatchObject([
      { symbol: "Gcd", sequence: 1, resultId: GCD_RESULT, operator: { symbol: "Gcd" } },
    ]);
    const after = await constants(origin);
    expect(after.activated).toMatchObject([
      { symbol: "Gcd", commandId: "command:agent-apply", resultId: GCD_RESULT, sequence: 1 },
    ]);

    // The same step by a person records the same activation.
    const person = await topUpScenario();
    await applyGcdDivides(person.origin);
    const byPerson = (await constants(person.origin)).activated[0]!;
    expect(byPerson).toMatchObject({ symbol: "Gcd", resultId: GCD_RESULT, sequence: 1 });
    expect(Object.keys(byPerson).sort()).toEqual(Object.keys(after.activated[0]!).sort());
  });
});

describe("top-ups that declare constants", () => {
  const request = { id: "llm-call:find-more", kind: "no-relevant-results" };
  const asked = { ...request, selections: [conclusionSelection] };

  it("admits results with the constants they need, carries them, and lists them as available", async () => {
    // Gcd is the library's available constant; Lcm is declared by the librarian now.
    const { origin } = await topUpScenario(() => libraryOutput([LCM_GCD], [gcd(), lcm()]));
    const { response, body } = await topUp(origin, asked);
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(body.added.map((entry: { id: string }) => entry.id)).toEqual(["result:library-lcm-gcd"]);
    expect(body.rejectedConstants).toEqual([]);
    expect(body.newConstants.map(({ symbol }: { symbol: string }) => symbol)).toEqual([
      "Gcd",
      "Lcm",
    ]);

    const recorded = (await events(origin)).filter(
      ({ layer }) => layer === "proof-time-background",
    );
    expect(recorded[0]!.artifact.operators?.map(({ symbol }) => symbol)).toEqual(["Gcd", "Lcm"]);
    const listed = await constants(origin);
    expect(listed.available.map(({ symbol }) => symbol)).toEqual(["Gcd", "Lcm"]);
    expect(listed.available.find(({ symbol }) => symbol === "Lcm")?.results).toEqual([
      { id: "result:library-lcm-gcd", name: "Result lcm-gcd" },
    ]);
    // The session's active constants did not change: nothing was applied.
    expect(listed.active.map(({ symbol }) => symbol)).toEqual(["Divides", "Coprime"]);
  });

  it("sets aside a constant that clashes, with the reason, and rejects the results that need it", async () => {
    const reuse = lcm();
    const clashing = {
      ...reuse,
      operator: {
        ...reuse.operator,
        // The LaTeX notation of the available constant Gcd.
        latex: {
          template: String.raw`\gcd\left(#1, #2\right)`,
          precedence: "atom",
          parse: { trigger: String.raw`\gcd`, notation: "function" },
        },
      },
    };
    const { origin } = await topUpScenario(() => libraryOutput([LCM_GCD], [clashing]));
    const { response, body } = await topUp(origin, asked);
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.addedCount).toBe(0);
    expect(body.rejectedConstants).toEqual([
      { symbol: "Lcm", reason: expect.stringMatching(/\\gcd|trigger/) },
    ]);
    expect(body.rejected).toMatchObject([
      { id: "result:library-lcm-gcd", codes: ["needs-new-constant"] },
    ]);
    expect((await constants(origin)).available.map(({ symbol }) => symbol)).toEqual(["Gcd"]);
  });

  it("sets aside a constant declared differently from an available or active one", async () => {
    const other = gcd({ id: "operator:other-gcd", displayName: "another gcd" });
    const { origin } = await topUpScenario(() => libraryOutput([LCM_GCD], [other, lcm()]));
    const { body } = await topUp(origin, asked);
    expect(body.rejectedConstants).toEqual([
      { symbol: "Gcd", reason: expect.stringContaining("available library constant") },
      { symbol: "Lcm", reason: expect.stringContaining("No admitted result") },
    ]);
    expect(body.rejected).toMatchObject([
      { id: "result:library-lcm-gcd", codes: ["needs-new-constant"] },
    ]);

    // Once Gcd is active it is part of the librarian's context, and a proposal that declares it
    // again (however) is refused as a whole before any result is judged.
    await applyGcdDivides(origin);
    const second = await topUp(origin, { id: "llm-call:find-again", kind: "new-constants" });
    expect(second.response.status).toBe(422);
    expect(second.body.diagnostics[0].code).toBe("invalid-output");
    expect((await constants(origin)).available.map(({ symbol }) => symbol)).toEqual([]);
  });

  it("does not add a constant that no admitted result applies", async () => {
    const { origin } = await topUpScenario(() => libraryOutput([SCALING], [lcm()]));
    const { body } = await topUp(origin, asked);
    expect(body.added.map((entry: { id: string }) => entry.id)).toEqual([
      "result:library-divides-scaling",
    ]);
    expect(body.rejectedConstants).toEqual([
      { symbol: "Lcm", reason: expect.stringContaining("No admitted result") },
    ]);
    expect((await constants(origin)).available.map(({ symbol }) => symbol)).toEqual(["Gcd"]);
  });

  it("accepts a result about an active constant without declaring it again", async () => {
    const { origin } = await topUpScenario(() => libraryOutput([LCM_GCD], [lcm()]));
    await applyGcdDivides(origin);
    const { response, body } = await topUp(origin, {
      id: "llm-call:after-activation",
      kind: "new-constants",
    });
    expect(response.status, JSON.stringify(body)).toBe(201);
    const recorded = (await events(origin)).filter(
      ({ layer }) => layer === "proof-time-background",
    );
    // Gcd is active, so only Lcm travels with the result.
    expect(recorded[0]!.artifact.operators?.map(({ symbol }) => symbol)).toEqual(["Lcm"]);
  });
});

describe("the operator declaration of a wire constant", () => {
  it("is the one the session lists", async () => {
    const { origin } = await topUpScenario();
    const listed = await constants(origin);
    const declared = listed.available[0]!.operator as unknown as Json;
    expect(declared).toMatchObject({
      id: "operator:gcd",
      symbol: "Gcd",
      presentation: {
        displayName: wireOperator({ displayName: "greatest common divisor" }).displayName,
      },
    });
  });
});
