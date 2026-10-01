// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProofNode } from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import { MoveAuthoring } from "./move-authoring";
import { fixtureHistory } from "./history-fixture.testing";
import { deriveRecordedPath, pathEdges } from "./recorded-paths";
import { assembleTemplate, draftFromPath } from "./template-builder";
import type { AuthoredMoves } from "./api-contract";

// A stand-in for the MathLive workspace: one button selects the first goal's conclusion.
vi.mock("../proof-workspace", () => ({
  ProofWorkspace: ({
    node,
    onSelectionChange,
  }: {
    node: ProofNode;
    onSelectionChange: (selections: readonly AnchoredProofSelection[]) => void;
  }) => (
    <div>
      <span data-testid="workspace-node">{node.id}</span>
      <button
        type="button"
        onClick={() =>
          onSelectionChange([
            {
              kind: "exact",
              anchor: {
                stateId: node.state.id,
                target: { kind: "goal", id: node.state.goals[0]!.id },
                statement: { kind: "conclusion" },
              },
              path: [],
            },
          ])
        }
      >
        Select goal
      </button>
    </div>
  ),
}));

const history = fixtureHistory();
const SESSION_ID = "session:test";
const session = { id: SESSION_ID, operators: [] } as const;
const INTRODUCE_END = "node:command:contraposition-1";

type Route = (init: RequestInit | undefined, url: string) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A well-formed stored template: the single-step move of the fixture's introduce step. */
function storedTemplate(): Record<string, unknown> {
  const path = pathEdges(history.edges, "node:contraposition-root", INTRODUCE_END)!;
  const derived = deriveRecordedPath({
    nodes: history.nodes,
    path,
    suggestionSets: history.suggestionSets,
    operators: [],
  });
  if (!derived.ok) throw new Error(derived.message);
  const built = draftFromPath(derived.path, "Demo move", "A stored move.");
  if (!built.ok) throw new Error(built.message);
  return assembleTemplate({ ...built.draft, idSuffix: "demo" });
}

const EMPTY_MOVES: AuthoredMoves = { sessionId: SESSION_ID, moves: [] };

function historyResponse() {
  return json({
    ok: true,
    data: {
      session: {
        id: SESSION_ID,
        rootNodeId: "node:contraposition-root",
        currentNodeId: "node:contraposition-root",
        operators: [],
      },
      nodes: history.nodes,
      edges: history.edges.map(({ edge, name }) => ({ edge, name })),
    },
  });
}

function stubFetch(routes: Readonly<Record<string, Route>> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((suffix) => url.endsWith(suffix));
    if (key !== undefined) return routes[key]!(init, url);
    if (url.endsWith("/history")) return historyResponse();
    const set = /\/suggestion-sets\/(.+)$/.exec(url);
    if (set !== null) {
      const found = history.suggestionSets.get(decodeURIComponent(set[1]!));
      return found === undefined
        ? json({ ok: false, error: { code: "not-found", message: "No such set." } }, 404)
        : json({ ok: true, data: { suggestionSet: found, transitionClasses: [] } });
    }
    if (url.endsWith("/authored-moves")) return json({ ok: true, data: EMPTY_MOVES });
    if (url.endsWith("/library")) {
      return json({
        ok: true,
        data: { sessionId: SESSION_ID, readOnly: false, entries: [], variantFamilies: [] },
      });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function committed(commandId: string, kind: string, result: Record<string, unknown>) {
  return {
    commandId,
    kind,
    actor: { id: "actor:web", kind: "human" },
    replayed: false,
    cursor: {
      nodeId: "node:contraposition-root",
      stateId: "state:contraposition-root",
      eventSequence: 0,
      inquirySequence: 0,
    },
    aliases: {
      nodeId: "node:contraposition-root",
      stateId: "state:contraposition-root",
      goals: [],
      obligations: [],
      hypotheses: [],
    },
    delta: {
      from: { nodeId: "node:contraposition-root", stateId: "state:contraposition-root" },
      to: { nodeId: "node:contraposition-root", stateId: "state:contraposition-root" },
      goals: { added: [], removed: [], updated: [] },
      obligations: { added: [], removed: [], updated: [] },
      assumptionsAdded: [],
      assumptionsRemoved: [],
    },
    result,
  };
}

beforeEach(() => {
  let uuid = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Choose the recorded path ending at the introduce-implication node and start a move from it. */
async function startFromIntroduceStep() {
  const end = await screen.findByLabelText("Path ending at");
  fireEvent.change(end, { target: { value: INTRODUCE_END } });
  fireEvent.click(
    await screen.findByRole("button", { name: "Start a single-step move from this step" }),
  );
  await screen.findByRole("region", { name: "Move template" });
}

function nameTheMove() {
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Introduce an implication" },
  });
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: "Assume the antecedent of an implication goal." },
  });
}

function addExamples() {
  const examples = screen.getByRole("region", { name: "Examples" });
  fireEvent.click(
    within(examples).getAllByRole("button", { name: "Add as a positive example" })[0]!,
  );
  const snapshot = screen.getByRole("region", { name: "Stored snapshot" });
  fireEvent.change(within(snapshot).getByLabelText("Snapshot"), {
    target: { value: INTRODUCE_END },
  });
  fireEvent.click(within(snapshot).getByRole("button", { name: "Select goal" }));
  fireEvent.click(
    within(snapshot).getByRole("button", { name: "Assign the selection to this slot" }),
  );
  fireEvent.click(within(snapshot).getByRole("button", { name: /Add as a negative example/ }));
}

describe("starting a move from the stored history", () => {
  it("explains why a recorded step cannot be used", async () => {
    stubFetch();
    render(<MoveAuthoring session={session} />);
    // The first path is a case split applied without a displayed suggestion.
    expect(await screen.findByTestId("path-unusable")).toHaveTextContent(
      /not applied from a displayed suggestion/,
    );
    expect(screen.queryByRole("button", { name: /Start a single-step move/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("Path ending at"), {
      target: { value: "node:command:contraposition-2" },
    });
    expect(await screen.findByTestId("path-unusable")).toHaveTextContent(
      /applies a library result/,
    );
  });

  it("builds a single-step draft from a stored step: contract, pattern, plan and class", async () => {
    stubFetch();
    render(<MoveAuthoring session={session} />);
    await startFromIntroduceStep();

    expect(screen.getByTestId("draft-source")).toHaveTextContent(
      "the recorded path “Introduce implication”",
    );
    const plan = screen.getByRole("region", { name: "Plan" });
    expect(
      within(plan).getByText("Introduce implication", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(within(plan).getByText(/driven by selections/)).toBeInTheDocument();
    const patterns = screen.getByRole("region", { name: "Patterns" });
    expect(within(patterns).getByText("Implies(Not(q), Not(p))")).toBeInTheDocument();
    expect(screen.getByLabelText("This move is")).toHaveValue("equivalence");
    expect(screen.getByTestId("composed-class")).toHaveTextContent("compose to Equivalence");
    // The ID follows the name.
    nameTheMove();
    expect(screen.getByTestId("move-id")).toHaveTextContent("authored:introduce-an-implication");
  });

  it("takes a pattern from the selection in a stored snapshot", async () => {
    stubFetch();
    render(<MoveAuthoring session={session} />);
    await startFromIntroduceStep();
    const snapshot = screen.getByRole("region", { name: "Stored snapshot" });
    fireEvent.change(within(snapshot).getByLabelText("Snapshot"), {
      target: { value: INTRODUCE_END },
    });
    fireEvent.click(within(snapshot).getByRole("button", { name: "Select goal" }));
    expect(screen.getByTestId("snapshot-selection")).toHaveTextContent("Selected: Not(p)");
    fireEvent.click(
      within(snapshot).getByRole("button", { name: /Use the selection as this slot/ }),
    );
    const patterns = screen.getByRole("region", { name: "Patterns" });
    expect(within(patterns).getByText("Not(p)")).toBeInTheDocument();
    expect(within(patterns).queryByText("Implies(Not(q), Not(p))")).toBeNull();
  });

  it("names recorded steps by what was done, never by a node ID, and explains the primitive", async () => {
    stubFetch();
    render(<MoveAuthoring session={session} />);
    const end = await screen.findByLabelText("Path ending at");
    const labels = [...end.querySelectorAll("option")].map(({ textContent }) => textContent);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label).toMatch(/^After “.+”/);
      expect(label).not.toMatch(/node:/);
    }
    const start = screen.getByLabelText("Starting after");
    expect([...start.querySelectorAll("option")].map(({ textContent }) => textContent)).toContain(
      "The very start",
    );
    expect(screen.getByText(/A kernel operation is one of the basic proof steps/)).toBeVisible();
  });

  it("numbers the review step only once a draft is being edited", async () => {
    stubFetch();
    render(<MoveAuthoring session={session} />);
    await screen.findByLabelText("Path ending at");
    expect(screen.getByRole("heading", { name: "Review and approve saved moves" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "6. Review and approve" })).toBeNull();
    await startFromIntroduceStep();
    expect(screen.getByRole("heading", { name: "6. Review and approve" })).toBeVisible();
  });

  it("starts from a primitive kernel operation", async () => {
    stubFetch();
    render(<MoveAuthoring session={session} />);
    await screen.findByLabelText("Kernel operation");
    fireEvent.change(screen.getByLabelText("Kernel operation"), {
      target: { value: "move:split-goal-conjunction" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start from this primitive" }));
    const patterns = await screen.findByRole("region", { name: "Patterns" });
    expect(within(patterns).getByText("And(p, q)")).toBeInTheDocument();
    expect(screen.getByTestId("draft-source")).toHaveTextContent("the primitive Split conjunction");
  });
});

describe("guidance for someone new to the platform", () => {
  it("explains each step in plain words and keeps longer help collapsed", async () => {
    stubFetch();
    render(<MoveAuthoring session={session} />);
    await startFromIntroduceStep();
    for (const heading of [
      "1. Start from something you already did",
      "2. Name and describe your move",
      "3. Show it working and failing (examples)",
      "4. Check your move",
      "5. Save as a draft",
      "6. Review and approve",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    // Longer help is optional: collapsed details, never a dialog.
    const helps = Array.from(document.querySelectorAll("details"));
    expect(helps.length).toBeGreaterThan(3);
    expect(helps.every((details) => !details.open)).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The kind of step is explained, and a wrong choice is flagged before checking.
    expect(screen.getByTestId("class-explanation")).toHaveTextContent(
      "Equivalence: The new goals are true exactly when the old goal was",
    );
    fireEvent.change(screen.getByLabelText("This move is"), { target: { value: "weakening" } });
    expect(screen.getByTestId("class-explanation")).toHaveTextContent("Weakening:");
    expect(screen.getByText(/The kernel will report Equivalence for these steps/)).toBeVisible();
  });

  it("has an informative empty state for examples and says why a button is disabled", async () => {
    stubFetch();
    render(<MoveAuthoring session={session} />);
    await startFromIntroduceStep();
    expect(
      screen.getByText("No examples yet: add two that should work and one that shouldn't."),
    ).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save draft" });
    expect(save).toBeDisabled();
    expect(screen.getByRole("region", { name: "Save" })).toHaveTextContent(
      /Complete the move first: /,
    );
    nameTheMove();
    expect(save).toBeEnabled();

    const snapshot = screen.getByRole("region", { name: "Stored snapshot" });
    const useAsPattern = within(snapshot).getByRole("button", { name: /Use the selection as/ });
    expect(useAsPattern).toBeDisabled();
    expect(snapshot).toHaveTextContent("Select exactly one occurrence in the snapshot.");
    const negative = within(snapshot).getByRole("button", { name: /Add as a negative example/ });
    expect(negative).toBeDisabled();
    expect(snapshot).toHaveTextContent("Assign a selection to a slot first");
  });

  it("shows a diagnostic beside the field it concerns, with what to do about it", async () => {
    stubFetch({
      "/authored-moves/validate": () =>
        json({
          ok: true,
          data: {
            sessionId: SESSION_ID,
            ok: false,
            diagnostics: [
              {
                code: "class-mismatch",
                message:
                  "The template declares weakening, but its kernel steps compose to equivalence.",
                path: ["transitionClass"],
              },
              {
                code: "unknown-artifact",
                message: "The required result result:gone is not available.",
                path: ["requiredArtifacts", 0],
              },
            ],
          },
        }),
    });
    render(<MoveAuthoring session={session} />);
    await startFromIntroduceStep();
    nameTheMove();
    fireEvent.click(screen.getByRole("button", { name: "Validate by running the examples" }));
    await screen.findByTestId("validation-result");

    const kind = screen.getByRole("region", { name: "Kind of step" });
    const here = within(kind).getByLabelText("Problems found in: Kind of step");
    expect(here).toHaveTextContent("Declared class differs from the kernel's");
    expect(here).toHaveTextContent("What to do: Set the kind of step to what the kernel reports");
    const artifacts = screen.getByRole("region", { name: "Required artifacts" });
    expect(
      within(artifacts).getByLabelText("Problems found in: Library items it relies on"),
    ).toHaveTextContent("Untick this library item");
    // The diagnostics disappear from the fields once the move changes.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Another name" } });
    expect(within(kind).queryByLabelText("Problems found in: Kind of step")).toBeNull();
  });
});

describe("validation", () => {
  it("shows every diagnostic under its section and on the example it concerns", async () => {
    let sent: Record<string, unknown> | undefined;
    stubFetch({
      "/authored-moves/validate": (init) => {
        sent = bodyOf(init);
        return json({
          ok: true,
          data: {
            sessionId: SESSION_ID,
            ok: false,
            diagnostics: [
              {
                code: "class-mismatch",
                message:
                  "The template declares weakening, but its kernel steps compose to equivalence.",
                path: ["transitionClass"],
              },
              {
                code: "example-mismatch",
                message:
                  "Example positive-1: the conclusion of goals 1 differs from the expected one.",
                path: ["examples", 0, "expected"],
                exampleId: "positive-1",
              },
              {
                code: "missing-example",
                message:
                  "A template needs at least two positive examples and one negative example.",
                path: ["examples"],
              },
            ],
          },
        });
      },
    });
    render(<MoveAuthoring session={session} />);
    await startFromIntroduceStep();
    nameTheMove();
    addExamples();
    fireEvent.click(screen.getByRole("button", { name: "Validate by running the examples" }));

    const result = await screen.findByTestId("validation-result");
    expect(result).toHaveTextContent("The template does not pass validation (3 problems).");
    const classGroup = within(result).getByText("Kind of step").closest("section")!;
    expect(classGroup).toHaveTextContent("Declared class differs from the kernel's");
    const examplesGroup = within(result)
      .getByText("Examples", { selector: "h4" })
      .closest("section")!;
    expect(examplesGroup).toHaveTextContent("Example outcome differs");
    expect(examplesGroup).toHaveTextContent("Examples missing");
    // The same diagnostic is shown on the example it names.
    const example = document.querySelector('[data-example-id="positive-1"]') as HTMLElement;
    expect(example).toHaveTextContent("Example outcome differs");

    // The request carries the template with the captured examples and no typed mathematics.
    const template = sent?.["template"] as Record<string, unknown>;
    expect(template["id"]).toBe("authored:introduce-an-implication");
    expect((template["examples"] as unknown[]).length).toBe(2);
    expect(template["plan"]).toMatchObject({
      steps: [{ moveId: "move:introduce-implication", operationKind: "introduce-implication" }],
    });

    // Editing afterwards marks the validation as out of date.
    fireEvent.change(screen.getByLabelText("This move is"), { target: { value: "weakening" } });
    expect(screen.getByTestId("validation-result")).toHaveAttribute("data-stale", "true");
    expect(screen.getByText(/You changed the move after this check ran/)).toBeInTheDocument();
  });

  it("reports a passing validation and whether the move will be offered", async () => {
    stubFetch({
      "/authored-moves/validate": () =>
        json({
          ok: true,
          data: {
            sessionId: SESSION_ID,
            ok: true,
            report: {
              transitionClass: "equivalence",
              stepCount: 1,
              retrievable: true,
              examples: [
                {
                  exampleId: "positive-1",
                  outcome: "applied",
                  transitionClass: "equivalence",
                  stepCount: 1,
                },
                { exampleId: "negative-2", outcome: "rejected", stepCount: 1 },
              ],
            },
          },
        }),
    });
    render(<MoveAuthoring session={session} />);
    await startFromIntroduceStep();
    nameTheMove();
    fireEvent.click(screen.getByRole("button", { name: "Validate by running the examples" }));
    expect(await screen.findByText("The template passes validation.")).toBeInTheDocument();
    expect(screen.getByTestId("validation-retrievable")).toHaveTextContent(
      "Once approved this move is offered as a suggestion",
    );
    expect(screen.getByText("negative-2: rejected, as expected")).toBeInTheDocument();
  });

  it("says when validation could not run", async () => {
    stubFetch({
      "/authored-moves/validate": () =>
        json({ ok: false, error: { code: "service_unavailable", message: "Down." } }, 503),
    });
    render(<MoveAuthoring session={session} />);
    await startFromIntroduceStep();
    nameTheMove();
    fireEvent.click(screen.getByRole("button", { name: "Validate by running the examples" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Validation could not run (service_unavailable): Down.",
    );
  });
});

describe("saving a draft", () => {
  it("sends the template as a reviewed-authoring envelope from the human actor", async () => {
    let envelope: Record<string, unknown> | undefined;
    stubFetch({
      "/protocol-commands": (init) => {
        envelope = bodyOf(init);
        return json(
          {
            ok: true,
            data: committed(String(envelope["commandId"]), "author-move-draft", {
              artifactId: "authored:introduce-an-implication.draft.x",
              moveId: "authored:introduce-an-implication",
              revision: 1,
              definitionDigest: `sha256:${"0".repeat(64)}`,
              status: "draft",
              validation: {
                ok: false,
                diagnostics: [
                  { code: "missing-example", message: "Needs examples.", path: ["examples"] },
                ],
              },
            }),
          },
          201,
        );
      },
    });
    render(<MoveAuthoring session={session} />);
    await startFromIntroduceStep();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    nameTheMove();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(await screen.findByTestId("authoring-notice")).toHaveTextContent(
      "Saved revision 1 of authored:introduce-an-implication as a draft. Validation still reports 1 problem",
    );
    expect(envelope).toMatchObject({
      actor: { id: "actor:web", kind: "human" },
      command: {
        kind: "author-move-draft",
        payloadSource: "reviewed-authoring",
        template: { id: "authored:introduce-an-implication", name: "Introduce an implication" },
      },
    });
    expect(envelope?.["commandId"]).toMatch(/^command:web-author-move-/);
  });

  it("shows a refused save with the validation diagnostics that came with it", async () => {
    stubFetch({
      "/protocol-commands": () =>
        json(
          {
            ok: false,
            error: { code: "invalid-template", message: "The template is not a well-formed move." },
            details: {
              diagnostics: [{ code: "invalid-template", message: "x" }],
              validation: [
                { code: "invalid-template", message: "Required", path: ["description"] },
              ],
            },
          },
          422,
        ),
    });
    render(<MoveAuthoring session={session} />);
    await startFromIntroduceStep();
    nameTheMove();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const refusal = await screen.findByTestId("save-refusal");
    expect(refusal).toHaveTextContent(
      "Save draft refused (invalid-template): The template is not a well-formed authored move.",
    );
    expect(within(refusal).getByText("Name and description")).toBeInTheDocument();
  });
});

describe("the draft to review workflow", () => {
  const draftMove: AuthoredMoves = {
    sessionId: SESSION_ID,
    moves: [
      {
        moveId: "authored:demo",
        name: "Demo move",
        retrievable: false,
        revisions: [
          {
            draftArtifactId: "authored:demo.draft.1",
            revision: 1,
            authorId: "actor:web",
            status: "draft",
            definitionDigest: `sha256:${"a".repeat(64)}`,
            template: storedTemplate(),
          },
          {
            draftArtifactId: "authored:demo.draft.0",
            reviewArtifactId: "authored:demo.review.0",
            revision: 2,
            authorId: "actor:web",
            status: "changes-requested",
            definitionDigest: `sha256:${"b".repeat(64)}`,
            review: {
              decision: "changes-requested",
              reviewerId: "actor:web",
              reviewedAt: "2026-09-30T10:00:00.000Z",
              notes: "Add a negative example.",
              reviewOf: "authored:demo.draft.0",
              definitionDigest: `sha256:${"b".repeat(64)}`,
            },
            template: storedTemplate(),
          },
        ],
      },
    ],
  };

  it("lists revisions with their recorded reviews and the retrievable state", async () => {
    stubFetch({ "/authored-moves": () => json({ ok: true, data: draftMove }) });
    render(<MoveAuthoring session={session} />);
    const move = await screen.findByRole("article", { name: "Move authored:demo" });
    expect(within(move).getByTestId("retrievable-authored:demo")).toHaveTextContent(
      "Not retrievable: no approved version",
    );
    expect(within(move).getByText("Draft, awaiting review")).toBeInTheDocument();
    expect(within(move).getByTestId("recorded-review")).toHaveTextContent(
      "Request changes by actor:web on 2026-09-30T10:00:00.000Z: “Add a negative example.”",
    );
    // Only the undecided revision has a review form.
    expect(within(move).getAllByRole("form")).toHaveLength(1);
  });

  it("requires notes to reject, shows the refusal readably, then records the approval", async () => {
    const sent: Record<string, unknown>[] = [];
    let moves = draftMove;
    stubFetch({
      "/authored-moves": () => json({ ok: true, data: moves }),
      "/protocol-commands": (init) => {
        const envelope = bodyOf(init);
        sent.push(envelope);
        const decision = (envelope["command"] as Record<string, unknown>)["decision"];
        if (decision === "approved" && sent.length === 1) {
          return json(
            {
              ok: false,
              error: {
                code: "move-validation-failed",
                message: "The template does not pass validation, so it cannot be approved.",
              },
              details: {
                diagnostics: [{ code: "move-validation-failed", message: "x" }],
                validation: [
                  {
                    code: "example-accepted",
                    message:
                      "Example negative-3 is expected to be rejected, but the kernel accepted it.",
                    path: ["examples", 2, "expected"],
                    exampleId: "negative-3",
                  },
                ],
              },
            },
            422,
          );
        }
        moves = {
          ...draftMove,
          moves: [
            {
              ...draftMove.moves[0]!,
              retrievable: true,
              activeArtifactId: "authored:demo.review.1",
            },
          ],
        };
        return json(
          {
            ok: true,
            data: committed(String(envelope["commandId"]), "review-move-draft", {
              artifactId: "authored:demo.review.1",
              draftArtifactId: "authored:demo.draft.1",
              moveId: "authored:demo",
              decision,
              definitionDigest: `sha256:${"a".repeat(64)}`,
              retrievable: decision === "approved",
            }),
          },
          201,
        );
      },
    });
    render(<MoveAuthoring session={session} />);
    const form = await screen.findByRole("form", { name: "Review revision 1 of authored:demo" });

    // Rejecting needs notes; approving does not.
    const submit = within(form).getByRole("button", { name: /^Record:/ });
    fireEvent.click(within(form).getByRole("radio", { name: "Reject" }));
    expect(submit).toBeDisabled();
    expect(within(form).getByText(/required to reject or request changes/)).toBeInTheDocument();
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "Too narrow." } });
    expect(submit).toBeEnabled();
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(within(form).getByRole("radio", { name: "Approve" }));
    expect(submit).toBeEnabled();

    // The first approval is refused: the reason and the failing example are shown.
    fireEvent.click(submit);
    const refusal = await within(form).findByTestId("review-refusal");
    expect(refusal).toHaveTextContent(
      "Approve refused (move-validation-failed): The template does not pass validation, so it cannot be approved.",
    );
    expect(refusal).toHaveTextContent("Negative example was accepted");
    expect(sent[0]).toMatchObject({
      actor: { id: "actor:web", kind: "human" },
      command: {
        kind: "review-move-draft",
        draftArtifactId: "authored:demo.draft.1",
        decision: "approved",
        notes: "",
        payloadSource: "reviewed-authoring",
      },
    });

    // The second attempt is recorded; the list is read again and the move is retrievable.
    fireEvent.click(submit);
    expect(await screen.findByTestId("authoring-notice")).toHaveTextContent(
      "Approved revision 1 of authored:demo; it is now offered as a suggestion.",
    );
    await waitFor(() =>
      expect(screen.getByTestId("retrievable-authored:demo")).toHaveTextContent(
        "Retrievable: offered as a suggestion",
      ),
    );
    // A refused command wrote nothing, so its retry reuses the command ID.
    expect(sent[1]?.["commandId"]).toBe(sent[0]?.["commandId"]);
  });

  it("loads a stored revision into the editor", async () => {
    stubFetch({ "/authored-moves": () => json({ ok: true, data: draftMove }) });
    render(<MoveAuthoring session={session} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Revise revision 1 of authored:demo in the editor",
      }),
    );
    expect(await screen.findByLabelText("Name")).toHaveValue("Demo move");
    expect(screen.getByTestId("move-id")).toHaveTextContent("authored:demo");
  });
});

describe("a read-only session", () => {
  it("shows the reason and offers no way to start, save or review", async () => {
    stubFetch({ "/authored-moves": () => json({ ok: true, data: draftMove() }) });
    render(<MoveAuthoring session={{ ...session, readOnly: true }} />);
    expect(await screen.findByTestId("read-only-reason")).toHaveTextContent(
      "This session is read-only (imported artifact)",
    );
    fireEvent.change(await screen.findByLabelText("Path ending at"), {
      target: { value: INTRODUCE_END },
    });
    expect(
      await screen.findByRole("button", { name: "Start a single-step move from this step" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start from this primitive" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: /^Record:/ })).toBeDisabled();
  });

  function draftMove(): AuthoredMoves {
    return {
      sessionId: SESSION_ID,
      moves: [
        {
          moveId: "authored:demo",
          name: "Demo",
          retrievable: false,
          revisions: [
            {
              draftArtifactId: "authored:demo.draft.1",
              revision: 1,
              authorId: "actor:web",
              status: "draft",
              definitionDigest: `sha256:${"a".repeat(64)}`,
              template: { id: "authored:demo" },
            },
          ],
        },
      ],
    };
  }
});
