import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { statementKey } from "./library-proposal";

/**
 * A top-up repeats nothing the session library already holds. Two results coincide when their
 * premises and statement agree up to the names of their parameters (and nothing else).
 */

const parameter = (symbol: string) => ({ symbol });
function shape(symbols: readonly string[], premises: unknown[], statement: unknown) {
  return {
    parameters: symbols.map(parameter),
    premises: premises.map((expression) => ({ expression })),
    statement: { expression: statement },
  } as never;
}

describe("statementKey", () => {
  it("ignores the names of the parameters, but not their roles", () => {
    const transitive = shape(
      ["a", "b", "c"],
      [
        ["Divides", "a", "b"],
        ["Divides", "b", "c"],
      ],
      ["Divides", "a", "c"],
    );
    const renamed = shape(
      ["x", "y", "z"],
      [
        ["Divides", "x", "y"],
        ["Divides", "y", "z"],
      ],
      ["Divides", "x", "z"],
    );
    const crossed = shape(
      ["a", "b", "c"],
      [
        ["Divides", "a", "b"],
        ["Divides", "c", "b"],
      ],
      ["Divides", "a", "c"],
    );
    expect(statementKey(renamed)).toBe(statementKey(transitive));
    expect(statementKey(crossed)).not.toBe(statementKey(transitive));
  });

  it("tells premises, statements and operators apart", () => {
    const base = shape(["a"], [], ["Divides", "a", "a"]);
    expect(statementKey(shape(["a"], [["Divides", "a", "a"]], ["Divides", "a", "a"]))).not.toBe(
      statementKey(base),
    );
    expect(statementKey(shape(["a"], [], ["Equal", "a", "a"]))).not.toBe(statementKey(base));
    expect(statementKey(shape(["a"], [], ["Divides", "a", 1]))).not.toBe(statementKey(base));
  });

  it("is invariant under any injective renaming of the parameters", () => {
    const names = ["a", "b", "c", "d", "p", "q", "r", "s", "t", "u"];
    fc.assert(
      fc.property(
        fc.shuffledSubarray(names, { minLength: 4, maxLength: 4 }),
        fc.shuffledSubarray(names, { minLength: 4, maxLength: 4 }),
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 2, maxLength: 6 }),
        (left, right, picks) => {
          const build = (symbols: readonly string[]) => {
            const [first, ...rest] = picks.map((pick) => symbols[pick] as string);
            const premises = rest.map((symbol) => ["Divides", first, symbol]);
            return shape(symbols, premises.slice(0, 2), ["Divides", first, rest.at(-1)]);
          };
          expect(statementKey(build(right))).toBe(statementKey(build(left)));
        },
      ),
      { numRuns: 100 },
    );
  });
});
