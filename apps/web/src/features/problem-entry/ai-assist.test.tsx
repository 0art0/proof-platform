// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROBLEM_SETUP_LAYER_CHOICES,
  PROBLEM_SETUP_SORT_CHOICES,
  createProofNodeSchema,
  type ProblemSetupOptions,
} from "@proof/protocol";
import { ProblemEntryForm } from "./problem-entry-form";

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

const MANIFEST = {
  kind: "topic-manifest",
  domains: ["propositional logic"],
  objectKinds: ["propositions"],
  vocabulary: ["disjunction"],
  notation: [{ symbol: "∨", meaning: "or" }],
  backgroundTopics: ["truth tables"],
  customOperators: [],
};

const DRAFT = {
  problem: { title: "Disjunction", statement: "Show p or q from p." },
  background: { level: "school", summary: "Logic.", assumptions: [] },
  libraryLayerIds: ["layer:global", "layer:initial-problem"],
  packs: [],
  declarations: [
    { symbol: "p", sort: "proposition" },
    { symbol: "q", sort: "proposition" },
  ],
  hypotheses: [{ format: "latex", latex: "p" }],
  goals: [{ format: "latex", latex: "p \\lor q" }],
};

function review() {
  return {
    rootNode: createProofNodeSchema().parse({
      id: "node:root",
      state: {
        id: "state:root",
        goals: [
          {
            id: "goal:1",
            sequent: {
              context: {
                declarations: ["p", "q"].map((symbol) => ({
                  id: `declaration:${symbol}`,
                  symbol,
                  sort: { kind: "proposition" },
                  role: "universal-parameter",
                })),
                hypotheses: [],
              },
              conclusion: { expression: ["Or", "p", "q"] },
            },
          },
        ],
        obligations: [],
      },
    }),
    operators: [],
    metadata: {
      problem: DRAFT.problem,
      background: DRAFT.background,
      libraryLayerIds: DRAFT.libraryLayerIds,
    },
    activePackIds: ["pack:elementary-logic"],
    digest: `sha256:${"c".repeat(64)}`,
  };
}

type Call = Readonly<{ url: string; body: Record<string, unknown> }>;
let calls: Call[];
let answers: Map<string, (body: Record<string, unknown>) => Response>;

beforeEach(() => {
  calls = [];
  answers = new Map([
    [
      "/api/ai/topics",
      (body) =>
        Response.json({
          ok: true,
          data: { status: "proposed", callId: body.id, replayed: false, proposal: MANIFEST },
        }),
    ],
    [
      "/api/ai/topics/decisions",
      (body) =>
        Response.json(
          { ok: true, data: { status: "recorded", decision: { decision: body.decision } } },
          { status: 201 },
        ),
    ],
    [
      "/api/ai/formalize",
      (body) =>
        Response.json({
          ok: true,
          data: { status: "ready-for-review", callId: body.id, replayed: false, draft: DRAFT },
        }),
    ],
    [
      "/api/problem-drafts/validate",
      () => Response.json({ ok: true, data: { ok: true, review: review() } }),
    ],
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body });
      const answer = answers.get(url);
      if (answer === undefined) throw new Error(`Unexpected request to ${url}`);
      return answer(body);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderForm(ai = { topics: true, formalizer: true }) {
  let ids = 0;
  render(
    <ProblemEntryForm
      options={options}
      navigate={vi.fn()}
      createSessionId={() => "session:test"}
      ai={ai}
      createAiId={(prefix) => `${prefix}-${(ids += 1)}`}
    />,
  );
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillProblem() {
  change("Problem title", "Disjunction");
  change("Problem statement", "Show p or q from p.");
  change("Assumed level", "school");
  change("What the reader is expected to know", "Logic.");
}

const section = () => screen.getByRole("region", { name: "AI assistance" });
const button = (name: string) => within(section()).getByRole("button", { name });
const callsTo = (url: string) => calls.filter((call) => call.url === url);

describe("AI assistance in problem entry", () => {
  it("explains when AI is not configured and offers nothing to click", () => {
    renderForm({ topics: false, formalizer: false });
    fillProblem();
    expect(section()).toHaveTextContent("not configured on this proof service");
    expect(button("Suggest topics")).toBeDisabled();
    expect(button("Draft the setup")).toBeDisabled();
  });

  it("asks for the problem and background before any request", () => {
    renderForm();
    expect(section()).toHaveTextContent("Fill in Problem title, Problem statement");
    expect(button("Suggest topics")).toBeDisabled();
    fillProblem();
    expect(button("Suggest topics")).toBeEnabled();
  });

  it("suggests topics from the problem and background only, and records approval", async () => {
    renderForm();
    fillProblem();
    change("Variable or object 1", "secret");
    fireEvent.click(button("Suggest topics"));
    const proposal = await screen.findByLabelText("Suggested topics");
    expect(proposal).toHaveTextContent("propositional logic");
    expect(proposal).toHaveTextContent("∨: or");

    const [request] = callsTo("/api/ai/topics");
    expect(Object.keys(request!.body).sort()).toEqual([
      "background",
      "constructionId",
      "id",
      "problem",
    ]);
    expect(JSON.stringify(request!.body)).not.toContain("secret");

    change("Note on your decision", "Looks right.");
    fireEvent.click(within(proposal).getByRole("button", { name: "Approve topics" }));
    await within(proposal).findByText("You approved these topics.");
    expect(callsTo("/api/ai/topics/decisions")[0]?.body).toMatchObject({
      constructionId: request!.body.constructionId,
      callId: "llm-call:topics-2",
      decision: "approved",
      rationale: "Looks right.",
    });
    // Nothing reaches the preferences until the user asks.
    expect(screen.getByLabelText("Preferred areas of mathematics")).toHaveValue("");
    fireEvent.click(
      within(proposal).getByRole("button", {
        name: "Add these areas and notation to my preferences",
      }),
    );
    expect(screen.getByLabelText("Preferred areas of mathematics")).toHaveValue(
      "propositional logic",
    );
    expect(screen.getByLabelText("Notation preferences (one per line)")).toHaveValue("∨: or");
  });

  it("records a rejection and retries a failed recording with the same decision", async () => {
    let failures = 1;
    const recorded = answers.get("/api/ai/topics/decisions")!;
    answers.set("/api/ai/topics/decisions", (body) =>
      failures-- > 0
        ? Response.json(
            { ok: false, error: { code: "service_unavailable", message: "Unavailable." } },
            { status: 503 },
          )
        : recorded(body),
    );
    renderForm();
    fillProblem();
    fireEvent.click(button("Suggest topics"));
    const proposal = await screen.findByLabelText("Suggested topics");
    fireEvent.click(within(proposal).getByRole("button", { name: "Reject topics" }));
    await within(proposal).findByText(/Your decision was not recorded/);
    fireEvent.click(within(proposal).getByRole("button", { name: "Reject topics" }));
    await within(proposal).findByText(/You rejected these topics/);
    const [first, second] = callsTo("/api/ai/topics/decisions");
    expect(second!.body).toEqual(first!.body);
    expect(first!.body).toMatchObject({ decision: "rejected" });
    expect(within(proposal).queryByRole("button", { name: /preferences/ })).toBeNull();
  });

  it("loads a drafted setup only on request, then reviews it with its provenance", async () => {
    renderForm();
    fillProblem();
    fireEvent.click(button("Draft the setup"));
    const drafted = await screen.findByLabelText("Drafted setup");
    expect(drafted).toHaveTextContent("p \\lor q");
    expect(screen.getByLabelText("Goal 1")).toHaveValue("");
    expect(callsTo("/api/ai/formalize")[0]?.body).toMatchObject({
      constructionId: "construction:web-1",
      id: "llm-call:formalize-2",
      problem: DRAFT.problem,
      libraryLayerIds: DRAFT.libraryLayerIds,
      packs: [],
    });

    fireEvent.click(
      within(drafted).getByRole("button", {
        name: "Replace my variables, hypotheses and goals with this draft",
      }),
    );
    expect(screen.getByLabelText("Goal 1")).toHaveValue("p \\lor q");
    expect(screen.getByLabelText("Hypothesis 1")).toHaveValue("p");
    expect(screen.getByLabelText("Variable or object 2")).toHaveValue("q");

    fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    const reviewed = await screen.findByRole("region", { name: "Review" });
    expect(reviewed).toHaveTextContent("started from an AI draft (llm-call:formalize-2)");
    expect(callsTo("/api/problem-drafts/validate")[0]?.body.draft).toMatchObject({
      declarations: DRAFT.declarations,
      hypotheses: DRAFT.hypotheses,
      goals: DRAFT.goals,
    });
    expect(callsTo("/api/proof-sessions")).toHaveLength(0);
  });

  it("shows why a draft needs review and still lets the user load it", async () => {
    answers.set("/api/ai/formalize", () =>
      Response.json(
        {
          ok: false,
          error: { code: "undeclared-symbol", message: "Goal 1 uses r." },
          details: {
            status: "needs-review",
            callId: "llm-call:formalize-2",
            draft: { ...DRAFT, goals: [{ format: "latex", latex: "r" }] },
            diagnostics: [{ code: "undeclared-symbol", message: "Goal 1 uses r.", path: [] }],
          },
        },
        { status: 422 },
      ),
    );
    renderForm();
    fillProblem();
    fireEvent.click(button("Draft the setup"));
    const drafted = await screen.findByLabelText("Drafted setup");
    expect(drafted).toHaveTextContent("Goal 1 uses r.");
    fireEvent.click(within(drafted).getByRole("button", { name: /Replace my variables/ }));
    expect(screen.getByLabelText("Goal 1")).toHaveValue("r");
  });

  it.each([
    [
      429,
      { code: "ai-rate-limited", message: "The AI request budget is exhausted; retry later." },
      "Too many AI requests right now",
    ],
    [
      422,
      { code: "invalid-output", message: "The LLM output is malformed." },
      "did not pass validation and was discarded",
    ],
  ])("explains a %s answer", async (status, error, text) => {
    answers.set("/api/ai/topics", () =>
      Response.json({ ok: false, error, details: { diagnostics: [error] } }, { status }),
    );
    renderForm();
    fillProblem();
    fireEvent.click(button("Suggest topics"));
    expect(await within(section()).findByRole("alert")).toHaveTextContent(text);
  });

  it("relays a model refusal without a proposal", async () => {
    answers.set("/api/ai/formalize", () =>
      Response.json({
        ok: true,
        data: {
          status: "declined",
          callId: "llm-call:formalize-2",
          replayed: false,
          result: { kind: "declined", reason: "Not a mathematics problem." },
        },
      }),
    );
    renderForm();
    fillProblem();
    fireEvent.click(button("Draft the setup"));
    expect(await within(section()).findByRole("alert")).toHaveTextContent(
      "The model declined: Not a mathematics problem.",
    );
    expect(screen.queryByLabelText("Drafted setup")).toBeNull();
  });
});
