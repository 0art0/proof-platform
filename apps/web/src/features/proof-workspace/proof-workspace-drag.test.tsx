// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proofNodeSchema } from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import { IDLE_DRAG_STATE, type DragSource } from "../gestures/drag-state";
import type { GestureBindings } from "../gestures/use-drag-gestures";
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

const node = proofNodeSchema.parse({
  id: "node:workspace",
  state: {
    id: "state:workspace",
    goals: [
      {
        id: "goal:a",
        sequent: {
          context: {
            declarations: ["p", "q"].map((symbol) => ({
              id: `declaration:${symbol}`,
              symbol,
              sort: { kind: "proposition" },
              role: "universal-parameter",
            })),
            hypotheses: [{ id: "hypothesis:h1", statement: { expression: ["And", "p", "q"] } }],
          },
          conclusion: { expression: ["And", "q", "p"] },
        },
      },
    ],
    obligations: [],
  },
});

function bindings(overrides: Partial<GestureBindings> = {}): GestureBindings {
  return {
    enabled: true,
    state: IDLE_DRAG_STATE,
    carrying: undefined,
    pickUp: vi.fn(),
    hover: vi.fn(),
    dropOn: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  };
}

const carried: DragSource = { kind: "result", artifactId: "result:lemma", label: "Lemma" };

describe("ProofWorkspace drag surface", () => {
  it("offers a handle on hypotheses only, which picks up the whole hypothesis", async () => {
    const gestures = bindings();
    render(<ProofWorkspace node={node} gestures={gestures} />);
    await screen.findByLabelText("Goal 1 conclusion");
    const handles = screen.getAllByRole("button", { name: /^Drag / });
    expect(handles).toHaveLength(1);
    expect(handles[0]).toHaveAccessibleName("Drag hypothesis 1 of goal 1");

    fireEvent.click(handles[0]!);
    expect(gestures.pickUp).toHaveBeenCalledWith(
      {
        kind: "hypothesis",
        selection: {
          kind: "exact",
          anchor: {
            stateId: "state:workspace",
            target: { kind: "goal", id: "goal:a" },
            statement: { kind: "hypothesis", id: "hypothesis:h1" },
          },
          path: [],
        },
        label: "hypothesis 1 of goal 1",
      },
      "keyboard",
    );
  });

  it("marks every statement as a labelled drop target while something is carried and reports the drop", async () => {
    const gestures = bindings({ carrying: carried });
    render(<ProofWorkspace node={node} gestures={gestures} />);
    const conclusion = await screen.findByLabelText("Goal 1 conclusion");
    const zone = conclusion.closest("[data-drop-ready]") as HTMLElement;
    expect(zone).toHaveAttribute("data-drop-ready", "true");
    // The cue is text, not colour alone.
    expect(within(zone).getByText("Drop here to preview a move")).toBeVisible();
    expect(document.querySelectorAll('[data-drop-ready="true"]')).toHaveLength(2);

    fireEvent.dragOver(zone);
    expect(gestures.hover).toHaveBeenCalledWith(true);
    expect(zone).toHaveAttribute("data-drop-over", "true");
    fireEvent.drop(zone);
    expect(gestures.dropOn).toHaveBeenCalledWith(
      {
        stateId: "state:workspace",
        target: { kind: "goal", id: "goal:a" },
        statement: { kind: "conclusion" },
      },
      // The mock field cannot hit-test, so the occurrence snaps to the whole statement.
      expect.objectContaining({ kind: "exact", path: [] }),
    );
  });

  it("shows no drop target or handle when nothing is carried or the view is not formal", async () => {
    const { rerender } = render(<ProofWorkspace node={node} gestures={bindings()} />);
    await screen.findByLabelText("Goal 1 conclusion");
    expect(document.querySelectorAll("[data-drop-ready='true']")).toHaveLength(0);

    rerender(
      <ProofWorkspace
        node={node}
        view="natural-language"
        gestures={bindings({ carrying: carried })}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Drag / })).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-drop-ready]")).toHaveLength(0);
  });

  it("makes the requested selections active once per request and reports them", async () => {
    const onSelectionChange = vi.fn<(selections: readonly AnchoredProofSelection[]) => void>();
    const anchor = (statement: unknown) =>
      ({
        stateId: node.state.id,
        target: { kind: "goal" as const, id: "goal:a" },
        statement,
      }) as AnchoredProofSelection["anchor"];
    const selections: AnchoredProofSelection[] = [
      {
        kind: "exact",
        anchor: anchor({ kind: "hypothesis", id: "hypothesis:h1" }),
        path: [],
      },
      { kind: "exact", anchor: anchor({ kind: "conclusion" }), path: [] },
    ];
    const { rerender } = render(
      <ProofWorkspace node={node} onSelectionChange={onSelectionChange} />,
    );
    await screen.findByLabelText("Goal 1 conclusion");
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);

    rerender(
      <ProofWorkspace
        node={node}
        onSelectionChange={onSelectionChange}
        selectionRequest={{ id: 1, selections }}
      />,
    );
    await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith(selections));
    expect(document.querySelectorAll("[data-selection-key]")).toHaveLength(2);
    expect(screen.getByTestId("selection-feedback")).toHaveTextContent(
      "Selected the drop source and target to preview a move.",
    );

    // The same request is not applied again, so a later clear stays cleared.
    fireEvent.click(screen.getByRole("button", { name: /Clear selections/ }));
    rerender(
      <ProofWorkspace
        node={node}
        onSelectionChange={onSelectionChange}
        selectionRequest={{ id: 1, selections }}
      />,
    );
    expect(document.querySelectorAll("[data-selection-key]")).toHaveLength(0);
  });
});
