import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  approvalLabel,
  availableDomains,
  filterEntries,
  groupByLayer,
  layerCounts,
  provenanceLabel,
  variantFamilyDetail,
} from "./library-view-model";
import {
  ENTRIES,
  LIBRARY,
  contrapositive,
  continuity,
  definition,
  derivedLemma,
  excludedMiddle,
} from "./library-fixtures.testing";

const ids = (entries: readonly { artifact: { id: string } }[]) =>
  entries.map(({ artifact }) => artifact.id);

describe("filterEntries", () => {
  it("returns everything for the empty filter", () => {
    expect(filterEntries(ENTRIES, EMPTY_FILTER)).toEqual(ENTRIES);
  });

  it("searches names, ids, domains, renderings and provenance, all words in any order", () => {
    const search = (query: string) => ids(filterEntries(ENTRIES, { ...EMPTY_FILTER, query }));
    expect(search("continuity")).toEqual(["result:continuity"]);
    expect(search("NUMBER theory")).toEqual(["definition:even"]);
    expect(search("sums continuous")).toEqual(["result:continuity"]);
    expect(search("reader notes")).toEqual(["result:continuity"]);
    expect(search("contrapositive variant")).toEqual(["result:contrapositive"]);
    expect(search("no such text")).toEqual([]);
  });

  it("filters by kind, domain and layer, and combines criteria", () => {
    expect(ids(filterEntries(ENTRIES, { ...EMPTY_FILTER, kind: "definition" }))).toEqual([
      "definition:even",
    ]);
    expect(ids(filterEntries(ENTRIES, { ...EMPTY_FILTER, domain: "analysis" }))).toEqual([
      "result:continuity",
      "result:lemma",
    ]);
    expect(ids(filterEntries(ENTRIES, { ...EMPTY_FILTER, layer: "derived" }))).toEqual([
      "result:lemma",
    ]);
    expect(
      ids(
        filterEntries(ENTRIES, {
          ...EMPTY_FILTER,
          domain: "logic",
          kind: "result",
          query: "lemma",
        }),
      ),
    ).toEqual(["result:lemma"]);
  });
});

describe("grouping and labels", () => {
  it("lists domains sorted and groups by layer in canonical order", () => {
    expect(availableDomains(ENTRIES)).toEqual(["analysis", "logic", "number theory"]);
    expect(groupByLayer(ENTRIES).map(({ layer, entries }) => [layer, entries.length])).toEqual([
      ["global", 3],
      ["proof-time-background", 1],
      ["derived", 1],
    ]);
    expect(layerCounts(ENTRIES).find(({ layer }) => layer === "initial-problem")?.count).toBe(0);
  });

  it("keeps approval and provenance distinctions in words", () => {
    expect(approvalLabel(excludedMiddle.artifact.approval)).toBe(
      "Approved (reviewer reviewer:core)",
    );
    expect(approvalLabel(continuity.artifact.approval)).toBe("Draft (not approved)");
    expect(approvalLabel({ status: "rejected", reason: "wrong" })).toBe("Rejected: wrong");
    expect(provenanceLabel(derivedLemma.artifact.provenance)).toContain("Derived in session");
    expect(provenanceLabel(contrapositive.artifact.provenance)).toBe(
      "Variant of result:excluded-middle (contrapositive)",
    );
    expect(provenanceLabel(definition.artifact.provenance)).toBe("Curated: core pack");
  });

  it("resolves a variant family's members present in the library", () => {
    const detail = variantFamilyDetail(excludedMiddle.artifact, LIBRARY.variantFamilies, ENTRIES);
    expect(detail?.members.map(({ id, entry }) => [id, entry !== undefined])).toEqual([
      ["result:excluded-middle", true],
      ["result:contrapositive", true],
      ["result:missing", false],
    ]);
    expect(
      variantFamilyDetail(continuity.artifact, LIBRARY.variantFamilies, ENTRIES),
    ).toBeUndefined();
  });
});
