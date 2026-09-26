import { describe, expect, it } from "vitest";
import { createProofStateSchema, freeSymbolNames, type PlainMathJson } from "@proof/mathjson-model";
import {
  CORE_LOGIC_RESULTS,
  ELEMENTARY_CORPUS,
  LIBRARY_PACK_IDS,
  SET_OPERATOR_DECLARATIONS,
  admitLibraryArtifact,
  corpusRootState,
  createLibraryResultSchema,
  libraryPacksForOperators,
  starterLibraryPack,
  starterLibraryPacks,
  variantFamilySchema,
} from "./index";

describe("starter domain packs", () => {
  it("builds one frozen pack per domain with reviewed results and requested variants", () => {
    const packs = starterLibraryPacks();
    expect(packs.map((pack) => pack.id)).toEqual([...LIBRARY_PACK_IDS]);
    expect(starterLibraryPacks()).toBe(packs);
    expect(
      Object.fromEntries(
        packs.map((pack) => [
          pack.id,
          {
            results: pack.results.length,
            variants: pack.results.filter((result) => result.provenance.kind === "derived-variant")
              .length,
            families: pack.variantFamilies.length,
          },
        ]),
      ),
    ).toEqual({
      "pack:elementary-logic": { results: 7, variants: 1, families: 1 },
      "pack:equality": { results: 3, variants: 1, families: 1 },
      "pack:order": { results: 12, variants: 7, families: 5 },
      "pack:arithmetic": { results: 13, variants: 5, families: 5 },
      "pack:sets": { results: 5, variants: 1, families: 1 },
    });
    packs.forEach((pack) => {
      expect(Object.isFrozen(pack)).toBe(true);
      expect(Object.isFrozen(pack.results[0]?.statement.expression)).toBe(true);
    });
  });

  it("covers the domains the roadmap names", () => {
    const ids = (packId: (typeof LIBRARY_PACK_IDS)[number]) =>
      starterLibraryPack(packId).results.map((result) => result.id);
    expect(ids("pack:order")).toEqual(
      expect.arrayContaining([
        "result:less-transitivity",
        "result:less-equal-transitivity",
        "result:less-equal-antisymmetry",
        "result:less-add-monotonicity",
        "result:less-equal-add-monotonicity",
      ]),
    );
    expect(ids("pack:sets")).toEqual(
      expect.arrayContaining([
        "result:subset-transitivity",
        "result:union-membership",
        "result:intersection-membership",
      ]),
    );
    expect(ids("pack:equality")).toEqual(
      expect.arrayContaining(["result:equality-symmetry", "result:equality-transitivity"]),
    );
    expect(ids("pack:arithmetic")).toEqual(
      expect.arrayContaining([
        "result:add-commutativity",
        "result:add-associativity",
        "result:add-zero",
        "result:left-distributivity",
      ]),
    );
  });

  it("validates, admits and approves every result in its pack's operator environment", () => {
    for (const pack of starterLibraryPacks()) {
      const schema = createLibraryResultSchema({ operators: pack.operators });
      for (const result of pack.results) {
        expect(schema.safeParse(result).success).toBe(true);
        expect(result.approval).toEqual({
          status: "approved",
          reviewerId: "reviewer:core-library",
        });
        expect(result.layer).toBe("global");
        expect(result.classification).toEqual({ domains: [pack.domain], level: "foundational" });
        expect(
          admitLibraryArtifact({
            artifact: result,
            layer: "global",
            environment: { operators: pack.operators },
          }).ok,
        ).toBe(true);
        if (result.provenance.kind === "curated") {
          expect(result.provenance.source).toMatch(/^proof-platform starter /);
        } else {
          expect(result.provenance).toMatchObject({ kind: "derived-variant" });
        }
      }
    }
  });

  it("keeps result IDs unique across the core pack and every starter pack", () => {
    const ids = [
      ...CORE_LOGIC_RESULTS.map((result) => result.id),
      ...starterLibraryPacks().flatMap((pack) => pack.results.map((result) => result.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("links every variant to its family and its source", () => {
    for (const pack of starterLibraryPacks()) {
      const byId = new Map(pack.results.map((result) => [result.id, result]));
      for (const family of pack.variantFamilies) {
        expect(variantFamilySchema.safeParse(family).success).toBe(true);
        const [sourceId, ...variantIds] = family.memberIds;
        expect(byId.get(sourceId!)?.provenance.kind).toBe("curated");
        for (const id of family.memberIds) expect(byId.get(id)?.variantFamilyId).toBe(family.id);
        for (const id of variantIds) {
          expect(byId.get(id)?.provenance).toMatchObject({
            kind: "derived-variant",
            sourceId,
          });
        }
      }
      for (const result of pack.results) {
        if (result.variantFamilyId === undefined) continue;
        expect(
          pack.variantFamilies.find((family) => family.id === result.variantFamilyId)?.memberIds,
        ).toContain(result.id);
      }
    }
  });

  it("indexes equations by their left-hand term forward and as a whole goal backward", () => {
    for (const result of starterLibraryPack("pack:arithmetic").results) {
      const statement = result.statement.expression as unknown as readonly PlainMathJson[];
      expect(statement[0]).toBe("Equal");
      const backward = result.patterns.filter((pattern) => pattern.direction === "backward");
      expect(backward).toHaveLength(1);
      expect(backward[0]?.expression).toEqual(statement);
      expect(backward[0]?.requirement).toEqual({
        section: "goal",
        polarity: "positive",
        role: "proposition",
      });
      result.patterns
        .filter((pattern) => pattern.direction === "forward")
        .forEach((pattern) => {
          expect(pattern.expression).toEqual(statement[1]);
          expect(pattern.requirement.role).toBe("term");
        });
    }
  });

  it("never indexes a bare parameter, which would match every statement", () => {
    for (const pack of starterLibraryPacks()) {
      for (const result of pack.results) {
        const parameters = new Set(result.parameters.map((parameter) => parameter.symbol));
        result.patterns.forEach((pattern) => {
          expect(typeof pattern.expression === "string" && parameters.has(pattern.expression)).toBe(
            false,
          );
        });
      }
    }
  });

  it("offers the set pack only to sessions declaring its operators identically", () => {
    const ids = (operators: Parameters<typeof libraryPacksForOperators>[0]) =>
      libraryPacksForOperators(operators).map((pack) => pack.id);
    const withoutSets = LIBRARY_PACK_IDS.filter((id) => id !== "pack:sets");
    expect(ids([])).toEqual(withoutSets);
    expect(ids(SET_OPERATOR_DECLARATIONS)).toEqual([...LIBRARY_PACK_IDS]);
    expect(ids(SET_OPERATOR_DECLARATIONS.slice(0, 1))).toEqual(withoutSets);
    const renamed = [
      { ...SET_OPERATOR_DECLARATIONS[0]!, id: "operator:other-union" },
      SET_OPERATOR_DECLARATIONS[1]!,
    ] as unknown as typeof SET_OPERATOR_DECLARATIONS;
    expect(ids(renamed)).toEqual(withoutSets);
  });

  it("registers the set operators in the global operator-registry shape", () => {
    const sets = starterLibraryPack("pack:sets");
    expect(sets.operators.map((operator) => operator.symbol)).toEqual(["Union", "Intersection"]);
    expect(sets.operatorRegistrations.map(({ operator }) => operator)).toEqual(sets.operators);
    expect(
      starterLibraryPacks()
        .filter((pack) => pack.id !== "pack:sets")
        .every((pack) => pack.operators.length === 0),
    ).toBe(true);
  });
});

describe("elementary corpus", () => {
  it("has at least eight distinct problems over known packs", () => {
    expect(ELEMENTARY_CORPUS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ELEMENTARY_CORPUS.map((problem) => problem.id)).size).toBe(
      ELEMENTARY_CORPUS.length,
    );
    ELEMENTARY_CORPUS.forEach((problem) => {
      expect(problem.steps.length).toBeGreaterThan(0);
      problem.packs.forEach((packId) => expect(LIBRARY_PACK_IDS).toContain(packId));
    });
  });

  it("states every problem as a valid proof state in its operator environment", () => {
    for (const problem of ELEMENTARY_CORPUS) {
      const parsed = createProofStateSchema({ operators: problem.operators }).safeParse(
        corpusRootState(problem, "state:corpus-root"),
      );
      expect(parsed.success, problem.id).toBe(true);
      const active = libraryPacksForOperators(problem.operators).map((pack) => pack.id);
      problem.packs.forEach((packId) => expect(active).toContain(packId));
    }
  });

  it("scripts choices only as displayed-suggestion references and menu values", () => {
    for (const problem of ELEMENTARY_CORPUS) {
      const declared = new Set([
        ...problem.declarations.map(([symbol]) => symbol),
        ...problem.operators.map((operator) => operator.symbol),
      ]);
      for (const step of problem.steps) {
        expect(step.selections.length).toBeGreaterThan(0);
        expect(step.suggestion.artifactId).toMatch(/^(move|result):/);
        Object.values(step.menu ?? {}).forEach((value) => {
          if (value.kind !== "term") return;
          // Menu terms come from the snapshot, so a scripted term uses only declared symbols.
          freeSymbolNames(value.expression, { operators: problem.operators }).forEach((symbol) =>
            expect(declared.has(symbol)).toBe(true),
          );
        });
      }
    }
  });
});
