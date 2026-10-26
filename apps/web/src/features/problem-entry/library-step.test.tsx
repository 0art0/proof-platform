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

// Build library (docs/ai-agents-architecture.md section 2) in the new-problem form. The model
// roles are stubbed at the web application's relay routes.

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

const BACKGROUND_PROPOSAL = {
  kind: "background-proposal",
  background: {
    level: "first-year undergraduate",
    summary: "Elementary number theory.",
    assumptions: [],
    domains: ["number theory"],
    maximumLevel: "undergraduate",
  },
  constants: [{ operator: COPRIME, rationale: "The goal says two integers are coprime." }],
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

const SYMMETRY_ID = "result:library-coprime-symmetry";
const CANCEL_ID = "result:library-coprime-cancellation";
const SYMMETRY = ["Equivalent", ["Coprime", "a", "b"], ["Coprime", "b", "a"]];

function review(withLibrary: boolean) {
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
    operators: [COPRIME],
    metadata: {
      problem: DRAFT.problem,
      background: DRAFT.background,
      libraryLayerIds: DRAFT.libraryLayerIds,
    },
    activePackIds: ["pack:elementary-logic"],
    ...(withLibrary
      ? {
          initialLibrary: {
            results: [
              {
                id: SYMMETRY_ID,
                name: "Symmetry of coprimality",
                description: "Symmetry of coprimality holds in general.",
                statement: SYMMETRY,
                premises: [],
              },
              {
                id: CANCEL_ID,
                name: "Cancelling a coprime factor",
                description: "Cancelling a coprime factor holds in general.",
                statement: ["Coprime", "a", "b"],
                premises: [["Coprime", "b", "a"]],
              },
            ],
            variantCount: 3,
            addedOperatorSymbols: [],
          },
        }
      : {}),
    digest: `sha256:${"c".repeat(64)}`,
  };
}

function libraryResult(
  id: string,
  name: string,
  overrides: { premises?: unknown[]; variants?: number; symbols?: string[] } = {},
) {
  return {
    artifact: {
      id,
      name,
      description: `${name} holds in general.`,
      statement: { expression: SYMMETRY },
      premises: (overrides.premises ?? []).map((expression) => ({ expression })),
      renderings: { latex: "worker latex", naturalLanguage: "worker prose" },
    },
    variants: Array.from({ length: overrides.variants ?? 1 }, (_, index) => ({
      id: `${id}/variant-${index}`,
    })),
    newConstantSymbols: overrides.symbols ?? [],
  };
}

function libraryAnswer(body: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return Response.json({
    ok: true,
    data: {
      status: "proposed",
      callId: body.id,
      replayed: false,
      requestKind: "initial",
      results: [
        libraryResult(SYMMETRY_ID, "Symmetry of coprimality"),
        libraryResult(CANCEL_ID, "Cancelling a coprime factor", {
          premises: [["Coprime", "b", "a"]],
          variants: 2,
        }),
      ],
      rejected: [
        {
          id: "result:library-uses-gcd",
          name: "Gcd of a pair",
          reasons: ["The statement uses Gcd, which is not an available operator."],
          codes: ["invalid-artifact"],
        },
      ],
      newConstants: [],
      rejectedConstants: [],
      ...overrides,
    },
  });
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
            proposal: BACKGROUND_PROPOSAL,
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
    ["/api/ai/library", libraryAnswer],
    [
      "/api/ai/library/decisions",
      () =>
        Response.json(
          {
            ok: true,
            data: { status: "recorded", replayed: false, approvedLibrary: { variantCount: 3 } },
          },
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
      (body) =>
        Response.json({
          ok: true,
          data: { ok: true, review: review(body.approvedLibrary !== undefined) },
        }),
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
  navigate: (url: string) => void = vi.fn(),
) {
  let ids = 0;
  render(
    <ProblemEntryForm
      options={options}
      navigate={navigate}
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
  change("Problem statement", "Show that consecutive integers are coprime.");
  change("Assumed level", "school");
  change("What the reader is expected to know", "Logic.");
}

const section = () => screen.getByRole("region", { name: "Background and setup" });
const button = (name: string) => within(section()).getByRole("button", { name });
const callsTo = (url: string) => calls.filter((call) => call.url === url);

/** The statements that "Check setup" needs besides the problem. */
function fillStatements() {
  change("Variable or object 1", "p");
  change("Goal 1", "p");
}

/**
 * Propose a background and accept it, as the first step to a library. Accepting drafts the setup
 * and checks it (llm-call:formalize-4), so this waits for that review.
 */
async function acceptBackground() {
  fillProblem();
  fireEvent.click(button("Suggest background"));
  const card = await screen.findByRole("group", { name: "Proposed background" });
  fireEvent.click(within(card).getByRole("button", { name: "Accept" }));
  await within(card).findByRole("button", { name: "Accepted" });
  await screen.findByRole("region", { name: "Review" });
}

async function build() {
  fireEvent.click(button("Build library"));
  return screen.findByRole("group", { name: "Proposed library" });
}

describe("Build library", () => {
  it("waits for an accepted background and says so, then offers to build", async () => {
    renderForm();
    fillProblem();
    expect(button("Build library")).toBeDisabled();
    expect(section()).toHaveTextContent("Accept a background first");
    await acceptBackground();
    expect(button("Build library")).toBeEnabled();
    expect(section()).not.toHaveTextContent("Accept a background first");
  });

  it("is disabled with an explanation when the role is not configured", async () => {
    renderForm({ background: true, library: false, formalizer: true });
    await acceptBackground();
    expect(button("Build library")).toBeDisabled();
    expect(button("Build library").parentElement).toHaveTextContent("Not configured.");
  });

  it("builds from the accepted background by decision, without the problem", async () => {
    renderForm();
    await acceptBackground();
    const card = await build();
    const [request] = callsTo("/api/ai/library");
    expect(request!.body).toEqual({
      constructionId: "construction:web-1",
      id: "llm-call:library-5",
      approvedBackground: { decisionId: "background-decision-3" },
      packs: [],
    });
    expect(JSON.stringify(request!.body)).not.toContain("consecutive");

    expect(card).toHaveTextContent("Proposed by AI. Nothing is added until you approve");
    expect(card).toHaveTextContent("2 of 2 results kept, plus 3 generated variants");
    const items = within(card).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // The statement is rendered in LaTeX and in words, and premises are listed separately.
    expect(items[0]).toHaveTextContent("Symmetry of coprimality");
    expect(items[0]).toHaveTextContent(String.raw`a\perp b`);
    expect(items[0]).toHaveTextContent("$a$ and $b$ are coprime");
    expect(items[0]).toHaveTextContent("Symmetry of coprimality holds in general.");
    expect(items[1]).toHaveTextContent("Assuming:");
    expect(items[1]).toHaveTextContent(String.raw`b\perp a`);
    // Items that did not pass are collapsed with plain reasons.
    const summary = within(card).getByText("1 proposed result did not pass checks");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(summary.closest("details")).toHaveTextContent("Gcd of a pair");
    expect(summary.closest("details")).toHaveTextContent("which is not an available operator");
    expect(callsTo("/api/ai/library/decisions")).toHaveLength(0);
  });

  it("removes and restores results, counting what is kept", async () => {
    renderForm();
    await acceptBackground();
    const card = await build();
    fireEvent.click(
      within(card).getByRole("button", { name: "Remove Cancelling a coprime factor" }),
    );
    expect(card).toHaveTextContent("1 of 2 results kept, plus 1 generated variant");
    expect(card).toHaveTextContent("Removed: it will not be added.");
    fireEvent.click(
      within(card).getByRole("button", { name: "Restore Cancelling a coprime factor" }),
    );
    expect(card).toHaveTextContent("2 of 2 results kept, plus 3 generated variants");
    expect(card).not.toHaveTextContent("Removed: it will not be added.");

    // Keeping nothing cannot be approved, and the control says why.
    fireEvent.click(within(card).getByRole("button", { name: "Remove Symmetry of coprimality" }));
    fireEvent.click(
      within(card).getByRole("button", { name: "Remove Cancelling a coprime factor" }),
    );
    expect(within(card).getByRole("button", { name: "Approve library" })).toBeDisabled();
    expect(card).toHaveTextContent("Keep at least one result to approve a library.");
  });

  it("approves the kept results by ID only and reports the approved library", async () => {
    renderForm();
    await acceptBackground();
    const card = await build();
    fireEvent.click(
      within(card).getByRole("button", { name: "Remove Cancelling a coprime factor" }),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Approve library" }));
    await within(card).findByRole("button", { name: "Approved" });

    const [decision] = callsTo("/api/ai/library/decisions");
    expect(Object.keys(decision!.body).sort()).toEqual([
      "approvedResultIds",
      "callId",
      "constructionId",
      "decidedAt",
      "decisionId",
    ]);
    expect(decision!.body).toMatchObject({
      constructionId: "construction:web-1",
      callId: "llm-call:library-5",
      decisionId: "library-decision-6",
      approvedResultIds: [SYMMETRY_ID],
    });
    expect(decision!.body.decidedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(JSON.stringify(decision!.body)).not.toContain("Equivalent");
    expect(card).toHaveTextContent("Proposed by AI and approved by you.");
    expect(card).toHaveTextContent("Approved: 1 result and 3 variants will be added");
  });

  it("retries a failed recording with the same decision, and a refusal changes nothing", async () => {
    let failures = 1;
    const recorded = answers.get("/api/ai/library/decisions")!;
    answers.set("/api/ai/library/decisions", (body) =>
      failures-- > 0
        ? Response.json(
            { ok: false, error: { code: "service_unavailable", message: "Unavailable." } },
            { status: 503 },
          )
        : recorded(body),
    );
    renderForm();
    await acceptBackground();
    const card = await build();
    fireEvent.click(within(card).getByRole("button", { name: "Approve library" }));
    await within(card).findByText(/Your approval was not recorded/);
    expect(within(card).getByRole("button", { name: "Approve library" })).toBeEnabled();
    fireEvent.click(within(card).getByRole("button", { name: "Approve library" }));
    await within(card).findByRole("button", { name: "Approved" });
    const [first, second] = callsTo("/api/ai/library/decisions");
    expect(second!.body).toEqual(first!.body);

    cleanup();
    answers.set("/api/ai/library/decisions", () =>
      Response.json(
        {
          ok: false,
          error: { code: "result-not-admitted", message: "A result was not admitted." },
          details: { diagnostics: [{ code: "result-not-admitted", message: "Not admitted." }] },
        },
        { status: 409 },
      ),
    );
    renderForm();
    await acceptBackground();
    const again = await build();
    fireEvent.click(within(again).getByRole("button", { name: "Approve library" }));
    expect(await within(again).findByRole("alert")).toHaveTextContent(
      "This selection cannot be approved: A result was not admitted.",
    );
    expect(within(again).getByRole("button", { name: "Approve library" })).toBeEnabled();
  });

  it("sends the approved library as a reference to the formalizer, Check setup and Start exploring", async () => {
    const navigate = vi.fn();
    renderForm(undefined, navigate);
    await acceptBackground();
    const proposed = await build();
    fireEvent.click(within(proposed).getByRole("button", { name: "Approve library" }));
    await within(proposed).findByRole("button", { name: "Approved" });
    const reference = { constructionId: "construction:web-1", decisionId: "library-decision-6" };

    // Approving a library dated the draft made on acceptance; drafting again loads and checks it.
    expect(section()).toHaveTextContent("since the setup was drafted");
    fireEvent.click(button("Draft the setup again"));
    const reviewed = await screen.findByRole("region", { name: "Review" });
    expect(callsTo("/api/ai/formalize")[0]!.body).not.toHaveProperty("approvedLibrary");
    expect(callsTo("/api/ai/formalize")[1]!.body).toMatchObject({
      approvedBackground: { decisionId: "background-decision-3" },
      approvedLibrary: { decisionId: "library-decision-6" },
    });
    const validate = callsTo("/api/problem-drafts/validate")[1];
    expect(validate!.body).toMatchObject({
      approvedBackground: { constructionId: "construction:web-1" },
      approvedLibrary: reference,
    });
    expect(JSON.stringify(validate!.body)).not.toContain("Equivalent");

    // The review shows the approved results, rendered, with what comes with them.
    expect(reviewed).toHaveTextContent("Initial library");
    expect(reviewed).toHaveTextContent("Symmetry of coprimality");
    expect(reviewed).toHaveTextContent("Cancelling a coprime factor");
    expect(reviewed).toHaveTextContent(String.raw`a\perp b`);
    expect(reviewed).toHaveTextContent("Plus 3 generated variants of these results.");

    fireEvent.click(within(reviewed).getByRole("button", { name: "Start exploring" }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    const [approval] = callsTo("/api/proof-sessions");
    expect(approval!.body).toMatchObject({
      sessionId: "session:test",
      reviewedDigest: `sha256:${"c".repeat(64)}`,
      approvedBackground: { constructionId: "construction:web-1" },
      approvedLibrary: reference,
    });
    expect(Object.keys(approval!.body).sort()).toEqual([
      "approvedBackground",
      "approvedLibrary",
      "draft",
      "reviewedDigest",
      "sessionId",
    ]);
  });

  it("asks to approve again after the selection changes, and a review made earlier is discarded", async () => {
    renderForm();
    await acceptBackground();
    fillStatements();
    const card = await build();
    fireEvent.click(within(card).getByRole("button", { name: "Approve library" }));
    await within(card).findByRole("button", { name: "Approved" });
    fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    await screen.findByRole("region", { name: "Review" });

    fireEvent.click(
      within(card).getByRole("button", { name: "Remove Cancelling a coprime factor" }),
    );
    expect(within(card).getByRole("button", { name: "Approve library" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Review" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    await screen.findByRole("region", { name: "Review" });
    expect(callsTo("/api/problem-drafts/validate")[1]!.body).toHaveProperty("approvedLibrary");
    expect(callsTo("/api/problem-drafts/validate")[2]!.body).not.toHaveProperty("approvedLibrary");
  });

  it("drops the approved library when the accepted background is forgotten", async () => {
    renderForm();
    await acceptBackground();
    fillStatements();
    const card = await build();
    fireEvent.click(within(card).getByRole("button", { name: "Approve library" }));
    await within(card).findByRole("button", { name: "Approved" });
    fireEvent.click(screen.getByRole("button", { name: "Stop using these constants" }));
    expect(button("Build library")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    await screen.findByRole("region", { name: "Review" });
    const validate = callsTo("/api/problem-drafts/validate").at(-1);
    expect(validate!.body).not.toHaveProperty("approvedLibrary");
    expect(validate!.body).not.toHaveProperty("approvedBackground");
  });

  it("building again replaces an approved library until the new one is approved", async () => {
    renderForm();
    await acceptBackground();
    const card = await build();
    fireEvent.click(within(card).getByRole("button", { name: "Approve library" }));
    await within(card).findByRole("button", { name: "Approved" });
    expect(section()).toHaveTextContent("Building again replaces the approved library");
    fireEvent.click(button("Build library"));
    await vi.waitFor(() => expect(callsTo("/api/ai/library")).toHaveLength(2));
    const fresh = screen.getByRole("group", { name: "Proposed library" });
    await within(fresh).findByRole("button", { name: "Approve library" });
    expect(within(fresh).getByRole("button", { name: "Approve library" })).toBeEnabled();
  });

  it("explains an answer with no admitted result, a rate limit, a refusal and a bad response", async () => {
    renderForm();
    await acceptBackground();
    answers.set("/api/ai/library", (body) =>
      libraryAnswer(body, {
        results: [],
        rejected: [{ id: "result:library-x", name: "X", reasons: ["It is not a proposition."] }],
      }),
    );
    const none = await build();
    expect(none).toHaveTextContent("None of the proposed results passed the checks.");
    expect(within(none).getByRole("button", { name: "Approve library" })).toBeDisabled();

    answers.set("/api/ai/library", () =>
      Response.json(
        {
          ok: false,
          error: { code: "ai-rate-limited", message: "The AI request budget is exhausted." },
          details: { diagnostics: [] },
        },
        { status: 429 },
      ),
    );
    fireEvent.click(button("Build library"));
    expect(await within(section()).findByRole("alert")).toHaveTextContent(
      "Too many AI requests right now",
    );

    answers.set("/api/ai/library", (body) =>
      Response.json({
        ok: true,
        data: {
          status: "declined",
          callId: body.id,
          replayed: false,
          result: { kind: "declined", reason: "Everything is in the library already." },
        },
      }),
    );
    fireEvent.click(button("Build library"));
    await vi.waitFor(() =>
      expect(within(section()).getByRole("alert")).toHaveTextContent(
        "The library builder declined: Everything is in the library already.",
      ),
    );

    answers.set("/api/ai/library", (body) =>
      Response.json({ ok: true, data: { status: "proposed", callId: body.id, results: "many" } }),
    );
    fireEvent.click(button("Build library"));
    await vi.waitFor(() =>
      expect(within(section()).getByRole("alert")).toHaveTextContent(
        "The proof service returned an invalid response.",
      ),
    );
  });

  it("lists the notation that kept results add, and only for kept results", async () => {
    const gcd = {
      ...COPRIME,
      id: "operator:gcd",
      symbol: "Gcd",
      signature: { parameters: [INTEGER, INTEGER], result: INTEGER },
      presentation: {
        displayName: "gcd",
        latex: { template: String.raw`\gcd(#1, #2)`, precedence: "atom" },
        naturalLanguage: [{ template: "the gcd of #1 and #2" }],
      },
    };
    answers.set("/api/ai/library", (body) =>
      libraryAnswer(body, {
        results: [
          libraryResult("result:library-gcd", "Gcd is symmetric", { symbols: ["Gcd"] }),
          libraryResult(SYMMETRY_ID, "Symmetry of coprimality"),
        ],
        newConstants: [{ operator: gcd, rationale: "Results are stated with the gcd." }],
      }),
    );
    renderForm();
    await acceptBackground();
    const card = await build();
    expect(card).toHaveTextContent("The kept results add notation to the setup:");
    expect(card).toHaveTextContent("Uses new notation: Gcd.");
    fireEvent.click(within(card).getByRole("button", { name: "Remove Gcd is symmetric" }));
    expect(card).not.toHaveTextContent("The kept results add notation to the setup:");
  });
});
