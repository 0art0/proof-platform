import { describe, expect, it } from "vitest";
import {
  KERNEL_OPERATION_KINDS,
  applyTransition,
  type KernelEnvironment,
  type KernelOperationKind,
  type KernelResult,
} from "@proof/kernel";
import { CORE_LOGIC_RESULTS } from "@proof/library";
import {
  PROPOSITION_SORT,
  createExecutableProofStateSchema,
  operatorDeclarationsSchema,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  HAND_AUTHORED_MOVES,
  approvedKernelResults,
  commandIdGenerator,
  generateParameterMenus,
  materializeMoveOperation,
  materializeResultApplication,
  type MoveDefinition,
  type MoveMenuChoices,
  type MoveSelectionInput,
  type MoveSelections,
  type ParameterMenuItem,
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

type HypothesisInput = Readonly<{ id: string; expression: PlainMathJson }>;

function sequent(conclusion: PlainMathJson, hypotheses: readonly HypothesisInput[] = []) {
  return {
    context: {
      declarations,
      hypotheses: hypotheses.map(({ id, expression }) => ({ id, statement: { expression } })),
    },
    conclusion: { expression: conclusion },
  };
}

function state(
  conclusion: PlainMathJson,
  hypotheses: readonly HypothesisInput[] = [],
  extra: Readonly<Record<string, unknown>> = {},
): ExecutableProofState {
  return stateSchema.parse({
    id: "state:before",
    goals: [{ id: "goal:main", sequent: sequent(conclusion, hypotheses) }],
    obligations: [],
    ...extra,
  }) as ExecutableProofState;
}

function moveFor(kind: KernelOperationKind): MoveDefinition {
  const move = HAND_AUTHORED_MOVES.find(
    (candidate) => candidate.implementation.operationKind === kind,
  );
  if (move === undefined) throw new Error(`Missing move for ${kind}.`);
  return move;
}

function at(
  statement: "conclusion" | string,
  path: readonly number[] = [],
  target = "goal:main",
): MoveSelectionInput {
  return {
    kind: "exact",
    anchor: {
      stateId: "state:before",
      target: { kind: "goal", id: target as never },
      statement:
        statement === "conclusion"
          ? { kind: "conclusion" }
          : { kind: "hypothesis", id: statement as never },
    },
    path,
  };
}

const ids = commandIdGenerator("command:1");

const resultEnvironment: KernelEnvironment = {
  operators,
  results: [
    {
      id: "result:conjunction-introduction",
      parameters: [
        { symbol: "s", sort: PROPOSITION_SORT },
        { symbol: "t", sort: PROPOSITION_SORT },
      ],
      premises: [{ expression: "s" }, { expression: "t" }],
      conclusion: { expression: ["And", "s", "t"] },
      directions: ["backward"],
    },
    {
      id: "result:transitivity",
      parameters: ["i", "j", "k"].map((symbol) => ({ symbol, sort: NATURAL })),
      premises: [{ expression: ["Lt", "i", "j"] }, { expression: ["Lt", "j", "k"] }],
      conclusion: { expression: ["Lt", "i", "k"] },
      directions: ["backward", "forward"],
    },
    {
      id: "result:double-negation",
      parameters: [{ symbol: "s", sort: PROPOSITION_SORT }],
      premises: [],
      conclusion: { expression: ["Equivalent", "s", ["Not", ["Not", "s"]]] },
      directions: ["backward", "forward"],
    },
  ] as unknown as readonly KernelResult[],
};

function menusOf(
  input: ExecutableProofState,
  kind: KernelOperationKind,
  selections: MoveSelections,
  environment: KernelEnvironment = { operators },
  menuChoices: MoveMenuChoices = {},
) {
  const result = generateParameterMenus(input, moveFor(kind), selections, environment, {
    menuChoices,
    idGenerator: ids,
    attestationIds: ["attestation:checked"],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result;
}

function menuValues(
  input: ExecutableProofState,
  kind: KernelOperationKind,
  selections: MoveSelections,
  parameterId: string,
  environment: KernelEnvironment = { operators },
  menuChoices: MoveMenuChoices = {},
): readonly unknown[] {
  const menu = menusOf(input, kind, selections, environment, menuChoices).menus.find(
    (candidate) => candidate.parameterId === parameterId,
  );
  return (menu?.items ?? []).map((item) => {
    const value = item.value as Readonly<Record<string, unknown>>;
    return value.expression ?? value.index ?? value.direction ?? value.source ?? value;
  });
}

type Picker = Readonly<Record<string, (item: ParameterMenuItem) => boolean>>;

/** Choose pending menu items (the first one unless a picker is given) until nothing is pending. */
function chooseAll(
  input: ExecutableProofState,
  kind: KernelOperationKind,
  selections: MoveSelections,
  environment: KernelEnvironment,
  pickers: Picker = {},
): MoveMenuChoices {
  const choices: Record<string, string> = {};
  for (let round = 0; round < 10; round += 1) {
    const result = menusOf(input, kind, selections, environment, choices);
    if (result.pendingParameters.length === 0) return choices;
    for (const parameterId of result.pendingParameters) {
      const items = result.menus.find((menu) => menu.parameterId === parameterId)?.items ?? [];
      const picker = pickers[parameterId];
      const item = picker === undefined ? items[0] : items.find(picker);
      if (item === undefined) throw new Error(`No item for ${parameterId}.`);
      choices[parameterId] = item.id;
    }
  }
  throw new Error("Menus did not converge.");
}

function termIs(expression: PlainMathJson): (item: ParameterMenuItem) => boolean {
  return (item) =>
    JSON.stringify((item.value as { expression?: unknown }).expression) ===
    JSON.stringify(expression);
}

type RoundTrip = Readonly<{
  kind: KernelOperationKind;
  input: ExecutableProofState;
  selections: MoveSelections;
  environment?: KernelEnvironment;
  pickers?: Picker;
}>;

const withSorry = (() => {
  const base = stateSchema.parse({
    id: "state:sorry-source",
    goals: [
      {
        id: "goal:source",
        sequent: sequent(["Lt", "a", "b"], [{ id: "h:ba", expression: ["Lt", "b", "a"] }]),
      },
      {
        id: "goal:main",
        sequent: sequent(["Lt", "x", "a"], [{ id: "h:ax", expression: ["Lt", "a", "x"] }]),
      },
    ],
    obligations: [],
  }) as ExecutableProofState;
  const sorried = applyTransition(
    base,
    {
      kind: "mark-sorry",
      expectedStateId: "state:sorry-source",
      resultStateId: "state:before",
      target: { kind: "goal", id: "goal:source" },
      assumptionId: "assumption:sorry",
    },
    { operators },
  );
  if (!sorried.ok) throw new Error("Expected the sorry to apply.");
  return sorried.state;
})();

const roundTrips: readonly RoundTrip[] = [
  {
    kind: "close-by-hypothesis",
    input: state("p", [{ id: "h:p", expression: "p" }]),
    selections: { target: at("conclusion"), fact: at("h:p") },
  },
  { kind: "close-true", input: state("True"), selections: { target: at("conclusion") } },
  {
    kind: "close-false-hypothesis",
    input: state("p", [{ id: "h:false", expression: "False" }]),
    selections: { target: at("conclusion"), false: at("h:false") },
  },
  {
    kind: "close-reflexive-equality",
    input: state(["Equal", "a", "a"]),
    selections: { target: at("conclusion") },
  },
  {
    kind: "close-by-contradiction",
    input: state("r", [
      { id: "h:p", expression: "p" },
      { id: "h:not-p", expression: ["Not", "p"] },
    ]),
    selections: { target: at("conclusion"), fact: at("h:p"), negation: at("h:not-p") },
  },
  {
    kind: "close-by-accepted-inference",
    input: state("p"),
    selections: { target: at("conclusion") },
  },
  {
    kind: "introduce-implication",
    input: state(["Implies", "p", "q"]),
    selections: { target: at("conclusion") },
  },
  {
    kind: "introduce-negation",
    input: state(["Not", "p"]),
    selections: { target: at("conclusion") },
  },
  {
    kind: "split-goal-conjunction",
    input: state(["And", "p", "q", "r"]),
    selections: { target: at("conclusion") },
  },
  {
    kind: "choose-goal-disjunct",
    input: state(["Or", "p", "q"]),
    selections: { target: at("conclusion") },
  },
  {
    kind: "expand-hypothesis-conjunction",
    input: state("r", [{ id: "h:and", expression: ["And", "p", "q"] }]),
    selections: { target: at("conclusion"), conjunction: at("h:and") },
  },
  {
    kind: "split-hypothesis-disjunction",
    input: state("r", [{ id: "h:or", expression: ["Or", "p", "q"] }]),
    selections: { target: at("conclusion"), disjunction: at("h:or") },
  },
  {
    kind: "split-classical-cases",
    input: state("r", [{ id: "h:imp", expression: ["Implies", "p", "r"] }]),
    selections: { target: at("conclusion") },
  },
  {
    kind: "assume-hypothesis",
    input: state("r", [{ id: "h:imp", expression: ["Implies", "p", "r"] }]),
    selections: { target: at("conclusion") },
  },
  {
    kind: "replace-goal",
    input: state(["And", "p", "q"]),
    selections: { target: at("conclusion") },
  },
  {
    kind: "suffices",
    input: state("q", [{ id: "h:p", expression: "p" }]),
    selections: { target: at("conclusion") },
  },
  {
    kind: "drop-hypothesis",
    input: state("q", [{ id: "h:p", expression: "p" }]),
    selections: { dropped: at("h:p") },
  },
  {
    kind: "apply-implication-hypothesis",
    input: state("q", [
      { id: "h:imp", expression: ["Implies", "p", "q"] },
      { id: "h:p", expression: "p" },
    ]),
    selections: { target: at("conclusion"), implication: at("h:imp"), antecedent: at("h:p") },
  },
  {
    kind: "introduce-universal",
    input: state(["ForAll", "x", ["Lt", "x", ["S", "x"]]]),
    selections: { target: at("conclusion") },
  },
  {
    kind: "instantiate-universal-hypothesis",
    input: state(
      ["Lt", "a", ["S", "a"]],
      [{ id: "h:all", expression: ["ForAll", "x", ["Lt", "x", ["S", "x"]]] }],
    ),
    selections: { target: at("conclusion"), universal: at("h:all"), term: at("conclusion", [0]) },
  },
  {
    kind: "choose-existential-witness",
    input: state(["Exists", "x", ["Lt", "a", "x"]]),
    selections: { target: at("conclusion") },
  },
  {
    kind: "unpack-existential-hypothesis",
    input: stateSchema.parse({
      id: "state:before",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: [
                ...declarations,
                {
                  id: "declaration:w",
                  symbol: "w",
                  sort: NATURAL,
                  role: "local-witness",
                },
              ],
              hypotheses: [
                { id: "h:ex", statement: { expression: ["Exists", "w", ["Lt", "a", "w"]] } },
              ],
            },
            conclusion: { expression: "p" },
          },
        },
      ],
      obligations: [],
    }) as ExecutableProofState,
    selections: { target: at("conclusion"), existential: at("h:ex") },
  },
  {
    kind: "rewrite-with-equality",
    input: state(["Lt", "a", ["S", "b"]], [{ id: "h:eq", expression: ["Equal", "b", "a"] }]),
    selections: {
      target: at("conclusion"),
      equality: at("h:eq"),
      occurrence: at("conclusion", [1, 0]),
    },
  },
  {
    kind: "rewrite-with-equivalence",
    input: state(["Not", "p"], [{ id: "h:iff", expression: ["Equivalent", "p", "q"] }]),
    selections: { target: at("conclusion"), occurrence: at("conclusion", [0]) },
  },
  {
    kind: "rewrite-with-implication",
    input: state(["Or", "q", "r"], [{ id: "h:imp", expression: ["Implies", "p", "q"] }]),
    selections: { target: at("conclusion"), occurrence: at("conclusion", [0]) },
  },
  {
    kind: "apply-result-backward",
    input: state(["And", "p", "q"]),
    selections: { target: at("conclusion") },
    environment: resultEnvironment,
  },
  {
    kind: "apply-result-forward",
    input: state("r", [
      { id: "h:ab", expression: ["Lt", "a", "b"] },
      { id: "h:bx", expression: ["Lt", "b", "x"] },
    ]),
    selections: { target: at("conclusion") },
    environment: resultEnvironment,
  },
  { kind: "mark-sorry", input: state("p"), selections: { target: at("conclusion") } },
  {
    kind: "close-by-assumption",
    input: withSorry,
    selections: { target: at("conclusion") },
  },
];

describe("materializeMoveOperation round trip", () => {
  it("covers every primitive kind", () => {
    expect(roundTrips.map(({ kind }) => kind).sort()).toEqual([...KERNEL_OPERATION_KINDS].sort());
  });

  it.each(roundTrips)("materializes $kind into an operation the kernel accepts", (entry) => {
    const environment = entry.environment ?? { operators };
    const menuChoices = chooseAll(
      entry.input,
      entry.kind,
      entry.selections,
      environment,
      entry.pickers,
    );
    const materialized = materializeMoveOperation({
      state: entry.input,
      move: moveFor(entry.kind),
      selections: entry.selections,
      menuChoices,
      idGenerator: ids,
      env: environment,
      attestationIds: ["attestation:checked"],
    });
    if (!materialized.ok) throw new Error(JSON.stringify(materialized.diagnostics));
    expect(materialized.operation).toMatchObject({
      kind: entry.kind,
      expectedStateId: entry.input.id,
      resultStateId: "state:command:1",
    });
    expect(Object.isFrozen(materialized.operation)).toBe(true);
    const transition = applyTransition(entry.input, materialized.operation, environment);
    expect(transition.diagnostics).toEqual([]);
    expect(transition.ok).toBe(true);
  });

  it("derives generated IDs exactly like the worker's command-ID convention", () => {
    const materialized = materializeMoveOperation({
      state: state("r", [{ id: "h:or", expression: ["Or", "p", "q"] }]),
      move: moveFor("split-hypothesis-disjunction"),
      selections: { target: at("conclusion"), disjunction: at("h:or") },
      idGenerator: ids,
    });
    expect(materialized).toMatchObject({
      ok: true,
      operation: {
        hypothesisId: "h:or",
        childIds: ["statement:command:1:child:1", "statement:command:1:child:2"],
        branchHypothesisIds: [
          "statement:command:1:branch-hypothesis:1",
          "statement:command:1:branch-hypothesis:2",
        ],
      },
    });
    expect(
      materializeMoveOperation({
        state: state("p"),
        move: moveFor("mark-sorry"),
        selections: { target: at("conclusion") },
        idGenerator: ids,
      }),
    ).toMatchObject({ ok: true, operation: { assumptionId: "assumption:command:1:sorry:1" } });
  });
});

describe("generateParameterMenus", () => {
  it("offers disjunct indices labelled with each disjunct", () => {
    const result = menusOf(state(["Or", "p", "q", ["And", "p", "q"]]), "choose-goal-disjunct", {
      target: at("conclusion"),
    });
    expect(result.pendingParameters).toEqual(["disjunctIndex"]);
    expect(
      result.menus[0]?.items.map(({ label, value, origin }) => [label, value, origin]),
    ).toEqual([
      [
        { kind: "math", expression: "p" },
        { kind: "index", index: 0 },
        { kind: "subterm-of", statement: { kind: "conclusion" }, path: [0] },
      ],
      [
        { kind: "math", expression: "q" },
        { kind: "index", index: 1 },
        { kind: "subterm-of", statement: { kind: "conclusion" }, path: [1] },
      ],
      [
        { kind: "math", expression: ["And", "p", "q"] },
        { kind: "index", index: 2 },
        { kind: "subterm-of", statement: { kind: "conclusion" }, path: [2] },
      ],
    ]);
  });

  it("orders instantiation terms selection-first, filters by sort, and omits bound subterms", () => {
    const input = state(
      ["Lt", "a", ["S", "b"]],
      [
        { id: "h:all", expression: ["ForAll", "x", ["Lt", "x", ["S", "x"]]] },
        { id: "h:ab", expression: ["Lt", "a", ["S", ["S", "a"]]] },
      ],
    );
    const selections = {
      target: at("conclusion"),
      universal: at("h:all"),
      term: at("conclusion", [1, 0]),
    };
    const terms = menuValues(input, "instantiate-universal-hypothesis", selections, "term");
    expect(terms).toEqual(["b", "a", "x", ["S", "b"], ["S", ["S", "a"]], ["S", "a"]]);
    expect(terms).not.toContain("p");
    expect(terms).not.toContainEqual(["S", "x"]);
    const origins = menusOf(input, "instantiate-universal-hypothesis", selections)
      .menus.find((menu) => menu.parameterId === "term")
      ?.items.map((item) => item.origin.kind);
    expect(origins).toEqual([
      "selection",
      "declaration",
      "declaration",
      "subterm-of",
      "subterm-of",
      "subterm-of",
    ]);
    // A selected proposition does not fit the natural-number binder, so it is not offered.
    expect(
      menuValues(
        input,
        "instantiate-universal-hypothesis",
        { ...selections, term: at("h:ab") },
        "term",
      )[0],
    ).toBe("a");
  });

  it("offers existential witnesses of the bound symbol's sort only", () => {
    expect(
      menuValues(
        state(["Exists", "x", ["Lt", "a", "x"]], [{ id: "h:p", expression: "p" }]),
        "choose-existential-witness",
        { target: at("conclusion") },
        "witness",
      ),
    ).toEqual(["a", "b", "x"]);
  });

  it("draws case-split propositions from selections, statements and proposition subterms", () => {
    const input = state(
      ["Or", "p", "q"],
      [
        { id: "h:imp", expression: ["Implies", "p", "r"] },
        { id: "h:lt", expression: ["Lt", "a", "b"] },
      ],
    );
    expect(
      menuValues(input, "split-classical-cases", { target: at("conclusion", [1]) }, "proposition"),
    ).toEqual(["q", ["Or", "p", "q"], ["Implies", "p", "r"], ["Lt", "a", "b"], "p", "r"]);
    // replace-goal never offers the current conclusion.
    expect(
      menuValues(input, "replace-goal", { target: at("conclusion") }, "proposition"),
    ).not.toContainEqual(["Or", "p", "q"]);
  });

  it("offers only kernel-valid rewrite directions and sources, the selected source first", () => {
    const equality = state(
      ["Lt", "a", ["S", "b"]],
      [{ id: "h:eq", expression: ["Equal", "b", "a"] }],
    );
    expect(
      menuValues(
        equality,
        "rewrite-with-equality",
        { target: at("conclusion"), equality: at("h:eq"), occurrence: at("conclusion", [1, 0]) },
        "direction",
      ),
    ).toEqual(["forward"]);

    const equivalence = state(
      ["Not", "p"],
      [
        { id: "h:iff", expression: ["Equivalent", "p", "q"] },
        { id: "h:other", expression: ["Equivalent", "q", "p"] },
        { id: "h:unrelated", expression: ["Equivalent", "q", "r"] },
      ],
    );
    const selections = {
      target: at("conclusion"),
      equivalence: at("h:other"),
      occurrence: at("conclusion", [0]),
    };
    const result = menusOf(equivalence, "rewrite-with-equivalence", selections, resultEnvironment);
    const sources = result.menus.find((menu) => menu.parameterId === "source")?.items ?? [];
    expect(sources.map(({ value, origin }) => [value, origin.kind])).toEqual([
      [
        { kind: "rewrite-source", source: { kind: "hypothesis", hypothesisId: "h:other" } },
        "selection",
      ],
      [
        { kind: "rewrite-source", source: { kind: "hypothesis", hypothesisId: "h:iff" } },
        "hypothesis",
      ],
      [
        {
          kind: "rewrite-source",
          source: { kind: "result", resultId: "result:double-negation", instantiation: { s: "p" } },
        },
        "result",
      ],
    ]);
    // The direction menu depends on the chosen source.
    expect(result.pendingParameters).toEqual(["source"]);
    expect(
      menuValues(
        equivalence,
        "rewrite-with-equivalence",
        selections,
        "direction",
        resultEnvironment,
        {
          source: sources[0]?.id ?? "",
        },
      ),
    ).toEqual(["backward"]);
  });

  it("asks for result parameters that the conclusion does not determine", () => {
    const input = state(["Lt", "a", "x"], [{ id: "h:p", expression: "p" }]);
    const selections = { target: at("conclusion") };
    const [resultItem] =
      menusOf(input, "apply-result-backward", selections, resultEnvironment).menus[0]?.items ?? [];
    expect(resultItem?.value).toEqual({ kind: "result", resultId: "result:transitivity" });
    const partial = materializeMoveOperation({
      state: input,
      move: moveFor("apply-result-backward"),
      selections,
      menuChoices: { resultId: resultItem?.id ?? "" },
      idGenerator: ids,
      env: resultEnvironment,
    });
    expect(partial).toMatchObject({
      ok: false,
      missingParameters: ["instantiation/j"],
      diagnostics: [{ code: "requires-input" }],
    });
    expect(
      menuValues(input, "apply-result-backward", selections, "instantiation/j", resultEnvironment, {
        resultId: resultItem?.id ?? "",
      }),
    ).toEqual(["a", "b", "x"]);
  });

  it("reports generated IDs as automatic single-item menus", () => {
    const menus = menusOf(state(["And", "p", "q"]), "split-goal-conjunction", {
      target: at("conclusion"),
    });
    expect(menus.pendingParameters).toEqual([]);
    expect(menus.menus).toMatchObject([
      {
        parameterId: "childIds",
        automatic: true,
        items: [
          {
            value: {
              kind: "generated-ids",
              ids: ["statement:command:1:child:1", "statement:command:1:child:2"],
            },
            origin: { kind: "generated" },
          },
        ],
      },
    ]);
  });

  it("is deterministic: equal inputs give equal menus and item IDs", () => {
    const input = state(["Exists", "x", ["Lt", "a", "x"]]);
    const first = menusOf(input, "choose-existential-witness", { target: at("conclusion") });
    const second = menusOf(structuredClone(input), "choose-existential-witness", {
      target: at("conclusion"),
    });
    expect(second).toEqual(first);
    expect(Object.isFrozen(first.menus)).toBe(true);
  });
});

describe("materialization rejects anything outside the regenerated menus", () => {
  const input = state(["Exists", "x", ["Lt", "a", "x"]]);
  const request = {
    state: input,
    move: moveFor("choose-existential-witness"),
    selections: { target: at("conclusion") },
    idGenerator: ids,
    env: { operators },
  };

  it("rejects a fabricated or stale choice ID", () => {
    expect(
      materializeMoveOperation({ ...request, menuChoices: { witness: "menu-item:fabricated" } }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-choice" }] });
    const other = state(["Exists", "x", ["Lt", ["S", "b"], "x"]]);
    const staleItem = menusOf(other, "choose-existential-witness", {
      target: at("conclusion"),
    }).menus[0]?.items.find(termIs(["S", "b"]));
    expect(staleItem).toBeDefined();
    expect(
      materializeMoveOperation({ ...request, menuChoices: { witness: staleItem?.id ?? "" } }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-choice" }] });
  });

  it("rejects choices for parameters the move does not have, and unknown slots", () => {
    const [item] =
      menusOf(input, "choose-existential-witness", { target: at("conclusion") }).menus[0]?.items ??
      [];
    expect(
      materializeMoveOperation({
        ...request,
        menuChoices: { witness: item?.id ?? "", expression: "anything" },
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "unexpected-choice" }] });
    expect(
      materializeMoveOperation({
        ...request,
        selections: { target: at("conclusion"), payload: at("conclusion") },
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-selection" }] });
  });

  it("reports missing input and empty menus distinctly", () => {
    expect(materializeMoveOperation(request)).toMatchObject({
      ok: false,
      missingParameters: ["witness"],
      menus: [{ parameterId: "witness", automatic: false }],
      diagnostics: [{ code: "requires-input" }],
    });
    expect(
      materializeMoveOperation({
        ...request,
        move: moveFor("choose-goal-disjunct"),
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "not-applicable" }] });
  });
});

describe("materializeResultApplication", () => {
  const catalog = approvedKernelResults(CORE_LOGIC_RESULTS);
  if (!catalog.ok) throw new Error("Expected the core catalog to adapt.");
  const environment: KernelEnvironment = { results: catalog.results };

  it("applies modus ponens forward from a hypothesis suggestion, leaving the antecedent as an obligation", () => {
    const input = state("r", [{ id: "h:imp", expression: ["Implies", "p", "q"] }]);
    const materialized = materializeResultApplication(
      {
        state: input,
        resultId: "result:modus-ponens",
        direction: "forward",
        target: { kind: "goal", id: "goal:main" as never },
        substitutions: [
          { symbol: "p", expression: "p" },
          { symbol: "q", expression: "q" },
        ],
      },
      environment,
      ids,
    );
    expect(materialized).toMatchObject({
      ok: true,
      operation: {
        kind: "apply-result-forward",
        resultId: "result:modus-ponens",
        instantiation: { p: "p", q: "q" },
        premiseHypothesisIds: ["h:imp", null],
        resultHypothesisId: "statement:command:1:result-hypothesis:1",
        obligationIds: ["statement:command:1:obligation:1"],
      },
    });
    if (!materialized.ok) return;
    expect(applyTransition(input, materialized.operation, environment)).toMatchObject({
      ok: true,
      evidence: "library-result",
    });
  });

  it("matches every premise locally when the antecedent is available", () => {
    const input = state("r", [
      { id: "h:imp", expression: ["Implies", "p", "q"] },
      { id: "h:p", expression: "p" },
    ]);
    expect(
      materializeResultApplication(
        {
          state: input,
          resultId: "result:modus-ponens",
          direction: "forward",
          target: { kind: "goal", id: "goal:main" as never },
          substitutions: [],
        },
        environment,
        ids,
      ),
    ).toMatchObject({
      ok: true,
      operation: { premiseHypothesisIds: ["h:imp", "h:p"], obligationIds: [] },
    });
  });

  it("turns an equivalence suggestion on an occurrence into a result-sourced rewrite", () => {
    const input = state(["Or", ["And", "p", "q"], "r"]);
    const materialized = materializeResultApplication(
      {
        state: input,
        resultId: "result:conjunction-commutativity",
        direction: "forward",
        target: { kind: "goal", id: "goal:main" as never },
        substitutions: [
          { symbol: "p", expression: "p" },
          { symbol: "q", expression: "q" },
        ],
        occurrence: at("conclusion", [0]),
      },
      environment,
      ids,
    );
    expect(materialized).toMatchObject({
      ok: true,
      operation: {
        kind: "rewrite-with-equivalence",
        source: {
          kind: "result",
          resultId: "result:conjunction-commutativity",
          instantiation: { p: "p", q: "q" },
        },
        direction: "forward",
      },
    });
    if (!materialized.ok) return;
    expect(applyTransition(input, materialized.operation, environment)).toMatchObject({
      ok: true,
      state: {
        goals: [{ sequent: { conclusion: { expression: ["Or", ["And", "q", "p"], "r"] } } }],
      },
    });
  });

  it("rejects substitutions that are not drawn from the target's context", () => {
    expect(
      materializeResultApplication(
        {
          state: state("r", [{ id: "h:imp", expression: ["Implies", "p", "q"] }]),
          resultId: "result:modus-ponens",
          direction: "forward",
          target: { kind: "goal", id: "goal:main" as never },
          substitutions: [{ symbol: "p", expression: ["And", "p", "r"] }],
        },
        environment,
        ids,
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-request" }] });
  });

  it("rejects a backward suggestion whose result does not match the target", () => {
    expect(
      materializeResultApplication(
        {
          state: state("r"),
          resultId: "result:excluded-middle",
          direction: "backward",
          target: { kind: "goal", id: "goal:main" as never },
          substitutions: [],
        },
        environment,
        ids,
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-choice" }] });
  });
});

describe("close-by-assumption menus", () => {
  it("lists matching assumptions and derives the instantiation from the conclusion and hypotheses", () => {
    const result = menusOf(withSorry, "close-by-assumption", { target: at("conclusion") });
    expect(result.menus[0]?.items.map((item) => item.value)).toEqual([
      { kind: "assumption", assumptionId: "assumption:sorry" },
    ]);
    const choices = chooseAll(
      withSorry,
      "close-by-assumption",
      { target: at("conclusion") },
      {
        operators,
      },
    );
    expect(
      materializeMoveOperation({
        state: withSorry,
        move: moveFor("close-by-assumption"),
        selections: { target: at("conclusion") },
        menuChoices: choices,
        idGenerator: ids,
        env: { operators },
      }),
    ).toMatchObject({
      ok: true,
      operation: { assumptionId: "assumption:sorry", instantiation: { a: "x", b: "a" } },
    });
  });
});

describe("materialization over typed binders", () => {
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
  const typedRoundTrips: readonly RoundTrip[] = [
    {
      kind: "introduce-universal",
      input: state(typedUniversal),
      selections: { target: at("conclusion") },
    },
    {
      kind: "instantiate-universal-hypothesis",
      input: state(["Lt", "a", ["S", "a"]], [{ id: "h:all", expression: typedUniversal }]),
      selections: { target: at("conclusion"), universal: at("h:all"), term: at("conclusion", [0]) },
    },
    {
      kind: "choose-existential-witness",
      input: state(typedExistential),
      selections: { target: at("conclusion") },
    },
    {
      kind: "unpack-existential-hypothesis",
      input: state("p", [{ id: "h:ex", expression: typedExistential }]),
      selections: { target: at("conclusion"), existential: at("h:ex") },
    },
  ];

  it.each(typedRoundTrips)(
    "materializes typed $kind into an operation the kernel accepts",
    (entry) => {
      const choices = chooseAll(entry.input, entry.kind, entry.selections, { operators });
      const materialized = materializeMoveOperation({
        state: entry.input,
        move: moveFor(entry.kind),
        selections: entry.selections,
        menuChoices: choices,
        idGenerator: ids,
        env: { operators },
        attestationIds: [],
      });
      if (!materialized.ok) throw new Error(JSON.stringify(materialized.diagnostics));
      const transition = applyTransition(entry.input, materialized.operation, { operators });
      expect(transition.diagnostics).toEqual([]);
      expect(transition.ok).toBe(true);
    },
  );

  it("offers instantiation terms of the binder's sort", () => {
    const input = state(["Lt", "a", ["S", "a"]], [{ id: "h:all", expression: typedUniversal }]);
    const terms = menuValues(
      input,
      "instantiate-universal-hypothesis",
      { target: at("conclusion"), universal: at("h:all") },
      "term",
    );
    expect(terms).toContainEqual("a");
    expect(terms).not.toContainEqual("p");
  });
});
