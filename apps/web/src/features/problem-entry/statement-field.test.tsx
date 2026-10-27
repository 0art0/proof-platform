// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatexRenderer } from "@proof/language";
import { StatementField, StatementPreview, statementFeedback } from "./statement-field";
import type { StatementRow } from "./draft-form";

afterEach(cleanup);

const latex = createLatexRenderer();

function field(row: Pick<StatementRow, "format" | "text">) {
  const full: StatementRow = { key: 7, ...row };
  const { container } = render(
    <StatementField
      label="Goal 1"
      family="goal"
      row={full}
      feedback={statementFeedback(full, latex)}
      onChange={vi.fn()}
    />,
  );
  return container;
}

describe("statementFeedback", () => {
  it("carries the recognized statement written back out as LaTeX", () => {
    const feedback = statementFeedback({ format: "latex", text: "p \\lor q" }, latex);
    expect(feedback).toMatchObject({ kind: "parsed", mathJson: '["Or","p","q"]' });
    expect(feedback.kind === "parsed" && latex.parse(feedback.latex)).toMatchObject({
      ok: true,
      expression: ["Or", "p", "q"],
    });
  });

  it("reads structured notation the same way", () => {
    const feedback = statementFeedback({ format: "mathjson", text: '["Or", "p", "q"]' }, latex);
    expect(feedback).toMatchObject({ kind: "parsed", mathJson: '["Or","p","q"]' });
  });

  it("reports nothing entered and unreadable input without a statement to typeset", () => {
    expect(statementFeedback({ format: "latex", text: "  " }, latex)).toEqual({ kind: "empty" });
    expect(statementFeedback({ format: "latex", text: "p \\lor" }, latex).kind).toBe("error");
    expect(statementFeedback({ format: "mathjson", text: '["Or", "p"' }, latex).kind).toBe("error");
  });
});

describe("StatementField preview", () => {
  it("shows the recognized statement typeset, beside the notation check, once it parses", () => {
    const container = field({ format: "latex", text: "p \\lor q" });
    const preview = container.querySelector("[data-preview]");
    expect(preview).not.toBeNull();
    expect(preview).toHaveTextContent("Preview");
    expect(preview).toHaveTextContent("Notation recognized.");
    // The LaTeX stays in the page next to the typeset formula, for assistive technology and copying.
    const source = preview?.querySelector("[data-latex]");
    expect(source?.getAttribute("data-latex")).toMatch(/p\s*\\lor\s*q/);
    expect(screen.getByRole("textbox")).toHaveAccessibleDescription("Notation recognized.");
  });

  it("typesets MathLive markup once the renderer has loaded", async () => {
    const container = field({ format: "latex", text: "p \\lor q" });
    await waitFor(() =>
      expect(container.querySelector("[data-preview] .ML__latex")).not.toBeNull(),
    );
  });

  it("shows no preview for unreadable input, only the error", () => {
    const container = field({ format: "latex", text: "p \\lor" });
    expect(container.querySelector("[data-preview]")).toBeNull();
    expect(screen.getByText(/could not be parsed/)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });

  it("shows no preview for an empty field, only the prompt", () => {
    const container = field({ format: "latex", text: "" });
    expect(container.querySelector("[data-preview]")).toBeNull();
    expect(screen.getByText("Enter the statement.")).toBeInTheDocument();
  });

  it("keeps the preview off while structured notation is not valid JSON", () => {
    const container = field({ format: "mathjson", text: '["Or", "p"' });
    expect(container.querySelector("[data-preview]")).toBeNull();
    expect(screen.getByText(/not valid JSON/)).toBeInTheDocument();
  });

  it("previews structured notation that parses", () => {
    const container = field({ format: "mathjson", text: '["Or", "p", "q"]' });
    expect(container.querySelector("[data-preview] [data-latex]")).not.toBeNull();
  });
});

describe("StatementPreview", () => {
  const preview = (text: string) =>
    render(<StatementPreview text={text} latex={latex} />).container.querySelector(
      "[data-preview]",
    );

  it("typesets the $…$ pieces of the problem statement that parse", () => {
    const container = preview("Show that $p \\lor q$ holds when $p$ does.");
    expect(container).not.toBeNull();
    expect(container).toHaveTextContent("Preview");
    expect(container).toHaveTextContent("Show that");
    expect(container?.querySelectorAll("[data-latex]")).toHaveLength(2);
  });

  it("is absent for plain prose, an unfinished $, or math that does not parse", () => {
    expect(preview("Show that any two consecutive integers are coprime.")).toBeNull();
    expect(preview("Show that $p \\lor q holds.")).toBeNull();
    expect(preview("Show that $p \\lor$ holds.")).toBeNull();
    expect(preview("")).toBeNull();
  });

  it("leaves a piece that does not parse as typed", () => {
    const container = preview("Both $p \\lor q$ and $p \\lor$ are needed.");
    expect(container?.querySelectorAll("[data-latex]")).toHaveLength(1);
    expect(container).toHaveTextContent("$p \\lor$");
  });
});
