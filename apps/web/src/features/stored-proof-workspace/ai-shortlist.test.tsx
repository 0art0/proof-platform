// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresentation } from "@proof/language";
import { displayedSuggestionSetSchema, type DisplayedSuggestionSet } from "@proof/protocol";
import { SuggestionPanel } from "./suggestion-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function suggestion(id: string, name: string) {
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
  };
}

function suggestionSet(suggestions: readonly unknown[]): DisplayedSuggestionSet {
  return displayedSuggestionSetSchema.parse({
    id: "suggestion-set:panel",
    nodeId: "node:test",
    stateId: "state:test",
    selection: {
      kind: "exact",
      anchor: {
        stateId: "state:test",
        target: { kind: "goal", id: "goal:test" },
        statement: { kind: "conclusion" },
      },
      path: [],
      fragment: "q",
      declarations: [
        {
          id: "declaration:q",
          symbol: "q",
          sort: { kind: "proposition" },
          role: "universal-parameter",
        },
      ],
      position: { polarity: "positive", role: "proposition" },
    },
    suggestions,
    variantGroups: [],
  });
}

const TWO = suggestionSet([
  suggestion("suggestion:or-left", "Or introduction (left)"),
  suggestion("suggestion:or-right", "Or introduction (right)"),
]);

function renderPanel(
  set: DisplayedSuggestionSet,
  aiShortlist: { sessionId: string; nodeId: string } | null = {
    sessionId: "session:a",
    nodeId: "node:test",
  },
) {
  const noop = () => undefined;
  render(
    <SuggestionPanel
      suggestions={{ kind: "ready", suggestionSet: set, transitionClasses: [] }}
      move={{ kind: "idle" }}
      mutationPending={false}
      presentation={createPresentation({ operators: [] })}
      view="formal"
      aiShortlist={aiShortlist ?? undefined}
      onPreview={noop}
      onChooseInputs={noop}
      onSubmitChoices={noop}
      onCancelChoices={noop}
      onApply={noop}
      onInputSummaryExpanded={noop}
    />,
  );
}

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const askButton = () => screen.queryByRole("button", { name: "Ask AI to rank these" });

describe("AI shortlist in the suggestion panel", () => {
  it("is offered only when configured and there is something to rank", () => {
    renderPanel(TWO, null);
    expect(askButton()).toBeNull();
    cleanup();
    renderPanel(suggestionSet([suggestion("suggestion:only", "Only one")]));
    expect(askButton()).toBeNull();
    cleanup();
    renderPanel(TWO);
    expect(askButton()).toBeEnabled();
  });

  it("ranks the displayed cards and leaves the deterministic list unchanged", async () => {
    const fetchMock = stubFetch(200, {
      ok: true,
      data: {
        status: "shortlisted",
        provenance: "minimal-context-llm",
        suggestionSetId: TWO.id,
        nodeId: "node:test",
        choices: [{ suggestionId: "suggestion:or-right", rationale: "The goal's right side." }],
        fallbackCandidateIds: [],
        diagnostics: [],
      },
    });
    renderPanel(TWO);
    fireEvent.click(askButton()!);
    const picks = await screen.findByRole("list", { name: "AI picks" });
    expect(picks).toHaveTextContent("Or introduction (right) — The goal's right side.");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/proof-sessions/session%3Aa/ai-shortlist");
    expect(JSON.parse(String(init.body))).toMatchObject({
      expectedCurrentNodeId: "node:test",
      suggestionSetId: TWO.id,
      candidateIds: ["suggestion:or-left", "suggestion:or-right"],
      trigger: "explicit-user",
    });
    const list = screen.getByTestId("suggestion-list");
    expect([...list.children].map((item) => item.textContent)).toEqual([
      expect.stringContaining("Or introduction (left)"),
      expect.stringContaining("Or introduction (right)"),
    ]);
  });

  it.each([
    [
      200,
      {
        ok: true,
        data: {
          status: "deterministic-fallback",
          provenance: "deterministic",
          choices: [],
          fallbackCandidateIds: [],
          diagnostics: [{ code: "ai-fallback", message: "Jev did not return a shortlist." }],
        },
      },
      "Jev did not return a shortlist.",
    ],
    [
      429,
      { ok: false, error: { code: "ai-rate-limited", message: "Retry later." } },
      "Too many AI requests right now",
    ],
    [
      409,
      { ok: false, error: { code: "stale-evidence", message: "The proof session moved." } },
      "The proof session moved.",
    ],
  ])("falls back visibly on a %s answer", async (status, body, text) => {
    stubFetch(status, body);
    renderPanel(TWO);
    fireEvent.click(askButton()!);
    expect(await screen.findByText(/No AI ranking:/)).toHaveTextContent(text);
    expect(screen.queryByRole("list", { name: "AI picks" })).toBeNull();
    expect(screen.getByTestId("suggestion-list")).toBeInTheDocument();
  });
});
