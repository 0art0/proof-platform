import { describe, expect, it } from "vitest";
import { parseProofArtifact } from "@proof/protocol";
import { storedAnalysis, storedPrunedProof, storedSorryAssumptions } from "./artifact-data";
import {
  fixtureArtifact,
  fixtureArtifactJson,
  importedFixture,
  unsolvedFixture,
} from "./fixture.testing";
import { inquiryExplanationContext } from "./inquiry-context";
import { buildPlaybackTimeline } from "./playback-timeline";
import { buildPrunedProofView } from "./pruned-proof-view";
import { buildTreeLayout } from "./tree-layout";

const ROOT = "node:contraposition-root";

describe("the fixture", () => {
  it("is a valid stored artifact", () => {
    expect(parseProofArtifact(fixtureArtifactJson)).toMatchObject({ ok: true });
    expect(importedFixture().provenance.kind).toBe("import");
  });
});

describe("buildTreeLayout", () => {
  const layout = buildTreeLayout(fixtureArtifact);

  it("lists every retained node once, root first, with abandoned branches", () => {
    expect(layout.rows).toHaveLength(fixtureArtifact.tree.nodes.length);
    expect(new Set(layout.rows.map(({ nodeId }) => nodeId)).size).toBe(layout.rows.length);
    expect(layout.rows[0]).toMatchObject({ nodeId: ROOT, depth: 0, isRoot: true });
    expect(layout.edges).toHaveLength(fixtureArtifact.tree.edges.length);
    expect(layout.solved).toBe(true);
    const status = Object.fromEntries(layout.rows.map((row) => [row.nodeId, row.routeStatus]));
    expect(status[ROOT]).toBe("solved-route");
    expect(status["node:command:contraposition-3"]).toBe("solved-route");
    expect(status["node:command:cases-on-p"]).toBe("abandoned");
    expect(status["node:command:sorry-kept"]).toBe("abandoned");
    expect(status["node:command:replay-first:replay:1"]).toBe("abandoned");
  });

  it("nests children under their parents in stored event order", () => {
    const depthOf = Object.fromEntries(layout.rows.map((row) => [row.nodeId, row.depth]));
    expect(depthOf["node:command:contraposition-1"]).toBe(1);
    expect(depthOf["node:command:contraposition-3"]).toBe(3);
    const positions = layout.rows.map(({ nodeId }) => nodeId);
    expect(positions.indexOf("node:command:contraposition-2")).toBe(
      positions.indexOf("node:command:contraposition-1") + 1,
    );
  });

  it("labels every edge with its move, transition class and stored evidence", () => {
    const first = layout.edges.find(({ edgeId }) => edgeId === "edge:command:contraposition-1");
    expect(first).toMatchObject({
      operationKind: "introduce-implication",
      transitionClass: "equivalence",
      evidence: "structural",
    });
    expect(first?.label.length).toBeGreaterThan(0);
    expect(layout.edges.find(({ edgeId }) => edgeId === "edge:command:sorry-kept")).toMatchObject({
      operationKind: "mark-sorry",
      evidence: undefined,
    });
    // The edge label is the stored chosen suggestion's name when there is one.
    const set = fixtureArtifact.tree.suggestionSets[0];
    const chosen = fixtureArtifact.tree.edges.find(
      ({ suggestionSetId }) => suggestionSetId === set?.id,
    );
    expect(set?.suggestions.map(({ name }) => name)).toContain(
      layout.edges.find(({ edgeId }) => edgeId === chosen?.id)?.label,
    );
  });

  it("marks the current node and calls an unsolved route partial", () => {
    expect(layout.rows.filter(({ isCurrent }) => isCurrent).map(({ nodeId }) => nodeId)).toEqual([
      fixtureArtifact.tree.currentNodeId,
    ]);
    const unsolved = buildTreeLayout(unsolvedFixture());
    expect(unsolved.solved).toBe(false);
    expect(unsolved.rows.find(({ nodeId }) => nodeId === ROOT)?.routeStatus).toBe("partial-route");
  });
});

describe("buildPlaybackTimeline", () => {
  const timeline = buildPlaybackTimeline(fixtureArtifact);
  const keys = timeline.entries.map(({ key }) => key);

  it("contains every stored transition, interaction event and inquiry record exactly once", () => {
    expect(timeline.counts).toEqual({ transitions: 6, interactions: 2, inquiries: 3 });
    expect(timeline.entries).toHaveLength(11);
    expect(new Set(keys).size).toBe(11);
  });

  it("plays parents before children and places records after their own step", () => {
    const position = (key: string) => keys.indexOf(key);
    expect(position("transition:edge:command:contraposition-1")).toBeLessThan(
      position("transition:edge:command:contraposition-2"),
    );
    expect(position("transition:edge:command:contraposition-2")).toBeLessThan(
      position("transition:edge:command:contraposition-3"),
    );
    // Records anchored at the root precede every transition; interaction events come first.
    const firstTransition = keys.findIndex((key) => key.startsWith("transition:"));
    expect(keys.slice(0, firstTransition)).toEqual([
      "interaction:interaction:requested-1",
      "inquiry:question:main",
      "inquiry:objective:main",
      "inquiry:attempt:introduce",
    ]);
    // The backtracking-with-information event follows the case split it recorded.
    expect(position("interaction:backtrack:command:cases-on-p")).toBe(
      position("transition:edge:command:cases-on-p") + 1,
    );
  });

  it("is empty for a tree without history entries", () => {
    const empty = buildPlaybackTimeline({
      ...fixtureArtifact,
      tree: { ...fixtureArtifact.tree, events: [], edges: [], nodes: [] },
      interactionEvents: [],
      inquiryRecords: [],
    });
    expect(empty.entries).toEqual([]);
  });
});

describe("buildPrunedProofView", () => {
  it("reads the stored pruned proof and links steps to the records that motivated them", () => {
    const view = buildPrunedProofView(fixtureArtifact);
    expect(view.solved).toBe(true);
    if (!view.solved) return;
    expect(view.steps.map(({ edgeId }) => edgeId)).toEqual(
      storedPrunedProof(fixtureArtifact)?.steps.map(({ edgeId }) => edgeId),
    );
    expect(view.steps.map(({ number }) => number)).toEqual([1, 2, 3]);
    expect(view.steps[0]?.motivatingRecords).toEqual([
      { recordId: "attempt:introduce", kind: "attempt", relation: "chose-this-suggestion" },
      { recordId: "objective:main", kind: "objective", relation: "motivating-context" },
      { recordId: "question:main", kind: "question", relation: "motivating-context" },
    ]);
    expect(view.steps[1]?.motivatingRecords).toEqual([]);
  });

  it("separates the sorries the proof depends on from those on abandoned branches", () => {
    const view = buildPrunedProofView(fixtureArtifact);
    if (!view.solved) throw new Error("expected a solved view");
    expect(view.assumptions).toEqual([]);
    expect(view.unusedSorryAssumptions.map(({ id }) => id)).toEqual(
      storedSorryAssumptions(fixtureArtifact).map(({ id }) => id),
    );
    expect(view.unusedSorryAssumptions).toHaveLength(1);
  });

  it("has no proof when the stored status is unsolved", () => {
    const view = buildPrunedProofView(unsolvedFixture());
    expect(view).toMatchObject({ solved: false, openTargets: [{ kind: "goal", id: "goal:main" }] });
    expect(view.solved ? [] : view.sorryAssumptions).toHaveLength(1);
  });
});

describe("stored final material and the explainer context", () => {
  it("narrows the stored JSON without recomputing it", () => {
    expect(storedAnalysis(fixtureArtifact)?.solved).toBe(true);
    expect(
      storedAnalysis({ ...fixtureArtifact, final: { ...fixtureArtifact.final, analysis: null } }),
    ).toBe(undefined);
    expect(storedPrunedProof(unsolvedFixture())).toBeUndefined();
  });

  it("assembles the explainer context from stored rows", () => {
    const context = inquiryExplanationContext(fixtureArtifact);
    expect(context.nodes.size).toBe(fixtureArtifact.tree.nodes.length);
    expect(context.records.size).toBe(3);
    expect(context.transitions?.get("node:command:contraposition-1")).toMatchObject({
      transitionClass: "equivalence",
      evidence: "structural",
    });
    const set = fixtureArtifact.tree.suggestionSets[0];
    expect([...(context.suggestionLabels?.get(set?.id ?? "")?.values() ?? [])]).toEqual(
      set?.suggestions.map(({ name }) => name),
    );
  });
});
