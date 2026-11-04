// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROBLEM_SETUP_LAYER_CHOICES,
  PROBLEM_SETUP_SORT_CHOICES,
  createProofNodeSchema,
  problemDraftSchema,
  type ProblemSetupOptions,
} from "@proof/protocol";
import { GuidedProblemEntry } from "./guided-entry";

// The typesetter's check, deterministic here: \Cop is the one command it does not know.
vi.mock("mathlive", () => ({
  validateLatex: (latex: string) =>
    /\\Cop\b/.test(latex) ? [{ code: "unknown-command", arg: "\\Cop" }] : [],
}));

const INTEGER = { kind: "named", id: "sort:integer" };
const COPRIME = {
  id: "operator:coprime",
  symbol: "Coprime",
  signature: { parameters: [INTEGER, INTEGER], result: { kind: "proposition" } },
  presentation: {
    displayName: "coprime",
    latex: {
      template: "#1 \\perp #2",
      precedence: "relation",
      parse: { trigger: "\\perp", notation: "infix" },
    },
    naturalLanguage: [{ template: "#1 and #2 are coprime" }],
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
  ],
} as ProblemSetupOptions;

const STATEMENT = "Show that consecutive integers are coprime.";
const PROPOSAL = {
  kind: "background-proposal",
  background: { level: "school", summary: "Integers.", assumptions: ["Divisibility"] },
  constants: [{ operator: COPRIME, rationale: "The goal uses it." }],
};
const result = (id: string, name: string, statement: unknown) => ({
  artifact: {
    id,
    name,
    description: `${name}.`,
    statement: { expression: statement },
    premises: [],
    renderings: { latex: "worker rendering", naturalLanguage: "worker rendering" },
  },
  variants: [],
  newConstantSymbols: [],
});
const SYMMETRY = result("result:library-symmetry", "Symmetry", [
  "Equivalent",
  ["Coprime", "a", "b"],
  ["Coprime", "b", "a"],
]);
const REFLEXIVE = result("result:library-equal", "Reflexivity", ["Equal", "a", "a"]);

const DRAFT = problemDraftSchema.parse({
  problem: { title: "Consecutive", statement: STATEMENT },
  background: { level: "school", summary: "Integers.", assumptions: ["Divisibility"] },
  libraryLayerIds: ["layer:global", "layer:initial-problem"],
  packs: [],
  declarations: [{ symbol: "n", sort: "integer" }],
  hypotheses: [],
  goals: [{ format: "latex", latex: "n \\perp n" }],
});

const REVIEW = {
  rootNode: createProofNodeSchema().parse({
    id: "node:root",
    state: {
      id: "state:root",
      goals: [
        {
          id: "goal:1",
          sequent: {
            context: {
              declarations: [
                { id: "declaration:n", symbol: "n", sort: INTEGER, role: "universal-parameter" },
              ],
              hypotheses: [],
            },
            conclusion: { expression: ["Equal", "n", "n"] },
          },
        },
      ],
      obligations: [],
    },
  }),
  operators: [],
  metadata: {
    problem: { title: "Consecutive", statement: STATEMENT },
    background: { level: "school", summary: "Integers.", assumptions: [] },
    libraryLayerIds: ["layer:global", "layer:initial-problem"],
  },
  activePackIds: ["pack:elementary-logic"],
  digest: `sha256:${"c".repeat(64)}`,
};

type Call = Readonly<{ url: string; body: Record<string, unknown> }>;
let calls: Call[];
let answers: Map<string, Array<() => Response>>;

const ok =
  (data: unknown, status = 200) =>
  () =>
    Response.json({ ok: true, data }, { status });

beforeEach(() => {
  calls = [];
  answers = new Map([
    [
      "/api/ai/background",
      [ok({ status: "proposed", callId: "llm-call:background-1", proposal: PROPOSAL })],
    ],
    [
      "/api/ai/library",
      [
        ok({
          status: "proposed",
          callId: "llm-call:library-1",
          results: [SYMMETRY, REFLEXIVE],
          newConstants: [],
        }),
      ],
    ],
    ["/api/ai/background/decisions", [ok({ status: "recorded", decision: {} }, 201)]],
    [
      "/api/ai/library/decisions",
      [ok({ status: "recorded", approvedLibrary: { variantCount: 1 } }, 201)],
    ],
    [
      "/api/ai/formalize",
      [ok({ status: "ready-for-review", callId: "llm-call:formalize-1", draft: DRAFT })],
    ],
    ["/api/problem-drafts/validate", [ok({ ok: true, review: REVIEW })]],
    ["/api/proof-sessions", [ok({ replayed: false }, 201)]],
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const queue = answers.get(url);
      const answer = queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0];
      if (answer === undefined) throw new Error(`Unexpected request to ${url}`);
      return answer();
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const callsTo = (url: string) => calls.filter((call) => call.url === url);

function renderEntry(props: Partial<Parameters<typeof GuidedProblemEntry>[0]> = {}) {
  const navigate = vi.fn();
  let ids = 0;
  render(
    <GuidedProblemEntry
      options={options}
      capabilities={{ library: true, formalizer: true }}
      prompts={{ background: "You propose a background.", library: "You build a library." }}
      initialStatement={STATEMENT}
      navigate={navigate}
      createId={(prefix) => `${prefix}-${(ids += 1)}`}
      createSessionId={() => "session:test-1"}
      {...props}
    />,
  );
  return navigate;
}

async function ready() {
  await screen.findByDisplayValue("school");
  await screen.findByText("Symmetry");
}

describe("GuidedProblemEntry", () => {
  it("asks for the background at once and builds the library from the proposal", async () => {
    renderEntry();
    await ready();
    expect(callsTo("/api/ai/background")[0]?.body).toMatchObject({
      problem: { statement: STATEMENT },
    });
    const library = callsTo("/api/ai/library")[0]?.body;
    expect(library).toMatchObject({
      backgroundProposal: { callId: "llm-call:background-1" },
      packs: [],
    });
    expect(library).not.toHaveProperty("approvedBackground");
    // The barrier holds: the library request carries no problem.
    expect(JSON.stringify(library)).not.toContain(STATEMENT);
    expect(screen.getByDisplayValue("Integers.")).toBeVisible();
    expect(screen.getByDisplayValue("Divisibility")).toBeVisible();
    expect(screen.getByLabelText("LaTeX of Coprime")).toHaveValue("#1 \\perp #2");
    expect(screen.getByText("2 of 2")).toBeVisible();
  });

  it("asks once more, quietly, when an answer did not pass validation", async () => {
    answers.set("/api/ai/background", [
      () =>
        Response.json(
          { ok: false, error: { code: "invalid-output", message: "Invalid." } },
          { status: 422 },
        ),
      ok({ status: "proposed", callId: "llm-call:background-2", proposal: PROPOSAL }),
    ]);
    renderEntry();
    await ready();
    expect(callsTo("/api/ai/background")).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the library in the edited notation and flags LaTeX the typesetter does not know", async () => {
    renderEntry();
    await ready();
    const symmetry = screen.getByText("Symmetry").closest("li")!;
    expect(symmetry).toHaveTextContent("\\perp");
    fireEvent.change(screen.getByLabelText("LaTeX of Coprime"), {
      target: { value: "\\operatorname{cop}\\left(#1, #2\\right)" },
    });
    expect(symmetry).toHaveTextContent("\\operatorname{cop}");
    expect(symmetry).not.toHaveTextContent("\\perp");

    fireEvent.change(screen.getByLabelText("LaTeX of Coprime"), {
      target: { value: "\\Cop(#1, #2)" },
    });
    expect(await screen.findByText(/\\Cop is not standard LaTeX/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Start proof" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("LaTeX of Coprime"), {
      target: { value: "\\operatorname{cop}(#1)" },
    });
    expect(screen.getByText("Show #2.")).toBeVisible();
  });

  it("starts the proof: approves with the edits, keeps the ticked results, drafts, checks, opens", async () => {
    const navigate = renderEntry();
    await ready();
    fireEvent.change(screen.getByDisplayValue("school"), {
      target: { value: "first-year undergraduate" },
    });
    fireEvent.change(screen.getByLabelText("LaTeX of Coprime"), {
      target: { value: "\\operatorname{cop}\\left(#1, #2\\right)" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Reflexivity/ }));
    expect(screen.getByText("1 of 2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start proof" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/sessions/session%3Atest-1"));
    const [decision] = callsTo("/api/ai/background/decisions");
    expect(decision?.body).toMatchObject({
      callId: "llm-call:background-1",
      decision: "approved",
      amendment: {
        background: { level: "first-year undergraduate", summary: "Integers." },
        constants: [
          {
            id: "operator:coprime",
            symbol: "Coprime",
            presentation: {
              latex: {
                template: "\\operatorname{cop}\\left(#1, #2\\right)",
                parse: { trigger: "\\operatorname{cop}", notation: "function" },
              },
            },
          },
        ],
      },
    });
    const decisionId = decision?.body.decisionId;
    const [library] = callsTo("/api/ai/library/decisions");
    expect(library?.body).toMatchObject({
      callId: "llm-call:library-1",
      approvedResultIds: ["result:library-symmetry"],
    });
    const libraryId = library?.body.decisionId;
    expect(callsTo("/api/ai/formalize")[0]?.body).toMatchObject({
      approvedBackground: { decisionId },
      approvedLibrary: { decisionId: libraryId },
      background: { level: "first-year undergraduate" },
      packs: [],
    });
    const references = {
      approvedBackground: { decisionId },
      approvedLibrary: { decisionId: libraryId },
    };
    expect(callsTo("/api/problem-drafts/validate")[0]?.body).toMatchObject(references);
    expect(callsTo("/api/proof-sessions")[0]?.body).toMatchObject({
      sessionId: "session:test-1",
      reviewedDigest: REVIEW.digest,
      ...references,
    });
  });

  it("approves without edits when nothing changed", async () => {
    renderEntry();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Start proof" }));
    await waitFor(() => expect(callsTo("/api/proof-sessions")).toHaveLength(1));
    expect(callsTo("/api/ai/background/decisions")[0]?.body).not.toHaveProperty("amendment");
  });

  it("drops the results that apply a removed constant", async () => {
    renderEntry();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Remove coprime" }));
    const symmetry = screen.getByRole("checkbox", { name: /Symmetry/ });
    expect(symmetry).toBeDisabled();
    expect(symmetry).not.toBeChecked();
    expect(screen.getByText("Uses removed notation")).toBeVisible();
    expect(screen.getByText("1 of 2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start proof" }));
    await waitFor(() => expect(callsTo("/api/proof-sessions")).toHaveLength(1));
    expect(callsTo("/api/ai/background/decisions")[0]?.body).toMatchObject({
      amendment: { constants: [] },
    });
    expect(callsTo("/api/ai/library/decisions")[0]?.body).toMatchObject({
      approvedResultIds: ["result:library-equal"],
    });
  });

  it("starts without a library when the librarian asks for more detail", async () => {
    answers.set("/api/ai/library", [
      ok({
        status: "insufficient-context",
        result: {
          kind: "insufficient-context",
          requestedCategories: ["constant-detail"],
          rationale: "The constants are too thin.",
        },
      }),
    ]);
    const navigate = renderEntry();
    await screen.findByDisplayValue("school");
    expect(
      await screen.findByText(/No library this time: The constants are too thin/),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start proof" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(callsTo("/api/ai/library/decisions")).toHaveLength(0);
    expect(callsTo("/api/ai/formalize")[0]?.body).not.toHaveProperty("approvedLibrary");
  });

  it("flags notation that would be typed as something else", async () => {
    renderEntry();
    await ready();
    fireEvent.change(screen.getByLabelText("LaTeX of Coprime"), {
      target: { value: "\\operatorname{D}\\left(#1, #2\\right)" },
    });
    expect(screen.getByText(/would read as something else/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Start proof" })).toBeDisabled();
  });

  it("hands a drafted setup that needs a fix to the hand-entry form, approvals kept", async () => {
    answers.set("/api/ai/formalize", [
      () =>
        Response.json(
          {
            ok: false,
            error: { code: "needs-review", message: "The draft needs review." },
            details: {
              status: "needs-review",
              callId: "llm-call:formalize-1",
              draft: DRAFT,
              diagnostics: [{ code: "unknown-symbol", message: "m is not declared." }],
            },
          },
          { status: 422 },
        ),
    ]);
    const navigate = renderEntry();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Start proof" }));
    expect(await screen.findByText(/needs a look: m is not declared/)).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Assumed level")).toHaveValue("school");
    expect(screen.getByLabelText("Variable or object 1")).toHaveValue("n");
    fireEvent.click(screen.getByRole("button", { name: "Check setup" }));
    await waitFor(() => expect(callsTo("/api/problem-drafts/validate")).toHaveLength(1));
    // The hand-entry form checks the setup against the approvals the guided entry recorded.
    expect(callsTo("/api/problem-drafts/validate")[0]?.body).toMatchObject({
      approvedBackground: {
        decisionId: callsTo("/api/ai/background/decisions")[0]?.body.decisionId,
      },
      approvedLibrary: { decisionId: callsTo("/api/ai/library/decisions")[0]?.body.decisionId },
    });
  });

  it("waits for the statement to be decided when it opens without one", async () => {
    renderEntry({ initialStatement: "" });
    expect(calls).toHaveLength(0);
    const next = screen.getByRole("button", { name: "Continue" });
    expect(next).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: STATEMENT },
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Add title" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Neighbours" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await ready();
    expect(callsTo("/api/ai/background")[0]?.body).toMatchObject({
      problem: { title: "Neighbours", statement: STATEMENT },
    });
    // Changing the statement afterwards offers to ask again, and holds the start until then.
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: `${STATEMENT} Prove it.` },
    });
    expect(screen.getByRole("button", { name: "Suggest again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start proof" })).toBeDisabled();
  });

  it("shows what each model is told behind an ⓘ", async () => {
    renderEntry();
    await ready();
    const background = screen.getByRole("region", { name: "Background" });
    const tip = within(background).getByRole("button", {
      name: "What the model is told: Background proposer",
    });
    fireEvent.click(tip);
    expect(within(background).getByRole("tooltip")).toHaveTextContent("You propose a background.");
    expect(
      within(screen.getByRole("region", { name: "Library" })).getByRole("tooltip"),
    ).toHaveTextContent("You build a library.");
  });
});
