import { describe, expect, it } from "vitest";
import { CORE_LOGIC_RESULTS, libraryResultSchema, variantFamilySchema } from "@proof/library";
import {
  PROPOSITION_SORT,
  proofStateSchema,
  type PlainMathJson,
  type ProofState,
} from "@proof/mathjson-model";
import { HAND_AUTHORED_MOVES, moveDefinitionSchema } from "@proof/moves";
import {
  bindingsTypeFit,
  createRetrievalIndex,
  type RetrievalCatalog,
  type RetrievalIndex,
} from "./index";

const declarations = ["p", "q", "r"].map((symbol, index) => ({
  id: `declaration:${index}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
}));

function state(
  conclusion: PlainMathJson,
  hypotheses: readonly Readonly<{ id: string; expression: PlainMathJson }>[] = [],
): ProofState {
  return proofStateSchema.parse({
    id: "state:query",
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

function selection(
  statement: Readonly<{ kind: "conclusion" }> | Readonly<{ kind: "hypothesis"; id: string }> = {
    kind: "conclusion",
  },
  path: readonly number[] = [],
) {
  return {
    kind: "exact",
    anchor: {
      stateId: "state:query",
      target: { kind: "goal", id: "goal:main" },
      statement,
    },
    path,
  };
}

function associativeSelection(
  startOperand: number,
  endOperand: number,
  statement: Readonly<{ kind: "conclusion" }> | Readonly<{ kind: "hypothesis"; id: string }> = {
    kind: "conclusion",
  },
) {
  return {
    kind: "associative",
    anchor: {
      stateId: "state:query",
      target: { kind: "goal", id: "goal:main" },
      statement,
    },
    containerPath: [],
    startOperand,
    endOperand,
  };
}

const propositionWildcard = {
  id: "wildcard:proposition",
  symbol: "_proposition",
  role: "retrieval-wildcard",
  sort: PROPOSITION_SORT,
} as const;

function selectionQuery(
  subjects: readonly Readonly<{
    id: string;
    selection: ReturnType<typeof selection>;
    abstraction?: unknown;
  }>[],
) {
  return {
    kind: "selection-query",
    selections: subjects.map(({ id, selection: selected, abstraction }) => ({
      id,
      selection: selected,
      ...(abstraction === undefined ? {} : { abstraction }),
    })),
  };
}

function indexFor(catalog: Partial<RetrievalCatalog> = {}): RetrievalIndex {
  const created = createRetrievalIndex({
    results: catalog.results ?? CORE_LOGIC_RESULTS,
    moves: catalog.moves ?? HAND_AUTHORED_MOVES,
    variantFamilies: catalog.variantFamilies ?? [],
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.diagnostics[0].message);
  return created.index;
}

function suggestionIds(
  index: RetrievalIndex,
  proofState: ProofState,
  selected: unknown = selection(),
) {
  const result = index.query(proofState, selected, { limit: 100 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostics[0].message);
  return result.suggestions.map(({ id }) => id);
}

describe("deterministic structural retrieval", () => {
  it("indexes every theorem variant and move pattern", () => {
    const index = indexFor();
    expect(index).toMatchObject({ resultCount: 3, moveCount: 29, patternCount: 33 });
  });

  it("matches representation variants and ranks exact, obligation-free results deterministically", () => {
    const index = indexFor();
    const proofState = state(["And", "p", "q"]);
    const result = index.query(proofState, selection(), { limit: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.suggestions.map(({ artifactId }) => artifactId)).toContain(
      "result:conjunction-commutativity",
    );
    expect(
      result.suggestions.some(({ artifactId }) => artifactId === "move:split-goal-conjunction"),
    ).toBe(true);
    expect(
      result.suggestions.some(
        ({ artifactId }) => artifactId === "move:expand-hypothesis-conjunction",
      ),
    ).toBe(false);
    expect(result.suggestions[0]).toMatchObject({
      artifactId: "result:conjunction-commutativity",
      substitutions: [
        { symbol: "p", expression: "p" },
        { symbol: "q", expression: "q" },
      ],
    });
    expect(result.suggestions.every(({ reasons }) => reasons.length >= 3)).toBe(true);
    expect(
      result.suggestions.find(({ artifactId }) => artifactId === "move:split-goal-conjunction"),
    ).toMatchObject({ unresolvedParameters: [], applicability: "applicable" });
    expect(Object.isFrozen(result)).toBe(true);

    const wrapped = index.query(
      state({ fn: ["And", "p", "q"], comment: "display wrapper" }),
      selection(),
      { limit: 100 },
    );
    expect(wrapped.ok).toBe(true);
    if (wrapped.ok) {
      expect(
        wrapped.suggestions.some(
          ({ artifactId, exactRepresentationMatch }) =>
            artifactId === "result:conjunction-commutativity" && !exactRepresentationMatch,
        ),
      ).toBe(true);
    }
  });

  it("uses section and polarity so hypothesis and goal moves stay distinct", () => {
    const proofState = state("r", [
      { id: "hypothesis:conjunction", expression: ["And", "p", "q"] },
    ]);
    const ids = suggestionIds(
      indexFor(),
      proofState,
      selection({ kind: "hypothesis", id: "hypothesis:conjunction" }),
    );
    expect(ids.some((id) => id.includes("move:expand-hypothesis-conjunction"))).toBe(true);
    expect(ids.some((id) => id.includes("move:split-goal-conjunction"))).toBe(false);
  });

  it("does not offer whole-statement primitives for a nested occurrence", () => {
    const proofState = state(["And", "p", "q"], [{ id: "hypothesis:p", expression: "p" }]);
    const ids = suggestionIds(indexFor(), proofState, selection({ kind: "conclusion" }, [0]));
    expect(ids.some((id) => id.includes("close-by-hypothesis"))).toBe(false);
    expect(ids.some((id) => id.includes("split-goal-conjunction"))).toBe(false);
  });

  it("retrieves against a snapshot-anchored virtual range without treating it as a whole statement", () => {
    const proofState = state(["And", "p", "q", "r"]);
    const result = indexFor().query(proofState, associativeSelection(1, 3), { limit: 100 });
    expect(result).toMatchObject({
      ok: true,
      selection: {
        kind: "associative",
        fragment: ["And", "q", "r"],
        coveredOperandPaths: [[1], [2]],
      },
    });
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(
      result.suggestions.some(
        ({ artifactId }) => artifactId === "result:conjunction-commutativity",
      ),
    ).toBe(true);
    expect(
      result.suggestions.some(({ artifactId }) => artifactId === "move:split-goal-conjunction"),
    ).toBe(false);

    const hypothesisState = state("r", [
      { id: "hypothesis:disjunction", expression: ["Or", "p", "q", "r"] },
    ]);
    const hypothesisResult = indexFor().query(
      hypothesisState,
      associativeSelection(0, 2, {
        kind: "hypothesis",
        id: "hypothesis:disjunction",
      }),
      { limit: 100 },
    );
    expect(hypothesisResult.ok).toBe(true);
    if (hypothesisResult.ok) {
      expect(
        hypothesisResult.suggestions.some(
          ({ artifactId }) => artifactId === "move:split-hypothesis-disjunction",
        ),
      ).toBe(false);
    }
  });

  it("does not suggest local-fact moves when their required hypotheses are unavailable", () => {
    const index = indexFor();
    expect(suggestionIds(index, state("p")).some((id) => id.includes("close-by-hypothesis"))).toBe(
      false,
    );
    expect(
      suggestionIds(index, state("p", [{ id: "hypothesis:p", expression: "p" }])).some((id) =>
        id.includes("close-by-hypothesis"),
      ),
    ).toBe(true);

    const withoutAntecedent = state("r", [
      { id: "hypothesis:implication", expression: ["Implies", "p", "q"] },
    ]);
    const withAntecedent = state("r", [
      { id: "hypothesis:implication", expression: ["Implies", "p", "q"] },
      { id: "hypothesis:p", expression: "p" },
    ]);
    const implicationSelection = selection({
      kind: "hypothesis",
      id: "hypothesis:implication",
    });
    expect(
      suggestionIds(index, withoutAntecedent, implicationSelection).some((id) =>
        id.includes("apply-implication-hypothesis"),
      ),
    ).toBe(false);
    expect(
      suggestionIds(index, withAntecedent, implicationSelection).some((id) =>
        id.includes("apply-implication-hypothesis"),
      ),
    ).toBe(true);
  });

  it("filters moves with unavailable artifact dependencies", () => {
    const source = structuredClone(
      HAND_AUTHORED_MOVES.find(({ id }) => id === "move:split-goal-conjunction")!,
    );
    const dependent = moveDefinitionSchema.parse({
      ...source,
      id: "move:dependent-split",
      requiredArtifacts: [{ kind: "result", id: "result:external" }],
    });
    const index = indexFor({ results: [], moves: [dependent] });
    const proofState = state(["And", "p", "q"]);
    expect(suggestionIds(index, proofState)).toEqual([]);

    const available = index.query(proofState, selection(), {
      availableArtifacts: [{ kind: "result", id: "result:external" }],
      limit: 100,
    });
    expect(available).toMatchObject({
      ok: true,
      suggestions: [{ artifactId: "move:dependent-split" }],
    });
  });

  it("does not retrieve draft entries", () => {
    const source = structuredClone(HAND_AUTHORED_MOVES.find(({ id }) => id === "move:close-true")!);
    const draft = moveDefinitionSchema.parse({
      ...source,
      id: "move:draft-close-true",
      approval: { status: "draft" },
    });
    expect(suggestionIds(indexFor({ results: [], moves: [draft] }), state("True"))).toEqual([]);
  });

  it("enforces repeated wildcard consistency", () => {
    const source = structuredClone(CORE_LOGIC_RESULTS[0]!);
    const repeated = libraryResultSchema.parse({
      ...source,
      id: "result:repeated-conjunct",
      parameters: [source.parameters[0]],
      statement: { expression: ["Equivalent", ["And", "p", "p"], "p"] },
      patterns: [
        {
          ...source.patterns[0]!,
          id: "pattern:repeated-conjunct",
          expression: ["And", "p", "p"],
          requirement: { section: "goal", polarity: "positive", role: "proposition" },
        },
      ],
    });
    const index = indexFor({ results: [repeated], moves: [] });
    expect(suggestionIds(index, state(["And", "p", "q"]))).toEqual([]);
    expect(suggestionIds(index, state(["And", "q", "q"]))).toHaveLength(1);
  });

  it("keeps variants independent while exposing a related-forms group", () => {
    const source = structuredClone(CORE_LOGIC_RESULTS[1]!);
    const familyId = "variant-family:conjunction-test";
    const variants = ["left", "right"].map((suffix) =>
      libraryResultSchema.parse({
        ...source,
        id: `result:conjunction-${suffix}`,
        name: `Conjunction ${suffix} variant`,
        variantFamilyId: familyId,
        patterns: source.patterns.map((pattern) => ({
          ...pattern,
          id: `${pattern.id}-${suffix}`,
        })),
      }),
    );
    const family = variantFamilySchema.parse({
      id: familyId,
      name: "Conjunction variants",
      memberIds: variants.map(({ id }) => id),
    });
    const index = indexFor({ results: variants, moves: [], variantFamilies: [family] });
    const result = index.query(state(["And", "p", "q"]), selection(), { limit: 100 });
    expect(result).toMatchObject({
      ok: true,
      variantGroups: [{ familyId, name: "Conjunction variants" }],
    });
    if (result.ok) {
      expect(new Set(result.suggestions.map(({ artifactId }) => artifactId)).size).toBe(2);
      expect(result.variantGroups[0]?.suggestionIds).toHaveLength(4);
    }
  });

  it("assigns multiple selected occurrences injectively to move slots", () => {
    const index = indexFor();
    const proofState = state("p", [{ id: "hypothesis:p", expression: "p" }]);
    const subjects = [
      { id: "selection:target", selection: selection() },
      {
        id: "selection:fact",
        selection: selection({ kind: "hypothesis", id: "hypothesis:p" }),
      },
    ] as const;
    const forward = index.query(proofState, selectionQuery(subjects), { limit: 100 });
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    const close = forward.suggestions.filter(
      ({ artifactId }) => artifactId === "move:close-by-hypothesis",
    );
    expect(close).toHaveLength(1);
    expect(close[0]).toMatchObject({
      selectionMatches: [
        { selectionId: "selection:fact", selectionSlotId: "fact" },
        {
          selectionId: "selection:target",
          selectionSlotId: "target",
          patternId: "move-pattern:close-by-hypothesis",
        },
      ],
      unresolvedSelectionSlots: [],
      unresolvedParameters: [],
      applicability: "applicable",
      abstractionFit: "not-used",
    });

    const reversed = index.query(proofState, selectionQuery([...subjects].reverse()), {
      limit: 100,
    });
    expect(reversed.ok).toBe(true);
    if (reversed.ok) {
      expect(reversed.suggestions).toEqual(forward.suggestions);
      expect(reversed.selection).toMatchObject({
        kind: "selection-query",
        selections: [{ id: "selection:fact" }, { id: "selection:target" }],
      });
    }
  });

  it("rejects mismatched, cross-target, and additional selections instead of dropping them", () => {
    const index = indexFor();
    const mismatched = state("p", [{ id: "hypothesis:q", expression: "q" }]);
    expect(
      suggestionIds(
        index,
        mismatched,
        selectionQuery([
          { id: "selection:target", selection: selection() },
          {
            id: "selection:fact",
            selection: selection({ kind: "hypothesis", id: "hypothesis:q" }),
          },
        ]),
      ),
    ).toEqual([]);

    const mainTarget = state("p", [{ id: "hypothesis:p", expression: "p" }]);
    const crossTarget = proofStateSchema.parse({
      ...mainTarget,
      goals: [
        ...mainTarget.goals,
        {
          id: "goal:other",
          sequent: {
            context: {
              declarations,
              hypotheses: [{ id: "hypothesis:other-p", statement: { expression: "p" } }],
            },
            conclusion: { expression: "q" },
          },
        },
      ],
    });
    const otherFact = selection({ kind: "hypothesis", id: "hypothesis:other-p" });
    otherFact.anchor.target.id = "goal:other";
    expect(
      suggestionIds(
        index,
        crossTarget,
        selectionQuery([
          { id: "selection:target", selection: selection() },
          { id: "selection:other-fact", selection: otherFact },
        ]),
      ),
    ).toEqual([]);

    const extra = state("p", [
      { id: "hypothesis:p", expression: "p" },
      { id: "hypothesis:q", expression: "q" },
    ]);
    expect(
      suggestionIds(
        index,
        extra,
        selectionQuery([
          { id: "selection:target", selection: selection() },
          {
            id: "selection:p",
            selection: selection({ kind: "hypothesis", id: "hypothesis:p" }),
          },
          {
            id: "selection:q",
            selection: selection({ kind: "hypothesis", id: "hypothesis:q" }),
          },
        ]),
      ),
    ).toEqual([]);
  });

  it("searches every structural bucket for query-only whole-selection abstractions", () => {
    const index = indexFor();
    const proofState = state("p");
    const before = structuredClone(proofState);
    const result = index.query(
      proofState,
      selectionQuery([
        {
          id: "selection:abstracted",
          selection: selection(),
          abstraction: propositionWildcard,
        },
      ]),
      { limit: 100 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toMatchObject({
      kind: "selection-query",
      selections: [
        {
          id: "selection:abstracted",
          selection: { fragment: "p" },
          abstraction: propositionWildcard,
        },
      ],
    });
    expect(result.suggestions.map(({ artifactId }) => artifactId)).toEqual(
      expect.arrayContaining([
        "result:conjunction-commutativity",
        "result:excluded-middle",
        "move:split-goal-conjunction",
      ]),
    );
    expect(
      result.suggestions.every(
        ({ abstractionFit, applicability, exactRepresentationMatch }) =>
          abstractionFit === "compatible" &&
          applicability === "requires-input" &&
          !exactRepresentationMatch,
      ),
    ).toBe(true);
    expect(proofState).toEqual(before);
  });

  it("uses abstractions rather than hidden fragments for primitive relationships", () => {
    const proofState = state("p", [{ id: "hypothesis:q", expression: "q" }]);
    const result = indexFor().query(
      proofState,
      selectionQuery([
        {
          id: "selection:target",
          selection: selection(),
          abstraction: propositionWildcard,
        },
        {
          id: "selection:fact",
          selection: selection({ kind: "hypothesis", id: "hypothesis:q" }),
        },
      ]),
      { limit: 100 },
    );
    expect(result).toMatchObject({
      ok: true,
      suggestions: [
        {
          artifactId: "move:close-by-hypothesis",
          applicability: "requires-input",
          abstractionFit: "compatible",
        },
      ],
    });
  });

  it("uses abstraction sorts as conservative compatibility constraints", () => {
    const termState = proofStateSchema.parse({
      id: "state:query",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: [
                {
                  id: "declaration:x",
                  symbol: "x",
                  sort: { kind: "named", id: "sort:real" },
                  role: "universal-parameter",
                },
              ],
              hypotheses: [],
            },
            conclusion: { expression: ["Equal", "x", "x"] },
          },
        },
      ],
      obligations: [],
    });
    const source = structuredClone(HAND_AUTHORED_MOVES.find(({ id }) => id === "move:close-true")!);
    const termMove = moveDefinitionSchema.parse({
      ...source,
      id: "move:term-pattern",
      selectionContract: {
        slots: [
          {
            id: "term",
            role: "witness",
            semanticRole: "term",
            required: true,
          },
        ],
        allowAdditional: false,
      },
      patterns: [{ id: "move-pattern:term", selectionSlotId: "term", expression: "x" }],
      parameters: [],
    });
    const index = indexFor({ results: [], moves: [termMove] });
    const abstractedTerm = (sort: unknown) =>
      selectionQuery([
        {
          id: "selection:term",
          selection: selection({ kind: "conclusion" }, [0]),
          abstraction: {
            id: "wildcard:term",
            symbol: "_term",
            role: "retrieval-wildcard",
            sort,
          },
        },
      ]);

    expect(index.query(termState, abstractedTerm(PROPOSITION_SORT), { limit: 100 })).toMatchObject({
      ok: true,
      suggestions: [],
    });
    const namedSort = index.query(termState, abstractedTerm({ kind: "named", id: "sort:real" }), {
      limit: 100,
    });
    expect(namedSort).toMatchObject({
      ok: true,
      suggestions: [
        {
          artifactId: "move:term-pattern",
          abstractionFit: "unknown",
          applicability: "requires-input",
        },
      ],
    });
  });

  it("shares wildcard bindings across patterns on distinct selected slots", () => {
    const source = structuredClone(
      HAND_AUTHORED_MOVES.find(({ id }) => id === "move:apply-implication-hypothesis")!,
    );
    const paired = moveDefinitionSchema.parse({
      ...source,
      id: "move:paired-implication",
      patterns: [
        ...source.patterns,
        {
          id: "move-pattern:paired-antecedent",
          selectionSlotId: "antecedent",
          expression: "p",
        },
      ],
    });
    const proofState = state("r", [
      { id: "hypothesis:implication", expression: ["Implies", "p", "q"] },
      { id: "hypothesis:p", expression: "p" },
    ]);
    const query = selectionQuery([
      {
        id: "selection:implication",
        selection: selection({ kind: "hypothesis", id: "hypothesis:implication" }),
      },
      {
        id: "selection:antecedent",
        selection: selection({ kind: "hypothesis", id: "hypothesis:p" }),
      },
    ]);
    const result = indexFor({ results: [], moves: [paired] }).query(proofState, query, {
      limit: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      artifactId: "move:paired-implication",
      substitutions: [
        { symbol: "p", expression: "p" },
        { symbol: "q", expression: "q" },
      ],
      selectionMatches: [
        {
          selectionId: "selection:antecedent",
          selectionSlotId: "antecedent",
          patternId: "move-pattern:paired-antecedent",
        },
        {
          selectionId: "selection:implication",
          selectionSlotId: "implication",
          patternId: "move-pattern:apply-implication-hypothesis",
        },
      ],
      unresolvedSelectionSlots: ["target"],
    });
  });

  it("unifies repeated query holes across differently named artifact variables", () => {
    const source = structuredClone(
      HAND_AUTHORED_MOVES.find(({ id }) => id === "move:close-by-hypothesis")!,
    );
    const differentlyNamed = moveDefinitionSchema.parse({
      ...source,
      id: "move:differently-named-close",
      patterns: [
        { id: "move-pattern:close-target", selectionSlotId: "target", expression: "u" },
        { id: "move-pattern:close-fact", selectionSlotId: "fact", expression: "v" },
      ],
    });
    const proofState = state("p", [{ id: "hypothesis:p", expression: "p" }]);
    const sharedWildcard = {
      id: "wildcard:shared",
      symbol: "_shared",
      role: "retrieval-wildcard",
      sort: PROPOSITION_SORT,
    } as const;
    const result = indexFor({ results: [], moves: [differentlyNamed] }).query(
      proofState,
      {
        kind: "selection-query",
        selections: [
          {
            id: "selection:target",
            selection: selection(),
            abstraction: sharedWildcard,
          },
          {
            id: "selection:fact",
            selection: selection({ kind: "hypothesis", id: "hypothesis:p" }),
            abstraction: sharedWildcard,
          },
        ],
      },
      { limit: 100 },
    );
    expect(result).toMatchObject({
      ok: true,
      suggestions: [{ artifactId: "move:differently-named-close" }],
    });
  });

  it("does not share artifact bindings across distinct lexical binder scopes", () => {
    const source = structuredClone(HAND_AUTHORED_MOVES.find(({ id }) => id === "move:close-true")!);
    const scoped = moveDefinitionSchema.parse({
      ...source,
      id: "move:scoped-pair",
      selectionContract: {
        slots: [
          { id: "left", role: "rewrite-occurrence", semanticRole: "proposition", required: true },
          { id: "right", role: "rewrite-occurrence", semanticRole: "proposition", required: true },
        ],
        allowAdditional: false,
      },
      patterns: [
        { id: "move-pattern:scoped-left", selectionSlotId: "left", expression: "u" },
        { id: "move-pattern:scoped-right", selectionSlotId: "right", expression: "u" },
      ],
      parameters: [],
    });
    const proofState = state(["And", ["ForAll", "p", "p"], "p"]);
    const result = indexFor({ results: [], moves: [scoped] }).query(
      proofState,
      selectionQuery([
        { id: "selection:bound", selection: selection({ kind: "conclusion" }, [0, 1]) },
        { id: "selection:free", selection: selection({ kind: "conclusion" }, [1]) },
      ]),
      { limit: 100 },
    );
    expect(result).toMatchObject({ ok: true, suggestions: [] });

    const sharedWildcard = {
      id: "wildcard:scoped",
      symbol: "_scoped",
      role: "retrieval-wildcard",
      sort: PROPOSITION_SORT,
    } as const;
    expect(
      indexFor({ results: [], moves: [scoped] }).query(
        proofState,
        selectionQuery([
          {
            id: "selection:bound",
            selection: selection({ kind: "conclusion" }, [0, 1]),
            abstraction: sharedWildcard,
          },
          {
            id: "selection:free",
            selection: selection({ kind: "conclusion" }, [1]),
            abstraction: sharedWildcard,
          },
        ]),
        { limit: 100 },
      ),
    ).toMatchObject({ ok: true, suggestions: [] });
  });

  it("returns the same stable order when catalog insertion order changes", () => {
    const proofState = state(["And", "p", "q"]);
    const forward = suggestionIds(indexFor(), proofState);
    const reversed = suggestionIds(
      indexFor({
        results: [...CORE_LOGIC_RESULTS].reverse(),
        moves: [...HAND_AUTHORED_MOVES].reverse(),
      }),
      proofState,
    );
    expect(reversed).toEqual(forward);
  });
});

function premiseResult(
  id: string,
  premises: readonly PlainMathJson[],
  sideConditions: readonly unknown[] = [],
  extraParameters: readonly string[] = [],
) {
  const source = structuredClone(CORE_LOGIC_RESULTS[1]!);
  return libraryResultSchema.parse({
    ...source,
    id,
    name: `Premise result ${id}`,
    parameters: [
      ...source.parameters,
      ...extraParameters.map((symbol) => ({
        id: `declaration:extra-${symbol}`,
        symbol,
        sort: PROPOSITION_SORT,
        role: "universal-parameter",
      })),
    ],
    statement: { expression: ["And", "p", "q"] },
    premises: premises.map((expression) => ({ expression })),
    sideConditions,
    applicationDirections: ["backward"],
    patterns: [
      {
        id: `pattern:${id}`,
        expression: ["And", "p", "q"],
        direction: "backward",
        requirement: { section: "goal", polarity: "positive", role: "proposition" },
      },
    ],
  });
}

function suggestionCategory(
  suggestion: Readonly<{ applicability: string; rank: readonly number[] }>,
) {
  if (suggestion.applicability === "requires-input") return "requires-input";
  return suggestion.rank[1] === 1 ? "immediate" : "with-obligations";
}

describe("variadic associative matching", () => {
  // Mirrors the development session: the goal is a ternary conjunction.
  const developmentState = () =>
    state(
      ["And", "p", "p", "q"],
      [
        { id: "hypothesis:conjunction", expression: ["And", "p", "q"] },
        { id: "hypothesis:q", expression: "q" },
      ],
    );

  it("offers the variadic conjunction primitives for an n-ary conjunction at the default limit", () => {
    const index = indexFor();
    const goalOnly = index.query(developmentState(), selection());
    expect(goalOnly.ok).toBe(true);
    if (!goalOnly.ok) return;
    expect(
      goalOnly.suggestions.find(({ artifactId }) => artifactId === "move:split-goal-conjunction"),
    ).toMatchObject({
      applicability: "applicable",
      substitutions: [
        { symbol: "p", expression: "p" },
        { symbol: "q", expression: ["And", "p", "q"] },
      ],
    });

    const both = index.query(
      developmentState(),
      selectionQuery([
        { id: "selection:target", selection: selection() },
        {
          id: "selection:conjunction",
          selection: selection({ kind: "hypothesis", id: "hypothesis:conjunction" }),
        },
      ]),
    );
    expect(both.ok).toBe(true);
    if (!both.ok) return;
    expect(
      both.suggestions.find(
        ({ artifactId }) => artifactId === "move:expand-hypothesis-conjunction",
      ),
    ).toMatchObject({ applicability: "applicable", unresolvedSelectionSlots: [] });
  });

  it("matches a ternary conjunction hypothesis with the binary move pattern", () => {
    const proofState = state("r", [
      { id: "hypothesis:triple", expression: ["And", "p", "q", "r"] },
    ]);
    const result = indexFor().query(
      proofState,
      selection({ kind: "hypothesis", id: "hypothesis:triple" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestions.map(({ artifactId }) => artifactId)).toContain(
      "move:expand-hypothesis-conjunction",
    );
  });

  it("never groups variadic operands for result instances", () => {
    const ids = suggestionIds(indexFor(), state(["And", "p", "q", "r"]));
    expect(ids.some((id) => id.includes("result:conjunction-commutativity"))).toBe(false);
    expect(ids.some((id) => id.includes("move:split-goal-conjunction"))).toBe(true);
  });
});

describe("typed unification and side-condition evaluation", () => {
  const realDeclarations = [
    { id: "declaration:p", symbol: "p", sort: PROPOSITION_SORT, role: "universal-parameter" },
    {
      id: "declaration:n",
      symbol: "n",
      sort: { kind: "named", id: "sort:real" },
      role: "universal-parameter",
    },
  ] as const;

  function equalityState(conclusion: PlainMathJson): ProofState {
    return proofStateSchema.parse({
      id: "state:query",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: { declarations: realDeclarations, hypotheses: [] },
            conclusion: { expression: conclusion },
          },
        },
      ],
      obligations: [],
    });
  }

  const reflexivity = libraryResultSchema.parse({
    ...structuredClone(CORE_LOGIC_RESULTS[2]!),
    id: "result:real-reflexivity",
    name: "Reflexivity of real equality",
    parameters: [
      {
        id: "declaration:real-x",
        symbol: "x",
        sort: { kind: "named", id: "sort:real" },
        role: "universal-parameter",
      },
    ],
    statement: { expression: ["Equal", "x", "x"] },
    patterns: [
      {
        id: "pattern:real-reflexivity",
        expression: ["Equal", "x", "x"],
        direction: "forward",
        requirement: { section: "any", polarity: "any", role: "proposition" },
      },
    ],
  });

  it("rejects bindings whose sort contradicts the declared parameter sort", () => {
    const index = indexFor({ results: [reflexivity], moves: [] });
    expect(suggestionIds(index, equalityState(["Equal", "p", "p"]))).toEqual([]);
    const real = index.query(equalityState(["Equal", "n", "n"]), selection(), { limit: 100 });
    expect(real).toMatchObject({
      ok: true,
      suggestions: [{ artifactId: "result:real-reflexivity", applicability: "applicable" }],
    });
    if (real.ok) expect(real.suggestions[0]?.rank.slice(1, 4)).toEqual([1, 1, 1]);
    expect(suggestionIds(index, equalityState(["Equal", 2, 2]))).toHaveLength(1);
  });

  it("treats terms with undeclared symbols as compatible but not exactly typed", () => {
    const context = { declarations: [], hypotheses: [], operators: [], sortCache: new Map() };
    expect(bindingsTypeFit(reflexivity, new Map([["x", "unknownSymbol"]]), context)).toBe(
      "unknown",
    );
    expect(bindingsTypeFit(reflexivity, new Map([["x", "True"]]), context)).toBe("mismatch");
    expect(bindingsTypeFit(reflexivity, new Map([["x", 3]]), context)).toBe("exact");
  });

  it("uses available hypotheses to avoid predicted obligations", () => {
    const index = indexFor({ results: [premiseResult("result:needs-p-q", ["p", "q"])], moves: [] });
    const partial = index.query(
      state(["And", "p", "q"], [{ id: "hypothesis:p", expression: "p" }]),
      selection(),
      { limit: 100 },
    );
    expect(partial).toMatchObject({
      ok: true,
      suggestions: [{ artifactId: "result:needs-p-q", applicability: "applicable" }],
    });
    if (!partial.ok) return;
    expect(partial.suggestions[0]?.rank[1]).toBe(0);
    expect(partial.suggestions[0]?.reasons).toContain(
      "Applies if premise 2 is proved; it becomes a new obligation.",
    );

    const complete = index.query(
      state(
        ["And", "p", "q"],
        [
          { id: "hypothesis:p", expression: "p" },
          { id: "hypothesis:q", expression: "q" },
        ],
      ),
      selection(),
      { limit: 100 },
    );
    expect(complete.ok).toBe(true);
    if (!complete.ok) return;
    expect(complete.suggestions[0]?.rank.slice(0, 3)).toEqual([1, 1, 1]);
    expect(complete.suggestions[0]?.reasons).toContain(
      "Every premise and side condition is already available as a hypothesis.",
    );
  });

  it("predicts obligations for prose side conditions and input for undetermined parameters", () => {
    const prose = premiseResult(
      "result:prose-side-condition",
      [],
      [{ id: "side-condition:prose", description: "the carrier is nonempty" }],
    );
    const undetermined = premiseResult("result:undetermined", ["r"], [], ["r"]);
    const result = indexFor({ results: [prose, undetermined], moves: [] }).query(
      state(["And", "p", "q"]),
      selection(),
      { limit: 100 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.suggestions.find(({ artifactId }) => artifactId === "result:prose-side-condition"),
    ).toMatchObject({
      applicability: "applicable",
      reasons: expect.arrayContaining([
        'Applies if side condition "the carrier is nonempty" holds; it becomes a new obligation.',
      ]),
    });
    expect(
      result.suggestions.find(({ artifactId }) => artifactId === "result:undetermined"),
    ).toMatchObject({
      applicability: "requires-input",
      unresolvedParameters: ["declaration:extra-r"],
    });
  });
});

describe("deterministic category diversity", () => {
  it("reserves slots for each category when the limit truncates", () => {
    const nearMiss = premiseResult("result:near-miss", [["Or", "p", "q"]]);
    const index = indexFor({ results: [...CORE_LOGIC_RESULTS, nearMiss] });
    const proofState = state(["And", "p", "q"]);
    const full = index.query(proofState, selection(), { limit: 100 });
    const truncated = index.query(proofState, selection(), { limit: 4 });
    expect(full.ok && truncated.ok).toBe(true);
    if (!full.ok || !truncated.ok) return;
    const fullIds = full.suggestions.map(({ id }) => id);
    // Plain rank order would fill all four slots with immediately applicable entries.
    expect(full.suggestions.slice(0, 4).map(suggestionCategory)).toEqual([
      "immediate",
      "immediate",
      "immediate",
      "immediate",
    ]);
    expect(truncated.suggestions.map(suggestionCategory)).toEqual([
      "immediate",
      "immediate",
      "requires-input",
      "with-obligations",
    ]);
    expect(truncated.suggestions.map(({ artifactId }) => artifactId)).toContain("result:near-miss");
    const truncatedIds = truncated.suggestions.map(({ id }) => id);
    expect(truncatedIds).toEqual(fullIds.filter((id) => truncatedIds.includes(id)));
  });

  it("ranks bare-variable catch-all moves below structural matches", () => {
    const result = indexFor({ results: [] }).query(state(["And", "p", "q"]), selection(), {
      limit: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suggestions[0]?.artifactId).toBe("move:split-goal-conjunction");
    const markSorry = result.suggestions.find(({ artifactId }) => artifactId === "move:mark-sorry");
    expect(markSorry?.rank[4]).toBe(-1);
  });
});

describe("retrieval performance", () => {
  it("answers a typical query on a 1000-result catalog within 150 ms", () => {
    const connectives = ["And", "Or", "Implies", "Equivalent"] as const;
    let seed = 7;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    const leaves = ["p", "q", "r", "True", "False"];
    const expression = (depth: number): PlainMathJson => {
      const choice = next(10);
      if (depth === 0 || choice < 3) return leaves[next(leaves.length)]!;
      if (choice === 3) return ["Not", expression(depth - 1)];
      return [connectives[next(connectives.length)]!, expression(depth - 1), expression(depth - 1)];
    };
    const source = structuredClone(CORE_LOGIC_RESULTS[1]!);
    const results = Array.from({ length: 1000 }, (_, index) => {
      const pattern = index % 97 === 0 ? "p" : expression(3);
      return {
        ...source,
        id: `result:synthetic-${index}`,
        name: `Synthetic ${index}`,
        parameters: ["p", "q", "r"].map((symbol) => ({
          id: `declaration:synthetic-${symbol}`,
          symbol,
          sort: PROPOSITION_SORT,
          role: "universal-parameter",
        })),
        statement: { expression: pattern },
        premises: index % 5 === 0 ? [{ expression: "q" }] : [],
        applicationDirections: ["forward"],
        patterns: [
          {
            id: `pattern:synthetic-${index}`,
            expression: pattern,
            direction: "forward",
            requirement: { section: "any", polarity: "any", role: "proposition" },
          },
        ],
      };
    });
    const created = createRetrievalIndex({
      results,
      moves: HAND_AUTHORED_MOVES,
      variantFamilies: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.index.resultCount).toBe(1000);
    const proofState = state(
      ["Implies", ["And", "p", "q"], ["Or", "q", ["Not", "p"]]],
      [{ id: "hypothesis:q", expression: "q" }],
    );
    const timings: number[] = [];
    let suggestionCount = 0;
    for (let run = 0; run < 7; run += 1) {
      const started = performance.now();
      const result = created.index.query(proofState, selection(), { limit: 20 });
      timings.push(performance.now() - started);
      expect(result.ok).toBe(true);
      if (result.ok) suggestionCount = result.suggestions.length;
    }
    const median = [...timings].sort((left, right) => left - right)[3]!;
    process.stdout.write(
      `retrieval over 1000 results: median ${median.toFixed(2)} ms; runs ${timings
        .map((timing) => timing.toFixed(2))
        .join(", ")} ms; ${suggestionCount} suggestions\n`,
    );
    expect(suggestionCount).toBeGreaterThan(0);
    expect(median).toBeLessThan(150);
  }, 60_000);
});

describe("retrieval boundary validation", () => {
  it("rejects stale selections and invalid limits", () => {
    const index = indexFor();
    expect(
      index.query(state("p"), {
        ...selection(),
        anchor: { ...selection().anchor, stateId: "state:stale" },
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "selection-rejected" }],
    });
    expect(index.query(state("p"), selection(), { limit: 0 })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-query" }],
    });
  });

  it("rejects duplicate IDs, broken variant links, and hostile catalogs", () => {
    expect(
      createRetrievalIndex({
        results: [CORE_LOGIC_RESULTS[0], CORE_LOGIC_RESULTS[0]],
        moves: [],
        variantFamilies: [],
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-catalog" }] });

    const linked = libraryResultSchema.parse({
      ...structuredClone(CORE_LOGIC_RESULTS[0]!),
      id: "result:linked",
      variantFamilyId: "variant-family:missing",
    });
    expect(
      createRetrievalIndex({ results: [linked], moves: [], variantFamilies: [] }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-catalog" }] });

    let invoked = false;
    const hostile = Object.defineProperty({}, "results", {
      enumerable: true,
      get() {
        invoked = true;
        return [];
      },
    });
    expect(createRetrievalIndex(hostile)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-catalog" }],
    });
    expect(invoked).toBe(false);
  });
});
