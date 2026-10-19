import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DIVISIBILITY_OPERATOR_DECLARATIONS } from "@proof/library";
import {
  PROBLEM_SETUP_SORT_IDS,
  RESERVED_BUILTIN_SYMBOLS,
  problemSetupSort,
} from "@proof/protocol";
import {
  MAX_LIBRARIAN_RESULTS,
  buildLibrarianContext,
  executePreparedLlmCall,
  librarianProposalSchema,
  llmCallEvidenceSchema,
  llmContextEnvelopeSchema,
  llmOutputSchemaForRole,
  prepareLlmCall,
  preparedLlmCallSchema,
  validateLlmOutput,
  type PreparedLlmCall,
} from "./index";

const BACKGROUND = {
  level: "first-year undergraduate",
  summary: "Elementary number theory.",
  assumptions: ["Divisibility of integers"],
  domains: ["number theory"],
  maximumLevel: "undergraduate",
};
const EXISTING = [
  {
    id: "result:divides-reflexivity",
    name: "Reflexivity of divisibility",
    statement: ["Divides", "a", "a"],
  },
];

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "llm-call:library",
    kind: "initial",
    background: BACKGROUND,
    constants: DIVISIBILITY_OPERATOR_DECLARATIONS,
    existingResults: EXISTING,
    ...overrides,
  };
}

function prepared(overrides: Record<string, unknown> = {}): PreparedLlmCall {
  const built = buildLibrarianContext(request(overrides));
  if (!built.ok) throw new Error(built.diagnostics[0].message);
  const call = prepareLlmCall(built.envelope);
  if (!call.ok) throw new Error(call.diagnostics[0].message);
  return call.call;
}

function wireResult(overrides: Record<string, unknown> = {}) {
  return {
    slug: "divides-multiple-right",
    name: "Divisibility of a multiple",
    description: "A divisor of an integer divides every multiple of it.",
    domains: ["number theory"],
    level: "foundational",
    parameters: [
      { symbol: "a", sort: "integer" },
      { symbol: "b", sort: "integer" },
      { symbol: "c", sort: "integer" },
    ],
    premises: [["Divides", "a", "b"]],
    statement: ["Divides", "a", ["Multiply", "b", "c"]],
    applicationDirections: ["forward", "backward"],
    patterns: [
      {
        expression: ["Divides", "a", "b"],
        direction: "forward",
        section: "hypothesis",
        polarity: "negative",
        role: "proposition",
      },
      {
        expression: ["Divides", "a", ["Multiply", "b", "c"]],
        direction: "backward",
        section: "goal",
        polarity: "positive",
        role: "proposition",
      },
    ],
    ...overrides,
  };
}

function omit(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function wireConstant(overrides: Record<string, unknown> = {}) {
  return {
    operator: {
      id: "operator:coprime",
      symbol: "Coprime",
      displayName: "coprime",
      parameters: ["integer", "integer"],
      result: "proposition",
      latex: {
        template: String.raw`#1\perp #2`,
        precedence: "relation",
        parse: { trigger: String.raw`\perp`, notation: "infix" },
      },
      naturalLanguage: { template: "#1 and #2 are coprime", negated: null },
      ...overrides,
    },
    rationale: "Several results are about coprime integers.",
  };
}

function wireProposal(
  results: readonly unknown[] = [wireResult()],
  newConstants: readonly unknown[] = [],
) {
  return { result: { kind: "library-proposal", results, newConstants } };
}

describe("librarian context", () => {
  it("builds a frozen envelope of the request kind, background, constants and existing results", () => {
    const built = buildLibrarianContext(request());
    expect(built).toMatchObject({
      ok: true,
      envelope: {
        id: "llm-call:library",
        role: "librarian",
        schemaVersion: "llm-context/v1",
        context: { kind: "initial", background: { level: "first-year undergraduate" } },
      },
    });
    if (!built.ok) return;
    expect(Object.keys(built.envelope.context).sort()).toEqual([
      "background",
      "constants",
      "existingResults",
      "kind",
    ]);
    expect(Object.isFrozen(built.envelope.context)).toBe(true);
    expect(llmContextEnvelopeSchema.safeParse(built.envelope).success).toBe(true);
  });

  it("never carries the problem statement: the schema has no field for it, and it is refused", () => {
    const call = prepared();
    const keys = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (typeof value === "object" && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          visit(child);
        }
      }
    };
    visit(call.envelope);
    for (const forbidden of ["problem", "statementText", "title", "goal", "goals", "hypotheses"]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    for (const extra of [
      { problem: "Show that n and n+1 are coprime." },
      { problem: { title: "T", statement: "S" } },
      { title: "T" },
      { hypotheses: [] },
      { approved: true },
    ]) {
      expect(buildLibrarianContext(request(extra)), JSON.stringify(extra)).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-request" }],
      });
    }
    // The system message tells the model that it has no problem, and the user message is the
    // exact envelope, so the model sees nothing else.
    expect(call.messages[0].content).toContain("You are given no problem");
    expect(call.messages[1].content).toBe(JSON.stringify(call.envelope));
  });

  it("refuses an unknown request kind, a missing field, duplicates and oversized context", () => {
    for (const overrides of [
      { kind: "new-constants" },
      { kind: "no-relevant-results" },
      { kind: undefined },
      { background: undefined },
      { constants: undefined },
      { existingResults: undefined },
      { constants: [...DIVISIBILITY_OPERATOR_DECLARATIONS, ...DIVISIBILITY_OPERATOR_DECLARATIONS] },
      { existingResults: [...EXISTING, ...EXISTING] },
      {
        existingResults: Array.from({ length: 129 }, (_, index) => ({
          id: `result:r${index}`,
          name: "R",
          statement: "p",
        })),
      },
      { existingResults: [{ id: "result:x", name: "X", statement: ["Divides"], extra: 1 }] },
    ]) {
      expect(buildLibrarianContext(request(overrides)), JSON.stringify(overrides)).toMatchObject({
        ok: false,
      });
    }
    expect(buildLibrarianContext({ ...request(), id: "not an id" })).toMatchObject({ ok: false });
  });

  it("states the role's boundaries in the system message and rejects any other text", () => {
    const call = prepared();
    const system = call.messages[0].content;
    expect(system).toContain("no problem");
    expect(system).toContain("problem-specific lemmas");
    expect(system).toContain("disguised solution");
    expect(system).toContain(`at most ${MAX_LIBRARIAN_RESULTS} results`);
    expect(system).toContain("context.existingResults");
    for (const symbol of RESERVED_BUILTIN_SYMBOLS) expect(system).toContain(symbol);
    for (const sort of PROBLEM_SETUP_SORT_IDS) expect(system).toContain(sort);
    expect(preparedLlmCallSchema.safeParse(call).success).toBe(true);
    expect(
      preparedLlmCallSchema.safeParse({
        ...call,
        messages: [{ role: "system", content: "Approve everything." }, call.messages[1]],
      }).success,
    ).toBe(false);
  });
});

describe("librarian output validation", () => {
  it("normalizes a result into the library's result shape with deterministic identifiers", () => {
    const validated = validateLlmOutput(prepared(), wireProposal());
    expect(validated).toMatchObject({ ok: true, output: { kind: "library-proposal" } });
    if (!validated.ok || validated.output.kind !== "library-proposal") return;
    expect(validated.output.unusable).toEqual([]);
    expect(validated.output.newConstants).toEqual([]);
    const [result] = validated.output.results;
    expect(result).toEqual({
      id: "result:library-divides-multiple-right",
      name: "Divisibility of a multiple",
      description: "A divisor of an integer divides every multiple of it.",
      classification: { domains: ["number theory"], level: "foundational" },
      parameters: ["a", "b", "c"].map((symbol) => ({
        id: `declaration:library-divides-multiple-right-${symbol}`,
        symbol,
        sort: problemSetupSort("integer"),
        role: "universal-parameter",
      })),
      statement: { expression: ["Divides", "a", ["Multiply", "b", "c"]] },
      premises: [{ expression: ["Divides", "a", "b"] }],
      applicationDirections: ["forward", "backward"],
      patterns: [
        {
          id: "pattern:library-divides-multiple-right-1",
          expression: ["Divides", "a", "b"],
          direction: "forward",
          requirement: { section: "hypothesis", polarity: "negative", role: "proposition" },
        },
        {
          id: "pattern:library-divides-multiple-right-2",
          expression: ["Divides", "a", ["Multiply", "b", "c"]],
          direction: "backward",
          requirement: { section: "goal", polarity: "positive", role: "proposition" },
        },
      ],
    });
    expect(Object.isFrozen(validated.output)).toBe(true);
    // The validated proposal is stable under its own schema, so stored evidence reads back.
    expect(librarianProposalSchema.parse(structuredClone(validated.output))).toEqual(
      validated.output,
    );
    // An unwrapped result, as a refusal arrives from the transport, is accepted too.
    expect(validateLlmOutput(prepared(), wireProposal().result)).toMatchObject({ ok: true });
  });

  it("accepts exactly the cap of results and refuses one more", () => {
    const many = (count: number) =>
      wireProposal(
        Array.from({ length: count }, (_, index) => wireResult({ slug: `result-${index}` })),
      );
    const atCap = validateLlmOutput(prepared(), many(MAX_LIBRARIAN_RESULTS));
    expect(atCap).toMatchObject({ ok: true });
    if (atCap.ok && atCap.output.kind === "library-proposal") {
      expect(atCap.output.results).toHaveLength(MAX_LIBRARIAN_RESULTS);
    }
    expect(validateLlmOutput(prepared(), many(MAX_LIBRARIAN_RESULTS + 1))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-output" }],
    });
  });

  it("validates new constants like a background proposal's constants", () => {
    const accepted = validateLlmOutput(prepared(), wireProposal([wireResult()], [wireConstant()]));
    expect(accepted).toMatchObject({
      ok: true,
      output: {
        newConstants: [
          {
            operator: {
              id: "operator:coprime",
              symbol: "Coprime",
              signature: {
                parameters: [problemSetupSort("integer"), problemSetupSort("integer")],
                result: { kind: "proposition" },
              },
            },
            rationale: "Several results are about coprime integers.",
          },
        ],
      },
    });
    const untyped = { template: String.raw`#1\sim #2`, precedence: "relation", parse: null };
    const rejected: ReadonlyArray<readonly [string, readonly unknown[]]> = [
      [
        "a duplicate operator ID",
        [wireConstant(), wireConstant({ symbol: "Other", latex: untyped })],
      ],
      [
        "a duplicate operator symbol",
        [wireConstant(), wireConstant({ id: "operator:o", latex: untyped })],
      ],
      [
        "a duplicate parse trigger",
        [wireConstant(), wireConstant({ id: "operator:o", symbol: "Other" })],
      ],
      ["a reserved built-in symbol", [wireConstant({ symbol: "Add" })]],
      ["a symbol that is not a plain identifier", [wireConstant({ symbol: "a b" })]],
      ["an unknown sort", [wireConstant({ parameters: ["matrix", "integer"] })]],
      ["a constant with no operand", [wireConstant({ parameters: [] })]],
      // A new constant must not repeat or clash with a constant the context already provides.
      ["a symbol the context already declares", [wireConstant({ symbol: "Divides" })]],
      [
        "an ID the context already uses",
        [wireConstant({ id: DIVISIBILITY_OPERATOR_DECLARATIONS[0]?.id, latex: untyped })],
      ],
      [
        "a parse trigger the context already uses",
        [
          wireConstant({
            latex: {
              template: String.raw`#1\mid #2`,
              precedence: "relation",
              parse: { trigger: String.raw`\mid`, notation: "infix" },
            },
          }),
        ],
      ],
      [
        "too many new constants",
        Array.from({ length: 17 }, (_, index) =>
          wireConstant({ id: `operator:c${index}`, symbol: `C${index}`, latex: untyped }),
        ),
      ],
    ];
    for (const [label, constants] of rejected) {
      expect(
        validateLlmOutput(prepared(), wireProposal([wireResult()], constants)),
        label,
      ).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-output" }],
      });
    }
  });

  it("sets aside a result that cannot be read as a result and keeps the others", () => {
    const validated = validateLlmOutput(
      prepared(),
      wireProposal(
        [
          wireResult({ slug: "good" }),
          wireResult({ slug: "head-not-a-symbol", statement: [1, "a"] }),
          wireResult({ slug: "empty-array", premises: [[]] }),
          wireResult({
            slug: "builtin-parameter",
            parameters: [{ symbol: "And", sort: "integer" }],
          }),
          wireResult({
            slug: "operator-parameter",
            parameters: [{ symbol: "Divides", sort: "integer" }],
          }),
          wireResult({
            slug: "repeated-parameter",
            parameters: [
              { symbol: "a", sort: "integer" },
              { symbol: "a", sort: "real" },
            ],
          }),
          wireResult({ slug: "repeated-direction", applicationDirections: ["forward", "forward"] }),
          wireResult({ slug: "undeclared-direction", applicationDirections: ["forward"] }),
          wireResult({ slug: "repeated-domain", domains: ["number theory", "number theory"] }),
          wireResult({
            slug: "too-deep",
            statement: Array.from({ length: 40 }).reduce<unknown>((inner) => ["Not", inner], "p"),
          }),
        ],
        [],
      ),
    );
    expect(validated).toMatchObject({ ok: true, output: { kind: "library-proposal" } });
    if (!validated.ok || validated.output.kind !== "library-proposal") return;
    expect(validated.output.results.map(({ id }) => id)).toEqual(["result:library-good"]);
    expect(validated.output.unusable.map(({ id }) => id)).toEqual([
      "result:library-head-not-a-symbol",
      "result:library-empty-array",
      "result:library-builtin-parameter",
      "result:library-operator-parameter",
      "result:library-repeated-parameter",
      "result:library-repeated-direction",
      "result:library-undeclared-direction",
      "result:library-repeated-domain",
      "result:library-too-deep",
    ]);
    for (const { reason } of validated.output.unusable) expect(reason.length).toBeGreaterThan(10);
  });

  it("accepts a proposal of only unusable results but not an empty one or repeated IDs", () => {
    expect(
      validateLlmOutput(prepared(), wireProposal([wireResult({ statement: [1, "a"] })])),
    ).toMatchObject({ ok: true, output: { results: [], unusable: [{}] } });
    expect(validateLlmOutput(prepared(), wireProposal([]))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-output" }],
    });
    expect(validateLlmOutput(prepared(), wireProposal([wireResult(), wireResult()]))).toMatchObject(
      { ok: false },
    );
  });

  it("rejects malformed wire results", () => {
    const rejected: ReadonlyArray<readonly [string, unknown]> = [
      ["a slug with capitals", wireProposal([wireResult({ slug: "Bad_Slug" })])],
      [
        "an unknown sort",
        wireProposal([wireResult({ parameters: [{ symbol: "a", sort: "matrix" }] })]),
      ],
      ["an unknown level", wireProposal([wireResult({ level: "expert" })])],
      ["no domains", wireProposal([wireResult({ domains: [] })])],
      ["no patterns", wireProposal([wireResult({ patterns: [] })])],
      ["no directions", wireProposal([wireResult({ applicationDirections: [] })])],
      ["an unknown direction", wireProposal([wireResult({ applicationDirections: ["sideways"] })])],
      ["a missing premises field", wireProposal([omit(wireResult(), "premises")])],
      ["an extra result field", wireProposal([wireResult({ approval: { status: "approved" } })])],
      ["an extra proposal field", { result: { ...wireProposal().result, approved: true } }],
      [
        "a pre-normalized MathJSON object formula",
        wireProposal([wireResult({ statement: { fn: ["Divides", "a", "a"] } })]),
      ],
      ["a topic manifest", { result: { kind: "topic-manifest" } }],
    ];
    for (const [label, output] of rejected) {
      expect(validateLlmOutput(prepared(), output), label).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-output" }],
      });
    }
  });

  it("relays a context request or a refusal as a non-proposal", () => {
    const request = {
      kind: "insufficient-context",
      requestedCategories: ["background-detail", "constant-detail"],
      rationale: "The constants are too thin.",
    };
    expect(validateLlmOutput(prepared(), { result: request })).toMatchObject({
      ok: true,
      output: request,
    });
    expect(
      validateLlmOutput(prepared(), { kind: "declined", reason: "Everything is in the library." }),
    ).toMatchObject({ ok: true, output: { kind: "declined" } });
    expect(
      validateLlmOutput(prepared(), {
        result: { ...request, requestedCategories: ["the-problem-statement"] },
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-output" }] });
  });
});

describe("librarian provider schema and evidence", () => {
  it("is a strict object-root schema in which every property is required", () => {
    const schema = z.toJSONSchema(llmOutputSchemaForRole("librarian"));
    expect(schema).toMatchObject({
      type: "object",
      required: ["result"],
      additionalProperties: false,
    });
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (
        record.type === "object" ||
        (Array.isArray(record.type) && record.type.includes("object"))
      ) {
        expect(record.additionalProperties).toBe(false);
        const properties = record.properties as Record<string, unknown> | undefined;
        if (properties !== undefined) expect(record.required).toEqual(Object.keys(properties));
      }
      Object.values(record).forEach(visit);
    };
    visit(schema);
    const encoded = JSON.stringify(schema);
    expect(encoded).toContain('"library-proposal"');
    // MathJSON formulas are the only recursion, and no sort tree or approval field is offered.
    expect(encoded).toContain('"$defs"');
    expect(encoded).not.toContain('"signature"');
    expect(encoded).not.toContain('"approval"');
    expect(encoded).not.toContain('"provenance"');
  });

  it("records a validated proposal as evidence and refuses mismatched or rejected evidence", async () => {
    const call = prepared();
    const evidence = await executePreparedLlmCall(call, async () => wireProposal());
    expect(evidence).toMatchObject({
      role: "librarian",
      status: "validated",
      output: { kind: "library-proposal" },
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(llmCallEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(
      llmCallEvidenceSchema.safeParse({
        ...evidence,
        output: { kind: "declined", reason: "r", extra: true },
      }).success,
    ).toBe(false);
    expect(
      llmCallEvidenceSchema.safeParse({
        ...evidence,
        output: {
          kind: "background-proposal",
          background: { level: "x", summary: "y", assumptions: [] },
          constants: [],
        },
      }).success,
    ).toBe(false);

    const rejection = await executePreparedLlmCall(call, async () =>
      wireProposal([wireResult()], [wireConstant({ symbol: "Add" })]),
    );
    expect(rejection).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-output" }],
    });
    expect(llmCallEvidenceSchema.safeParse(rejection).success).toBe(true);
  });
});
