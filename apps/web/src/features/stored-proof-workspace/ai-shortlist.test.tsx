// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresentation } from "@proof/language";
import { displayedSuggestionSetSchema, type DisplayedSuggestionSet } from "@proof/protocol";
import { AUTO_RANK_KEY, writeAutoRankPreference } from "./ai-ranking-preference";
import type { TopUpStatus } from "./library-top-up";
import { SuggestionPanel } from "./suggestion-panel";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
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

function suggestionSet(
  suggestions: readonly unknown[],
  id = "suggestion-set:panel",
): DisplayedSuggestionSet {
  return displayedSuggestionSetSchema.parse({
    id,
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
const OTHER_TWO = suggestionSet(
  [
    suggestion("suggestion:and-left", "And elimination"),
    suggestion("suggestion:and-right", "Split"),
  ],
  "suggestion-set:other",
);

type PanelExtras = Readonly<{
  mutationPending?: boolean;
  onDescribeMove?: () => void;
  onFindMoreResults?: () => void;
  findMoreDisabledReason?: string;
  findMoreStatus?: TopUpStatus;
  onAskAgain?: () => void;
}>;
const SESSION = { sessionId: "session:a", nodeId: "node:test" };

function panel(
  set: DisplayedSuggestionSet,
  aiShortlist: typeof SESSION | null = SESSION,
  extras: PanelExtras = {},
) {
  const noop = () => undefined;
  return (
    <SuggestionPanel
      suggestions={{
        kind: set.suggestions.length === 0 ? "empty" : "ready",
        suggestionSet: set,
        transitionClasses: [],
      }}
      move={{ kind: "idle" }}
      mutationPending={extras.mutationPending ?? false}
      presentation={createPresentation({ operators: [] })}
      view="formal"
      aiShortlist={aiShortlist ?? undefined}
      onDescribeMove={extras.onDescribeMove}
      onFindMoreResults={extras.onFindMoreResults}
      findMoreDisabledReason={extras.findMoreDisabledReason}
      findMoreStatus={extras.findMoreStatus}
      onAskAgain={extras.onAskAgain}
      onPreview={noop}
      onChooseInputs={noop}
      onSubmitChoices={noop}
      onCancelChoices={noop}
      onApply={noop}
      onInputSummaryExpanded={noop}
    />
  );
}

function renderPanel(
  set: DisplayedSuggestionSet,
  aiShortlist: typeof SESSION | null = SESSION,
  extras: PanelExtras = {},
) {
  const view = render(panel(set, aiShortlist, extras));
  return {
    ...view,
    showing: (next: DisplayedSuggestionSet, nextExtras: PanelExtras = extras) =>
      view.rerender(panel(next, aiShortlist, nextExtras)),
  };
}

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const shortlisted = (
  set: DisplayedSuggestionSet,
  suggestionId: string,
  rationale = "Best fit.",
) => ({
  ok: true,
  data: {
    status: "shortlisted",
    provenance: "minimal-context-llm",
    suggestionSetId: set.id,
    nodeId: "node:test",
    choices: [{ suggestionId, rationale }],
    fallbackCandidateIds: set.suggestions.map(({ id }) => id),
    diagnostics: [],
  },
});

const noneRelevant = (set: DisplayedSuggestionSet) => ({
  ok: true,
  data: {
    status: "none-relevant",
    provenance: "minimal-context-llm",
    suggestionSetId: set.id,
    nodeId: "node:test",
    choices: [],
    confidence: 0.9,
    reason: "Every card is about a different connective.",
    fallbackCandidateIds: set.suggestions.map(({ id }) => id),
    diagnostics: [],
  },
});

const askButton = () => screen.queryByRole("button", { name: "Ask AI to rank these" });
const autoToggle = () =>
  screen.getByRole("checkbox", { name: "Rank suggestions with AI automatically" });
const NOTICE = "None of these suggestions look relevant to your selection.";

/** Let the automatic-ranking pause elapse and the request settle. */
async function elapse(ms = 700) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function sentBodies(fetchMock: ReturnType<typeof stubFetch>) {
  return (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(
    ([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>,
  );
}

describe("AI shortlist in the suggestion panel (explicit)", () => {
  beforeEach(() => writeAutoRankPreference(false));

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
    const fetchMock = stubFetch(
      200,
      shortlisted(TWO, "suggestion:or-right", "The goal's right side."),
    );
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

  it("sends nothing on its own while automatic ranking is off", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(200, shortlisted(TWO, "suggestion:or-right"));
    renderPanel(TWO);
    await elapse(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(autoToggle()).not.toBeChecked();
    expect(
      screen.getByText(/Automatic ranking is off, so nothing is sent until you ask/),
    ).toBeVisible();
  });

  it("explains why the button is unavailable while a step is being applied", () => {
    renderPanel(TWO, SESSION, { mutationPending: true });
    expect(askButton()).toBeDisabled();
    expect(screen.getByText(/Ranking is paused while a step is being applied/)).toBeVisible();
    expect(askButton()).toHaveAccessibleDescription(/paused while a step is being applied/);
  });

  it("shows the none-relevant notice for an explicit run, with the model's reason and the list", async () => {
    stubFetch(200, noneRelevant(TWO));
    renderPanel(TWO);
    fireEvent.click(askButton()!);
    expect(await screen.findByText(NOTICE)).toBeVisible();
    expect(screen.getByText(/Every card is about a different connective\./)).toBeVisible();
    expect(screen.queryByRole("list", { name: "AI picks" })).toBeNull();
    expect(screen.queryByText(/No AI ranking:/)).toBeNull();
    expect(screen.getByTestId("suggestion-list").children).toHaveLength(2);
  });
});

describe("automatic AI ranking", () => {
  beforeEach(() => vi.useFakeTimers());

  it("is on by default and ranks a new list of two or more once, with the automatic trigger", async () => {
    const fetchMock = stubFetch(
      200,
      shortlisted(TWO, "suggestion:or-right", "The goal's right side."),
    );
    const view = renderPanel(TWO);
    expect(autoToggle()).toBeChecked();
    expect(askButton()).toBeEnabled();
    // Nothing is sent the moment a list appears: it must stay displayed for a moment first.
    expect(fetchMock).not.toHaveBeenCalled();

    await elapse();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBodies(fetchMock)[0]).toMatchObject({
      trigger: "automatic",
      suggestionSetId: TWO.id,
      expectedCurrentNodeId: "node:test",
      candidateIds: ["suggestion:or-left", "suggestion:or-right"],
    });
    expect(screen.getByRole("list", { name: "AI picks" })).toHaveTextContent(
      "Or introduction (right) — The goal's right side.",
    );

    // The same list, shown again, is not ranked again; the deterministic list is unchanged.
    view.showing(TWO);
    await elapse(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("suggestion-list").children).toHaveLength(2);

    // A different list is a new ranking, with a fresh call ID.
    stubFetch(200, shortlisted(OTHER_TWO, "suggestion:and-right", "Splits the goal."));
    view.showing(OTHER_TWO);
    expect(screen.queryByRole("list", { name: "AI picks" })).toBeNull();
    await elapse();
    expect(screen.getByRole("list", { name: "AI picks" })).toHaveTextContent(
      "Split — Splits the goal.",
    );
  });

  it("gives every ranking its own call ID", async () => {
    const fetchMock = stubFetch(200, shortlisted(TWO, "suggestion:or-right"));
    const view = renderPanel(TWO);
    await elapse();
    view.showing(OTHER_TWO);
    await elapse();
    const [first, second] = sentBodies(fetchMock);
    expect(first!.id).toMatch(/^llm-call:shortlist-/);
    expect(second!.id).toMatch(/^llm-call:shortlist-/);
    expect(first!.id).not.toBe(second!.id);
    expect(second).toMatchObject({ suggestionSetId: OTHER_TWO.id, trigger: "automatic" });
  });

  it("does not rank a list of fewer than two, an empty list, or when AI is not configured", async () => {
    const fetchMock = stubFetch(200, shortlisted(TWO, "suggestion:or-right"));
    renderPanel(suggestionSet([suggestion("suggestion:only", "Only one")]));
    await elapse(5_000);
    cleanup();
    renderPanel(suggestionSet([]));
    await elapse(5_000);
    cleanup();
    renderPanel(TWO, null);
    await elapse(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("debounces: a list replaced before the pause ends costs nothing", async () => {
    const fetchMock = stubFetch(200, shortlisted(OTHER_TWO, "suggestion:and-right"));
    const view = renderPanel(TWO);
    await elapse(300);
    view.showing(OTHER_TWO);
    await elapse(300);
    // 600 ms have passed since the first list appeared, but only 300 since the second.
    expect(fetchMock).not.toHaveBeenCalled();
    await elapse(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBodies(fetchMock)[0]).toMatchObject({ suggestionSetId: OTHER_TWO.id });
  });

  it("ignores an answer that arrives after the list changed", async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            pending.push(resolve);
          }),
      ),
    );
    const view = renderPanel(TWO);
    await elapse();
    expect(pending).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ranking…" })).toBeDisabled();

    view.showing(OTHER_TWO);
    await elapse();
    expect(pending).toHaveLength(2);
    // The first list's answer arrives late: it is not shown on the new list.
    await act(async () => {
      pending[0]!(Response.json(shortlisted(TWO, "suggestion:or-right", "Late and stale.")));
    });
    expect(screen.queryByText(/Late and stale\./)).toBeNull();
    expect(screen.queryByRole("list", { name: "AI picks" })).toBeNull();
    await act(async () => {
      pending[1]!(Response.json(shortlisted(OTHER_TWO, "suggestion:and-left", "Current.")));
    });
    expect(screen.getByRole("list", { name: "AI picks" })).toHaveTextContent("Current.");
    expect(screen.queryByText(/Late and stale\./)).toBeNull();
  });

  it("ignores an answer that names a different list, without a banner", async () => {
    stubFetch(200, shortlisted(OTHER_TWO, "suggestion:and-right"));
    renderPanel(TWO);
    await elapse();
    expect(screen.queryByRole("list", { name: "AI picks" })).toBeNull();
    expect(screen.queryByText(/No AI ranking:/)).toBeNull();
  });

  it("falls back silently to the deterministic list on a 429", async () => {
    const fetchMock = stubFetch(429, {
      ok: false,
      error: { code: "ai-rate-limited", message: "The AI request budget is exhausted." },
    });
    renderPanel(TWO);
    await elapse();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/No AI ranking:/)).toBeNull();
    expect(screen.queryByText(/Too many AI requests/)).toBeNull();
    expect(screen.queryByRole("list", { name: "AI picks" })).toBeNull();
    expect(screen.getByTestId("suggestion-list").children).toHaveLength(2);
    expect(askButton()).toBeEnabled();
    // It does not retry on its own.
    await elapse(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a deterministic-fallback answer",
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
    ],
    ["a stale answer", 409, { ok: false, error: { code: "stale-evidence", message: "Moved." } }],
    ["an invalid answer", 200, { unexpected: true }],
  ])("falls back silently on %s", async (_name, status, body) => {
    stubFetch(status, body);
    renderPanel(TWO);
    await elapse();
    expect(screen.queryByText(/No AI ranking:/)).toBeNull();
    expect(screen.queryByText(/Jev did not return a shortlist\./)).toBeNull();
    expect(screen.getByTestId("suggestion-list")).toBeInTheDocument();
  });

  it("falls back silently when the service cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    renderPanel(TWO);
    await elapse();
    expect(screen.queryByText(/No AI ranking:/)).toBeNull();
    expect(askButton()).toBeEnabled();
  });

  it("keeps explicit messaging for a run the user asks for after an automatic fallback", async () => {
    stubFetch(429, { ok: false, error: { code: "ai-rate-limited", message: "Retry later." } });
    renderPanel(TWO);
    await elapse();
    expect(screen.queryByText(/No AI ranking:/)).toBeNull();
    fireEvent.click(askButton()!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/No AI ranking:/)).toHaveTextContent("Too many AI requests right now");
  });

  it("does not send a second automatic request after the user asks first", async () => {
    const fetchMock = stubFetch(200, shortlisted(TWO, "suggestion:or-right"));
    renderPanel(TWO);
    await elapse(200);
    fireEvent.click(askButton()!);
    await elapse(5_000);
    expect(sentBodies(fetchMock).map(({ trigger }) => trigger)).toEqual(["explicit-user"]);
  });

  it("waits while a step is being applied, then ranks once", async () => {
    const fetchMock = stubFetch(200, shortlisted(TWO, "suggestion:or-right"));
    const view = renderPanel(TWO, SESSION, { mutationPending: true });
    await elapse(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
    view.showing(TWO, { mutationPending: false });
    await elapse();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never ranks the same list twice, however the controls around it change", async () => {
    const fetchMock = stubFetch(200, shortlisted(TWO, "suggestion:or-right"));
    const view = renderPanel(TWO);
    await elapse();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    view.showing(TWO, { mutationPending: true });
    view.showing(TWO, { mutationPending: false });
    await elapse(5_000);
    fireEvent.click(autoToggle());
    fireEvent.click(autoToggle());
    await elapse(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("list", { name: "AI picks" })).toBeVisible();
  });

  describe("the toggle", () => {
    it("turns automatic ranking off, remembers it, and keeps the explicit button", async () => {
      const fetchMock = stubFetch(200, shortlisted(TWO, "suggestion:or-right"));
      const view = renderPanel(TWO);
      expect(window.localStorage.getItem(AUTO_RANK_KEY)).toBeNull();
      fireEvent.click(autoToggle());
      expect(autoToggle()).not.toBeChecked();
      expect(window.localStorage.getItem(AUTO_RANK_KEY)).toBe("off");
      await elapse(5_000);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(askButton()).toBeEnabled();

      // A later list, and a later page, still see the choice.
      view.showing(OTHER_TWO);
      expect(autoToggle()).not.toBeChecked();
      await elapse(5_000);
      expect(fetchMock).not.toHaveBeenCalled();
      cleanup();
      renderPanel(TWO);
      expect(autoToggle()).not.toBeChecked();
      await elapse(5_000);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("turning it back on ranks the list that is showing", async () => {
      writeAutoRankPreference(false);
      const fetchMock = stubFetch(200, shortlisted(TWO, "suggestion:or-right"));
      renderPanel(TWO);
      await elapse(5_000);
      expect(fetchMock).not.toHaveBeenCalled();
      fireEvent.click(autoToggle());
      expect(window.localStorage.getItem(AUTO_RANK_KEY)).toBe("on");
      await elapse();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sentBodies(fetchMock)[0]).toMatchObject({ trigger: "automatic" });
    });

    it("drops the answer of an automatic run that is switched off while it is running", async () => {
      let answer!: (response: Response) => void;
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      renderPanel(TWO);
      await elapse();
      expect(screen.getByRole("button", { name: "Ranking…" })).toBeDisabled();
      fireEvent.click(autoToggle());
      expect(askButton()).toBeEnabled();
      await act(async () => {
        answer(Response.json(shortlisted(TWO, "suggestion:or-right", "Too late.")));
      });
      expect(screen.queryByText(/Too late\./)).toBeNull();
      expect(screen.queryByRole("list", { name: "AI picks" })).toBeNull();
    });

    it("works without browser storage", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      const fetchMock = stubFetch(200, shortlisted(TWO, "suggestion:or-right"));
      renderPanel(TWO);
      expect(autoToggle()).toBeChecked();
      fireEvent.click(autoToggle());
      expect(autoToggle()).not.toBeChecked();
      await elapse(5_000);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("explains in plain language what automatic ranking sends", () => {
      stubFetch(200, shortlisted(TWO, "suggestion:or-right"));
      renderPanel(TWO);
      expect(screen.getByText(/A model sees only your selection and these cards/)).toBeVisible();
      expect(screen.getByText(/switch it off above to send nothing until you ask/)).toBeVisible();
    });
  });

  describe("when no suggestion looks relevant", () => {
    it("says so calmly, keeps the list, and shows no buttons whose handlers are missing", async () => {
      const fetchMock = stubFetch(200, noneRelevant(TWO));
      renderPanel(TWO);
      await elapse();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText(NOTICE)).toBeVisible();
      expect(screen.getByText(/Every card is about a different connective\./)).toBeVisible();
      expect(screen.queryByRole("button", { name: "Describe a move" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Find more results" })).toBeNull();
      expect(screen.queryByText(/No AI ranking:/)).toBeNull();
      expect(screen.queryByRole("list", { name: "AI picks" })).toBeNull();
      expect(screen.getByTestId("suggestion-list").children).toHaveLength(2);
    });

    it("offers both next steps when both handlers are provided", async () => {
      stubFetch(200, noneRelevant(TWO));
      const onDescribeMove = vi.fn();
      const onFindMoreResults = vi.fn();
      renderPanel(TWO, SESSION, { onDescribeMove, onFindMoreResults });
      await elapse();
      fireEvent.click(screen.getByRole("button", { name: "Describe a move" }));
      expect(onDescribeMove).toHaveBeenCalledTimes(1);
      expect(onFindMoreResults).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Find more results" }));
      expect(onFindMoreResults).toHaveBeenCalledTimes(1);
    });

    it("renders only the button whose handler exists", async () => {
      stubFetch(200, noneRelevant(TWO));
      renderPanel(TWO, SESSION, { onFindMoreResults: vi.fn() });
      await elapse();
      expect(screen.getByRole("button", { name: "Find more results" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Describe a move" })).toBeNull();
    });

    it("does not show the notice for a different list's answer", async () => {
      stubFetch(200, noneRelevant(OTHER_TWO));
      renderPanel(TWO);
      await elapse();
      expect(screen.queryByText(NOTICE)).toBeNull();
    });
  });
});

describe("the empty suggestions state", () => {
  it("offers 'Find more results' only when a handler is provided", () => {
    renderPanel(suggestionSet([]));
    expect(screen.getByText(/Try selecting a different part of the statement/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Find more results" })).toBeNull();
    cleanup();
    const onFindMoreResults = vi.fn();
    renderPanel(suggestionSet([]), SESSION, { onFindMoreResults });
    fireEvent.click(screen.getByRole("button", { name: "Find more results" }));
    expect(onFindMoreResults).toHaveBeenCalledTimes(1);
  });
});

describe("find more results states", () => {
  it("disables the button in the empty state and says why", () => {
    const onFindMoreResults = vi.fn();
    renderPanel(suggestionSet([]), SESSION, {
      onFindMoreResults,
      findMoreDisabledReason: "This session is read-only, so its library cannot grow.",
    });
    const button = screen.getByRole("button", { name: "Find more results" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/read-only/);
    fireEvent.click(button);
    expect(onFindMoreResults).not.toHaveBeenCalled();
  });

  it("shows the running request and disables the button while it runs", () => {
    renderPanel(suggestionSet([]), SESSION, {
      onFindMoreResults: vi.fn(),
      findMoreStatus: { kind: "working" },
    });
    expect(screen.getByTestId("library-top-up-status")).toHaveTextContent(
      "Looking for more results…",
    );
    expect(screen.getByRole("button", { name: "Find more results" })).toBeDisabled();
  });

  it("offers to ask for suggestions again once results were added, and not otherwise", () => {
    const onAskAgain = vi.fn();
    const { rerender } = render(
      panel(suggestionSet([]), SESSION, {
        onFindMoreResults: vi.fn(),
        onAskAgain,
        findMoreStatus: {
          kind: "done",
          added: 2,
          message: "Added 2 results to the library. Ask for suggestions again to use them.",
        },
      }),
    );
    expect(screen.getByTestId("library-top-up-status")).toHaveTextContent(
      "Added 2 results to the library. Ask for suggestions again to use them.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask for suggestions again" }));
    expect(onAskAgain).toHaveBeenCalledTimes(1);
    rerender(
      panel(suggestionSet([]), SESSION, {
        onFindMoreResults: vi.fn(),
        onAskAgain,
        findMoreStatus: { kind: "done", added: 0, message: "No new results were added." },
      }),
    );
    expect(screen.queryByRole("button", { name: "Ask for suggestions again" })).toBeNull();
    rerender(panel(suggestionSet([]), SESSION, { onFindMoreResults: vi.fn() }));
    expect(screen.queryByTestId("library-top-up-status")).toBeNull();
  });

  it("disables the none-relevant notice's button too, with the same reason", async () => {
    vi.useFakeTimers();
    stubFetch(200, noneRelevant(TWO));
    renderPanel(TWO, SESSION, {
      onFindMoreResults: vi.fn(),
      findMoreDisabledReason: "The library assistant is not set up for this service.",
    });
    await elapse();
    const button = screen.getByRole("button", { name: "Find more results" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/not set up/);
  });
});
