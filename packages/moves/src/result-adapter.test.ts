import { describe, expect, it } from "vitest";
import { CORE_LOGIC_RESULTS, libraryResultSchema, type LibraryResult } from "@proof/library";
import { PROPOSITION_SORT } from "@proof/mathjson-model";
import { approvedKernelResults, libraryResultToKernelResult } from "./index";

function coreResult(id: string): LibraryResult {
  const result = CORE_LOGIC_RESULTS.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`Missing core result ${id}.`);
  return result;
}

function libraryResult(overrides: Readonly<Record<string, unknown>>): LibraryResult {
  const [base] = CORE_LOGIC_RESULTS;
  return libraryResultSchema.parse({ ...base, ...overrides });
}

const propositionParameters = ["a", "b", "c"].map((symbol) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter",
}));

describe("libraryResultToKernelResult", () => {
  it("splits modus ponens into its two premises and its consequent", () => {
    expect(libraryResultToKernelResult(coreResult("result:modus-ponens"))).toEqual({
      ok: true,
      result: {
        id: "result:modus-ponens",
        parameters: [
          { symbol: "p", sort: PROPOSITION_SORT },
          { symbol: "q", sort: PROPOSITION_SORT },
        ],
        premises: [{ expression: ["Implies", "p", "q"] }, { expression: "p" }],
        conclusion: { expression: "q" },
        directions: ["forward"],
      },
      diagnostics: [],
    });
  });

  it("keeps equivalences and other statements whole and premise-free", () => {
    expect(libraryResultToKernelResult(coreResult("result:conjunction-commutativity"))).toEqual({
      ok: true,
      result: {
        id: "result:conjunction-commutativity",
        parameters: [
          { symbol: "p", sort: PROPOSITION_SORT },
          { symbol: "q", sort: PROPOSITION_SORT },
        ],
        premises: [],
        conclusion: { expression: ["Equivalent", ["And", "p", "q"], ["And", "q", "p"]] },
        directions: ["forward", "backward"],
      },
      diagnostics: [],
    });
    expect(libraryResultToKernelResult(coreResult("result:excluded-middle"))).toMatchObject({
      ok: true,
      result: { premises: [], conclusion: { expression: ["Or", "p", ["Not", "p"]] } },
    });
  });

  it("appends side-condition statements and a non-conjunctive antecedent after explicit premises", () => {
    const result = libraryResult({
      id: "result:layered",
      parameters: propositionParameters,
      premises: [{ expression: "a" }],
      sideConditions: [
        { id: "side:descriptive", description: "Only prose; not a premise." },
        { id: "side:checked", description: "b holds.", statement: { expression: "b" } },
      ],
      statement: { expression: ["Implies", ["Or", "a", "b"], ["Implies", "c", "a"]] },
      applicationDirections: ["forward", "backward"],
      patterns: [
        {
          id: "pattern:layered",
          expression: "a",
          direction: "forward",
          requirement: { section: "any", polarity: "any", role: "proposition" },
        },
      ],
    });
    expect(libraryResultToKernelResult(result)).toMatchObject({
      ok: true,
      result: {
        premises: [{ expression: "a" }, { expression: "b" }, { expression: ["Or", "a", "b"] }],
        // Only the top-level implication splits; a curried consequent stays whole.
        conclusion: { expression: ["Implies", "c", "a"] },
        directions: ["forward", "backward"],
      },
    });
  });

  it("returns frozen, detached output and adapts only approved results", () => {
    const adapted = libraryResultToKernelResult(coreResult("result:modus-ponens"));
    expect(Object.isFrozen(adapted)).toBe(true);
    const draft = libraryResult({ id: "result:draft", approval: { status: "draft" } });
    const catalog = approvedKernelResults([...CORE_LOGIC_RESULTS, draft]);
    expect(catalog.ok && catalog.results.map((result) => result.id)).toEqual([
      "result:modus-ponens",
      "result:conjunction-commutativity",
      "result:excluded-middle",
    ]);
  });
});
