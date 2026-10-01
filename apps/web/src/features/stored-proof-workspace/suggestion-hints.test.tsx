// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresentation } from "@proof/language";
import type { DisplayedSuggestionSet } from "@proof/protocol";
import { EvidenceBadge, TransitionClassBadge } from "./suggestion-badges";
import {
  SuggestionPanel,
  SUGGESTION_PANEL_ID,
  type SuggestionPanelActions,
  type SuggestionState,
} from "./suggestion-panel";

afterEach(cleanup);

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

function suggestion(id: string, name: string, extra: Record<string, unknown> = {}) {
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

/** Panel fixtures are hand-built: the panel renders what it is given and does not validate it. */
function setOf(suggestions: readonly unknown[]): DisplayedSuggestionSet {
  return {
    id: "suggestion-set:hints",
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
    variantGroups: [],
  } as unknown as DisplayedSuggestionSet;
}

function actions(): SuggestionPanelActions {
  return {
    onPreview: vi.fn(),
    onChooseInputs: vi.fn(),
    onSubmitChoices: vi.fn(),
    onCancelChoices: vi.fn(),
    onApply: vi.fn(),
    onInputSummaryExpanded: vi.fn(),
  };
}

function renderPanel(suggestions: SuggestionState) {
  return render(
    <SuggestionPanel
      suggestions={suggestions}
      move={{ kind: "idle" }}
      mutationPending={false}
      presentation={presentation}
      view="formal"
      {...actions()}
    />,
  );
}

const abstractionResult = (id: string, name: string) =>
  suggestion(id, name, {
    exactRepresentationMatch: false,
    applicability: "requires-input",
    abstractionFit: "compatible",
  });

describe("suggestion card guidance", () => {
  it("explains a disabled Preview on a search-only result", () => {
    renderPanel({
      kind: "ready",
      suggestionSet: setOf([abstractionResult("suggestion:search-a", "Search only A")]),
      transitionClasses: [],
    });
    const preview = screen.getByRole("button", { name: "Preview changes" });
    expect(preview).toBeDisabled();
    expect(preview).toHaveAccessibleDescription(
      "Search-only result: select a concrete expression to apply this.",
    );
  });

  it("explains a disabled Preview that waits for missing values, with no raw identifiers", () => {
    renderPanel({
      kind: "ready",
      suggestionSet: setOf([
        suggestion("suggestion:needs", "Needs a value", {
          applicability: "requires-input",
          unresolvedParameters: ["declaration:arithmetic-left-distributivity-x"],
        }),
      ]),
      transitionClasses: [],
    });
    expect(screen.getByRole("button", { name: "Preview changes" })).toHaveAccessibleDescription(
      "Fill in the missing values first, then preview.",
    );
    expect(screen.getByRole("button", { name: "Fill in missing values" })).toBeEnabled();
    expect(document.body).not.toHaveTextContent("arithmetic-left-distributivity");
  });

  it("gives an applicable result no disabled-Preview reason", () => {
    renderPanel({
      kind: "ready",
      suggestionSet: setOf([suggestion("suggestion:ok", "Fine")]),
      transitionClasses: [],
    });
    expect(screen.getByRole("button", { name: "Preview changes" })).toBeEnabled();
    expect(document.querySelector("[id]+p[class*=previewReason]")).toBeNull();
  });

  it("exposes the panel as a link target", () => {
    renderPanel({ kind: "idle" });
    expect(screen.getByRole("region", { name: "Available suggestions" })).toHaveAttribute(
      "id",
      SUGGESTION_PANEL_ID,
    );
  });
});

describe("suggestion badges", () => {
  it("marks mark-sorry as an unproved assumption beside its stored class", () => {
    const set = setOf([
      suggestion("suggestion:sorry", "Mark as sorry", {
        source: "move",
        artifactId: "move:mark-sorry",
      }),
    ]);
    renderPanel({
      kind: "ready",
      suggestionSet: set,
      transitionClasses: [{ suggestionId: "suggestion:sorry", transitionClass: "equivalence" }],
    });
    const badges = screen.getByRole("group", { name: "Classification of Mark as sorry" });
    const sorry = badges.querySelector('[data-badge="evidence"][data-evidence="sorry"]')!;
    expect(sorry).toHaveTextContent("Sorry (unproved assumption)");
    expect(sorry).toHaveAttribute("title", expect.stringContaining("not an equivalence"));
    // The stored class is not hidden, but the card says plainly that this is an assumption.
    expect(screen.getByTestId("sorry-meaning")).toHaveTextContent("It is not an equivalence.");
  });

  it("does not add a sorry badge to an ordinary move or result", () => {
    renderPanel({
      kind: "ready",
      suggestionSet: setOf([
        suggestion("suggestion:split", "Split", { source: "move", artifactId: "move:split" }),
      ]),
      transitionClasses: [],
    });
    expect(document.querySelector('[data-evidence="sorry"]')).toBeNull();
  });

  it("gives every badge a one-sentence tooltip and keeps the classes distinct", () => {
    const set = setOf([
      suggestion("suggestion:r", "R", {
        predictedObligations: [{ kind: "premise", index: 0, description: "p" }],
      }),
    ]);
    renderPanel({
      kind: "ready",
      suggestionSet: set,
      transitionClasses: [{ suggestionId: "suggestion:r", transitionClass: "strengthening" }],
    });
    const badges = screen.getByRole("group", { name: "Classification of R" });
    for (const badge of badges.querySelectorAll("[data-badge]")) {
      expect(badge.getAttribute("title")?.length ?? 0).toBeGreaterThan(20);
    }
    expect(within(badges).getByText("strengthening")).toBeVisible();
    // The identical provenance badge is no longer repeated on every card.
    expect(badges.querySelector('[data-badge="provenance"]')).toBeNull();
  });

  it("describes equivalence, strengthening, weakening and each evidence kind", () => {
    const view = render(
      <>
        {(["equivalence", "strengthening", "weakening"] as const).map((transitionClass) => (
          <TransitionClassBadge key={transitionClass} transitionClass={transitionClass} />
        ))}
        {(["structural", "library-result", "background-inference", "sorry"] as const).map(
          (evidence) => (
            <EvidenceBadge key={evidence} evidence={evidence} />
          ),
        )}
      </>,
    );
    const titles = [...view.container.querySelectorAll("[data-badge]")].map((badge) =>
      badge.getAttribute("title"),
    );
    expect(new Set(titles).size).toBe(7);
  });
});
