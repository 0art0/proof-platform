import { describe, expect, it } from "vitest";
import { MAX_FORMALIZER_LIBRARY_RESULTS } from "@proof/llm";
import { starterLibraryPacks, type LibraryResult } from "@proof/library";
import { formalizerLibraryResults, initialLibraryEventId } from "./approved-library";
import type { ApprovedInitialLibrary } from "./library-proposal";

const [template] = starterLibraryPacks().flatMap((pack) => pack.results);

function result(id: string, variantOf?: string): LibraryResult {
  if (template === undefined) throw new Error("The starter packs have no results.");
  return {
    ...template,
    id,
    name: id,
    layer: "initial-problem",
    provenance:
      variantOf === undefined
        ? { kind: "generated", role: "librarian", contextId: "llm-call:library" }
        : { kind: "derived-variant", sourceId: variantOf, transformation: "converse" },
  } as unknown as LibraryResult;
}

function library(originals: number, variantsPerOriginal: number): ApprovedInitialLibrary {
  const results = Array.from({ length: originals }, (_, index) =>
    result(`result:library-r${index}`),
  );
  const variants = results.flatMap(({ id }) =>
    Array.from({ length: variantsPerOriginal }, (_, index) => result(`${id}/v${index}`, id)),
  );
  return { results, variants } as unknown as ApprovedInitialLibrary;
}

describe("formalizerLibraryResults", () => {
  const packs = starterLibraryPacks().filter(({ id }) => id === "pack:divisibility");
  const packResults = packs.flatMap((pack) => pack.results);

  it("shows the packs' results, then the approved results, then their variants, within the cap", () => {
    const shown = formalizerLibraryResults(packs, library(2, 1));
    expect(shown.map(({ id }) => id)).toEqual([
      ...packResults.map(({ id }) => id),
      "result:library-r0",
      "result:library-r1",
      "result:library-r0/v0",
      "result:library-r1/v0",
    ]);
    expect(shown[0]).toEqual({
      id: packResults[0]!.id,
      name: packResults[0]!.name,
      description: packResults[0]!.description,
      statement: packResults[0]!.statement.expression,
      premises: packResults[0]!.premises.map((premise) => premise.expression),
    });
  });

  it("shows the packs' results alone when there is no library", () => {
    expect(formalizerLibraryResults(packs, undefined).map(({ id }) => id)).toEqual(
      packResults.map(({ id }) => id),
    );
  });

  it("beyond the cap keeps originals before variants, and approved results before the packs' own", () => {
    const all = starterLibraryPacks();
    const packOriginals = all
      .flatMap((pack) => pack.results)
      .filter(({ provenance }) => provenance.kind !== "derived-variant");
    const shown = formalizerLibraryResults(all, library(40, 2));
    expect(shown).toHaveLength(MAX_FORMALIZER_LIBRARY_RESULTS);
    const ids = shown.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    // No variant is shown while an original is left out, and the 40 approved results come first.
    expect(ids.slice(0, 40)).toEqual(Array.from({ length: 40 }, (_, i) => `result:library-r${i}`));
    expect(ids.slice(40)).toEqual(
      packOriginals.slice(0, MAX_FORMALIZER_LIBRARY_RESULTS - 40).map(({ id }) => id),
    );
    expect(ids.some((id) => id.includes("/"))).toBe(false);
  });

  it("beyond the cap shows variants only after every original", () => {
    const shown = formalizerLibraryResults(packs, library(MAX_FORMALIZER_LIBRARY_RESULTS - 8, 1));
    expect(shown).toHaveLength(MAX_FORMALIZER_LIBRARY_RESULTS);
    const ids = shown.map(({ id }) => id);
    const firstVariant = ids.findIndex((id) => id.includes("/"));
    const packVariants = packResults.filter(
      ({ provenance }) => provenance.kind === "derived-variant",
    );
    expect(firstVariant).toBeGreaterThan(-1);
    expect(ids.slice(firstVariant).every((id) => id.includes("/"))).toBe(true);
    expect(packVariants.length).toBeGreaterThan(0);
    // Every original (the approved ones and the packs') is shown.
    for (const original of packResults.filter(
      ({ provenance }) => provenance.kind !== "derived-variant",
    )) {
      expect(ids).toContain(original.id);
    }
  });
});

describe("initialLibraryEventId", () => {
  it("derives the event ID from the session, the decision and the artifact", () => {
    expect(
      initialLibraryEventId("session:a", "library-decision:1", "result:library-x/converse"),
    ).toBe("library-addition:session:a:library-decision:1:result:library-x/converse");
    expect(initialLibraryEventId("session:a", "d", "r")).not.toBe(
      initialLibraryEventId("session:b", "d", "r"),
    );
    expect(initialLibraryEventId("session:a", "d1", "r")).not.toBe(
      initialLibraryEventId("session:a", "d2", "r"),
    );
  });
});
