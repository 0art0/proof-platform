/**
 * Characterization of the move walk: for every move whose parameters the walk derives itself, the
 * trace pins the menus of the first round, then each materialization round (the missing parameters,
 * the diagnostic or the exact kernel operation) while the first item of every missing menu is
 * chosen. The expectations record the current behaviour, so a refactoring of the walk must not
 * change any of them.
 */
import { describe, expect, it } from "vitest";
import {
  PROPOSITION_SORT,
  createExecutableProofStateSchema,
  operatorDeclarationsSchema,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  HAND_AUTHORED_MOVES,
  commandIdGenerator,
  generateParameterMenus,
  materializeMoveOperation,
  type MoveDefinition,
  type MoveMenuChoices,
  type MoveOperationKind,
  type MoveSelectionInput,
  type MoveSelections,
} from "./index";

const NATURAL = { kind: "named", id: "sort:natural" } as const;
const operators = operatorDeclarationsSchema.parse([
  {
    id: "operator:less-than",
    symbol: "Lt",
    signature: { parameters: [NATURAL, NATURAL], result: PROPOSITION_SORT },
  },
  {
    id: "operator:successor",
    symbol: "S",
    signature: { parameters: [NATURAL], result: NATURAL },
  },
]);
const stateSchema = createExecutableProofStateSchema({ operators });

const declarations = [
  ...["p", "q", "r"].map((symbol) => ({ symbol, sort: PROPOSITION_SORT })),
  ...["a", "b", "x"].map((symbol) => ({ symbol, sort: NATURAL })),
].map(({ symbol, sort }) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort,
  role: "universal-parameter" as const,
}));

type Hypotheses = readonly (readonly [string, PlainMathJson])[];

function state(
  conclusion: PlainMathJson,
  hypotheses: Hypotheses = [],
  localDeclarations: readonly unknown[] = declarations,
): ExecutableProofState {
  return stateSchema.parse({
    id: "state:before",
    goals: [
      {
        id: "goal:main",
        sequent: {
          context: {
            declarations: localDeclarations,
            hypotheses: hypotheses.map(([id, expression]) => ({ id, statement: { expression } })),
          },
          conclusion: { expression: conclusion },
        },
      },
    ],
    obligations: [],
  }) as ExecutableProofState;
}

function moveFor(kind: MoveOperationKind): MoveDefinition {
  const move = HAND_AUTHORED_MOVES.find(
    (candidate) => candidate.implementation.operationKind === kind,
  );
  if (move === undefined) throw new Error(`Missing move for ${kind}.`);
  return move;
}

function at(statement: "conclusion" | string, path: readonly number[] = []): MoveSelectionInput {
  return {
    kind: "exact",
    anchor: {
      stateId: "state:before",
      target: { kind: "goal", id: "goal:main" as never },
      statement:
        statement === "conclusion"
          ? { kind: "conclusion" }
          : { kind: "hypothesis", id: statement as never },
    },
    path,
  };
}

const target = { target: at("conclusion") };
const ids = commandIdGenerator("command:1");

type Options = Readonly<{ attestationIds?: readonly string[]; withIds?: boolean }>;

/** The first-round menus, then every materialization round while the first menu items are chosen. */
function trace(
  kind: MoveOperationKind,
  input: ExecutableProofState,
  selections: MoveSelections,
  { attestationIds = [], withIds = true }: Options = {},
): string[] {
  const move = moveFor(kind);
  const env = { operators };
  const lines: string[] = [];
  const first = generateParameterMenus(input, move, selections, env, {
    attestationIds,
    ...(withIds ? { idGenerator: ids } : {}),
  });
  lines.push(
    first.ok
      ? `menus ${first.menus
          .map(
            (menu) => `${menu.parameterId}${menu.automatic ? "(auto)" : ""}[${menu.items.length}]`,
          )
          .join(" ")} pending=[${first.pendingParameters.join(" ")}]`
      : `menus FAIL ${first.diagnostics[0].code}: ${first.diagnostics[0].message}`,
  );
  let menuChoices: MoveMenuChoices = {};
  for (let round = 0; round < 6; round += 1) {
    const result = materializeMoveOperation({
      state: input,
      move,
      selections,
      menuChoices,
      env,
      attestationIds,
      idGenerator: ids,
    });
    if (result.ok) {
      lines.push(`ok ${JSON.stringify(result.operation)}`);
      return lines;
    }
    const diagnostic = result.diagnostics[0];
    lines.push(`${diagnostic.code}: ${diagnostic.message}`);
    if (result.missingParameters.length === 0) return lines;
    const next: Record<string, string> = { ...menuChoices };
    for (const parameterId of result.missingParameters) {
      const item = result.menus.find((menu) => menu.parameterId === parameterId)?.items[0];
      if (item !== undefined) next[parameterId] = item.id;
    }
    menuChoices = next;
  }
  return lines;
}

const typedUniversal: PlainMathJson = [
  "ForAll",
  ["Element", "n", "NonNegativeIntegers"],
  ["Lt", "n", ["S", "n"]],
];
const typedExistential: PlainMathJson = [
  "Exists",
  ["Element", "n", "NonNegativeIntegers"],
  ["Lt", "a", "n"],
];
const witnessDeclarations = [
  ...declarations,
  { id: "declaration:w", symbol: "w", sort: NATURAL, role: "local-witness" },
];

describe("walk of the closing and hypothesis moves", () => {
  it("pins the traces", () => {
    const withHypotheses = state("r", [
      ["h:p", "p"],
      ["h:not", ["Not", "p"]],
      ["h:false", "False"],
    ]);
    expect({
      "close-true": trace("close-true", state("True"), target),
      "close-reflexive-equality": trace(
        "close-reflexive-equality",
        state(["Equal", "a", "a"]),
        target,
      ),
      "close-by-hypothesis": trace("close-by-hypothesis", withHypotheses, {
        ...target,
        fact: at("h:p"),
      }),
      "close-by-hypothesis without a hypothesis selection": trace(
        "close-by-hypothesis",
        withHypotheses,
        { ...target, fact: at("conclusion") },
      ),
      "close-false-hypothesis": trace("close-false-hypothesis", withHypotheses, {
        ...target,
        false: at("h:false"),
      }),
      "close-false-hypothesis without a hypothesis selection": trace(
        "close-false-hypothesis",
        withHypotheses,
        target,
      ),
      "close-by-contradiction": trace("close-by-contradiction", withHypotheses, {
        ...target,
        fact: at("h:p"),
        negation: at("h:not"),
      }),
      "close-by-contradiction without selections": trace(
        "close-by-contradiction",
        withHypotheses,
        target,
      ),
      "close-by-contradiction without a negation selection": trace(
        "close-by-contradiction",
        withHypotheses,
        { ...target, fact: at("h:p") },
      ),
      "drop-hypothesis": trace("drop-hypothesis", withHypotheses, { dropped: at("h:p") }),
      "drop-hypothesis without a hypothesis selection": trace("drop-hypothesis", withHypotheses, {
        dropped: at("conclusion"),
      }),
      "close-by-accepted-inference with attestations": trace(
        "close-by-accepted-inference",
        state("p"),
        target,
        { attestationIds: ["attestation:one", "attestation:two"] },
      ),
      "close-by-accepted-inference without attestations": trace(
        "close-by-accepted-inference",
        state("p"),
        target,
      ),
      "apply-implication-hypothesis": trace(
        "apply-implication-hypothesis",
        state("q", [
          ["h:imp", ["Implies", "p", "q"]],
          ["h:p", "p"],
        ]),
        { ...target, implication: at("h:imp"), antecedent: at("h:p") },
      ),
      "apply-implication-hypothesis without selections": trace(
        "apply-implication-hypothesis",
        state("q", [["h:imp", ["Implies", "p", "q"]]]),
        target,
      ),
      "apply-implication-hypothesis without an ID generator": trace(
        "apply-implication-hypothesis",
        state("q", [
          ["h:imp", ["Implies", "p", "q"]],
          ["h:p", "p"],
        ]),
        { ...target, implication: at("h:imp"), antecedent: at("h:p") },
        { withIds: false },
      ),
      "mark-sorry": trace("mark-sorry", state("p"), target),
      "mark-sorry without an ID generator": trace("mark-sorry", state("p"), target, {
        withIds: false,
      }),
    }).toMatchInlineSnapshot(`
      {
        "apply-implication-hypothesis": [
          "menus resultHypothesisId(auto)[1] pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"apply-implication-hypothesis","implicationHypothesisId":"h:imp","antecedentHypothesisId":"h:p","resultHypothesisId":"statement:command:1:result-hypothesis:1"}",
        ],
        "apply-implication-hypothesis without an ID generator": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"apply-implication-hypothesis","implicationHypothesisId":"h:imp","antecedentHypothesisId":"h:p","resultHypothesisId":"statement:command:1:result-hypothesis:1"}",
        ],
        "apply-implication-hypothesis without selections": [
          "menus FAIL missing-selection: The implication slot needs a selected hypothesis.",
          "missing-selection: The implication slot needs a selected hypothesis.",
        ],
        "close-by-accepted-inference with attestations": [
          "menus attestationId[2] pending=[attestationId]",
          "requires-input: Choose a menu item for: attestationId.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"close-by-accepted-inference","attestationId":"attestation:one"}",
        ],
        "close-by-accepted-inference without attestations": [
          "menus attestationId[0] pending=[attestationId]",
          "not-applicable: No item in the current context is available for attestationId.",
        ],
        "close-by-contradiction": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"close-by-contradiction","hypothesisId":"h:p","negationHypothesisId":"h:not"}",
        ],
        "close-by-contradiction without a negation selection": [
          "menus FAIL missing-selection: The negation slot needs a selected hypothesis.",
          "missing-selection: The negation slot needs a selected hypothesis.",
        ],
        "close-by-contradiction without selections": [
          "menus FAIL missing-selection: The fact slot needs a selected hypothesis.",
          "missing-selection: The fact slot needs a selected hypothesis.",
        ],
        "close-by-hypothesis": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"close-by-hypothesis","hypothesisId":"h:p"}",
        ],
        "close-by-hypothesis without a hypothesis selection": [
          "menus FAIL missing-selection: The fact slot needs a selected hypothesis.",
          "missing-selection: The fact slot needs a selected hypothesis.",
        ],
        "close-false-hypothesis": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"close-false-hypothesis","hypothesisId":"h:false"}",
        ],
        "close-false-hypothesis without a hypothesis selection": [
          "menus FAIL missing-selection: The false slot needs a selected hypothesis.",
          "missing-selection: The false slot needs a selected hypothesis.",
        ],
        "close-reflexive-equality": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"close-reflexive-equality"}",
        ],
        "close-true": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"close-true"}",
        ],
        "drop-hypothesis": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"drop-hypothesis","hypothesisId":"h:p"}",
        ],
        "drop-hypothesis without a hypothesis selection": [
          "menus FAIL missing-selection: The dropped slot needs a selected hypothesis.",
          "missing-selection: The dropped slot needs a selected hypothesis.",
        ],
        "mark-sorry": [
          "menus assumptionId(auto)[1] pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"mark-sorry","assumptionId":"assumption:command:1:sorry:1"}",
        ],
        "mark-sorry without an ID generator": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"mark-sorry","assumptionId":"assumption:command:1:sorry:1"}",
        ],
      }
    `);
  });
});

describe("walk of the connective moves", () => {
  it("pins the traces", () => {
    expect({
      "introduce-implication": trace("introduce-implication", state(["Implies", "p", "q"]), target),
      "introduce-implication without an ID generator": trace(
        "introduce-implication",
        state(["Implies", "p", "q"]),
        target,
        { withIds: false },
      ),
      "introduce-negation": trace("introduce-negation", state(["Not", "p"]), target),
      "split-goal-conjunction": trace(
        "split-goal-conjunction",
        state(["And", "p", "q", "r"]),
        target,
      ),
      "split-goal-conjunction on a non-conjunction": trace(
        "split-goal-conjunction",
        state("p"),
        target,
      ),
      "expand-hypothesis-conjunction": trace(
        "expand-hypothesis-conjunction",
        state("r", [["h:and", ["And", "p", "q", "r"]]]),
        { ...target, conjunction: at("h:and") },
      ),
      "expand-hypothesis-conjunction on a non-conjunction": trace(
        "expand-hypothesis-conjunction",
        state("r", [["h:or", ["Or", "p", "q"]]]),
        { ...target, conjunction: at("h:or") },
      ),
      "expand-hypothesis-conjunction without a hypothesis selection": trace(
        "expand-hypothesis-conjunction",
        state("r", [["h:and", ["And", "p", "q"]]]),
        { ...target, conjunction: at("conclusion") },
      ),
      "split-hypothesis-disjunction": trace(
        "split-hypothesis-disjunction",
        state("r", [["h:or", ["Or", "p", "q", "r"]]]),
        { ...target, disjunction: at("h:or") },
      ),
      "split-hypothesis-disjunction on a non-disjunction": trace(
        "split-hypothesis-disjunction",
        state("r", [["h:and", ["And", "p", "q"]]]),
        { ...target, disjunction: at("h:and") },
      ),
      "split-hypothesis-disjunction without an ID generator": trace(
        "split-hypothesis-disjunction",
        state("r", [["h:or", ["Or", "p", "q"]]]),
        { ...target, disjunction: at("h:or") },
        { withIds: false },
      ),
      "choose-goal-disjunct": trace("choose-goal-disjunct", state(["Or", "p", "q", "r"]), target),
      "choose-goal-disjunct on a non-disjunction": trace(
        "choose-goal-disjunct",
        state("p"),
        target,
      ),
      "split-classical-cases": trace(
        "split-classical-cases",
        state("r", [["h:imp", ["Implies", "p", "r"]]]),
        target,
      ),
      "split-classical-cases from a selected proposition": trace(
        "split-classical-cases",
        state(["Or", "p", "q"]),
        { target: at("conclusion", [1]) },
      ),
      "assume-hypothesis": trace(
        "assume-hypothesis",
        state("r", [["h:imp", ["Implies", "p", "r"]]]),
        target,
      ),
      "replace-goal": trace("replace-goal", state(["And", "p", "q"]), target),
      suffices: trace("suffices", state("q", [["h:p", "p"]]), target),
      "suffices without an ID generator": trace("suffices", state("q", [["h:p", "p"]]), target, {
        withIds: false,
      }),
    }).toMatchInlineSnapshot(`
      {
        "assume-hypothesis": [
          "menus proposition[3] hypothesisId(auto)[1] pending=[proposition]",
          "requires-input: Choose a menu item for: proposition.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"assume-hypothesis","proposition":"r","hypothesisId":"statement:command:1:hypothesis:1"}",
        ],
        "choose-goal-disjunct": [
          "menus disjunctIndex[3] pending=[disjunctIndex]",
          "requires-input: Choose a menu item for: disjunctIndex.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"choose-goal-disjunct","disjunctIndex":0}",
        ],
        "choose-goal-disjunct on a non-disjunction": [
          "menus disjunctIndex[0] pending=[disjunctIndex]",
          "not-applicable: No item in the current context is available for disjunctIndex.",
        ],
        "expand-hypothesis-conjunction": [
          "menus expandedHypothesisIds(auto)[1] pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"expand-hypothesis-conjunction","hypothesisId":"h:and","expandedHypothesisIds":["statement:command:1:expanded-hypothesis:1","statement:command:1:expanded-hypothesis:2","statement:command:1:expanded-hypothesis:3"]}",
        ],
        "expand-hypothesis-conjunction on a non-conjunction": [
          "menus FAIL not-applicable: The hypothesis is not a conjunction.",
          "not-applicable: The hypothesis is not a conjunction.",
        ],
        "expand-hypothesis-conjunction without a hypothesis selection": [
          "menus FAIL missing-selection: The conjunction slot needs a selected hypothesis.",
          "missing-selection: The conjunction slot needs a selected hypothesis.",
        ],
        "introduce-implication": [
          "menus hypothesisId(auto)[1] pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"introduce-implication","hypothesisId":"statement:command:1:hypothesis:1"}",
        ],
        "introduce-implication without an ID generator": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"introduce-implication","hypothesisId":"statement:command:1:hypothesis:1"}",
        ],
        "introduce-negation": [
          "menus hypothesisId(auto)[1] pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"introduce-negation","hypothesisId":"statement:command:1:hypothesis:1"}",
        ],
        "replace-goal": [
          "menus proposition[2] pending=[proposition]",
          "requires-input: Choose a menu item for: proposition.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"replace-goal","proposition":"p"}",
        ],
        "split-classical-cases": [
          "menus proposition[3] childIds(auto)[1] branchHypothesisIds(auto)[1] pending=[proposition]",
          "requires-input: Choose a menu item for: proposition.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"split-classical-cases","proposition":"r","childIds":["statement:command:1:child:1","statement:command:1:child:2"],"branchHypothesisIds":["statement:command:1:branch-hypothesis:1","statement:command:1:branch-hypothesis:2"]}",
        ],
        "split-classical-cases from a selected proposition": [
          "menus proposition[3] childIds(auto)[1] branchHypothesisIds(auto)[1] pending=[proposition]",
          "requires-input: Choose a menu item for: proposition.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"split-classical-cases","proposition":"q","childIds":["statement:command:1:child:1","statement:command:1:child:2"],"branchHypothesisIds":["statement:command:1:branch-hypothesis:1","statement:command:1:branch-hypothesis:2"]}",
        ],
        "split-goal-conjunction": [
          "menus childIds(auto)[1] pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"split-goal-conjunction","childIds":["statement:command:1:child:1","statement:command:1:child:2","statement:command:1:child:3"]}",
        ],
        "split-goal-conjunction on a non-conjunction": [
          "menus FAIL not-applicable: The target is not a conjunction.",
          "not-applicable: The target is not a conjunction.",
        ],
        "split-hypothesis-disjunction": [
          "menus childIds(auto)[1] branchHypothesisIds(auto)[1] pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"split-hypothesis-disjunction","hypothesisId":"h:or","childIds":["statement:command:1:child:1","statement:command:1:child:2","statement:command:1:child:3"],"branchHypothesisIds":["statement:command:1:branch-hypothesis:1","statement:command:1:branch-hypothesis:2","statement:command:1:branch-hypothesis:3"]}",
        ],
        "split-hypothesis-disjunction on a non-disjunction": [
          "menus FAIL not-applicable: The hypothesis is not a disjunction.",
          "not-applicable: The hypothesis is not a disjunction.",
        ],
        "split-hypothesis-disjunction without an ID generator": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"split-hypothesis-disjunction","hypothesisId":"h:or","childIds":["statement:command:1:child:1","statement:command:1:child:2"],"branchHypothesisIds":["statement:command:1:branch-hypothesis:1","statement:command:1:branch-hypothesis:2"]}",
        ],
        "suffices": [
          "menus proposition[2] obligationId(auto)[1] pending=[proposition]",
          "requires-input: Choose a menu item for: proposition.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"suffices","proposition":"q","obligationId":"statement:command:1:obligation:1"}",
        ],
        "suffices without an ID generator": [
          "menus proposition[2] pending=[proposition]",
          "requires-input: Choose a menu item for: proposition.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"suffices","proposition":"q","obligationId":"statement:command:1:obligation:1"}",
        ],
      }
    `);
  });
});

describe("walk of the quantifier moves", () => {
  it("pins the traces", () => {
    const universalHypothesis = state(
      ["Lt", "a", ["S", "a"]],
      [["h:all", ["ForAll", "x", ["Lt", "x", ["S", "x"]]]]],
    );
    const typedHypothesis = state(["Lt", "a", ["S", "a"]], [["h:all", typedUniversal]]);
    const instantiate = { ...target, universal: at("h:all"), term: at("conclusion", [0]) };
    expect({
      "introduce-universal untyped": trace(
        "introduce-universal",
        state(["ForAll", "x", ["Lt", "x", ["S", "x"]]]),
        target,
      ),
      "introduce-universal typed": trace("introduce-universal", state(typedUniversal), target),
      "introduce-universal typed without an ID generator": trace(
        "introduce-universal",
        state(typedUniversal),
        target,
        { withIds: false },
      ),
      "introduce-universal on a non-universal": trace("introduce-universal", state("p"), target),
      "instantiate-universal-hypothesis untyped": trace(
        "instantiate-universal-hypothesis",
        universalHypothesis,
        instantiate,
      ),
      "instantiate-universal-hypothesis typed": trace(
        "instantiate-universal-hypothesis",
        typedHypothesis,
        instantiate,
      ),
      "instantiate-universal-hypothesis on a non-universal": trace(
        "instantiate-universal-hypothesis",
        state("r", [["h:p", "p"]]),
        { ...target, universal: at("h:p") },
      ),
      "instantiate-universal-hypothesis without a hypothesis selection": trace(
        "instantiate-universal-hypothesis",
        universalHypothesis,
        { ...target, universal: at("conclusion") },
      ),
      "choose-existential-witness untyped": trace(
        "choose-existential-witness",
        state(["Exists", "x", ["Lt", "a", "x"]]),
        target,
      ),
      "choose-existential-witness typed": trace(
        "choose-existential-witness",
        state(typedExistential),
        target,
      ),
      "choose-existential-witness on a non-existential": trace(
        "choose-existential-witness",
        state("p"),
        target,
      ),
      "unpack-existential-hypothesis untyped": trace(
        "unpack-existential-hypothesis",
        state("p", [["h:ex", ["Exists", "w", ["Lt", "a", "w"]]]], witnessDeclarations),
        { ...target, existential: at("h:ex") },
      ),
      "unpack-existential-hypothesis typed": trace(
        "unpack-existential-hypothesis",
        state("p", [["h:ex", typedExistential]]),
        { ...target, existential: at("h:ex") },
      ),
      "unpack-existential-hypothesis typed without an ID generator": trace(
        "unpack-existential-hypothesis",
        state("p", [["h:ex", typedExistential]]),
        { ...target, existential: at("h:ex") },
        { withIds: false },
      ),
      "unpack-existential-hypothesis without a hypothesis selection": trace(
        "unpack-existential-hypothesis",
        state("p", [["h:ex", typedExistential]]),
        { ...target, existential: at("conclusion") },
      ),
    }).toMatchInlineSnapshot(`
      {
        "choose-existential-witness on a non-existential": [
          "menus FAIL not-applicable: The target conclusion is not existential.",
          "not-applicable: The target conclusion is not existential.",
        ],
        "choose-existential-witness typed": [
          "menus witness[3] pending=[witness]",
          "requires-input: Choose a menu item for: witness.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"choose-existential-witness","witness":"a"}",
        ],
        "choose-existential-witness untyped": [
          "menus witness[3] pending=[witness]",
          "requires-input: Choose a menu item for: witness.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"choose-existential-witness","witness":"a"}",
        ],
        "instantiate-universal-hypothesis on a non-universal": [
          "menus FAIL not-applicable: The hypothesis is not a universal statement.",
          "not-applicable: The hypothesis is not a universal statement.",
        ],
        "instantiate-universal-hypothesis typed": [
          "menus term[4] resultHypothesisId(auto)[1] pending=[term]",
          "requires-input: Choose a menu item for: term.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"instantiate-universal-hypothesis","hypothesisId":"h:all","term":"a","resultHypothesisId":"statement:command:1:result-hypothesis:1","membershipObligationId":"statement:command:1:membership-obligation:1"}",
        ],
        "instantiate-universal-hypothesis untyped": [
          "menus term[4] resultHypothesisId(auto)[1] pending=[term]",
          "requires-input: Choose a menu item for: term.",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"instantiate-universal-hypothesis","hypothesisId":"h:all","term":"a","resultHypothesisId":"statement:command:1:result-hypothesis:1"}",
        ],
        "instantiate-universal-hypothesis without a hypothesis selection": [
          "menus FAIL missing-selection: The universal slot needs a selected hypothesis.",
          "missing-selection: The universal slot needs a selected hypothesis.",
        ],
        "introduce-universal on a non-universal": [
          "menus FAIL not-applicable: The target conclusion is not a universal statement.",
          "not-applicable: The target conclusion is not a universal statement.",
        ],
        "introduce-universal typed": [
          "menus parameterDeclarationId(auto)[1] membershipHypothesisId(auto)[1] pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"introduce-universal","parameterDeclarationId":"statement:command:1:parameter:1","membershipHypothesisId":"statement:command:1:membership-hypothesis:1"}",
        ],
        "introduce-universal typed without an ID generator": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"introduce-universal","parameterDeclarationId":"statement:command:1:parameter:1","membershipHypothesisId":"statement:command:1:membership-hypothesis:1"}",
        ],
        "introduce-universal untyped": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"introduce-universal"}",
        ],
        "unpack-existential-hypothesis typed": [
          "menus resultHypothesisId(auto)[1] witnessDeclarationId(auto)[1] membershipHypothesisId(auto)[1] pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"unpack-existential-hypothesis","hypothesisId":"h:ex","resultHypothesisId":"statement:command:1:result-hypothesis:1","witnessDeclarationId":"statement:command:1:witness:1","membershipHypothesisId":"statement:command:1:membership-hypothesis:1"}",
        ],
        "unpack-existential-hypothesis typed without an ID generator": [
          "menus  pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"unpack-existential-hypothesis","hypothesisId":"h:ex","resultHypothesisId":"statement:command:1:result-hypothesis:1","witnessDeclarationId":"statement:command:1:witness:1","membershipHypothesisId":"statement:command:1:membership-hypothesis:1"}",
        ],
        "unpack-existential-hypothesis untyped": [
          "menus resultHypothesisId(auto)[1] pending=[]",
          "ok {"expectedStateId":"state:before","resultStateId":"state:command:1","target":{"kind":"goal","id":"goal:main"},"kind":"unpack-existential-hypothesis","hypothesisId":"h:ex","resultHypothesisId":"statement:command:1:result-hypothesis:1"}",
        ],
        "unpack-existential-hypothesis without a hypothesis selection": [
          "menus FAIL missing-selection: The existential slot needs a selected hypothesis.",
          "missing-selection: The existential slot needs a selected hypothesis.",
        ],
      }
    `);
  });
});
