import {
  PROPOSITION_SORT,
  declarationSchema,
  operatorDeclarationSchema,
  sortSchema,
  type Declaration,
  type OperatorDeclaration,
  type Sort,
} from "@proof/mathjson-model";

/** Shared test fixtures; not exported from the package. */
export function namedSort(id: string, ...parameters: Sort[]): Sort {
  return sortSchema.parse(
    parameters.length === 0 ? { kind: "named", id } : { kind: "named", id, arguments: parameters },
  );
}

export const INTEGER = namedSort("sort:integer");
export const REAL = namedSort("sort:real");
export const NATURAL = namedSort("sort:natural");

export function declare(symbol: string, sort: Sort): Declaration {
  return declarationSchema.parse({
    id: `decl:${symbol}`,
    symbol,
    sort,
    role: "universal-parameter",
  });
}

export const GCD: OperatorDeclaration = operatorDeclarationSchema.parse({
  id: "operator:gcd",
  symbol: "Gcd",
  signature: { parameters: [INTEGER, INTEGER], result: INTEGER },
  presentation: {
    displayName: "greatest common divisor",
    latex: {
      template: "\\operatorname{gcd}\\left(#1, #2\\right)",
      precedence: "atom",
      parse: { trigger: "\\operatorname{gcd}", notation: "function" },
    },
    naturalLanguage: [{ template: "the greatest common divisor of #1 and #2" }],
    domains: ["number-theory"],
  },
});

export const DIVIDES: OperatorDeclaration = operatorDeclarationSchema.parse({
  id: "operator:divides",
  symbol: "Divides",
  signature: { parameters: [INTEGER, INTEGER], result: PROPOSITION_SORT },
  presentation: {
    displayName: "divides",
    latex: {
      template: "#1 \\divides #2",
      precedence: "relation",
      parse: { trigger: "\\divides", notation: "infix" },
    },
    naturalLanguage: [{ template: "#1 divides #2", negated: "#1 does not divide #2" }],
  },
});

export const IS_PRIME: OperatorDeclaration = operatorDeclarationSchema.parse({
  id: "operator:is-prime",
  symbol: "IsPrime",
  signature: { parameters: [NATURAL], result: PROPOSITION_SORT },
  presentation: {
    displayName: "is prime",
    latex: {
      template: "\\isprime #1",
      precedence: "prefix",
      parse: { trigger: "\\isprime", notation: "prefix" },
    },
    naturalLanguage: [{ template: "#1 is prime" }],
  },
});

/** A binder: `SumOver(k, n, body)` is the sum of `body` over the divisors `k` of `n`. */
export const SUM_OVER_DIVISORS: OperatorDeclaration = operatorDeclarationSchema.parse({
  id: "operator:sum-over-divisors",
  symbol: "SumOverDivisors",
  signature: { parameters: [INTEGER, INTEGER, INTEGER], result: INTEGER },
  binder: { kind: "direct-symbols", boundOperands: [0], scopedOperands: [2] },
  presentation: {
    displayName: "sum over divisors",
    latex: { template: "\\sum_{#1 \\mid #2} #3", precedence: "additive" },
    naturalLanguage: [{ template: "the sum of $#3$ over all divisors $#1$ of #2" }],
  },
});

/** An operator without presentation metadata. */
export const PHI: OperatorDeclaration = operatorDeclarationSchema.parse({
  id: "operator:totient",
  symbol: "Totient",
  signature: { parameters: [INTEGER], result: INTEGER },
});

export const OPERATORS: readonly OperatorDeclaration[] = [
  GCD,
  DIVIDES,
  IS_PRIME,
  SUM_OVER_DIVISORS,
  PHI,
];
