// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProofNodeSchema, type ProofNode } from "@proof/protocol";
import { ProofPlanPanel } from "./proof-plan-panel";
import { CANDIDATE, PLAN_VIEW } from "./proof-plan.testing";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function node(id = "node:one"): ProofNode {
  return createProofNodeSchema().parse({
    id,
    state: {
      id: `state:${id}`,
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: [
                {
                  id: "declaration:p",
                  symbol: "p",
                  sort: { kind: "proposition" },
                  role: "universal-parameter",
                },
                {
                  id: "declaration:q",
                  symbol: "q",
                  sort: { kind: "proposition" },
                  role: "universal-parameter",
                },
              ],
              hypotheses: [{ id: "hypothesis:pq", statement: { expression: ["And", "p", "q"] } }],
            },
            conclusion: { expression: ["And", "q", "p"] },
          },
        },
      ],
      obligations: [],
    },
  });
}

type RouteAnswer = readonly [number, unknown];
type Route = (body: Record<string, unknown> | undefined) => RouteAnswer | Promise<RouteAnswer>;

/** Answer each same-origin endpoint from its own queue; record every request. */
function stubRoutes(routes: Record<string, Route[]>) {
  const requests: { path: string; body: Record<string, unknown> | undefined }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body =
      init?.body === undefined
        ? undefined
        : (JSON.parse(String(init.body)) as Record<string, unknown>);
    requests.push({ path, body });
    const key = Object.keys(routes).find((suffix) => path.endsWith(suffix));
    const next = key === undefined ? undefined : routes[key]!.shift();
    const [status, json] = (await next?.(body)) ?? [
      500,
      { ok: false, error: { code: "x", message: "unexpected" } },
    ];
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return requests;
}

const ok =
  (data: unknown, status = 200) =>
  () =>
    [status, { ok: true, data }] as const;

const DRAFT_VIEW = {
  status: "drafted",
  callId: "llm-call:draft-fixed",
  prompt: "Write from the problem statement.",
  draft: {
    sketch: "Read the hypothesis in reverse order.",
    steps: [
      {
        title: "Take the conjuncts",
        motivation: "The goal asks for both.",
        reasoning: "The hypothesis gives each conjunct.",
      },
    ],
  },
};

function renderPanel(overrides: Partial<Parameters<typeof ProofPlanPanel>[0]> = {}) {
  const onApplied = vi.fn(() => true);
  const props = {
    sessionId: "session:test",
    node: node(),
    draftEnabled: true,
    blueprintEnabled: true,
    translatorEnabled: true,
    hasStatement: true,
    readOnly: false,
    busy: false,
    onApplyStart: () => true,
    onApplyEnd: () => undefined,
    onApplied,
    createId: (prefix: string) => `${prefix}-fixed`,
    ...overrides,
  };
  const view = render(<ProofPlanPanel {...props} />);
  return { ...view, onApplied, props };
}

async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

async function buildBlueprint() {
  await click("Draft proof");
  await click("Adapt to workspace");
  fireEvent.click(screen.getByText("Blueprint", { selector: "summary" }));
  fireEvent.click(screen.getByText("Independent proof", { selector: "summary" }));
}

describe("the proof-plan panel", () => {
  it("shows what the independent model is told and works without Jev", async () => {
    const requests = stubRoutes({ "/ai-proof-plan": [ok(DRAFT_VIEW), ok(PLAN_VIEW)] });
    renderPanel({ translatorEnabled: false, draftPrompt: DRAFT_VIEW.prompt });
    expect(
      screen.getByRole("button", { name: /What the model is told.*Independent proof/ }),
    ).toHaveAccessibleDescription(`Independent proof ${DRAFT_VIEW.prompt}`);
    expect(screen.queryByRole("button", { name: "Adapt to workspace" })).toBeNull();
    await buildBlueprint();
    expect(requests.map(({ body }) => body)).toEqual([
      { id: "llm-call:draft-fixed", stage: "draft" },
      {
        id: "llm-call:blueprint-fixed",
        draftCallId: "llm-call:draft-fixed",
        expectedCurrentNodeId: "node:one",
      },
    ]);
    expect(screen.getByText("Take the conjuncts")).toBeInTheDocument();
    expect(screen.getByText("Jev is unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview next move" })).toBeDisabled();
  });

  it("shows the plan as numbered steps with their forms, motivation and justification", async () => {
    stubRoutes({ "/ai-proof-plan": [ok(DRAFT_VIEW), ok(PLAN_VIEW)] });
    renderPanel();
    await buildBlueprint();
    const tree = screen.getByRole("list", { name: "Steps of the plan" });
    const steps = within(tree).getAllByRole("listitem");
    expect(steps.map((item) => item.getAttribute("data-step"))).toEqual([
      "have-q",
      "have-p",
      "qed",
    ]);
    expect(within(steps[0]!).getByText("⟨1⟩1")).toBeInTheDocument();
    expect(within(steps[0]!).getByText("HAVE")).toBeInTheDocument();
    expect(within(steps[0]!).getByText(/The hypothesis is a conjunction/)).toBeInTheDocument();
    expect(within(steps[0]!).getByText(/and elimination; using H1/)).toBeInTheDocument();
    expect(steps[0]).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(/Take the conjunction apart/)).toBeInTheDocument();
  });

  it("proposes Jev's move, applies it as the plan's move, and records the realized step", async () => {
    const requests = stubRoutes({
      "/ai-proof-plan": [ok(DRAFT_VIEW), ok(PLAN_VIEW)],
      "/ai-proof-plan-translate": [
        ok({
          status: "proposed",
          callId: "llm-call:translate-fixed",
          confidence: 0.9,
          actor: { kind: "agent" },
          choice: { ...CANDIDATE, probability: 0.9 },
          alternatives: [
            {
              id: "candidate:1",
              label: "Drop hypothesis",
              artifactId: "move:drop-hypothesis",
              selections: ["p"],
              probability: 0.05,
            },
          ],
          menuChoices: {},
          preview: { nodeId: "node:one", transitionClass: "equivalence" },
        }),
        ok({
          status: "realized",
          outputs: { focusTargetId: "goal:main", produced: ["hypothesis:q"] },
        }),
      ],
      "/ai-proof-plan-apply": [ok({ status: "applied", nodeId: "node:two" }, 201)],
    });
    const { onApplied, rerender, props } = renderPanel();
    await buildBlueprint();
    await click("Preview next move");
    const card = screen.getByTestId("proof-plan-proposal");
    expect(within(card).getByText("Expand conjunction hypothesis")).toBeInTheDocument();
    expect(within(card).getByText(/Jev chose this move \(confidence 90%\)/)).toBeInTheDocument();
    expect(within(card).getByText(/Drop hypothesis \(5%\)/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Apply move" }));
    });
    expect(onApplied).toHaveBeenCalledWith({
      nodeId: "node:two",
      name: "Expand conjunction hypothesis",
    });
    fireEvent.click(screen.getByText("Applied moves (1)"));
    const appliedMoves = screen.getByRole("list", { name: "Applied proof moves" });
    expect(appliedMoves).toHaveTextContent("Expand conjunction hypothesis");
    expect(appliedMoves).toHaveTextContent("equivalence");
    expect(appliedMoves).toHaveTextContent("The hypothesis is a conjunction");
    expect(screen.getByText("Take the conjuncts")).toBeInTheDocument();
    expect(requests.find(({ path }) => path.endsWith("/ai-proof-plan-apply"))?.body).toEqual({
      callId: "llm-call:translate-fixed",
      candidateId: CANDIDATE.id,
      expectedCurrentNodeId: "node:one",
    });

    rerender(<ProofPlanPanel {...props} node={node("node:two")} />);
    await click("Preview next move");
    const translate = requests.filter(({ path }) => path.endsWith("/ai-proof-plan-translate"));
    expect(translate[1]?.body).toMatchObject({
      stepId: "have-q",
      expectedCurrentNodeId: "node:two",
      start: { nodeId: "node:one", focusTargetId: "goal:main" },
      movesSoFar: [CANDIDATE.label],
    });
    const first = screen
      .getAllByRole("listitem")
      .find((item) => item.getAttribute("data-step") === "have-q")!;
    expect(first).toHaveAttribute("data-status", "realized");
    expect(
      screen.getAllByRole("listitem").find((item) => item.getAttribute("data-step") === "have-p"),
    ).toHaveAttribute("aria-current", "step");
  });

  it("shows Jev choosing a move and pauses before applying an in-flight choice", async () => {
    let finishTranslation: (answer: RouteAnswer) => void = () => undefined;
    const translation = new Promise<RouteAnswer>((resolve) => {
      finishTranslation = resolve;
    });
    const requests = stubRoutes({
      "/ai-proof-plan": [ok(DRAFT_VIEW), ok(PLAN_VIEW)],
      "/ai-proof-plan-translate": [() => translation],
    });
    renderPanel();
    await buildBlueprint();
    await click("Run with Jev");
    expect(screen.getByRole("status")).toHaveTextContent("Finding a move for this step…");
    await click("Pause");
    await act(async () => {
      finishTranslation(
        ok({
          status: "proposed",
          callId: "llm-call:translate-fixed",
          confidence: 0.9,
          actor: { kind: "agent" },
          choice: CANDIDATE,
          alternatives: [],
          menuChoices: {},
          preview: { nodeId: "node:one", transitionClass: "equivalence" },
        })(),
      );
    });
    expect(requests.some(({ path }) => path.endsWith("/ai-proof-plan-apply"))).toBe(false);
    expect(
      within(screen.getByTestId("proof-plan-proposal")).getByRole("button", { name: "Apply move" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
  });

  it("retains every applied move in an automatic run and reports remaining goals", async () => {
    const proposed = (callId: string, label: string) =>
      ok({
        status: "proposed",
        callId,
        confidence: 0.9,
        actor: { kind: "agent" },
        choice: { ...CANDIDATE, label },
        alternatives: [],
        menuChoices: {},
        preview: { nodeId: "node:one", transitionClass: "equivalence" },
      });
    const realized = ok({
      status: "realized",
      outputs: { focusTargetId: "goal:main", produced: [] },
    });
    stubRoutes({
      "/ai-proof-plan": [ok(DRAFT_VIEW), ok(PLAN_VIEW)],
      "/ai-proof-plan-translate": [
        proposed("llm-call:first", "Take the first conjunct"),
        realized,
        proposed("llm-call:second", "Take the second conjunct"),
        realized,
        realized,
      ],
      "/ai-proof-plan-apply": [
        ok({ status: "applied", nodeId: "node:two" }, 201),
        ok({ status: "applied", nodeId: "node:three" }, 201),
      ],
    });
    const { rerender, props } = renderPanel();
    await buildBlueprint();
    await click("Run with Jev");
    rerender(<ProofPlanPanel {...props} node={node("node:three")} />);

    expect(
      screen.getByText("Blueprint finished. This proof still has open goals or obligations."),
    ).toBeVisible();
    fireEvent.click(screen.getByText("Applied moves (2)"));
    const applied = screen.getByRole("list", { name: "Applied proof moves" });
    expect(applied).toHaveTextContent("Take the first conjunct");
    expect(applied).toHaveTextContent("Take the second conjunct");
  });

  it("reports a missing move, offers the alternatives and lists it in the report", async () => {
    stubRoutes({
      "/ai-proof-plan": [ok(DRAFT_VIEW), ok(PLAN_VIEW)],
      "/ai-proof-plan-translate": [
        ok({
          status: "no-move",
          reason: "Jev judged that no displayed action carries out this step: a move is missing.",
          callId: "llm-call:translate-fixed",
          candidateCount: 9,
          alternatives: [{ ...CANDIDATE, probability: 0.1 }],
        }),
      ],
    });
    renderPanel();
    await buildBlueprint();
    await click("Preview next move");
    const stopped = screen.getByTestId("proof-plan-stopped");
    expect(
      within(stopped).getByText("This step needs a move the platform does not have."),
    ).toBeInTheDocument();
    expect(within(stopped).getByRole("button", { name: "Choose this instead" })).toBeEnabled();
    const report = screen.getByTestId("proof-plan-report");
    expect(within(report).getByText(/Missing moves \(1 step/)).toBeInTheDocument();
    expect(within(report).getByText(/"candidateCount": 9/)).toBeInTheDocument();
    await click("Skip step");
    expect(
      screen.getAllByRole("listitem").find((item) => item.getAttribute("data-step") === "have-p"),
    ).toHaveAttribute("aria-current", "step");
  });

  it("keeps the walk across a reload and offers to continue when the proof moved on", async () => {
    stubRoutes({ "/ai-proof-plan": [ok(DRAFT_VIEW), ok(PLAN_VIEW)] });
    const { unmount } = renderPanel();
    await buildBlueprint();
    unmount();
    renderPanel({ node: node("node:elsewhere") });
    expect(screen.getByText(/The proof changed outside the plan/)).toBeInTheDocument();
    await click("Continue from here");
    expect(screen.getByRole("button", { name: "Preview next move" })).toBeEnabled();
  });

  it("says when the planner declines", async () => {
    stubRoutes({
      "/ai-proof-plan": [
        ok({
          status: "declined",
          callId: "llm-call:plan-fixed",
          result: { kind: "declined", reason: "Not a theorem." },
        }),
      ],
    });
    renderPanel();
    await click("Draft proof");
    expect(screen.getByRole("status")).toHaveTextContent("The model declined: Not a theorem.");
    expect(screen.queryByRole("button", { name: "Adapt to workspace" })).toBeNull();
  });
});
