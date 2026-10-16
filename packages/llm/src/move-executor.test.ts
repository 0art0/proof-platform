import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyTransition } from "@proof/kernel";
import { MAX_PLAN_STEPS } from "@proof/moves/authoring";
import { createProofNodeSchema, type ProofNode } from "@proof/protocol";
import {
  EXECUTOR_FORBIDDEN_OPERATION_KINDS,
  EXECUTOR_OPERATION_KINDS,
  buildMoveExecutorContext,
  executePreparedLlmCall,
  executorFreshIdFields,
  executorPlanOperations,
  llmCallEvidenceSchema,
  llmOutputSchemaForRole,
  prepareLlmCall,
  validateLlmOutput,
  type PreparedLlmCall,
} from "./index";

const callId = "llm-call:execute-test";

function declaration(symbol: string, index: number) {
  return {
    id: `declaration:${index}`,
    symbol,
    sort: { kind: "proposition" },
    role: "universal-parameter",
  };
}

/** Two goals: the target, and an unrelated one whose contents must never reach the model. */
function node(expression: unknown = ["Implies", "p", "q"]): ProofNode {
  return createProofNodeSchema().parse({
    id: "node:current",
    state: {
      id: "state:current",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: ["p", "q", "unused-symbol"].map(declaration),
              hypotheses: [
                { id: "hypothesis:0", statement: { expression: ["Implies", "p", "q"] } },
              ],
            },
            conclusion: { expression },
          },
        },
        {
          id: "goal:elsewhere",
          sequent: {
            context: {
              declarations: [declaration("remote-secret-symbol", 9)],
              hypotheses: [],
            },
            conclusion: { expression: "remote-secret-symbol" },
          },
        },
      ],
      obligations: [],
    },
  });
}

const target = { kind: "goal", id: "goal:main" } as const;

function resolvedConclusion(current: ProofNode) {
  return {
    kind: "exact",
    anchor: {
      stateId: current.state.id,
      target,
      statement: { kind: "conclusion" },
    },
    path: [],
    fragment: ["Implies", "p", "q"],
    declarations: [],
    position: { polarity: "positive", role: "proposition" },
  };
}

function kernelResult(id: string, conclusion: unknown, premises: unknown[] = []) {
  return {
    id,
    parameters: [{ symbol: "x", sort: { kind: "proposition" } }],
    premises: premises.map((expression) => ({ expression })),
    conclusion: { expression: conclusion },
    directions: ["backward"],
  };
}

function build(overrides: Record<string, unknown> = {}) {
  const current = node();
  return buildMoveExecutorContext({
    id: callId,
    node: current,
    instruction: "  introduce the antecedent and finish  ",
    source: "user-instruction",
    target,
    selections: [resolvedConclusion(current)],
    operators: [],
    results: [],
    ...overrides,
  });
}

function envelope(overrides: Record<string, unknown> = {}) {
  const built = build(overrides);
  if (!built.ok) throw new Error(built.diagnostics[0].message);
  return built.envelope;
}

function preparedCall(overrides: Record<string, unknown> = {}): PreparedLlmCall {
  const prepared = prepareLlmCall(envelope(overrides));
  if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
  return prepared.call;
}

const introduceAntecedent = {
  kind: "introduce-implication",
  target,
  hypothesisId: "assume-p",
};
const closeByAssumption = { kind: "close-by-hypothesis", target, hypothesisId: "assume-p" };

describe("move executor context", () => {
  it("projects the target sequent, selections and instruction only", () => {
    const built = envelope();
    expect(built.role).toBe("move-executor");
    if (built.role !== "move-executor") throw new Error("wrong role");
    const { context } = built;
    expect(context).toMatchObject({
      nodeId: "node:current",
      stateId: "state:current",
      instruction: "introduce the antecedent and finish",
      source: "user-instruction",
      target,
      maxSteps: MAX_PLAN_STEPS,
      sequent: {
        hypotheses: [{ id: "hypothesis:0", expression: ["Implies", "p", "q"] }],
        conclusion: ["Implies", "p", "q"],
      },
      selections: [
        {
          id: "selection:1",
          location: {
            target,
            statement: { kind: "conclusion" },
            occurrence: { kind: "exact", path: [] },
          },
          position: { polarity: "positive", role: "proposition" },
          expression: ["Implies", "p", "q"],
        },
      ],
    });
    // Only the declarations the statements use.
    expect(context.sequent.declarations.map(({ symbol }) => symbol).sort()).toEqual(["p", "q"]);
  });

  it("never contains the problem, other goals, history or alternative suggestions", () => {
    const serialized = JSON.stringify(envelope());
    expect(serialized).not.toContain("remote-secret-symbol");
    expect(serialized).not.toContain("goal:elsewhere");
    expect(serialized).not.toContain("unused-symbol");
    const { context } = envelope() as unknown as { context: Record<string, unknown> };
    for (const key of [
      "problem",
      "background",
      "goals",
      "obligations",
      "history",
      "tree",
      "branches",
      "suggestions",
      "suggestionSet",
      "candidates",
      "alternatives",
    ]) {
      expect(Object.keys(context), key).not.toContain(key);
    }
    expect(Object.keys(context).sort()).toEqual(
      [
        "instruction",
        "maxSteps",
        "nodeId",
        "operators",
        "results",
        "selections",
        "sequent",
        "source",
        "stateId",
        "target",
      ].sort(),
    );
  });

  it("works without selections and for a technique source", () => {
    const built = envelope({ selections: [], source: "shortlisted-technique" });
    expect(built.role === "move-executor" && built.context.selections).toEqual([]);
    expect(built.role === "move-executor" && built.context.source).toBe("shortlisted-technique");
  });

  it("is a deterministic function of its inputs", () => {
    expect(JSON.stringify(envelope())).toBe(JSON.stringify(envelope()));
  });

  it("keeps only approved results that share operators with the selection, best first, capped at 32", () => {
    const many = Array.from({ length: 40 }, (_unused, index) =>
      kernelResult(`result:implies-${String(index).padStart(2, "0")}`, ["Implies", "x", "x"]),
    );
    const results = [
      kernelResult("result:unrelated", ["Equal", "x", "x"]),
      kernelResult("result:a-rich", ["Implies", "x", ["And", "x", "x"]], [["And", "x", "x"]]),
      ...many,
    ];
    const built = envelope({ results, resultNames: { "result:a-rich": "A named result" } });
    if (built.role !== "move-executor") throw new Error("wrong role");
    const ids = built.context.results.map(({ id }) => id);
    expect(ids).toHaveLength(32);
    expect(ids).not.toContain("result:unrelated");
    // The selection mentions only Implies, so every match scores one and ties break by ID.
    expect([...ids]).toEqual([...ids].sort());
    expect(built.context.results.find(({ id }) => id === "result:a-rich")).toMatchObject({
      name: "A named result",
      conclusion: ["Implies", "x", ["And", "x", "x"]],
      premises: [["And", "x", "x"]],
    });
  });

  it("ranks results by the operators they share with the conclusion when nothing is selected", () => {
    const built = buildMoveExecutorContext({
      id: callId,
      node: node(["Implies", ["And", "p", "q"], "p"]),
      instruction: "split",
      source: "user-instruction",
      target,
      selections: [],
      operators: [],
      results: [
        kernelResult("result:a-one-shared", ["Implies", "x", "x"]),
        kernelResult("result:z-two-shared", ["Implies", ["And", "x", "x"], "x"]),
        kernelResult("result:m-none-shared", ["Or", "x", "x"]),
      ],
    });
    if (!built.ok || built.envelope.role !== "move-executor") throw new Error("not built");
    expect(built.envelope.context.results.map(({ id }) => id)).toEqual([
      "result:z-two-shared",
      "result:a-one-shared",
    ]);
  });

  it("rejects a target outside the state, a selection elsewhere, and empty or oversized text", () => {
    const current = node();
    expect(build({ target: { kind: "goal", id: "goal:missing" } }).ok).toBe(false);
    expect(
      build({
        selections: [
          {
            ...resolvedConclusion(current),
            anchor: {
              stateId: current.state.id,
              target: { kind: "goal", id: "goal:elsewhere" },
              statement: { kind: "conclusion" },
            },
          },
        ],
      }).ok,
    ).toBe(false);
    expect(build({ instruction: "   " }).ok).toBe(false);
    expect(build({ instruction: "x".repeat(2_001) }).ok).toBe(false);
    expect(build({ source: "background-proposer" }).ok).toBe(false);
    expect(build({ extra: true }).ok).toBe(false);
  });

  it("prepares a call whose system message names the contract", () => {
    const call = preparedCall();
    expect(call.role).toBe("move-executor");
    expect(call.messages[0].content).toContain("sorry");
    expect(call.messages[1].content).toBe(JSON.stringify(call.envelope));
  });
});

describe("move executor output validation", () => {
  const wireIntroduce = { ...introduceAntecedent };
  const plan = (steps: unknown[], explanation = "Assume p, then it is the hypothesis.") => ({
    kind: "plan",
    steps,
    explanation,
  });

  it("accepts a plan in the stored (kernel-shaped) form", () => {
    const validated = validateLlmOutput(preparedCall(), {
      result: plan([wireIntroduce, closeByAssumption]),
    });
    expect(validated).toMatchObject({
      ok: true,
      output: {
        kind: "plan",
        steps: [{ kind: "introduce-implication" }, { kind: "close-by-hypothesis" }],
      },
    });
  });

  it("accepts a strict wire plan and normalises nulls, statements, sources and instantiations", () => {
    const wire = plan([
      {
        kind: "rewrite-with-equivalence",
        target,
        statement: { kind: "hypothesis", id: "hypothesis:0" },
        path: [0],
        lens: null,
        source: {
          kind: "result",
          hypothesisId: null,
          resultId: "result:swap",
          instantiation: [{ symbol: "x", term: ["Not", "p"] }],
        },
        direction: "forward",
      },
      {
        kind: "introduce-universal",
        target,
        parameterDeclarationId: null,
        membershipHypothesisId: null,
      },
    ]);
    const call = preparedCall({ results: [kernelResult("result:swap", ["Implies", "x", "x"])] });
    const validated = validateLlmOutput(call, { result: wire });
    expect(validated).toMatchObject({ ok: true });
    if (!validated.ok) return;
    expect(validated.output).toEqual({
      kind: "plan",
      steps: [
        {
          kind: "rewrite-with-equivalence",
          target,
          statement: { kind: "hypothesis", id: "hypothesis:0" },
          path: [0],
          source: { kind: "result", resultId: "result:swap", instantiation: { x: ["Not", "p"] } },
          direction: "forward",
        },
        { kind: "introduce-universal", target },
      ],
      explanation: "Assume p, then it is the hypothesis.",
    });
  });

  it("accepts a context request and a refusal", () => {
    expect(
      validateLlmOutput(preparedCall(), {
        result: {
          kind: "insufficient-context",
          requestedCategories: ["local-hypothesis"],
          rationale: "Which hypothesis should I use?",
        },
      }),
    ).toMatchObject({ ok: true, output: { kind: "insufficient-context" } });
    expect(
      validateLlmOutput(preparedCall(), { kind: "declined", reason: "The model declined." }),
    ).toMatchObject({ ok: true, output: { kind: "declined" } });
  });

  it.each(EXECUTOR_FORBIDDEN_OPERATION_KINDS)("rejects a plan that uses %s", (kind) => {
    const forbidden =
      kind === "mark-sorry"
        ? { kind, target, assumptionId: "assumption:one" }
        : { kind, target, attestationId: "attestation:one" };
    const validated = validateLlmOutput(preparedCall(), {
      result: plan([wireIntroduce, forbidden]),
    });
    expect(validated).toMatchObject({
      ok: false,
      diagnostics: [
        { code: "invalid-output", message: expect.stringContaining("may not propose") },
      ],
    });
  });

  it("offers no forbidden or unknown kind in the wire schema", () => {
    expect(EXECUTOR_OPERATION_KINDS).not.toContain("mark-sorry");
    expect(EXECUTOR_OPERATION_KINDS).not.toContain("close-by-accepted-inference");
    expect(EXECUTOR_OPERATION_KINDS).toHaveLength(27);
    const schema = JSON.stringify(z.toJSONSchema(llmOutputSchemaForRole("move-executor")));
    expect(schema).not.toContain("mark-sorry");
    expect(schema).not.toContain("close-by-accepted-inference");
    for (const kind of EXECUTOR_OPERATION_KINDS) expect(schema).toContain(`"${kind}"`);
  });

  it("rejects unknown kinds, construction operations and malformed steps", () => {
    for (const step of [
      { kind: "prove-everything", target },
      { kind: "introduce-placeholder", target },
      { ...introduceAntecedent, kind: undefined },
      { ...introduceAntecedent, extra: "field" },
      { kind: "close-by-hypothesis", target },
      { ...closeByAssumption, expectedStateId: "state:current" },
      { ...closeByAssumption, resultStateId: "state:next" },
      { kind: "split-goal-conjunction", target, childIds: ["only-one"] },
      { kind: "assume-hypothesis", target, hypothesisId: "has:colon", proposition: "p" },
      { kind: "assume-hypothesis", target, hypothesisId: "fine", proposition: { sym: 3 } },
    ]) {
      expect(
        validateLlmOutput(preparedCall(), { result: plan([step]) }),
        JSON.stringify(step),
      ).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-output" }],
      });
    }
  });

  it("bounds the number of steps by MAX_PLAN_STEPS", () => {
    const atTheCap = Array.from({ length: MAX_PLAN_STEPS }, (_unused, index) => ({
      kind: "assume-hypothesis",
      target,
      hypothesisId: `assumption-${index}`,
      proposition: "p",
    }));
    expect(validateLlmOutput(preparedCall(), { result: plan(atTheCap) })).toMatchObject({
      ok: true,
    });
    expect(
      validateLlmOutput(preparedCall(), {
        result: plan([
          ...atTheCap,
          { kind: "assume-hypothesis", target, hypothesisId: "one-too-many", proposition: "p" },
        ]),
      }),
    ).toMatchObject({ ok: false });
    expect(validateLlmOutput(preparedCall(), { result: plan([]) })).toMatchObject({ ok: false });
  });

  it("rejects reused labels", () => {
    const validated = validateLlmOutput(preparedCall(), {
      result: plan([
        { kind: "assume-hypothesis", target, hypothesisId: "same", proposition: "p" },
        { kind: "assume-hypothesis", target, hypothesisId: "same", proposition: "q" },
      ]),
    });
    expect(validated).toMatchObject({ ok: false });
  });

  it("allows citing only results the context supplied", () => {
    const apply = {
      kind: "apply-result-backward",
      target,
      resultId: "result:swap",
      instantiation: [{ symbol: "x", term: "p" }],
      premiseTargetIds: [],
    };
    expect(validateLlmOutput(preparedCall(), { result: plan([apply]) })).toMatchObject({
      ok: false,
    });
    expect(
      validateLlmOutput(
        preparedCall({ results: [kernelResult("result:swap", ["Implies", "x", "x"])] }),
        { result: plan([apply]) },
      ),
    ).toMatchObject({ ok: true });
  });

  it("rejects a malformed or foreign output", () => {
    for (const output of [
      null,
      "plan",
      { result: { kind: "plan" } },
      { result: { kind: "none-relevant" } },
    ]) {
      expect(validateLlmOutput(preparedCall(), output)).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-output" }],
      });
    }
  });

  it("records a rejected, validated or failed call as schema-valid evidence", async () => {
    const call = preparedCall();
    const validated = await executePreparedLlmCall(call, async () => ({
      result: plan([wireIntroduce, closeByAssumption]),
    }));
    expect(validated.status).toBe("validated");
    expect(llmCallEvidenceSchema.safeParse(JSON.parse(JSON.stringify(validated))).success).toBe(
      true,
    );
    const rejected = await executePreparedLlmCall(call, async () => ({ result: plan([]) }));
    expect(rejected.status).toBe("rejected");
    expect(llmCallEvidenceSchema.safeParse(JSON.parse(JSON.stringify(rejected))).success).toBe(
      true,
    );
    // Evidence whose stored plan was tampered with no longer validates.
    const tampered = JSON.parse(JSON.stringify(validated)) as {
      output: { steps: { kind: string }[] };
    };
    tampered.output.steps[0]!.kind = "mark-sorry";
    expect(llmCallEvidenceSchema.safeParse(tampered).success).toBe(false);
  });
});

describe("move executor provider schema", () => {
  type JsonSchema = Record<string, unknown>;
  const schema = z.toJSONSchema(llmOutputSchemaForRole("move-executor")) as JsonSchema;

  /** The structured-output subset providers enforce: closed objects, all properties required. */
  function checkStrict(node: unknown, path: string, problems: string[], seen = new Set<unknown>()) {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    const record = node as JsonSchema;
    for (const keyword of ["oneOf", "allOf", "not", "if", "then", "else", "patternProperties"]) {
      if (keyword in record) problems.push(`${path}: unsupported keyword ${keyword}`);
    }
    if (record.type === "object" || "properties" in record) {
      const properties = Object.keys((record.properties as object | undefined) ?? {});
      if (record.additionalProperties !== false) problems.push(`${path}: open object`);
      const required = new Set((record.required as string[] | undefined) ?? []);
      for (const property of properties) {
        if (!required.has(property)) problems.push(`${path}.${property}: optional property`);
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (Array.isArray(value)) {
        value.forEach((item, index) =>
          checkStrict(item, `${path}.${key}[${index}]`, problems, seen),
        );
      } else {
        checkStrict(value, `${path}.${key}`, problems, seen);
      }
    }
  }

  it("is a closed, fully required object schema without unsupported keywords", () => {
    const problems: string[] = [];
    checkStrict(schema, "$", problems);
    expect(problems).toEqual([]);
    expect(schema.type).toBe("object");
  });

  it("bounds the plan length and writes MathJSON as a recursive definition", () => {
    const text = JSON.stringify(schema);
    expect(text).toContain(`"maxItems":${MAX_PLAN_STEPS}`);
    expect(text).toContain("$ref");
  });

  it("gives every fresh-ID field a label type and every reference a stable-identifier type", () => {
    const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/);
    expect(label.safeParse("case.even-1").success).toBe(true);
    expect(label.safeParse("a:b").success).toBe(false);
    expect(executorFreshIdFields("split-classical-cases")).toEqual([
      "childIds",
      "branchHypothesisIds",
    ]);
    expect(executorFreshIdFields("close-true")).toEqual([]);
    for (const kind of EXECUTOR_OPERATION_KINDS) {
      // Declared fresh fields exist on the wire shape of their kind.
      const stepSchema = z.toJSONSchema(llmOutputSchemaForRole("move-executor")) as JsonSchema;
      expect(JSON.stringify(stepSchema)).toContain(`"${kind}"`);
      for (const field of executorFreshIdFields(kind)) {
        expect(JSON.stringify(stepSchema)).toContain(`"${field}"`);
      }
    }
  });
});

describe("concrete operations", () => {
  const stateId = "state:current";
  const steps = [
    { ...introduceAntecedent, hypothesisId: "assume-p" },
    {
      kind: "apply-implication-hypothesis",
      target,
      implicationHypothesisId: "hypothesis:0",
      antecedentHypothesisId: "assume-p",
      resultHypothesisId: "derived-q",
    },
    { kind: "close-by-hypothesis", target, hypothesisId: "derived-q" },
  ];

  it("chains state IDs and namespaces labels by the call ID", () => {
    const operations = executorPlanOperations(steps, { stateId, callId });
    expect(operations).toEqual([
      {
        kind: "introduce-implication",
        target,
        hypothesisId: `${callId}:assume-p`,
        expectedStateId: stateId,
        resultStateId: `state:${callId}:1`,
      },
      {
        kind: "apply-implication-hypothesis",
        target,
        implicationHypothesisId: "hypothesis:0",
        antecedentHypothesisId: `${callId}:assume-p`,
        resultHypothesisId: `${callId}:derived-q`,
        expectedStateId: `state:${callId}:1`,
        resultStateId: `state:${callId}:2`,
      },
      {
        kind: "close-by-hypothesis",
        target,
        hypothesisId: `${callId}:derived-q`,
        expectedStateId: `state:${callId}:2`,
        resultStateId: `state:${callId}:3`,
      },
    ]);
  });

  it("leaves references to existing IDs exactly as written", () => {
    const operations = executorPlanOperations(
      [
        { kind: "drop-hypothesis", target, hypothesisId: "hypothesis:0" },
        { kind: "assume-hypothesis", target, hypothesisId: "later", proposition: "p" },
      ],
      { stateId, callId },
    );
    expect(operations[0]).toMatchObject({ hypothesisId: "hypothesis:0", target });
  });

  it("follows labels introduced as targets and as nested references", () => {
    const operations = executorPlanOperations(
      [
        { kind: "split-goal-conjunction", target, childIds: ["left", "right"] },
        { kind: "close-true", target: { kind: "goal", id: "left" } },
        {
          kind: "rewrite-with-implication",
          target: { kind: "goal", id: "right" },
          statement: { kind: "hypothesis", id: "left" },
          path: [],
          source: { kind: "hypothesis", hypothesisId: "left" },
        },
        {
          kind: "apply-result-forward",
          target,
          resultId: "result:r",
          instantiation: {},
          premiseHypothesisIds: ["left", null],
          resultHypothesisId: "derived",
          obligationIds: ["owed"],
        },
      ],
      { stateId, callId },
    );
    expect(operations[0]).toMatchObject({ childIds: [`${callId}:left`, `${callId}:right`] });
    expect(operations[1]).toMatchObject({ target: { kind: "goal", id: `${callId}:left` } });
    expect(operations[2]).toMatchObject({
      target: { kind: "goal", id: `${callId}:right` },
      statement: { kind: "hypothesis", id: `${callId}:left` },
      source: { kind: "hypothesis", hypothesisId: `${callId}:left` },
    });
    expect(operations[3]).toMatchObject({
      premiseHypothesisIds: [`${callId}:left`, null],
      resultHypothesisId: `${callId}:derived`,
      obligationIds: [`${callId}:owed`],
    });
  });

  it("produces operations the kernel accepts, chained through successive states", () => {
    const current = node();
    const operations = executorPlanOperations(steps, { stateId: current.state.id, callId });
    let state = current.state;
    for (const operation of operations) {
      const result = applyTransition(state, operation);
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      state = result.state;
    }
    expect(state.goals.map(({ id }) => id)).toEqual(["goal:elsewhere"]);
  });

  it("does not mutate the stored plan", () => {
    const before = JSON.stringify(steps);
    executorPlanOperations(steps, { stateId, callId });
    expect(JSON.stringify(steps)).toBe(before);
  });
});
