// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MathJsonSpike } from "./mathjson-spike";

vi.mock("mathlive", () => {
  class MockMathfieldElement extends HTMLElement {
    readOnly = false;
    value = "";
    selection = { ranges: [[0, 0] as [number, number]] };
    selectionIsCollapsed = true;
    position = 0;
    lastOffset = 20;

    getValue(): string {
      return '"x"';
    }

    getElementInfo(): { data: Record<string, string> } {
      return { data: { "proof-path-3": "0.0.0" } };
    }
  }

  if (!customElements.get("math-field")) customElements.define("math-field", MockMathfieldElement);
  return { MathfieldElement: MockMathfieldElement };
});

afterEach(cleanup);

async function renderReady() {
  render(<MathJsonSpike />);
  await waitFor(() => expect(screen.getByText("MathLive ready")).toBeInTheDocument());
}

describe("MathJSON interaction spike", () => {
  it("shows exact paths and expands to a semantic parent", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Select x²" }));
    expect(screen.getByText("Exact subtree selection")).toBeInTheDocument();
    expect(screen.getByTestId("selection-path")).toHaveTextContent("0.0");
    expect(screen.getByTestId("selection-fragment")).toHaveTextContent("Power");

    fireEvent.click(screen.getByRole("button", { name: "Expand to parent" }));
    expect(screen.getByTestId("selection-path")).toHaveTextContent("0");
  });

  it("distinguishes the second equal leaf occurrence", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Select second y" }));
    expect(screen.getByTestId("selection-path")).toHaveTextContent("0.3");
  });

  it("replaces a virtual selection and rerenders from the new ground truth", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Select 3y + z" }));
    expect(screen.getByText("Associative virtual selection")).toBeInTheDocument();
    expect(screen.getByText("0.1, 0.2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Replace selection" }));
    await waitFor(() =>
      expect(screen.getByTestId("authoritative-mathjson")).toHaveTextContent(
        /"Power"[\s\S]*"u"[\s\S]*"y"/,
      ),
    );
    expect(screen.getByTestId("authoritative-mathjson")).not.toHaveTextContent("Multiply");
    expect(screen.getByText(/MathLive rerendered the new projection/)).toBeInTheDocument();
  });

  it("makes fallback and its actual interpreted subtree visible", async () => {
    await renderReady();
    fireEvent.click(screen.getByRole("button", { name: "Try cross-branch range" }));
    expect(screen.getByText("Snapped fallback selection")).toBeInTheDocument();
    expect(screen.getByTestId("selection-path")).toHaveTextContent("0");
    expect(screen.getByRole("status")).toHaveTextContent("Fallback applied");
  });
});
