import { describe, expect, it } from "vitest";
import { admitLibraryArtifact } from "./additions";
import { libraryArtifactSchema } from "./index";

const DIGEST = `sha256:${"a".repeat(64)}`;

function move(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "authored:m.draft.c1",
    kind: "move",
    name: "Authored move",
    description: "A template.",
    renderings: { latex: "m", naturalLanguage: "m" },
    classification: { domains: ["logic"], level: "foundational" },
    provenance: { kind: "curated", source: "authored:human" },
    approval: { status: "draft" },
    layer: "move-discovery-draft",
    related: [],
    priority: 0,
    template: { id: "authored:m" },
    definitionDigest: DIGEST,
    authorId: "human:a",
    ...overrides,
  };
}

function review(decision: string, extra: Record<string, unknown> = {}) {
  return {
    decision,
    reviewerId: "human:r",
    reviewedAt: "2026-09-30T10:00:00Z",
    notes: "notes",
    reviewOf: "authored:m.draft.c1",
    definitionDigest: DIGEST,
    ...extra,
  };
}

const admit = (artifact: unknown, layer = "move-discovery-draft" as const) =>
  admitLibraryArtifact({ artifact, layer, sessionId: "session:1" });

describe("move artifacts", () => {
  it("admits a draft and each review outcome in the draft layer", () => {
    expect(admit(move()).ok).toBe(true);
    expect(
      admit(
        move({
          approval: { status: "approved", reviewerId: "human:r" },
          review: review("approved"),
        }),
      ).ok,
    ).toBe(true);
    expect(
      admit(move({ approval: { status: "rejected", reason: "no" }, review: review("rejected") }))
        .ok,
    ).toBe(true);
    expect(admit(move({ review: review("changes-requested") })).ok).toBe(true);
  });

  it("rejects an approval that does not restate the review", () => {
    const cases = [
      move({ approval: { status: "approved", reviewerId: "human:r" } }),
      move({ approval: { status: "draft" }, review: review("approved") }),
      move({
        approval: { status: "approved", reviewerId: "human:other" },
        review: review("approved"),
      }),
      move({ approval: { status: "rejected", reason: "x" }, review: review("changes-requested") }),
      move({
        review: review("rejected", { notes: " " }),
        approval: { status: "rejected", reason: "x" },
      }),
      move({
        approval: { status: "approved", reviewerId: "human:r" },
        review: review("approved", { definitionDigest: `sha256:${"b".repeat(64)}` }),
      }),
    ];
    for (const artifact of cases) {
      expect(libraryArtifactSchema.safeParse(artifact).success).toBe(false);
    }
  });

  it("admits moves only to the move-discovery-draft layer", () => {
    const result = admit(
      move({
        layer: "proof-time-background",
        approval: { status: "approved", reviewerId: "h" },
        review: review("approved", { reviewerId: "h" }),
      }),
      "proof-time-background" as never,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map(({ code }) => code)).toContain("move-layer-required");
    }
  });
});
