// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresentation } from "@proof/language";
import {
  createMovePreviewSchema,
  displayedSuggestionSetSchema,
  protocolRequiresInputResponseSchema,
  type DisplayedSuggestionSet,
  type MovePreview,
} from "@proof/protocol";
import { ParameterMenu } from "./parameter-menu";
import { PreviewDetails } from "./preview-details";
import { SuggestionCard, type MoveState } from "./suggestion-card";
import { SuggestionPanel, type SuggestionPanelActions } from "./suggestion-panel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const presentation = createPresentation({ operators: [] });
const declarations = ["p", "q"].map((symbol) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: { kind: "proposition" },
  role: "universal-parameter",
}));
const anchor = {
  stateId: "state:test",
  target: { kind: "goal", id: "goal:test" },
  statement: { kind: "conclusion" },
} as const;

function resultSuggestion(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    source: "result",
    artifactId: `result:${id.slice("suggestion:".length)}`,
    patternId: `pattern:${id}`,
    name,
    exactRepresentationMatch: true,
    substitutions: [],
    rank: [1, 1],
    reasons: [`Reason for ${name}`],
    selectionMatches: [{ selectionId: "selection:primary", patternId: `pattern:${id}` }],
    unresolvedSelectionSlots: [],
    unresolvedParameters: [],
    applicability: "applicable",
    abstractionFit: "not-used",
    ...extra,
  };
}

function suggestionSet(
  suggestions: readonly unknown[],
  variantGroups: readonly unknown[] = [],
): DisplayedSuggestionSet {
  return displayedSuggestionSetSchema.parse({
    id: "suggestion-set:panel",
    nodeId: "node:test",
    stateId: "state:test",
    selection: {
      kind: "exact",
      anchor,
      path: [],
      fragment: "q",
      declarations,
      position: { polarity: "positive", role: "proposition" },
    },
    suggestions,
    variantGroups,
  });
}

const modusPonens = resultSuggestion("suggestion:modus-ponens", "Modus ponens", {
  exactRepresentationMatch: false,
  substitutions: [
    { symbol: "P", expression: "p" },
    { symbol: "Q", expression: "q" },
  ],
  rank: [0, 0],
  reasons: ["Applies if $p$ is proved; it becomes a new obligation."],
  predictedObligations: [
    { kind: "premise", index: 0, description: "$p$", applicationPremiseIndex: 0 },
    { kind: "side-condition", index: 0, description: "the domain is nonempty" },
  ],
});

function noActions(): SuggestionPanelActions {
  return {
    onPreview: vi.fn(),
    onChooseInputs: vi.fn(),
    onSubmitChoices: vi.fn(),
    onCancelChoices: vi.fn(),
    onApply: vi.fn(),
    onInputSummaryExpanded: vi.fn(),
  };
}

function cardActions() {
  return {
    onPreview: vi.fn(),
    onChooseInputs: vi.fn(),
    onSubmitChoices: vi.fn(),
    onCancelChoices: vi.fn(),
    onApply: vi.fn(),
    onInputSummaryExpanded: vi.fn(),
  };
}

const state = (goals: unknown[], obligations: unknown[], id: string, extra = {}) => ({
  id,
  goals,
  obligations,
  ...extra,
});
const goal = (id: string, conclusion: unknown, hypotheses: unknown[] = []) => ({
  id,
  sequent: { context: { declarations, hypotheses }, conclusion: { expression: conclusion } },
});

/** Backward modus ponens: the goal q is closed and its premise p becomes an obligation. */
function resultPreview(): MovePreview {
  const before = state([goal("goal:test", "q")], [], "state:test");
  const after = state(
    [],
    [
      {
        ...goal("obligation:p", "p"),
        provenance: { kind: "premise-of-result", resultId: "result:modus-ponens" },
      },
    ],
    "state:after",
  );
  return createMovePreviewSchema().parse({
    id: "preview:result",
    nodeId: "node:test",
    stateId: "state:test",
    suggestionSetId: "suggestion-set:panel",
    chosenSuggestionId: "suggestion:modus-ponens",
    moveId: "move:apply-result-backward",
    operation: {
      kind: "apply-result-backward",
      expectedStateId: "state:test",
      resultStateId: "state:after",
      target: { kind: "goal", id: "goal:test" },
      resultId: "result:modus-ponens",
      instantiation: { P: "p", Q: "q" },
      premiseTargetIds: ["obligation:p"],
    },
    transitionClass: "strengthening",
    beforeState: before,
    afterState: after,
    delta: {
      goals: { added: [], removed: ["goal:test"], updated: [] },
      obligations: { added: ["obligation:p"], removed: [], updated: [] },
    },
  });
}

/** Introducing an implication: the goal p ⇒ q becomes q under the new hypothesis p. */
function introductionPreview(): MovePreview {
  const before = state([goal("goal:test", ["Implies", "p", "q"])], [], "state:test");
  const after = state(
    [goal("goal:test", "q", [{ id: "hypothesis:p", statement: { expression: "p" } }])],
    [],
    "state:after",
  );
  return createMovePreviewSchema().parse({
    id: "preview:intro",
    nodeId: "node:test",
    stateId: "state:test",
    suggestionSetId: "suggestion-set:panel",
    chosenSuggestionId: "suggestion:intro",
    moveId: "move:introduce-implication",
    operation: {
      kind: "introduce-implication",
      expectedStateId: "state:test",
      resultStateId: "state:after",
      target: { kind: "goal", id: "goal:test" },
      hypothesisId: "hypothesis:p",
    },
    transitionClass: "equivalence",
    beforeState: before,
    afterState: after,
    delta: {
      goals: { added: [], removed: [], updated: ["goal:test"] },
      obligations: { added: [], removed: [], updated: [] },
    },
  });
}

function latexIn(element: HTMLElement): string[] {
  return [...element.querySelectorAll("[data-latex]")].map(
    (node) => node.getAttribute("data-latex") ?? "",
  );
}

describe("SuggestionCard", () => {
  it("shows a result-application card with provenance, evidence and near-miss obligations", () => {
    const set = suggestionSet([modusPonens]);
    render(
      <ol>
        <SuggestionCard
          suggestion={set.suggestions[0]!}
          move={{ kind: "idle" }}
          mutationPending={false}
          presentation={presentation}
          view="formal"
          {...cardActions()}
        />
      </ol>,
    );
    const card = screen.getByText("Modus ponens").closest("li")!;
    expect(card).toHaveAttribute("data-source", "result");
    expect(card).toHaveAttribute("data-category", "near-miss");
    const badges = within(card).getByRole("group", { name: "Classification of Modus ponens" });
    expect(within(badges).getByText("Result application")).toBeVisible();
    expect(within(badges).getByText("Deterministic")).toBeVisible();
    expect(within(badges).getByText("Structural match")).toBeVisible();
    expect(within(badges).getByText("Near miss")).toBeVisible();
    // Every badge carries a text label and a data value, never colour alone.
    for (const badge of badges.querySelectorAll("[data-badge]")) {
      expect(badge.textContent?.trim().length).toBeGreaterThan(1);
      expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull();
    }

    const instantiation = within(card).getByLabelText("Instantiation for Modus ponens");
    expect(latexIn(instantiation)).toEqual(["P \\mapsto p", "Q \\mapsto q"]);

    const obligations = within(card).getByLabelText("Predicted obligations for Modus ponens");
    const items = within(obligations).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-obligation-kind"))).toEqual([
      "premise",
      "side-condition",
    ]);
    expect(items[0]).toHaveTextContent("Premise");
    expect(latexIn(items[0]!)).toEqual(["p"]);
    expect(items[1]).toHaveTextContent("Side condition the domain is nonempty");
    expect(within(card).getByText(/Near miss: applies once these are proved/)).toBeVisible();
    expect(within(card).getByRole("button", { name: "Preview" })).toBeEnabled();
  });

  it("shows the stored transition class of a move and the recorded evidence after preview", () => {
    const set = suggestionSet([resultSuggestion("suggestion:modus-ponens", "Modus ponens")]);
    const move: MoveState = {
      kind: "previewed",
      suggestionId: "suggestion:modus-ponens",
      commandId: "command:test",
      preview: resultPreview(),
      choices: {},
    };
    render(
      <ol>
        <SuggestionCard
          suggestion={set.suggestions[0]!}
          transitionClass="strengthening"
          move={move}
          mutationPending={false}
          presentation={presentation}
          view="formal"
          {...cardActions()}
        />
      </ol>,
    );
    const badges = screen.getByRole("group", { name: "Classification of Modus ponens" });
    expect(within(badges).getByText("Immediate")).toBeVisible();
    expect(badges.querySelector('[data-transition-class="strengthening"]')).toHaveTextContent(
      "strengthening",
    );
    const preview = screen.getByLabelText("Move preview");
    expect(preview.querySelector('[data-evidence="library-result"]')).toHaveTextContent(
      "Library result cited",
    );
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });
});

describe("PreviewDetails", () => {
  it("renders a result preview as LaTeX before → after differences, not JSON", () => {
    const preview = resultPreview();
    render(<PreviewDetails preview={preview} presentation={presentation} view="formal" />);
    const panel = screen.getByLabelText("Move preview");
    const changes = within(panel).getByLabelText("State changes");
    const closed = within(changes)
      .getByText(/Goal closed/)
      .closest("li")!;
    expect(closed).toHaveAttribute("data-change", "removed");
    expect(latexIn(closed)).toEqual([presentation.latex("q")]);
    const obligations = within(panel).getByLabelText("New obligations");
    const added = within(obligations)
      .getByText(/Obligation added/)
      .closest("li")!;
    expect(added).toHaveTextContent("premise of result:modus-ponens");
    expect(latexIn(added)).toEqual([presentation.latex("p")]);
    expect(panel.textContent).not.toMatch(/[[{]"/);
  });

  it("shows an updated goal's conclusion and new hypothesis in natural language", () => {
    const preview = introductionPreview();
    const { rerender } = render(
      <PreviewDetails preview={preview} presentation={presentation} view="formal" />,
    );
    const updated = screen.getByText(/Goal changed/).closest("li")!;
    expect(updated.querySelector('[data-side="before"]')).toHaveAttribute("data-side", "before");
    expect(latexIn(updated.querySelector('[data-side="before"]')!)).toEqual([
      presentation.latex(["Implies", "p", "q"]),
    ]);
    expect(latexIn(updated.querySelector('[data-side="after"]')!)).toEqual(["q"]);
    expect(within(updated).getByLabelText("Hypotheses added")).toBeVisible();
    expect(within(updated).queryByLabelText("Hypotheses removed")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Move preview").querySelector("[data-evidence]")).toHaveAttribute(
      "data-evidence",
      "structural",
    );

    rerender(
      <PreviewDetails preview={preview} presentation={presentation} view="natural-language" />,
    );
    const before = screen
      .getByText(/Goal changed/)
      .closest("li")!
      .querySelector('[data-side="before"]')!;
    expect(before).toHaveTextContent(/if\s*p\s*, then\s*q/);
    expect(screen.getByLabelText("Move preview").textContent).not.toMatch(/[[{]"/);
  });
});

describe("SuggestionPanel", () => {
  it("groups stored variants behind an expandable control without reranking", () => {
    const set = suggestionSet(
      [
        resultSuggestion("suggestion:transitivity", "Transitivity", {
          rank: [1, 3],
          variantFamilyId: "family:transitivity",
        }),
        resultSuggestion("suggestion:other", "Other result", { rank: [1, 2] }),
        resultSuggestion("suggestion:transitivity-flipped", "Transitivity (flipped)", {
          rank: [1, 1],
          variantFamilyId: "family:transitivity",
        }),
      ],
      [
        {
          familyId: "family:transitivity",
          name: "Transitivity",
          suggestionIds: ["suggestion:transitivity", "suggestion:transitivity-flipped"],
        },
      ],
    );
    render(
      <SuggestionPanel
        suggestions={{ kind: "ready", suggestionSet: set, transitionClasses: [] }}
        move={{ kind: "idle" }}
        mutationPending={false}
        presentation={presentation}
        view="formal"
        {...noActions()}
      />,
    );
    const list = screen.getByTestId("suggestion-list");
    const titles = () => [...list.querySelectorAll("h3")].map(({ textContent }) => textContent);
    expect(titles()).toEqual(["Transitivity", "Other result"]);

    const toggle = screen.getByRole("button", { name: /Show 1 related variant of Transitivity/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(titles()).toEqual(["Transitivity", "Transitivity (flipped)", "Other result"]);
    expect(screen.getByRole("list", { name: "Related variants of Transitivity" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Hide related variants/ }));
    expect(titles()).toEqual(["Transitivity", "Other result"]);
  });
});

describe("ParameterMenu", () => {
  const response = protocolRequiresInputResponseSchema.parse({
    status: "requires-input",
    commandId: "command:test",
    suggestionSetId: "suggestion-set:panel",
    chosenSuggestionId: "suggestion:disjunct",
    menus: [
      {
        parameterId: "disjunctIndex",
        label: "Disjunct",
        automatic: false,
        items: [
          {
            id: "menu-item:00000000000000a1",
            alias: "m1",
            label: { kind: "math", expression: "p" },
            value: { kind: "index", index: 0 },
            origin: { kind: "conclusion" },
          },
          {
            id: "menu-item:00000000000000a2",
            alias: "m2",
            label: { kind: "math", expression: "q" },
            value: { kind: "index", index: 1 },
            origin: { kind: "conclusion" },
          },
        ],
      },
    ],
    missingParameters: ["disjunctIndex"],
    diagnostics: [{ code: "requires-input", message: "Choose a disjunct." }],
  });

  it("submits only the chosen menu item IDs", () => {
    const onSubmit = vi.fn();
    render(
      <ParameterMenu
        suggestionName="Choose disjunct"
        menus={response.menus}
        missingParameters={response.missingParameters}
        choices={{}}
        pending={false}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        presentation={presentation}
        view="formal"
      />,
    );
    const form = screen.getByRole("form", { name: "Parameter menus for Choose disjunct" });
    const submit = within(form).getByRole("button", { name: "Preview with these inputs" });
    expect(submit).toBeDisabled();
    const group = within(form).getByRole("group", { name: /Disjunct/ });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("value"))).toEqual([
      "menu-item:00000000000000a1",
      "menu-item:00000000000000a2",
    ]);
    fireEvent.click(radios[1]!);
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({ disjunctIndex: "menu-item:00000000000000a2" });
  });
});
