import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { OperatorDeclaration } from "@proof/mathjson-model";
import { DIVIDES, GCD, INTEGER, LCM } from "./constant-activation.testing";
import { evaluateTopUpProposal, statementKey } from "./library-proposal";

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

describe("judging a top-up proposal that declares a constant", () => {
  const profile = {
    level: "undergraduate",
    summary: "Number theory.",
    assumptions: [],
    domains: ["number theory"],
    maximumLevel: "undergraduate",
  } as never;
  const proposal = {
    kind: "library-proposal",
    unusable: [],
    newConstants: [{ operator: LCM, rationale: "Results are stated with the lcm." }],
    results: [
      {
        id: "result:lcm-multiples",
        name: "Lcm multiples",
        description: "A number divides its multiples when the lcm is their product.",
        classification: { domains: ["number theory"], level: "foundational" },
        parameters: ["a", "b"].map((symbol) => ({
          id: `declaration:lcm-multiples-${symbol}`,
          symbol,
          sort: INTEGER,
          role: "universal-parameter",
        })),
        statement: { expression: ["Divides", "a", ["Multiply", "a", "b"]] },
        premises: [{ expression: ["Equal", ["Lcm", "a", "b"], ["Multiply", "a", "b"]] }],
        applicationDirections: ["backward"],
        patterns: [
          {
            id: "pattern:lcm-multiples",
            expression: ["Divides", "a", ["Multiply", "a", "b"]],
            direction: "backward",
            requirement: { section: "goal", polarity: "positive", role: "proposition" },
          },
        ],
      },
    ],
  };
  const context = { kind: "no-relevant-results" } as never;
  const judge = (operators: readonly OperatorDeclaration[]) =>
    evaluateTopUpProposal({
      callId: "llm-call:top-up",
      context,
      proposal: proposal as never,
      operators,
      profile,
      existing: [],
    });

  it("carries the constant on the result, the same whether or not a step activated it since", () => {
    const first = judge([DIVIDES, GCD]);
    expect(first.rejected).toEqual([]);
    expect(first.results.map(({ artifact }) => artifact.operators)).toEqual([[LCM]]);
    expect(first.newConstants.map(({ operator }) => operator.symbol)).toEqual(["Lcm"]);

    // Lcm is active now: the stored call is judged again and gives the very same artifacts, so a
    // replay by call ID finds its additions already recorded.
    const again = judge([DIVIDES, GCD, LCM]);
    expect(again.results).toEqual(first.results);
    expect(again.rejectedConstants).toEqual([]);
  });

  it("sets the constant aside when it clashes, and the results that need it with it", () => {
    const clashing = { ...LCM, id: DIVIDES.id } as OperatorDeclaration;
    const rejected = evaluateTopUpProposal({
      callId: "llm-call:top-up",
      context,
      proposal: { ...proposal, newConstants: [{ operator: clashing, rationale: "x" }] } as never,
      operators: [DIVIDES, GCD],
      profile,
      existing: [],
    });
    expect(rejected.results).toEqual([]);
    expect(rejected.rejectedConstants).toEqual([
      { symbol: "Lcm", reason: expect.stringContaining("already used by Divides") },
    ]);
    expect(rejected.rejected).toMatchObject([
      { id: "result:lcm-multiples", codes: ["needs-new-constant"] },
    ]);
  });
});
