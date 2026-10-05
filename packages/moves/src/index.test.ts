import { describe, expect, it } from "vitest";
import {
  KERNEL_OPERATION_KINDS,
  type KernelEnvironment,
  type KernelResult,
  type KernelOperation,
  type KernelOperationKind,
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
  declaredTransitionClass,
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
      expect(move.transitionClass).toBe(declaredTransitionClass(move.implementation.operationKind));
      expect(PRIMITIVE_TRANSITION_CLASSES[move.implementation.operationKind]).toContain(
        move.transitionClass,
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
      KernelOperationKind,
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
          transitionClass: declaredTransitionClass(kind),
          evidence: PRIMITIVE_TRANSITION_EVIDENCE[kind][0],
        },
      });
    }
    expect(PRIMITIVE_TRANSITION_CLASSES["assume-hypothesis"]).toEqual(["weakening"]);
    expect(PRIMITIVE_TRANSITION_CLASSES["replace-goal"]).toEqual(["weakening"]);
    expect(PRIMITIVE_TRANSITION_CLASSES.suffices).toEqual(["strengthening"]);
    expect(PRIMITIVE_TRANSITION_CLASSES["drop-hypothesis"]).toEqual(["strengthening"]);
    expect(PRIMITIVE_TRANSITION_CLASSES["apply-result-forward"]).toEqual([
      "equivalence",
      "strengthening",
    ]);
    expect(PRIMITIVE_TRANSITION_EVIDENCE["close-by-accepted-inference"]).toEqual([
      "background-inference",
    ]);
    expect(
      KERNEL_OPERATION_KINDS.filter(
        (kind) =>
          PRIMITIVE_TRANSITION_EVIDENCE[kind].length !== 1 ||
          PRIMITIVE_TRANSITION_EVIDENCE[kind][0] !== "structural",
      ),
    ).toEqual([
      "close-by-accepted-inference",
      "rewrite-with-equivalence",
      "rewrite-with-implication",
      "apply-result-backward",
      "apply-result-forward",
      "mark-sorry",
    ]);
    expect(PRIMITIVE_TRANSITION_EVIDENCE["rewrite-with-implication"]).toEqual([
      "structural",
      "library-result",
    ]);
  });

  it("previews a sorry and closing a target by that additional assumption", () => {
    const input = state(["Implies", "p", "q"], [{ id: "hypothesis:p", expression: "p" }]);
    const sorry = planMove(input, {
      moveId: "move:mark-sorry",
      operation: operation("mark-sorry", { assumptionId: "assumption:sorry" }),
    });
    expect(sorry).toMatchObject({
      ok: true,
      preview: {
        transitionClass: "equivalence",
        evidence: "sorry",
        state: {
          goals: [],
          assumptions: [
            {
              id: "assumption:sorry",
              statement: {
                expression: [
                  "ForAll",
                  "p",
                  ["ForAll", "q", ["Implies", "p", ["Implies", "p", "q"]]],
                ],
              },
              origin: { kind: "sorry", sourceTarget: { kind: "goal", id: "goal:main" } },
            },
          ],
        },
      },
    });
    if (!sorry.ok) return;

    const withAssumption = executableProofStateSchema.parse({
      ...input,
      assumptions: sorry.preview.state.assumptions,
    });
    const closed = planMove(withAssumption, {
      moveId: "move:close-by-assumption",
      operation: operation("close-by-assumption", {
        assumptionId: "assumption:sorry",
        instantiation: { p: "p", q: "q" },
      }),
    });
    expect(closed).toMatchObject({
      ok: true,
      preview: { transitionClass: "equivalence", evidence: "structural", state: { goals: [] } },
    });
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
      KernelOperationKind,
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
          transitionClass: declaredTransitionClass(kind),
          evidence: "library-result",
        },
      });
    }
    // Every premise matched by a hypothesis: no obligation, so the same primitive is an equivalence.
    expect(
      planMove(
        state("q", [
          { id: "hypothesis:implication", expression: ["Implies", "p", "q"] },
          { id: "hypothesis:p", expression: "p" },
        ]),
        {
          moveId: "move:apply-result-forward",
          operation: operation("apply-result-forward", {
            resultId: "result:modus-ponens",
            instantiation: { a: "p", b: "q" },
            premiseHypothesisIds: ["hypothesis:implication", "hypothesis:p"],
            resultHypothesisId: "hypothesis:q",
            obligationIds: [],
          }),
        },
        environment,
      ),
    ).toMatchObject({ ok: true, preview: { transitionClass: "equivalence" } });
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

  it("previews deep rewrites with source-dependent evidence and polarity-checked classes", () => {
    const environment: KernelEnvironment = {
      results: [
        {
          id: "result:double-negation",
          parameters: [{ symbol: "a", sort: PROPOSITION_SORT }],
          premises: [],
          conclusion: { expression: ["Equivalent", ["Not", ["Not", "a"]], "a"] },
          directions: ["backward"],
        },
      ] as unknown as readonly KernelResult[],
    };
    const cases: readonly (readonly [
      ExecutableProofState,
      KernelOperationKind,
      Readonly<Record<string, unknown>>,
      "structural" | "library-result",
    ])[] = [
      [
        state(["Not", "p"], [{ id: "hypothesis:iff", expression: ["Equivalent", "p", "q"] }]),
        "rewrite-with-equivalence",
        {
          statement: { kind: "conclusion" },
          path: [0],
          source: { kind: "hypothesis", hypothesisId: "hypothesis:iff" },
          direction: "forward",
        },
        "structural",
      ],
      [
        state(["Or", ["Not", ["Not", "p"]], "q"]),
        "rewrite-with-equivalence",
        {
          statement: { kind: "conclusion" },
          path: [0],
          source: {
            kind: "result",
            resultId: "result:double-negation",
            instantiation: { a: "p" },
          },
          direction: "forward",
        },
        "library-result",
      ],
      [
        state(["Or", "q", "q"], [{ id: "hypothesis:implies", expression: ["Implies", "p", "q"] }]),
        "rewrite-with-implication",
        {
          statement: { kind: "conclusion" },
          path: [1],
          source: { kind: "hypothesis", hypothesisId: "hypothesis:implies" },
        },
        "structural",
      ],
    ];
    for (const [input, kind, fields, evidence] of cases) {
      expect(
        planMove(
          input,
          { moveId: `move:${kind}`, operation: operation(kind, fields) },
          environment,
        ),
      ).toMatchObject({
        ok: true,
        preview: { transitionClass: declaredTransitionClass(kind), evidence },
      });
    }
    expect(PRIMITIVE_TRANSITION_CLASSES["rewrite-with-implication"]).toEqual(["strengthening"]);
    expect(
      planMove(
        state(
          ["Equivalent", "q", "p"],
          [{ id: "hypothesis:implies", expression: ["Implies", "p", "q"] }],
        ),
        {
          moveId: "move:rewrite-with-implication",
          operation: operation("rewrite-with-implication", {
            statement: { kind: "conclusion" },
            path: [0],
            source: { kind: "hypothesis", hypothesisId: "hypothesis:implies" },
          }),
        },
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "kernel-rejected",
          message: "The kernel rejected the move: polarity-not-permitted.",
        },
      ],
    });
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
