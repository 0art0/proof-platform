import { describe, expect, it } from "vitest";
import { type TransitionClass } from "@proof/kernel";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { composeTransitionClasses, movePlanImplementationSchema, planMoveSequence } from "./index";

const declarations = ["p", "q", "r"].map((symbol) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
}));

function state(
  conclusion: PlainMathJson,
  hypotheses: readonly Readonly<{ id: string; expression: PlainMathJson }>[] = [],
): ExecutableProofState {
  return executableProofStateSchema.parse({
    id: "state:0",
    goals: [
      {
        id: "goal:main",
        sequent: {
          context: {
            declarations,
            hypotheses: hypotheses.map(({ id, expression }) => ({ id, statement: { expression } })),
          },
          conclusion: { expression: conclusion },
        },
      },
    ],
    obligations: [],
  });
}

function step(
  index: number,
  kind: string,
  fields: Readonly<Record<string, unknown>> = {},
  target = "goal:main",
): Readonly<Record<string, unknown>> {
  return {
    kind,
    expectedStateId: `state:${index}`,
    resultStateId: `state:${index + 1}`,
    target: { kind: "goal", id: target },
    ...fields,
  };
}

describe("composeTransitionClasses", () => {
  it("takes the weakest guarantee: weakening > strengthening > equivalence", () => {
    const cases: readonly (readonly [readonly TransitionClass[], TransitionClass])[] = [
      [[], "equivalence"],
      [["equivalence", "equivalence"], "equivalence"],
      [["equivalence", "strengthening", "equivalence"], "strengthening"],
      [["strengthening", "weakening", "equivalence"], "weakening"],
      [["weakening", "strengthening"], "weakening"],
    ];
    for (const [classes, expected] of cases) {
      expect(composeTransitionClasses(classes)).toBe(expected);
    }
  });
});

describe("planMoveSequence", () => {
  it("chains operations through successive states and previews the final state", () => {
    const plan = movePlanImplementationSchema.parse({
      kind: "deterministic-plan",
      steps: [
        { id: "step:intro", operationKind: "introduce-implication" },
        { id: "step:close", operationKind: "close-by-hypothesis" },
      ],
    });
    const result = planMoveSequence(
      state(["Implies", "p", "p"]),
      [
        step(0, "introduce-implication", { hypothesisId: "h:p" }),
        step(1, "close-by-hypothesis", { hypothesisId: "h:p" }),
      ],
      {},
      plan,
    );
    expect(result).toMatchObject({
      ok: true,
      steps: [
        { transitionClass: "equivalence", evidence: "structural" },
        { transitionClass: "equivalence", evidence: "structural" },
      ],
      preview: {
        state: { id: "state:2", goals: [] },
        transitionClass: "equivalence",
        evidence: ["structural"],
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("aggregates the weakest class and the union of evidence", () => {
    const strengthened = planMoveSequence(
      state(["Or", "p", "q"], [{ id: "h:p", expression: "p" }]),
      [
        step(0, "choose-goal-disjunct", { disjunctIndex: 0 }),
        step(1, "close-by-hypothesis", { hypothesisId: "h:p" }),
      ],
    );
    expect(strengthened).toMatchObject({
      ok: true,
      preview: { transitionClass: "strengthening", evidence: ["structural"] },
    });

    const weakened = planMoveSequence(state(["Or", "p", "q"]), [
      step(0, "choose-goal-disjunct", { disjunctIndex: 1 }),
      step(1, "assume-hypothesis", { proposition: "q", hypothesisId: "h:q" }),
      step(2, "mark-sorry", { assumptionId: "assumption:sorry" }),
    ]);
    expect(weakened).toMatchObject({
      ok: true,
      preview: { transitionClass: "weakening", evidence: ["structural", "sorry"] },
    });
  });

  it("is atomic: a failing later step yields no preview", () => {
    const input = state(["Implies", "p", "q"]);
    const before = JSON.stringify(input);
    const result = planMoveSequence(input, [
      step(0, "introduce-implication", { hypothesisId: "h:p" }),
      step(1, "close-by-hypothesis", { hypothesisId: "h:p" }),
    ]);
    expect(result).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "kernel-rejected",
          message: "The kernel rejected step 1: rule-not-applicable.",
          stepIndex: 1,
        },
      ],
    });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("rejects unchained steps, plan mismatches and empty plans", () => {
    const input = state(["Implies", "p", "p"]);
    expect(
      planMoveSequence(input, [
        step(0, "introduce-implication", { hypothesisId: "h:p" }),
        { ...step(1, "close-by-hypothesis", { hypothesisId: "h:p" }), expectedStateId: "state:0" },
      ]),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "kernel-rejected", message: expect.stringContaining("stale-state") }],
    });
    expect(
      planMoveSequence(
        input,
        [step(0, "introduce-implication", { hypothesisId: "h:p" })],
        {},
        {
          kind: "deterministic-plan",
          steps: [{ id: "step:close", operationKind: "close-by-hypothesis" }],
        },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "plan-mismatch", stepIndex: 0 }] });
    expect(planMoveSequence(input, [])).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-request" }],
    });
    expect(
      movePlanImplementationSchema.safeParse({
        kind: "deterministic-plan",
        steps: [
          { id: "step:a", operationKind: "close-true" },
          { id: "step:a", operationKind: "close-true" },
        ],
      }).success,
    ).toBe(false);
  });
});
