// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProofNodeSchema, type ProofNode } from "@proof/protocol";
import {
  WorkspaceHeader,
  branchBreadcrumb,
  snapshotStatusText,
  type HistoryEdgeRecord,
} from "./workspace-header";
import { WorkspaceToolbar, proofStateJson } from "./workspace-toolbar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function node(id: string, goals: number, obligations = 0): ProofNode {
  const target = (kind: string, index: number) => ({
    id: `${kind}:${id.replace("node:", "")}-${index}`,
    sequent: { context: { declarations: [], hypotheses: [] }, conclusion: { expression: "True" } },
  });
  return createProofNodeSchema().parse({
    id,
    state: {
      id: id.replace("node:", "state:"),
      goals: Array.from({ length: goals }, (_unused, index) => target("goal", index)),
      obligations: Array.from({ length: obligations }, (_unused, index) =>
        target("obligation", index),
      ),
    },
  });
}

function edge(parent: string, child: string, name: string): HistoryEdgeRecord {
  return { name, edge: { parentNodeId: parent, childNodeId: child } };
}

describe("branchBreadcrumb", () => {
  const nodes = ["node:root", "node:a", "node:b", "node:c"].map((id) => node(id, 1));

  it("follows parent edges from the root to the current node only", () => {
    const edges = [
      edge("node:root", "node:a", "Split"),
      edge("node:root", "node:b", "Expand"),
      edge("node:a", "node:c", "Close"),
    ];
    expect(branchBreadcrumb(nodes, edges, "node:c")).toEqual([
      { nodeId: "node:root", label: "Root" },
      { nodeId: "node:a", label: "Split" },
      { nodeId: "node:c", label: "Close" },
    ]);
    expect(branchBreadcrumb(nodes, edges, "node:root")).toEqual([
      { nodeId: "node:root", label: "Root" },
    ]);
  });

  it("rejects an unknown current node and a cyclic history", () => {
    expect(branchBreadcrumb(nodes, [], "node:missing")).toBeUndefined();
    expect(
      branchBreadcrumb(
        nodes,
        [edge("node:a", "node:b", "x"), edge("node:b", "node:a", "y")],
        "node:a",
      ),
    ).toBeUndefined();
  });
});

describe("snapshotStatusText", () => {
  it("reports open targets without claiming provability", () => {
    expect(snapshotStatusText({ goals: 0, obligations: 0 })).toBe("No open goals");
    expect(snapshotStatusText({ goals: 1, obligations: 0 })).toBe("Open: 1 goal, 0 obligations");
    expect(snapshotStatusText({ goals: 2, obligations: 1 })).toBe("Open: 2 goals, 1 obligation");
  });
});

describe("WorkspaceHeader", () => {
  const baseProps = {
    sessionId: "session:test",
    currentNodeId: "node:c",
    counts: { goals: 1, obligations: 1 },
  } as const;

  it("falls back to the session id as title and hides an absent background", () => {
    render(<WorkspaceHeader {...baseProps} breadcrumb={{ kind: "loading" }} />);
    expect(screen.getByRole("heading", { level: 1, name: "session:test" })).toBeVisible();
    expect(screen.getAllByText("session:test")).toHaveLength(1);
    expect(screen.getByText("Proof session")).toBeVisible();
    expect(screen.getByText("Current node node:c")).toBeVisible();
    expect(screen.getByText("Loading branch…")).toBeVisible();
    expect(document.querySelector("header p:nth-of-type(3)")).toBeNull();
  });

  it("shows problem metadata when supplied", () => {
    render(
      <WorkspaceHeader
        {...baseProps}
        title="Infinitely many primes"
        background="Euclid's argument."
        breadcrumb={{ kind: "unavailable" }}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Infinitely many primes" })).toBeVisible();
    expect(screen.getByText("Euclid's argument.")).toBeVisible();
    expect(screen.getByText("Branch unavailable")).toBeVisible();
  });

  it("labels the snapshot status so it is not read as a provability result", () => {
    const { rerender } = render(
      <WorkspaceHeader {...baseProps} breadcrumb={{ kind: "loading" }} />,
    );
    const status = screen.getByTestId("snapshot-status");
    expect(status).toHaveTextContent("Snapshot targets: Open: 1 goal, 1 obligation");
    expect(status).toHaveAttribute("title", expect.stringContaining("not a provability check"));
    expect(status).toHaveAttribute("data-closed", "false");

    rerender(
      <WorkspaceHeader
        {...baseProps}
        counts={{ goals: 0, obligations: 0 }}
        breadcrumb={{ kind: "loading" }}
      />,
    );
    expect(screen.getByTestId("snapshot-status")).toHaveTextContent("No open goals");
    expect(screen.getByTestId("snapshot-status")).toHaveAttribute("data-closed", "true");
  });

  it("renders the branch breadcrumb with the current step marked", () => {
    render(
      <WorkspaceHeader
        {...baseProps}
        breadcrumb={{
          kind: "ready",
          crumbs: [
            { nodeId: "node:root", label: "Root" },
            { nodeId: "node:a", label: "Split" },
            { nodeId: "node:c", label: "Close" },
          ],
        }}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Current branch" });
    const items = within(nav).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Root", "Split", "Close"]);
    expect(items[2]).toHaveAttribute("aria-current", "step");
    expect(items[0]).not.toHaveAttribute("aria-current");
  });

  it("collapses the middle of a long branch", () => {
    const crumbs = Array.from({ length: 8 }, (_unused, index) => ({
      nodeId: `node:${index}`,
      label: index === 0 ? "Root" : `Step ${index}`,
    }));
    render(<WorkspaceHeader {...baseProps} breadcrumb={{ kind: "ready", crumbs }} />);
    const items = within(screen.getByRole("navigation")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Root",
      "…",
      "Step 5",
      "Step 6",
      "Step 7",
    ]);
    expect(items[1]).toHaveAttribute("aria-label", "4 earlier steps");
  });
});

describe("WorkspaceToolbar", () => {
  const snapshot = node("node:root", 1, 1);

  it("toggles between formal and natural-language views", () => {
    const onViewChange = vi.fn();
    const { rerender } = render(
      <WorkspaceToolbar
        view="formal"
        onViewChange={onViewChange}
        sessionId="session:test"
        node={snapshot}
      />,
    );
    const formal = screen.getByRole("button", { name: "Formal (LaTeX)" });
    const prose = screen.getByRole("button", { name: "Natural language" });
    expect(formal).toHaveAttribute("aria-pressed", "true");
    expect(prose).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(prose);
    expect(onViewChange).toHaveBeenCalledWith("natural-language");

    rerender(
      <WorkspaceToolbar
        view="natural-language"
        onViewChange={onViewChange}
        sessionId="session:test"
        node={snapshot}
      />,
    );
    expect(prose).toHaveAttribute("aria-pressed", "true");
  });

  it("discloses the raw stored MathJSON of the current snapshot", () => {
    render(
      <WorkspaceToolbar
        view="formal"
        onViewChange={() => undefined}
        sessionId="session:test"
        node={snapshot}
      />,
    );
    fireEvent.click(screen.getByText("More tools"));
    const details = screen.getByText("View raw MathJSON").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("View raw MathJSON"));
    const raw = JSON.parse(screen.getByTestId("raw-proof-state").textContent ?? "");
    expect(raw).toEqual({ sessionId: "session:test", nodeId: snapshot.id, state: snapshot.state });
  });

  it("copies the proof state as JSON and confirms it visibly", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <WorkspaceToolbar
        view="formal"
        onViewChange={() => undefined}
        sessionId="session:test"
        node={snapshot}
      />,
    );
    fireEvent.click(screen.getByText("More tools"));
    fireEvent.click(screen.getByRole("button", { name: "Copy proof state as JSON" }));
    await screen.findByText("Proof state copied to the clipboard.");
    expect(writeText).toHaveBeenCalledWith(proofStateJson("session:test", snapshot));
    expect(screen.getByText("Proof state copied to the clipboard.")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("reports a denied clipboard write gracefully", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    render(
      <WorkspaceToolbar
        view="formal"
        onViewChange={() => undefined}
        sessionId="session:test"
        node={snapshot}
      />,
    );
    fireEvent.click(screen.getByText("More tools"));
    fireEvent.click(screen.getByRole("button", { name: "Copy proof state as JSON" }));
    await screen.findByText(/Copy failed: clipboard permission was denied/);
  });

  it("reports an unavailable clipboard without throwing", async () => {
    vi.stubGlobal("navigator", {});
    render(
      <WorkspaceToolbar
        view="formal"
        onViewChange={() => undefined}
        sessionId="session:test"
        node={snapshot}
      />,
    );
    fireEvent.click(screen.getByText("More tools"));
    fireEvent.click(screen.getByRole("button", { name: "Copy proof state as JSON" }));
    await waitFor(() =>
      expect(screen.getByText(/Copy failed: the clipboard is unavailable/)).toBeVisible(),
    );
  });
});

describe("WorkspaceHeader problem statement", () => {
  it("shows the title as the heading, the session id as the eyebrow, and the statement collapsed", () => {
    render(
      <WorkspaceHeader
        sessionId="session:test"
        title="Commute a conjunction"
        statement="Show that p and q implies q and p."
        currentNodeId="node:c"
        counts={{ goals: 1, obligations: 0 }}
        breadcrumb={{ kind: "loading" }}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Commute a conjunction" }),
    ).toHaveAttribute("title", "session:test");
    expect(screen.getByText("session:test")).toBeVisible();
    const details = screen.getByText("Problem statement").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("Show that p and q implies q and p.");
  });

  it("omits the statement section when there is no statement", () => {
    render(
      <WorkspaceHeader
        sessionId="session:test"
        currentNodeId="node:c"
        counts={{ goals: 1, obligations: 0 }}
        breadcrumb={{ kind: "loading" }}
      />,
    );
    expect(screen.queryByText("Problem statement")).toBeNull();
  });
});
