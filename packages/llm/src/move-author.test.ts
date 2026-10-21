import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateMoveTemplate, authoredMoveTemplateSchema } from "@proof/moves/authoring";
import { createProofNodeSchema, type ProofNode } from "@proof/protocol";
import {
  EXECUTOR_OPERATION_KINDS,
  MAX_PLAN_STEPS,
  MOVE_AUTHOR_SYSTEM_MESSAGE,
  buildMoveAuthorContext,
  DEFAULT_MOVE_AUTHOR_MAX_OUTPUT_TOKENS,
  DEFAULT_MOVE_AUTHOR_MODEL,
  DEFAULT_MOVE_AUTHOR_REASONING_EFFORT,
  buildMoveExecutorContext,
  compileMoveAuthorProposal,
  createVercelStructuredOutputTransport,
  describePrimitives,
  executePreparedLlmCall,
  llmCallEvidenceSchema,
  llmOutputSchemaForRole,
  prepareLlmCall,
  proposedMoveId,
  validateLlmOutput,
  type MoveAuthorContext,
  type MoveAuthorProposal,
  type PreparedLlmCall,
} from "./index";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const executorCallId = "llm-call:execute-contrapositive";
const authorCallId = "llm-call:author-contrapositive";
const target = { kind: "goal", id: "goal:main" } as const;

const declaration = (symbol: string, index: number) => ({
  id: `declaration:${index}`,
  symbol,
  sort: { kind: "proposition" },
  role: "universal-parameter",
});

/** The proof node the user was in: the goal, a used hypothesis, an unused one, and a second goal. */
function node(): ProofNode {
  return createProofNodeSchema().parse({
    id: "node:current",
    state: {
      id: "state:current",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: ["alpha", "beta", "gamma"].map(declaration),
              hypotheses: [
                { id: "hypothesis:0", statement: { expression: "alpha" } },
                { id: "hypothesis:unused", statement: { expression: "gamma" } },
              ],
            },
            conclusion: { expression: ["Implies", "alpha", "beta"] },
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

function executorContext(
  source: "user-instruction" | "shortlisted-technique" = "user-instruction",
) {
  const current = node();
  const built = buildMoveExecutorContext({
    id: executorCallId,
    node: current,
    instruction: "Prove the contrapositive instead.",
    source,
    target,
    selections: [
      {
        kind: "exact",
        anchor: { stateId: current.state.id, target, statement: { kind: "conclusion" } },
        path: [],
        fragment: ["Implies", "alpha", "beta"],
        declarations: [],
        position: { polarity: "positive", role: "proposition" },
      },
    ],
    operators: [],
    results: [],
  });
  if (!built.ok) throw new Error(built.diagnostics[0].message);
  return built.envelope.context;
}

const plan = {
  kind: "plan",
  steps: [
    {
      kind: "suffices",
      target,
      proposition: ["Implies", ["Not", "beta"], ["Not", "alpha"]],
      obligationId: "contra",
    },
  ],
  explanation: "Reduce to the contrapositive.",
};

function authorInput(overrides: Record<string, unknown> = {}) {
  return {
    id: authorCallId,
    executorCallId,
    executorContext: executorContext(),
    executorPlan: plan,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}): MoveAuthorContext {
  const built = buildMoveAuthorContext(authorInput(overrides));
  if (!built.ok) throw new Error(built.diagnostics[0].message);
  return built.envelope.context;
}

function preparedCall(overrides: Record<string, unknown> = {}): PreparedLlmCall {
  const built = buildMoveAuthorContext(authorInput(overrides));
  if (!built.ok) throw new Error(built.diagnostics[0].message);
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
  return prepared.call;
}

const contrapositive = (a: unknown, b: unknown) => ["Implies", ["Not", b], ["Not", a]];
const wireParameter = (overrides: Record<string, unknown>) => ({
  parameter: "proposition",
  kind: "proposition",
  index: null,
  direction: null,
  expression: null,
  resultId: null,
  hypothesis: null,
  ...overrides,
});
const conclusionSelection = () => ({
  slot: "target",
  statementKind: "conclusion",
  statementLabel: null,
  path: [],
});

/** The proposal a model could return for the contrapositive step, in the provider's wire form. */
function wireProposal(edit: (proposal: Json) => void = () => undefined) {
  const proposal: Json = {
    kind: "move-proposal",
    name: "Prove the contrapositive",
    description:
      "Reduce an implication goal to the implication between the negations of its parts.",
    motivation: "The user replaced the goal A implies B by its contrapositive.",
    classification: { kind: "macro", rationale: "One suffices step; no new result is needed." },
    transitionClass: "strengthening",
    contextRequirements: [],
    sideConditions: ["The selected statement is an implication."],
    requiredResultIds: [],
    metavariables: [
      { name: "A", sort: "proposition" },
      { name: "B", sort: "proposition" },
    ],
    patterns: [{ slot: "target", expression: ["Implies", "A", "B"] }],
    steps: [
      {
        id: "reduce",
        operation: "suffices",
        selections: [
          {
            slot: "target",
            target: "goal",
            statementKind: "conclusion",
            statementLabel: null,
            path: [],
            fragment: ["Implies", "A", "B"],
          },
        ],
        parameters: [wireParameter({ expression: contrapositive("A", "B") })],
      },
    ],
    examples: [
      {
        id: "source",
        description: "The step as the user took it.",
        outcome: "applied",
        situation: "source",
        state: null,
        selections: [conclusionSelection()],
        choices: [],
        expected: null,
      },
      {
        id: "compound",
        description: "Both parts are compound statements.",
        outcome: "applied",
        situation: "independent",
        state: {
          declarations: ["p", "q", "r"].map((symbol) => ({ symbol, sort: "proposition" })),
          hypotheses: [],
          conclusion: ["Implies", ["And", "p", "r"], ["Or", "q", "r"]],
        },
        selections: [conclusionSelection()],
        choices: [],
        expected: {
          transitionClass: "strengthening",
          goals: [contrapositive(["And", "p", "r"], ["Or", "q", "r"])],
          obligations: [
            [
              "Implies",
              contrapositive(["And", "p", "r"], ["Or", "q", "r"]),
              ["Implies", ["And", "p", "r"], ["Or", "q", "r"]],
            ],
          ],
        },
      },
      {
        id: "not-an-implication",
        description: "The goal is not an implication.",
        outcome: "rejected",
        situation: "independent",
        state: {
          declarations: [{ symbol: "p", sort: "proposition" }],
          hypotheses: [],
          conclusion: "p",
        },
        selections: [conclusionSelection()],
        choices: [],
        expected: null,
      },
    ],
  };
  edit(proposal);
  return proposal;
}

function validate(proposal: unknown) {
  return validateLlmOutput(preparedCall(), { result: proposal });
}

function accepted(proposal: unknown): MoveAuthorProposal {
  const validated = validate(proposal);
  if (!validated.ok) throw new Error(validated.diagnostics[0].message);
  return validated.output as MoveAuthorProposal;
}

describe("the move author's context", () => {
  it("shows the instruction and the abstracted situation, with neutral names and IDs", () => {
    const { situation, instruction } = context();
    expect(instruction).toBe("Prove the contrapositive instead.");
    expect(situation.targetKind).toBe("goal");
    expect(situation.before).toMatchObject({
      id: "goal:situation",
      conclusion: ["Implies", "P", "Q"],
      hypotheses: [],
    });
    expect(situation.before.declarations.map(({ symbol }) => symbol)).toEqual(["P", "Q"]);
    expect(situation.plan).toEqual([
      {
        kind: "suffices",
        target: { kind: "goal", id: "goal:situation" },
        proposition: ["Implies", ["Not", "Q"], ["Not", "P"]],
        obligationId: "contra",
      },
    ]);
    expect(situation.after.transitionClass).toBe("strengthening");
    expect(situation.after.goals.map(({ conclusion }) => conclusion)).toEqual([
      ["Implies", ["Not", "Q"], ["Not", "P"]],
    ]);
    expect(situation.after.obligations.map(({ conclusion }) => conclusion)).toEqual([
      ["Implies", ["Implies", ["Not", "Q"], ["Not", "P"]], ["Implies", "P", "Q"]],
    ]);
    expect(situation.selections).toEqual([
      {
        statement: { kind: "conclusion" },
        occurrence: { kind: "exact", path: [] },
        expression: ["Implies", "P", "Q"],
      },
    ]);
  });

  it("restricts the sequent to the hypotheses and declarations the step uses", () => {
    // Nothing in the step refers to either hypothesis, so none is shown.
    const { situation } = context();
    expect(situation.restricted).toBe(true);
    expect(situation.before.hypotheses).toEqual([]);
    expect(JSON.stringify(situation)).not.toContain("gamma");
    expect(situation.before.declarations.map(({ symbol }) => symbol)).toEqual(["P", "Q"]);

    // A step that uses one hypothesis shows that one, renamed, and the declarations it needs.
    const using = context({
      executorPlan: {
        kind: "plan",
        steps: [{ kind: "drop-hypothesis", target, hypothesisId: "hypothesis:unused" }],
        explanation: "Drop the hypothesis.",
      },
    });
    expect(using.situation.restricted).toBe(true);
    expect(using.situation.before.hypotheses).toEqual([{ id: "hypothesis:1", expression: "R" }]);
    expect(using.situation.before.declarations.map(({ symbol }) => symbol)).toEqual([
      "P",
      "Q",
      "R",
    ]);
    expect(using.situation.plan).toEqual([
      {
        kind: "drop-hypothesis",
        target: { kind: "goal", id: "goal:situation" },
        hypothesisId: "hypothesis:1",
      },
    ]);
    expect(JSON.stringify(using.situation)).not.toContain("hypothesis:0");
  });

  it("excludes the original problem, the history and every other goal (key and value absence)", () => {
    const envelope = JSON.stringify(
      (buildMoveAuthorContext(authorInput()) as { envelope: unknown }).envelope,
    );
    for (const original of ["alpha", "beta", "gamma", "remote-secret-symbol", "goal:elsewhere"]) {
      expect(envelope, original).not.toContain(original);
    }
    for (const key of [
      "problem",
      "title",
      "background",
      "history",
      "branches",
      "suggestions",
      "alternatives",
      "nodeId",
      "stateId",
      "sessionId",
      "goals",
    ]) {
      // `after.goals` is the outcome of the step; nothing else carries a goal list.
      const occurrences = envelope.split(`"${key}":`).length - 1;
      expect(occurrences, key).toBe(key === "goals" ? 1 : 0);
    }
    const built = buildMoveAuthorContext(authorInput());
    if (!built.ok) throw new Error("context");
    expect(Object.keys(built.envelope.context).sort()).toEqual([
      "executorCallId",
      "instruction",
      "limits",
      "operators",
      "primitives",
      "results",
      "situation",
    ]);
  });

  it("generates the primitives from the move catalog, without sorries or attestations", () => {
    const primitives = context().primitives;
    expect(primitives).toEqual(describePrimitives());
    expect(primitives.map(({ operationKind }) => operationKind).sort()).toEqual(
      [...EXECUTOR_OPERATION_KINDS].sort(),
    );
    const suffices = primitives.find(({ operationKind }) => operationKind === "suffices");
    expect(suffices).toMatchObject({
      moveId: "move:suffices",
      transitionClass: "strengthening",
      usable: true,
      slots: [{ id: "target", required: true }],
      createsIdentifiers: ["obligationId"],
    });
    expect(suffices?.parameters).toEqual([
      {
        id: "proposition",
        label: "Sufficient proposition",
        source: "menu",
        value: "proposition",
        origins: ["selection", "conclusion", "hypothesis", "subterm-of", "rule"],
      },
      { id: "obligationId", label: "Sufficiency obligation ID", source: "generated-id" },
    ]);
    expect(
      primitives.find(({ operationKind }) => operationKind === "split-hypothesis-disjunction")
        ?.createsIdentifiers,
    ).toEqual(["childIds", "branchHypothesisIds"]);
    expect(
      primitives.find(({ operationKind }) => operationKind === "close-by-assumption"),
    ).toMatchObject({ usable: false });
    expect(primitives.some(({ operationKind }) => operationKind === "mark-sorry")).toBe(false);
    // Every menu parameter says where its items come from, generated from the materializer's table.
    for (const primitive of primitives) {
      for (const parameter of primitive.parameters) {
        const isMenu = parameter.source === "menu" || parameter.source === "term-input";
        if (isMenu && primitive.usable) {
          expect(
            parameter.origins?.length,
            `${primitive.operationKind}.${parameter.id}`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("refuses a step that is not the user's own instruction, or a malformed stored call", () => {
    for (const overrides of [
      { executorContext: executorContext("shortlisted-technique") },
      { executorContext: { not: "a context" } },
      { executorPlan: { kind: "plan", steps: [] } },
      { extra: "field" },
    ]) {
      expect(buildMoveAuthorContext(authorInput(overrides))).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-request" }],
      });
    }
  });

  it("is deterministic", () => {
    expect(JSON.stringify(context())).toBe(JSON.stringify(context()));
  });
});

describe("a revision", () => {
  const revision = (proposal: unknown, extra: Record<string, unknown> = {}) => ({
    previousCallId: "llm-call:author-first",
    feedback: "  Also allow a conjunction as the antecedent.  ",
    previousProposal: proposal,
    previousFindings: [
      { code: "example-mismatch", message: "The goals differ.", exampleId: "compound" },
    ],
    ...extra,
  });

  it("carries the previous proposal, the trimmed feedback and the platform's findings", () => {
    const previous = accepted(wireProposal());
    const revised = context({ revision: revision(previous) });
    expect(revised.revision).toEqual({
      previousCallId: "llm-call:author-first",
      feedback: "Also allow a conjunction as the antecedent.",
      previousProposal: previous,
      previousFindings: [
        { code: "example-mismatch", message: "The goals differ.", exampleId: "compound" },
      ],
    });
    expect(context().revision).toBeUndefined();
  });

  it("validates the previous proposal like any proposal, so a forged one is refused", () => {
    const previous = accepted(wireProposal()) as unknown as Record<string, unknown>;
    for (const forged of [
      { ...previous, examples: (previous["examples"] as unknown[]).slice(1) },
      { ...previous, steps: [] },
      { ...previous, extra: true },
      "a proposal",
      null,
    ]) {
      expect(buildMoveAuthorContext(authorInput({ revision: revision(forged) }))).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-request" }],
      });
    }
    expect(
      buildMoveAuthorContext(authorInput({ revision: revision(previous, { feedback: "  " }) })),
    ).toMatchObject({ ok: false });
    expect(
      buildMoveAuthorContext(
        authorInput({ revision: revision(previous, { feedback: "x".repeat(4_001) }) }),
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("output validation", () => {
  it("accepts a complete proposal and normalizes it", () => {
    const proposal = accepted(wireProposal());
    expect(proposal).toMatchObject({
      kind: "move-proposal",
      transitionClass: "strengthening",
      classification: { kind: "macro" },
    });
    expect(proposal.steps[0]).toMatchObject({
      id: "reduce",
      operationKind: "suffices",
      selections: [{ slot: "target", statement: { kind: "conclusion" }, path: [] }],
      parameters: [{ parameter: "proposition", kind: "proposition" }],
    });
    expect(proposal.examples.map(({ id, source, outcome }) => [id, source, outcome])).toEqual([
      ["source", true, "applied"],
      ["compound", false, "applied"],
      ["not-an-implication", false, "rejected"],
    ]);
    // A source example carries neither a state nor an outcome: the platform supplies them.
    expect(proposal.examples[0]).not.toHaveProperty("state");
    expect(proposal.examples[0]).not.toHaveProperty("expected");
  });

  it("requires two positive examples, one of them the source situation, and a negative one", () => {
    const cases: [string, (proposal: Json) => void][] = [
      ["a single positive example", (proposal) => proposal["examples"].splice(1, 1)],
      [
        "no source situation",
        (proposal) => {
          proposal["examples"][0].situation = "independent";
          proposal["examples"][0].state = proposal["examples"][1].state;
          proposal["examples"][0].expected = proposal["examples"][1].expected;
        },
      ],
      [
        "two source situations",
        (proposal) => {
          proposal["examples"][1].situation = "source";
          proposal["examples"][1].state = null;
          proposal["examples"][1].expected = null;
        },
      ],
      [
        "no negative example",
        (proposal) => {
          proposal["examples"][2].outcome = "applied";
          proposal["examples"][2].expected = proposal["examples"][1].expected;
        },
      ],
      [
        "a source situation that states its own state",
        (proposal) => {
          proposal["examples"][0].state = proposal["examples"][2].state;
        },
      ],
      [
        "a positive example without an expected outcome",
        (proposal) => {
          proposal["examples"][1].expected = null;
        },
      ],
      [
        "a negative example that states an outcome",
        (proposal) => {
          proposal["examples"][2].expected = proposal["examples"][1].expected;
        },
      ],
      [
        "a repeated example ID",
        (proposal) => {
          proposal["examples"][2].id = "source";
        },
      ],
    ];
    for (const [label, edit] of cases) {
      expect(validate(wireProposal(edit)), label).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-output" }],
      });
    }
  });

  it("rejects a proposal that disagrees with its context", () => {
    const cases: [string, (proposal: Json) => void][] = [
      ["an unknown operation", (proposal) => (proposal["steps"][0].operation = "prove-everything")],
      ["a sorry", (proposal) => (proposal["steps"][0].operation = "mark-sorry")],
      [
        "a slot the primitive does not have",
        (proposal) => (proposal["steps"][0].selections[0].slot = "occurrence"),
      ],
      ["a pattern on a foreign slot", (proposal) => (proposal["patterns"][0].slot = "fact")],
      [
        "a required result that was not supplied",
        (proposal) => (proposal["requiredResultIds"] = ["result:invented"]),
      ],
      [
        "a metavariable that is a built-in",
        (proposal) => (proposal["metavariables"][0].name = "Implies"),
      ],
      [
        "a parameter in the wrong form",
        (proposal) => {
          proposal["steps"][0].parameters = [wireParameter({ kind: "index", index: 0 })];
        },
      ],
      [
        "a first step that fixes a menu choice",
        (proposal) => {
          proposal["steps"][0].operation = "choose-goal-disjunct";
          proposal["steps"][0].parameters = [
            wireParameter({ parameter: "disjunctIndex", kind: "index", index: 0 }),
          ];
        },
      ],
      [
        "an example slot of another primitive",
        (proposal) => {
          proposal["examples"][1].selections[0].slot = "fact";
        },
      ],
      [
        "a later step without selections",
        (proposal) => {
          proposal["steps"].push({
            id: "second",
            operation: "close-true",
            selections: [],
            parameters: [],
          });
        },
      ],
    ];
    for (const [label, edit] of cases) {
      expect(validate(wireProposal(edit)), label).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-output" }],
      });
    }
  });

  it("bounds the plan by MAX_PLAN_STEPS", () => {
    const steps = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_unused, index) => ({
      id: `step-${index}`,
      operation: "close-true",
      selections: [
        {
          slot: "target",
          target: "goal",
          statementKind: "conclusion",
          statementLabel: null,
          path: [],
          fragment: "True",
        },
      ],
      parameters: [],
    }));
    expect(validate(wireProposal((proposal) => (proposal["steps"] = steps)))).toMatchObject({
      ok: false,
    });
  });

  it("rejects fields outside the wire schema and malformed output", () => {
    expect(validate(wireProposal((proposal) => (proposal["extra"] = 1)))).toMatchObject({
      ok: false,
    });
    for (const output of [null, "move", { result: { kind: "move-proposal" } }, { kind: "plan" }]) {
      expect(validateLlmOutput(preparedCall(), output)).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-output" }],
      });
    }
  });

  it("allows a context request and a refusal", () => {
    expect(
      validate({
        kind: "insufficient-context",
        requestedCategories: ["situation-detail"],
        rationale: "The step uses a hypothesis I cannot see.",
      }),
    ).toMatchObject({ ok: true, output: { kind: "insufficient-context" } });
    expect(
      validate({ kind: "declined", reason: "No general move is behind this step." }),
    ).toMatchObject({
      ok: true,
      output: { kind: "declined" },
    });
  });

  it("stores schema-valid evidence for a proposal, a rejection and a failure", async () => {
    const call = preparedCall();
    const validated = await executePreparedLlmCall(call, async () => ({ result: wireProposal() }));
    expect(validated.diagnostics).toEqual([]);
    expect(validated.status).toBe("validated");
    expect(llmCallEvidenceSchema.safeParse(JSON.parse(JSON.stringify(validated))).success).toBe(
      true,
    );
    const rejected = await executePreparedLlmCall(call, async () => ({
      result: wireProposal((proposal) => proposal["examples"].splice(1, 1)),
    }));
    expect(rejected.status).toBe("rejected");
    expect(llmCallEvidenceSchema.safeParse(JSON.parse(JSON.stringify(rejected))).success).toBe(
      true,
    );
    const failed = await executePreparedLlmCall(call, async () => {
      throw new Error("down");
    });
    expect(failed.status).toBe("transport-failed");
    // Evidence whose stored proposal was tampered with no longer validates.
    const tampered = JSON.parse(JSON.stringify(validated)) as { output: { examples: unknown[] } };
    tampered.output.examples = tampered.output.examples.slice(1);
    expect(llmCallEvidenceSchema.safeParse(tampered).success).toBe(false);
  });

  it("has a system message the role's calls carry", () => {
    expect(preparedCall().messages[0].content).toBe(MOVE_AUTHOR_SYSTEM_MESSAGE);
    expect(MOVE_AUTHOR_SYSTEM_MESSAGE).toContain("Never write a symbol of the situation");
  });
});

describe("the move author's provider schema", () => {
  type JsonSchema = Record<string, unknown>;
  const schema = z.toJSONSchema(llmOutputSchemaForRole("move-author")) as JsonSchema;

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

  it("is sent with the move author's defaults, and its wire proposal validates", async () => {
    expect(DEFAULT_MOVE_AUTHOR_MODEL).toBe("openai/gpt-6-luna");
    expect(DEFAULT_MOVE_AUTHOR_REASONING_EFFORT).toBe("high");
    expect(DEFAULT_MOVE_AUTHOR_MAX_OUTPUT_TOKENS).toBe(32_000);
    const call = preparedCall();
    let requestBody: Record<string, unknown> | undefined;
    const wire = { result: wireProposal() };
    const transport = createVercelStructuredOutputTransport({
      apiKey: "test-key",
      model: DEFAULT_MOVE_AUTHOR_MODEL,
      reasoningEffort: DEFAULT_MOVE_AUTHOR_REASONING_EFFORT,
      maxOutputTokens: DEFAULT_MOVE_AUTHOR_MAX_OUTPUT_TOKENS,
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(wire) } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const output = await transport(call);
    expect(requestBody).toMatchObject({
      model: "openai/gpt-6-luna",
      max_completion_tokens: 32_000,
      reasoning_effort: "high",
      response_format: {
        type: "json_schema",
        json_schema: { strict: true, name: "proof_move_author_output" },
      },
    });
    expect(output).toEqual(wire);
    expect(validateLlmOutput(call, output)).toMatchObject({
      ok: true,
      output: { kind: "move-proposal", name: "Prove the contrapositive" },
    });
  });

  it("names every primitive's kind only through the context, not as an open enum", () => {
    const text = JSON.stringify(schema);
    expect(text).toContain("move-proposal");
    expect(text).not.toContain("mark-sorry");
    expect(text).toContain(`"maxItems":${MAX_PLAN_STEPS}`);
    expect(text).toContain("$ref");
  });
});

describe("compiling a proposal into the authored-move language", () => {
  const compileOf = (proposal: MoveAuthorProposal, withExamples = true) =>
    compileMoveAuthorProposal({ proposal, context: context(), withExamples });

  it("derives a readable, stable move ID from the name and the executed step", () => {
    const id = proposedMoveId("Prove the contrapositive", executorCallId);
    expect(id).toMatch(/^authored:prove-the-contrapositive-[0-9a-f]{8}$/);
    expect(proposedMoveId("Prove the contrapositive", executorCallId)).toBe(id);
    expect(proposedMoveId("Prove the contrapositive", "llm-call:other")).not.toBe(id);
    expect(proposedMoveId("???", executorCallId)).toMatch(/^authored:move-/);
  });

  it("makes a template of the existing schema in which the first step constructs its proposition", () => {
    const template = authoredMoveTemplateSchema.parse(compileOf(accepted(wireProposal())));
    expect(template.selectionContract.slots.map(({ id }) => id)).toEqual(["target"]);
    expect(template.patterns).toEqual([
      { id: "pattern:target", selectionSlotId: "target", expression: ["Implies", "A", "B"] },
    ]);
    // The construction is not asked of the user; the sufficiency obligation's ID is generated.
    expect(template.parameters.map(({ id }) => id)).toEqual(["obligationId"]);
    expect(template.plan.steps[0]?.parameters?.[0]).toMatchObject({
      parameterId: "proposition",
      origin: { kind: "rule" },
      value: { kind: "proposition", expression: contrapositive("A", "B") },
    });
    expect(template.discoveryContext).toBe(
      "The user replaced the goal A implies B by its contrapositive.",
    );
    expect(template.examples.map(({ id }) => id)).toEqual([
      "example:source",
      "example:compound",
      "example:not-an-implication",
    ]);
  });

  it("uses the platform's own abstracted before and after for the source situation", () => {
    const template = authoredMoveTemplateSchema.parse(compileOf(accepted(wireProposal())));
    const source = template.examples[0];
    expect(source?.expected).toEqual({
      outcome: "applied",
      transitionClass: "strengthening",
      goals: [["Implies", ["Not", "Q"], ["Not", "P"]]],
      obligations: [["Implies", ["Implies", ["Not", "Q"], ["Not", "P"]], ["Implies", "P", "Q"]]],
    });
    expect(JSON.stringify(source?.state)).toContain('"expression":["Implies","P","Q"]');
  });

  it("passes the same validation as a hand-authored template, running every example", () => {
    const validation = validateMoveTemplate(compileOf(accepted(wireProposal())), { operators: [] });
    expect(validation.ok, JSON.stringify(validation)).toBe(true);
    if (!validation.ok) return;
    expect(validation.report).toMatchObject({
      transitionClass: "strengthening",
      stepCount: 1,
      retrievable: true,
    });
    expect(validation.report.examples.map(({ outcome }) => outcome)).toEqual([
      "applied",
      "applied",
      "rejected",
    ]);
  });

  it("reports an independent example whose stated outcome the kernel does not produce", () => {
    const proposal = accepted(
      wireProposal((wire) => {
        wire["examples"][1].expected.goals = [["Implies", "p", "q"]];
      }),
    );
    const validation = validateMoveTemplate(compileOf(proposal), { operators: [] });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.diagnostics[0]).toMatchObject({
      code: "example-mismatch",
      exampleId: "example:compound",
    });
  });

  it("flags a symbol of the original situation kept in the move, instead of a metavariable", () => {
    // The model wrote the situation's own Q where the metavariable B belongs.
    const proposal = accepted(
      wireProposal((wire) => {
        wire["steps"][0].parameters = [
          wireParameter({ expression: ["Implies", ["Not", "Q"], ["Not", "A"]] }),
        ];
      }),
    );
    const validation = validateMoveTemplate(compileOf(proposal), { operators: [] });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.diagnostics.map(({ code }) => code)).toContain("problem-specific-symbol");
  });

  it("flags a fragment that uses a symbol it did not declare as a metavariable", () => {
    const proposal = accepted(
      wireProposal((wire) => {
        wire["metavariables"] = [{ name: "A", sort: "proposition" }];
      }),
    );
    const validation = validateMoveTemplate(compileOf(proposal), { operators: [] });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.diagnostics.map(({ code }) => code)).toContain("problem-specific-symbol");
  });

  it("compiles to a structural template without examples for the output check", () => {
    const template = compileOf(accepted(wireProposal()), false);
    expect(template["examples"]).toEqual([]);
    expect(authoredMoveTemplateSchema.safeParse(template).success).toBe(true);
  });
});
