import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ProofContext } from "@proof/mathjson-model";
import { admitLibraryArtifact, extractDerivedResult, type DerivedResultInput } from "./index";

const proposition = { kind: "proposition" } as const;
const universal = (symbol: string) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: proposition,
  role: "universal-parameter" as const,
});

const context = {
  declarations: [
    universal("p"),
    universal("q"),
    universal("r"),
    { id: "declaration:w", symbol: "w", sort: proposition, role: "local-witness" },
    {
      id: "declaration:c",
      symbol: "c",
      sort: proposition,
      role: "construction-metavariable",
      resolution: { status: "resolved", value: ["And", "w", "p"] },
    },
  ],
  hypotheses: [
    { id: "hypothesis:pq", statement: { expression: ["Implies", "p", "q"] } },
    { id: "hypothesis:case-p", statement: { expression: "p" } },
    { id: "hypothesis:r", statement: { expression: "r" } },
    { id: "hypothesis:w", statement: { expression: "w" } },
  ],
} as unknown as ProofContext;

function input(overrides: Partial<DerivedResultInput> = {}): DerivedResultInput {
  return {
    sessionId: "session:one",
    proofNodeId: "node:7",
    id: "result:derived-q",
    name: "q in the case p",
    context,
    conclusion: { expression: "q" },
    usedHypothesisIds: ["hypothesis:case-p", "hypothesis:pq"],
    classification: { domains: ["logic"], level: "foundational" },
    renderings: { latex: "q", naturalLanguage: "q holds" },
    approval: { status: "draft" },
    ...overrides,
  };
}

describe("conditional-lemma extraction", () => {
  it("retains the used branch assumptions as premises and depends only on used parameters", () => {
    const extraction = extractDerivedResult(input());
    if (!extraction.ok) throw new Error(extraction.diagnostics[0].message);
    const { result } = extraction;
    expect(result.layer).toBe("derived");
    expect(result.provenance).toEqual({
      kind: "derived",
      sessionId: "session:one",
      proofNodeId: "node:7",
    });
    expect(result.parameters.map((parameter) => parameter.symbol)).toEqual(["p", "q"]);
    // Premises follow context order, whatever order the caller lists them in.
    expect(result.premises).toEqual([{ expression: ["Implies", "p", "q"] }, { expression: "p" }]);
    expect(result.statement).toEqual({ expression: "q" });
    expect(result.applicationDirections).toEqual(["backward", "forward"]);
    expect(Object.isFrozen(result.premises)).toBe(true);
    expect(
      admitLibraryArtifact({
        artifact: result,
        layer: "derived",
        sessionId: "session:one",
        proofNodeIds: ["node:7"],
      }).ok,
    ).toBe(true);
  });

  it("extracts an unconditional result when no hypothesis was used", () => {
    const extraction = extractDerivedResult(
      input({ conclusion: { expression: ["Or", "r", ["Not", "r"]] }, usedHypothesisIds: [] }),
    );
    expect(extraction.ok && extraction.result.premises).toEqual([]);
    expect(extraction.ok && extraction.result.parameters.map(({ symbol }) => symbol)).toEqual([
      "r",
    ]);
    expect(extraction.ok && extraction.result.applicationDirections).toEqual(["backward"]);
  });

  it("rejects dependencies on local witnesses, directly or through constructions", () => {
    const direct = extractDerivedResult(input({ usedHypothesisIds: ["hypothesis:w"] }));
    expect(direct.ok).toBe(false);
    expect(direct.diagnostics).toEqual([
      expect.objectContaining({ code: "local-dependency", symbol: "w" }),
    ]);
    const viaConstruction = extractDerivedResult(
      input({ conclusion: { expression: "c" }, usedHypothesisIds: [] }),
    );
    expect(viaConstruction.diagnostics.map((diagnostic) => diagnostic.symbol)).toEqual(["w", "c"]);
  });

  it("rejects unknown or repeated hypotheses and ill-typed sequents", () => {
    expect(
      extractDerivedResult(input({ usedHypothesisIds: ["hypothesis:missing"] })).diagnostics[0]
        ?.code,
    ).toBe("unknown-hypothesis");
    expect(
      extractDerivedResult(input({ usedHypothesisIds: ["hypothesis:pq", "hypothesis:pq"] }))
        .diagnostics[0]?.code,
    ).toBe("duplicate-hypothesis");
    expect(
      extractDerivedResult(input({ conclusion: { expression: "undeclared" } })).diagnostics[0]
        ?.code,
    ).toBe("invalid-sequent");
  });

  it("keeps exactly the used hypotheses as premises for any subset", () => {
    const ids = ["hypothesis:pq", "hypothesis:case-p", "hypothesis:r"];
    fc.assert(
      fc.property(fc.subarray(ids), (used) => {
        const extraction = extractDerivedResult(input({ usedHypothesisIds: used }));
        if (!extraction.ok) throw new Error(extraction.diagnostics[0].message);
        const expected = context.hypotheses
          .filter((hypothesis) => used.includes(hypothesis.id))
          .map((hypothesis) => hypothesis.statement);
        expect(extraction.result.premises).toEqual(expected);
        const symbols = extraction.result.parameters.map(({ symbol }) => symbol);
        expect(symbols).toContain("q");
        expect(symbols.includes("r")).toBe(used.includes("hypothesis:r"));
      }),
    );
  });
});
