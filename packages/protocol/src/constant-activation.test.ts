import { describe, expect, it } from "vitest";
import {
  appliedResultIds,
  constantActivationSchema,
  createMovePreviewSchema,
  effectiveOperators,
  parseProofArtifact,
  type ConstantActivation,
  type OperatorDeclaration,
} from "./index";

const INTEGER = { kind: "named", id: "sort:integer" } as never;
const operator = (symbol: string, overrides: Record<string, unknown> = {}) =>
  ({
    id: `operator:${symbol.toLowerCase()}`,
    symbol,
    signature: { parameters: [INTEGER, INTEGER], result: INTEGER },
    ...overrides,
  }) as unknown as OperatorDeclaration;
const SETUP = [operator("Divides")];
const GCD = operator("Gcd");
const LCM = operator("Lcm");

function activation(
  declaration: OperatorDeclaration,
  sequence: number,
): Pick<ConstantActivation, "sequence" | "symbol" | "declaration"> {
  return { sequence, symbol: declaration.symbol, declaration };
}

describe("a constant activation record", () => {
  const record = {
    sequence: 1,
    symbol: "Gcd",
    declaration: GCD,
    commandId: "command:apply",
    edgeId: "edge:apply",
    nodeId: "node:apply",
    resultId: "result:gcd-divides",
    transitionSequence: 4,
    activatedAt: "2026-10-19T10:00:00.000Z",
  };

  it("is strict, restates its declaration's symbol and names the step", () => {
    expect(constantActivationSchema.safeParse(record).success).toBe(true);
    expect(constantActivationSchema.safeParse({ ...record, symbol: "Lcm" }).success).toBe(false);
    expect(constantActivationSchema.safeParse({ ...record, sequence: 0 }).success).toBe(false);
    expect(constantActivationSchema.safeParse({ ...record, extra: true }).success).toBe(false);
    expect(
      constantActivationSchema.safeParse({ ...record, activatedAt: "yesterday" }).success,
    ).toBe(false);
  });
});

describe("effective operators", () => {
  it("are the setup operators followed by the activated constants in order", () => {
    expect(effectiveOperators(SETUP, [])).toEqual({ ok: true, operators: SETUP });
    const effective = effectiveOperators(SETUP, [activation(GCD, 1), activation(LCM, 2)]);
    expect(effective.ok && effective.operators.map(({ symbol }) => symbol)).toEqual([
      "Divides",
      "Gcd",
      "Lcm",
    ]);
  });

  it("refuse activations out of order, repeated, or clashing with the setup", () => {
    expect(effectiveOperators(SETUP, [activation(GCD, 2)]).ok).toBe(false);
    expect(effectiveOperators(SETUP, [activation(GCD, 1), activation(GCD, 2)]).ok).toBe(false);
    expect(effectiveOperators(SETUP, [activation(SETUP[0]!, 1)]).ok).toBe(false);
    const clash = effectiveOperators(SETUP, [
      activation(operator("Gcd", { id: "operator:divides" }), 1),
    ]);
    expect(clash).toEqual({
      ok: false,
      message: "The operators Divides and Gcd share the identifier operator:divides.",
    });
  });
});

describe("the results a step applies", () => {
  it("names the result of an application or of a rewrite whose source is a result", () => {
    const applied = (operation: unknown) => appliedResultIds(operation as never);
    expect(applied({ kind: "apply-result-backward", resultId: "result:a" })).toEqual(["result:a"]);
    expect(applied({ kind: "apply-result-forward", resultId: "result:a" })).toEqual(["result:a"]);
    expect(
      applied({
        kind: "rewrite-with-equivalence",
        source: { kind: "result", resultId: "result:b" },
      }),
    ).toEqual(["result:b"]);
    expect(
      applied({
        kind: "rewrite-with-implication",
        source: { kind: "result", resultId: "result:c" },
      }),
    ).toEqual(["result:c"]);
    expect(
      applied({
        kind: "rewrite-with-equivalence",
        source: { kind: "hypothesis", hypothesisId: "hyp" },
      }),
    ).toEqual([]);
    expect(applied({ kind: "close-true" })).toEqual([]);
  });
});

describe("a preview that names constants", () => {
  const state = (id: string, expression: unknown) => ({
    id,
    goals: [
      {
        id: "goal:1",
        sequent: {
          context: { declarations: [], hypotheses: [] },
          conclusion: { expression },
        },
      },
    ],
    obligations: [],
  });
  const preview = (extra: Record<string, unknown> = {}) => ({
    id: "preview:one",
    nodeId: "node:root",
    stateId: "state:before",
    suggestionSetId: "suggestion-set:one",
    chosenSuggestionId: "suggestion:one",
    moveId: "move:replace",
    operation: {
      kind: "close-true",
      expectedStateId: "state:before",
      resultStateId: "state:after",
      target: { kind: "goal", id: "goal:1" },
    },
    transitionClass: "equivalence",
    beforeState: state("state:before", "True"),
    afterState: state("state:after", ["Equal", ["Gcd", 6, 4], 2]),
    delta: {
      goals: { added: [], removed: [], updated: ["goal:1"] },
      obligations: { added: [], removed: [], updated: [] },
    },
    ...extra,
  });

  it("is read in the session's operators plus the constants it names", () => {
    const schema = createMovePreviewSchema({ operators: SETUP });
    const without = schema.safeParse(preview());
    expect(without.success).toBe(false);
    expect(schema.safeParse(preview({ constants: [GCD] })).success).toBe(true);
    // Another environment does not make the constant part of it: the preview still names it.
    const parsed = createMovePreviewSchema({ operators: [...SETUP, GCD] }).safeParse(preview());
    expect(parsed.success).toBe(true);
  });

  it("refuses constants that clash with the session or are empty", () => {
    const schema = createMovePreviewSchema({ operators: SETUP });
    const clash = schema.safeParse(
      preview({ constants: [operator("Gcd", { id: "operator:divides" })] }),
    );
    expect(clash.success).toBe(false);
    expect(
      clash.success ? "" : clash.error.issues.map(({ message }) => message).join(" "),
    ).toContain("must not clash");
    expect(schema.safeParse(preview({ constants: [] })).success).toBe(false);
  });
});

describe("an artifact without activations", () => {
  it("is still an artifact: a missing section means none", () => {
    const parsed = parseProofArtifact({ artifactVersion: 2, kind: "proof-artifact" });
    expect(parsed.ok).toBe(false);
    const bad = parseProofArtifact({
      artifactVersion: 2,
      initialState: { rootNodeId: "node:root", operators: SETUP },
      library: { operators: SETUP },
      constantActivations: [{ sequence: 1 }],
    });
    expect(bad).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-artifact", path: ["constantActivations"] }],
    });
  });
});
