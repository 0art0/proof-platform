import { describe, expect, it } from "vitest";
import { APPROVED_DEFINITIONS } from "./approved-catalog";
import { describeSessionConstants } from "./active-constants";
import { DIVIDES, GCD, LCM, libraryResult, scenario } from "./constant-activation.testing";
import {
  availableConstants,
  catalogOperators,
  extendOperators,
  libraryConstantsOf,
  missingConstants,
  stepConstants,
  untrustedResultIds,
} from "./session-constants";

describe("library constants", () => {
  it("collects the constants of results once, in first-seen order", () => {
    expect(
      libraryConstantsOf([libraryResult("lcm"), libraryResult("both"), libraryResult("plain")]),
    ).toEqual([LCM, GCD]);
    expect(libraryConstantsOf([])).toEqual([]);
  });

  it("extends operators with what fits, and leaves out a repeat or a clash", () => {
    expect(extendOperators([DIVIDES], [GCD, LCM]).map(({ symbol }) => symbol)).toEqual([
      "Divides",
      "Gcd",
      "Lcm",
    ]);
    const operators = [DIVIDES];
    expect(extendOperators(operators, [])).toBe(operators);
    // A repeat of a declared symbol, and a declaration reusing an identifier, are skipped.
    expect(extendOperators([DIVIDES, GCD], [GCD])).toEqual([DIVIDES, GCD]);
    expect(extendOperators([DIVIDES], [{ ...GCD, id: DIVIDES.id }])).toEqual([DIVIDES]);
  });
});

describe("what a session's catalog offers", () => {
  it("lists available constants and the results that need them", async () => {
    const { definitions } = await scenario(1, ["plain", "gcd", "both"]);
    expect(definitions.libraryConstants?.map(({ symbol }) => symbol)).toEqual(["Gcd", "Lcm"]);
    expect(availableConstants([DIVIDES], definitions).map(({ symbol }) => symbol)).toEqual([
      "Gcd",
      "Lcm",
    ]);
    expect(availableConstants([DIVIDES, GCD], definitions).map(({ symbol }) => symbol)).toEqual([
      "Lcm",
    ]);
    expect(catalogOperators([DIVIDES], definitions).map(({ symbol }) => symbol)).toEqual([
      "Divides",
      "Gcd",
      "Lcm",
    ]);
    expect(availableConstants([DIVIDES], APPROVED_DEFINITIONS)).toEqual([]);
    expect(catalogOperators([DIVIDES], APPROVED_DEFINITIONS)).toEqual([DIVIDES]);
  });

  it("finds the constants a result would add, in the operators in force", async () => {
    const { definitions } = await scenario(1);
    expect(missingConstants(definitions, [DIVIDES], ["result:test-plain"])).toEqual([]);
    expect(missingConstants(definitions, [DIVIDES], ["result:test-both"])).toEqual([GCD, LCM]);
    expect(missingConstants(definitions, [DIVIDES, GCD], ["result:test-both"])).toEqual([LCM]);
    expect(missingConstants(definitions, [DIVIDES], ["result:unknown"])).toEqual([]);
    expect(missingConstants(definitions, [DIVIDES], [])).toEqual([]);
  });

  it("reads the step of an untrusted operation", async () => {
    const { definitions } = await scenario(1);
    const apply = (resultId: string) => ({ kind: "apply-result-backward", resultId });
    expect(stepConstants(definitions, [DIVIDES], apply("result:test-gcd"))).toEqual({
      resultId: "result:test-gcd",
      constants: [GCD],
    });
    expect(
      stepConstants(definitions, [DIVIDES], {
        kind: "rewrite-with-equivalence",
        source: { kind: "result", resultId: "result:test-lcm" },
      }),
    ).toEqual({ resultId: "result:test-lcm", constants: [LCM] });
    expect(stepConstants(definitions, [DIVIDES, GCD], apply("result:test-gcd"))).toBeUndefined();
    for (const operation of [
      undefined,
      null,
      "close-true",
      [],
      { kind: "close-true" },
      apply(""),
    ]) {
      expect(stepConstants(definitions, [DIVIDES], operation)).toBeUndefined();
    }
    expect(untrustedResultIds({ kind: "apply-result-forward", resultId: 3 })).toEqual([]);
    expect(
      untrustedResultIds({ kind: "rewrite-with-implication", source: { kind: "hypothesis" } }),
    ).toEqual([]);
  });
});

describe("describing a session's constants", () => {
  it("separates setup, activated and available constants and names the results", async () => {
    const { definitions } = await scenario(1);
    const described = describeSessionConstants({
      setupOperators: [DIVIDES],
      activations: [
        {
          sequence: 1,
          symbol: "Gcd",
          declaration: GCD,
          commandId: "command:a",
          edgeId: "edge:a",
          nodeId: "node:a",
          resultId: "result:test-gcd",
          transitionSequence: 1,
          activatedAt: "2026-10-19T10:00:00.000Z",
        } as never,
      ],
      definitions,
    });
    expect(described.active.map(({ symbol, origin }) => [symbol, origin])).toEqual([
      ["Divides", "setup"],
      ["Gcd", "activated"],
    ]);
    expect(
      described.available.map(({ symbol, results }) => [symbol, results.map(({ id }) => id)]),
    ).toEqual([["Lcm", ["result:test-lcm", "result:test-both"]]]);
    expect(described.activated).toMatchObject([
      { symbol: "Gcd", resultId: "result:test-gcd", resultName: "Multiples (gcd)", sequence: 1 },
    ]);
  });
});
