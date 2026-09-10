import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PROPOSITION_SORT,
  declarationSchema,
  operatorDeclarationSchema,
  type PlainMathJson,
  type ProofState,
  type StatementId,
} from "@proof/mathjson-model";
import {
  createAssociativeSelection,
  expressionAtPath,
  findExactPaths,
  replaceAtPath,
  replaceSelection,
  resolveProofSelection,
  resolveProofSelectionQuery,
  resolveSelection,
} from "./index";

const statement = [
  "Equal",
  ["Add", ["Power", "x", 2], ["Multiply", 3, "y"], "z", "y"],
  12,
] as const satisfies PlainMathJson;

describe("operand paths", () => {
  it("uses zero-based operand indices and never counts the operator", () => {
    expect(expressionAtPath(statement, [])).toBe(statement);
    expect(expressionAtPath(statement, [0, 0])).toEqual(["Power", "x", 2]);
    expect(expressionAtPath(statement, [0, 1, 1])).toBe("y");
    expect(expressionAtPath(statement, [2])).toBeUndefined();
  });

  it("distinguishes equal expressions by occurrence", () => {
    expect(findExactPaths(statement, "y")).toEqual([
      [0, 1, 1],
      [0, 3],
    ]);
    expect(resolveSelection(statement, "y", { occurrence: 1 })).toMatchObject({
      kind: "exact",
      path: [0, 3],
    });
    expect(resolveSelection(statement, "y", { paths: [[0, 1, 1]] })).toMatchObject({
      kind: "exact",
      path: [0, 1, 1],
    });
    expect(
      resolveSelection(statement, "y", {
        paths: [
          [0, 2],
          [0, 3],
        ],
      }),
    ).toMatchObject({ kind: "exact", path: [0, 3] });
  });

  it("replaces an exact occurrence without changing its source or siblings", () => {
    const before = JSON.stringify(statement);
    const result = replaceAtPath(statement, [0, 1], "u");

    expect(result).toEqual({
      ok: true,
      expression: ["Equal", ["Add", ["Power", "x", 2], "u", "z", "y"], 12],
      diagnostics: [],
    });
    expect(JSON.stringify(statement)).toBe(before);
  });

  it("returns a diagnostic and the untouched expression for invalid paths", () => {
    const result = replaceAtPath(statement, [0, 9], "u");
    expect(result.ok).toBe(false);
    expect(result.expression).toBe(statement);
    expect(result.diagnostics[0]).toMatchObject({ code: "invalid-path", path: [0, 9] });
  });

  it("supports object-form function expressions", () => {
    const expression = {
      fn: ["Equal", { fn: ["Add", "a", "b"], comment: "keep me" }, "c"],
    } as const satisfies PlainMathJson;
    const result = replaceAtPath(expression, [0, 1], "x");
    expect(result.expression).toEqual({
      fn: ["Equal", { fn: ["Add", "a", "x"], comment: "keep me" }, "c"],
    });
  });
});

describe("associative virtual selections", () => {
  it.each([
    ["Add", ["Add", "a", "b", "c", "d"]],
    ["Multiply", ["Multiply", "a", "b", "c", "d"]],
    ["And", ["And", "a", "b", "c", "d"]],
    ["Or", ["Or", "a", "b", "c", "d"]],
  ] as const)("extracts and reinserts a contiguous %s range", (operator, expression) => {
    const lens = createAssociativeSelection(expression, [], 1, 3);
    expect(lens).toMatchObject({
      kind: "associative",
      operator,
      containerPath: [],
      startOperand: 1,
      endOperand: 3,
      coveredOperandPaths: [[1], [2]],
      fragment: [operator, "b", "c"],
    });

    expect(replaceSelection(expression, lens!, "u")).toEqual({
      ok: true,
      expression: [operator, "a", "u", "d"],
      diagnostics: [],
    });
  });

  it("resolves a displayed contiguous range to a lens", () => {
    expect(
      resolveSelection(statement, ["Add", ["Multiply", 3, "y"], "z"], {
        paths: [
          [0, 1, 0],
          [0, 2],
        ],
        displayRange: [4, 9],
      }),
    ).toMatchObject({
      kind: "associative",
      containerPath: [0],
      startOperand: 1,
      endOperand: 3,
      displayRange: [4, 9],
    });
  });

  it("rejects noncontiguous and singleton ranges", () => {
    expect(createAssociativeSelection(statement, [0], 1, 1)).toBeUndefined();
    expect(createAssociativeSelection(statement, [0], 1, 5)).toBeUndefined();
    expect(createAssociativeSelection(["Subtract", "a", "b", "c"], [], 0, 2)).toBeUndefined();
  });

  it("rejects a stale lens rather than replacing a changed container", () => {
    const expression: PlainMathJson = ["Add", "a", "b", "c"];
    const lens = createAssociativeSelection(expression, [], 0, 2);
    const changed: PlainMathJson = ["Add", "x", "b", "c"];
    const result = replaceSelection(changed, lens!, "u");
    expect(result).toMatchObject({
      ok: false,
      expression: changed,
      diagnostics: [{ code: "invalid-associative-range" }],
    });
  });

  it("preserves all unselected operands for arbitrary integer lists", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer(), { minLength: 4, maxLength: 12 }),
        fc.integer(),
        (operands, replacement) => {
          const expression: PlainMathJson = ["Add", ...operands];
          const lens = createAssociativeSelection(expression, [], 1, 3);
          expect(lens).toBeDefined();
          const result = replaceSelection(expression, lens!, replacement);
          expect(result).toEqual({
            ok: true,
            expression: ["Add", operands[0], replacement, ...operands.slice(3)],
            diagnostics: [],
          });
        },
      ),
    );
  });
});

describe("visible fallback semantics", () => {
  it("snaps a cross-branch range to the common enclosing subtree", () => {
    const requested: PlainMathJson = ["Add", 2, ["Multiply", 3, "y"]];
    expect(
      resolveSelection(statement, requested, {
        paths: [
          [0, 0, 1],
          [0, 1, 1],
        ],
      }),
    ).toMatchObject({
      kind: "fallback",
      path: [0],
      fragment: statement[1],
      requestedFragment: requested,
    });
  });

  it("uses leaf containment when display metadata is unavailable", () => {
    expect(resolveSelection(statement, ["Add", 2, 3, "z"])).toMatchObject({
      kind: "fallback",
      path: [0],
    });
  });
});

const realSort = { kind: "named", id: "sort:real" } as const;

function propositionDeclaration(symbol: string) {
  return declarationSchema.parse({
    id: `decl:${symbol}`,
    symbol,
    sort: PROPOSITION_SORT,
    role: "universal-parameter",
  });
}

function proofState(
  expression: PlainMathJson,
  hypothesisExpressions: readonly PlainMathJson[] = [],
): ProofState {
  return {
    id: "state:one" as ProofState["id"],
    goals: [
      {
        id: "goal:main" as ProofState["goals"][number]["id"],
        sequent: {
          context: {
            declarations: ["P", "Q", "R", "S"].map(propositionDeclaration),
            hypotheses: hypothesisExpressions.map((hypothesis, index) => ({
              id: `hyp:${index}` as ProofState["goals"][number]["sequent"]["context"]["hypotheses"][number]["id"],
              statement: { expression: hypothesis },
            })),
          },
          conclusion: { expression },
        },
      },
    ],
    obligations: [],
  };
}

function anchored(
  path: readonly number[],
  statementReference: { kind: "conclusion" } | { kind: "hypothesis"; id: string } = {
    kind: "conclusion",
  },
) {
  return {
    kind: "exact",
    anchor: {
      stateId: "state:one",
      target: { kind: "goal", id: "goal:main" },
      statement: statementReference,
    },
    path,
  };
}

function anchoredAssociative(
  containerPath: readonly number[],
  startOperand: number,
  endOperand: number,
  statementReference: { kind: "conclusion" } | { kind: "hypothesis"; id: string } = {
    kind: "conclusion",
  },
) {
  return {
    kind: "associative",
    anchor: {
      stateId: "state:one",
      target: { kind: "goal", id: "goal:main" },
      statement: statementReference,
    },
    containerPath,
    startOperand,
    endOperand,
  };
}

describe("snapshot-anchored associative selections", () => {
  it("derives an exact virtual fragment, lens, and logical position from the snapshot", () => {
    const state = proofState(["Implies", ["And", "P", "Q", "R"], "S"]);
    const result = resolveProofSelection(state, anchoredAssociative([0], 1, 3));

    expect(result).toMatchObject({
      ok: true,
      selection: {
        kind: "associative",
        operator: "And",
        containerPath: [0],
        startOperand: 1,
        endOperand: 3,
        coveredOperandPaths: [
          [0, 1],
          [0, 2],
        ],
        fragment: ["And", "Q", "R"],
        position: { polarity: "negative", role: "proposition" },
      },
    });
    if (!result.ok || result.selection.kind !== "associative") {
      throw new Error("Expected an associative proof selection.");
    }
    expect(
      replaceSelection(state.goals[0]!.sequent.conclusion.expression, result.selection, "P"),
    ).toEqual({
      ok: true,
      expression: ["Implies", ["And", "P", "P"], "S"],
      diagnostics: [],
    });
  });

  it("preserves object-form container metadata and optional display evidence", () => {
    const expression = {
      fn: ["And", "P", "Q", "R"],
      comment: "author-approved grouping",
    } as const satisfies PlainMathJson;
    const result = resolveProofSelection(proofState(expression), {
      ...anchoredAssociative([], 0, 2),
      displayRange: [4, 12],
    });

    expect(result).toMatchObject({
      ok: true,
      selection: {
        container: expression,
        fragment: { fn: ["And", "P", "Q"], comment: "author-approved grouping" },
        displayRange: [4, 12],
        position: { polarity: "positive", role: "proposition" },
      },
    });
  });

  it("starts associative hypothesis ranges in negative position", () => {
    const result = resolveProofSelection(
      proofState("S", [["Or", "P", "Q", "R"]]),
      anchoredAssociative([], 0, 2, { kind: "hypothesis", id: "hyp:0" }),
    );
    expect(result).toMatchObject({
      ok: true,
      selection: {
        fragment: ["Or", "P", "Q"],
        position: { polarity: "negative", role: "proposition" },
      },
    });
  });

  it.each([
    [
      "invalid-selection",
      { ...anchoredAssociative([], 0, 2), container: ["And", "P", "Q"] },
      undefined,
    ],
    ["invalid-selection", { ...anchoredAssociative([], 1, 1) }, undefined],
    ["invalid-associative-range", anchoredAssociative([], 0, 4), undefined],
    ["invalid-associative-range", anchoredAssociative([], 0, 2), proofState(["Implies", "P", "Q"])],
  ] as const)("reports %s for malformed or unavailable lenses", (code, selection, stateInput) => {
    expect(
      resolveProofSelection(stateInput ?? proofState(["And", "P", "Q"]), selection),
    ).toMatchObject({ ok: false, diagnostics: [{ code }] });
  });
});

describe("snapshot-anchored selection queries", () => {
  const wildcard = {
    id: "wildcard:shared",
    symbol: "_shared",
    role: "retrieval-wildcard",
    sort: PROPOSITION_SORT,
  } as const;

  function querySubject(
    id: string,
    selection: unknown,
    abstraction?: unknown,
  ): Record<string, unknown> {
    return {
      id,
      selection,
      ...(abstraction === undefined ? {} : { abstraction }),
    };
  }

  it("resolves independent occurrences without collapsing them to an ancestor", () => {
    const state = proofState(["And", "P", "Q"], ["R"]);
    const result = resolveProofSelectionQuery(state, {
      kind: "selection-query",
      selections: [
        querySubject("selection:goal-q", anchored([1])),
        querySubject("selection:hypothesis-r", anchored([], { kind: "hypothesis", id: "hyp:0" })),
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      query: {
        kind: "selection-query",
        stateId: "state:one",
        selections: [
          { id: "selection:goal-q", selection: { fragment: "Q" } },
          { id: "selection:hypothesis-r", selection: { fragment: "R" } },
        ],
      },
    });
    if (result.ok) {
      expect(Object.isFrozen(result.query)).toBe(true);
      expect(Object.isFrozen(result.query.selections)).toBe(true);
    }
  });

  it("keeps whole-selection abstraction separate from authoritative MathJSON", () => {
    const state = proofState(["And", "P", "Q"]);
    const result = resolveProofSelectionQuery(state, {
      kind: "selection-query",
      selections: [
        querySubject("selection:p", anchored([0]), wildcard),
        querySubject("selection:q", anchored([1]), wildcard),
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      query: {
        selections: [
          { selection: { fragment: "P" }, abstraction: wildcard },
          { selection: { fragment: "Q" }, abstraction: wildcard },
        ],
      },
    });
    expect(state.goals[0]?.sequent.conclusion.expression).toEqual(["And", "P", "Q"]);
  });

  it.each([
    [
      "duplicate-selection",
      proofState("P"),
      [
        querySubject("selection:first", anchored([])),
        querySubject("selection:second", anchored([])),
      ],
    ],
    [
      "overlapping-selection",
      proofState(["And", ["And", "P", "Q"], "R"]),
      [
        querySubject("selection:outer", anchored([0])),
        querySubject("selection:inner", anchored([0, 1])),
      ],
    ],
    [
      "overlapping-selection",
      proofState(["And", "P", "Q", "R"]),
      [
        querySubject("selection:range", anchoredAssociative([], 0, 2)),
        querySubject("selection:covered", anchored([1])),
      ],
    ],
  ] as const)(
    "reports %s rather than silently widening or dropping occurrences",
    (code, state, selections) => {
      expect(
        resolveProofSelectionQuery(state, { kind: "selection-query", selections }),
      ).toMatchObject({ ok: false, diagnostics: [{ code }] });
    },
  );

  it("keeps identical expressions at distinct paths as distinct occurrences", () => {
    expect(
      resolveProofSelectionQuery(proofState(["And", "P", "P"]), {
        kind: "selection-query",
        selections: [
          querySubject("selection:left", anchored([0])),
          querySubject("selection:right", anchored([1])),
        ],
      }),
    ).toMatchObject({
      ok: true,
      query: { selections: [{ selection: { path: [0] } }, { selection: { path: [1] } }] },
    });
  });

  it("rejects ambiguous wildcard identities and binder abstraction", () => {
    const mismatchedWildcard = { ...wildcard, symbol: "_different" };
    const sameSymbolDifferentId = { ...wildcard, id: "wildcard:different" };
    const state = proofState(["And", "P", "Q"]);
    for (const abstractions of [
      [wildcard, mismatchedWildcard],
      [wildcard, sameSymbolDifferentId],
    ]) {
      expect(
        resolveProofSelectionQuery(state, {
          kind: "selection-query",
          selections: [
            querySubject("selection:left", anchored([0]), abstractions[0]),
            querySubject("selection:right", anchored([1]), abstractions[1]),
          ],
        }),
      ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-abstraction" }] });
    }

    const quantified = proofState(["ForAll", "x", "P"]);
    quantified.goals[0]!.sequent.context.declarations.push(
      declarationSchema.parse({
        id: "decl:x",
        symbol: "x",
        sort: realSort,
        role: "universal-parameter",
      }),
    );
    expect(
      resolveProofSelectionQuery(quantified, {
        kind: "selection-query",
        selections: [querySubject("selection:binder", anchored([0]), wildcard)],
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-abstraction" }] });
  });

  it("rejects stale, duplicate-ID, and hostile query envelopes safely", () => {
    expect(
      resolveProofSelectionQuery(proofState("P"), {
        kind: "selection-query",
        selections: [
          querySubject("selection:one", {
            ...anchored([]),
            anchor: { ...anchored([]).anchor, stateId: "state:stale" },
          }),
        ],
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "stale-state" }] });
    expect(
      resolveProofSelectionQuery(proofState(["And", "P", "Q"]), {
        kind: "selection-query",
        selections: [
          querySubject("selection:duplicate", anchored([0])),
          querySubject("selection:duplicate", anchored([1])),
        ],
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-selection" }] });

    let invoked = false;
    const hostile = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        invoked = true;
        return "selection-query";
      },
    });
    expect(resolveProofSelectionQuery(proofState("P"), hostile)).toMatchObject({ ok: false });
    expect(invoked).toBe(false);
  });
});

describe("snapshot-anchored exact selections", () => {
  it("derives conclusion polarity through implication, negation, and conjunction", () => {
    const state = proofState(["Implies", "P", ["Not", ["And", "Q", "R"]]]);

    expect(resolveProofSelection(state, anchored([0]))).toMatchObject({
      ok: true,
      selection: { fragment: "P", position: { polarity: "negative", role: "proposition" } },
    });
    expect(resolveProofSelection(state, anchored([1, 0, 1]))).toMatchObject({
      ok: true,
      selection: { fragment: "R", position: { polarity: "negative", role: "proposition" } },
    });
  });

  it("starts hypotheses negative and flips only the implication antecedent", () => {
    const state = proofState("S", [["Implies", "P", "Q"]]);

    expect(
      resolveProofSelection(state, anchored([0], { kind: "hypothesis", id: "hyp:0" })),
    ).toMatchObject({
      ok: true,
      selection: { fragment: "P", position: { polarity: "positive", role: "proposition" } },
    });
    expect(
      resolveProofSelection(state, anchored([1], { kind: "hypothesis", id: "hyp:0" })),
    ).toMatchObject({
      ok: true,
      selection: { fragment: "Q", position: { polarity: "negative", role: "proposition" } },
    });
  });

  it("propagates mixed and neutral positions through all descendants", () => {
    const equivalent = proofState(["Equivalent", ["Not", "P"], "Q"]);
    expect(resolveProofSelection(equivalent, anchored([0, 0]))).toMatchObject({
      ok: true,
      selection: { position: { polarity: "mixed", role: "proposition" } },
    });

    const relation = {
      ...proofState(["Equal", ["Add", "x", 1], 2]),
      goals: [
        {
          ...proofState(["Equal", ["Add", "x", 1], 2]).goals[0]!,
          sequent: {
            ...proofState(["Equal", ["Add", "x", 1], 2]).goals[0]!.sequent,
            context: {
              declarations: [
                declarationSchema.parse({
                  id: "decl:x",
                  symbol: "x",
                  sort: realSort,
                  role: "universal-parameter",
                }),
              ],
              hypotheses: [],
            },
          },
        },
      ],
    } as ProofState;
    expect(resolveProofSelection(relation, anchored([0, 0]))).toMatchObject({
      ok: true,
      selection: { fragment: "x", position: { polarity: "neutral", role: "term" } },
    });

    const mixedTerm = proofState(["Equivalent", ["Equal", "x", 1], "P"]);
    mixedTerm.goals[0]!.sequent.context.declarations.push(
      declarationSchema.parse({
        id: "decl:x",
        symbol: "x",
        sort: realSort,
        role: "universal-parameter",
      }),
    );
    expect(resolveProofSelection(mixedTerm, anchored([0, 0]))).toMatchObject({
      ok: true,
      selection: { fragment: "x", position: { polarity: "neutral", role: "term" } },
    });

    const mixedBinder = proofState(["Equivalent", ["ForAll", "x", "P"], "Q"]);
    mixedBinder.goals[0]!.sequent.context.declarations.push(
      declarationSchema.parse({
        id: "decl:x",
        symbol: "x",
        sort: realSort,
        role: "universal-parameter",
      }),
    );
    expect(resolveProofSelection(mixedBinder, anchored([0, 0]))).toMatchObject({
      ok: true,
      selection: { fragment: "x", position: { polarity: "neutral", role: "binder" } },
    });
  });

  it("handles quantifier binders, object-form functions, and exact metadata", () => {
    const body: PlainMathJson = {
      fn: ["Implies", "P", "Q"],
      comment: "keep exact metadata",
    };
    const state: ProofState = {
      ...proofState({ fn: ["ForAll", "x", body] }),
      goals: [
        {
          ...proofState({ fn: ["ForAll", "x", body] }).goals[0]!,
          sequent: {
            context: {
              declarations: [
                ...["P", "Q"].map(propositionDeclaration),
                declarationSchema.parse({
                  id: "decl:x",
                  symbol: "x",
                  sort: realSort,
                  role: "universal-parameter",
                }),
              ],
              hypotheses: [],
            },
            conclusion: { expression: { fn: ["ForAll", "x", body] } },
          },
        },
      ],
    };

    expect(resolveProofSelection(state, anchored([0]))).toMatchObject({
      ok: true,
      selection: { position: { polarity: "neutral", role: "binder" } },
    });
    const bodyResult = resolveProofSelection(state, anchored([1]));
    expect(bodyResult).toMatchObject({
      ok: true,
      selection: { position: { polarity: "positive", role: "proposition" } },
    });
    if (bodyResult.ok) expect(bodyResult.selection.fragment).toBe(body);
    expect(resolveProofSelection(state, anchored([1, 0]))).toMatchObject({
      ok: true,
      selection: { position: { polarity: "negative", role: "proposition" } },
    });
  });

  it("marks custom proposition arguments mixed from their declared signature", () => {
    const operator = operatorDeclarationSchema.parse({
      id: "operator:modal",
      symbol: "Modal",
      signature: { parameters: [PROPOSITION_SORT, realSort], result: PROPOSITION_SORT },
    });
    const state: ProofState = {
      ...proofState(["Modal", "P", "x"]),
      goals: [
        {
          ...proofState(["Modal", "P", "x"]).goals[0]!,
          sequent: {
            context: {
              declarations: [
                propositionDeclaration("P"),
                declarationSchema.parse({
                  id: "decl:x",
                  symbol: "x",
                  sort: realSort,
                  role: "universal-parameter",
                }),
              ],
              hypotheses: [],
            },
            conclusion: { expression: ["Modal", "P", "x"] },
          },
        },
      ],
    };

    expect(resolveProofSelection(state, anchored([0]), { operators: [operator] })).toMatchObject({
      ok: true,
      selection: { position: { polarity: "mixed", role: "proposition" } },
    });
    expect(resolveProofSelection(state, anchored([1]), { operators: [operator] })).toMatchObject({
      ok: true,
      selection: { position: { polarity: "neutral", role: "term" } },
    });
  });

  it("tracks function sorts introduced by custom binders in scoped operands", () => {
    const operator = operatorDeclarationSchema.parse({
      id: "operator:binder",
      symbol: "BindPredicate",
      signature: {
        parameters: [
          {
            kind: "function",
            signature: { parameters: [PROPOSITION_SORT], result: PROPOSITION_SORT },
          },
          PROPOSITION_SORT,
        ],
        result: PROPOSITION_SORT,
      },
      binder: { kind: "direct-symbols", boundOperands: [0], scopedOperands: [1] },
    });
    const state = proofState(["BindPredicate", "f", ["f", "P"]]);

    expect(resolveProofSelection(state, anchored([0]), { operators: [operator] })).toMatchObject({
      ok: true,
      selection: { position: { polarity: "neutral", role: "binder" } },
    });
    expect(resolveProofSelection(state, anchored([1, 0]), { operators: [operator] })).toMatchObject(
      {
        ok: true,
        selection: { fragment: "P", position: { polarity: "mixed", role: "proposition" } },
      },
    );
  });

  it("uses the anchored target's local context when hypothesis IDs repeat", () => {
    const state = proofState("P", ["Q"]);
    state.goals.push({
      id: "goal:other" as ProofState["goals"][number]["id"],
      sequent: {
        context: {
          declarations: ["P", "Q", "R"].map(propositionDeclaration),
          hypotheses: [{ id: "hyp:0" as StatementId, statement: { expression: "R" } }],
        },
        conclusion: { expression: "P" },
      },
    });

    const result = resolveProofSelection(state, anchored([], { kind: "hypothesis", id: "hyp:0" }));
    expect(result).toMatchObject({ ok: true, selection: { fragment: "Q" } });
  });

  it("resolves obligations and permits unresolved construction declarations in draft states", () => {
    const state = proofState("P");
    state.obligations.push({
      id: "obligation:one" as ProofState["obligations"][number]["id"],
      sequent: {
        context: {
          declarations: [
            propositionDeclaration("P"),
            declarationSchema.parse({
              id: "decl:C",
              symbol: "C",
              sort: PROPOSITION_SORT,
              role: "construction-metavariable",
              resolution: { status: "unresolved" },
            }),
          ],
          hypotheses: [],
        },
        conclusion: { expression: "C" },
      },
    });
    const selection = {
      kind: "exact",
      anchor: {
        stateId: "state:one",
        target: { kind: "obligation", id: "obligation:one" },
        statement: { kind: "conclusion" },
      },
      path: [],
    };
    expect(resolveProofSelection(state, selection)).toMatchObject({
      ok: true,
      selection: { fragment: "C", declarations: [{ symbol: "P" }, { symbol: "C" }] },
    });
  });

  it.each([
    ["stale-state", { ...anchored([]), anchor: { ...anchored([]).anchor, stateId: "state:old" } }],
    [
      "target-not-found",
      {
        ...anchored([]),
        anchor: {
          ...anchored([]).anchor,
          target: { kind: "goal", id: "goal:missing" },
        },
      },
    ],
    ["hypothesis-not-found", anchored([], { kind: "hypothesis", id: "hyp:missing" })],
    ["invalid-path", anchored([9])],
  ] as const)("reports %s deterministically", (code, selection) => {
    const result = resolveProofSelection(proofState("P"), selection);
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code }] });
  });

  it("rejects malformed or spoofed selection data without invoking accessors", () => {
    let invoked = false;
    const hostile = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        invoked = true;
        return "exact";
      },
    });
    const spoofed = { ...anchored([]), fragment: "Q", polarity: "positive" };

    expect(resolveProofSelection(proofState("P"), hostile)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-selection" }],
    });
    expect(invoked).toBe(false);
    expect(resolveProofSelection(proofState("P"), spoofed)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-selection" }],
    });
  });

  it("contains late proxy failures retained by plain MathJSON validation", () => {
    let sliceReads = 0;
    const expression = new Proxy(["And", "True", "True"], {
      get(target, property, receiver) {
        if (property === "slice" && (sliceReads += 1) > 2) {
          throw new Error("late proxy access");
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as PlainMathJson;
    const input = proofState(expression);

    expect(() => resolveProofSelection(input, anchored([0]))).not.toThrow();
    expect(resolveProofSelection(input, anchored([0]))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-state" }],
    });
  });

  it("does not mutate a deeply frozen state", () => {
    const state = proofState(["And", "P", "Q"]);
    Object.freeze(state.goals[0]!.sequent.context.hypotheses);
    Object.freeze(state.goals[0]!.sequent.context.declarations);
    Object.freeze(state.goals[0]!.sequent.context);
    Object.freeze(state.goals[0]!.sequent.conclusion);
    Object.freeze(state.goals[0]!.sequent);
    Object.freeze(state.goals[0]);
    Object.freeze(state.goals);
    Object.freeze(state.obligations);
    Object.freeze(state);

    expect(resolveProofSelection(state, anchored([1]))).toMatchObject({
      ok: true,
      selection: { fragment: "Q" },
    });
  });

  it("rejects an invalid draft state before resolving its selection", () => {
    const state = proofState(["Add", 1, 2]);
    expect(resolveProofSelection(state, anchored([]))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-state" }],
    });
  });
});
