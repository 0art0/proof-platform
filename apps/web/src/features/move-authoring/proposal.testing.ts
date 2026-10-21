/** Fixtures for the "Save as reusable move" tests: a model's contrapositive proposal, as answered. */

const target = { kind: "goal", id: "goal:main" };

const selection = () => ({
  kind: "exact",
  anchor: { target, statement: { kind: "conclusion" } },
  path: [],
});

const state = (names: readonly string[], conclusion: unknown, id: string) => ({
  id,
  goals: [
    {
      id: "goal:main",
      sequent: {
        context: {
          declarations: names.map((symbol) => ({
            id: `declaration:${symbol}`,
            symbol,
            sort: { kind: "proposition" },
            role: "universal-parameter",
          })),
          hypotheses: [],
        },
        conclusion: { expression: conclusion },
      },
    },
  ],
  obligations: [],
});

const contrapositive = (antecedent: unknown, consequent: unknown) => [
  "Implies",
  ["Not", consequent],
  ["Not", antecedent],
];

/** The template the worker compiles from the proposal: a single `suffices` that constructs. */
export function proposedTemplate(): Record<string, unknown> {
  const positive = (id: string, names: string[], conclusion: unknown, goal: unknown) => ({
    id: `example:${id}`,
    description: `The ${id} situation`,
    state: state(names, conclusion, `state:example-${id}`),
    selections: { target: selection() },
    expected: {
      outcome: "applied",
      transitionClass: "strengthening",
      goals: [goal],
      obligations: [["Implies", goal, conclusion]],
    },
  });
  return {
    id: "authored:prove-the-contrapositive-331fedf4",
    name: "Prove the contrapositive",
    description:
      "Reduce an implication goal to the implication between the negations of its parts.",
    selectionContract: {
      slots: [
        { id: "target", role: "target-conclusion", semanticRole: "proposition", required: true },
      ],
      allowAdditional: false,
    },
    patterns: [
      { id: "pattern:target", selectionSlotId: "target", expression: ["Implies", "A", "B"] },
    ],
    contextRequirements: [],
    sideConditions: ["The selected statement is an implication."],
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
          selections: [
            {
              slotId: "target",
              target: { kind: "goal", id: "goal" },
              statement: { role: "conclusion" },
              occurrence: { kind: "exact", path: [] },
              fragment: ["Implies", "A", "B"],
              variables: [
                { symbol: "A", sort: { kind: "proposition" } },
                { symbol: "B", sort: { kind: "proposition" } },
              ],
            },
          ],
          parameters: [
            {
              parameterId: "proposition",
              origin: { kind: "rule" },
              value: { kind: "proposition", expression: contrapositive("A", "B") },
              variables: [
                { symbol: "A", sort: { kind: "proposition" } },
                { symbol: "B", sort: { kind: "proposition" } },
              ],
            },
          ],
        },
      ],
    },
    transitionClass: "strengthening",
    examples: [
      positive("source", ["P", "Q"], ["Implies", "P", "Q"], contrapositive("P", "Q")),
      positive(
        "compound",
        ["p", "q", "r"],
        ["Implies", ["And", "p", "r"], ["Or", "q", "r"]],
        contrapositive(["And", "p", "r"], ["Or", "q", "r"]),
      ),
      {
        id: "example:not-an-implication",
        description: "The goal is not an implication",
        state: state(["p"], "p", "state:example-not"),
        selections: { target: selection() },
        expected: { outcome: "rejected" },
      },
    ],
    discoveryContext: "The user replaced the goal A implies B by its contrapositive.",
  };
}

export const PASSING_VALIDATION = {
  ok: true,
  report: {
    transitionClass: "strengthening",
    stepCount: 1,
    retrievable: true,
    examples: [
      {
        exampleId: "example:source",
        outcome: "applied",
        transitionClass: "strengthening",
        stepCount: 1,
      },
      {
        exampleId: "example:compound",
        outcome: "applied",
        transitionClass: "strengthening",
        stepCount: 1,
      },
      { exampleId: "example:not-an-implication", outcome: "rejected", stepCount: 1 },
    ],
  },
};

export const FAILING_VALIDATION = {
  ok: false,
  diagnostics: [
    {
      code: "example-mismatch",
      message: "Example example:compound: the conclusion of goals 1 differs from the expected one.",
      path: ["examples", 1, "expected"],
      exampleId: "example:compound",
    },
  ],
};

/** The worker's `proposed` answer, as the proxy relays it (without the `ok` wrapper). */
export function proposedAnswer(overrides: Record<string, unknown> = {}) {
  return {
    status: "proposed",
    provenance: { kind: "minimal-context-llm", role: "move-author" },
    callId: "llm-call:author-1",
    replayed: false,
    executorCallId: "llm-call:execute-1",
    template: proposedTemplate(),
    motivation: "The user replaced the goal A implies B by its contrapositive.",
    classification: { kind: "macro", rationale: "One suffices step; no new result is needed." },
    validation: PASSING_VALIDATION,
    generality: [],
    diagnostics: [],
    ...overrides,
  };
}
