import { describe, expect, it } from "vitest";
import { CORE_LOGIC_RESULTS, libraryResultSchema, variantFamilySchema } from "@proof/library";
import {
  PROPOSITION_SORT,
  proofStateSchema,
  type PlainMathJson,
  type ProofState,
} from "@proof/mathjson-model";
import { HAND_AUTHORED_MOVES, moveDefinitionSchema } from "@proof/moves";
import { createRetrievalIndex, type RetrievalCatalog, type RetrievalIndex } from "./index";

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
    expect(index).toMatchObject({ resultCount: 3, moveCount: 15, patternCount: 19 });
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
      result.suggestions.some(({ unresolvedParameters }) => unresolvedParameters.length > 0),
    ).toBe(true);
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
      unresolvedParameters: ["hypothesisId"],
      applicability: "requires-input",
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
