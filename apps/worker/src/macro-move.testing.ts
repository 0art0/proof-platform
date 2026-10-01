/**
 * Shared fixtures for multi-step macro tests (roadmap N35): "introduce two implications", built
 * from two recorded `introduce-implication` steps by the same authoring helpers the editor uses.
 */
import { expect } from "vitest";
import { createProofNodeSchema } from "@proof/protocol";
import { MemoryLibraryStore } from "./memory-library-store";
import { initializeProofSession } from "./proof-repository";
import { createProofHttpService, type ProofHttpService } from "./proof-http";
import type { KernelEnvironment } from "@proof/kernel";
import {
  macroFromSemanticSteps,
  recordedMacroExample,
  type MacroSelection,
  type RecordedStep,
} from "@proof/moves/authoring";
import {
  HAND_AUTHORED_MOVES,
  commandIdGenerator,
  materializeMoveOperation,
  planMove,
  type MoveSelections,
} from "@proof/moves";
import {
  PROPOSITION_SORT,
  createExecutableProofStateSchema,
  operatorDeclarationsSchema,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";

export const MACRO_ID = "authored:intro-twice";

const operators = operatorDeclarationsSchema.parse([]);
const environment: KernelEnvironment = { operators };
const stateSchema = createExecutableProofStateSchema({ operators });

/** A proof state over proposition symbols with one goal and no hypotheses. */
export function macroState(
  names: readonly string[],
  conclusion: PlainMathJson,
  id: string,
): Record<string, unknown> {
  return {
    id,
    goals: [
      {
        id: "goal:main",
        sequent: {
          context: {
            declarations: names.map((symbol) => ({
              id: `declaration:${symbol}`,
              symbol,
              sort: PROPOSITION_SORT,
              role: "universal-parameter",
            })),
            hypotheses: [],
          },
          conclusion: { expression: conclusion },
        },
      },
    ],
    obligations: [],
  };
}

const conclusionSelection = {
  kind: "exact",
  anchor: { target: { kind: "goal", id: "goal:main" }, statement: { kind: "conclusion" } },
  path: [],
} as const;

function selectionOf(fragment: PlainMathJson, names: readonly string[]): MacroSelection {
  return {
    slotId: "target",
    target: { kind: "goal", id: "goal:main" },
    statement: { role: "conclusion" },
    occurrence: { kind: "exact", path: [] },
    fragment,
    variables: names.map((symbol) => ({ symbol, sort: PROPOSITION_SORT })),
  } as unknown as MacroSelection;
}

function recordedSteps() {
  const before = stateSchema.parse(
    macroState(["p", "q", "r"], ["Implies", "p", ["Implies", "q", "r"]], "state:recorded"),
  ) as ExecutableProofState;
  const move = HAND_AUTHORED_MOVES.find(
    (candidate) => candidate.id === "move:introduce-implication",
  );
  if (move === undefined) throw new Error("Missing move.");
  let state = before;
  const steps: RecordedStep[] = [];
  const fragments: [PlainMathJson, string[]][] = [
    [
      ["Implies", "p", ["Implies", "q", "r"]],
      ["p", "q", "r"],
    ],
    [
      ["Implies", "q", "r"],
      ["q", "r"],
    ],
  ];
  fragments.forEach(([fragment, names], index) => {
    const materialized = materializeMoveOperation({
      state,
      move,
      selections: {
        target: {
          ...conclusionSelection,
          anchor: { ...conclusionSelection.anchor, stateId: state.id },
        },
      } as unknown as MoveSelections,
      idGenerator: commandIdGenerator(`record:${index + 1}`),
      env: environment,
    });
    if (!materialized.ok) throw new Error(JSON.stringify(materialized.diagnostics));
    const planned = planMove(
      state,
      { moveId: move.id, operation: materialized.operation },
      environment,
    );
    if (!planned.ok) throw new Error(JSON.stringify(planned.diagnostics));
    steps.push({
      moveId: move.id,
      source: "move",
      selections: [selectionOf(fragment, names)],
      parameters: [],
      operation: materialized.operation,
    });
    state = planned.preview.state;
  });
  return { steps, before, after: state };
}

/**
 * A valid two-step macro template as plain JSON. With `generic`, its first step is recorded on the
 * looser `p implies x`, so it is also offered where its second step cannot re-match.
 */
export function macroTemplate(
  options: { id?: string; generic?: boolean } = {},
): Record<string, unknown> {
  const { steps, before, after } = recordedSteps();
  const recorded = recordedMacroExample({
    id: "example:recorded",
    description: "the recorded proof",
    state: before,
    finalState: after,
    steps,
    transitionClass: "equivalence",
    operators,
  });
  if (recorded === undefined) throw new Error("No recorded example.");
  const second = {
    ...recorded,
    id: "example:nested-conjunction",
    description: "a different conclusion under the same shape",
    state: macroState(
      ["p", "q", "r"],
      ["Implies", "p", ["Implies", "q", ["And", "q", "r"]]],
      "state:example",
    ),
    expected: { ...recorded.expected, goals: [["And", "q", "r"]] },
  };
  const negative = {
    id: "example:negative",
    description: "only one implication deep",
    state: macroState(["p", "q", "r"], ["Implies", "p", "q"], "state:example"),
    selections: recorded.selections,
    expected: { outcome: "rejected", diagnosticCode: "macro-step-unmatched" },
  };
  const built = macroFromSemanticSteps(steps, {
    id: options.id ?? MACRO_ID,
    name: "Introduce two implications",
    description: "Assume two nested antecedents at once.",
    examples: [recorded, second as never, negative as never],
  });
  if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
  const template = JSON.parse(JSON.stringify(built.template)) as Record<string, unknown>;
  if (options.generic === true) {
    const first = (template["plan"] as { steps: Record<string, any>[] }).steps[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
    const selection = (first?.["selections"] as Record<string, unknown>[])[0];
    if (selection === undefined) throw new Error("Missing recorded selection.");
    selection["fragment"] = ["Implies", "p", "x"];
    selection["variables"] = ["p", "x"].map((symbol) => ({ symbol, sort: PROPOSITION_SORT }));
    template["patterns"] = [
      { id: "pattern:target", selectionSlotId: "target", expression: ["Implies", "p", "x"] },
    ];
  }
  return template;
}

// ---------------------------------------------------------------------------------------------
// A running worker with a macro-ready session
// ---------------------------------------------------------------------------------------------

export const HUMAN = { id: "actor:human-1", kind: "human" } as const;
export const REVIEWER = { id: "actor:human-reviewer", kind: "human" } as const;
export const SESSION_ID = "session:macro";
export const ROOT_ID = "node:macro-root";

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function choiceOf(body: Json, suggestion: Json, commandId: string) {
  return {
    commandId,
    suggestionSetId: body.suggestionSet.id,
    chosenSuggestionId: suggestion.id,
  };
}

/** Start a worker over a memory store with one session whose goal is `conclusion`. */
export async function startMacroSession(
  services: ProofHttpService[],
  conclusion: unknown = ["Implies", "p", ["Implies", "q", "r"]],
) {
  const store = new MemoryLibraryStore();
  const rootNode = createProofNodeSchema().parse({
    id: ROOT_ID,
    state: macroState(["p", "q", "r"], conclusion as never, "state:macro-root"),
  });
  await initializeProofSession(store, { sessionId: SESSION_ID, rootNode });
  const service = createProofHttpService(store, { library: store });
  services.push(service);
  const { origin } = await service.listen();
  const base = `${origin}/proof-sessions/${SESSION_ID}`;
  let counter = 0;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const get = async (path: string) => {
    const response = await fetch(`${base}/${path}`);
    return { status: response.status, body: (await response.json()) as Json };
  };
  const envelope = async (actor: unknown, command: Json) => {
    counter += 1;
    return post("protocol-commands", { commandId: `command:macro-${counter}`, actor, command });
  };
  const approve = async (template: Record<string, unknown>) => {
    const drafted = await envelope(HUMAN, {
      kind: "author-move-draft",
      template,
      payloadSource: "reviewed-authoring",
    });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    return {
      drafted,
      approve: async () =>
        envelope(REVIEWER, {
          kind: "review-move-draft",
          draftArtifactId: drafted.body.result.artifactId,
          decision: "approved",
          notes: "ok",
          payloadSource: "reviewed-authoring",
        }),
    };
  };
  let suggestionCounter = 0;
  /** Displayed suggestions for the current node's goal conclusion. */
  const suggest = async () => {
    suggestionCounter += 1;
    const current = (await get("")).body;
    const response = await post("suggestion-sets", {
      id: `suggestion-set:macro-${suggestionCounter}`,
      selections: [
        {
          kind: "exact",
          anchor: {
            stateId: current.node.state.id,
            target: { kind: "goal", id: current.node.state.goals[0].id },
            statement: { kind: "conclusion" },
          },
          path: [],
        },
      ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as Json;
  };
  const macroChoice = async (commandId: string) => {
    const body = await suggest();
    const found = (body.suggestionSet.suggestions as Json[]).find(
      ({ artifactId }) => artifactId === MACRO_ID,
    );
    return { body, choice: found === undefined ? undefined : choiceOf(body, found, commandId) };
  };
  return { store, get, post, envelope, approve, suggest, macroChoice };
}
