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

const INTEGER = { kind: "named", id: "sort:integer" };
const COPRIME = {
  id: "operator:coprime",
  symbol: "Coprime",
  signature: { parameters: [INTEGER, INTEGER], result: { kind: "proposition" } },
  presentation: {
    displayName: "coprime",
    latex: {
      template: String.raw`#1\perp #2`,
      precedence: "relation",
      parse: { trigger: String.raw`\perp`, notation: "infix" },
    },
    naturalLanguage: [{ template: "#1 and #2 are coprime" }],
  },
};

function proposal(level = "first-year undergraduate") {
  return {
    kind: "background-proposal",
    background: {
      level,
      summary: "Elementary number theory.",
      assumptions: ["Divisibility of integers", "Euclid's lemma"],
      domains: ["number theory", "algebra"],
      maximumLevel: "undergraduate",
    },
    constants: [{ operator: COPRIME, rationale: "The goal says two integers are coprime." }],
  };
}

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
      "/api/ai/background",
      (body) =>
        Response.json({
          ok: true,
          data: {
            status: "proposed",
            callId: body.id,
            replayed: false,
            proposal: proposal(
              body.revision === undefined ? undefined : "second-year undergraduate",
            ),
          },
        }),
    ],
    [
      "/api/ai/background/decisions",
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
    ["/api/proof-sessions", () => Response.json({ ok: true, data: {} }, { status: 201 })],
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

function renderForm(
  ai = { background: true, library: true, formalizer: true },
  initialStatement = "",
) {
  let ids = 0;
  render(
    <ProblemEntryForm
      options={options}
      navigate={vi.fn()}
      createSessionId={() => "session:test"}
      ai={ai}
      createAiId={(prefix) => `${prefix}-${(ids += 1)}`}
      initialStatement={initialStatement}
    />,
  );
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillStatement() {
  change("Problem statement", "Show that consecutive integers are coprime.");
}

function fillProblem() {
  change("Problem title", "Disjunction");
  change("Problem statement", "Show p or q from p.");
  change("Assumed level", "school");
  change("What the reader is expected to know", "Logic.");
}

const section = () => screen.getByRole("region", { name: "Background and setup" });
const button = (name: string) => within(section()).getByRole("button", { name });
const callsTo = (url: string) => calls.filter((call) => call.url === url);

async function propose() {
  fireEvent.click(button("Suggest background"));
  return screen.findByRole("group", { name: "Proposed background" });
}

describe("AI assistance in problem entry", () => {
  it("explains when AI is not configured and offers nothing to click", () => {
    renderForm({ background: false, library: false, formalizer: false });
    fillProblem();
    expect(section()).toHaveTextContent("not configured on this proof service");
    expect(button("Suggest background")).toBeDisabled();
    expect(section()).toHaveTextContent("Not configured.");
    expect(button("Draft the setup")).toBeDisabled();
  });

  it("needs only the problem statement to propose a background, and says so", () => {
    renderForm();
    expect(button("Suggest background")).toBeDisabled();
    expect(section()).toHaveTextContent("Enter the problem statement first.");
    // The background fields are what a proposal fills in; they need not be filled first.
    fillStatement();
    expect(button("Suggest background")).toBeEnabled();
    expect(section()).not.toHaveTextContent("Enter the problem statement first.");
    expect(screen.getByLabelText("Assumed level")).toHaveValue("");
  });

  it("asks for the background fields before drafting a setup, and points to the proposal", () => {
    renderForm();
    fillStatement();
    expect(button("Draft the setup")).toBeDisabled();
    expect(section()).toHaveTextContent(
      "Accept a background first, or fill in Assumed level, What the reader is expected to know by hand.",
    );
    fillProblem();
    expect(button("Draft the setup")).toBeEnabled();
  });

  it("proposes from the problem statement and preferences only, and shows the result card", async () => {
    renderForm();
    fillStatement();
    change("Preferred areas of mathematics", "number theory");
    change("Variable or object 1", "secret");
    const card = await propose();

    const [request] = callsTo("/api/ai/background");
    expect(Object.keys(request!.body).sort()).toEqual([
      "constructionId",
      "id",
      "preferences",
      "problem",
    ]);
    expect(request!.body).toMatchObject({
      constructionId: "construction:web-1",
      id: "llm-call:background-2",
      // Without an entered title, the statement names the problem.
      problem: {
        title: "Show that consecutive integers are coprime.",
        statement: "Show that consecutive integers are coprime.",
      },
      preferences: { domains: ["number theory"] },
    });
    expect(JSON.stringify(request!.body)).not.toContain("secret");

    expect(card).toHaveTextContent("Proposed by AI from your problem statement");
    expect(card).toHaveTextContent("Background levelfirst-year undergraduate");
    expect(card).toHaveTextContent("Elementary number theory.");
    expect(card).toHaveTextContent("Divisibility of integers; Euclid's lemma");
    expect(card).toHaveTextContent("number theory, algebra");
    expect(card).toHaveTextContent("Up to undergraduate level.");
    const constants = within(card).getByRole("list");
    expect(constants).toHaveTextContent("x_1\\perp x_2");
    expect(constants).toHaveTextContent("coprime");
    expect(constants).toHaveTextContent("$x_1$ and $x_2$ are coprime");
    expect(constants).toHaveTextContent("The goal says two integers are coprime.");
    // Nothing is filled in until the user accepts.
    expect(screen.getByLabelText("Assumed level")).toHaveValue("");
    expect(callsTo("/api/ai/background/decisions")).toHaveLength(0);
  });

  it("sends the entered title when there is one", async () => {
    renderForm();
    change("Problem title", "Coprime neighbours");
    fillStatement();
    await propose();
    expect(callsTo("/api/ai/background")[0]!.body).toMatchObject({
      problem: { title: "Coprime neighbours" },
    });
  });

  it("says when the proposal has no constants", async () => {
    answers.set("/api/ai/background", (body) =>
      Response.json({
        ok: true,
        data: {
          status: "proposed",
          callId: body.id,
          proposal: { ...proposal(), constants: [] },
        },
      }),
    );
    renderForm();
    fillStatement();
    const card = await propose();
    expect(card).toHaveTextContent("The problem needs no notation beyond built-in mathematics.");
    expect(within(card).queryByRole("list")).toBeNull();
  });

  it("revises with feedback, naming the previous call and never sending the proposal back", async () => {
    renderForm();
    fillStatement();
    const card = await propose();
    const revise = within(card).getByRole("button", { name: "Revise with feedback" });
    expect(revise).toBeDisabled();
    expect(card).toHaveTextContent("To revise, describe what to change first.");

    fireEvent.change(within(card).getByLabelText("Feedback for a revision"), {
      target: { value: "  Assume a bit more.  " },
    });
    expect(revise).toBeEnabled();
    fireEvent.click(revise);
    await within(card).findByText("second-year undergraduate");

    const [first, second] = callsTo("/api/ai/background");
    expect(second!.body).toMatchObject({
      constructionId: first!.body.constructionId,
      id: "llm-call:background-3",
      revision: { previousCallId: "llm-call:background-2", feedback: "Assume a bit more." },
    });
    expect(Object.keys(second!.body.revision as object).sort()).toEqual([
      "feedback",
      "previousCallId",
    ]);
    expect(JSON.stringify(second!.body)).not.toContain("background-proposal");
    expect(within(card).getByLabelText("Feedback for a revision")).toHaveValue("");

    // A further revision chains from the latest proposal.
    fireEvent.change(within(card).getByLabelText("Feedback for a revision"), {
      target: { value: "Drop Euclid." },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Revise with feedback" }));
    await vi.waitFor(() => expect(callsTo("/api/ai/background")).toHaveLength(3));
    expect(callsTo("/api/ai/background")[2]!.body.revision).toMatchObject({
      previousCallId: "llm-call:background-3",
    });
  });

  it("keeps the proposal and explains when a revision fails", async () => {
    renderForm();
    fillStatement();
    const card = await propose();
    answers.set("/api/ai/background", () =>
      Response.json(
        {
          ok: false,
          error: { code: "call-not-found", message: "The LLM call does not exist." },
          details: {
            diagnostics: [{ code: "call-not-found", message: "The LLM call does not exist." }],
          },
        },
        { status: 404 },
      ),
    );
    fireEvent.change(within(card).getByLabelText("Feedback for a revision"), {
      target: { value: "More." },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Revise with feedback" }));
    expect(await within(section()).findByRole("alert")).toHaveTextContent(
      "The LLM call does not exist.",
    );
    expect(screen.getByRole("group", { name: "Proposed background" })).toHaveTextContent(
      "first-year undergraduate",
    );
  });

  it("accepts a proposal: records the decision, fills the background fields and keeps them editable", async () => {
    renderForm();
    fillStatement();
    const card = await propose();
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await within(card).findByRole("button", { name: "Accepted" });

    const [decision] = callsTo("/api/ai/background/decisions");
    expect(decision!.body).toMatchObject({
      constructionId: "construction:web-1",
      callId: "llm-call:background-2",
      decisionId: "background-decision-3",
      decision: "approved",
      rationale: "Accepted in the problem setup form.",
    });
    expect(decision!.body.decidedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    // The existing background fields are filled, and remain ordinary editable fields.
    expect(screen.getByLabelText("Assumed level")).toHaveValue("first-year undergraduate");
    expect(screen.getByLabelText("What the reader is expected to know")).toHaveValue(
      "Elementary number theory.",
    );
    expect(screen.getByLabelText("Specific background assumptions (one per line)")).toHaveValue(
      "Divisibility of integers\nEuclid's lemma",
    );
    expect(screen.getByLabelText("Areas of mathematics")).toHaveValue("number theory, algebra");
    expect(screen.getByLabelText("Highest level of included results")).toHaveValue("undergraduate");
    change("Assumed level", "second-year undergraduate");
    expect(screen.getByLabelText("Assumed level")).toHaveValue("second-year undergraduate");

    const status = within(card).getByRole("status");
    expect(status).toHaveTextContent("Accepted.");
    expect(status).toHaveTextContent("its constant (Coprime) will be used");
    expect(within(card).getByRole("button", { name: "Accepted" })).toBeDisabled();
  });

  it("retries a failed recording with the same decision", async () => {
    let failures = 1;
    const recorded = answers.get("/api/ai/background/decisions")!;
    answers.set("/api/ai/background/decisions", (body) =>
      failures-- > 0
        ? Response.json(
            { ok: false, error: { code: "service_unavailable", message: "Unavailable." } },
            { status: 503 },
          )
        : recorded(body),
    );
    renderForm();
    fillStatement();
    const card = await propose();
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await within(card).findByText(/Your acceptance was not recorded/);
    expect(screen.getByLabelText("Assumed level")).toHaveValue("");
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await within(card).findByRole("button", { name: "Accepted" });
    const [first, second] = callsTo("/api/ai/background/decisions");
    expect(second!.body).toEqual(first!.body);
    expect(screen.getByLabelText("Assumed level")).toHaveValue("first-year undergraduate");
  });

  it("explains a refused acceptance, changes nothing, and offers a revision instead", async () => {
    answers.set("/api/ai/background/decisions", () =>
      Response.json(
        {
          ok: false,
          error: {
            code: "approved-constant-conflict",
            message: "Divides is already an operator of the pack pack:divisibility.",
          },
          details: {
            diagnostics: [
              {
                code: "approved-constant-conflict",
                message: "Divides is already an operator of the pack pack:divisibility.",
              },
            ],
          },
        },
        { status: 409 },
      ),
    );
    renderForm();
    fillStatement();
    const card = await propose();
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "This proposal cannot be accepted: Divides is already an operator of the pack",
    );
    expect(screen.getByLabelText("Assumed level")).toHaveValue("");
    expect(within(card).getByRole("button", { name: "Accept" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Revise with feedback" })).toBeDisabled();
  });

  it("flags a proposal made before the problem statement was edited", async () => {
    renderForm();
    fillStatement();
    const card = await propose();
    expect(card).not.toHaveTextContent("You have edited the problem");
    change("Problem statement", "Show that consecutive integers are coprime, in detail.");
    expect(card).toHaveTextContent("You have edited the problem or preferences");
  });

  it("suggests a background at once for a statement typed on the landing page, and only once", async () => {
    renderForm(undefined, "Show that consecutive integers are coprime.");
    expect(screen.getByLabelText("Problem statement")).toHaveValue(
      "Show that consecutive integers are coprime.",
    );
    const card = await screen.findByRole("group", { name: "Proposed background" });
    expect(card).toHaveTextContent("first-year undergraduate");
    expect(callsTo("/api/ai/background")).toHaveLength(1);
    expect(button("Suggest again")).toBeEnabled();
  });

  it("waits for a click when the statement was typed here, or AI is not configured", async () => {
    renderForm({ background: false, library: false, formalizer: false }, "Show p.");
    expect(screen.getByLabelText("Problem statement")).toHaveValue("Show p.");
    // Without AI, the setup is entered by hand and is not tucked away.
    expect(screen.queryByText("Edit the background and setup by hand")).toBeNull();
    cleanup();
    renderForm();
    fillStatement();
    await Promise.resolve();
    expect(calls).toHaveLength(0);
  });

  it("drafts and checks the setup once a background is accepted, so only the statement is typed", async () => {
    renderForm();
    fillStatement();
    const card = await propose();
    expect(callsTo("/api/ai/formalize")).toHaveLength(0);
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));

    // Accepting drafts the setup with the accepted background, loads it and checks it.
    const reviewed = await screen.findByRole("region", { name: "Review" });
    const [formalize] = callsTo("/api/ai/formalize");
    expect(formalize!.body).toMatchObject({
      constructionId: "construction:web-1",
      id: "llm-call:formalize-4",
      problem: {
        title: "Show that consecutive integers are coprime.",
        statement: "Show that consecutive integers are coprime.",
      },
      background: proposal().background,
      approvedBackground: { decisionId: "background-decision-3" },
    });
    expect(JSON.stringify(formalize!.body)).not.toContain("signature");
    expect(JSON.stringify(formalize!.body)).not.toContain("operators");
    expect(screen.getByLabelText("Goal 1")).toHaveValue("p \\lor q");
    expect(screen.getByLabelText("Hypothesis 1")).toHaveValue("p");
    expect(section()).toHaveTextContent(
      "Drafted by AI (llm-call:formalize-4) and loaded into the setup for you to review.",
    );
    expect(reviewed).toHaveTextContent("started from an AI draft (llm-call:formalize-4)");
    // Nothing needed fixing, so entering the setup by hand stays tucked away.
    expect(
      screen.getByText("Edit the background and setup by hand").closest("details"),
    ).not.toHaveAttribute("open");
    // The session still waits for the user's approval.
    expect(callsTo("/api/proof-sessions")).toHaveLength(0);
    expect(reviewed).toHaveTextContent("Accepted constants");
    expect(reviewed).toHaveTextContent("Coprime");
    const [validate] = callsTo("/api/problem-drafts/validate");
    expect(validate!.body.approvedBackground).toEqual({
      constructionId: "construction:web-1",
      decisionId: "background-decision-3",
    });
    expect(JSON.stringify(validate!.body)).not.toContain("signature");

    fireEvent.click(within(reviewed).getByRole("button", { name: "Start exploring" }));
    await vi.waitFor(() => expect(callsTo("/api/proof-sessions")).toHaveLength(1));
    expect(callsTo("/api/proof-sessions")[0]!.body).toMatchObject({
      sessionId: "session:test",
      reviewedDigest: review().digest,
      approvedBackground: {
        constructionId: "construction:web-1",
        decisionId: "background-decision-3",
      },
    });
  });

  it("invalidates a review when the accepted constants change, and can stop using them", async () => {
    renderForm();
    fillStatement();
    const card = await propose();
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await screen.findByRole("region", { name: "Review" });

    fireEvent.click(within(card).getByRole("button", { name: "Stop using these constants" }));
    expect(screen.queryByRole("region", { name: "Review" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Stop using these constants" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    await screen.findByRole("region", { name: "Review" });
    const validations = callsTo("/api/problem-drafts/validate");
    expect(validations).toHaveLength(2);
    expect(validations[1]!.body).not.toHaveProperty("approvedBackground");
    expect(screen.getByRole("region", { name: "Review" })).not.toHaveTextContent(
      "Accepted constants",
    );
  });

  it("keeps an earlier acceptance in use while a new proposal is being considered", async () => {
    renderForm();
    fillStatement();
    const card = await propose();
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    await within(card).findByRole("button", { name: "Accepted" });
    fireEvent.click(button("Suggest again"));
    await vi.waitFor(() => expect(callsTo("/api/ai/background")).toHaveLength(2));
    const fresh = await screen.findByRole("group", { name: "Proposed background" });
    await within(fresh).findByRole("button", { name: "Accept" });
    expect(section()).toHaveTextContent("An earlier proposal is accepted and in use.");
    expect(within(fresh).getByRole("button", { name: "Accept" })).toBeEnabled();
  });

  it("drafts from a background entered by hand, then loads, checks and reviews the draft with its provenance", async () => {
    renderForm();
    fillProblem();
    fireEvent.click(button("Draft the setup"));
    const reviewed = await screen.findByRole("region", { name: "Review" });
    const [formalize] = callsTo("/api/ai/formalize");
    expect(formalize!.body).toMatchObject({
      constructionId: "construction:web-1",
      id: "llm-call:formalize-2",
      problem: DRAFT.problem,
      libraryLayerIds: DRAFT.libraryLayerIds,
      packs: [],
    });
    expect(formalize!.body).not.toHaveProperty("approvedBackground");

    expect(screen.getByLabelText("Goal 1")).toHaveValue("p \\lor q");
    expect(screen.getByLabelText("Hypothesis 1")).toHaveValue("p");
    expect(screen.getByLabelText("Variable or object 2")).toHaveValue("q");
    expect(button("Draft the setup again")).toBeEnabled();
    expect(reviewed).toHaveTextContent("started from an AI draft (llm-call:formalize-2)");
    expect(callsTo("/api/problem-drafts/validate")[0]?.body.draft).toMatchObject({
      declarations: DRAFT.declarations,
      hypotheses: DRAFT.hypotheses,
      goals: DRAFT.goals,
    });
    expect(callsTo("/api/problem-drafts/validate")[0]?.body).not.toHaveProperty(
      "approvedBackground",
    );
    expect(callsTo("/api/proof-sessions")).toHaveLength(0);
  });

  it("shows why a draft needs review, including an unapproved constant, and still lets the user load it", async () => {
    answers.set("/api/ai/formalize", () =>
      Response.json(
        {
          ok: false,
          error: { code: "unapproved-constant", message: "Goal 1 applies the operator Gcd." },
          details: {
            status: "needs-review",
            callId: "llm-call:formalize-2",
            draft: { ...DRAFT, goals: [{ format: "latex", latex: "r" }] },
            diagnostics: [
              {
                code: "unapproved-constant",
                message: "Goal 1 applies the operator Gcd, which is not an approved constant.",
                path: ["goals", 0, "latex"],
              },
            ],
          },
        },
        { status: 422 },
      ),
    );
    renderForm();
    fillStatement();
    const card = await propose();
    fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
    // A draft that fails the check is shown, not loaded or checked.
    const drafted = await screen.findByLabelText("Drafted setup");
    expect(drafted).toHaveTextContent("which is not an approved constant");
    expect(screen.getByLabelText("Goal 1")).toHaveValue("");
    expect(callsTo("/api/problem-drafts/validate")).toHaveLength(0);
    const hand = screen.getByText("Edit the background and setup by hand").closest("details");
    expect(hand).not.toHaveAttribute("open");
    fireEvent.click(within(drafted).getByRole("button", { name: /Replace my variables/ }));
    expect(screen.getByLabelText("Goal 1")).toHaveValue("r");
    // Loaded to be fixed by hand, so the hand-entry fields open.
    expect(hand).toHaveAttribute("open");
    expect(callsTo("/api/problem-drafts/validate")).toHaveLength(0);
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
  ])("explains a %s answer to a proposal", async (status, error, text) => {
    answers.set("/api/ai/background", () =>
      Response.json({ ok: false, error, details: { diagnostics: [error] } }, { status }),
    );
    renderForm();
    fillStatement();
    fireEvent.click(button("Suggest background"));
    expect(await within(section()).findByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByRole("group", { name: "Proposed background" })).toBeNull();
  });

  it("relays a model request for more detail without a proposal", async () => {
    answers.set("/api/ai/background", (body) =>
      Response.json({
        ok: true,
        data: {
          status: "insufficient-context",
          callId: body.id,
          replayed: false,
          result: {
            kind: "insufficient-context",
            requestedCategories: ["problem-detail"],
            rationale: "Which integers are meant?",
          },
        },
      }),
    );
    renderForm();
    fillStatement();
    fireEvent.click(button("Suggest background"));
    expect(await within(section()).findByRole("alert")).toHaveTextContent(
      "The model asked for more detail (problem-detail): Which integers are meant?",
    );
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

  it("rejects a malformed proposal from the proof service", async () => {
    answers.set("/api/ai/background", (body) =>
      Response.json({
        ok: true,
        data: {
          status: "proposed",
          callId: body.id,
          proposal: { ...proposal(), constants: [{ operator: { id: "x" }, rationale: "r" }] },
        },
      }),
    );
    renderForm();
    fillStatement();
    fireEvent.click(button("Suggest background"));
    expect(await within(section()).findByRole("alert")).toHaveTextContent(
      "The proof service returned an invalid response.",
    );
  });
});
