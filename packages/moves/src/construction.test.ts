import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { KernelEnvironment } from "@proof/kernel";
import {
  PROPOSITION_SORT,
  createExecutableProofStateSchema,
  operatorDeclarationsSchema,
  substituteMathJson,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  authoredMacroDefinition,
  authoredMoveDefinition,
  authoredMoveTemplateSchema,
  describeGenerality,
  isConstruction,
  runMovePlan,
  validateMoveTemplate,
} from "./authoring";
import {
  bindPatterns,
  instantiateTemplate,
  materializeMoveOperation,
  commandIdGenerator,
  generateParameterMenus,
  HAND_AUTHORED_MOVES,
  PARAMETER_MENU_ORIGINS,
  metavariablesOf,
  moveDefinitionSchema,
  type MoveDefinition,
  type MoveSelectionInput,
  type MoveSelections,
} from "./index";

const operators = operatorDeclarationsSchema.parse([]);
const environment: KernelEnvironment = { operators };
const stateSchema = createExecutableProofStateSchema({ operators });

function declarationsFor(names: readonly string[]) {
  return names.map((symbol) => ({
    id: `declaration:${symbol}`,
    symbol,
    sort: PROPOSITION_SORT,
    role: "universal-parameter" as const,
  }));
}

function stateWith(
  names: readonly string[],
  conclusion: PlainMathJson,
  id = "state:example",
): Record<string, unknown> {
  return {
    id,
    goals: [
      {
        id: "goal:main",
        sequent: {
          context: { declarations: declarationsFor(names), hypotheses: [] },
          conclusion: { expression: conclusion },
        },
      },
    ],
    obligations: [],
  };
}

function parsedState(names: readonly string[], conclusion: PlainMathJson): ExecutableProofState {
  return stateSchema.parse(stateWith(names, conclusion)) as ExecutableProofState;
}

function conclusionSelection(): MoveSelectionInput {
  return {
    kind: "exact",
    anchor: {
      target: { kind: "goal", id: "goal:main" as never },
      statement: { kind: "conclusion" },
    },
    path: [],
  };
}

const TARGET_SLOT = {
  id: "target",
  role: "target-conclusion",
  semanticRole: "proposition",
  required: true,
};

const variables = (names: readonly string[]) =>
  names.map((symbol) => ({ symbol, sort: PROPOSITION_SORT }));

const contrapositive = (a: string, b: string): PlainMathJson => ["Implies", ["Not", b], ["Not", a]];

/** The shape every example of the contrapositive move shares. */
function applied(
  id: string,
  names: readonly string[],
  conclusion: PlainMathJson,
  goal: PlainMathJson,
): Record<string, unknown> {
  return {
    id: `example:${id}`,
    description: id,
    state: stateWith(names, conclusion),
    selections: { target: conclusionSelection() },
    expected: {
      outcome: "applied",
      transitionClass: "strengthening",
      goals: [goal],
      obligations: [["Implies", goal, conclusion]],
    },
  };
}

/**
 * "Prove the contrapositive": `suffices` whose proposition is NOT in any menu of the situation but
 * is built from the two parts of the selected implication.
 */
function contrapositiveTemplate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "authored:contrapositive",
    name: "Prove the contrapositive",
    description: "Reduce an implication goal to the implication between the negations.",
    selectionContract: { slots: [TARGET_SLOT], allowAdditional: false },
    patterns: [
      { id: "pattern:implication", selectionSlotId: "target", expression: ["Implies", "A", "B"] },
    ],
    contextRequirements: [],
    sideConditions: [],
    parameters: [
      { id: "obligationId", label: "Sufficiency obligation ID", source: "generated-id" },
    ],
    requiredArtifacts: [],
    plan: {
      kind: "deterministic-plan",
      steps: [
        {
          id: "reduce",
          moveId: "move:suffices",
          operationKind: "suffices",
          parameters: [
            {
              parameterId: "proposition",
              origin: { kind: "rule" },
              value: { kind: "proposition", expression: contrapositive("A", "B") },
              variables: variables(["A", "B"]),
            },
          ],
        },
      ],
    },
    transitionClass: "strengthening",
    examples: [
      applied("one", ["p", "q"], ["Implies", "p", "q"], contrapositive("p", "q")),
      applied(
        "two",
        ["p", "q", "r"],
        ["Implies", ["And", "p", "r"], ["Or", "q", "r"]],
        contrapositive(["And", "p", "r"] as never, ["Or", "q", "r"] as never),
      ),
      {
        id: "example:negative",
        description: "not an implication",
        state: stateWith(["p"], "p"),
        selections: { target: conclusionSelection() },
        expected: { outcome: "rejected" },
      },
    ],
    ...overrides,
  };
}

function problems(input: unknown) {
  const validation = validateMoveTemplate(input, { operators });
  if (validation.ok) throw new Error("Expected the template to be rejected.");
  return validation.diagnostics;
}

describe("template construction helpers", () => {
  it("finds the metavariables of a pattern: free symbols that are not built in or operators", () => {
    expect(metavariablesOf(["Implies", "A", ["Not", ["P", "x"]]], [])).toEqual(["A", "P", "x"]);
    expect(metavariablesOf(["ForAll", "y", ["Q", "y", "z"]], [])).toEqual(["Q", "z"]);
    expect(metavariablesOf("True", [])).toEqual([]);
  });

  it("binds metavariables by matching each slot's selection against its pattern", () => {
    const bindings = bindPatterns(
      [
        [{ pattern: ["Implies", "A", "B"], fragment: ["Implies", "p", ["And", "q", "r"]] }],
        [{ pattern: ["Not", "A"], fragment: ["Not", "p"] }],
      ],
      [],
    );
    expect(Object.fromEntries(bindings)).toEqual({ A: "p", B: ["And", "q", "r"] });
    // Contradictory slots keep the first binding; a non-matching selection binds nothing.
    expect(
      Object.fromEntries(
        bindPatterns(
          [[{ pattern: "A", fragment: "p" }], [{ pattern: ["Not", "A"], fragment: ["Not", "q"] }]],
          [],
        ),
      ),
    ).toEqual({ A: "p" });
    expect(bindPatterns([[{ pattern: ["Not", "A"], fragment: "p" }]], []).size).toBe(0);
  });

  it("instantiates a template deterministically and refuses an unbound metavariable", () => {
    const template: PlainMathJson = ["Implies", ["Not", "B"], ["Not", "A"]];
    const bound = new Map<string, PlainMathJson>([
      ["A", "p"],
      ["B", ["And", "q", "r"]],
    ]);
    const first = instantiateTemplate(template, bound, []);
    expect(first).toEqual({
      ok: true,
      expression: ["Implies", ["Not", ["And", "q", "r"]], ["Not", "p"]],
    });
    expect(instantiateTemplate(template, bound, [])).toEqual(first);
    const unbound = instantiateTemplate(template, new Map([["A", "p"]]), []);
    expect(unbound).toMatchObject({ ok: false, unbound: ["B"] });
  });

  it("avoids capture when a binding mentions a symbol the template binds", () => {
    const result = instantiateTemplate(
      ["ForAll", "y", ["Equal", "y", "A"]],
      new Map([["A", "y"]]),
      [],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The free y of the binding is not captured by the template's own binder.
    expect(JSON.stringify(result.expression)).not.toBe(
      JSON.stringify(["ForAll", "y", ["Equal", "y", "y"]]),
    );
  });
});

describe("instantiation is alpha-invariant (property)", () => {
  const symbols = ["u", "v", "w", "s", "t"];
  const expression: fc.Arbitrary<PlainMathJson> = fc.letrec<{ expr: PlainMathJson }>((tie) => ({
    expr: fc.oneof(
      { maxDepth: 3 },
      fc.constantFrom(...symbols),
      fc.tuple(fc.constant("Not"), tie("expr")).map((parts) => parts as PlainMathJson),
      fc
        .tuple(fc.constantFrom("And", "Or", "Implies"), tie("expr"), tie("expr"))
        .map((parts) => parts as PlainMathJson),
    ),
  })).expr;
  const template: PlainMathJson = ["Implies", ["And", "A", ["Not", "B"]], ["Or", "B", "A"]];

  it("commutes with renaming the symbols of the bindings", () => {
    fc.assert(
      fc.property(
        expression,
        expression,
        fc.shuffledSubarray(["x1", "x2", "x3", "x4", "x5"], { minLength: 5, maxLength: 5 }),
        (a, b, fresh) => {
          const renaming = symbols.map((symbol, index) => ({
            symbol,
            replacement: fresh[index] as string,
          }));
          const rename = (value: PlainMathJson): PlainMathJson => {
            const renamed = substituteMathJson(value, renaming);
            if (!renamed.ok) throw new Error("rename");
            return renamed.expression;
          };
          const plain = instantiateTemplate(
            template,
            new Map<string, PlainMathJson>([
              ["A", a],
              ["B", b],
            ]),
            [],
          );
          const renamedFirst = instantiateTemplate(
            template,
            new Map<string, PlainMathJson>([
              ["A", rename(a)],
              ["B", rename(b)],
            ]),
            [],
          );
          expect(plain.ok && renamedFirst.ok).toBe(true);
          if (!plain.ok || !renamedFirst.ok) return;
          expect(renamedFirst.expression).toEqual(rename(plain.expression));
          // And it is deterministic.
          expect(
            instantiateTemplate(
              template,
              new Map<string, PlainMathJson>([
                ["A", a],
                ["B", b],
              ]),
              [],
            ),
          ).toEqual(plain);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("constructions in a move definition", () => {
  const suffices = HAND_AUTHORED_MOVES.find(({ id }) => id === "move:suffices") as MoveDefinition;
  const withConstruction = (construction: unknown, parameters = suffices.parameters) => ({
    ...suffices,
    parameters: parameters.filter(({ id }) => id !== "proposition"),
    constructions: [construction],
  });

  it("accepts a construction of a constructible parameter", () => {
    const parsed = moveDefinitionSchema.safeParse(
      withConstruction({
        parameterId: "proposition",
        kind: "proposition",
        template: contrapositive("A", "B"),
      }),
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("rejects a parameter the primitive cannot construct, a wrong kind, and a listed parameter", () => {
    const base = { parameterId: "proposition", kind: "proposition", template: "A" };
    for (const construction of [
      { ...base, parameterId: "obligationId" },
      { ...base, kind: "term" },
    ]) {
      expect(moveDefinitionSchema.safeParse(withConstruction(construction)).success).toBe(false);
    }
    // The user is not asked for what the move constructs.
    expect(moveDefinitionSchema.safeParse({ ...suffices, constructions: [base] }).success).toBe(
      false,
    );
    expect(
      moveDefinitionSchema.safeParse({
        ...withConstruction(base),
        constructions: [base, base],
      }).success,
    ).toBe(false);
    // Other primitives: a term for instantiation, and nothing for a closing primitive.
    const instantiate = HAND_AUTHORED_MOVES.find(
      ({ id }) => id === "move:instantiate-universal-hypothesis",
    ) as MoveDefinition;
    expect(
      moveDefinitionSchema.safeParse({
        ...instantiate,
        parameters: instantiate.parameters.filter(({ id }) => id !== "term"),
        constructions: [{ parameterId: "term", kind: "term", template: "A" }],
      }).success,
    ).toBe(true);
    const closeTrue = HAND_AUTHORED_MOVES.find(
      ({ id }) => id === "move:close-true",
    ) as MoveDefinition;
    expect(moveDefinitionSchema.safeParse({ ...closeTrue, constructions: [base] }).success).toBe(
      false,
    );
  });
});

describe("materializing a constructed parameter", () => {
  const definition = (): MoveDefinition => {
    const accepted = authoredMoveDefinition(
      contrapositiveTemplate(),
      { status: "approved", reviewerId: "reviewer:human" },
      "construction test",
    );
    if (accepted === undefined) throw new Error("The template does not project.");
    return accepted;
  };

  it("projects a single-step construction to an ordinary, retrievable definition", () => {
    expect(definition().constructions).toEqual([
      { parameterId: "proposition", kind: "proposition", template: contrapositive("A", "B") },
    ]);
    expect(definition().parameters.map(({ id }) => id)).toEqual(["obligationId"]);
  });

  it("builds the proposition from the selection, offers it in the menu and applies it", () => {
    const state = parsedState(["p", "q"], ["Implies", "p", "q"]);
    const menus = generateParameterMenus(
      state,
      definition(),
      { target: conclusionSelection() } as MoveSelections,
      environment,
      { idGenerator: commandIdGenerator("menus") },
    );
    expect(menus.ok).toBe(true);
    if (!menus.ok) return;
    const proposition = menus.menus.find(({ parameterId }) => parameterId === "proposition");
    expect(proposition?.items.at(-1)).toMatchObject({
      value: { kind: "proposition", expression: contrapositive("p", "q") },
      origin: { kind: "rule" },
    });
    expect(menus.pendingParameters).toEqual([]);

    const result = materializeMoveOperation({
      state,
      move: definition(),
      selections: { target: conclusionSelection() } as MoveSelections,
      idGenerator: commandIdGenerator("apply"),
      env: environment,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.operation).toMatchObject({
      kind: "suffices",
      proposition: contrapositive("p", "q"),
    });
  });

  it("does not let the user pick another item for a constructed parameter", () => {
    const state = parsedState(["p", "q"], ["Implies", "p", "q"]);
    const menus = generateParameterMenus(
      state,
      definition(),
      { target: conclusionSelection() } as MoveSelections,
      environment,
      { idGenerator: commandIdGenerator("menus") },
    );
    if (!menus.ok) throw new Error("menus");
    const other = menus.menus
      .find(({ parameterId }) => parameterId === "proposition")
      ?.items.find(({ origin }) => origin.kind === "selection");
    expect(other).toBeDefined();
    const result = materializeMoveOperation({
      state,
      move: definition(),
      selections: { target: conclusionSelection() } as MoveSelections,
      menuChoices: { proposition: other?.id as string },
      idGenerator: commandIdGenerator("apply"),
      env: environment,
    });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-choice" }] });
  });

  it("reports a selection that does not bind the template's metavariables", () => {
    const result = materializeMoveOperation({
      state: parsedState(["p"], "p"),
      move: definition(),
      selections: { target: conclusionSelection() } as MoveSelections,
      idGenerator: commandIdGenerator("unbound"),
      env: environment,
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "not-applicable", message: expect.stringContaining("no selection") }],
    });
  });

  it("rejects a constructed value that is not a proposition of the context", () => {
    // `Not(A)` with A bound to a real number is not a proposition, so the menu never offers it.
    const real = { kind: "named", id: "sort:real" };
    const state = stateSchema.parse({
      id: "state:reals",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: ["x", "y"].map((symbol) => ({
                id: `declaration:${symbol}`,
                symbol,
                sort: real,
                role: "universal-parameter",
              })),
              hypotheses: [],
            },
            conclusion: { expression: ["Equal", "x", "y"] },
          },
        },
      ],
      obligations: [],
    }) as ExecutableProofState;
    const equality = moveDefinitionSchema.parse({
      ...definition(),
      patterns: [
        { id: "pattern:equality", selectionSlotId: "target", expression: ["Equal", "A", "B"] },
      ],
      constructions: [{ parameterId: "proposition", kind: "proposition", template: ["Not", "A"] }],
    });
    const result = materializeMoveOperation({
      state,
      move: equality,
      selections: { target: conclusionSelection() } as MoveSelections,
      idGenerator: commandIdGenerator("bad"),
      env: environment,
    });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-choice" }] });
  });

  it("agrees with running the template as a plan", () => {
    const state = parsedState(["p", "q"], ["Implies", "p", "q"]);
    const selections = { target: conclusionSelection() } as MoveSelections;
    const direct = materializeMoveOperation({
      state,
      move: definition(),
      selections,
      idGenerator: commandIdGenerator("same:1"),
      env: environment,
    });
    const run = runMovePlan(
      authoredMoveTemplateSchema.parse(contrapositiveTemplate()),
      state,
      selections,
      {},
      environment,
      "same",
    );
    expect(direct.ok && run.ok).toBe(true);
    if (!direct.ok || !run.ok) return;
    expect(run.operations).toEqual([direct.operation]);
  });

  it("is deterministic and commutes with renaming the symbols of the situation", () => {
    const names = ["u", "v", "w", "s", "t", "m", "n"];
    fc.assert(
      fc.property(
        fc.shuffledSubarray(names, { minLength: 2, maxLength: 2 }),
        fc.constantFrom<"plain" | "nested">("plain", "nested"),
        ([left, right], shape) => {
          const antecedent: PlainMathJson = shape === "plain" ? left! : ["And", left!, right!];
          const consequent: PlainMathJson = shape === "plain" ? right! : ["Or", right!, left!];
          const state = parsedState([left!, right!], ["Implies", antecedent, consequent]);
          const run = () =>
            materializeMoveOperation({
              state,
              move: definition(),
              selections: { target: conclusionSelection() } as MoveSelections,
              idGenerator: commandIdGenerator("property"),
              env: environment,
            });
          const first = run();
          expect(first.ok).toBe(true);
          expect(JSON.stringify(run())).toBe(JSON.stringify(first));
          if (!first.ok || first.operation.kind !== "suffices") return;
          expect(first.operation.proposition).toEqual([
            "Implies",
            ["Not", consequent],
            ["Not", antecedent],
          ]);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("the origins of menu items", () => {
  const menuOf = (primitiveId: string, state: ExecutableProofState, parameterId: string) => {
    const move = HAND_AUTHORED_MOVES.find(({ id }) => id === primitiveId) as MoveDefinition;
    const menus = generateParameterMenus(
      state,
      move,
      { target: conclusionSelection() } as MoveSelections,
      environment,
      { idGenerator: commandIdGenerator("origins") },
    );
    if (!menus.ok) throw new Error(menus.diagnostics[0].message);
    return menus.menus.find((menu) => menu.parameterId === parameterId);
  };

  it("are the ones the materializer's table lists, for the menus a move reads", () => {
    const state = stateSchema.parse({
      id: "state:origins",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: declarationsFor(["p", "q"]),
              hypotheses: [{ id: "hypothesis:one", statement: { expression: ["Not", "p"] } }],
            },
            conclusion: { expression: ["Or", "p", ["And", "q", ["Not", "p"]]] },
          },
        },
      ],
      obligations: [],
    }) as ExecutableProofState;
    for (const [primitive, parameterId] of [
      ["move:split-classical-cases", "proposition"],
      ["move:suffices", "proposition"],
      ["move:choose-goal-disjunct", "disjunctIndex"],
    ] as const) {
      const menu = menuOf(primitive, state, parameterId);
      expect(menu?.items.length, `${primitive}.${parameterId}`).toBeGreaterThan(0);
      const allowed = PARAMETER_MENU_ORIGINS[parameterId] ?? [];
      for (const item of menu?.items ?? []) {
        expect(allowed, `${primitive}.${parameterId}: ${item.origin.kind}`).toContain(
          item.origin.kind,
        );
      }
    }
  });

  it("have an entry for every menu parameter of every hand-authored primitive", () => {
    for (const move of HAND_AUTHORED_MOVES) {
      for (const parameter of move.parameters) {
        if (parameter.source !== "menu" && parameter.source !== "term-input") continue;
        const key = parameter.id === "instantiation" ? "term" : parameter.id;
        expect(PARAMETER_MENU_ORIGINS[key], `${move.id}.${parameter.id}`).toBeDefined();
      }
    }
  });
});

describe("validating a template with a construction", () => {
  it("accepts the contrapositive template, running every example through the kernel", () => {
    const validation = validateMoveTemplate(contrapositiveTemplate(), { operators });
    expect(validation.ok, JSON.stringify(validation)).toBe(true);
    if (!validation.ok) return;
    expect(validation.report).toMatchObject({
      transitionClass: "strengthening",
      stepCount: 1,
      retrievable: true,
    });
    expect(validation.report.examples.map(({ outcome }) => outcome)).toEqual([
      "applied",
      "applied",
      "rejected",
    ]);
  });

  it("has a construction only where the recorded parameter is a rule-origin term or proposition", () => {
    const template = authoredMoveTemplateSchema.parse(contrapositiveTemplate());
    const [step] = template.plan.steps;
    expect(step?.parameters?.filter(isConstruction)).toHaveLength(1);
    expect(
      isConstruction({
        parameterId: "direction",
        origin: { kind: "rule" },
        value: { kind: "direction", direction: "forward" },
        variables: [],
      }),
    ).toBe(false);
  });

  it("still compares the declared class with the class the kernel steps compose to", () => {
    expect(problems(contrapositiveTemplate({ transitionClass: "equivalence" }))[0]).toMatchObject({
      code: "class-mismatch",
    });
  });

  it("checks every example against the kernel's result for the constructed proposition", () => {
    const template = contrapositiveTemplate();
    const first = (template.examples as Record<string, unknown>[])[0] as {
      expected: { goals: unknown[] };
    };
    first.expected.goals = [["Implies", ["Not", "p"], ["Not", "q"]]];
    expect(problems(template)[0]).toMatchObject({
      code: "example-mismatch",
      exampleId: "example:one",
    });
  });

  it("flags a symbol of the original situation kept as a literal in a construction", () => {
    const template = contrapositiveTemplate();
    const plan = template.plan as { steps: { parameters: { value: { expression: unknown } }[] }[] };
    plan.steps[0]!.parameters[0]!.value.expression = ["Implies", ["Not", "q"], ["Not", "A"]];
    const diagnostics = problems(template);
    expect(diagnostics[0]).toMatchObject({
      code: "problem-specific-symbol",
      message: expect.stringContaining("q"),
      path: ["plan", "steps", 0, "parameters", 0, "value", "expression"],
    });
  });

  it("rejects a construction of a parameter the primitive cannot construct", () => {
    const template = contrapositiveTemplate();
    const plan = template.plan as { steps: { parameters: { parameterId: string }[] }[] };
    plan.steps[0]!.parameters[0]!.parameterId = "obligationId";
    expect(problems(template).map(({ code }) => code)).toContain("invalid-construction");
  });

  it("requires the contract not to ask for a constructed parameter", () => {
    const template = contrapositiveTemplate({
      parameters: [
        { id: "obligationId", label: "Sufficiency obligation ID", source: "generated-id" },
        { id: "proposition", label: "Sufficient proposition", source: "menu" },
      ],
    });
    expect(problems(template)[0]).toMatchObject({ code: "parameter-mismatch" });
  });

  it("fails an independent example of a template that bakes in a symbol, even when its own passes", () => {
    // The author's only situation declares q; the construction keeps q instead of the metavariable B.
    const template = contrapositiveTemplate();
    const plan = template.plan as { steps: { parameters: { value: { expression: unknown } }[] }[] };
    plan.steps[0]!.parameters[0]!.value.expression = ["Implies", ["Not", "q"], ["Not", "A"]];
    const codes = problems(template).map(({ code }) => code);
    expect(codes).toContain("problem-specific-symbol");
    // Removing the screen would still fail: the independent example that declares r, not q.
    const independent = authoredMoveTemplateSchema.parse(template);
    const run = runMovePlan(
      independent,
      parsedState(["p", "r"], ["Implies", "p", "r"]),
      { target: conclusionSelection() } as MoveSelections,
      {},
      environment,
      "baked",
    );
    expect(run.ok).toBe(false);
  });
});

describe("a multi-step plan with a construction", () => {
  /** Reduce to the contrapositive, then introduce its antecedent. */
  function macro(): Record<string, unknown> {
    const base = contrapositiveTemplate();
    const steps = [
      ...((base.plan as { steps: unknown[] }).steps as Record<string, unknown>[]).map((step) => ({
        ...step,
        selections: [
          {
            slotId: "target",
            target: { kind: "goal", id: "g" },
            statement: { role: "conclusion" },
            occurrence: { kind: "exact", path: [] },
            fragment: ["Implies", "A", "B"],
            variables: variables(["A", "B"]),
          },
        ],
      })),
      {
        id: "assume",
        moveId: "move:introduce-implication",
        operationKind: "introduce-implication",
        selections: [
          {
            slotId: "target",
            target: { kind: "goal", id: "g" },
            statement: { role: "conclusion" },
            occurrence: { kind: "exact", path: [] },
            fragment: contrapositive("A", "B"),
            variables: variables(["A", "B"]),
          },
        ],
      },
    ];
    const afterIntro = (
      a: PlainMathJson,
      b: PlainMathJson,
      names: string[],
      conclusion: PlainMathJson,
    ) => ({
      id: `example:${JSON.stringify(a)}`,
      description: `${JSON.stringify(conclusion)}`,
      state: stateWith(names, conclusion),
      selections: { target: conclusionSelection() },
      expected: {
        outcome: "applied",
        transitionClass: "strengthening",
        goals: [["Not", a]],
        obligations: [["Implies", contrapositive(a as never, b as never), conclusion]],
      },
    });
    return {
      ...base,
      id: "authored:contrapositive-then-assume",
      plan: { kind: "deterministic-plan", steps },
      examples: [
        { ...afterIntro("p", "q", ["p", "q"], ["Implies", "p", "q"]), id: "example:one" },
        {
          ...afterIntro(
            ["And", "p", "r"],
            ["Or", "q", "r"],
            ["p", "q", "r"],
            ["Implies", ["And", "p", "r"], ["Or", "q", "r"]],
          ),
          id: "example:two",
        },
        (base.examples as unknown[])[2],
      ],
    };
  }

  it("validates, and the construction's metavariables carry across steps", () => {
    const validation = validateMoveTemplate(macro(), { operators });
    expect(validation.ok, JSON.stringify(validation)).toBe(true);
    if (!validation.ok) return;
    expect(validation.report).toMatchObject({ stepCount: 2, retrievable: true });
  });

  it("is retrieved through the first step's projection, which carries the construction", () => {
    const approved = authoredMacroDefinition(
      macro(),
      { status: "approved", reviewerId: "reviewer:human" },
      "macro",
    );
    expect(approved?.definition.constructions).toHaveLength(1);
  });

  it("applies on an alpha-renamed situation to the renamed result", () => {
    const template = authoredMoveTemplateSchema.parse(macro());
    const names = ["u", "v", "w", "s", "t", "m", "n"];
    fc.assert(
      fc.property(fc.shuffledSubarray(names, { minLength: 2, maxLength: 2 }), ([a, b]) => {
        const run = runMovePlan(
          template,
          parsedState([a as string, b as string], ["Implies", a as string, b as string]),
          { target: conclusionSelection() } as MoveSelections,
          {},
          environment,
          "renamed",
        );
        expect(run.ok, JSON.stringify(run)).toBe(true);
        if (!run.ok) return;
        expect(run.operations.map(({ kind }) => kind)).toEqual([
          "suffices",
          "introduce-implication",
        ]);
        expect(run.state.goals[0]?.sequent.conclusion.expression).toEqual(["Not", a]);
        expect(
          run.state.goals[0]?.sequent.context.hypotheses.map(
            ({ statement }) => statement.expression,
          ),
        ).toEqual([["Not", b]]);
        expect(run.transitionClass).toBe("strengthening");
      }),
      { numRuns: 40 },
    );
  });
});

describe("naming the identifiers a step creates", () => {
  const recorded = (id: string, targetLabel: string) => ({
    id,
    moveId: "move:close-true",
    operationKind: "close-true",
    selections: [
      {
        slotId: "target",
        target: { kind: "goal", id: targetLabel },
        statement: { role: "conclusion" },
        occurrence: { kind: "exact", path: [] },
        fragment: "True",
        variables: [],
      },
    ],
  });

  function template(): Record<string, unknown> {
    const conjunction = (name: string) => ({
      id: `example:${name}`,
      description: name,
      state: stateWith(["p"], ["And", "True", "True"]),
      selections: { target: conclusionSelection() },
      expected: { outcome: "applied", transitionClass: "equivalence", goals: [], obligations: [] },
    });
    return {
      id: "authored:split-and-close",
      name: "Split a conjunction of truths and close both",
      description: "Split, then close the second conjunct before the first.",
      selectionContract: { slots: [TARGET_SLOT], allowAdditional: false },
      patterns: [
        { id: "pattern:and", selectionSlotId: "target", expression: ["And", "True", "True"] },
      ],
      contextRequirements: [],
      sideConditions: [],
      parameters: [{ id: "childIds", label: "Child target IDs", source: "generated-id" }],
      requiredArtifacts: [],
      plan: {
        kind: "deterministic-plan",
        steps: [
          {
            id: "split",
            moveId: "move:split-goal-conjunction",
            operationKind: "split-goal-conjunction",
          },
          recorded("second", "split.childIds.2"),
          recorded("first", "split.childIds.1"),
        ],
      },
      transitionClass: "equivalence",
      examples: [
        conjunction("a"),
        { ...conjunction("b"), state: stateWith(["q", "r"], ["And", "True", "True"]) },
        {
          id: "example:negative",
          description: "one conjunct is not True",
          state: stateWith(["p"], ["And", "True", "p"]),
          selections: { target: conclusionSelection() },
          expected: { outcome: "rejected" },
        },
      ],
    };
  }

  it("lets a later step refer to a target by the step and field that created it", () => {
    const parsed = authoredMoveTemplateSchema.parse(template());
    const run = runMovePlan(
      parsed,
      parsedState(["p"], ["And", "True", "True"]),
      { target: conclusionSelection() } as MoveSelections,
      {},
      environment,
      "names",
    );
    expect(run.ok, JSON.stringify(run)).toBe(true);
    if (!run.ok) return;
    const [split, second, first] = run.operations as unknown as {
      childIds: string[];
      target: { id: string };
    }[];
    expect(second?.target.id).toBe(split?.childIds[1]);
    expect(first?.target.id).toBe(split?.childIds[0]);
    expect(run.state.goals).toEqual([]);
  });

  it("validates without recording the operations it names", () => {
    expect(validateMoveTemplate(template(), { operators }).ok).toBe(true);
  });
});

describe("describeGenerality", () => {
  it("notes a numeral kept by a construction and examples that differ only by renaming", () => {
    const template = authoredMoveTemplateSchema.parse(
      contrapositiveTemplate({
        examples: [
          applied("one", ["p", "q"], ["Implies", "p", "q"], contrapositive("p", "q")),
          applied("two", ["u", "v"], ["Implies", "u", "v"], contrapositive("u", "v")),
          (contrapositiveTemplate().examples as unknown[])[2],
        ],
      }),
    );
    expect(describeGenerality(template, operators).map(({ code }) => code)).toEqual([
      "examples-alike",
    ]);
    const numeric = authoredMoveTemplateSchema.parse(
      contrapositiveTemplate({
        plan: {
          kind: "deterministic-plan",
          steps: [
            {
              id: "reduce",
              moveId: "move:suffices",
              operationKind: "suffices",
              parameters: [
                {
                  parameterId: "proposition",
                  origin: { kind: "rule" },
                  value: { kind: "proposition", expression: ["Equal", ["Add", "A", 2], "B"] },
                  variables: variables(["A", "B"]),
                },
              ],
            },
          ],
        },
      }),
    );
    expect(describeGenerality(numeric, operators).map(({ code }) => code)).toEqual([
      "numeric-constant",
    ]);
  });

  it("sees examples as alike whatever the key order of the metadata in their statements", () => {
    // `p` and `u` carry display metadata, written in different key orders.
    const conclusion = (metadata: unknown, other: string) =>
      ["Implies", metadata, other] as unknown as PlainMathJson;
    const template = authoredMoveTemplateSchema.parse(
      contrapositiveTemplate({
        examples: [
          applied(
            "one",
            ["p", "q"],
            conclusion({ sym: "p", latex: "p" }, "q"),
            contrapositive("p", "q"),
          ),
          applied(
            "two",
            ["u", "v"],
            conclusion({ latex: "u", sym: "u" }, "v"),
            contrapositive("u", "v"),
          ),
          (contrapositiveTemplate().examples as unknown[])[2],
        ],
      }),
    );
    expect(describeGenerality(template, operators).map(({ code }) => code)).toEqual([
      "examples-alike",
    ]);
  });

  it("notes nothing for examples with different shapes", () => {
    const template = authoredMoveTemplateSchema.parse(contrapositiveTemplate());
    expect(describeGenerality(template, operators)).toEqual([]);
  });
});
