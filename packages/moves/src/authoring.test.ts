import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { KernelEnvironment, KernelOperation } from "@proof/kernel";
import {
  PROPOSITION_SORT,
  createExecutableProofStateSchema,
  operatorDeclarationsSchema,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  AUTHORED_MOVE_ID_PREFIX,
  authoredMoveDefinition,
  authoredMoveTemplateSchema,
  macroFromSemanticSteps,
  recordedMacroExample,
  runMovePlan,
  validateMoveTemplate,
  type AuthoredMoveTemplate,
  type MacroSelection,
  type RecordedStep,
} from "./authoring";
import {
  commandIdGenerator,
  materializeMoveOperation,
  planMove,
  type MoveSelectionInput,
  type MoveSelections,
} from "./index";
import { HAND_AUTHORED_MOVES } from "./index";

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
const HYPOTHESIS_PARAMETER = {
  id: "hypothesisId",
  label: "Antecedent hypothesis ID",
  source: "generated-id",
};

type TemplateOverrides = Partial<Record<string, unknown>>;

/** A narrowed `introduce-implication`: applies to a nested implication goal. */
function introTemplate(overrides: TemplateOverrides = {}): Record<string, unknown> {
  return {
    id: "authored:intro-nested",
    name: "Introduce the outer implication",
    description: "Assume the antecedent of an implication goal.",
    selectionContract: { slots: [TARGET_SLOT], allowAdditional: false },
    patterns: [
      {
        id: "pattern:nested",
        selectionSlotId: "target",
        expression: ["Implies", "p", ["Implies", "q", "r"]],
      },
    ],
    contextRequirements: [],
    sideConditions: [],
    parameters: [HYPOTHESIS_PARAMETER],
    requiredArtifacts: [],
    plan: {
      kind: "deterministic-plan",
      steps: [
        {
          id: "step-1",
          moveId: "move:introduce-implication",
          operationKind: "introduce-implication",
        },
      ],
    },
    transitionClass: "equivalence",
    examples: [
      {
        id: "example:positive-1",
        description: "p implies (q implies r)",
        state: stateWith(["p", "q", "r"], ["Implies", "p", ["Implies", "q", "r"]]),
        selections: { target: conclusionSelection() },
        expected: {
          outcome: "applied",
          transitionClass: "equivalence",
          goals: [["Implies", "q", "r"]],
          obligations: [],
        },
      },
      {
        id: "example:positive-2",
        description: "p implies (q implies (q and r))",
        state: stateWith(["p", "q", "r"], ["Implies", "p", ["Implies", "q", ["And", "q", "r"]]]),
        selections: { target: conclusionSelection() },
        expected: {
          outcome: "applied",
          transitionClass: "equivalence",
          goals: [["Implies", "q", ["And", "q", "r"]]],
          obligations: [],
        },
      },
      {
        id: "example:negative-1",
        description: "a goal that is not an implication",
        state: stateWith(["p", "q", "r"], "p"),
        selections: { target: conclusionSelection() },
        expected: { outcome: "rejected" },
      },
    ],
    ...overrides,
  };
}

function diagnosticsOf(input: unknown) {
  const validation = validateMoveTemplate(input, { operators });
  if (validation.ok) throw new Error("Expected the template to be rejected.");
  return validation.diagnostics;
}

function example(template: Record<string, unknown>, index: number): Record<string, unknown> {
  return (template.examples as Record<string, unknown>[])[index] as Record<string, unknown>;
}

describe("validateMoveTemplate", () => {
  it("accepts a valid single-step template, running every example through the kernel", () => {
    const validation = validateMoveTemplate(introTemplate(), { operators });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.report).toMatchObject({
      transitionClass: "equivalence",
      stepCount: 1,
      retrievable: true,
    });
    expect(validation.report.examples.map(({ outcome }) => outcome)).toEqual([
      "applied",
      "applied",
      "rejected",
    ]);
  });

  it("projects a single-step template to a retrievable move definition", () => {
    const definition = authoredMoveDefinition(
      introTemplate(),
      { status: "approved", reviewerId: "reviewer:human" },
      "authored by test",
    );
    expect(definition?.id).toBe("authored:intro-nested");
    expect(definition?.implementation).toEqual({
      kind: "deterministic-kernel-primitive",
      operationKind: "introduce-implication",
    });
    expect(definition?.examples.positive).toHaveLength(2);
    expect(definition?.approval).toEqual({ status: "approved", reviewerId: "reviewer:human" });
    expect(HAND_AUTHORED_MOVES.some((move) => move.id === "authored:intro-nested")).toBe(false);
  });

  it("rejects malformed parts with a precise diagnostic each", () => {
    const cases: [string, TemplateOverrides, string, readonly (string | number)[] | undefined][] = [
      [
        "an ID outside the authored namespace",
        { id: "move:introduce-implication" },
        "invalid-template",
        ["id"],
      ],
      [
        "a pattern on an undeclared slot",
        { patterns: [{ id: "pattern:x", selectionSlotId: "missing", expression: "p" }] },
        "invalid-template",
        ["patterns", 0, "selectionSlotId"],
      ],
      [
        "duplicate slot IDs",
        { selectionContract: { slots: [TARGET_SLOT, TARGET_SLOT], allowAdditional: false } },
        "invalid-template",
        ["selectionContract", "slots", 1],
      ],
      [
        "an unknown primitive",
        {
          plan: {
            kind: "deterministic-plan",
            steps: [{ id: "s", moveId: "move:nonexistent", operationKind: "close-true" }],
          },
        },
        "unknown-primitive",
        ["plan", "steps", 0, "moveId"],
      ],
      [
        "a step whose kind is not its primitive's",
        {
          plan: {
            kind: "deterministic-plan",
            steps: [
              { id: "s", moveId: "move:close-true", operationKind: "close-reflexive-equality" },
            ],
          },
        },
        "primitive-mismatch",
        ["plan", "steps", 0, "operationKind"],
      ],
      [
        "a slot the primitive does not have",
        {
          selectionContract: {
            slots: [TARGET_SLOT, { ...TARGET_SLOT, id: "extra", required: false }],
            allowAdditional: false,
          },
        },
        "slot-mismatch",
        ["selectionContract", "slots", 1, "id"],
      ],
      [
        "a slot with the wrong role",
        {
          selectionContract: {
            slots: [{ ...TARGET_SLOT, role: "hypothesis" }],
            allowAdditional: false,
          },
        },
        "slot-mismatch",
        ["selectionContract", "slots", 0],
      ],
      [
        "a missing required slot",
        {
          plan: {
            kind: "deterministic-plan",
            steps: [
              {
                id: "s",
                moveId: "move:close-by-hypothesis",
                operationKind: "close-by-hypothesis",
              },
            ],
          },
          parameters: [{ id: "hypothesisId", label: "Hypothesis", source: "selection" }],
        },
        "slot-mismatch",
        ["selectionContract", "slots"],
      ],
      [
        "a parameter with the wrong source",
        { parameters: [{ ...HYPOTHESIS_PARAMETER, source: "menu" }] },
        "parameter-mismatch",
        ["parameters", 0, "source"],
      ],
      ["a missing parameter", { parameters: [] }, "parameter-mismatch", ["parameters"]],
      [
        "a declared class that is not the kernel steps' class",
        { transitionClass: "strengthening" },
        "class-mismatch",
        ["transitionClass"],
      ],
      [
        "too few examples",
        { examples: (introTemplate().examples as unknown[]).slice(0, 2) },
        "missing-example",
        ["examples"],
      ],
    ];
    for (const [label, overrides, code, path] of cases) {
      const diagnostics = diagnosticsOf(introTemplate(overrides));
      expect(diagnostics[0], label).toMatchObject({ code, path });
    }
  });

  it("rejects a required artifact that is not available", () => {
    const template = introTemplate({
      requiredArtifacts: [{ kind: "result", id: "result:missing" }],
    });
    const validation = validateMoveTemplate(template, {
      operators,
      artifactExists: () => false,
    });
    expect(validation.ok).toBe(false);
    if (!validation.ok)
      expect(validation.diagnostics[0]).toMatchObject({ code: "unknown-artifact" });
    expect(validateMoveTemplate(template, { operators }).ok).toBe(true);
  });

  it("rejects an example whose expected outcome differs from the kernel result", () => {
    const template = introTemplate();
    (example(template, 0).expected as Record<string, unknown>).goals = [["Implies", "r", "q"]];
    expect(diagnosticsOf(template)[0]).toMatchObject({
      code: "example-mismatch",
      exampleId: "example:positive-1",
    });
  });

  it("rejects an example that expects the wrong number of goals or class", () => {
    const wrongGoals = introTemplate();
    (example(wrongGoals, 0).expected as Record<string, unknown>).goals = [];
    expect(diagnosticsOf(wrongGoals)[0]).toMatchObject({ code: "example-mismatch" });

    const wrongClass = introTemplate();
    (example(wrongClass, 0).expected as Record<string, unknown>).transitionClass = "weakening";
    expect(diagnosticsOf(wrongClass)[0]).toMatchObject({
      code: "example-mismatch",
      path: ["examples", 0, "expected", "transitionClass"],
    });
  });

  it("rejects a positive example the kernel cannot run and a negative example it accepts", () => {
    const failing = introTemplate();
    (example(failing, 0) as Record<string, unknown>).state = stateWith(["p", "q", "r"], "p");
    expect(diagnosticsOf(failing)[0]).toMatchObject({ code: "example-failed" });

    const accepted = introTemplate();
    (example(accepted, 2) as Record<string, unknown>).state = stateWith(
      ["p", "q", "r"],
      ["Implies", "p", "q"],
    );
    expect(diagnosticsOf(accepted)[0]).toMatchObject({
      code: "example-accepted",
      exampleId: "example:negative-1",
    });
  });

  it("checks a negative example's expected diagnostic code", () => {
    const template = introTemplate();
    (example(template, 2).expected as Record<string, unknown>).diagnosticCode = "kernel-rejected";
    const validation = validateMoveTemplate(template, { operators });
    expect(validation.ok).toBe(true);
    (example(template, 2).expected as Record<string, unknown>).diagnosticCode = "invalid-choice";
    expect(diagnosticsOf(template)[0]).toMatchObject({ code: "example-mismatch" });
  });

  it("rejects malformed examples precisely", () => {
    const badState = introTemplate();
    (example(badState, 0) as Record<string, unknown>).state = { id: "state:x" };
    expect(diagnosticsOf(badState)[0]).toMatchObject({ code: "example-invalid" });

    const undeclared = introTemplate();
    (example(undeclared, 0) as Record<string, unknown>).selections = {
      target: conclusionSelection(),
      other: conclusionSelection(),
    };
    expect(diagnosticsOf(undeclared)[0]).toMatchObject({ code: "example-invalid" });

    const missing = introTemplate();
    (example(missing, 0) as Record<string, unknown>).selections = {};
    expect(diagnosticsOf(missing)[0]).toMatchObject({ code: "example-invalid" });
  });

  it("reports an example that needs a menu choice it does not make", () => {
    const template = introTemplate({
      plan: {
        kind: "deterministic-plan",
        steps: [
          { id: "s", moveId: "move:choose-goal-disjunct", operationKind: "choose-goal-disjunct" },
        ],
      },
      parameters: [{ id: "disjunctIndex", label: "Disjunct", source: "menu" }],
      transitionClass: "strengthening",
      patterns: [{ id: "pattern:or", selectionSlotId: "target", expression: ["Or", "p", "q"] }],
      examples: ["first", "second"]
        .map((id) => ({
          id: `example:${id}`,
          description: id,
          state: stateWith(["p", "q"], ["Or", "p", "q"]),
          selections: { target: conclusionSelection() },
          expected: {
            outcome: "applied",
            transitionClass: "strengthening",
            goals: ["p"],
            obligations: [],
          },
        }))
        .concat([
          {
            id: "example:negative",
            description: "not a disjunction",
            state: stateWith(["p", "q"], "p"),
            selections: { target: conclusionSelection() },
            expected: { outcome: "rejected" } as never,
          } as never,
        ]),
    });
    const diagnostics = diagnosticsOf(template);
    expect(diagnostics[0]).toMatchObject({ code: "example-incomplete" });
    expect(diagnostics[0]?.message).toContain("disjunctIndex");
  });

  it("never treats non-template input as valid", () => {
    for (const input of [undefined, null, 3, "x", [], {}]) {
      const validation = validateMoveTemplate(input);
      expect(validation.ok).toBe(false);
    }
    expect(authoredMoveTemplateSchema.safeParse({ ...introTemplate(), extra: 1 }).success).toBe(
      false,
    );
    expect(AUTHORED_MOVE_ID_PREFIX).toBe("authored:");
  });
});

// --------------------------------------------------------------------------------------------
// Macros
// --------------------------------------------------------------------------------------------

function selectionOf(
  slotId: string,
  fragment: PlainMathJson,
  names: readonly string[],
): MacroSelection {
  return {
    slotId,
    target: { kind: "goal", id: "goal:main" as never },
    statement: { role: "conclusion" },
    occurrence: { kind: "exact", path: [] },
    fragment,
    variables: names.map((symbol) => ({ symbol, sort: PROPOSITION_SORT })),
  } as MacroSelection;
}

/** Record `introduce-implication` twice on `p implies (q implies r)` by running the kernel. */
function recordedSteps(): {
  steps: RecordedStep[];
  before: ExecutableProofState;
  after: ExecutableProofState;
} {
  const before = stateSchema.parse(
    stateWith(["p", "q", "r"], ["Implies", "p", ["Implies", "q", "r"]], "state:recorded"),
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
          ...conclusionSelection(),
          anchor: { ...conclusionSelection().anchor, stateId: state.id },
        },
      } as MoveSelections,
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
      selections: [selectionOf("target", fragment, names)],
      parameters: [],
      operation: materialized.operation,
    });
    state = planned.preview.state;
  });
  return { steps, before, after: state };
}

function macroTemplate(): AuthoredMoveTemplate {
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
    state: stateWith(["p", "q", "r"], ["Implies", "p", ["Implies", "q", ["And", "q", "r"]]]),
    expected: { ...recorded.expected, goals: [["And", "q", "r"]] },
  };
  const negative = {
    id: "example:negative",
    description: "only one implication deep",
    state: stateWith(["p", "q", "r"], ["Implies", "p", "q"]),
    selections: recorded.selections,
    expected: { outcome: "rejected", diagnosticCode: "macro-step-unmatched" },
  };
  const built = macroFromSemanticSteps(steps, {
    id: "authored:intro-twice",
    name: "Introduce two implications",
    description: "Assume two nested antecedents at once.",
    examples: [recorded, second as never, negative as never],
  });
  if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
  return built.template;
}

describe("macroFromSemanticSteps", () => {
  it("builds a macro template from recorded steps that passes the same validation", () => {
    const template = macroTemplate();
    expect(template.plan.steps.map(({ operationKind }) => operationKind)).toEqual([
      "introduce-implication",
      "introduce-implication",
    ]);
    expect(template.patterns).toEqual([
      {
        id: "pattern:target",
        selectionSlotId: "target",
        expression: ["Implies", "p", ["Implies", "q", "r"]],
      },
    ]);
    expect(template.transitionClass).toBe("equivalence");
    const validation = validateMoveTemplate(template, { operators });
    expect(validation).toMatchObject({ ok: true, report: { stepCount: 2, retrievable: false } });
  });

  it("is not projected to a retrievable definition", () => {
    expect(
      authoredMoveDefinition(
        macroTemplate(),
        { status: "approved", reviewerId: "reviewer:human" },
        "macro",
      ),
    ).toBeUndefined();
  });

  it("composes the declared class from the steps and rejects a mismatch", () => {
    const { steps } = recordedSteps();
    const weakening = macroFromSemanticSteps(
      [
        steps[0] as RecordedStep,
        {
          ...(steps[1] as RecordedStep),
          moveId: "move:choose-goal-disjunct",
          operation: {
            ...(steps[1] as RecordedStep).operation,
            kind: "choose-goal-disjunct",
          } as never,
        },
      ],
      { id: "authored:mixed", name: "Mixed", description: "Mixed classes" },
    );
    expect(weakening.ok).toBe(false);

    const template = { ...macroTemplate(), transitionClass: "weakening" as const };
    expect(diagnosticsOf(template)[0]).toMatchObject({ code: "class-mismatch" });
  });

  it("rejects sequences that are not primitive move steps", () => {
    const { steps } = recordedSteps();
    expect(macroFromSemanticSteps([], { id: "authored:x", name: "x", description: "x" }).ok).toBe(
      false,
    );
    expect(
      macroFromSemanticSteps([{ ...(steps[0] as RecordedStep), source: "result" }], {
        id: "authored:x",
        name: "x",
        description: "x",
      }).ok,
    ).toBe(false);
    expect(
      macroFromSemanticSteps([{ ...(steps[0] as RecordedStep), moveId: "move:unknown" }], {
        id: "authored:x",
        name: "x",
        description: "x",
      }).ok,
    ).toBe(false);
  });

  it("fails an example whose later step cannot be matched", () => {
    const template = macroTemplate();
    const broken = {
      ...template,
      examples: template.examples.map((entry) =>
        entry.id === "example:nested-conjunction"
          ? { ...entry, state: stateWith(["p", "q", "r"], ["Implies", "p", ["And", "q", "r"]]) }
          : entry,
      ),
    };
    expect(diagnosticsOf(broken)[0]).toMatchObject({
      code: "macro-step-unmatched",
      exampleId: "example:nested-conjunction",
    });
  });

  it("reproduces the recorded outcome on any alpha-renamed state", () => {
    const template = macroTemplate();
    const names = ["u", "v", "w", "s", "t", "m", "n"];
    fc.assert(
      fc.property(fc.shuffledSubarray(names, { minLength: 3, maxLength: 3 }), (chosen) => {
        const [a, b, c] = chosen as [string, string, string];
        const state = stateSchema.parse(
          stateWith([a, b, c], ["Implies", a, ["Implies", b, c]], "state:renamed"),
        ) as ExecutableProofState;
        const run = runMovePlan(
          template,
          state,
          { target: conclusionSelection() } as MoveSelections,
          {},
          environment,
          "property",
        );
        expect(run.ok).toBe(true);
        if (!run.ok) return;
        expect(run.transitionClass).toBe("equivalence");
        expect(run.operations).toHaveLength(2);
        expect(run.state.goals).toHaveLength(1);
        const goal = run.state.goals[0];
        expect(goal?.sequent.conclusion.expression).toBe(c);
        expect(
          goal?.sequent.context.hypotheses.map(({ statement }) => statement.expression),
        ).toEqual([a, b]);
      }),
      { numRuns: 40 },
    );
  });

  it("agrees with the kernel on the recorded operations' own effect", () => {
    const { steps, before, after } = recordedSteps();
    const template = macroTemplate();
    const run = runMovePlan(
      template,
      before,
      { target: conclusionSelection() } as MoveSelections,
      {},
      environment,
      "recorded",
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.state.goals[0]?.sequent.conclusion).toEqual(after.goals[0]?.sequent.conclusion);
    expect(run.operations.map((operation: KernelOperation) => operation.kind)).toEqual(
      steps.map((step) => step.operation.kind),
    );
  });
});
