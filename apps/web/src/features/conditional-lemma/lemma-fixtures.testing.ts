import type { LibraryEntry } from "../library-drawer/api-contract";
import type { LemmaCandidate, LemmaCandidates, ReadyLemmaPreview } from "./api-contract";

/** Test fixtures shaped like the worker's conditional-lemma responses. */

export const READY_PREVIEW: ReadyLemmaPreview = {
  status: "ready",
  nodeId: "node:root",
  target: { kind: "goal", id: "goal:main" },
  name: "Lemma: p",
  statement: { latex: "p \\implies p", naturalLanguage: "if $p$, then $p$" },
  conclusion: { latex: "p", naturalLanguage: "$p$" },
  premises: [{ id: "hyp:p", latex: "p", naturalLanguage: "$p$" }],
  unusedHypotheses: [
    { id: "hyp:q", latex: "q", naturalLanguage: "$q$" },
    { id: "hyp:r", latex: "r", naturalLanguage: "$r$" },
  ],
  conservative: [],
  parameters: ["p"],
  establishingSteps: 1,
  backgroundInferences: 0,
  existing: [],
};

export const READY: LemmaCandidate = {
  nodeId: "node:root",
  target: { kind: "goal", id: "goal:main" },
  goal: { latex: "p", naturalLanguage: "$p$" },
  preview: READY_PREVIEW,
};

export const NOT_CLOSED: LemmaCandidate = {
  nodeId: "node:open",
  target: { kind: "goal", id: "goal:open" },
  goal: { latex: "s", naturalLanguage: "$s$" },
  preview: { status: "refused", code: "lemma-not-closed", message: "Open." },
};

export const USES_SORRY: LemmaCandidate = {
  nodeId: "node:sorry",
  target: { kind: "goal", id: "goal:sorry" },
  goal: { latex: "t", naturalLanguage: "$t$" },
  preview: { status: "refused", code: "lemma-uses-sorry", message: "Sorry." },
};

export const ALREADY_SAVED: LemmaCandidate = {
  nodeId: "node:saved",
  target: { kind: "goal", id: "goal:saved" },
  goal: { latex: "u", naturalLanguage: "$u$" },
  preview: {
    ...READY_PREVIEW,
    nodeId: "node:saved",
    existing: [{ artifactId: "result:lemma.command:save", status: "draft" }],
  },
};

export function candidates(list: readonly LemmaCandidate[], readOnly = false): LemmaCandidates {
  return { sessionId: "session:test", readOnly, candidates: [...list] };
}

/** A saved lemma draft, and the approved copy that records its review. */
export function lemmaDraft(overrides: Record<string, unknown> = {}): LibraryEntry {
  return {
    source: "stored-library",
    artifact: {
      id: "result:lemma.command:save",
      kind: "result",
      name: "Lemma: p",
      description: "Derived at proof node node:root of session session:test.",
      layer: "derived",
      renderings: { latex: "p \\implies p", naturalLanguage: "if $p$, then $p$" },
      classification: { domains: ["logic"], level: "foundational" },
      provenance: { kind: "derived", sessionId: "session:test", proofNodeId: "node:root" },
      approval: { status: "draft" },
      related: [],
      priority: 0,
      parameters: [{ id: "declaration:p", symbol: "p", sort: { kind: "proposition" } }],
      statement: { expression: "p" },
      premises: [{ expression: "p" }],
      sideConditions: [],
      applicationDirections: ["backward", "forward"],
      ...overrides,
    } as LibraryEntry["artifact"],
  };
}

export function lemmaReviewed(decision: "approved" | "rejected", notes = ""): LibraryEntry {
  return lemmaDraft({
    id: "result:lemma.command:save.review.command:r",
    approval:
      decision === "approved"
        ? { status: "approved", reviewerId: "actor:web" }
        : { status: "draft" },
    review: {
      decision,
      reviewerId: "actor:web",
      reviewedAt: "2026-10-02T00:00:00.000Z",
      notes,
      reviewOf: "result:lemma.command:save",
    },
  });
}
