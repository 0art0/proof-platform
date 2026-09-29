// @vitest-environment jsdom

/**
 * Roadmap N28 acceptance: the static viewers read only stored snapshots. Every function of the
 * kernel, move planner, retrieval index and protocol discovery/preview layer that could recompute
 * history or a menu is replaced by one that throws, and all three views still render, navigate and
 * show exactly the stored suggestion entries. The static guard below also forbids importing them.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const guards = vi.hoisted(() => {
  const forbidden = (name: string) =>
    vi.fn(() => {
      throw new Error(`${name} must not run in a static viewer`);
    });
  return {
    applyTransition: forbidden("applyTransition"),
    sorryClosure: forbidden("sorryClosure"),
    planMove: forbidden("planMove"),
    createRetrievalIndex: forbidden("createRetrievalIndex"),
    analyzeDiscoveryTree: forbidden("analyzeDiscoveryTree"),
    prunedProof: forbidden("prunedProof"),
    deriveArtifactFinalMaterial: forbidden("deriveArtifactFinalMaterial"),
    prepareDisplayedSuggestionSet: forbidden("prepareDisplayedSuggestionSet"),
    prepareMovePreview: forbidden("prepareMovePreview"),
    prepareProofCommand: forbidden("prepareProofCommand"),
    prepareInquiryCommand: forbidden("prepareInquiryCommand"),
    planSemanticReplay: forbidden("planSemanticReplay"),
    analyzeBacktrack: forbidden("analyzeBacktrack"),
  };
});

vi.mock("@proof/kernel", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applyTransition: guards.applyTransition,
  sorryClosure: guards.sorryClosure,
}));
vi.mock("@proof/moves", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  planMove: guards.planMove,
}));
vi.mock("@proof/retrieval", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createRetrievalIndex: guards.createRetrievalIndex,
}));
vi.mock("@proof/protocol", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  analyzeDiscoveryTree: guards.analyzeDiscoveryTree,
  prunedProof: guards.prunedProof,
  deriveArtifactFinalMaterial: guards.deriveArtifactFinalMaterial,
  prepareDisplayedSuggestionSet: guards.prepareDisplayedSuggestionSet,
  prepareMovePreview: guards.prepareMovePreview,
  prepareProofCommand: guards.prepareProofCommand,
  prepareInquiryCommand: guards.prepareInquiryCommand,
  planSemanticReplay: guards.planSemanticReplay,
  analyzeBacktrack: guards.analyzeBacktrack,
}));

const { DiscoveryTreeView } = await import("./discovery-tree-view");
const { PlaybackView } = await import("./playback-view");
const { PrunedProofViewer } = await import("./pruned-proof-viewer");
const { fixtureArtifact } = await import("./fixture.testing");

afterEach(cleanup);

function expectNothingRecomputed() {
  for (const [name, guard] of Object.entries(guards)) {
    expect(guard, name).not.toHaveBeenCalled();
  }
}

describe("static viewers do not recompute", () => {
  it("renders and navigates the discovery tree from stored snapshots and menus only", () => {
    render(<DiscoveryTreeView artifact={fixtureArtifact} />);
    for (const set of fixtureArtifact.tree.suggestionSets) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Node ${set.nodeId},`) }));
      const region = screen.getByRole("region", { name: `Displayed suggestion set ${set.id}` });
      const shown = [...region.querySelectorAll("li[data-suggestion-id]")].map((item) => [
        item.getAttribute("data-suggestion-id"),
        item.querySelector("strong")?.textContent,
        item.querySelectorAll("ul li").length,
      ]);
      expect(shown).toEqual(
        set.suggestions.map(({ id, name, reasons }) => [id, name, reasons.length]),
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Natural language" }));
    expect(within(screen.getByTestId("node-detail")).getByTestId("state-snapshot")).toBeVisible();
    expectNothingRecomputed();
  });

  it("plays back the whole stored history without recomputing", () => {
    render(<PlaybackView artifact={fixtureArtifact} />);
    const playback = screen.getByTestId("playback");
    for (let step = 0; step < 12; step += 1) fireEvent.keyDown(playback, { key: "ArrowRight" });
    expect(screen.getByTestId("step-status")).toHaveTextContent("Step 11 of 11");
    fireEvent.click(screen.getByRole("button", { name: "Natural language" }));
    fireEvent.keyDown(playback, { key: "Home" });
    expectNothingRecomputed();
  });

  it("shows the stored pruned proof, sorries and explanations without recomputing", () => {
    render(<PrunedProofViewer artifact={fixtureArtifact} />);
    expect(screen.getByTestId("proof-steps").children).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Natural language" }));
    expect(
      screen.getByRole("list", { name: "Assumptions this proof does not depend on" }),
    ).toBeVisible();
    expectNothingRecomputed();
  });

  it("imports no computing package and calls no analysis function in viewer sources", () => {
    const directory = __dirname;
    const sources = readdirSync(directory).filter(
      (name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name),
    );
    expect(sources.length).toBeGreaterThan(5);
    for (const name of sources) {
      const text = readFileSync(join(directory, name), "utf8");
      expect(text, name).not.toMatch(/@proof\/(kernel|moves|retrieval|library)/);
      expect(text, name).not.toMatch(
        /\b(analyzeDiscoveryTree|prunedProof|deriveArtifactFinalMaterial|prepare[A-Z]\w+|plan[A-Z]\w+)\(/,
      );
    }
  });
});
