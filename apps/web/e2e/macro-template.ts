/**
 * A two-step macro template ("introduce two implications") for the macro e2e, built from two
 * recorded `introduce-implication` steps by the same authoring helpers the editor uses. It is
 * plain JSON, so the spec can send it through the existing author/review envelopes.
 */
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

export const MACRO_MOVE_ID = "authored:introduce-two-implications";
export const MACRO_NAME = "Introduce two implications";

const operators = operatorDeclarationsSchema.parse([]);
const environment = { operators };
const stateSchema = createExecutableProofStateSchema({ operators });

function macroState(
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

/** The macro template as plain JSON, with two positive examples and one negative one. */
export function macroTemplate(): Record<string, unknown> {
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
    id: MACRO_MOVE_ID,
    name: MACRO_NAME,
    description: "Assume two nested antecedents at once.",
    examples: [recorded, second as never, negative as never],
  });
  if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
  return JSON.parse(JSON.stringify(built.template)) as Record<string, unknown>;
}
