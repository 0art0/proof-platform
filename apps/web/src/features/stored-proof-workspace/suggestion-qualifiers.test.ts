import { describe, expect, it } from "vitest";
import type { DisplayedSuggestionSet } from "@proof/protocol";
import { suggestionQualifiers } from "./suggestion-qualifiers";

type Suggestion = DisplayedSuggestionSet["suggestions"][number];

function make(id: string, name: string, extra: Record<string, unknown> = {}): Suggestion {
  return {
    id,
    name,
    source: "result",
    artifactId: `result:${name}`,
    patternId: `pattern:${id}`,
    substitutions: [],
    ...extra,
  } as unknown as Suggestion;
}

describe("suggestionQualifiers", () => {
  it("qualifies nothing when every name is unique", () => {
    expect(suggestionQualifiers([make("a", "One"), make("b", "Two")]).size).toBe(0);
  });

  it("uses what differs in the pattern, naming directions in words", () => {
    const qualifiers = suggestionQualifiers([
      make("a", "Same", { patternId: "pattern:comm-forward" }),
      make("b", "Same", { patternId: "pattern:comm-backward" }),
    ]);
    expect([...qualifiers.values()]).toEqual(["forward direction", "backward direction"]);
  });

  it("falls back to the result, then the instantiation, then a number", () => {
    const byResult = suggestionQualifiers([
      make("a", "Same", { patternId: "pattern:x", artifactId: "result:left" }),
      make("b", "Same", { patternId: "pattern:x", artifactId: "result:right" }),
    ]);
    expect([...byResult.values()]).toEqual(["left", "right"]);

    const bySubstitution = suggestionQualifiers([
      make("a", "Same", {
        patternId: "pattern:x",
        artifactId: "result:r",
        substitutions: [{ symbol: "p", expression: "a" }],
      }),
      make("b", "Same", {
        patternId: "pattern:x",
        artifactId: "result:r",
        substitutions: [{ symbol: "p", expression: "b" }],
      }),
    ]);
    expect([...bySubstitution.values()]).toEqual(['p = "a"', 'p = "b"']);

    const numbered = suggestionQualifiers([
      make("a", "Same", { patternId: "pattern:x", artifactId: "result:r" }),
      make("b", "Same", { patternId: "pattern:x", artifactId: "result:r" }),
    ]);
    expect([...numbered.values()]).toEqual(["option 1", "option 2"]);
  });

  it("leaves members of one stored variant family alone", () => {
    expect(
      suggestionQualifiers([
        make("a", "Same", { variantFamilyId: "family:1" }),
        make("b", "Same", { variantFamilyId: "family:1" }),
      ]).size,
    ).toBe(0);
  });
});
