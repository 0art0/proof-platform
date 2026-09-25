import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_LEVELS,
  admissionRecord,
  admitLibraryArtifact,
  applyBackgroundRevisions,
  backgroundProfileSchema,
  backgroundRevisionEventSchema,
  checkBackgroundAdmission,
  createLibraryAdditionEventSchema,
  libraryResultSchema,
  type BackgroundLevel,
  type BackgroundProfile,
  type BackgroundRevisionEvent,
  type LibraryLayer,
  type LibraryResult,
} from "./index";

const SESSION = "session:one";

function profile(overrides: Partial<BackgroundProfile> = {}): BackgroundProfile {
  return backgroundProfileSchema.parse({
    level: "undergraduate",
    summary: "Elementary logic.",
    assumptions: [],
    domains: ["logic"],
    maximumLevel: "undergraduate",
    ...overrides,
  });
}

function result(overrides: Record<string, unknown> = {}): LibraryResult {
  return libraryResultSchema.parse({
    kind: "result",
    id: "result:test",
    name: "Test result",
    description: "A test-only result.",
    renderings: { latex: "p", naturalLanguage: "p" },
    classification: { domains: ["logic"], level: "foundational" },
    provenance: { kind: "curated", source: "unit test" },
    approval: { status: "approved", reviewerId: "reviewer:test" },
    layer: "proof-time-background",
    related: [],
    priority: 1,
    parameters: [
      {
        id: "declaration:p",
        symbol: "p",
        sort: { kind: "proposition" },
        role: "universal-parameter",
      },
    ],
    statement: { expression: ["Or", "p", ["Not", "p"]] },
    premises: [],
    sideConditions: [],
    applicationDirections: ["backward"],
    patterns: [
      {
        id: "pattern:test",
        expression: ["Or", "p", ["Not", "p"]],
        direction: "backward",
        requirement: { section: "goal", polarity: "any", role: "proposition" },
      },
    ],
    ...overrides,
  });
}

function revision(
  sequence: number,
  previous: BackgroundProfile,
  revised: BackgroundProfile,
): BackgroundRevisionEvent {
  return backgroundRevisionEventSchema.parse({
    id: `revision:${sequence}`,
    sessionId: SESSION,
    sequence,
    occurredAt: "2026-09-26T00:00:00.000Z",
    previous,
    revised,
    reason: "The reader knows analysis.",
    actor: { kind: "user", id: "user:reader" },
  });
}

const codes = (outcome: ReturnType<typeof admitLibraryArtifact>) =>
  outcome.diagnostics.map((diagnostic) => diagnostic.code);

describe("library admission gate", () => {
  it("admits a proof-time background result within the profile", () => {
    const outcome = admitLibraryArtifact({
      artifact: result(),
      layer: "proof-time-background",
      sessionId: SESSION,
      profile: profile(),
    });
    expect(outcome.ok).toBe(true);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(admissionRecord(outcome)).toEqual({ decision: "admitted", diagnostics: [] });
  });

  it("rejects a result outside the background and records why", () => {
    const outside = result({ classification: { domains: ["analysis"], level: "graduate" } });
    const outcome = admitLibraryArtifact({
      artifact: outside,
      layer: "proof-time-background",
      sessionId: SESSION,
      profile: profile(),
    });
    expect(outcome.ok).toBe(false);
    expect(codes(outcome)).toEqual(["domain-outside-background", "level-above-background"]);
    expect(admissionRecord(outcome).decision).toBe("rejected");
    expect(
      admitLibraryArtifact({
        artifact: outside,
        layer: "proof-time-background",
        sessionId: SESSION,
      }).diagnostics[0]?.code,
    ).toBe("background-profile-missing");
  });

  it("admits the same result only after a recorded background revision", () => {
    const outside = result({ classification: { domains: ["analysis"], level: "graduate" } });
    const initial = profile();
    const revised = profile({ domains: ["logic", "analysis"], maximumLevel: "graduate" });
    const outcome = admitLibraryArtifact({
      artifact: outside,
      layer: "proof-time-background",
      sessionId: SESSION,
      profile: initial,
      revisions: [revision(0, initial, revised)],
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.profile).toEqual(revised);
  });

  it("rejects broken revision chains", () => {
    const initial = profile();
    const revised = profile({ maximumLevel: "graduate" });
    const unrelated = profile({ domains: ["algebra"] });
    expect(applyBackgroundRevisions(initial, [revision(0, unrelated, revised)]).ok).toBe(false);
    expect(
      applyBackgroundRevisions(initial, [
        revision(1, initial, revised),
        revision(0, revised, initial),
      ]).ok,
    ).toBe(false);
    expect(
      applyBackgroundRevisions(initial, [revision(0, initial, revised)], "session:other").ok,
    ).toBe(false);
    expect(
      backgroundRevisionEventSchema.safeParse({
        ...revision(0, initial, revised),
        revised: initial,
      }).success,
    ).toBe(false);
  });

  it("applies curated approval rules to the global and initial-problem layers", () => {
    const draft = { approval: { status: "draft" } };
    expect(
      admitLibraryArtifact({ artifact: result({ layer: "global" }), layer: "global" }).ok,
    ).toBe(true);
    expect(
      codes(
        admitLibraryArtifact({ artifact: result({ ...draft, layer: "global" }), layer: "global" }),
      ),
    ).toEqual(["approval-required"]);
    expect(
      codes(
        admitLibraryArtifact({
          artifact: result({ layer: "initial-problem" }),
          layer: "initial-problem",
        }),
      ),
    ).toEqual(["scope-mismatch"]);
    expect(
      codes(
        admitLibraryArtifact({
          artifact: result({ layer: "global" }),
          layer: "global",
          sessionId: SESSION,
        }),
      ),
    ).toEqual(["scope-mismatch"]);
    expect(
      codes(
        admitLibraryArtifact({
          artifact: result({ layer: "global", approval: { status: "rejected", reason: "wrong" } }),
          layer: "global",
        }),
      ),
    ).toEqual(["approval-rejected", "approval-required"]);
    expect(
      codes(
        admitLibraryArtifact({ artifact: result(), layer: "initial-problem", sessionId: SESSION }),
      ),
    ).toEqual(["layer-mismatch"]);
    expect(codes(admitLibraryArtifact({ artifact: { kind: "result" }, layer: "global" }))).toEqual([
      "invalid-artifact",
    ]);
  });

  it("admits derived results only with derived provenance for this session and node", () => {
    const derived = (provenance: unknown) =>
      result({ layer: "derived", approval: { status: "draft" }, provenance });
    const good = { kind: "derived", sessionId: SESSION, proofNodeId: "node:3" };
    expect(
      admitLibraryArtifact({
        artifact: derived(good),
        layer: "derived",
        sessionId: SESSION,
        proofNodeIds: ["node:3"],
      }).ok,
    ).toBe(true);
    expect(
      codes(
        admitLibraryArtifact({
          artifact: derived({ kind: "curated", source: "claimed" }),
          layer: "derived",
          sessionId: SESSION,
        }),
      ),
    ).toEqual(["derived-provenance-required"]);
    expect(
      codes(
        admitLibraryArtifact({
          artifact: derived({ ...good, sessionId: "session:other" }),
          layer: "derived",
          sessionId: SESSION,
          proofNodeIds: [],
        }),
      ),
    ).toEqual(["derived-session-mismatch", "derived-node-not-found"]);
    expect(
      codes(
        admitLibraryArtifact({
          artifact: result({ provenance: good }),
          layer: "proof-time-background",
          sessionId: SESSION,
          profile: profile(),
        }),
      ),
    ).toEqual(["derived-layer-required"]);
  });

  it("admits move-discovery additions as drafts only", () => {
    const layer = "move-discovery-draft";
    expect(
      admitLibraryArtifact({
        artifact: result({ layer, approval: { status: "draft" } }),
        layer,
        sessionId: SESSION,
      }).ok,
    ).toBe(true);
    expect(
      codes(admitLibraryArtifact({ artifact: result({ layer }), layer, sessionId: SESSION })),
    ).toEqual(["draft-required"]);
  });

  it("agrees with the background check for every proof-time classification", () => {
    const level = fc.constantFrom<BackgroundLevel>(...BACKGROUND_LEVELS);
    const domains = fc.uniqueArray(fc.constantFrom("logic", "algebra", "analysis"), {
      minLength: 1,
    });
    fc.assert(
      fc.property(
        domains,
        level,
        domains,
        level,
        (artifactDomains, artifactLevel, pDomains, max) => {
          const classification = { domains: artifactDomains, level: artifactLevel };
          const current = profile({ domains: pDomains, maximumLevel: max });
          const outcome = admitLibraryArtifact({
            artifact: result({ classification }),
            layer: "proof-time-background",
            sessionId: SESSION,
            profile: current,
          });
          expect(outcome.ok).toBe(checkBackgroundAdmission(classification, current).ok);
        },
      ),
    );
  });
});

describe("library addition events", () => {
  const schema = createLibraryAdditionEventSchema();
  const event = (layer: LibraryLayer, overrides: Record<string, unknown> = {}) => {
    const artifact = result({ layer });
    return {
      id: "addition:1",
      sessionId: SESSION,
      sequence: 0,
      occurredAt: "2026-09-26T00:00:00.000Z",
      artifact,
      layer,
      origin: { kind: "user", actorId: "user:reader" },
      classification: artifact.classification,
      admission: { decision: "admitted", diagnostics: [] },
      approval: artifact.approval,
      ...overrides,
    };
  };

  it("requires the event to restate the artifact's layer, classification and approval", () => {
    expect(schema.safeParse(event("proof-time-background")).success).toBe(true);
    expect(schema.safeParse({ ...event("proof-time-background"), layer: "derived" }).success).toBe(
      false,
    );
    expect(
      schema.safeParse(
        event("proof-time-background", {
          classification: { domains: ["analysis"], level: "graduate" },
        }),
      ).success,
    ).toBe(false);
    expect(
      schema.safeParse(event("proof-time-background", { approval: { status: "draft" } })).success,
    ).toBe(false);
    expect(schema.safeParse(event("global")).success).toBe(false);
    const global: Record<string, unknown> = { ...event("global") };
    delete global.sessionId;
    expect(schema.safeParse(global).success).toBe(true);
  });

  it("records rejections only with diagnostics", () => {
    expect(
      schema.safeParse(
        event("proof-time-background", { admission: { decision: "rejected", diagnostics: [] } }),
      ).success,
    ).toBe(false);
    expect(
      schema.safeParse(
        event("proof-time-background", {
          admission: {
            decision: "rejected",
            diagnostics: [{ code: "level-above-background", message: "Too advanced." }],
          },
        }),
      ).success,
    ).toBe(true);
  });
});
