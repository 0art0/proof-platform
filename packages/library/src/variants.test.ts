import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PlainMathJson } from "@proof/mathjson-model";
import {
  CORE_LOGIC_RESULTS,
  generateVariants,
  libraryResultSchema,
  variantFamilySchema,
  type LibraryResult,
} from "./index";

const proposition = (symbol: string) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: { kind: "proposition" },
  role: "universal-parameter",
});
const real = (symbol: string) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: { kind: "named", id: "sort:real" },
  role: "universal-parameter",
});

function result(
  overrides: Readonly<{
    id?: string;
    statement: PlainMathJson;
    premises?: readonly PlainMathJson[];
    parameters?: readonly unknown[];
    applicationDirections?: readonly string[];
    variantFamilyId?: string;
  }>,
): LibraryResult {
  const directions = overrides.applicationDirections ?? ["forward"];
  return libraryResultSchema.parse({
    kind: "result",
    id: overrides.id ?? "result:test",
    name: "Test result",
    description: "A test-only result.",
    renderings: { latex: "T", naturalLanguage: "test result" },
    classification: { domains: ["logic"], level: "foundational" },
    provenance: { kind: "curated", source: "unit test" },
    approval: { status: "approved", reviewerId: "reviewer:test" },
    layer: "global",
    related: [],
    priority: 7,
    parameters: overrides.parameters ?? ["p", "q", "r"].map(proposition),
    statement: { expression: overrides.statement },
    premises: (overrides.premises ?? []).map((expression) => ({ expression })),
    sideConditions: [],
    applicationDirections: directions,
    patterns: directions.map((direction) => ({
      id: `pattern:test-${direction}`,
      expression: overrides.statement,
      direction,
      requirement: { section: "any", polarity: "any", role: "proposition" },
    })),
    ...(overrides.variantFamilyId === undefined
      ? {}
      : { variantFamilyId: overrides.variantFamilyId }),
  });
}

function generated(source: LibraryResult) {
  const output = generateVariants(source);
  if (!output.ok) throw new Error(JSON.stringify(output.diagnostics));
  return output;
}

function byTransformation(source: LibraryResult) {
  return Object.fromEntries(
    generated(source).variants.map((variant) => {
      if (variant.provenance.kind !== "derived-variant") throw new Error("missing provenance");
      return [variant.provenance.transformation, variant];
    }),
  );
}

describe("deterministic variant generation", () => {
  it("generates the contrapositive and curried forms of modus ponens", () => {
    const source = CORE_LOGIC_RESULTS[0]!;
    const output = generated(source);
    expect(output.variants).toHaveLength(2);
    const [contrapositive, curried] = output.variants;
    expect(contrapositive).toMatchObject({
      id: "result:modus-ponens/contrapositive",
      statement: {
        expression: ["Implies", ["Not", "q"], ["Not", ["And", ["Implies", "p", "q"], "p"]]],
      },
      premises: [],
      provenance: {
        kind: "derived-variant",
        sourceId: "result:modus-ponens",
        transformation: "contrapositive",
      },
      approval: source.approval,
      parameters: source.parameters,
      classification: source.classification,
      applicationDirections: ["forward"],
      related: [{ kind: "result", id: "result:modus-ponens" }],
      variantFamilyId: "variant-family:result:modus-ponens",
      patterns: [
        {
          id: "pattern:result:modus-ponens/contrapositive/forward",
          expression: ["Not", "q"],
          direction: "forward",
          requirement: { section: "hypothesis", polarity: "negative", role: "proposition" },
        },
      ],
    });
    expect(contrapositive?.renderings.latex).toBe(
      String.raw`\text{contrapositive: }((p\Rightarrow q)\land p)\Rightarrow q`,
    );
    expect(contrapositive?.renderings.naturalLanguage).toBe(
      "Contrapositive of: If p implies q and p holds, then q holds.",
    );
    expect(curried).toMatchObject({
      id: "result:modus-ponens/curry",
      statement: { expression: ["Implies", ["Implies", "p", "q"], ["Implies", "p", "q"]] },
      patterns: [{ expression: ["Implies", "p", "q"], direction: "forward" }],
    });
    expect(output.family).toEqual({
      id: "variant-family:result:modus-ponens",
      name: "Modus ponens variants",
      memberIds: [
        "result:modus-ponens",
        "result:modus-ponens/contrapositive",
        "result:modus-ponens/curry",
      ],
    });
    expect(output.source).toEqual({
      ...source,
      variantFamilyId: "variant-family:result:modus-ponens",
    });
  });

  it("generates only the converse of an equivalence, with regenerated side patterns", () => {
    const output = generated(CORE_LOGIC_RESULTS[1]!);
    expect(output.variants).toHaveLength(1);
    expect(output.variants[0]).toMatchObject({
      id: "result:conjunction-commutativity/converse",
      statement: { expression: ["Equivalent", ["And", "q", "p"], ["And", "p", "q"]] },
      applicationDirections: ["forward", "backward"],
      patterns: [
        { expression: ["And", "q", "p"], direction: "forward" },
        { expression: ["And", "p", "q"], direction: "backward" },
      ],
    });
  });

  it("swaps the orientation of an equality conclusion, including under implications", () => {
    const parameters = [proposition("p"), real("x"), real("y")];
    const equation: PlainMathJson = ["Equal", ["Add", "x", "y"], ["Add", "y", "x"]];
    const direct = byTransformation(
      result({ statement: equation, parameters, applicationDirections: ["forward", "backward"] }),
    );
    expect(Object.keys(direct)).toEqual(["symmetric-equality"]);
    expect(direct["symmetric-equality"]).toMatchObject({
      statement: { expression: ["Equal", ["Add", "y", "x"], ["Add", "x", "y"]] },
      patterns: [
        {
          expression: ["Add", "y", "x"],
          direction: "forward",
          requirement: { section: "any", polarity: "any", role: "term" },
        },
        { expression: ["Add", "x", "y"], direction: "backward" },
      ],
    });

    const guarded = byTransformation(result({ statement: ["Implies", "p", equation], parameters }));
    expect(guarded["symmetric-equality"]?.statement.expression).toEqual([
      "Implies",
      "p",
      ["Equal", ["Add", "y", "x"], ["Add", "x", "y"]],
    ]);
  });

  it("uncurries nested implications and curries conjunctive antecedents", () => {
    const nested = byTransformation(result({ statement: ["Implies", "p", ["Implies", "q", "r"]] }));
    expect(Object.keys(nested)).toEqual(["contrapositive", "uncurry"]);
    expect(nested.uncurry?.statement.expression).toEqual(["Implies", ["And", "p", "q"], "r"]);
    expect(nested.contrapositive?.statement.expression).toEqual([
      "Implies",
      ["Not", ["Implies", "q", "r"]],
      ["Not", "p"],
    ]);
    expect(nested.uncurry?.patterns.map(({ expression }) => expression)).toEqual([
      ["And", "p", "q"],
    ]);

    const bundled = byTransformation(
      result({ statement: ["Implies", ["And", "p", "q", "r"], "r"] }),
    );
    expect(bundled.curry?.statement.expression).toEqual([
      "Implies",
      "p",
      ["Implies", "q", ["Implies", "r", "r"]],
    ]);
    expect(bundled.curry?.patterns).toEqual([
      // The curried antecedent `p` is a bare parameter, so the pattern falls back to the statement.
      {
        id: "pattern:result:test/curry/forward",
        expression: ["Implies", "p", ["Implies", "q", ["Implies", "r", "r"]]],
        direction: "forward",
        requirement: { section: "any", polarity: "any", role: "proposition" },
      },
    ]);
  });

  it("bundles and unbundles premises and contraposes premise-shaped results", () => {
    const split = byTransformation(result({ statement: "r", premises: ["p", ["Not", "q"]] }));
    expect(Object.keys(split)).toEqual(["contrapositive", "bundle-premises"]);
    expect(split["bundle-premises"]).toMatchObject({
      statement: { expression: "r" },
      premises: [{ expression: ["And", "p", ["Not", "q"]] }],
    });
    expect(split.contrapositive).toMatchObject({
      statement: { expression: ["Implies", ["Not", "r"], ["Not", ["And", "p", ["Not", "q"]]]] },
      premises: [],
    });

    const joined = byTransformation(result({ statement: "r", premises: [["And", "p", "q"]] }));
    expect(joined["unbundle-premises"]).toMatchObject({
      premises: [{ expression: "p" }, { expression: "q" }],
      patterns: [{ expression: "r", direction: "forward" }],
    });
    expect(joined.contrapositive?.statement.expression).toEqual([
      "Implies",
      ["Not", "r"],
      ["Not", ["And", "p", "q"]],
    ]);
  });

  it("generates nothing for atomic or non-applicable statements", () => {
    for (const source of [
      result({ statement: "p" }),
      result({ statement: ["Or", "p", ["Not", "p"]] }),
      CORE_LOGIC_RESULTS[2]!,
    ]) {
      const output = generated(source);
      expect(output.variants).toEqual([]);
      expect(output.family).toBeUndefined();
      expect(output.source).toEqual(source);
    }
  });

  it("skips variants identical to the source", () => {
    expect(generated(result({ statement: ["Equivalent", "p", "p"] })).variants).toEqual([]);
    const parameters = [real("x")];
    expect(
      generated(result({ statement: ["Equal", ["Add", "x", "x"], ["Add", "x", "x"]], parameters }))
        .variants,
    ).toEqual([]);
  });

  it("reuses an existing variant family ID", () => {
    const output = generated(
      result({
        statement: ["Equivalent", "p", "q"],
        variantFamilyId: "variant-family:existing",
      }),
    );
    expect(output.family?.id).toBe("variant-family:existing");
    expect(output.variants.map((variant) => variant.variantFamilyId)).toEqual([
      "variant-family:existing",
    ]);
  });

  it("inherits the source approval status for equivalence transformations", () => {
    const draft = libraryResultSchema.parse({
      ...structuredClone(CORE_LOGIC_RESULTS[1]!),
      approval: { status: "draft" },
    });
    expect(generated(draft).variants[0]?.approval).toEqual({ status: "draft" });
  });

  it("returns diagnostics for invalid sources and environments", () => {
    const invalid = { ...CORE_LOGIC_RESULTS[0]!, statement: { expression: ["Add", "p", "q"] } };
    expect(generateVariants(invalid as unknown as LibraryResult)).toMatchObject({
      ok: false,
      variants: [],
      diagnostics: [{ code: "invalid-source" }],
    });
    expect(
      generateVariants(CORE_LOGIC_RESULTS[0]!, { operators: [{ bogus: true }] as never }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-environment" }] });
  });

  it("produces frozen, schema-valid, family-linked output", () => {
    const output = generated(CORE_LOGIC_RESULTS[0]!);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.variants[0]?.statement.expression)).toBe(true);
    const family = variantFamilySchema.parse(output.family);
    [output.source, ...output.variants].forEach((member) => {
      expect(libraryResultSchema.safeParse(member).success).toBe(true);
      expect(member.variantFamilyId).toBe(family.id);
      expect(family.memberIds).toContain(member.id);
    });
  });
});

const atom = fc.constantFrom<PlainMathJson>("p", "q", "r");
const { formula } = fc.letrec<{ formula: PlainMathJson }>((tie) => ({
  formula: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    atom,
    tie("formula").map((operand): PlainMathJson => ["Not", operand]),
    fc
      .tuple(fc.constantFrom("And", "Or", "Implies", "Equivalent"), tie("formula"), tie("formula"))
      .map(([operator, left, right]): PlainMathJson => [operator, left, right]),
    fc
      .array(tie("formula"), { minLength: 2, maxLength: 3 })
      .map((operands): PlainMathJson => ["And", ...operands]),
  ),
}));
const randomResult = fc
  .record({
    statement: formula,
    premises: fc.array(formula, { maxLength: 3 }),
    applicationDirections: fc.constantFrom(["forward"], ["backward"], ["forward", "backward"]),
  })
  .map((input) => result(input));

describe("variant generation properties", () => {
  it("is deterministic and yields only valid, distinct, family-linked variants", () => {
    fc.assert(
      fc.property(randomResult, (source) => {
        const first = generated(source);
        const second = generated(structuredClone(source));
        expect(second).toEqual(first);
        const ids = first.variants.map((variant) => variant.id);
        expect(new Set(ids).size).toBe(ids.length);
        first.variants.forEach((variant) => {
          expect(libraryResultSchema.safeParse(variant).success).toBe(true);
          expect(variant.approval).toEqual(source.approval);
          expect(variant.id.startsWith(`${source.id}/`)).toBe(true);
        });
        if (first.family !== undefined) {
          expect(first.family.memberIds).toEqual([source.id, ...ids]);
        }
      }),
      { numRuns: 200 },
    );
  });
});
