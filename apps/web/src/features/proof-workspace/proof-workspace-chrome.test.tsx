// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proofNodeSchema, type ProofNode } from "@proof/protocol";
import { ProofWorkspace } from "./proof-workspace";

vi.mock("mathlive", () => {
  class MockMathfieldElement extends HTMLElement {
    static fontsDirectory: string | null = "fonts";
    readOnly = false;
    value = "";
    selection = { ranges: [[0, 0] as [number, number]] };
    selectionIsCollapsed = true;
    position = 4;
    lastOffset = 20;

    getValue(): string {
      return '"x"';
    }

    getElementInfo(): { data: Record<string, string> } {
      return { data: { "proof-path-1": "0" } };
    }
  }

  if (!customElements.get("math-field")) customElements.define("math-field", MockMathfieldElement);
  return { MathfieldElement: MockMathfieldElement };
});

afterEach(cleanup);

const realSort = { kind: "named", id: "sort:real" } as const;

function proofNode(goalConclusion: unknown = ["Equal", ["Add", "x", "y"], 4]): ProofNode {
  return proofNodeSchema.parse({
    id: "node:chrome",
    state: {
      id: "state:chrome",
      goals: [
        {
          id: "goal:sum",
          sequent: {
            context: {
              declarations: [
                { id: "declaration:x", symbol: "x", sort: realSort, role: "universal-parameter" },
                { id: "declaration:y", symbol: "y", sort: realSort, role: "local-witness" },
              ],
              hypotheses: [
                { id: "hypothesis:positive", statement: { expression: ["Greater", "x", 0] } },
                {
                  id: "hypothesis:implication",
                  statement: { expression: ["Implies", ["Greater", "y", 0], ["Greater", "x", 0]] },
                },
              ],
            },
            conclusion: { expression: goalConclusion },
          },
        },
      ],
      obligations: [
        {
          id: "obligation:step",
          sequent: {
            context: {
              declarations: [
                { id: "declaration:n", symbol: "n", sort: realSort, role: "universal-parameter" },
              ],
              hypotheses: [],
            },
            conclusion: { expression: ["Greater", "n", 0] },
          },
        },
      ],
    },
  });
}

function selectionCount() {
  return document.querySelectorAll("[data-selection-key]").length;
}

describe("ProofWorkspace selection feedback", () => {
  it("announces the interpreted gesture outcome in a polite live region", async () => {
    render(<ProofWorkspace node={proofNode()} />);
    const feedback = screen.getByTestId("selection-feedback");
    expect(feedback).toHaveAttribute("aria-live", "polite");
    const conclusion = await screen.findByLabelText("Goal 1 conclusion");

    fireEvent.pointerUp(conclusion);
    expect(feedback).toHaveTextContent("Click it again to expand to its parent.");
    expect(feedback).toHaveAttribute("data-outcome", "replaced");
    fireEvent.pointerUp(conclusion);
    expect(feedback).toHaveTextContent("Expanded to parent.");
    fireEvent.pointerUp(conclusion);
    expect(feedback).toHaveAttribute("data-outcome", "saturated");

    fireEvent.pointerUp(await screen.findByLabelText("Obligation 1 conclusion"), {
      ctrlKey: true,
    });
    expect(feedback).toHaveAttribute("data-outcome", "added");
  });

  it("ignores secondary-button gestures", async () => {
    render(<ProofWorkspace node={proofNode()} />);
    fireEvent.pointerUp(await screen.findByLabelText("Goal 1 conclusion"), { button: 2 });
    expect(screen.getByText("Nothing selected yet.")).toBeVisible();
  });

  it("says when stale display metadata was snapped to a subtree", async () => {
    render(<ProofWorkspace node={proofNode()} />);
    const conclusion = await screen.findByLabelText("Goal 1 conclusion");
    Object.assign(conclusion, { getElementInfo: () => ({ data: { "proof-path-2": "9.2" } }) });
    fireEvent.pointerUp(conclusion);
    expect(screen.getByTestId("selection-feedback")).toHaveTextContent(
      /^Snapped to nearest subtree/,
    );
    expect(screen.getByText("path root")).toBeVisible();
  });
});

describe("ProofWorkspace Escape", () => {
  it("clears every selection with Escape, like the Clear button", async () => {
    const onSelectionChange = vi.fn();
    render(<ProofWorkspace node={proofNode()} onSelectionChange={onSelectionChange} />);
    fireEvent.pointerUp(await screen.findByLabelText("Goal 1 conclusion"));
    fireEvent.pointerUp(await screen.findByLabelText("Obligation 1 conclusion"), {
      ctrlKey: true,
    });
    expect(selectionCount()).toBe(2);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(selectionCount()).toBe(0);
    expect(screen.getByTestId("selection-feedback")).toHaveTextContent("Selections cleared.");
    await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith([]));
    expect(screen.getByRole("button", { name: "Clear selections" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Escape",
    );
  });

  it("does not react to other keys", async () => {
    render(<ProofWorkspace node={proofNode()} />);
    fireEvent.pointerUp(await screen.findByLabelText("Goal 1 conclusion"));
    fireEvent.keyDown(document, { key: "Enter" });
    expect(selectionCount()).toBe(1);
  });
});

describe("ProofWorkspace visual families", () => {
  it("labels every family and polarity independently of colour", () => {
    render(<ProofWorkspace node={proofNode()} />);
    const legend = screen.getByRole("list", { name: "Colour key" });
    for (const label of [
      "Variable",
      "Hypothesis",
      "Goal",
      "Obligation / assumption",
      "Positive (goal-like): inward bevel",
      "Negative (hypothesis-like): outward bevel",
    ]) {
      expect(within(legend).getByText(label)).toBeInTheDocument();
    }

    const goal = document.querySelector('[data-target-id="goal:sum"]') as HTMLElement;
    const obligation = document.querySelector('[data-target-id="obligation:step"]') as HTMLElement;
    expect(goal).toHaveAttribute("data-family", "goal");
    expect(obligation).toHaveAttribute("data-family", "obligation");
    expect(within(goal).getByText("Goal", { selector: "p" })).toBeVisible();
    expect(
      within(obligation).getByText("Obligation (assumption)", { selector: "p" }),
    ).toBeVisible();
    expect(within(goal).getByLabelText("Variable x: sort:real, universal parameter")).toBeVisible();
    expect(within(goal).getByText("Hypothesis 1")).toBeInTheDocument();
  });

  it("marks a selected goal proposition positive and a term neutral", async () => {
    render(<ProofWorkspace node={proofNode(["And", ["Greater", "x", 0], "True"])} />);
    fireEvent.pointerUp(await screen.findByLabelText("Goal 1 conclusion"));
    const summary = document.querySelector("[data-selection-key]") as HTMLElement;
    expect(summary).toHaveAttribute("data-family", "goal");
    expect(summary).toHaveAttribute("data-polarity", "positive");
    expect(within(summary).getByText("Positive position (goal-like)")).toBeVisible();
    expect(screen.getByText("Selected · Positive position (goal-like)")).toBeVisible();

    // Path 0 of hypothesis `x > 0` is the term `x`, which has no logical polarity.
    fireEvent.pointerUp(await screen.findByLabelText("Goal 1 hypothesis 1"));
    const hypothesis = document.querySelector("[data-selection-key]") as HTMLElement;
    expect(hypothesis).toHaveAttribute("data-family", "hypothesis");
    expect(hypothesis).toHaveAttribute("data-polarity", "neutral");
  });

  it("marks a whole hypothesis negative", async () => {
    render(<ProofWorkspace node={proofNode()} />);
    const hypothesis = await screen.findByLabelText("Goal 1 hypothesis 2");
    Object.assign(hypothesis, { getElementInfo: () => ({ data: { "proof-path-0": "root" } }) });
    fireEvent.pointerUp(hypothesis);
    const summary = document.querySelector("[data-selection-key]") as HTMLElement;
    expect(summary).toHaveAttribute("data-polarity", "negative");
    expect(within(summary).getByText("Negative position (hypothesis-like)")).toBeVisible();
  });
});

describe("ProofWorkspace natural-language view", () => {
  it("renders read-only prose with inline mathematics instead of MathLive fields", () => {
    render(<ProofWorkspace node={proofNode()} view="natural-language" />);
    expect(document.querySelectorAll("math-field")).toHaveLength(0);
    expect(screen.getByText(/Natural-language view is read-only/)).toBeVisible();
    const conclusion = screen.getByLabelText("Goal 1 conclusion");
    expect(conclusion.tagName).toBe("P");
    expect(conclusion).toHaveTextContent("is equal to");
    expect(conclusion.querySelector("[data-latex]")).not.toBeNull();
  });
});

describe("ProofWorkspace guidance", () => {
  it("collapses the colour key and keeps ids in tooltips", () => {
    render(<ProofWorkspace node={proofNode()} />);
    expect(screen.getByRole("heading", { name: "Goals and obligations" })).toBeVisible();
    const key = screen.getByText("Colour and symbol key").closest("details")!;
    expect(key).not.toHaveAttribute("open");
    expect(key).toContainElement(screen.getByRole("list", { name: "Colour key" }));
    const goal = document.querySelector('[data-target-id="goal:sum"]') as HTMLElement;
    expect(goal).toHaveAttribute("title", "goal:sum");
    expect(within(goal).queryByText("goal:sum")).toBeNull();
  });

  it("links to the suggestions once something is selected", async () => {
    render(
      <ProofWorkspace
        node={proofNode()}
        suggestionsLink={{ href: "#suggestion-panel", text: "3 suggestions below" }}
      />,
    );
    expect(screen.queryByRole("link", { name: "3 suggestions below" })).toBeNull();
    fireEvent.pointerUp(await screen.findByLabelText("Goal 1 conclusion"));
    expect(screen.getByRole("link", { name: "3 suggestions below" })).toHaveAttribute(
      "href",
      "#suggestion-panel",
    );
  });
});

describe("ProofWorkspace keyboard", () => {
  it("lets Tab leave a read-only math field instead of letting MathLive consume it", async () => {
    render(<ProofWorkspace node={proofNode()} />);
    const field = await screen.findByLabelText("Goal 1 conclusion");
    const seen: string[] = [];
    field.addEventListener("keydown", (event) => seen.push((event as KeyboardEvent).key));
    fireEvent.keyDown(field, { key: "Tab" });
    fireEvent.keyDown(field, { key: "a" });
    expect(seen).toEqual(["a"]);
  });
});
