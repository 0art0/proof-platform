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

type Route = (body: Record<string, unknown> | undefined) => readonly [number, unknown];

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
    const [status, json] = next?.(body) ?? [
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

function renderPanel(overrides: Partial<Parameters<typeof ProofPlanPanel>[0]> = {}) {
  const onApplied = vi.fn();
  const props = {
    sessionId: "session:test",
    node: node(),
    enabled: true,
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

describe("the proof-plan panel", () => {
  it("explains itself and says why it is unavailable", () => {
    renderPanel({ enabled: false });
    expect(screen.getByText(/writes the whole proof as numbered steps/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Write a proof plan" })).toBeDisabled();
    expect(
      screen.getByText(/planner or the step translator is not configured/),
    ).toBeInTheDocument();
  });

  it("shows the plan as numbered steps with their forms, motivation and justification", async () => {
    stubRoutes({ "/ai-proof-plan": [ok(PLAN_VIEW)] });
    renderPanel();
    await click("Write a proof plan");
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
      "/ai-proof-plan": [ok(PLAN_VIEW)],
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
    await click("Write a proof plan");
    await click("Next move");
    const card = screen.getByTestId("proof-plan-proposal");
    expect(within(card).getByText(CANDIDATE.label)).toBeInTheDocument();
    expect(within(card).getByText(/Jev chose this move \(confidence 90%\)/)).toBeInTheDocument();
    expect(within(card).getByText(/Drop hypothesis \(5%\)/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Apply" }));
    });
    expect(onApplied).toHaveBeenCalledWith({ nodeId: "node:two", name: CANDIDATE.label });
    expect(requests.find(({ path }) => path.endsWith("/ai-proof-plan-apply"))?.body).toEqual({
      callId: "llm-call:translate-fixed",
      candidateId: CANDIDATE.id,
      expectedCurrentNodeId: "node:one",
    });

    rerender(<ProofPlanPanel {...props} node={node("node:two")} />);
    await click("Next move");
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

  it("reports a missing move, offers the alternatives and lists it in the report", async () => {
    stubRoutes({
      "/ai-proof-plan": [ok(PLAN_VIEW)],
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
    await click("Write a proof plan");
    await click("Next move");
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
    stubRoutes({ "/ai-proof-plan": [ok(PLAN_VIEW)] });
    const { unmount } = renderPanel();
    await click("Write a proof plan");
    unmount();
    renderPanel({ node: node("node:elsewhere") });
    expect(screen.getByText(/The proof changed outside the plan/)).toBeInTheDocument();
    await click("Continue from here");
    expect(screen.getByRole("button", { name: "Next move" })).toBeEnabled();
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
    await click("Write a proof plan");
    expect(screen.getByRole("status")).toHaveTextContent("The planner declined: Not a theorem.");
  });
});
