import { afterEach, describe, expect, it } from "vitest";
import {
  createProofNodeSchema,
  type DisplayedSuggestionSet,
  type MoveRequiresInputResponse,
  type ParameterMenuItemRecord,
  type ProofEdge,
  type ProofNode,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { initializeProofSession } from "../proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore } from "../memory-proof-store.testing";
import { createProofHttpService, type ProofHttpService } from ".";

/**
 * N14 acceptance: the four moves that the worker could not apply before parameter menus
 * (choose-goal-disjunct, instantiate-universal-hypothesis, choose-existential-witness and
 * rewrite-with-equality) are applied end to end through menu choices, and displayed result
 * suggestions are applied through the result-application moves.
 */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const SESSION_ID = "session:menus";
const STATE_ID = "state:menus-root";
const NATURAL = { kind: "named", id: "sort:natural" } as const;
const PROPOSITION = { kind: "proposition" } as const;
const OPERATORS: NonNullable<ProtocolEnvironment["operators"]> = [
  {
    id: "operator:less-than",
    symbol: "Lt",
    signature: { parameters: [NATURAL, NATURAL], result: PROPOSITION },
  },
  {
    id: "operator:successor",
    symbol: "S",
    signature: { parameters: [NATURAL], result: NATURAL },
  },
] as unknown as NonNullable<ProtocolEnvironment["operators"]>;

const DECLARATIONS = [
  ...["p", "q", "r"].map((symbol) => ({ symbol, sort: PROPOSITION })),
  ...["a", "b", "x"].map((symbol) => ({ symbol, sort: NATURAL })),
].map(({ symbol, sort }) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort,
  role: "universal-parameter" as const,
}));

type Hypothesis = Readonly<{ id: string; expression: unknown }>;

type Session = Readonly<{
  sessionUrl: string;
  post(path: string, body: unknown): Promise<Response>;
}>;

async function startSession(
  conclusion: unknown,
  hypotheses: readonly Hypothesis[] = [],
): Promise<Session> {
  const store = new MemoryProofStore();
  const rootNode = createProofNodeSchema({ operators: OPERATORS }).parse({
    id: "node:menus-root",
    state: {
      id: STATE_ID,
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: DECLARATIONS,
              hypotheses: hypotheses.map(({ id, expression }) => ({
                id,
                statement: { expression },
              })),
            },
            conclusion: { expression: conclusion },
          },
        },
      ],
      obligations: [],
    },
  });
  expect(
    await initializeProofSession(store, {
      sessionId: SESSION_ID,
      rootNode,
      operators: OPERATORS,
    }),
  ).toMatchObject({ status: "committed" });
  const service = createProofHttpService(store);
  services.push(service);
  const { origin } = await service.listen();
  const sessionUrl = `${origin}/proof-sessions/${SESSION_ID}`;
  return {
    sessionUrl,
    post: (path, body) =>
      fetch(`${sessionUrl}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

function at(statement: "conclusion" | string, path: readonly number[] = []) {
  return {
    kind: "exact",
    anchor: {
      stateId: STATE_ID,
      target: { kind: "goal", id: "goal:main" },
      statement:
        statement === "conclusion" ? { kind: "conclusion" } : { kind: "hypothesis", id: statement },
    },
    path,
  } as const;
}

async function json<Value = Record<string, unknown>>(response: Response): Promise<Value> {
  return (await response.json()) as Value;
}

async function suggestion(
  session: Session,
  id: string,
  selections: readonly unknown[],
  artifactId: string,
): Promise<Readonly<{ suggestionSetId: string; suggestionId: string }>> {
  const response = await session.post("suggestion-sets", { id, selections });
  if (response.status !== 201) {
    throw new Error(`Suggestion request failed: ${JSON.stringify(await json(response))}`);
  }
  const set = (await json(response)).suggestionSet as DisplayedSuggestionSet;
  const found = set.suggestions.find((candidate) => candidate.artifactId === artifactId);
  if (found === undefined) {
    throw new Error(
      `Expected ${artifactId}; received ${JSON.stringify(set.suggestions.map((candidate) => candidate.artifactId))}`,
    );
  }
  return { suggestionSetId: set.id, suggestionId: found.id };
}

function itemWith(
  body: MoveRequiresInputResponse,
  parameterId: string,
  value: unknown,
): ParameterMenuItemRecord {
  const menu = body.menus.find((candidate) => candidate.parameterId === parameterId);
  const item = menu?.items.find(
    (candidate) => JSON.stringify(candidate.value) === JSON.stringify(value),
  );
  if (item === undefined) {
    throw new Error(
      `No ${parameterId} item ${JSON.stringify(value)} in ${JSON.stringify(body.menus)}`,
    );
  }
  return item;
}

/**
 * Apply one displayed input-requiring move: the first attempt must return its menus without
 * recording anything, and the retry with a chosen menu item must commit the transition.
 */
async function applyThroughMenu(
  session: Session,
  choice: Readonly<{ suggestionSetId: string; suggestionId: string }>,
  commandId: string,
  parameterId: string,
  value: unknown,
): Promise<
  Readonly<{ node: ProofNode; itemId: string; menus: MoveRequiresInputResponse["menus"] }>
> {
  const request = {
    commandId,
    suggestionSetId: choice.suggestionSetId,
    chosenSuggestionId: choice.suggestionId,
  };
  const pending = await session.post("commands", request);
  expect(pending.status).toBe(422);
  const body = await json<MoveRequiresInputResponse>(pending);
  expect(body).toMatchObject({
    status: "requires-input",
    suggestionSetId: choice.suggestionSetId,
    chosenSuggestionId: choice.suggestionId,
    missingParameters: [parameterId],
    diagnostics: [{ code: "requires-input" }],
  });
  const current = await json(await fetch(session.sessionUrl));
  expect(current).toMatchObject({ session: { currentNodeId: "node:menus-root" } });

  const item = itemWith(body, parameterId, value);
  const preview = await session.post("move-previews", {
    ...request,
    menuChoices: { [parameterId]: item.id },
  });
  expect(preview.status).toBe(201);
  expect(await json(preview)).toMatchObject({
    preview: { menuSelection: { choices: { [parameterId]: item.id } } },
  });

  const applied = await session.post("commands", {
    ...request,
    menuChoices: { [parameterId]: item.id },
  });
  expect(applied.status).toBe(201);
  const appliedBody = await json(applied);
  expect(appliedBody).toMatchObject({
    session: { currentNodeId: `node:${commandId}` },
    receipt: { commandId },
  });
  return { node: appliedBody.node as ProofNode, itemId: item.id, menus: body.menus };
}

async function historyEdge(session: Session, commandId: string): Promise<ProofEdge> {
  const history = await json(await fetch(`${session.sessionUrl}/history`));
  const edge = (history.edges as { edge: ProofEdge }[]).find(
    (candidate) => candidate.edge.commandId === commandId,
  )?.edge;
  if (edge === undefined) throw new Error(`No history edge for ${commandId}.`);
  return edge;
}

function conclusionOf(node: ProofNode, goalIndex = 0): unknown {
  return node.state.goals[goalIndex]?.sequent.conclusion.expression;
}

describe("parameter menus through the proof HTTP service", () => {
  it("applies choose-goal-disjunct through a disjunct-index menu and keeps the menus in history", async () => {
    const session = await startSession(["Or", "p", "q"]);
    const choice = await suggestion(
      session,
      "suggestion-set:disjunct",
      [at("conclusion")],
      "move:choose-goal-disjunct",
    );
    const { node, itemId, menus } = await applyThroughMenu(
      session,
      choice,
      "command:disjunct",
      "disjunctIndex",
      { kind: "index", index: 1 },
    );
    expect(conclusionOf(node)).toBe("q");

    const edge = await historyEdge(session, "command:disjunct");
    expect(edge).toMatchObject({
      moveId: "move:choose-goal-disjunct",
      transitionClass: "strengthening",
      operation: { kind: "choose-goal-disjunct", disjunctIndex: 1 },
      menuSelection: { menus, choices: { disjunctIndex: itemId } },
    });

    // A retry with the same command and choice replays; a different choice conflicts.
    const request = {
      commandId: "command:disjunct",
      suggestionSetId: choice.suggestionSetId,
      chosenSuggestionId: choice.suggestionId,
    };
    const replay = await session.post("commands", {
      ...request,
      menuChoices: { disjunctIndex: itemId },
    });
    expect(replay.status).toBe(200);
    const other = itemWith({ menus } as MoveRequiresInputResponse, "disjunctIndex", {
      kind: "index",
      index: 0,
    });
    const conflict = await session.post("commands", {
      ...request,
      menuChoices: { disjunctIndex: other.id },
    });
    expect(conflict.status).toBe(400);
  });

  it("applies instantiate-universal-hypothesis through an instantiation-term menu", async () => {
    const session = await startSession(
      ["Lt", "a", ["S", "a"]],
      [{ id: "hypothesis:all", expression: ["ForAll", "x", ["Lt", "x", ["S", "x"]]] }],
    );
    const choice = await suggestion(
      session,
      "suggestion-set:instantiate",
      [at("conclusion"), at("hypothesis:all")],
      "move:instantiate-universal-hypothesis",
    );
    const { node } = await applyThroughMenu(session, choice, "command:instantiate", "term", {
      kind: "term",
      expression: "a",
    });
    expect(node.state.goals[0]?.sequent.context.hypotheses).toContainEqual({
      id: "statement:command:instantiate:result-hypothesis:1",
      statement: { expression: ["Lt", "a", ["S", "a"]] },
    });
    expect(await historyEdge(session, "command:instantiate")).toMatchObject({
      operation: { kind: "instantiate-universal-hypothesis", term: "a" },
      menuSelection: { choices: { term: expect.stringMatching(/^menu-item:/) } },
    });
  });

  it("applies choose-existential-witness through a witness menu", async () => {
    const session = await startSession(["Exists", "x", ["Lt", "a", "x"]]);
    const choice = await suggestion(
      session,
      "suggestion-set:witness",
      [at("conclusion")],
      "move:choose-existential-witness",
    );
    const { node } = await applyThroughMenu(session, choice, "command:witness", "witness", {
      kind: "term",
      expression: "b",
    });
    expect(conclusionOf(node)).toEqual(["Lt", "a", "b"]);
    expect(await historyEdge(session, "command:witness")).toMatchObject({
      transitionClass: "strengthening",
      operation: { kind: "choose-existential-witness", witness: "b" },
    });
  });

  it("applies rewrite-with-equality through a direction menu", async () => {
    const session = await startSession(
      ["Lt", "a", ["S", "b"]],
      [{ id: "hypothesis:equality", expression: ["Equal", "b", "a"] }],
    );
    const choice = await suggestion(
      session,
      "suggestion-set:rewrite",
      [at("hypothesis:equality"), at("conclusion", [1, 0])],
      "move:rewrite-with-equality",
    );
    const { node } = await applyThroughMenu(session, choice, "command:rewrite", "direction", {
      kind: "direction",
      direction: "forward",
    });
    expect(conclusionOf(node)).toEqual(["Lt", "a", ["S", "a"]]);
    expect(await historyEdge(session, "command:rewrite")).toMatchObject({
      transitionClass: "equivalence",
      operation: { kind: "rewrite-with-equality", direction: "forward", path: [1, 0] },
    });
  });

  it("rejects unknown, stale and expression-valued menu choices without recording anything", async () => {
    const session = await startSession(["Or", "p", "q"]);
    const choice = await suggestion(
      session,
      "suggestion-set:reject",
      [at("conclusion")],
      "move:choose-goal-disjunct",
    );
    const request = {
      commandId: "command:reject",
      suggestionSetId: choice.suggestionSetId,
      chosenSuggestionId: choice.suggestionId,
    };

    const unknown = await session.post("commands", {
      ...request,
      menuChoices: { disjunctIndex: "menu-item:0000000000000000" },
    });
    expect(unknown.status).toBe(400);
    expect(await json(unknown)).toMatchObject({ diagnostics: [{ code: "preview-rejected" }] });

    // A genuine item of another snapshot's menu whose value is not offered here is stale.
    const other = await startSession(["Or", "p", "q", "r"]);
    const otherChoice = await suggestion(
      other,
      "suggestion-set:other",
      [at("conclusion")],
      "move:choose-goal-disjunct",
    );
    const otherPending = await json<MoveRequiresInputResponse>(
      await other.post("commands", {
        commandId: "command:other",
        suggestionSetId: otherChoice.suggestionSetId,
        chosenSuggestionId: otherChoice.suggestionId,
      }),
    );
    const staleItem = itemWith(otherPending, "disjunctIndex", { kind: "index", index: 2 });
    const stale = await session.post("commands", {
      ...request,
      menuChoices: { disjunctIndex: staleItem.id },
    });
    expect(stale.status).toBe(400);
    expect(await json(stale)).toMatchObject({ diagnostics: [{ code: "preview-rejected" }] });

    // A choice for a parameter the move does not have is rejected as well.
    const firstItem = itemWith(otherPending, "disjunctIndex", { kind: "index", index: 0 });
    const extra = await session.post("commands", {
      ...request,
      menuChoices: { disjunctIndex: firstItem.id, witness: staleItem.id },
    });
    expect(extra.status).toBe(400);
    expect(await json(extra)).toMatchObject({ diagnostics: [{ code: "preview-rejected" }] });

    const expression = await session.post("commands", {
      ...request,
      menuChoices: { disjunctIndex: ["Or", "p", "q"] },
    });
    expect(expression.status).toBe(400);
    expect(await json(expression)).toMatchObject({ diagnostics: [{ code: "invalid-request" }] });

    const current = await json(await fetch(session.sessionUrl));
    expect(current).toMatchObject({ session: { currentNodeId: "node:menus-root" } });
    const history = await json(await fetch(`${session.sessionUrl}/history`));
    expect(history).toMatchObject({ edges: [] });
  });
});

describe("result suggestions through the proof HTTP service", () => {
  async function resultSuggestion(
    session: Session,
    id: string,
    selections: readonly unknown[],
    resultId: string,
    patternId: string,
  ) {
    const response = await session.post("suggestion-sets", { id, selections });
    expect(response.status).toBe(201);
    const set = (await json(response)).suggestionSet as DisplayedSuggestionSet;
    const found = set.suggestions.find(
      (candidate) =>
        candidate.source === "result" &&
        candidate.artifactId === resultId &&
        candidate.patternId === patternId,
    );
    if (found === undefined) throw new Error(`Expected a ${resultId} suggestion.`);
    return { set, suggestion: found };
  }

  it("rewrites a selected occurrence with an approved equivalence result", async () => {
    const session = await startSession(["Or", ["And", "p", "q"], "r"]);
    const { set, suggestion: chosen } = await resultSuggestion(
      session,
      "suggestion-set:commutativity",
      [at("conclusion", [0])],
      "result:conjunction-commutativity",
      "pattern:conjunction-commutativity-forward",
    );
    expect(chosen).toMatchObject({ applicability: "applicable" });
    const request = {
      commandId: "command:commutativity",
      suggestionSetId: set.id,
      chosenSuggestionId: chosen.id,
    };

    const preview = await session.post("move-previews", request);
    expect(preview.status).toBe(201);
    expect(await json(preview)).toMatchObject({
      preview: {
        moveId: "move:rewrite-with-equivalence",
        chosenSuggestionId: chosen.id,
        transitionClass: "equivalence",
        operation: {
          kind: "rewrite-with-equivalence",
          source: { kind: "result", resultId: "result:conjunction-commutativity" },
          direction: "forward",
          path: [0],
        },
      },
    });

    const applied = await session.post("commands", request);
    expect(applied.status).toBe(201);
    expect(conclusionOf((await json(applied)).node as ProofNode)).toEqual([
      "Or",
      ["And", "q", "p"],
      "r",
    ]);

    const history = await json(await fetch(`${session.sessionUrl}/history`));
    expect(history.edges).toEqual([
      {
        name: chosen.name,
        edge: expect.objectContaining({
          moveId: "move:rewrite-with-equivalence",
          chosenSuggestionId: chosen.id,
          // The source and direction menus were displayed; the suggestion fixed both.
          menuSelection: {
            menus: expect.arrayContaining([
              expect.objectContaining({ parameterId: "source" }),
              expect.objectContaining({ parameterId: "direction" }),
            ]),
            choices: {},
          },
        }),
      },
    ]);
    const replay = await session.post("commands", request);
    expect(replay.status).toBe(200);
  });

  it("applies modus ponens forward from a hypothesis, leaving the antecedent as an obligation", async () => {
    const session = await startSession("q", [
      { id: "hypothesis:implication", expression: ["Implies", "p", "q"] },
    ]);
    const { set, suggestion: chosen } = await resultSuggestion(
      session,
      "suggestion-set:modus-ponens",
      [at("hypothesis:implication")],
      "result:modus-ponens",
      "pattern:modus-ponens",
    );
    const applied = await session.post("commands", {
      commandId: "command:modus-ponens",
      suggestionSetId: set.id,
      chosenSuggestionId: chosen.id,
    });
    expect(applied.status).toBe(201);
    const node = (await json(applied)).node as ProofNode;
    expect(node.state.goals[0]?.sequent.context.hypotheses).toContainEqual({
      id: "statement:command:modus-ponens:result-hypothesis:1",
      statement: { expression: "q" },
    });
    expect(node.state.obligations.map(({ sequent }) => sequent.conclusion.expression)).toEqual([
      "p",
    ]);
    expect(await historyEdge(session, "command:modus-ponens")).toMatchObject({
      moveId: "move:apply-result-forward",
      operation: {
        kind: "apply-result-forward",
        resultId: "result:modus-ponens",
        instantiation: { p: "p", q: "q" },
      },
    });
  });

  it("rejects a result suggestion whose menu choice is not in the regenerated menu", async () => {
    const session = await startSession(["Or", ["And", "p", "q"], "r"]);
    const { set, suggestion: chosen } = await resultSuggestion(
      session,
      "suggestion-set:commutativity-choice",
      [at("conclusion", [0])],
      "result:conjunction-commutativity",
      "pattern:conjunction-commutativity-forward",
    );
    const response = await session.post("commands", {
      commandId: "command:commutativity-choice",
      suggestionSetId: set.id,
      chosenSuggestionId: chosen.id,
      menuChoices: { direction: "menu-item:ffffffffffffffff" },
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ diagnostics: [{ code: "preview-rejected" }] });
  });
});
