// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROBLEM_SETUP_LAYER_CHOICES,
  PROBLEM_SETUP_SORT_CHOICES,
  createProofNodeSchema,
  type ProblemSetupOptions,
} from "@proof/protocol";
import { ProblemEntryForm } from "./problem-entry-form";
import type { AiSetupCapabilities } from "./ai-assist";

const options = {
  sorts: PROBLEM_SETUP_SORT_CHOICES.map(({ id, label, sort }) => ({ id, label, sort })),
  layers: PROBLEM_SETUP_LAYER_CHOICES.map(({ id, layer, label, description }) => ({
    id,
    layer,
    label,
    description,
  })),
  packs: [
    {
      id: "pack:elementary-logic",
      name: "Elementary logic",
      description: "Connectives.",
      domain: "logic",
      alwaysActive: true,
      operators: [],
    },
  ],
} as ProblemSetupOptions;

const proposition = (symbol: string) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: { kind: "proposition" },
  role: "universal-parameter",
});

function review() {
  const rootNode = createProofNodeSchema().parse({
    id: "node:root",
    state: {
      id: "state:root",
      goals: [
        {
          id: "goal:1",
          sequent: {
            context: {
              declarations: [proposition("p"), proposition("q")],
              hypotheses: [{ id: "hypothesis:1", statement: { expression: "p" } }],
            },
            conclusion: { expression: ["Or", "p", "q"] },
          },
        },
      ],
      obligations: [],
    },
  });
  return {
    rootNode,
    operators: [],
    metadata: {
      problem: { title: "Disjunction", statement: "Show p or q from p." },
      background: { level: "school", summary: "Logic.", assumptions: [] },
      libraryLayerIds: ["layer:global", "layer:initial-problem"],
    },
    activePackIds: ["pack:elementary-logic"],
    digest: `sha256:${"b".repeat(64)}`,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, data: { ok: true, review: review() } })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderForm(ai?: AiSetupCapabilities) {
  render(
    <ProblemEntryForm
      options={options}
      navigate={vi.fn()}
      createSessionId={() => "session:test"}
      {...(ai === undefined ? {} : { ai })}
    />,
  );
}

const progress = () => screen.getByRole("navigation", { name: "Setup progress" });
const link = (name: string) => within(progress()).getByRole("link", { name });
const currentSteps = () =>
  within(progress())
    .getAllByRole("link")
    .filter((step) => step.getAttribute("aria-current") === "step")
    .map((step) => step.textContent);

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("Setup progress", () => {
  it("lists the steps for a form without AI, each linking to its section", () => {
    renderForm();
    const steps = within(progress())
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(steps).toEqual([
      "1ProblemEnter the problem statement",
      "2BackgroundEnter what the reader may assume",
      "3SetupEnter what to prove",
      "4Review & startCheck your setup",
    ]);
    expect(link("Problem")).toHaveAttribute("href", "#setup-problem");
    expect(link("Background")).toHaveAttribute("href", "#setup-background-fields");
    expect(link("Setup")).toHaveAttribute("href", "#setup-known");
    expect(link("Review & start")).toHaveAttribute("href", "#setup-check");
    // Every link has a section to land on.
    for (const anchor of within(progress()).getAllByRole("link")) {
      const target = anchor.getAttribute("href")?.slice(1) ?? "";
      expect(document.getElementById(target)).not.toBeNull();
    }
    expect(currentSteps()).toEqual(["Problem"]);
  });

  it("follows the form: the statement, the by-hand background, then the setup", () => {
    renderForm();
    change("Problem statement", "Show p or q from p.");
    expect(within(progress()).getByText("Statement entered")).toBeInTheDocument();
    expect(currentSteps()).toEqual(["Background"]);

    change("Assumed level", "school");
    expect(currentSteps()).toEqual(["Background"]);
    change("What the reader is expected to know", "Logic.");
    expect(within(progress()).getByText("Entered by hand")).toBeInTheDocument();
    expect(currentSteps()).toEqual(["Setup"]);

    change("Variable or object 1", "p");
    change("Goal 1", "p \\lor");
    expect(within(progress()).getByText("Fix the notation that was not recognized")).toBeVisible();
    change("Goal 1", "p \\lor q");
    expect(within(progress()).getByText("0 hypotheses, 1 goal")).toBeInTheDocument();
    expect(currentSteps()).toEqual(["Review & start"]);
  });

  it("marks the checked setup as ready, and withdraws that when the form changes", async () => {
    renderForm();
    change("Problem statement", "Show p or q from p.");
    change("Assumed level", "school");
    change("What the reader is expected to know", "Logic.");
    change("Variable or object 1", "p");
    change("Goal 1", "p \\lor q");
    fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start exploring" })).toBeEnabled(),
    );
    expect(within(progress()).getByText("Ready to start")).toBeInTheDocument();
    expect(link("Review & start")).toHaveAttribute("href", "#setup-review");
    expect(document.getElementById("setup-review")).toBe(
      screen.getByRole("region", { name: "Review" }),
    );

    change("Goal 1", "q \\lor p");
    expect(within(progress()).getByText("Check your setup")).toBeInTheDocument();
    expect(link("Review & start")).toHaveAttribute("href", "#setup-check");
  });

  it("adds the library step only when the librarian is configured", () => {
    renderForm({ background: true, library: false, formalizer: false });
    expect(within(progress()).queryByRole("link", { name: "Library" })).toBeNull();
    expect(link("Background")).toHaveAttribute("href", "#setup-background");
    cleanup();

    renderForm({ background: true, library: true, formalizer: false });
    expect(link("Library")).toHaveAttribute("href", "#setup-library");
    expect(within(progress()).getByText("Optional")).toBeInTheDocument();
    expect(document.getElementById("setup-library")).not.toBeNull();
  });

  it("opens the by-hand setup of a guided form before jumping to it", () => {
    renderForm({ background: true, library: true, formalizer: true });
    const hand = screen.getByText("Edit the background and setup by hand").closest("details");
    expect(hand).not.toHaveAttribute("open");
    fireEvent.click(link("Setup"));
    expect(hand).toHaveAttribute("open");
  });
});

describe("Typeset previews in the form", () => {
  const previews = () => document.querySelectorAll("[data-preview]");

  it("appear under a field only while its statement parses", () => {
    renderForm();
    expect(previews()).toHaveLength(0);

    change("Goal 1", "p \\lor");
    expect(previews()).toHaveLength(0);
    change("Goal 1", "p \\lor q");
    expect(previews()).toHaveLength(1);
    expect(screen.getByLabelText("Goal 1").closest("[data-family]")).toContainElement(
      previews()[0] as HTMLElement,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add hypothesis" }));
    expect(previews()).toHaveLength(1);
    change("Hypothesis 1", "p");
    expect(previews()).toHaveLength(2);
  });

  it("typeset the problem statement's $…$ pieces", () => {
    renderForm();
    change("Problem statement", "Show that consecutive integers are coprime.");
    expect(previews()).toHaveLength(0);
    change("Problem statement", "Show that $p \\lor q$ holds.");
    expect(previews()).toHaveLength(1);
  });

  it("typeset the formulas of the review, which keeps their LaTeX", async () => {
    renderForm();
    change("Problem statement", "Show p or q from p.");
    change("Assumed level", "school");
    change("What the reader is expected to know", "Logic.");
    change("Variable or object 1", "p");
    change("Goal 1", "p \\lor q");
    fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    const reviewPanel = await screen.findByRole("region", { name: "Review" });
    await waitFor(() => expect(reviewPanel.querySelector(".ML__latex")).not.toBeNull());
    expect(reviewPanel).toHaveTextContent("p \\lor q");
    expect(reviewPanel.querySelector("code[data-latex]")).toBeNull();
  });
});
