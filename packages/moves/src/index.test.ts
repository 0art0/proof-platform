import { describe, expect, it } from "vitest";
import {
  KERNEL_OPERATION_KINDS,
  type KernelEnvironment,
  type KernelResult,
  type KernelOperation,
} from "@proof/kernel";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  HAND_AUTHORED_MOVES,
  PRIMITIVE_PATTERN_SLOTS,
  PRIMITIVE_TRANSITION_CLASSES,
  PRIMITIVE_TRANSITION_EVIDENCE,
  moveDefinitionSchema,
  planMove,
} from "./index";

const declarations = ["p", "q"].map((symbol, index) => ({
  id: `declaration:${index}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
}));

function state(
  conclusion: PlainMathJson,
  hypotheses: readonly Readonly<{ id: string; expression: PlainMathJson }>[] = [],
): ExecutableProofState {
  return executableProofStateSchema.parse({
    id: "state:before",
    goals: [
      {
        id: "goal:main",
        sequent: {
          context: {
            declarations,
            hypotheses: hypotheses.map(({ id, expression }) => ({
              id,
              statement: { expression },
            })),
          },
          conclusion: { expression: conclusion },
        },
      },
    ],
    obligations: [],
  });
}

function operation(
  kind: KernelOperation["kind"],
  fields: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    kind,
    expectedStateId: "state:before",
    resultStateId: "state:after",
    target: { kind: "goal", id: "goal:main" },
    ...fields,
  };
}

describe("hand-authored move catalog", () => {
  it("covers every kernel primitive exactly once with an inspectable approved definition", () => {
    expect(HAND_AUTHORED_MOVES).toHaveLength(KERNEL_OPERATION_KINDS.length);
    expect(
      HAND_AUTHORED_MOVES.map(({ implementation }) => implementation.operationKind).sort(),
    ).toEqual([...KERNEL_OPERATION_KINDS].sort());
    HAND_AUTHORED_MOVES.forEach((move) => {
      expect(moveDefinitionSchema.safeParse(move).success).toBe(true);
      expect(move.approval.status).toBe("approved");
      expect(move.examples.positive).toHaveLength(2);
      expect(move.examples.negative).toHaveLength(1);
      expect(Object.isFrozen(move)).toBe(true);
      expect(move.transitionClass).toBe(
        PRIMITIVE_TRANSITION_CLASSES[move.implementation.operationKind],
      );
      expect(move.selectionContract.slots.map(({ id }) => id)).toContain(
        PRIMITIVE_PATTERN_SLOTS[move.implementation.operationKind],
      );
    });
  });

  it("rejects definitions with duplicate contracts, invalid dependencies, or false classifications", () => {
    const source = structuredClone(HAND_AUTHORED_MOVES[0]!);
    expect(
      moveDefinitionSchema.safeParse({
        ...source,
        selectionContract: {
          slots: [source.selectionContract.slots[0], source.selectionContract.slots[0]],
          allowAdditional: false,
        },
      }).success,
    ).toBe(false);
    expect(
      moveDefinitionSchema.safeParse({
        ...source,
        requiredArtifacts: [{ kind: "technique", id: "technique:forbidden-dependency" }],
      }).success,
    ).toBe(false);
    expect(
      moveDefinitionSchema.safeParse({ ...source, transitionClass: "weakening" }).success,
    ).toBe(false);
  });

  it("rejects hostile definition accessors without invoking them", () => {
    let invoked = false;
    const hostile = Object.defineProperty({}, "id", {
      enumerable: true,
      get() {
        invoked = true;
        return "move:hostile";
      },
    });
    expect(moveDefinitionSchema.safeParse(hostile).success).toBe(false);
    expect(invoked).toBe(false);
  });
});

describe("deterministic move planning", () => {
  it("previews a validated primitive without mutating the input state", () => {
    const input = state("True");
    const before = JSON.stringify(input);
    const request = {
      moveId: "move:close-true",
      operation: operation("close-true"),
    };
    const result = planMove(input, request);

    expect(result).toMatchObject({
      ok: true,
      move: { id: "move:close-true" },
      operation: { kind: "close-true" },
      preview: { state: { id: "state:after", goals: [] }, transitionClass: "equivalence" },
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(input.goals).toHaveLength(1);
    if (result.ok) {
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.preview.state)).toBe(true);
    }
  });

  it("keeps strengthening visible in existential and disjunction previews", () => {
    for (const [input, moveId, plannedOperation] of [
      [
        state(["Or", "p", "q"]),
        "move:choose-goal-disjunct",
        operation("choose-goal-disjunct", { disjunctIndex: 1 }),
      ],
      [
        state(["Exists", "p", ["Or", "p", "q"]]),
        "move:choose-existential-witness",
        operation("choose-existential-witness", { witness: "q" }),
      ],
    ] as const) {
      expect(planMove(input, { moveId, operation: plannedOperation })).toMatchObject({
        ok: true,
        preview: { transitionClass: "strengthening" },
      });
    }
  });

  it("previews every classical, weakening, and strengthening primitive with its declared class", () => {
    const withFacts = state("q", [
      { id: "hypothesis:p", expression: "p" },
      { id: "hypothesis:not-p", expression: ["Not", "p"] },
    ]);
    const cases: readonly (readonly [
      ExecutableProofState,
      KernelOperation["kind"],
      Readonly<Record<string, unknown>>,
    ])[] = [
      [state(["Equal", "p", "p"]), "close-reflexive-equality", {}],
      [
        withFacts,
        "close-by-contradiction",
        { hypothesisId: "hypothesis:p", negationHypothesisId: "hypothesis:not-p" },
      ],
      [state("q"), "close-by-accepted-inference", { attestationId: "attestation:1" }],
      [
        state("q"),
        "split-classical-cases",
        {
          proposition: "p",
          childIds: ["case:p", "case:not-p"],
          branchHypothesisIds: ["hypothesis:case-p", "hypothesis:case-not-p"],
        },
      ],
      [state("q"), "assume-hypothesis", { proposition: "p", hypothesisId: "hypothesis:new" }],
      [state("q"), "replace-goal", { proposition: "p" }],
      [state("q"), "suffices", { proposition: "p", obligationId: "obligation:sufficiency" }],
      [withFacts, "drop-hypothesis", { hypothesisId: "hypothesis:p" }],
    ];
    for (const [input, kind, fields] of cases) {
      const result = planMove(input, {
        moveId: `move:${kind}`,
        operation: operation(kind, fields),
      });
      expect(result).toMatchObject({
        ok: true,
        preview: {
          transitionClass: PRIMITIVE_TRANSITION_CLASSES[kind],
          evidence: PRIMITIVE_TRANSITION_EVIDENCE[kind],
        },
      });
    }
    expect(PRIMITIVE_TRANSITION_CLASSES["assume-hypothesis"]).toBe("weakening");
    expect(PRIMITIVE_TRANSITION_CLASSES["replace-goal"]).toBe("weakening");
    expect(PRIMITIVE_TRANSITION_CLASSES.suffices).toBe("strengthening");
    expect(PRIMITIVE_TRANSITION_CLASSES["drop-hypothesis"]).toBe("strengthening");
    expect(PRIMITIVE_TRANSITION_EVIDENCE["close-by-accepted-inference"]).toBe(
      "background-inference",
    );
    expect(
      KERNEL_OPERATION_KINDS.filter((kind) => PRIMITIVE_TRANSITION_EVIDENCE[kind] !== "structural"),
    ).toEqual(["close-by-accepted-inference", "apply-result-backward", "apply-result-forward"]);
  });

  it("previews approved-result applications with library-result evidence", () => {
    const propositions = ["a", "b"].map((symbol) => ({ symbol, sort: PROPOSITION_SORT }));
    const environment: KernelEnvironment = {
      results: [
        {
          id: "result:conjunction-introduction",
          parameters: propositions,
          premises: [{ expression: "a" }, { expression: "b" }],
          conclusion: { expression: ["And", "a", "b"] },
          directions: ["backward"],
        },
        {
          id: "result:modus-ponens",
          parameters: propositions,
          premises: [{ expression: ["Implies", "a", "b"] }, { expression: "a" }],
          conclusion: { expression: "b" },
          directions: ["forward"],
        },
      ] as unknown as readonly KernelResult[],
    };
    const cases: readonly (readonly [
      ExecutableProofState,
      KernelOperation["kind"],
      Readonly<Record<string, unknown>>,
    ])[] = [
      [
        state(["And", "p", "q"]),
        "apply-result-backward",
        {
          resultId: "result:conjunction-introduction",
          instantiation: { a: "p", b: "q" },
          premiseTargetIds: ["goal:p", "goal:q"],
        },
      ],
      [
        state("q", [{ id: "hypothesis:implication", expression: ["Implies", "p", "q"] }]),
        "apply-result-forward",
        {
          resultId: "result:modus-ponens",
          instantiation: { a: "p", b: "q" },
          premiseHypothesisIds: ["hypothesis:implication", null],
          resultHypothesisId: "hypothesis:q",
          obligationIds: ["obligation:p"],
        },
      ],
    ];
    for (const [input, kind, fields] of cases) {
      expect(
        planMove(
          input,
          { moveId: `move:${kind}`, operation: operation(kind, fields) },
          environment,
        ),
      ).toMatchObject({
        ok: true,
        preview: {
          transitionClass: PRIMITIVE_TRANSITION_CLASSES[kind],
          evidence: "library-result",
        },
      });
    }
    expect(
      planMove(
        state(["And", "p", "q"]),
        {
          moveId: "move:apply-result-backward",
          operation: operation("apply-result-backward", {
            resultId: "result:missing",
            instantiation: {},
            premiseTargetIds: [],
          }),
        },
        environment,
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "kernel-rejected" }] });
  });

  it("rejects unknown moves, mismatched primitives, and inapplicable operations", () => {
    const input = state("True");
    expect(
      planMove(input, { moveId: "move:missing", operation: operation("close-true") }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "move-not-found" }] });
    expect(
      planMove(input, {
        moveId: "move:close-true",
        operation: operation("introduce-negation", { hypothesisId: "hypothesis:p" }),
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "operation-kind-mismatch" }] });
    expect(
      planMove(state("p"), {
        moveId: "move:close-true",
        operation: operation("close-true"),
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "kernel-rejected" }] });
  });

  it("rejects accessor-backed requests without invoking getters", () => {
    let invoked = false;
    const hostile = Object.defineProperty({}, "moveId", {
      enumerable: true,
      get() {
        invoked = true;
        return "move:close-true";
      },
    });
    expect(planMove(state("True"), hostile)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-request" }],
    });
    expect(invoked).toBe(false);
  });

  it("completes conjunction commutativity through only previewed kernel moves", () => {
    let current = state(["Implies", ["And", "p", "q"], ["And", "q", "p"]]);
    current = successfulPreview(
      current,
      "move:introduce-implication",
      operationFor(current, "state:introduced", "goal:main", "introduce-implication", {
        hypothesisId: "hypothesis:conjunction",
      }),
    );
    current = successfulPreview(
      current,
      "move:expand-hypothesis-conjunction",
      operationFor(current, "state:expanded", "goal:main", "expand-hypothesis-conjunction", {
        hypothesisId: "hypothesis:conjunction",
        expandedHypothesisIds: ["hypothesis:p", "hypothesis:q"],
      }),
    );
    current = successfulPreview(
      current,
      "move:split-goal-conjunction",
      operationFor(current, "state:split", "goal:main", "split-goal-conjunction", {
        childIds: ["goal:q", "goal:p"],
      }),
    );
    current = successfulPreview(
      current,
      "move:close-by-hypothesis",
      operationFor(current, "state:q-closed", "goal:q", "close-by-hypothesis", {
        hypothesisId: "hypothesis:q",
      }),
    );
    current = successfulPreview(
      current,
      "move:close-by-hypothesis",
      operationFor(current, "state:solved", "goal:p", "close-by-hypothesis", {
        hypothesisId: "hypothesis:p",
      }),
    );

    expect(current).toMatchObject({ id: "state:solved", goals: [], obligations: [] });
  });
});

function operationFor(
  current: ExecutableProofState,
  resultStateId: string,
  targetId: string,
  kind: KernelOperation["kind"],
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    kind,
    expectedStateId: current.id,
    resultStateId,
    target: { kind: "goal", id: targetId },
    ...fields,
  };
}

function successfulPreview(
  current: ExecutableProofState,
  moveId: string,
  plannedOperation: unknown,
): ExecutableProofState {
  const result = planMove(current, { moveId, operation: plannedOperation });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostics[0].message);
  return result.preview.state;
}
