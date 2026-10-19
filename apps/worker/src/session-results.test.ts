import { describe, expect, it } from "vitest";
import {
  DIVISIBILITY_OPERATOR_DECLARATIONS,
  createLibraryResultSchema,
  generateVariants,
  type LibraryArtifact,
  type LibraryResult,
} from "@proof/library";
import { problemSetupSort } from "@proof/protocol";
import { APPROVED_DEFINITIONS } from "./approved-catalog";
import { approvedRetrievalIndex } from "./proof-http/shared";
import { sessionLibraryResults, withSessionResults } from "./session-results";

const INTEGER = problemSetupSort("integer");
const GCD = {
  id: "operator:gcd",
  symbol: "Gcd",
  signature: { parameters: [INTEGER, INTEGER], result: INTEGER },
};
const OPERATORS = DIVISIBILITY_OPERATOR_DECLARATIONS;
const WITH_GCD = [...OPERATORS, GCD] as unknown as typeof OPERATORS;

function result(
  id: string,
  statement: unknown,
  overrides: Record<string, unknown> = {},
  operators: readonly unknown[] = OPERATORS,
): LibraryResult {
  return createLibraryResultSchema({ operators: operators as never }).parse({
    kind: "result",
    id,
    name: `Result ${id}`,
    description: "A result.",
    renderings: { latex: "x", naturalLanguage: "x" },
    classification: { domains: ["number theory"], level: "foundational" },
    provenance: { kind: "generated", role: "librarian", contextId: "llm-call:x" },
    approval: { status: "approved", reviewerId: "service:library-gate" },
    layer: "proof-time-background",
    related: [],
    priority: 50,
    parameters: ["a", "b"].map((symbol) => ({
      id: `declaration:${id}-${symbol}`,
      symbol,
      sort: INTEGER,
      role: "universal-parameter",
    })),
    statement: { expression: statement },
    premises: [],
    sideConditions: [],
    applicationDirections: ["forward"],
    patterns: [
      {
        id: `pattern:${id}`,
        expression: statement,
        direction: "forward",
        requirement: { section: "any", polarity: "any", role: "proposition" },
      },
    ],
    ...overrides,
  });
}

const catalogOf = (results: readonly LibraryResult[], operators = OPERATORS) =>
  withSessionResults(APPROVED_DEFINITIONS, results).catalog(operators);

describe("session results in the catalog", () => {
  it("is the base catalog when the session added nothing", () => {
    expect(withSessionResults(APPROVED_DEFINITIONS, [])).toBe(APPROVED_DEFINITIONS);
  });

  it("adds approved results, their kernel form and their variant family to the base catalog", () => {
    const source = result("result:s-symmetry", [
      "Equivalent",
      ["Divides", "a", "b"],
      ["Divides", "b", "a"],
    ]);
    const generated = generateVariants(source, { operators: OPERATORS });
    if (!generated.ok) throw new Error("Expected variants.");
    const added = [generated.source, ...generated.variants];
    const base = APPROVED_DEFINITIONS.catalog(OPERATORS);
    const catalog = catalogOf(added);
    expect(catalog.results.map(({ id }) => id)).toEqual([
      ...base.results.map(({ id }) => id),
      ...added.map(({ id }) => id),
    ]);
    expect(catalog.kernelResults?.map(({ id }) => id as string)).toEqual(
      expect.arrayContaining(added.map(({ id }) => id as string)),
    );
    expect(catalog.variantFamilies.at(-1)).toEqual({
      id: "variant-family:result:s-symmetry",
      name: "Result result:s-symmetry variants",
      memberIds: added.map(({ id }) => id),
    });
    // The retrieval index accepts the enlarged catalog.
    expect(
      approvedRetrievalIndex(withSessionResults(APPROVED_DEFINITIONS, added), OPERATORS).ok,
    ).toBe(true);
  });

  it("leaves out a result the kernel cannot instantiate in the session's operators, without failing", () => {
    const undeclared = result(
      "result:s-gcd",
      ["Equal", ["Gcd", "a", "b"], ["Gcd", "b", "a"]],
      {},
      WITH_GCD,
    );
    const fine = result("result:s-fine", ["Divides", "a", "a"]);
    const catalog = catalogOf([undeclared, fine]);
    const ids = catalog.results.map(({ id }) => id);
    expect(ids).toContain("result:s-fine");
    expect(ids).not.toContain("result:s-gcd");
    expect(catalog.kernelResults).toBeDefined();
    // The same result is part of a session that does declare the operator.
    expect(catalogOf([undeclared], WITH_GCD).results.map(({ id }) => id)).toContain("result:s-gcd");
  });

  it("drops a family that would have fewer than two members, so retrieval stays valid", () => {
    const source = result("result:s-lonely", ["Divides", "a", "a"], {
      variantFamilyId: "variant-family:result:s-lonely",
    });
    const catalog = catalogOf([source]);
    expect(catalog.results.at(-1)).not.toHaveProperty("variantFamilyId");
    expect(catalog.variantFamilies.map(({ id }) => id)).not.toContain(
      "variant-family:result:s-lonely",
    );
    expect(
      approvedRetrievalIndex(withSessionResults(APPROVED_DEFINITIONS, [source]), OPERATORS).ok,
    ).toBe(true);
  });

  it("ignores an identifier of the base catalog, a repeated identifier and a result that is not approved", () => {
    const base = APPROVED_DEFINITIONS.catalog(OPERATORS).results[0]!;
    const clash = result(base.id, ["Divides", "a", "a"]);
    const first = result("result:s-once", ["Divides", "a", "b"]);
    const second = result("result:s-once", ["Divides", "b", "a"]);
    const draft = result("result:s-draft", ["Divides", "b", "b"], {
      approval: { status: "draft" },
    });
    const catalog = catalogOf([clash, first, second, draft]);
    const added = catalog.results.slice(APPROVED_DEFINITIONS.catalog(OPERATORS).results.length);
    expect(added.map(({ id }) => id)).toEqual(["result:s-once"]);
    expect(added[0]?.statement.expression).toEqual(["Divides", "a", "b"]);
  });

  it("lists only approved results of the initial and proof-time layers", () => {
    const initial = result("result:l-initial", ["Divides", "a", "a"], { layer: "initial-problem" });
    const proofTime = result("result:l-proof", ["Divides", "a", "b"]);
    const derived = result("result:l-derived", ["Divides", "b", "a"], {
      layer: "derived",
      provenance: { kind: "derived", sessionId: "session:x", proofNodeId: "node:x" },
    });
    const draft = result("result:l-draft", ["Divides", "b", "b"], {
      approval: { status: "draft" },
    });
    expect(
      sessionLibraryResults([initial, proofTime, derived, draft] as readonly LibraryArtifact[]).map(
        ({ id }) => id,
      ),
    ).toEqual(["result:l-initial", "result:l-proof"]);
  });
});
