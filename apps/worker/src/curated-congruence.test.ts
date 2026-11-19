import { previewGeneralizedRewrite } from "@proof/kernel";
import { REAL_SORT } from "@proof/library";
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
