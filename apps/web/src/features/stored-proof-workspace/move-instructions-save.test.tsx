// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPresentation } from "@proof/language";
import { createProofNodeSchema, type ProofNode } from "@proof/protocol";
import { readStashedMoveProposal } from "../move-authoring/proposal-contract";
import { proposedAnswer } from "../move-authoring/proposal.testing";
import { MoveInstructions, SAVE_AS_MOVE_HINT } from "./move-instructions";

/** "Save as reusable move" (slice M): offered after a described step is applied, inline. */

beforeEach(() => window.sessionStorage.clear());
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
const mainGoal = {
  id: "goal:main",
  sequent: {
    context: { declarations: [declaration], hypotheses: [] },
    conclusion: { expression: ["Implies", "p", "p"] },
  },
};

function node(id = "node:one"): ProofNode {
  return createProofNodeSchema().parse({
    id,
    state: { id: `state:${id}`, goals: [mainGoal], obligations: [] },
  });
}

const previewedAnswer = {
  ok: true,
  data: {
    status: "previewed",
    provenance: { kind: "user-proposal", role: "move-executor" },
    callId: "llm-call:execute-1",
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
    ],
    preview: {
      transitionClass: "equivalence",
      evidence: "structural",
      beforeState: { id: "state:node:one", goals: [mainGoal], obligations: [] },
      afterState: { id: "state:after", goals: [], obligations: [] },
      delta: {
        goals: { added: [], removed: ["goal:main"], updated: [] },
        obligations: { added: [], removed: [], updated: [] },
      },
    },
    diagnostics: [],
  },
};
const appliedAnswer = {
  ok: true,
  data: {
    status: "applied",
    callId: "llm-call:execute-1",
    replayed: false,
    nodeId: "node:two",
    transitionClass: "equivalence",
    steps: [{ index: 1 }],
  },
};

type Answer = readonly [number, unknown];

function stubFetch(...answers: readonly Answer[]) {
  const queue = [...answers];
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
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
  const navigate = vi.fn();
  const merged = {
    sessionId: "session:a",
    node: node(),
    operators: [],
    selections: [],
    presentation: createPresentation({ operators: [] }),
    view: "formal" as const,
    enabled: true,
    moveAuthorEnabled: true,
    readOnly: false,
    busy: false,
    onApplyStart: () => true,
    onApplyEnd: () => undefined,
    onApplied: async () => undefined,
    createId: (prefix: string) => `${prefix}-1`,
    navigate,
    ...props,
  };
  const view = render(<MoveInstructions {...merged} />);
  return {
    navigate,
    rerenderWith: (next: Props) => view.rerender(<MoveInstructions {...merged} {...next} />),
  };
}

async function describeAndApply() {
  fireEvent.change(screen.getByRole("textbox", { name: "Describe a step" }), {
    target: { value: "assume p and finish" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  });
}

const saveButton = () =>
  screen.getByRole("button", { name: /Save as reusable move|Asking the model/ });

describe("Save as reusable move", () => {
  it("is not offered before a step has been applied, nor after only a preview", async () => {
    stubFetch([200, previewedAnswer]);
    renderPanel();
    expect(screen.queryByTestId("save-as-move")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Describe a step" }), {
      target: { value: "assume p and finish" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
    expect(screen.queryByTestId("save-as-move")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save as reusable move" })).not.toBeInTheDocument();
  });

  it("is offered inline after the step is applied, with a plain-language hint", async () => {
    stubFetch([200, previewedAnswer], [200, appliedAnswer]);
    renderPanel();
    await describeAndApply();
    expect(screen.getByTestId("save-as-move")).toHaveTextContent(SAVE_AS_MOVE_HINT);
    expect(SAVE_AS_MOVE_HINT).toBe(
      "Turn this step into a general move you can reuse. You'll review it before it's added.",
    );
    expect(saveButton()).toBeEnabled();
    // It is a quiet inline offer: no dialog, and it can be dismissed.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByTestId("save-as-move")).not.toBeInTheDocument();
  });

  it("stays offered when the proof moves on, until it is dismissed", async () => {
    stubFetch([200, previewedAnswer], [200, appliedAnswer]);
    const { rerenderWith } = renderPanel();
    await describeAndApply();
    rerenderWith({ node: node("node:two") });
    expect(screen.getByTestId("save-as-move")).toBeInTheDocument();
  });

  it("requests a proposal for the applied step, hands it over, and opens the authoring form", async () => {
    const fetchMock = stubFetch(
      [200, previewedAnswer],
      [200, appliedAnswer],
      [200, { ok: true, data: proposedAnswer() }],
    );
    const { navigate } = renderPanel();
    await describeAndApply();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(url).toBe("/api/proof-sessions/session%3Aa/ai-move-author");
    expect(JSON.parse(String(init.body))).toEqual({
      id: "llm-call:author-1",
      executorCallId: "llm-call:execute-1",
    });
    // The checked answer is kept for the form, and the form opens on it.
    expect(readStashedMoveProposal("session:a", "llm-call:author-1")).toMatchObject({
      callId: "llm-call:author-1",
      classification: { kind: "macro" },
    });
    expect(navigate).toHaveBeenCalledWith(
      "/sessions/session%3Aa/moves?proposal=llm-call%3Aauthor-1",
    );
  });

  it("says why it is disabled: no provider, read-only, or another step running", async () => {
    stubFetch([200, previewedAnswer], [200, appliedAnswer]);
    const { rerenderWith } = renderPanel({ moveAuthorEnabled: false });
    await describeAndApply();
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAccessibleDescription(/no AI provider is configured/);
    rerenderWith({ moveAuthorEnabled: true, busy: true });
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAccessibleDescription(/Another step is being applied/);
    rerenderWith({ moveAuthorEnabled: true, readOnly: true });
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAccessibleDescription(/read-only/);
    rerenderWith({ moveAuthorEnabled: true });
    expect(saveButton()).toBeEnabled();
  });

  it.each([
    [
      409,
      { ok: false, error: { code: "plan-not-applied", message: "x" } },
      /no longer part of the proof/,
    ],
    [
      503,
      { ok: false, error: { code: "ai-disabled", message: "x" } },
      /no AI provider is configured/,
    ],
    [429, { ok: false, error: { code: "ai-rate-limited", message: "x" } }, /Too many AI requests/],
    [
      422,
      { ok: false, error: { code: "invalid-output", message: "x" } },
      /rejected by the checker/,
    ],
  ])("explains a %s answer in place and keeps the offer", async (status, body, message) => {
    stubFetch([200, previewedAnswer], [200, appliedAnswer], [status, body]);
    const { navigate } = renderPanel();
    await describeAndApply();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(screen.getByTestId("save-as-move")).toHaveTextContent(message);
    expect(navigate).not.toHaveBeenCalled();
    expect(saveButton()).toBeEnabled();
  });

  it("shows the model's own words when it asks for more or declines", async () => {
    stubFetch(
      [200, previewedAnswer],
      [200, appliedAnswer],
      [
        200,
        {
          ok: true,
          data: {
            status: "declined",
            callId: "llm-call:author-1",
            result: { kind: "declined", reason: "No general method is behind this." },
          },
        },
      ],
    );
    const { navigate } = renderPanel();
    await describeAndApply();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(screen.getByTestId("save-as-move")).toHaveTextContent(
      "The model did not propose a move: No general method is behind this.",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("reports an invalid answer and an unreachable service without navigating", async () => {
    stubFetch(
      [200, previewedAnswer],
      [200, appliedAnswer],
      [200, { ok: true, data: { nonsense: 1 } }],
    );
    const { navigate } = renderPanel();
    await describeAndApply();
    await act(async () => {
      fireEvent.click(saveButton());
    });
    expect(screen.getByTestId("save-as-move")).toHaveTextContent(/invalid response/);
    expect(navigate).not.toHaveBeenCalled();
  });
});
