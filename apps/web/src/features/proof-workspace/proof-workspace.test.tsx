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
const naturalSort = { kind: "named", id: "sort:natural" } as const;

function proofNode(goalConclusion: unknown = ["Equal", ["Add", "x", "y"], 4]): ProofNode {
  return proofNodeSchema.parse({
    id: "node:workspace",
    state: {
      id: "state:workspace",
      goals: [
        {
          id: "goal:sum",
          sequent: {
            context: {
              declarations: [
                {
                  id: "declaration:goal-x",
                  symbol: "x",
                  sort: realSort,
                  role: "universal-parameter",
                },
                {
                  id: "declaration:goal-y",
                  symbol: "y",
                  sort: realSort,
                  role: "local-witness",
                },
                {
                  id: "declaration:goal-shared",
                  symbol: "c",
                  sort: realSort,
                  role: "universal-parameter",
                },
              ],
              hypotheses: [
                {
                  id: "hypothesis:goal-positive",
                  statement: { expression: ["Greater", "x", 0] },
                },
                {
                  id: "hypothesis:shared-context",
                  statement: { expression: ["Greater", "c", 0] },
                },
              ],
            },
            conclusion: { expression: goalConclusion },
          },
        },
      ],
      obligations: [
        {
          id: "obligation:natural-step",
          sequent: {
            context: {
              declarations: [
                {
                  id: "declaration:obligation-n",
                  symbol: "n",
                  sort: naturalSort,
                  role: "universal-parameter",
                },
                {
                  id: "declaration:obligation-shared",
                  symbol: "c",
                  sort: realSort,
                  role: "universal-parameter",
                },
              ],
              hypotheses: [
                {
                  id: "hypothesis:obligation-lower-bound",
                  statement: { expression: ["Greater", "n", 1] },
                },
                {
                  id: "hypothesis:obligation-parity",
                  statement: { expression: ["Equal", ["Add", "n", 1], 4] },
                },
                {
                  id: "hypothesis:shared-context",
                  statement: { expression: ["Greater", "c", 0] },
                },
              ],
            },
            conclusion: { expression: ["Greater", ["Add", "n", 1], 0] },
          },
        },
      ],
    },
  });
}

describe("ProofWorkspace", () => {
  it("rejects an invalid ProofNode at the runtime boundary", () => {
    render(<ProofWorkspace node={{ id: "node:invalid", state: { goals: [] } }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("ProofNode snapshot is invalid");
    expect(screen.queryByLabelText("Proof workspace")).not.toBeInTheDocument();
  });

  it("keeps each goal and obligation's distinct context inside its own sequent", async () => {
    render(<ProofWorkspace node={proofNode()} />);
    const goal = document.querySelector('[data-target-id="goal:sum"]');
    const obligation = document.querySelector('[data-target-id="obligation:natural-step"]');
    expect(goal).not.toBeNull();
    expect(obligation).not.toBeNull();

    expect(within(goal as HTMLElement).getByRole("heading", { name: "Goal 1" })).toBeVisible();
    expect(
      within(goal as HTMLElement).getByRole("heading", { name: "Declarations for goal 1" }),
    ).toBeVisible();
    expect(within(goal as HTMLElement).getByText("x")).toBeVisible();
    expect(within(goal as HTMLElement).getByText("c")).toBeVisible();
    expect(within(goal as HTMLElement).queryByText("n")).not.toBeInTheDocument();

    expect(
      within(obligation as HTMLElement).getByRole("heading", {
        name: "Obligation 1",
      }),
    ).toBeVisible();
    expect(within(obligation as HTMLElement).getByText("n")).toBeVisible();
    expect(within(obligation as HTMLElement).getByText("c")).toBeVisible();
    expect(within(obligation as HTMLElement).queryByText("x")).not.toBeInTheDocument();
    expect(
      within(obligation as HTMLElement).getByRole("heading", {
        name: "Hypotheses for obligation 1",
      }),
    ).toBeVisible();

    await waitFor(() => {
      expect(screen.getByLabelText("Goal 1 hypothesis 1")).toBeInTheDocument();
      expect(screen.getByLabelText("Goal 1 conclusion")).toBeInTheDocument();
      expect(screen.getByLabelText("Obligation 1 hypothesis 2")).toBeInTheDocument();
      expect(screen.getByLabelText("Obligation 1 hypothesis 3")).toBeInTheDocument();
      expect(screen.getByLabelText("Obligation 1 conclusion")).toBeInTheDocument();
    });
    expect(goal?.querySelectorAll("math-field")).toHaveLength(3);
    expect(obligation?.querySelectorAll("math-field")).toHaveLength(4);
    expect(goal?.querySelectorAll("button")).toHaveLength(0);
    expect(obligation?.querySelectorAll("button")).toHaveLength(0);
  });

  it("replaces, expands, and modifier-toggles occurrence selections", async () => {
    render(<ProofWorkspace node={proofNode()} />);
    const goalConclusion = await screen.findByLabelText("Goal 1 conclusion");
    const obligationConclusion = await screen.findByLabelText("Obligation 1 conclusion");

    fireEvent.pointerUp(goalConclusion);
    expect(screen.getByText("goal goal:sum")).toBeVisible();
    expect(screen.getByText("path 0")).toBeVisible();

    fireEvent.pointerUp(goalConclusion);
    expect(screen.getByText("path root")).toBeVisible();

    fireEvent.pointerUp(obligationConclusion);
    expect(screen.queryByText("goal goal:sum")).not.toBeInTheDocument();
    expect(screen.getByText("obligation obligation:natural-step")).toBeVisible();
    expect(document.querySelectorAll("[data-selection-key]")).toHaveLength(1);

    fireEvent.pointerUp(goalConclusion, { ctrlKey: true });
    expect(screen.getByText("goal goal:sum")).toBeVisible();
    expect(screen.getByText("obligation obligation:natural-step")).toBeVisible();
    expect(document.querySelectorAll("[data-selection-key]")).toHaveLength(2);

    fireEvent.pointerUp(goalConclusion, { ctrlKey: true });
    expect(screen.queryByText("goal goal:sum")).not.toBeInTheDocument();
    expect(screen.getByText("obligation obligation:natural-step")).toBeVisible();
  });

  it("clears the active set when any ProofNode snapshot content changes", async () => {
    const { rerender } = render(<ProofWorkspace node={proofNode()} />);
    fireEvent.pointerUp(await screen.findByLabelText("Goal 1 conclusion"));
    expect(screen.getByText("goal goal:sum")).toBeVisible();

    rerender(<ProofWorkspace node={proofNode(["Equal", ["Add", "x", "y"], 5])} />);
    expect(screen.getByText("No active occurrence.")).toBeVisible();
    expect(screen.queryByText("goal goal:sum")).not.toBeInTheDocument();
  });

  it("notifies controlled selection state when a valid snapshot becomes invalid", async () => {
    const onSelectionChange = vi.fn();
    const { rerender } = render(
      <ProofWorkspace node={proofNode()} onSelectionChange={onSelectionChange} />,
    );
    fireEvent.pointerUp(await screen.findByLabelText("Goal 1 conclusion"));
    await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith([expect.any(Object)]));

    rerender(
      <ProofWorkspace
        node={{ id: "node:invalid", state: { goals: [] } }}
        onSelectionChange={onSelectionChange}
      />,
    );

    await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith([]));
    expect(screen.getByRole("alert")).toHaveTextContent("ProofNode snapshot is invalid");
  });

  it("reports complete anchor-and-path data through its selection callback", async () => {
    const onSelectionChange = vi.fn();
    render(<ProofWorkspace node={proofNode()} onSelectionChange={onSelectionChange} />);
    fireEvent.pointerUp(await screen.findByLabelText("Goal 1 hypothesis 1"));

    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith([
        {
          kind: "exact",
          anchor: {
            stateId: "state:workspace",
            target: { kind: "goal", id: "goal:sum" },
            statement: { kind: "hypothesis", id: "hypothesis:goal-positive" },
          },
          path: [0],
        },
      ]),
    );
  });
});
