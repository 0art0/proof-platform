import { describe, expect, it } from "vitest";
import {
  createLibraryAdditionEventSchema,
  createLibraryResultSchema,
  generateVariants,
  mentionedSymbols,
  mergeLibraryOperators,
  resultMentionedSymbols,
  type LibraryResult,
} from "./index";

const INTEGER = { kind: "named", id: "sort:integer" } as never;

function operator(symbol: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `operator:${symbol.toLowerCase()}`,
    symbol,
    signature: { parameters: [INTEGER, INTEGER], result: INTEGER },
    ...overrides,
  };
}
const DIVIDES = {
  id: "operator:divides",
  symbol: "Divides",
  signature: { parameters: [INTEGER, INTEGER], result: { kind: "proposition" } },
};
const GCD = operator("Gcd");

function result(overrides: Record<string, unknown> = {}) {
  const parameter = (symbol: string) => ({
    id: `declaration:${symbol}`,
    symbol,
    sort: INTEGER,
    role: "universal-parameter",
  });
  return {
    kind: "result",
    id: "result:gcd-divides",
    name: "Gcd divides",
    description: "The greatest common divisor divides both numbers.",
    renderings: { latex: "x", naturalLanguage: "x" },
    classification: { domains: ["number theory"], level: "foundational" },
    provenance: { kind: "curated", source: "test" },
    approval: { status: "approved", reviewerId: "actor:web" },
    layer: "initial-problem",
    related: [],
    priority: 50,
    parameters: [parameter("a"), parameter("b")],
    statement: { expression: ["Divides", ["Gcd", "a", "b"], "a"] },
    premises: [],
    sideConditions: [],
    applicationDirections: ["forward"],
    patterns: [
      {
        id: "pattern:one",
        expression: ["Divides", ["Gcd", "a", "b"], "a"],
        direction: "forward",
        requirement: { section: "any", polarity: "any", role: "proposition" },
      },
    ],
    ...overrides,
  };
}

const issues = (schema: ReturnType<typeof createLibraryResultSchema>, value: unknown) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map(({ message }) => message);
};

describe("merging operator environments", () => {
  it("collapses identical declarations and names the clash otherwise", () => {
    expect(mergeLibraryOperators([[DIVIDES], [DIVIDES, GCD]])).toMatchObject({ ok: true });
    expect(mergeLibraryOperators([[GCD], [operator("Gcd", { id: "operator:other" })]])).toEqual({
      ok: false,
      message: "The operator Gcd is declared inconsistently.",
    });
    expect(mergeLibraryOperators([[GCD], [operator("Lcm", { id: GCD.id })]])).toEqual({
      ok: false,
      message: "The operators Gcd and Lcm share the identifier operator:gcd.",
    });
    const trigger = (symbol: string) =>
      operator(symbol, {
        presentation: {
          latex: {
            template: "\\operatorname{f}(#1, #2)",
            precedence: "atom",
            parse: { trigger: "\\operatorname{f}", notation: "function" },
          },
        },
      });
    expect(mergeLibraryOperators([[trigger("Gcd")], [trigger("Lcm")]])).toEqual({
      ok: false,
      message: "The operators Gcd and Lcm share the LaTeX trigger \\operatorname{f}.",
    });
  });
});

describe("the symbols a result mentions", () => {
  it("reads symbols, heads and nested nodes", () => {
    expect(
      [
        ...mentionedSymbols(["Equal", ["Gcd", { sym: "a" }, 1], { fn: ["Lcm", "b"] } as never]),
      ].sort(),
    ).toEqual(["Equal", "Gcd", "Lcm", "a", "b"]);
    const parsed = createLibraryResultSchema({ operators: [DIVIDES, GCD] as never }).parse(
      result({ operators: [GCD] }),
    );
    expect([...resultMentionedSymbols(parsed)].sort()).toEqual(["Divides", "Gcd", "a", "b"]);
  });
});

describe("a library result that declares the constants it needs", () => {
  const schema = createLibraryResultSchema({ operators: [DIVIDES] as never });

  it("is valid in the environment plus its own declarations, and only then", () => {
    expect(issues(schema, result({ operators: [GCD] }))).toEqual([]);
    expect(issues(schema, result())).not.toEqual([]);
  });

  it("refuses a declaration that clashes with the environment", () => {
    const clash = operator("Gcd", { id: DIVIDES.id });
    expect(issues(schema, result({ operators: [clash] }))).toEqual([
      "The operators Divides and Gcd share the identifier operator:divides.",
    ]);
    const environment = createLibraryResultSchema({ operators: [DIVIDES, GCD] as never });
    // The same declaration is a reference to the operator the environment has.
    expect(issues(environment, result({ operators: [GCD] }))).toEqual([]);
    expect(
      issues(environment, result({ operators: [operator("Gcd", { id: "operator:other" })] })),
    ).toEqual(["The operator Gcd is declared inconsistently."]);
  });

  it("refuses a declared constant that the result does not apply", () => {
    const unused = operator("Lcm");
    expect(issues(schema, result({ operators: [GCD, unused] }))).toEqual([
      "The declared constant Lcm is not applied by the result.",
    ]);
  });

  it("gives its variants the constants they still apply", () => {
    const base = createLibraryResultSchema({ operators: [DIVIDES] as never }).parse(
      result({
        id: "result:gcd-equal",
        statement: { expression: ["Equal", ["Gcd", "a", "b"], ["Gcd", "b", "a"]] },
        patterns: [
          {
            id: "pattern:one",
            expression: ["Gcd", "a", "b"],
            direction: "forward",
            requirement: { section: "any", polarity: "any", role: "term" },
          },
        ],
        operators: [GCD],
      }),
    ) as LibraryResult;
    const generated = generateVariants(base, { operators: [DIVIDES] as never });
    if (!generated.ok) throw new Error(JSON.stringify(generated.diagnostics));
    expect(generated.source.operators).toEqual([GCD]);
    for (const variant of generated.variants) expect(variant.operators).toEqual([GCD]);
  });

  it("is recorded with its addition event, which restates it", () => {
    const parsed = schema.parse(result({ operators: [GCD] }));
    const event = {
      id: "library-addition:one",
      sessionId: "session:one",
      sequence: 0,
      occurredAt: "2026-10-19T09:00:00.000Z",
      layer: "initial-problem",
      origin: { kind: "setup" },
      classification: parsed.classification,
      admission: { decision: "admitted", diagnostics: [] },
      approval: parsed.approval,
      artifact: parsed,
    };
    const eventSchema = createLibraryAdditionEventSchema({ operators: [DIVIDES] as never });
    expect(eventSchema.safeParse(event).success).toBe(true);
    expect(createLibraryAdditionEventSchema({ operators: [] }).safeParse(event).success).toBe(
      false,
    );
  });
});
