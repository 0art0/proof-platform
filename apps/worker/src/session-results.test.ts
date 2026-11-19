import { describe, expect, it } from "vitest";
import {
  DIVISIBILITY_OPERATOR_DECLARATIONS,
  createLibraryResultSchema,
  generateVariants,
  type LibraryArtifact,
  type LibraryResult,
} from "@proof/library";
import { problemSetupSort } from "@proof/protocol";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "./approved-catalog";
import { DIVIDES, SESSION, libraryResult, rootNode, scenario } from "./constant-activation.testing";
import { addLibraryArtifact } from "./library-repository";
import { sessionDefinitions } from "./move-authoring";
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

describe("approved retrieval index reuse", () => {
  function index(definitions: DefinitionCatalog, operators: typeof OPERATORS = [DIVIDES]) {
    const built = approvedRetrievalIndex(definitions, operators);
    if (!built.ok) throw new Error(built.message);
    return built.index;
  }

  it("reuses the starter index for equivalent declarations and changes when their content changes", () => {
    const operators = structuredClone([DIVIDES]);
    const first = index(APPROVED_DEFINITIONS, operators);
    expect(index(APPROVED_DEFINITIONS, [DIVIDES])).toBe(first);
    operators[0]!.presentation!.displayName = "another display name";
    const renamed = index(APPROVED_DEFINITIONS, operators);
    expect(renamed).not.toBe(first);
    expect(renamed.resultCount).toBeLessThan(first.resultCount);
    expect(index(APPROVED_DEFINITIONS, [DIVIDES])).toBe(first);
  });

  it("does not let an index hit bypass operator-environment validation", () => {
    const malformed = structuredClone([DIVIDES]);
    index(APPROVED_DEFINITIONS, malformed);
    Object.defineProperty(malformed[0], "non-data", { value: 1 });
    expect(approvedRetrievalIndex(APPROVED_DEFINITIONS, malformed)).toMatchObject({ ok: false });
  });

  it("refreshes an injected catalog even when its result keeps the same ID", () => {
    const artifact = structuredClone(libraryResult("plain"));
    const definitions: DefinitionCatalog = Object.freeze({
      moves: [],
      catalog: () => ({ results: [artifact], variantFamilies: [], kernelResults: undefined }),
    });
    const first = index(definitions);
    Object.assign(artifact, { name: "Updated result name" });
    const updated = index(definitions);
    const state = rootNode(1).state;
    const selection = {
      kind: "exact",
      anchor: {
        stateId: state.id,
        target: { kind: "goal", id: "goal:1" },
        statement: { kind: "conclusion" },
      },
      path: [],
    };
    expect(updated.query(state, selection)).toMatchObject({
      ok: true,
      suggestions: [{ artifactId: artifact.id, name: "Updated result name" }],
    });
    expect(first.query(state, selection)).toMatchObject({
      ok: true,
      suggestions: [{ artifactId: artifact.id, name: "Multiples (plain)" }],
    });
  });

  it("reuses stored session definitions and refreshes after an admission, scoped by session and store", async () => {
    const { store, definitions } = await scenario(1, ["plain"]);
    const first = index(definitions);
    const read = () => sessionDefinitions(APPROVED_DEFINITIONS, store, SESSION);
    expect(await read()).toBe(definitions);
    expect(index(await read())).toBe(first);

    const differentStore = await scenario(1, ["gcd"]);
    const differentSession = await scenario(1, ["gcd"], "session:other", store);
    expect(index(differentStore.definitions)).not.toBe(first);
    expect(index(differentSession.definitions)).not.toBe(first);

    const addition = await addLibraryArtifact(store, {
      id: "library-addition:cache-test",
      sessionId: SESSION,
      occurredAt: "2026-10-19T09:00:00.000Z",
      layer: "initial-problem",
      origin: { kind: "setup", actorId: "actor:web" },
      artifact: libraryResult("gcd"),
    });
    expect(addition).toMatchObject({ status: "recorded", admitted: true });
    const extended = await read();
    const updated = index(extended);
    expect(updated).not.toBe(first);
    expect(updated.resultCount).toBe(first.resultCount + 1);
    expect(index(await read())).toBe(updated);
  });
});
