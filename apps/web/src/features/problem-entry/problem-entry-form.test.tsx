// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROBLEM_SETUP_LAYER_CHOICES,
  PROBLEM_SETUP_SORT_CHOICES,
  createProofNodeSchema,
  type ProblemSetupOptions,
} from "@proof/protocol";
import { ProblemEntryForm } from "./problem-entry-form";
import { emptyProblemForm, formToDraft } from "./draft-form";

const SET = { kind: "named", id: "sort:set", arguments: [{ kind: "named", id: "sort:element" }] };
const UNION = {
  id: "operator:set-union",
  symbol: "Union",
  signature: { parameters: [SET, SET], result: SET },
  presentation: {
    displayName: "union",
    latex: { template: "#1\\cup #2", precedence: "additive" },
    naturalLanguage: [{ template: "the union of #1 and #2" }],
    domains: ["sets"],
  },
};

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
    {
      id: "pack:sets",
      name: "Sets",
      description: "Union and intersection.",
      domain: "sets",
      alwaysActive: false,
      operators: [UNION],
    },
  ],
} as ProblemSetupOptions;

const proposition = (symbol: string) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: { kind: "proposition" },
  role: "universal-parameter",
});

function review(goal: unknown = ["Or", "p", "q"]) {
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
            conclusion: { expression: goal },
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

type Call = Readonly<{ url: string; body: Record<string, unknown> }>;
let calls: Call[];
let answers: Map<string, () => Response>;

beforeEach(() => {
  calls = [];
  answers = new Map([
    [
      "/api/problem-drafts/validate",
      () => Response.json({ ok: true, data: { ok: true, review: review() } }),
    ],
    [
      "/api/proof-sessions",
      () => Response.json({ ok: true, data: { replayed: false } }, { status: 201 }),
    ],
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const answer = answers.get(url);
      if (answer === undefined) throw new Error(`Unexpected request to ${url}`);
      return answer();
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const createCalls = () => calls.filter(({ url }) => url === "/api/proof-sessions");
const validateCalls = () => calls.filter(({ url }) => url === "/api/problem-drafts/validate");
const approveButton = () => screen.queryByRole("button", { name: "Start exploring" });

function renderForm() {
  const navigate = vi.fn();
  let sessions = 0;
  render(
    <ProblemEntryForm
      options={options}
      navigate={navigate}
      createSessionId={() => `session:test-${(sessions += 1)}`}
    />,
  );
  return navigate;
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillDraft() {
  change("Problem title", "Disjunction");
  change("Problem statement", "Show p or q from p.");
  fireEvent.click(screen.getByText("More setup choices (optional)"));
  change("Assumed level", "school");
  change("What the reader is expected to know", "Logic.");
  change("Variable or object 1", "p");
  fireEvent.click(screen.getByRole("button", { name: "Add variable or object" }));
  change("Variable or object 2", "q");
  change("Kind of symbol 2", "proposition");
  fireEvent.click(screen.getByRole("button", { name: "Add hypothesis" }));
  change("Hypothesis 1", "p");
  change("Goal 1", "p \\lor q");
}

async function reviewDraft() {
  fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
  await waitFor(() => expect(approveButton()).toBeEnabled());
}

describe("ProblemEntryForm approval gate", () => {
  it("posts nothing to the create endpoint before explicit approval", async () => {
    const navigate = renderForm();
    fillDraft();
    expect(approveButton()).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("created only after you approve");

    await reviewDraft();
    expect(validateCalls()).toHaveLength(1);
    expect(createCalls()).toHaveLength(0);
    const reviewed = validateCalls()[0]?.body.draft;
    expect(reviewed).toMatchObject({
      declarations: [
        { symbol: "p", sort: "proposition" },
        { symbol: "q", sort: "proposition" },
      ],
      hypotheses: [{ format: "latex", latex: "p" }],
      goals: [{ format: "latex", latex: "p \\lor q" }],
      packs: [],
      libraryLayerIds: ["layer:global", "layer:initial-problem"],
    });
    // The review shows the entered problem and mathematical statements.
    expect(screen.getByRole("region", { name: "Review" })).toHaveTextContent("p \\lor q");
    expect(screen.getByRole("region", { name: "Review" })).toHaveTextContent("Show p or q from p.");

    fireEvent.click(approveButton()!);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/sessions/session%3Atest-1"));
    expect(createCalls()).toEqual([
      {
        url: "/api/proof-sessions",
        body: { sessionId: "session:test-1", draft: reviewed, reviewedDigest: review().digest },
      },
    ]);
  });

  it("discards the review when the draft is edited afterwards", async () => {
    renderForm();
    fillDraft();
    await reviewDraft();

    change("Goal 1", "q \\lor p");
    expect(approveButton()).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("created only after you approve");
    expect(createCalls()).toHaveLength(0);

    await reviewDraft();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Sets/ }));
    expect(approveButton()).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Sets/ }));
    expect(approveButton()).toBeNull();
    expect(createCalls()).toHaveLength(0);

    await reviewDraft();
    fireEvent.click(approveButton()!);
    await waitFor(() => expect(createCalls()).toHaveLength(1));
    // Approval sends the draft that was reviewed last, under that review's session ID.
    expect(createCalls()[0]?.body).toMatchObject({
      sessionId: "session:test-3",
      draft: { goals: [{ format: "latex", latex: "q \\lor p" }] },
    });
  });

  it("shows the worker's draft diagnostics and offers no approval", async () => {
    answers.set("/api/problem-drafts/validate", () =>
      Response.json(
        {
          ok: false,
          error: { code: "invalid-draft", message: "Goal 1 uses r." },
          details: {
            diagnostics: [
              {
                code: "undeclared-symbol",
                message: "Goal 1 uses r, which is not declared. Declare it with a sort.",
                path: ["goals", 0, "latex"],
              },
            ],
          },
        },
        { status: 422 },
      ),
    );
    renderForm();
    fillDraft();
    fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Goal 1 (undeclared-symbol): Goal 1 uses r, which is not declared.",
    );
    expect(approveButton()).toBeNull();
    expect(createCalls()).toHaveLength(0);
  });

  it("drops the review when approval finds it stale", async () => {
    answers.set("/api/proof-sessions", () =>
      Response.json(
        {
          ok: false,
          error: { code: "review-stale", message: "Review it again." },
          details: { diagnostics: [{ code: "review-stale", message: "Review it again." }] },
        },
        { status: 409 },
      ),
    );
    const navigate = renderForm();
    fillDraft();
    await reviewDraft();
    fireEvent.click(approveButton()!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Review it again.");
    expect(approveButton()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("gives live parse feedback and blocks review of unreadable MathJSON locally", async () => {
    renderForm();
    fillDraft();
    change("Goal 1", "p \\lor");
    expect(screen.getByText(/could not be parsed/)).toBeInTheDocument();
    change("Goal 1", "p \\lor q");
    expect(screen.getAllByText("Notation recognized.")).toHaveLength(2);

    change("Goal 1 format", "mathjson");
    change("Goal 1", '["Or", "p"');
    expect(screen.getByText(/not valid JSON/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Goal 1: The MathJSON is not valid JSON.",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("formToDraft", () => {
  it("keeps only optional packs, in menu order, and omits empty preferences", () => {
    const result = formToDraft(
      {
        ...emptyProblemForm(),
        title: "t",
        statement: "s",
        packIds: ["pack:sets", "pack:elementary-logic"],
        goals: [{ key: 1, format: "mathjson", text: '["Or", "p", "q"]' }],
      },
      options,
    );
    expect(result).toMatchObject({
      ok: true,
      draft: {
        packs: ["pack:sets"],
        goals: [{ format: "mathjson", expression: ["Or", "p", "q"] }],
      },
    });
    expect(result.ok && "preferences" in result.draft).toBe(false);
  });
});
