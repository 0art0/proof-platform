import { applyTransition, previewGeneralizedRewrite } from "@proof/kernel";
import {
  CLOSURE_OPERATOR_DECLARATIONS,
  ELEMENT_SET_SORT,
  ELEMENT_SORT,
  REAL_SORT,
  SET_OPERATOR_DECLARATIONS,
} from "@proof/library";
import {
  createExecutableProofStateSchema,
  statementIdSchema,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { describe, expect, it } from "vitest";
import { approvedResultEnvironment } from "./approved-catalog";

function multiplyRewrite(
  relation: "LessEqual" | "Less",
  order: "Monotone" | "Antitone",
  guard?: PlainMathJson,
) {
  const monotone = order === "Monotone";
  const state = createExecutableProofStateSchema().parse({
    id: "state:order",
    goals: [
      {
        id: "goal:order",
        sequent: {
          context: {
            declarations: ["x", "y", "z", "c"].map((symbol) => ({
              id: `declaration:${symbol}`,
              sort: REAL_SORT,
              symbol,
              role: "universal-parameter",
            })),
            hypotheses: [
              { id: "hypothesis:order", statement: { expression: [relation, "x", "y"] } },
              ...(guard === undefined
                ? []
                : [{ id: "hypothesis:sign", statement: { expression: guard } }]),
            ],
          },
          conclusion: { expression: [relation, ["Multiply", monotone ? "x" : "y", "c"], "z"] },
        },
      },
    ],
    obligations: [],
  });
  const results = approvedResultEnvironment([]);
  if (results === undefined) throw new Error("Could not adapt the production library.");
  return previewGeneralizedRewrite(
    state,
    {
      target: { kind: "goal", id: statementIdSchema.parse("goal:order") },
      statement: { kind: "conclusion" },
      source: { kind: "hypothesis", hypothesisId: statementIdSchema.parse("hypothesis:order") },
      path: [0, 0],
      direction: monotone ? "forward" : "backward",
    },
    { results },
  );
}

describe("order congruence in the production library", () => {
  it("asks for zero or a positive factor when lifting a weak inequality", () => {
    expect(multiplyRewrite("LessEqual", "Monotone")).toMatchObject({
      ok: true,
      replacement: "y",
      transitionClass: "strengthening",
      obligations: [["LessEqual", 0, "c"]],
      congruenceResultIds: [
        "result:less-equal-multiply-nonnegative-left",
        "result:less-equal-transport-less-equal-left",
      ],
    });
    expect(multiplyRewrite("LessEqual", "Monotone", ["LessEqual", 0, "c"])).toMatchObject({
      ok: true,
      obligations: [],
    });
    expect(multiplyRewrite("LessEqual", "Monotone", ["Greater", "c", 0])).toMatchObject({
      ok: true,
      obligations: [],
      congruenceResultIds: [
        "result:less-equal-multiply-positive-left",
        "result:less-equal-transport-less-equal-left",
      ],
    });
  });

  it("uses a nonpositive factor for weak antitonicity and witnesses strict negativity when supplied", () => {
    expect(multiplyRewrite("LessEqual", "Antitone")).toMatchObject({
      ok: true,
      replacement: "x",
      obligations: [["LessEqual", "c", 0]],
      congruenceResultIds: [
        "result:less-equal-multiply-nonpositive-left",
        "result:less-equal-transport-less-equal-left",
      ],
    });
    expect(multiplyRewrite("LessEqual", "Antitone", ["Less", "c", 0])).toMatchObject({
      ok: true,
      obligations: [],
      congruenceResultIds: [
        "result:less-equal-multiply-negative-left",
        "result:less-equal-transport-less-equal-left",
      ],
    });
  });

  it("asks for a strictly positive factor when preserving a strict comparison", () => {
    expect(multiplyRewrite("Less", "Monotone", ["LessEqual", 0, "c"])).toMatchObject({
      ok: true,
      obligations: [["Greater", "c", 0]],
      congruenceResultIds: [
        "result:less-multiply-positive-left",
        "result:less-transport-less-left",
      ],
    });
  });
});

it("composes the production closure and membership witnesses in the sound directions", () => {
  const operators = [...SET_OPERATOR_DECLARATIONS, ...CLOSURE_OPERATOR_DECLARATIONS];
  const results = approvedResultEnvironment(operators);
  if (results === undefined) throw new Error("Could not adapt the production library.");
  const state = createExecutableProofStateSchema({ operators }).parse({
    id: "state:closure-before",
    goals: [
      {
        id: "goal:closure",
        sequent: {
          context: {
            declarations: [
              {
                id: "declaration:A",
                sort: ELEMENT_SET_SORT,
                symbol: "A",
                role: "universal-parameter",
              },
              {
                id: "declaration:B",
                sort: ELEMENT_SET_SORT,
                symbol: "B",
                role: "universal-parameter",
              },
              { id: "declaration:x", sort: ELEMENT_SORT, symbol: "x", role: "universal-parameter" },
            ],
            hypotheses: [
              { id: "hypothesis:subset", statement: { expression: ["SubsetEqual", "A", "B"] } },
              {
                id: "hypothesis:member",
                statement: { expression: ["Element", "x", ["Closure", "A"]] },
              },
            ],
          },
          conclusion: { expression: ["Element", "x", ["Closure", "B"]] },
        },
      },
    ],
    obligations: [],
  });
  const address = {
    target: { kind: "goal", id: statementIdSchema.parse("goal:closure") },
    source: { kind: "hypothesis", hypothesisId: statementIdSchema.parse("hypothesis:subset") },
    path: [1, 0],
  } as const;
  const environment = { operators, results };
  const witnesses = ["result:closure-monotone", "result:subset-membership"];
  const goalPlan = previewGeneralizedRewrite(
    state,
    { ...address, statement: { kind: "conclusion" }, direction: "backward" },
    environment,
  );
  expect(goalPlan).toMatchObject({
    ok: true,
    replacement: "A",
    transitionClass: "strengthening",
    obligations: [],
    congruenceResultIds: witnesses,
  });

  const hypothesisRewrite = {
    ...address,
    statement: { kind: "hypothesis", id: statementIdSchema.parse("hypothesis:member") },
    direction: "forward",
  } as const;
  const plan = previewGeneralizedRewrite(state, hypothesisRewrite, environment);
  expect(plan).toMatchObject({
    ok: true,
    replacement: "B",
    transitionClass: "strengthening",
    obligations: [],
    congruenceResultIds: witnesses,
  });
  if (!plan.ok) throw new Error(plan.message);
  expect(
    applyTransition(
      state,
      {
        ...hypothesisRewrite,
        kind: "generalized-rewrite",
        expectedStateId: state.id,
        resultStateId: "state:closure-after",
        obligationIds: [],
        congruenceResultIds: plan.congruenceResultIds,
      },
      environment,
    ),
  ).toMatchObject({
    ok: true,
    state: {
      goals: [
        {
          sequent: {
            context: {
              hypotheses: expect.arrayContaining([
                {
                  id: "hypothesis:member",
                  statement: { expression: ["Element", "x", ["Closure", "B"]] },
                },
              ]),
            },
          },
        },
      ],
    },
  });
});
