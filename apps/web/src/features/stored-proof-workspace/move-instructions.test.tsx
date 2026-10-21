// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresentation } from "@proof/language";
import { createProofNodeSchema, type ProofNode } from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import { MoveInstructions, MOVE_INSTRUCTIONS_PLACEHOLDER } from "./move-instructions";
import { READ_ONLY_REASON } from "./toolbar-actions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const declaration = {
  id: "declaration:p",
  symbol: "p",
  sort: { kind: "proposition" },
  role: "universal-parameter",
};

function stateWith(id: string, goals: readonly unknown[]) {
  return { id, goals, obligations: [] };
}

const mainGoal = {
  id: "goal:main",
  sequent: {
    context: { declarations: [declaration], hypotheses: [] },
    conclusion: { expression: ["Implies", "p", "p"] },
  },
};
const otherGoal = {
  id: "goal:other",
  sequent: {
    context: { declarations: [declaration], hypotheses: [] },
    conclusion: { expression: "p" },
  },
};

function node(id = "node:one", goals: readonly unknown[] = [mainGoal]): ProofNode {
  return createProofNodeSchema().parse({ id, state: stateWith(`state:${id}`, goals) });
}

const selectionOf = (goal: string, stateId = "state:node:one"): AnchoredProofSelection =>
  ({
    kind: "exact",
    anchor: {
      stateId,
      target: { kind: "goal", id: goal },
      statement: { kind: "conclusion" },
    },
    path: [],
  }) as unknown as AnchoredProofSelection;

const PROVENANCE = { kind: "user-proposal", role: "move-executor" };

function previewedAnswer(overrides: Record<string, unknown> = {}) {
  const before = stateWith("state:node:one", [mainGoal]);
  return {
    ok: true,
    data: {
      status: "previewed",
      provenance: PROVENANCE,
      callId: "llm-call:execute-test",
      replayed: false,
      nodeId: "node:one",
      explanation: "Assume p, then it is exactly the hypothesis.",
      transitionClass: "equivalence",
      evidence: "structural",
      steps: [
        {
          index: 1,
          operation: { kind: "introduce-implication" },
          transitionClass: "equivalence",
          evidence: "structural",
        },
        {
          index: 2,
          operation: { kind: "close-by-hypothesis" },
          transitionClass: "equivalence",
          evidence: "structural",
        },
      ],
      preview: {
        transitionClass: "equivalence",
        evidence: "structural",
        beforeState: before,
        afterState: stateWith("state:after", []),
        delta: {
          goals: { added: [], removed: ["goal:main"], updated: [] },
          obligations: { added: [], removed: [], updated: [] },
        },
      },
      diagnostics: [],
      ...overrides,
    },
  };
}

function stubFetch(...answers: readonly (readonly [number, unknown])[]) {
  const queue = [...answers];
  const fetchMock = vi.fn(async () => {
    const [status, body] = queue.shift() ?? [
      500,
      { ok: false, error: { code: "x", message: "?" } },
    ];
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type Props = Partial<Parameters<typeof MoveInstructions>[0]>;

function renderPanel(props: Props = {}) {
  const onApplyStart = vi.fn(() => true);
  const onApplyEnd = vi.fn();
  const onApplied = vi.fn(async () => undefined);
  const merged = {
    sessionId: "session:a",
    node: node(),
    operators: [],
    selections: [],
    presentation: createPresentation({ operators: [] }),
    view: "formal" as const,
    enabled: true,
    readOnly: false,
    busy: false,
    onApplyStart,
    onApplyEnd,
    onApplied,
    createId: (prefix: string) => `${prefix}-test`,
    ...props,
  };
  const view = render(<MoveInstructions {...merged} />);
  return {
    ...view,
    rerenderWith: (next: Props) => view.rerender(<MoveInstructions {...merged} {...next} />),
    onApplyStart: merged.onApplyStart,
    onApplyEnd: merged.onApplyEnd,
    onApplied: merged.onApplied,
  };
}

const box = () => screen.getByRole("textbox", { name: "Describe a step" });
const previewButton = () => screen.getByRole("button", { name: /^(Preview|Asking the model)/ });

function describeStep(text = "assume p and finish") {
  fireEvent.change(box(), { target: { value: text } });
}

async function preview(text?: string) {
  describeStep(text);
  await act(async () => {
    fireEvent.click(previewButton());
  });
}

describe("the move-instruction box", () => {
  it("shows the instruction placeholder and an inline hint", () => {
    renderPanel();
    expect(MOVE_INSTRUCTIONS_PLACEHOLDER).toBe(
      "Describe a step, e.g. 'split into cases on whether n is even'",
    );
    expect(box()).toHaveAttribute("placeholder", MOVE_INSTRUCTIONS_PLACEHOLDER);
    expect(
      screen.getByText(/you see exactly what they change before anything is applied/),
    ).toBeVisible();
  });

  it("explains why it is disabled when the role is not configured", () => {
    const fetchMock = stubFetch();
    renderPanel({ enabled: false });
    expect(box()).toBeDisabled();
    expect(previewButton()).toBeDisabled();
    expect(previewButton()).toHaveAccessibleDescription(/no AI provider is configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains why it is disabled in a read-only session", () => {
    renderPanel({ readOnly: true });
    expect(box()).toBeDisabled();
    expect(previewButton()).toBeDisabled();
    expect(previewButton()).toHaveAccessibleDescription(expect.stringContaining(READ_ONLY_REASON));
  });

  it("asks for a description before it can preview", () => {
    renderPanel();
    expect(previewButton()).toBeDisabled();
    expect(previewButton()).toHaveAccessibleDescription("Describe a step first.");
    describeStep("   ");
    expect(previewButton()).toBeDisabled();
    describeStep("do something");
    expect(previewButton()).toBeEnabled();
  });

  it("waits while another proof command is running", () => {
    renderPanel({ busy: true });
    describeStep();
    expect(previewButton()).toBeDisabled();
    expect(previewButton()).toHaveAccessibleDescription(/Another step is being applied/);
  });

  it("explains selections that span goals and the end of the proof", () => {
    renderPanel({
      node: node("node:one", [mainGoal, otherGoal]),
      selections: [selectionOf("goal:main"), selectionOf("goal:other")],
    });
    describeStep();
    expect(previewButton()).toBeDisabled();
    expect(previewButton()).toHaveAccessibleDescription(/different goals/);
    cleanup();
    renderPanel({ node: node("node:done", []) });
    describeStep();
    expect(previewButton()).toHaveAccessibleDescription(/nothing left to prove/);
  });

  it("exposes its text area so the page can focus it", () => {
    const textareaRef = createRef<HTMLTextAreaElement>();
    renderPanel({ textareaRef });
    expect(textareaRef.current).toBe(box());
  });

  it("sends the description, the target and the current selection, and only then previews", async () => {
    const fetchMock = stubFetch([200, previewedAnswer()]);
    renderPanel({ selections: [selectionOf("goal:main")] });
    expect(screen.getByText(/Using your current selection \(1 occurrence\)/)).toBeVisible();
    await preview("  assume p and finish  ");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/proof-sessions/session%3Aa/ai-execute");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      id: "llm-call:execute-test",
      expectedCurrentNodeId: "node:one",
      instruction: "assume p and finish",
      source: "user-instruction",
      target: { kind: "goal", id: "goal:main" },
      selections: [
        {
          kind: "exact",
          anchor: {
            stateId: "state:node:one",
            target: { kind: "goal", id: "goal:main" },
            statement: { kind: "conclusion" },
          },
          path: [],
        },
      ],
    });
  });

  it("about the first open goal when nothing is selected", async () => {
    const fetchMock = stubFetch([200, previewedAnswer()]);
    renderPanel();
    expect(screen.getByText(/first open goal/)).toBeVisible();
    await preview();
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.target).toEqual({ kind: "goal", id: "goal:main" });
    expect(body.selections).toBeUndefined();
  });

  it("shows the transition class first, then the steps and the resulting state", async () => {
    stubFetch([200, previewedAnswer()]);
    renderPanel();
    await preview();
    const card = screen.getByRole("region", { name: "Proposed steps" });
    expect(card).toHaveAttribute("data-transition-class", "equivalence");
    // The class and its plain-language meaning lead the card.
    expect(within(card).getAllByText("equivalence").length).toBeGreaterThan(0);
    expect(screen.getByTestId("executor-meaning")).toHaveTextContent(
      "This step preserves the goal: the old and new states mean the same thing.",
    );
    expect(within(card).getByText(/Assume p, then it is exactly the hypothesis\./)).toBeVisible();
    expect(within(card).getByText(/Proposed by an AI model from your description/)).toBeVisible();
    const steps = within(card).getByRole("list", { name: "Steps of this plan" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2);
    expect(steps).toHaveTextContent("Introduce implication");
    expect(steps).toHaveTextContent("Close by hypothesis");
    // The goal that closed is listed like any other preview.
    expect(within(card).getByRole("list", { name: "State changes" })).toHaveTextContent(
      "Goal closed",
    );
    expect(within(card).getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Discard" })).toBeEnabled();
  });

  it("says which library constants applying the plan would add", async () => {
    const INTEGER = { kind: "named", id: "sort:integer" };
    const GCD = {
      id: "operator:gcd",
      symbol: "Gcd",
      signature: { parameters: [INTEGER, INTEGER], result: INTEGER },
      presentation: {
        displayName: "greatest common divisor",
        latex: { template: String.raw`\gcd\left(#1, #2\right)`, precedence: "atom" },
        naturalLanguage: [{ template: "the gcd of #1 and #2", proposition: false }],
      },
    };
    stubFetch([200, previewedAnswer({ constants: [GCD] })]);
    renderPanel();
    await preview();
    const card = screen.getByRole("region", { name: "Proposed steps" });
    expect(within(card).getByTestId("preview-constants")).toHaveTextContent(
      "Applying this adds the constant ‘greatest common divisor’ to this proof’s constants.",
    );
  });

  it("adds no constants note when the plan uses only the proof's constants", async () => {
    stubFetch([200, previewedAnswer()]);
    renderPanel();
    await preview();
    expect(screen.queryByTestId("preview-constants")).toBeNull();
  });

  it("shows a weakening as weaker, not as an equivalence", async () => {
    stubFetch([
      200,
      previewedAnswer({
        transitionClass: "weakening",
        preview: {
          ...previewedAnswer().data.preview,
          transitionClass: "weakening",
        },
      }),
    ]);
    renderPanel();
    await preview();
    expect(screen.getByTestId("executor-meaning")).toHaveTextContent(
      "The new state is weaker. Solving it alone does not prove the original goal.",
    );
  });

  it("names the failing step and the kernel's reason, and says nothing changed", async () => {
    stubFetch([
      200,
      {
        ok: true,
        data: {
          status: "plan-failed",
          provenance: PROVENANCE,
          callId: "llm-call:execute-test",
          nodeId: "node:one",
          explanation: "Close it by the hypothesis.",
          failure: {
            stepIndex: 2,
            stepCount: 3,
            code: "rule-not-applicable",
            message: "The selected hypothesis does not match the conclusion.",
          },
          diagnostics: [],
        },
      },
    ]);
    renderPanel();
    await preview();
    const failed = screen.getByTestId("plan-failed");
    expect(failed).toHaveTextContent("stopped at step 2 of 3");
    expect(failed).toHaveTextContent("The selected hypothesis does not match the conclusion.");
    expect(failed).toHaveTextContent("Nothing was changed");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });

  it.each([
    [
      "needs more detail",
      {
        status: "insufficient-context",
        callId: "llm-call:x",
        result: { kind: "insufficient-context", rationale: "Which hypothesis do you mean?" },
      },
      "The model needs more detail: Which hypothesis do you mean?",
    ],
    [
      "declines",
      {
        status: "declined",
        callId: "llm-call:x",
        result: { kind: "declined", reason: "Not a step." },
      },
      "The model did not propose a step: Not a step.",
    ],
  ])("shows the model's reason when it %s", async (_name, data, expected) => {
    stubFetch([200, { ok: true, data }]);
    renderPanel();
    await preview();
    expect(screen.getByRole("status")).toHaveTextContent(expected);
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });

  it.each([
    [429, "ai-rate-limited", "Too many AI requests right now"],
    [503, "ai-disabled", "no AI provider is configured"],
    [409, "stale-evidence", "The proof moved on"],
    [422, "invalid-output", "rejected by the checker"],
  ])("explains a %s answer in plain language", async (status, code, expected) => {
    stubFetch([status, { ok: false, error: { code, message: "Raw message." } }]);
    renderPanel();
    await preview();
    expect(screen.getByRole("status")).toHaveTextContent(expected);
  });

  it("reports an unreachable service without losing the description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    renderPanel();
    await preview("keep this text");
    expect(screen.getByRole("status")).toHaveTextContent("could not be reached");
    expect(box()).toHaveValue("keep this text");
  });

  it("discards a preview without applying anything", async () => {
    const fetchMock = stubFetch([200, previewedAnswer()]);
    renderPanel();
    await preview();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("region", { name: "Proposed steps" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(box()).toHaveValue("assume p and finish");
  });

  it("applies by naming the stored call, never a plan, and then hands over to the page", async () => {
    const fetchMock = stubFetch(
      [200, previewedAnswer()],
      [
        201,
        {
          ok: true,
          data: {
            status: "applied",
            callId: "llm-call:execute-test",
            replayed: false,
            nodeId: "node:final",
            transitionClass: "equivalence",
            steps: [{ index: 1 }, { index: 2 }],
          },
        },
      ],
    );
    const { onApplyStart, onApplyEnd, onApplied } = renderPanel();
    await preview();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/api/proof-sessions/session%3Aa/ai-execute/apply");
    expect(JSON.parse(String(init.body))).toEqual({
      callId: "llm-call:execute-test",
      expectedCurrentNodeId: "node:one",
    });
    expect(onApplyStart).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledWith({ nodeId: "node:final", stepCount: 2 });
    expect(onApplyEnd).toHaveBeenCalledTimes(1);
    expect(box()).toHaveValue("");
    expect(screen.queryByRole("region", { name: "Proposed steps" })).not.toBeInTheDocument();
  });

  it("keeps the proof and says so when applying is refused as stale", async () => {
    stubFetch(
      [200, previewedAnswer()],
      [409, { ok: false, error: { code: "serialized-stale-command", message: "Moved." } }],
    );
    const { onApplied, onApplyEnd } = renderPanel();
    await preview();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    expect(onApplied).not.toHaveBeenCalled();
    expect(onApplyEnd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing was changed; preview again");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });

  it("does not apply while another proof command holds the slot", async () => {
    const fetchMock = stubFetch([200, previewedAnswer()]);
    const { onApplied } = renderPanel({ onApplyStart: vi.fn(() => false) });
    await preview();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("drops a preview once the proof has moved on", async () => {
    stubFetch([200, previewedAnswer()]);
    const view = renderPanel();
    await preview();
    expect(screen.getByRole("region", { name: "Proposed steps" })).toBeVisible();
    view.rerenderWith({ node: node("node:two") });
    expect(screen.queryByRole("region", { name: "Proposed steps" })).not.toBeInTheDocument();
    expect(box()).toHaveValue("assume p and finish");
  });

  it("ignores an answer for a proof that moved on while the model worked", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const view = renderPanel();
    describeStep();
    await act(async () => {
      fireEvent.click(previewButton());
    });
    expect(previewButton()).toHaveTextContent("Asking the model");
    view.rerenderWith({ node: node("node:two") });
    await act(async () => {
      finish(new Response(JSON.stringify(previewedAnswer()), { status: 200 }));
    });
    expect(screen.queryByRole("region", { name: "Proposed steps" })).not.toBeInTheDocument();
  });
});
