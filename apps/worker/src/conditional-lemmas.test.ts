import { describe, expect, it } from "vitest";
import type { LibraryArtifact, LibraryResult } from "@proof/library";
import { existingLemmas } from "./conditional-lemmas";

/** A saved derived result reduced to the fields `existingLemmas` reads. */
function savedLemma(
  id: string,
  statement: unknown,
  premises: unknown,
  overrides: Record<string, unknown> = {},
): LibraryArtifact {
  return {
    kind: "result",
    layer: "derived",
    id,
    provenance: { kind: "derived", proofNodeId: "node:closed" },
    statement,
    premises,
    ...overrides,
  } as unknown as LibraryArtifact;
}

/** The lemma just built from the closed subtree. */
function builtLemma(statement: unknown, premises: unknown): LibraryResult {
  return { statement, premises } as unknown as LibraryResult;
}

describe("existing conditional lemmas", () => {
  it("finds a saved lemma with the same statement and premises", () => {
    const lemma = builtLemma({ expression: ["Implies", "p", "q"] }, [
      { id: "statement:p", expression: "p" },
    ]);
    const saved = savedLemma("result:lemma-1", { expression: ["Implies", "p", "q"] }, [
      { id: "statement:p", expression: "p" },
    ]);
    expect(existingLemmas([saved], "node:closed", lemma)).toEqual([
      { artifactId: "result:lemma-1", status: "draft" },
    ]);
  });

  it("finds a saved lemma read back with another object key order", () => {
    // A numeral with metadata keeps its keys in the order they were written; a stored copy
    // returns them in JSONB order (shorter keys first), as does a premise's own fields.
    const built = [
      { expression: ["Equal", { latex: "2", num: "2" }, "x"] },
      [{ id: "statement:p", expression: { latex: "p", sym: "p" } }],
    ] as const;
    const stored = [
      { expression: ["Equal", { num: "2", latex: "2" }, "x"] },
      [{ expression: { sym: "p", latex: "p" }, id: "statement:p" }],
    ] as const;
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(built));
    const lemma = builtLemma(...built);
    const saved = savedLemma("result:lemma-1", ...stored);
    expect(existingLemmas([saved], "node:closed", lemma)).toEqual([
      { artifactId: "result:lemma-1", status: "draft" },
    ]);
  });

  it("ignores lemmas of another node, other statements and other premises", () => {
    const lemma = builtLemma({ expression: ["Implies", "p", "q"] }, []);
    expect(
      existingLemmas(
        [
          savedLemma("result:other-node", { expression: ["Implies", "p", "q"] }, [], {
            provenance: { kind: "derived", proofNodeId: "node:elsewhere" },
          }),
          savedLemma("result:other-statement", { expression: ["Implies", "q", "p"] }, []),
          savedLemma("result:other-premises", { expression: ["Implies", "p", "q"] }, [
            { id: "statement:p", expression: "p" },
          ]),
        ],
        "node:closed",
        lemma,
      ),
    ).toEqual([]);
  });
});
