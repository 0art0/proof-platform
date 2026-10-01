// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiscoveryTreeView } from "./discovery-tree-view";
import { fixtureArtifact, importedFixture, unsolvedFixture } from "./fixture.testing";
import { PlaybackView } from "./playback-view";
import { PrunedProofViewer } from "./pruned-proof-viewer";
import { viewerHref } from "./viewer-shell";

afterEach(cleanup);

const ROOT = "node:contraposition-root";

describe("the shell", () => {
  it("links the three views, shows solved status and marks imported sessions read-only", () => {
    const { unmount } = render(<DiscoveryTreeView artifact={fixtureArtifact} />);
    const nav = screen.getByRole("navigation", { name: "Stored views" });
    expect(within(nav).getByRole("link", { name: "Discovery tree" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Playback" })).toHaveAttribute(
      "href",
      viewerHref(fixtureArtifact.sessionId, "playback"),
    );
    expect(within(nav).getByRole("link", { name: "Pruned proof" })).toHaveAttribute(
      "href",
      "/sessions/session%3Aartifact-source/proof",
    );
    expect(within(nav).getByRole("link", { name: "Back to the workspace" })).toHaveAttribute(
      "href",
      "/sessions/session%3Aartifact-source",
    );
    expect(screen.getByTestId("solved-status")).toHaveTextContent("Solved");
    expect(screen.queryByTestId("read-only-note")).not.toBeInTheDocument();
    unmount();

    render(<DiscoveryTreeView artifact={importedFixture()} />);
    expect(screen.getByTestId("read-only-note")).toHaveTextContent("read-only");
  });

  it("says when a session is not solved", () => {
    render(<DiscoveryTreeView artifact={unsolvedFixture()} />);
    expect(screen.getByTestId("solved-status")).toHaveTextContent("Not solved");
  });
});

/** The fixture with its first two contraposition steps recorded as one macro application. */
function macroArtifact() {
  const link = (stepIndex: number) => ({
    moveId: "authored:intro-twice",
    previewId: "preview:macro",
    stepIndex,
    stepCount: 2,
    stepId: `step-${stepIndex}`,
  });
  const macroEdges = new Map([
    ["edge:command:contraposition-1", link(1)],
    ["edge:command:contraposition-2", link(2)],
  ]);
  return {
    ...fixtureArtifact,
    tree: {
      ...fixtureArtifact.tree,
      edges: fixtureArtifact.tree.edges.map((edge) => {
        const macro = macroEdges.get(edge.id);
        return macro === undefined ? edge : { ...edge, macro };
      }),
    },
  } as typeof fixtureArtifact;
}

describe("macro applications in the static viewers", () => {
  it("heads a macro's first step with one group line and labels every step", () => {
    render(<DiscoveryTreeView artifact={macroArtifact()} />);
    const outline = screen.getByTestId("tree-outline");
    const groups = outline.querySelectorAll("[data-macro-application]");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveTextContent("Macro Intro twice: 2 steps applied as one move");
    const first = outline.querySelector('[data-edge-id="edge:command:contraposition-1"]');
    const second = outline.querySelector('[data-edge-id="edge:command:contraposition-2"]');
    expect(first).toHaveTextContent("Macro Intro twice, step 1 of 2");
    expect(first).toHaveTextContent("Introduce implication");
    expect(second).toHaveTextContent("Macro Intro twice, step 2 of 2");
  });

  it("names the macro step in playback", () => {
    render(<PlaybackView artifact={macroArtifact()} />);
    const list = screen.getByTestId("step-list");
    expect(within(list).getByText("Macro Intro twice, step 2 of 2")).toBeInTheDocument();
  });
});

describe("DiscoveryTreeView", () => {
  it("lists every node with labelled edges and text badges for abandoned branches", () => {
    render(<DiscoveryTreeView artifact={fixtureArtifact} />);
    const outline = screen.getByTestId("tree-outline");
    const items = within(outline).getAllByRole("listitem");
    expect(items).toHaveLength(fixtureArtifact.tree.nodes.length);
    expect(within(outline).getAllByText("Abandoned branch")).toHaveLength(3);
    expect(within(outline).getAllByText("On the solved route")).toHaveLength(4);
    const sorry = within(outline).getByRole("button", { name: /node:command:sorry-kept/ });
    expect(sorry.closest("li")).toHaveTextContent("Abandoned branch");
    expect(sorry.closest("li")).toHaveTextContent(
      "mark-sorry".replace("-", " ").replace(/^m/, "M"),
    );
    const edge = items[1]?.querySelector("[data-edge-id]");
    expect(edge).toHaveTextContent("equivalence");
    expect(screen.getByText(/1 assumption/)).toBeInTheDocument();
  });

  it("shows the stored snapshot and the stored displayed suggestions of the selected node", () => {
    render(<DiscoveryTreeView artifact={fixtureArtifact} />);
    fireEvent.click(screen.getByRole("button", { name: `Node ${ROOT}, depth 0` }));
    const detail = screen.getByTestId("node-detail");
    expect(within(detail).getByRole("heading", { name: "Starting point" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Node ${ROOT}, depth 0` })).toHaveTextContent(
      "Starting point",
    );
    expect(within(detail).getByTestId("state-snapshot")).toHaveTextContent("goal:main");

    const stored = fixtureArtifact.tree.suggestionSets.filter(({ nodeId }) => nodeId === ROOT);
    expect(stored.length).toBeGreaterThan(0);
    for (const set of stored) {
      const region = within(detail).getByRole("region", {
        name: `Displayed suggestion set ${set.id}`,
      });
      const shown = [...region.querySelectorAll("li[data-suggestion-id]")].map((item) => [
        item.getAttribute("data-suggestion-id"),
        item.querySelector("strong")?.textContent,
      ]);
      // Exactly the stored entries, in stored order: nothing re-ranked, filtered or added.
      expect(shown).toEqual(set.suggestions.map(({ id, name }) => [id, name]));
    }
    expect(within(detail).getAllByText("Chosen").length).toBeGreaterThan(0);
  });

  it("moves between nodes through the detail panel and switches statement view", () => {
    render(<DiscoveryTreeView artifact={fixtureArtifact} />);
    fireEvent.click(screen.getByRole("button", { name: `Node ${ROOT}, depth 0` }));
    const outgoing = screen.getByRole("list", { name: "Outgoing transitions" });
    fireEvent.click(
      outgoing.querySelector<HTMLButtonElement>(
        '[data-child-node-id="node:command:contraposition-1"]',
      )!,
    );
    const detail = screen.getByTestId("node-detail");
    expect(within(detail).getByText("Recorded details")).toBeInTheDocument();
    expect(within(detail).getByText("introduce-implication")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Node node:command:contraposition-1, depth 1` }),
    ).toHaveAttribute("aria-pressed", "true");

    const natural = screen.getByRole("button", { name: "Natural language" });
    fireEvent.click(natural);
    expect(natural).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Formal (LaTeX)" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("moves focus through the outline with the arrow keys", () => {
    render(<DiscoveryTreeView artifact={fixtureArtifact} />);
    const first = screen.getByRole("button", { name: `Node ${ROOT}, depth 0` });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = within(screen.getByTestId("tree-outline")).getAllByRole("button")[1];
    expect(second).toHaveFocus();
    fireEvent.keyDown(second as HTMLElement, { key: "ArrowUp" });
    expect(first).toHaveFocus();
  });
});

describe("PlaybackView", () => {
  it("steps through the stored history with buttons and the keyboard", () => {
    render(<PlaybackView artifact={fixtureArtifact} />);
    const status = screen.getByTestId("step-status");
    expect(status).toHaveTextContent("Step 1 of 11");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "First" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(status).toHaveTextContent("Step 2 of 11");
    const playback = screen.getByTestId("playback");
    fireEvent.keyDown(playback, { key: "ArrowRight" });
    expect(status).toHaveTextContent("Step 3 of 11");
    fireEvent.keyDown(playback, { key: "ArrowLeft" });
    expect(status).toHaveTextContent("Step 2 of 11");
    fireEvent.keyDown(playback, { key: "End" });
    expect(status).toHaveTextContent("Step 11 of 11");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.keyDown(playback, { key: "Home" });
    expect(status).toHaveTextContent("Step 1 of 11");
  });

  it("shows the stored interaction, transition and inquiry entries with their snapshots", () => {
    render(<PlaybackView artifact={fixtureArtifact} />);
    const detail = screen.getByTestId("step-detail");
    expect(detail).toHaveTextContent("Interaction");
    expect(within(detail).getByTestId("state-snapshot")).toBeInTheDocument();
    const list = screen.getByTestId("step-list");
    expect(within(list).getAllByText("Proof step")).toHaveLength(6);
    expect(within(list).getAllByText("Interaction")).toHaveLength(2);
    expect(within(list).getAllByText("Inquiry record")).toHaveLength(3);

    fireEvent.click(within(list).getByRole("button", { name: /Attempt attempt:introduce/ }));
    expect(screen.getByTestId("step-detail")).toHaveTextContent("attempt");
    expect(screen.getByTestId("playback-order-note")).toHaveTextContent("causal order");
  });
});

describe("PrunedProofViewer", () => {
  it("shows the pruned steps with links to the records that motivated them", () => {
    render(<PrunedProofViewer artifact={fixtureArtifact} />);
    const steps = [...screen.getByTestId("proof-steps").children] as HTMLElement[];
    expect(steps).toHaveLength(3);
    const link = within(steps[0] as HTMLElement).getByRole("link", {
      name: /attempt.*attempt:introduce/,
    });
    expect(link).toHaveAttribute("href", "#inquiry-attempt:introduce");
    const record = document.getElementById("inquiry-attempt:introduce");
    expect(record).not.toBeNull();
    expect(
      record?.querySelector("[data-record-kind='attempt']")?.textContent?.length,
    ).toBeGreaterThan(0);
    expect(within(steps[1] as HTMLElement).queryByText(/Motivated by/)).not.toBeInTheDocument();
  });

  it("lists the sorry assumptions and toggles between LaTeX and natural language", () => {
    render(<PrunedProofViewer artifact={fixtureArtifact} />);
    expect(screen.getByTestId("no-sorry-dependency")).toBeInTheDocument();
    const abandoned = screen.getByRole("list", {
      name: "Assumptions this proof does not depend on",
    });
    expect(within(abandoned).getAllByRole("listitem")).toHaveLength(1);
    expect(abandoned).toHaveTextContent("Sorry, assumed without proof");
    expect(abandoned).toHaveTextContent("assumption:command:sorry-kept:sorry:0");

    const latexBefore = screen.getByTestId("proof-steps").innerHTML;
    fireEvent.click(screen.getByRole("button", { name: "Natural language" }));
    expect(screen.getByRole("button", { name: "Natural language" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("proof-steps").innerHTML).not.toBe(latexBefore);
  });

  it("names the sorries a proof depends on", () => {
    const sorry = fixtureArtifact.final.sorryAssumptions[0];
    const dependent = {
      ...fixtureArtifact,
      final: {
        ...fixtureArtifact.final,
        prunedProof: {
          ...(fixtureArtifact.final.prunedProof as Record<string, unknown>),
          assumptions: [sorry],
        },
      },
    } as typeof fixtureArtifact;
    render(<PrunedProofViewer artifact={dependent} />);
    expect(screen.queryByTestId("no-sorry-dependency")).not.toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Assumptions this proof depends on" }),
    ).toHaveTextContent("assumption:command:sorry-kept:sorry:0");
  });

  it("shows no proof for an unsolved tree", () => {
    render(<PrunedProofViewer artifact={unsolvedFixture()} />);
    expect(screen.getByText(/A pruned proof is the successful route only/)).toBeInTheDocument();
    expect(screen.getByTestId("not-solved")).toBeInTheDocument();
    expect(screen.queryByTestId("proof-steps")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Open targets" })).toHaveTextContent("goal:main");
  });
});
