import type { LibraryAdditionEventView, LibraryEntry, SessionLibrary } from "./api-contract";

/** Test fixtures shaped like the worker's library responses. */

const param = { id: "declaration:p", symbol: "p", sort: { kind: "proposition" } };

function artifact(id: string, overrides: Record<string, unknown> = {}): LibraryEntry["artifact"] {
  return {
    id,
    kind: "result",
    name: `Result ${id}`,
    description: `Description of ${id}.`,
    layer: "global",
    renderings: { latex: "p \\lor \\lnot p", naturalLanguage: "p or not p" },
    classification: { domains: ["logic"], level: "foundational" },
    provenance: { kind: "curated", source: "core pack" },
    approval: { status: "approved", reviewerId: "reviewer:core" },
    related: [],
    priority: 1,
    parameters: [param],
    statement: { expression: ["Or", "p", ["Not", "p"]] },
    premises: [],
    sideConditions: [],
    applicationDirections: ["backward"],
    ...overrides,
  } as LibraryEntry["artifact"];
}

export const excludedMiddle: LibraryEntry = {
  source: "approved-catalog",
  artifact: artifact("result:excluded-middle", {
    name: "Excluded middle",
    variantFamilyId: "family:middle",
  }),
};

export const contrapositive: LibraryEntry = {
  source: "approved-catalog",
  artifact: artifact("result:contrapositive", {
    name: "Contrapositive",
    provenance: {
      kind: "derived-variant",
      sourceId: "result:excluded-middle",
      transformation: "contrapositive",
    },
    variantFamilyId: "family:middle",
    premises: [{ expression: ["Not", "q"] }],
    applicationDirections: ["forward", "backward"],
  }),
};

export const continuity: LibraryEntry = {
  source: "stored-library",
  artifact: artifact("result:continuity", {
    name: "Continuity of sums",
    layer: "proof-time-background",
    classification: { domains: ["analysis"], level: "undergraduate" },
    provenance: { kind: "curated", source: "reader notes" },
    approval: { status: "draft" },
    renderings: { latex: "f + g \\text{ continuous}", naturalLanguage: "sums are continuous" },
  }),
};

export const derivedLemma: LibraryEntry = {
  source: "stored-library",
  artifact: artifact("result:lemma", {
    name: "Session lemma",
    layer: "derived",
    classification: { domains: ["logic", "analysis"], level: "undergraduate" },
    provenance: { kind: "derived", sessionId: "session:test", proofNodeId: "node:a" },
  }),
};

export const definition: LibraryEntry = {
  source: "approved-catalog",
  artifact: artifact("definition:even", {
    kind: "definition",
    name: "Even number",
    classification: { domains: ["number theory"], level: "foundational" },
    premises: undefined,
    applicationDirections: undefined,
    sideConditions: undefined,
  }),
};

export const ENTRIES: readonly LibraryEntry[] = [
  excludedMiddle,
  contrapositive,
  definition,
  continuity,
  derivedLemma,
];

export const LIBRARY: SessionLibrary = {
  sessionId: "session:test",
  readOnly: false,
  entries: [...ENTRIES],
  variantFamilies: [
    {
      id: "family:middle",
      name: "Middle family",
      memberIds: ["result:excluded-middle", "result:contrapositive", "result:missing"],
    },
  ],
};

export const EVENTS: readonly LibraryAdditionEventView[] = [
  {
    id: "addition:1",
    sequence: 1,
    occurredAt: "2026-09-29T11:00:01.000Z",
    layer: "proof-time-background",
    origin: { kind: "user", actorId: "user:reader" },
    classification: { domains: ["analysis"], level: "undergraduate" },
    admission: { decision: "admitted", diagnostics: [] },
    approval: { status: "draft" },
    artifact: continuity.artifact,
  },
  {
    id: "addition:2",
    sequence: 2,
    occurredAt: "2026-09-29T11:00:02.000Z",
    layer: "proof-time-background",
    origin: { kind: "agent" },
    classification: { domains: ["analysis"], level: "graduate" },
    admission: {
      decision: "rejected",
      diagnostics: [{ code: "level-above-background", message: "The level graduate is too high." }],
    },
    approval: { status: "approved", reviewerId: "reviewer:x" },
    artifact: artifact("result:hard", { name: "Hard result" }),
  },
];
