import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PROPOSITION_SORT,
  binderSpecificationSchema,
  createExecutableProofStateSchema,
  createStatementViewSchema,
  declarationSchema,
  executableProofStateSchema,
  operatorDeclarationSchema,
  operatorDeclarationsSchema,
  operatorTemplateSegments,
  parseStatementView,
  proofContextSchema,
  proofStateSchema,
  retrievalWildcardSchema,
  signatureEquals,
  signatureSchema,
  sortEquals,
  sortSchema,
  statementViewSchema,
  symbolSpecificationSchema,
} from "./index";

const realSort = { kind: "named", id: "sort:real" } as const;
const naturalSort = { kind: "named", id: "sort:natural" } as const;

function universal(id: string, symbol: string, sort: unknown = realSort) {
  return declarationSchema.parse({ id, symbol, sort, role: "universal-parameter" });
}

function witness(id: string, symbol: string, sort: unknown = realSort) {
  return declarationSchema.parse({ id, symbol, sort, role: "local-witness" });
}

function statement(expression: unknown) {
  return { expression };
}

describe("sort and declaration schemas", () => {
  it("validates recursive higher-order signatures without conflating propositions and terms", () => {
    const predicateSortInput = {
      kind: "function",
      signature: { parameters: [realSort], result: PROPOSITION_SORT },
    } as const;
    const predicateSort = sortSchema.parse(predicateSortInput);
    const functionalSignature = signatureSchema.parse({
      parameters: [predicateSort, naturalSort],
      result: realSort,
    });

    expect(sortEquals(predicateSort, { ...predicateSort })).toBe(true);
    expect(sortEquals(predicateSort, sortSchema.parse(realSort))).toBe(false);
    expect(signatureEquals(functionalSignature, { ...functionalSignature })).toBe(true);
    expect(sortSchema.safeParse({ ...realSort, displayName: "the reals" }).success).toBe(false);
  });

  it("uses stable declaration IDs and keeps retrieval wildcards out of proof contexts", () => {
    const parameter = universal("decl:x", "x");
    const localWitness = witness("decl:w", "w");
    const wildcard = {
      id: "wildcard:any-real",
      symbol: "_a",
      role: "retrieval-wildcard",
      sort: realSort,
    } as const;

    expect(declarationSchema.safeParse(parameter).success).toBe(true);
    expect(declarationSchema.safeParse(localWitness).success).toBe(true);
    expect(retrievalWildcardSchema.safeParse(wildcard).success).toBe(true);
    expect(symbolSpecificationSchema.safeParse(wildcard).success).toBe(true);
    expect(declarationSchema.safeParse(wildcard).success).toBe(false);
    expect(
      declarationSchema.safeParse({ ...parameter, id: "derived from an array index" }).success,
    ).toBe(false);
  });
});

describe("binder and statement-view contracts", () => {
  it("returns a proposition view over the exact uncanonicalized MathJSON", () => {
    const expression = ["Equal", ["Add", "x", 1], ["Add", 1, "x"]] as const;
    const view = parseStatementView(expression, {
      declarations: [universal("decl:x", "x")],
    });

    expect(view?.expression).toBe(expression);
    expect(view?.expression).toEqual(["Equal", ["Add", "x", 1], ["Add", 1, "x"]]);
    expect(statementViewSchema.safeParse(statement(["Add", "x", 1])).success).toBe(false);
  });

  it("uses signatures to admit custom proposition-valued operators", () => {
    const isPrime = operatorDeclarationSchema.parse({
      id: "operator:is-prime",
      symbol: "IsPrime",
      signature: { parameters: [naturalSort], result: PROPOSITION_SORT },
    });
    const schema = createStatementViewSchema({
      declarations: [universal("decl:n", "n", naturalSort), universal("decl:x", "x", realSort)],
      operators: [isPrime],
    });

    expect(schema.safeParse(statement(["IsPrime", "n"])).success).toBe(true);
    expect(schema.safeParse(statement(["IsPrime", 2])).success).toBe(true);
    expect(schema.safeParse(statement(["IsPrime", 0.5])).success).toBe(false);
    expect(schema.safeParse(statement(["IsPrime", { num: "NaN" }])).success).toBe(false);
    expect(schema.safeParse(statement(["IsPrime", "x"])).success).toBe(false);
    expect(schema.safeParse(statement(["Equal", "n", "x"])).success).toBe(false);
    expect(schema.safeParse(statement(["IsPrime", "n", "m"])).success).toBe(false);
    expect(schema.safeParse(statement(["UnknownPredicate", "n"])).success).toBe(false);
    expect(schema.safeParse(statement(["IsPrime", ["UnknownTerm", "n"]])).success).toBe(false);
  });

  it("uses explicit numeric and set contracts for built-in operations", () => {
    const setOfReals = { kind: "named", id: "sort:set", arguments: [realSort] } as const;
    const schema = createStatementViewSchema({
      declarations: [universal("decl:A", "A", setOfReals), universal("decl:B", "B", setOfReals)],
    });

    expect(statementViewSchema.safeParse(statement(["Equal", 1, 2])).success).toBe(true);
    expect(statementViewSchema.safeParse(statement(["Equal", { str: "a" }, 2])).success).toBe(
      false,
    );
    expect(statementViewSchema.safeParse(statement(["Subset", 1, 2])).success).toBe(false);
    expect(schema.safeParse(statement(["Subset", "A", "B"])).success).toBe(true);
    expect(
      statementViewSchema.safeParse(
        statement(["Equal", ["Add", { str: "a" }, { str: "b" }], { str: "c" }]),
      ).success,
    ).toBe(false);
  });

  it("reserves built-in symbols against conflicting declarations and operators", () => {
    expect(
      declarationSchema.safeParse({
        id: "decl:add",
        symbol: "Add",
        sort: realSort,
        role: "universal-parameter",
      }).success,
    ).toBe(false);
    expect(
      operatorDeclarationSchema.safeParse({
        id: "operator:fake-equality",
        symbol: "Equal",
        signature: { parameters: [], result: realSort },
      }).success,
    ).toBe(false);
  });

  it("supports only declared direct-symbol binder operands", () => {
    const typedSchema = createStatementViewSchema({
      declarations: [universal("decl:x", "x")],
    });
    expect(
      typedSchema.safeParse(
        statement(["ForAll", "x", ["Implies", ["Greater", "x", 0], ["Greater", "x", -1]]]),
      ).success,
    ).toBe(true);
    expect(
      statementViewSchema.safeParse(statement(["ForAll", "x", ["And", "x", ["Greater", "x", 0]]]))
        .success,
    ).toBe(false);
    expect(
      statementViewSchema.safeParse(statement(["ForAll", ["Tuple", "x", "y"], ["Equal", "x", "y"]]))
        .success,
    ).toBe(false);
    expect(
      binderSpecificationSchema.safeParse({
        kind: "pattern-binder",
        boundOperands: [0],
        scopedOperands: [1],
      }).success,
    ).toBe(false);
    expect(
      binderSpecificationSchema.safeParse({
        kind: "direct-symbols",
        boundOperands: [0],
        scopedOperands: [0],
      }).success,
    ).toBe(false);
    expect(
      operatorDeclarationSchema.safeParse({
        id: "operator:bad-binder",
        symbol: "BadBinder",
        signature: { parameters: [realSort], result: PROPOSITION_SORT },
        binder: { kind: "direct-symbols", boundOperands: [0], scopedOperands: [1] },
      }).success,
    ).toBe(false);
  });

  it("enforces lexical binder scope, including proposition and function variables", () => {
    const predicateSort = {
      kind: "function",
      signature: { parameters: [realSort], result: PROPOSITION_SORT },
    } as const;
    const endomorphismSort = {
      kind: "function",
      signature: { parameters: [realSort], result: realSort },
    } as const;
    const schema = createStatementViewSchema({
      declarations: [
        universal("decl:x", "x"),
        universal("decl:P", "P", PROPOSITION_SORT),
        universal("decl:predicate", "predicate", predicateSort),
        universal("decl:f", "f", endomorphismSort),
      ],
    });

    expect(schema.safeParse(statement(["ForAll", "P", "P"])).success).toBe(true);
    expect(
      schema.safeParse(statement(["ForAll", "f", ["Equal", ["f", "x"], ["Add", "x", 0]]])).success,
    ).toBe(true);
    expect(schema.safeParse(statement(["ForAll", "x", ["predicate", "x"]])).success).toBe(true);
    expect(
      statementViewSchema.safeParse(
        statement([
          "And",
          ["ForAll", "scoped", ["Equal", "scoped", "scoped"]],
          ["Equal", "scoped", "scoped"],
        ]),
      ).success,
    ).toBe(false);
  });

  it("limits custom binder names to their declared scoped operands", () => {
    const scopedOperator = operatorDeclarationSchema.parse({
      id: "operator:scoped",
      symbol: "Scoped",
      signature: {
        parameters: [realSort, PROPOSITION_SORT, PROPOSITION_SORT],
        result: PROPOSITION_SORT,
      },
      binder: {
        kind: "direct-symbols",
        boundOperands: [0],
        scopedOperands: [1],
      },
    });
    const schema = createStatementViewSchema({ operators: [scopedOperator] });

    expect(schema.safeParse(statement(["Scoped", "z", ["Equal", "z", 1], "True"])).success).toBe(
      true,
    );
    expect(
      schema.safeParse(statement(["Scoped", "z", ["Equal", "z", 1], ["Equal", "z", 1]])).success,
    ).toBe(false);
    expect(schema.safeParse(statement(["Scoped", "True", "True", "True"])).success).toBe(false);
    expect(schema.safeParse(statement(["Scoped", "Scoped", "True", "True"])).success).toBe(false);
  });
});

describe("contextual proof-state invariants", () => {
  it("stores an independent contextual sequent on every goal and obligation", () => {
    const state = executableProofStateSchema.parse({
      id: "state:initial",
      goals: [
        {
          id: "statement:goal",
          sequent: {
            context: {
              declarations: [universal("decl:x", "x")],
              hypotheses: [
                { id: "statement:x-positive", statement: statement(["Greater", "x", 0]) },
              ],
            },
            conclusion: statement(["Greater", ["Add", "x", 1], 0]),
          },
        },
      ],
      obligations: [
        {
          id: "statement:obligation",
          sequent: {
            context: {
              declarations: [witness("decl:y", "y")],
              hypotheses: [
                { id: "statement:y-positive", statement: statement(["Greater", "y", 0]) },
              ],
            },
            conclusion: statement(["Equal", ["Multiply", "y", "y"], 4]),
          },
        },
      ],
    });

    expect(state).toMatchInlineSnapshot(`
      {
        "goals": [
          {
            "id": "statement:goal",
            "sequent": {
              "conclusion": {
                "expression": [
                  "Greater",
                  [
                    "Add",
                    "x",
                    1,
                  ],
                  0,
                ],
              },
              "context": {
                "declarations": [
                  {
                    "id": "decl:x",
                    "role": "universal-parameter",
                    "sort": {
                      "id": "sort:real",
                      "kind": "named",
                    },
                    "symbol": "x",
                  },
                ],
                "hypotheses": [
                  {
                    "id": "statement:x-positive",
                    "statement": {
                      "expression": [
                        "Greater",
                        "x",
                        0,
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
        "id": "state:initial",
        "obligations": [
          {
            "id": "statement:obligation",
            "sequent": {
              "conclusion": {
                "expression": [
                  "Equal",
                  [
                    "Multiply",
                    "y",
                    "y",
                  ],
                  4,
                ],
              },
              "context": {
                "declarations": [
                  {
                    "id": "decl:y",
                    "role": "local-witness",
                    "sort": {
                      "id": "sort:real",
                      "kind": "named",
                    },
                    "symbol": "y",
                  },
                ],
                "hypotheses": [
                  {
                    "id": "statement:y-positive",
                    "statement": {
                      "expression": [
                        "Greater",
                        "y",
                        0,
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      }
    `);
    expect(state.goals[0]?.sequent.context.declarations[0]?.symbol).toBe("x");
    expect(state.obligations[0]?.sequent.context.declarations[0]?.symbol).toBe("y");
  });

  it("rejects terms as statements and duplicate statement identities", () => {
    const invalidState = {
      id: "state:invalid",
      goals: [
        {
          id: "statement:duplicate",
          sequent: {
            context: { declarations: [], hypotheses: [] },
            conclusion: statement(["Add", 1, 2]),
          },
        },
      ],
      obligations: [
        {
          id: "statement:duplicate",
          sequent: {
            context: { declarations: [], hypotheses: [] },
            conclusion: statement(["Equal", 1, 1]),
          },
        },
      ],
    };

    expect(proofStateSchema.safeParse(invalidState).success).toBe(false);
  });

  it("rejects duplicate declaration identities and symbols for arbitrary contexts", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,12}$/),
        fc.string({ minLength: 1, maxLength: 12 }),
        (suffix, symbol) => {
          const declaration = universal(`decl:${suffix}`, symbol);
          expect(
            proofContextSchema.safeParse({
              declarations: [declaration, { ...declaration }],
              hypotheses: [],
            }).success,
          ).toBe(false);
        },
      ),
    );
  });

  it("allows construction tasks in drafts but rejects unresolved ones at execution", () => {
    const unresolved = {
      id: "decl:target",
      symbol: "target",
      sort: realSort,
      role: "construction-metavariable",
      resolution: { status: "unresolved" },
    } as const;
    const draft = {
      id: "state:construction",
      goals: [
        {
          id: "statement:goal",
          sequent: {
            context: { declarations: [unresolved], hypotheses: [] },
            conclusion: statement(["Equal", "target", 2]),
          },
        },
      ],
      obligations: [],
    };

    expect(proofStateSchema.safeParse(draft).success).toBe(true);
    expect(executableProofStateSchema.safeParse(draft).success).toBe(false);
    expect(
      executableProofStateSchema.safeParse({
        ...draft,
        goals: [
          {
            ...draft.goals[0],
            sequent: {
              ...draft.goals[0]?.sequent,
              context: {
                declarations: [
                  { ...unresolved, resolution: { status: "resolved", value: 2 } as const },
                ],
                hypotheses: [],
              },
            },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("applies custom signatures independently to every contextual sequent", () => {
    const operators = [
      operatorDeclarationSchema.parse({
        id: "operator:is-prime",
        symbol: "IsPrime",
        signature: { parameters: [naturalSort], result: PROPOSITION_SORT },
      }),
    ];
    const schema = createExecutableProofStateSchema({ operators });

    expect(
      schema.safeParse({
        id: "state:prime",
        goals: [
          {
            id: "statement:goal",
            sequent: {
              context: { declarations: [universal("decl:n", "n", naturalSort)], hypotheses: [] },
              conclusion: statement(["IsPrime", "n"]),
            },
          },
        ],
        obligations: [],
      }).success,
    ).toBe(true);
  });

  it("does not leak declarations between sibling sequents", () => {
    const state = {
      id: "state:siblings",
      goals: [
        {
          id: "statement:first",
          sequent: {
            context: { declarations: [universal("decl:first-x", "x")], hypotheses: [] },
            conclusion: statement(["Equal", "x", "x"]),
          },
        },
        {
          id: "statement:second",
          sequent: {
            context: { declarations: [], hypotheses: [] },
            conclusion: statement(["Equal", "x", "x"]),
          },
        },
      ],
      obligations: [],
    };

    expect(proofStateSchema.safeParse(state).success).toBe(false);
    expect(
      proofStateSchema.safeParse({
        ...state,
        goals: [
          state.goals[0],
          {
            ...state.goals[1],
            sequent: {
              ...state.goals[1]?.sequent,
              context: {
                declarations: [universal("decl:second-x", "x", naturalSort)],
                hypotheses: [],
              },
            },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("validates resolved construction values and rejects even unused unresolved choices", () => {
    const baseDeclaration = {
      id: "decl:choice",
      symbol: "choice",
      sort: realSort,
      role: "construction-metavariable",
    } as const;
    const stateWith = (resolution: unknown) => ({
      id: "state:resolved",
      goals: [
        {
          id: "statement:true",
          sequent: {
            context: {
              declarations: [{ ...baseDeclaration, resolution }],
              hypotheses: [],
            },
            conclusion: statement("True"),
          },
        },
      ],
      obligations: [],
    });

    const unresolved = stateWith({ status: "unresolved" });
    expect(proofStateSchema.safeParse(unresolved).success).toBe(true);
    expect(executableProofStateSchema.safeParse(unresolved).success).toBe(false);
    expect(
      executableProofStateSchema.safeParse(stateWith({ status: "resolved", value: ["Add", 1, 2] }))
        .success,
    ).toBe(true);
    expect(
      proofStateSchema.safeParse(stateWith({ status: "resolved", value: "True" })).success,
    ).toBe(false);
    expect(
      proofStateSchema.safeParse(stateWith({ status: "resolved", value: ["UnknownTerm", 1] }))
        .success,
    ).toBe(false);
    expect(
      executableProofStateSchema.safeParse(stateWith({ status: "resolved", value: "choice" }))
        .success,
    ).toBe(false);

    const mutuallyRecursive = {
      id: "state:cycle",
      goals: [
        {
          id: "statement:true",
          sequent: {
            context: {
              declarations: [
                {
                  id: "decl:a",
                  symbol: "a",
                  sort: realSort,
                  role: "construction-metavariable",
                  resolution: { status: "resolved", value: "b" },
                },
                {
                  id: "decl:b",
                  symbol: "b",
                  sort: realSort,
                  role: "construction-metavariable",
                  resolution: { status: "resolved", value: "a" },
                },
              ],
              hypotheses: [],
            },
            conclusion: statement("True"),
          },
        },
      ],
      obligations: [],
    };
    expect(executableProofStateSchema.safeParse(mutuallyRecursive).success).toBe(false);

    const boundShadow = {
      id: "state:bound-shadow",
      goals: [
        {
          id: "statement:true",
          sequent: {
            context: {
              declarations: [
                {
                  id: "decl:p",
                  symbol: "p",
                  sort: PROPOSITION_SORT,
                  role: "construction-metavariable",
                  resolution: { status: "resolved", value: ["ForAll", "p", "p"] },
                },
              ],
              hypotheses: [],
            },
            conclusion: statement("True"),
          },
        },
      ],
      obligations: [],
    };
    expect(executableProofStateSchema.safeParse(boundShadow).success).toBe(true);
  });
});

describe("operator presentation metadata", () => {
  const integerSort = { kind: "named", id: "sort:integer" } as const;
  const gcdBase = {
    id: "operator:gcd",
    symbol: "Gcd",
    signature: { parameters: [integerSort, integerSort], result: integerSort },
  } as const;
  const dividesBase = {
    id: "operator:divides",
    symbol: "Divides",
    signature: { parameters: [integerSort, integerSort], result: PROPOSITION_SORT },
  } as const;

  function withPresentation(base: object, presentation: unknown) {
    return operatorDeclarationSchema.safeParse({ ...base, presentation });
  }

  it("keeps declarations without presentation valid", () => {
    expect(operatorDeclarationSchema.safeParse(gcdBase).success).toBe(true);
  });

  it("accepts complete templates, parse triggers and tags", () => {
    const parsed = withPresentation(gcdBase, {
      displayName: "greatest common divisor",
      latex: {
        template: "\\operatorname{gcd}\\left(#1, #2\\right)",
        precedence: "atom",
        parse: { trigger: "\\operatorname{gcd}", notation: "function" },
      },
      naturalLanguage: [
        { template: "the greatest common divisor of #1 and #2" },
        { template: "$\\gcd(#1, #2)$", proposition: false },
      ],
      domains: ["number-theory"],
      notations: ["function-application"],
    });
    expect(parsed.success).toBe(true);

    expect(
      withPresentation(dividesBase, {
        displayName: "divides",
        latex: {
          template: "#1 \\divides #2",
          precedence: "relation",
          parse: { trigger: "\\divides", notation: "infix" },
        },
        naturalLanguage: [
          { template: "#1 divides #2", proposition: true, negated: "#1 does not divide #2" },
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    ["an out-of-range placeholder", { template: "#1 \\divides #3", precedence: "relation" }],
    ["a missing operand", { template: "\\operatorname{dv}(#1)", precedence: "atom" }],
    ["a malformed placeholder", { template: "#1 \\divides #x #2", precedence: "relation" }],
    ["a zero placeholder", { template: "#0 \\divides #1 #2", precedence: "relation" }],
    ["an unknown precedence", { template: "#1 \\divides #2", precedence: "tight" }],
    [
      "a trigger absent from the template",
      {
        template: "#1 \\mid #2",
        precedence: "relation",
        parse: { trigger: "\\divides", notation: "infix" },
      },
    ],
    [
      "a non-command trigger",
      { template: "#1 | #2", precedence: "relation", parse: { trigger: "|", notation: "infix" } },
    ],
    [
      "a prefix trigger on a binary operator",
      {
        template: "\\divides #1 #2",
        precedence: "prefix",
        parse: { trigger: "\\divides", notation: "prefix" },
      },
    ],
  ])("rejects a LaTeX template with %s", (_label, latex) => {
    expect(withPresentation(dividesBase, { displayName: "divides", latex }).success).toBe(false);
  });

  it("validates natural-language templates against arity and result sort", () => {
    const nl = (naturalLanguage: unknown) =>
      withPresentation(gcdBase, { displayName: "gcd", naturalLanguage }).success;
    expect(nl([{ template: "the gcd of #1 and #2" }])).toBe(true);
    expect(nl([])).toBe(false);
    expect(nl([{ template: "the gcd of #1" }])).toBe(false);
    expect(nl([{ template: "the gcd of #1, #2 and #3" }])).toBe(false);
    expect(nl([{ template: "the gcd of #1 and #2", proposition: true }])).toBe(false);
    expect(nl([{ template: "the gcd of #1 and #2", negated: "not the gcd of #1 and #2" }])).toBe(
      false,
    );
    expect(
      withPresentation(dividesBase, {
        displayName: "divides",
        naturalLanguage: [{ template: "#1 divides #2", negated: "#1 does not divide" }],
      }).success,
    ).toBe(false);
    expect(
      withPresentation(gcdBase, { latex: { template: "#1#2", precedence: "atom" } }).success,
    ).toBe(false);
  });

  it("requires binder templates to render bound and scoped operands", () => {
    const sumOver = {
      id: "operator:sum-over",
      symbol: "SumOver",
      signature: { parameters: [integerSort, integerSort, integerSort], result: integerSort },
      binder: { kind: "direct-symbols", boundOperands: [0], scopedOperands: [2] },
    };
    const latex = (template: string) =>
      withPresentation(sumOver, {
        displayName: "sum",
        latex: { template, precedence: "additive" },
      }).success;
    expect(latex("\\sum_{#1 \\mid #2} #3")).toBe(true);
    expect(latex("\\sum_{#2} #3")).toBe(false);
  });

  it("rejects duplicate parse triggers in one operator environment", () => {
    const presentation = (displayName: string) => ({
      displayName,
      latex: {
        template: "\\operatorname{g}\\left(#1, #2\\right)",
        precedence: "atom",
        parse: { trigger: "\\operatorname{g}", notation: "function" },
      },
    });
    expect(
      operatorDeclarationsSchema.safeParse([
        { ...gcdBase, presentation: presentation("A") },
        { ...gcdBase, id: "operator:gcd-2", symbol: "Gcd2", presentation: presentation("B") },
      ]).success,
    ).toBe(false);
  });

  it("splits templates into segments that reassemble the template", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.stringMatching(/^[a-z {}()]{1,6}$/),
            fc.integer({ min: 1, max: 12 }).map((index) => `#${index}`),
            fc.constant("\\#"),
          ),
        ),
        (parts) => {
          const template = parts.join("");
          const segments = operatorTemplateSegments(template);
          expect(segments).toBeDefined();
          const rebuilt = (segments ?? [])
            .map((segment) => (segment.kind === "text" ? segment.text : `#${segment.index + 1}`))
            .join("");
          expect(rebuilt).toBe(template);
        },
      ),
    );
    expect(operatorTemplateSegments("#1 and #")).toBeUndefined();
    expect(operatorTemplateSegments("\\#1 and #2")).toEqual([
      { kind: "text", text: "\\#1 and " },
      { kind: "operand", index: 1 },
    ]);
  });
});

describe("state-global additional assumptions and obligation provenance", () => {
  const propositionVariable = (id: string, symbol: string) =>
    universal(id, symbol, PROPOSITION_SORT);
  const baseState = {
    id: "state:assumptions",
    goals: [
      {
        id: "statement:goal",
        sequent: {
          context: { declarations: [propositionVariable("decl:p", "p")], hypotheses: [] },
          conclusion: statement(["Or", "p", ["Not", "p"]]),
        },
      },
    ],
    obligations: [],
  } as const;
  const sorryOrigin = {
    kind: "sorry",
    sourceTarget: { kind: "goal", id: "statement:sorried" },
    sorryId: "sorry:one",
  } as const;
  const closedAssumption = {
    id: "assumption:excluded-middle",
    declarations: [propositionVariable("decl:q", "q")],
    statement: statement(["ForAll", "q", ["Or", "q", ["Not", "q"]]]),
    origin: sorryOrigin,
  } as const;

  it("keeps states without assumptions or provenance valid and unchanged", () => {
    const parsed = executableProofStateSchema.parse(baseState);
    expect(parsed).toEqual(baseState);
    expect("assumptions" in parsed).toBe(false);
  });

  it("accepts closed assumptions in draft and executable states", () => {
    const state = { ...baseState, assumptions: [closedAssumption] };
    expect(executableProofStateSchema.safeParse(state).success).toBe(true);
    expect(proofStateSchema.safeParse(state).success).toBe(true);
    expect(
      executableProofStateSchema.safeParse({
        ...baseState,
        assumptions: [
          {
            id: "assumption:trivial",
            declarations: [],
            statement: statement("True"),
            origin: { kind: "sorry", sourceTarget: { kind: "obligation", id: "statement:o" } },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("admits declared operators but rejects free symbols", () => {
    const operators = [
      operatorDeclarationSchema.parse({
        id: "operator:is-prime",
        symbol: "IsPrime",
        signature: { parameters: [naturalSort], result: PROPOSITION_SORT },
      }),
    ];
    const withOperator = {
      ...baseState,
      assumptions: [
        {
          ...closedAssumption,
          declarations: [universal("decl:n", "n", naturalSort)],
          statement: statement(["Exists", "n", ["IsPrime", "n"]]),
        },
      ],
    };
    expect(createExecutableProofStateSchema({ operators }).safeParse(withOperator).success).toBe(
      true,
    );
    expect(executableProofStateSchema.safeParse(withOperator).success).toBe(false);

    const open = executableProofStateSchema.safeParse({
      ...baseState,
      assumptions: [
        {
          ...closedAssumption,
          declarations: [propositionVariable("decl:q", "q"), propositionVariable("decl:r", "r")],
          statement: statement(["ForAll", "q", ["Or", "q", "r"]]),
        },
      ],
    });
    expect(open.success).toBe(false);
    expect(open.error?.issues[0]?.message).toMatch(/closed; free symbols: r/);
  });

  it("rejects duplicate assumption ids, non-propositions and construction binders", () => {
    expect(
      executableProofStateSchema.safeParse({
        ...baseState,
        assumptions: [closedAssumption, closedAssumption],
      }).success,
    ).toBe(false);
    expect(
      executableProofStateSchema.safeParse({
        ...baseState,
        assumptions: [{ ...closedAssumption, declarations: [], statement: statement(1) }],
      }).success,
    ).toBe(false);
    expect(
      executableProofStateSchema.safeParse({
        ...baseState,
        assumptions: [
          {
            ...closedAssumption,
            declarations: [
              declarationSchema.parse({
                id: "decl:q",
                symbol: "q",
                sort: PROPOSITION_SORT,
                role: "construction-metavariable",
                resolution: { status: "resolved", value: "True" },
              }),
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      executableProofStateSchema.safeParse({
        ...baseState,
        assumptions: [{ ...closedAssumption, origin: { kind: "sorry" } }],
      }).success,
    ).toBe(false);
  });

  it("rejects any assumption mentioning an undeclared free symbol", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/), (name) => {
        fc.pre(name !== "q");
        const parsed = executableProofStateSchema.safeParse({
          ...baseState,
          assumptions: [
            {
              ...closedAssumption,
              declarations: [
                propositionVariable("decl:q", "q"),
                propositionVariable("decl:free", name),
              ],
              statement: statement(["ForAll", "q", ["Implies", name, "q"]]),
            },
          ],
        });
        expect(parsed.success).toBe(false);
      }),
    );
  });

  it("accepts optional obligation provenance and rejects malformed provenance", () => {
    const withObligation = (provenance: unknown) => ({
      ...baseState,
      obligations: [
        {
          id: "statement:obligation",
          sequent: {
            context: { declarations: [], hypotheses: [] },
            conclusion: statement("True"),
          },
          provenance,
        },
      ],
    });
    [
      { kind: "premise-of-result", resultId: "result:modus-ponens" },
      { kind: "side-condition", resultId: "result:division", sideConditionId: "nonzero" },
      { kind: "user" },
      { kind: "case" },
      { kind: "suffices" },
    ].forEach((provenance) => {
      expect(executableProofStateSchema.safeParse(withObligation(provenance)).success).toBe(true);
    });
    [
      { kind: "premise-of-result" },
      { kind: "side-condition", resultId: "result:division" },
      { kind: "user", resultId: "result:x" },
      { kind: "unknown" },
    ].forEach((provenance) => {
      expect(executableProofStateSchema.safeParse(withObligation(provenance)).success).toBe(false);
    });
  });
});
