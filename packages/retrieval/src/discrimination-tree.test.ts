import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PlainMathJson } from "@proof/mathjson-model";
import { DiscriminationTree, patternKeys, WILDCARD_EDGE } from "./discrimination-tree";
import {
  functionParts,
  groupedAssociativeOperands,
  matchPattern,
  symbolValue,
  usesAssociativeGrouping,
  type PatternMatchOptions,
} from "./matching";

const VARIABLES: ReadonlySet<string> = new Set(["X", "Y", "Z", "F"]);
const QUERY_HOLE = "_hole";
const GROUPED: PatternMatchOptions = { associativeGrouping: true };
const EXACT: PatternMatchOptions = { associativeGrouping: false };

const constant = fc.constantFrom<PlainMathJson>("a", "b", 1, 2, { sym: "a" }, { num: "3" });

function termArbitrary(leaves: fc.Arbitrary<PlainMathJson>): fc.Arbitrary<PlainMathJson> {
  const { term } = fc.letrec<{ term: PlainMathJson }>((tie) => ({
    term: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      leaves,
      fc
        .tuple(fc.constantFrom("f", "Not"), tie("term"))
        .map(([head, operand]): PlainMathJson => [head, operand]),
      fc
        .tuple(fc.constantFrom("g", "Implies"), tie("term"), tie("term"))
        .map(([head, left, right]): PlainMathJson => [head, left, right]),
      fc
        .tuple(
          fc.constantFrom("And", "Or", "Add"),
          fc.array(tie("term"), { minLength: 2, maxLength: 4 }),
        )
        .map(([head, operands]): PlainMathJson => [head, ...operands]),
      fc
        .tuple(tie("term"), tie("term"))
        .map(([left, right]): PlainMathJson => ({ fn: ["And", left, right] })),
    ),
  }));
  return term;
}

const queryTerm = termArbitrary(constant);
const patternTerm = fc.oneof(
  termArbitrary(fc.oneof(constant, fc.constantFrom<PlainMathJson>("X", "Y", "Z"))),
  fc
    .tuple(termArbitrary(fc.constantFrom<PlainMathJson>("X", "a")))
    .map(([operand]) => ["F", operand, "Y"] as PlainMathJson),
);
const queryWithHoles = termArbitrary(fc.oneof(constant, fc.constant<PlainMathJson>(QUERY_HOLE)));

type StoredPattern = Readonly<{ id: number; pattern: PlainMathJson; options: PatternMatchOptions }>;

function treeFor(patterns: readonly StoredPattern[]): DiscriminationTree<StoredPattern> {
  const tree = new DiscriminationTree<StoredPattern>();
  patterns.forEach((entry) =>
    tree.insert(entry.pattern, VARIABLES, entry.options, `bucket:${entry.id % 3}`, entry),
  );
  return tree;
}

const storedPatterns = fc
  .array(fc.tuple(patternTerm, fc.boolean()), { maxLength: 12 })
  .map((entries) =>
    entries.map(([pattern, grouped], id) => ({ id, pattern, options: grouped ? GROUPED : EXACT })),
  );

/**
 * Brute-force matching where a query hole matches any pattern subtree. Pattern
 * variables ignore repeated-binding consistency, so this relation contains
 * every exact match and the tree must still retrieve all of it.
 */
function holeMatches(
  pattern: PlainMathJson,
  query: PlainMathJson,
  options: PatternMatchOptions,
): boolean {
  if (query === QUERY_HOLE) return true;
  const patternSymbol = symbolValue(pattern);
  if (patternSymbol !== undefined && VARIABLES.has(patternSymbol)) return true;
  const patternParts = functionParts(pattern);
  const queryParts = functionParts(query);
  if (patternParts !== undefined || queryParts !== undefined) {
    if (patternParts === undefined || queryParts === undefined) return false;
    if (!VARIABLES.has(patternParts.operator) && patternParts.operator !== queryParts.operator) {
      return false;
    }
    const operands =
      usesAssociativeGrouping(patternParts, VARIABLES, options) && queryParts.operands.length > 2
        ? groupedAssociativeOperands(queryParts.operator, queryParts.operands)
        : queryParts.operands;
    return (
      operands !== undefined &&
      operands.length === patternParts.operands.length &&
      patternParts.operands.every((operand, index) =>
        holeMatches(operand, operands[index] as PlainMathJson, options),
      )
    );
  }
  return matchPattern(pattern, query, VARIABLES, options) !== undefined;
}

describe("discrimination tree", () => {
  it("retrieves a superset of brute-force first-order matching", () => {
    fc.assert(
      fc.property(storedPatterns, queryTerm, (patterns, query) => {
        const retrieved = new Set(
          treeFor(patterns)
            .retrieve(query)
            .map(({ id }) => id),
        );
        patterns.forEach(({ id, pattern, options }) => {
          if (matchPattern(pattern, query, VARIABLES, options) !== undefined) {
            expect(retrieved.has(id)).toBe(true);
          }
        });
      }),
      { numRuns: 500 },
    );
  });

  it("retrieves every pattern that a query with abstraction holes can match", () => {
    fc.assert(
      fc.property(storedPatterns, queryWithHoles, (patterns, query) => {
        const retrieved = new Set(
          treeFor(patterns)
            .retrieve(query, { isQueryWildcard: (term) => term === QUERY_HOLE })
            .map(({ id }) => id),
        );
        patterns.forEach(({ id, pattern, options }) => {
          if (holeMatches(pattern, query, options)) expect(retrieved.has(id)).toBe(true);
        });
      }),
      { numRuns: 500 },
    );
  });

  it("filters leaf buckets without dropping matches from accepted buckets", () => {
    fc.assert(
      fc.property(storedPatterns, queryTerm, (patterns, query) => {
        const retrieved = treeFor(patterns).retrieve(query, {
          acceptBucket: (bucket) => bucket === "bucket:0",
        });
        expect(retrieved.every(({ id }) => id % 3 === 0)).toBe(true);
        const ids = new Set(retrieved.map(({ id }) => id));
        patterns.forEach(({ id, pattern, options }) => {
          if (id % 3 === 0 && matchPattern(pattern, query, VARIABLES, options) !== undefined) {
            expect(ids.has(id)).toBe(true);
          }
        });
      }),
      { numRuns: 200 },
    );
  });

  it("prunes on heads, arities, symbols, and literals", () => {
    const patterns: StoredPattern[] = [
      { id: 0, pattern: ["And", "X", "Y"], options: EXACT },
      { id: 1, pattern: ["And", "X", "Y"], options: GROUPED },
      { id: 2, pattern: ["Or", "X", "Y"], options: GROUPED },
      { id: 3, pattern: "X", options: EXACT },
      { id: 4, pattern: ["And", "a", "X", "Y"], options: EXACT },
      { id: 5, pattern: ["F", "X"], options: EXACT },
      { id: 6, pattern: 1, options: EXACT },
    ];
    const tree = treeFor(patterns);
    const ids = (query: PlainMathJson) =>
      tree
        .retrieve(query)
        .map(({ id }) => id)
        .sort();
    expect(ids(["And", "a", "b"])).toEqual([0, 1, 3]);
    expect(ids(["And", "a", "b", "c"])).toEqual([1, 3, 4]);
    expect(ids(["Or", "a"])).toEqual([3, 5]);
    expect(ids(1)).toEqual([3, 6]);
    expect(ids("a")).toEqual([3]);
    expect(tree.size).toBe(7);
    expect(patternKeys(["And", "X", ["F", "a"]], VARIABLES, GROUPED)).toEqual([
      ["fnv:And", 2],
      [WILDCARD_EDGE, 0],
      ["fn:*/1", 1],
      ["sym:a", 0],
    ]);
  });
});
