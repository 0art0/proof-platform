import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SET_OPERATOR_DECLARATIONS, type LibraryResult } from "@proof/library";
import {
  PROPOSITION_SORT,
  RESERVED_BUILTIN_SYMBOLS,
  createStatementViewSchema,
  declarationIdSchema,
  freeSymbolNames,
  freshSymbolName,
  sortSchema,
  type Declaration,
  type OperatorDeclaration,
  type PlainMathJson,
  type Sort,
} from "@proof/mathjson-model";
import { bindingsTypeFit, type FilterContext, type TypeFit } from "./filtering";

const REAL: Sort = sortSchema.parse({ kind: "named", id: "sort:real" });
const ELEMENT: Sort = sortSchema.parse({ kind: "named", id: "sort:element" });

function declaration(id: string, symbol: string, sort: Sort): Declaration {
  return {
    id: declarationIdSchema.parse(id),
    symbol,
    sort,
    role: "universal-parameter",
  };
}

function contextFor(
  declarations: readonly Declaration[],
  operators: readonly OperatorDeclaration[] = [],
): FilterContext {
  return { declarations, hypotheses: [], operators, sortCache: new Map() };
}

/** The sort fit of one term for a result with a single parameter of the expected sort. */
function fit(term: PlainMathJson, expected: Sort, context: FilterContext): TypeFit {
  const result = { parameters: [{ symbol: "p", sort: expected }] } as unknown as LibraryResult;
  return bindingsTypeFit(result, new Map([["p", term]]), context);
}

/**
 * The straightforward algorithm the memoized one must agree with: everything about the probe is
 * recomputed from the context and the term, and nothing is shared between terms.
 */
function referenceFit(term: PlainMathJson, expected: Sort, context: FilterContext): TypeFit {
  const declared = new Set<string>([
    ...context.declarations.map(({ symbol }) => symbol),
    ...context.operators.map(({ symbol }) => symbol),
  ]);
  const free = freeSymbolNames(term, { operators: context.operators });
  if (free.some((symbol) => !declared.has(symbol) && !RESERVED_BUILTIN_SYMBOLS.has(symbol))) {
    return "unknown";
  }
  const usedSymbols = new Set<string>([...declared, ...free]);
  const usedIds = new Set<string>(context.declarations.map(({ id }) => id));
  let probeId = "declaration:retrieval-sort-probe";
  for (let suffix = 1; usedIds.has(probeId); suffix += 1) {
    probeId = `declaration:retrieval-sort-probe-${suffix}`;
  }
  const probe = freshSymbolName("SortProbe", usedSymbols);
  try {
    return createStatementViewSchema({
      declarations: [
        ...context.declarations,
        declaration(probeId, probe, {
          kind: "function",
          signature: { parameters: [expected], result: PROPOSITION_SORT },
        }),
      ],
      operators: context.operators,
    }).safeParse({ expression: [probe, term] }).success
      ? "exact"
      : "mismatch";
  } catch {
    return "unknown";
  }
}

describe("sort fit of a bound term", () => {
  const real = declaration("declaration:x", "x", REAL);
  const proposition = declaration("declaration:q", "q", PROPOSITION_SORT);

  it("checks several expected sorts against one context without mixing them up", () => {
    const context = contextFor([real, proposition]);
    expect(fit("x", REAL, context)).toBe("exact");
    expect(fit("x", PROPOSITION_SORT, context)).toBe("mismatch");
    expect(fit("q", PROPOSITION_SORT, context)).toBe("exact");
    expect(fit("q", REAL, context)).toBe("mismatch");
    // The same sorts again, now served by the validators the first checks built.
    expect(fit(["Add", "x", 1], REAL, context)).toBe("exact");
    expect(fit(["Not", "q"], PROPOSITION_SORT, context)).toBe("exact");
    expect(fit(["Not", "x"], PROPOSITION_SORT, context)).toBe("mismatch");
  });

  it("does not carry a context's declarations over to another context", () => {
    const asReal = contextFor([real]);
    const asProposition = contextFor([declaration("declaration:x", "x", PROPOSITION_SORT)]);
    expect(fit("x", REAL, asReal)).toBe("exact");
    expect(fit("x", REAL, asProposition)).toBe("mismatch");
    expect(fit("x", REAL, asReal)).toBe("exact");
    // The same declarations under different operators are a different environment.
    const withOperators = contextFor(asReal.declarations, SET_OPERATOR_DECLARATIONS);
    expect(fit(["Union", "x", "x"], REAL, withOperators)).toBe("mismatch");
    expect(fit(["Union", "x", "x"], REAL, asReal)).toBe("unknown");
  });

  it("picks a probe symbol that avoids the declared symbols", () => {
    const clashing = contextFor([declaration("declaration:probe", "SortProbe", REAL), real]);
    expect(fit(["Add", "SortProbe", "x"], REAL, clashing)).toBe("exact");
    expect(fit("SortProbe", PROPOSITION_SORT, clashing)).toBe("mismatch");
    const clashingId = contextFor([
      declaration("declaration:retrieval-sort-probe", "x", REAL),
      declaration("declaration:retrieval-sort-probe-1", "y", REAL),
    ]);
    expect(fit(["Add", "x", "y"], REAL, clashingId)).toBe("exact");
  });

  it("agrees with the unshared algorithm on arbitrary contexts, terms and sorts", () => {
    // Mostly declarable symbols, so that terms often reach the probe; a few that never are
    // declared (`z`), are reserved (`True`), or collide with the set operators (`Union`).
    const declarable = ["x", "y", "q", "SortProbe", "SortProbe_1"] as const;
    const sorts = fc.constantFrom<Sort>(REAL, REAL, PROPOSITION_SORT, ELEMENT);
    const leaf = fc.oneof(
      { weight: 8, arbitrary: fc.constantFrom<PlainMathJson>(...declarable) },
      { weight: 1, arbitrary: fc.constantFrom<PlainMathJson>("z", "True", "Union") },
      { weight: 3, arbitrary: fc.integer({ min: 0, max: 9 }) },
    );
    const term = fc.letrec<{ term: PlainMathJson }>((tie) => ({
      term: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        leaf,
        fc.tuple(
          fc.constantFrom("Add", "Multiply", "Equal", "And", "Union"),
          tie("term"),
          tie("term"),
        ),
        fc.tuple(fc.constant("Not"), tie("term")),
      ) as fc.Arbitrary<PlainMathJson>,
    })).term;
    const environment = fc.record({
      declared: fc.uniqueArray(fc.tuple(fc.constantFrom(...declarable), sorts), {
        selector: ([symbol]) => symbol,
        maxLength: 5,
      }),
      declareUnion: fc.boolean(),
      useSetOperators: fc.boolean(),
      probeIdTaken: fc.boolean(),
      checks: fc.array(fc.tuple(term, sorts), { minLength: 1, maxLength: 12 }),
    });
    const outcomes = new Set<TypeFit>();
    fc.assert(
      fc.property(
        environment,
        ({ declared, declareUnion, useSetOperators, probeIdTaken, checks }) => {
          const declarations = [
            ...declared.map(([symbol, sort], index) =>
              declaration(`declaration:d${index}`, symbol, sort),
            ),
            ...(declareUnion && declared.length % 2 === 0
              ? [declaration("declaration:union", "Union", ELEMENT)]
              : []),
            ...(probeIdTaken
              ? [declaration("declaration:retrieval-sort-probe", "taken", REAL)]
              : []),
          ];
          const operators = useSetOperators ? SET_OPERATOR_DECLARATIONS : [];
          // One context object shared by every check, as a query shares it across candidates.
          const shared = contextFor(declarations, operators);
          for (const [checked, expected] of checks) {
            const actual = fit(checked, expected, shared);
            outcomes.add(actual);
            expect(actual).toBe(
              referenceFit(checked, expected, contextFor(declarations, operators)),
            );
          }
        },
      ),
      { numRuns: 300 },
    );
    // The generator must reach every outcome, or the comparison proves little.
    expect([...outcomes].sort()).toEqual(["exact", "mismatch", "unknown"]);
  });
});
