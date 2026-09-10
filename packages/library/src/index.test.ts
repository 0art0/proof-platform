import { describe, expect, it } from "vitest";
import { operatorDeclarationsSchema } from "@proof/mathjson-model";
import {
  CORE_LOGIC_RESULTS,
  createLibraryArtifactSchema,
  createLibraryResultSchema,
  libraryArtifactKindSchema,
  libraryArtifactSchema,
  libraryDefinitionSchema,
  libraryResultSchema,
  libraryTechniqueSchema,
  variantFamilySchema,
} from "./index";

function common(id: string) {
  return {
    id,
    name: "Test artifact",
    description: "A test-only library artifact.",
    renderings: { latex: "T", naturalLanguage: "test artifact" },
    classification: { domains: ["logic"], level: "foundational" },
    provenance: { kind: "curated", source: "unit test" },
    approval: { status: "approved", reviewerId: "reviewer:test" },
    layer: "global",
    related: [],
    priority: 1,
  } as const;
}

describe("library artifact contracts", () => {
  it("exports a frozen, runtime-validated core logic result pack", () => {
    expect(CORE_LOGIC_RESULTS.map(({ id }) => id)).toEqual([
      "result:modus-ponens",
      "result:conjunction-commutativity",
      "result:excluded-middle",
    ]);
    CORE_LOGIC_RESULTS.forEach((result) => {
      expect(libraryResultSchema.safeParse(result).success).toBe(true);
      expect(result.kind).toBe("result");
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.statement.expression)).toBe(true);
    });
  });

  it("keeps result, definition, technique, and move classifications distinct", () => {
    expect(libraryArtifactKindSchema.options).toEqual([
      "definition",
      "result",
      "technique",
      "move",
    ]);
    expect(
      libraryDefinitionSchema.safeParse({
        ...common("definition:identity"),
        kind: "definition",
        parameters: [
          {
            id: "declaration:p",
            symbol: "p",
            sort: { kind: "proposition" },
            role: "universal-parameter",
          },
        ],
        statement: { expression: ["Equivalent", "p", "p"] },
      }).success,
    ).toBe(true);
    expect(
      libraryTechniqueSchema.safeParse({
        ...common("technique:contradiction"),
        kind: "technique",
        steps: ["Assume the negation.", "Derive falsity."],
      }).success,
    ).toBe(true);
    expect(
      libraryArtifactSchema.safeParse({
        ...common("move:not-a-library-record"),
        kind: "move",
      }).success,
    ).toBe(false);
  });

  it("rejects ill-typed results and patterns with undeclared symbols", () => {
    const source = structuredClone(CORE_LOGIC_RESULTS[0]!);
    expect(
      libraryResultSchema.safeParse({
        ...source,
        statement: { expression: ["Add", "p", "q"] },
      }).success,
    ).toBe(false);
    expect(
      libraryResultSchema.safeParse({
        ...source,
        patterns: [{ ...source.patterns[0]!, expression: ["Implies", "p", "r"] }],
      }).success,
    ).toBe(false);
  });

  it("requires unique directions, IDs, related references, and classification domains", () => {
    const source = structuredClone(CORE_LOGIC_RESULTS[0]!);
    expect(
      libraryResultSchema.safeParse({
        ...source,
        applicationDirections: ["forward", "forward"],
      }).success,
    ).toBe(false);
    expect(
      libraryResultSchema.safeParse({
        ...source,
        patterns: [source.patterns[0], source.patterns[0]],
      }).success,
    ).toBe(false);
    expect(
      libraryResultSchema.safeParse({
        ...source,
        related: [
          { kind: "result", id: "result:other" },
          { kind: "result", id: "result:other" },
        ],
      }).success,
    ).toBe(false);
    expect(
      libraryResultSchema.safeParse({
        ...source,
        classification: { domains: ["logic", "logic"], level: "foundational" },
      }).success,
    ).toBe(false);
  });

  it("requires every pattern direction to be explicitly permitted", () => {
    const source = structuredClone(CORE_LOGIC_RESULTS[0]!);
    expect(
      libraryResultSchema.safeParse({
        ...source,
        patterns: [{ ...source.patterns[0]!, direction: "backward" }],
      }).success,
    ).toBe(false);
  });

  it("detaches accepted MathJSON and rejects ill-typed proposition patterns", () => {
    const source = structuredClone(CORE_LOGIC_RESULTS[0]!);
    const expression = { fn: ["Implies", "p", "q"], comment: "original" };
    const parsed = libraryResultSchema.parse({
      ...source,
      patterns: [{ ...source.patterns[0]!, expression }],
    });
    expression.comment = "mutated";
    expect(parsed.patterns[0]?.expression).toEqual({
      fn: ["Implies", "p", "q"],
      comment: "original",
    });

    expect(
      libraryResultSchema.safeParse({
        ...source,
        patterns: [{ ...source.patterns[0]!, expression: ["Add", "p", "q"] }],
      }).success,
    ).toBe(false);
  });

  it("validates custom proposition operators only in their frozen environment", () => {
    const operator = operatorDeclarationsSchema.parse([
      {
        id: "operator:predicate",
        symbol: "Predicate",
        signature: {
          parameters: [{ kind: "proposition" }],
          result: { kind: "proposition" },
        },
      },
    ])[0]!;
    const input = {
      ...common("result:custom-predicate"),
      kind: "result",
      parameters: [
        {
          id: "declaration:p",
          symbol: "p",
          sort: { kind: "proposition" },
          role: "universal-parameter",
        },
      ],
      statement: { expression: ["Predicate", "p"] },
      premises: [],
      sideConditions: [],
      applicationDirections: ["forward"],
      patterns: [
        {
          id: "pattern:predicate",
          expression: ["Predicate", "p"],
          direction: "forward",
          requirement: { section: "any", polarity: "any", role: "proposition" },
        },
      ],
    } as const;

    expect(libraryResultSchema.safeParse(input).success).toBe(false);
    expect(createLibraryResultSchema({ operators: [operator] }).safeParse(input).success).toBe(
      true,
    );
    expect(createLibraryArtifactSchema({ operators: [operator] }).safeParse(input).success).toBe(
      true,
    );
  });

  it("groups variants without collapsing their independent result identities", () => {
    expect(
      variantFamilySchema.parse({
        id: "variant-family:de-morgan",
        name: "De Morgan variants",
        memberIds: ["result:de-morgan-and", "result:de-morgan-or"],
      }),
    ).toMatchObject({ memberIds: ["result:de-morgan-and", "result:de-morgan-or"] });
    expect(
      variantFamilySchema.safeParse({
        id: "variant-family:duplicate",
        name: "Invalid family",
        memberIds: ["result:same", "result:same"],
      }).success,
    ).toBe(false);
  });

  it("rejects accessors and cycles without invoking hostile properties", () => {
    let invoked = false;
    const hostile = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        invoked = true;
        return "result";
      },
    });
    expect(libraryResultSchema.safeParse(hostile).success).toBe(false);
    expect(invoked).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(libraryArtifactSchema.safeParse(cyclic).success).toBe(false);
  });
});
