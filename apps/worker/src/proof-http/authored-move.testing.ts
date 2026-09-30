/** Shared fixtures for authored-move tests (roadmap N35): a runnable narrowed introduce-implication. */

const TARGET_SLOT = {
  id: "target",
  role: "target-conclusion",
  semanticRole: "proposition",
  required: true,
};

function stateWith(conclusion: unknown): Record<string, unknown> {
  return {
    id: "state:example",
    goals: [
      {
        id: "goal:main",
        sequent: {
          context: {
            declarations: ["a", "b"].map((symbol) => ({
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
  };
}

const selection = {
  kind: "exact",
  anchor: { target: { kind: "goal", id: "goal:main" }, statement: { kind: "conclusion" } },
  path: [],
};

/** A narrowed introduce-implication for implications whose antecedent is a negation. */
export function template(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const positive = (name: string, conclusion: unknown, goal: unknown) => ({
    id: `example:${name}`,
    description: name,
    state: stateWith(conclusion),
    selections: { target: selection },
    expected: {
      outcome: "applied",
      transitionClass: "equivalence",
      goals: [goal],
      obligations: [],
    },
  });
  return {
    id,
    name: "Introduce a negated antecedent",
    description: "Assume the negation that an implication goal starts with.",
    selectionContract: { slots: [TARGET_SLOT], allowAdditional: false },
    patterns: [
      { id: "pattern:neg", selectionSlotId: "target", expression: ["Implies", ["Not", "a"], "b"] },
    ],
    contextRequirements: [],
    sideConditions: [],
    parameters: [{ id: "hypothesisId", label: "Antecedent hypothesis ID", source: "generated-id" }],
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
      positive("one", ["Implies", ["Not", "a"], "b"], "b"),
      positive("two", ["Implies", ["Not", "a"], ["Not", "b"]], ["Not", "b"]),
      {
        id: "example:negative",
        description: "not an implication",
        state: stateWith("a"),
        selections: { target: selection },
        expected: { outcome: "rejected" },
      },
    ],
    ...overrides,
  };
}
