// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresentation } from "@proof/language";
import { statementIdSchema } from "@proof/mathjson-model";
import type { DisplayedSuggestionSet, InquiryRecord } from "@proof/protocol";
import type { MoveState } from "../stored-proof-workspace/suggestion-card";
import type { SuggestionState } from "../stored-proof-workspace/suggestion-panel";
import type { ProtocolCommandOutcome } from "../stored-proof-workspace/toolbar-requests";
import { InquiryPanel, type InquiryPanelProps } from "./inquiry-panel";
import {
  MAIN_TARGET,
  METHOD_ENCODED,
  PREMISE_TARGET,
  makeConstructedNode,
  makeNode,
  makeTask,
  recordSeries,
  selection,
  withConstructions,
} from "./inquiry-fixtures.testing";

const presentation = createPresentation({ operators: [] });
const node = makeNode();
const conclusion = { kind: "conclusion" } as const;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function storedRecords(): InquiryRecord[] {
  const record = recordSeries();
  return [
    record({
      id: "question:main",
      kind: "question",
      question: {
        form: "establish",
        proposition: { kind: "target", nodeId: "node:root", target: MAIN_TARGET },
      },
    }),
    record({
      id: "objective:main",
      kind: "objective",
      questionId: "question:main",
      necessity: "required",
      focus: { nodeId: "node:root", target: MAIN_TARGET },
    }),
    record({
      id: "attempt:try",
      kind: "attempt",
      objectiveId: "objective:main",
      method: { kind: "library-result", resultId: "result:continuity" },
    }),
    record({
      id: "observation:unmet",
      kind: "observation",
      diagnostic: { code: "unmet-condition", detail: "premise 1 is not available" },
    }),
    record({
      id: "obstruction:unmet",
      kind: "obstruction",
      attemptId: "attempt:try",
      cause: { kind: "observation", observationId: "observation:unmet" },
    }),
    record({
      id: "relationship:addresses",
      kind: "relationship",
      relation: "addresses",
      from: ["objective:main"],
      to: "obstruction:unmet",
      reason: METHOD_ENCODED,
    }),
    record({
      id: "relationship:later",
      kind: "relationship",
      relation: "motivatedBy",
      from: ["objective:main"],
      to: "obstruction:unmet",
      reason: { provenance: "later-interpretation" },
    }),
  ];
}

type Post = Readonly<{ url: string; body: { commandId: string; command: { kind: string } } }>;

/** Serve the records and answer commands with a committed response echoing the command ID. */
function stubFetch(
  options: Readonly<{
    records?: InquiryRecord[];
    failure?: boolean;
    commandFailure?: boolean;
  }> = {},
) {
  const posts: Post[] = [];
  let gets = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ url, body });
      if (options.commandFailure === true) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: { code: "hypothesis-not-found", message: "The hypothesis is gone." },
          }),
          { status: 422 },
        );
      }
      const delta = { added: [], removed: [], updated: [] };
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            commandId: body.commandId,
            kind: body.command.kind,
            actor: { id: "actor:web", kind: "human" },
            replayed: false,
            cursor: {
              nodeId: "node:root",
              stateId: "state:root",
              eventSequence: 0,
              inquirySequence: 2,
            },
            aliases: {
              nodeId: "node:root",
              stateId: "state:root",
              goals: [],
              obligations: [],
              hypotheses: [],
            },
            delta: {
              from: { nodeId: "node:root", stateId: "state:root" },
              to: { nodeId: "node:root", stateId: "state:root" },
              goals: delta,
              obligations: delta,
              assumptionsAdded: [],
              assumptionsRemoved: [],
            },
            result: {},
          },
        }),
        { status: 201 },
      );
    }
    gets += 1;
    if (options.failure === true) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "session-not-found", message: "No such session." },
        }),
        { status: 404 },
      );
    }
    return new Response(JSON.stringify({ ok: true, data: { records: options.records ?? [] } }), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, posts, gets: () => gets };
}

const idle = { kind: "idle" } as const;

function renderPanel(overrides: Partial<InquiryPanelProps> = {}) {
  const runCommand = vi.fn<InquiryPanelProps["runCommand"]>(async () => ({
    ok: false,
    status: 422,
    code: "not-a-result-application",
    message: "The suggestion is not a result application.",
  }));
  const props: InquiryPanelProps = {
    sessionId: "session:test",
    node,
    history: { kind: "ready", nodes: [node], edges: [] },
    selections: [],
    suggestions: idle,
    move: idle,
    mutationPending: false,
    presentation,
    operators: [],
    view: "formal",
    runCommand,
    ...overrides,
  };
  render(<InquiryPanel {...props} />);
  return { runCommand };
}

const button = (name: string) => screen.getByRole("button", { name });

describe("InquiryPanel summary", () => {
  it("shows the objective, attempt, top obstruction and later interpretations from stored records", async () => {
    stubFetch({ records: storedRecords() });
    renderPanel();
    const objective = await screen.findByTestId("inquiry-objective");
    await waitFor(() => expect(objective).toHaveTextContent(/Required · active/));
    expect(screen.getByTestId("inquiry-attempt")).toHaveTextContent(/in-progress/);
    const blocker = screen.getByTestId("inquiry-blocker");
    expect(within(blocker).getByText("Top obstruction")).toBeInTheDocument();
    expect(blocker).toHaveTextContent(/unmet condition/i);
    const later = screen.getByRole("region", { name: "Later interpretations" });
    expect(later).toHaveTextContent(/later interpretation/i);
    expect(later).toHaveTextContent(/not the reason for the action/);
  });

  it("says so when nothing is recorded, and reads the stored records once for the node", async () => {
    const { fetchMock } = stubFetch();
    renderPanel();
    expect(await screen.findByText(/None yet\. Select a goal/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proof-sessions/session%3Atest/inquiry-records?after=0&limit=500",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("reports unavailable records readably", async () => {
    stubFetch({ failure: true });
    renderPanel();
    expect(await screen.findByText(/Inquiry records unavailable/)).toHaveTextContent(
      "Inquiry records unavailable: No such session. (session-not-found)",
    );
  });

  it("lists unresolved constructions with a task view grouped by role", async () => {
    stubFetch();
    renderPanel({ node: withConstructions(node, [makeTask()]) });
    const entry = await screen.findByTestId("construction-entry");
    expect(entry).toHaveTextContent(/delta · partially specified · 3 requirements/);
    const view = within(entry).getByTestId("construction-task");
    for (const label of [
      "Necessary requirements",
      "Sufficient requirements",
      "Heuristic requirements",
    ]) {
      expect(within(view).getByRole("region", { name: label })).toBeInTheDocument();
    }
    expect(
      within(within(view).getByRole("region", { name: "Heuristic requirements" })).getByText(
        /no implication established/,
      ),
    ).toBeInTheDocument();
    expect(within(view).getByTestId("construction-dependencies")).toHaveTextContent("eps");
  });
});

describe("InquiryPanel actions", () => {
  it("keeps every action visible, disabled with its reason", async () => {
    stubFetch();
    renderPanel();
    await screen.findByText(/None yet\. Select a goal/);
    for (const name of [
      "Use this",
      "Construct an object",
      "Find sufficient conditions",
      "Investigate this hypothesis",
      "Try this method",
    ]) {
      expect(button(name)).toBeDisabled();
      expect(button(name)).toHaveAccessibleDescription(/\S/);
    }
    expect(button("Investigate this hypothesis")).toHaveAccessibleDescription(
      "Select an occurrence in a hypothesis first.",
    );
    expect(button("Try this method")).toHaveAccessibleDescription(
      /Preview a library-result suggestion first/,
    );
    expect(button("Use this")).toHaveAccessibleDescription(/no active objective|not loaded/i);
  });

  it("investigates the selected hypothesis, then rereads the records", async () => {
    const { posts, gets } = stubFetch();
    renderPanel({
      selections: [
        selection(node, { kind: "hypothesis", id: statementIdSchema.parse("hypothesis:eps") }, [1]),
      ],
    });
    await screen.findByText(/None yet\. Select a goal/);
    const before = gets();
    fireEvent.click(button("Investigate this hypothesis"));
    expect(await screen.findByTestId("inquiry-feedback")).toHaveTextContent(
      "Recorded in this inquiry: Investigate this hypothesis.",
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("/api/proof-sessions/session%3Atest/protocol-commands");
    expect(posts[0]?.body).toMatchObject({
      actor: { id: "actor:web", kind: "human" },
      basis: { nodeId: "node:root" },
      command: {
        kind: "investigate-hypothesis",
        target: { kind: "goal", id: "goal:main" },
        hypothesis: "hypothesis:eps",
      },
    });
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
  });

  it("shows a structured refusal as an alert with its code", async () => {
    stubFetch({ commandFailure: true });
    renderPanel({
      selections: [
        selection(node, { kind: "hypothesis", id: statementIdSchema.parse("hypothesis:eps") }, [1]),
      ],
    });
    await screen.findByText(/None yet\. Select a goal/);
    fireEvent.click(button("Investigate this hypothesis"));
    const alert = await screen.findByTestId("inquiry-feedback");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(
      "Investigate this hypothesis rejected (hypothesis-not-found): The hypothesis is gone.",
    );
  });

  it("records Find sufficient conditions as an Explore question with no reason", async () => {
    const { posts } = stubFetch();
    renderPanel({ selections: [selection(node, conclusion, [])] });
    await screen.findByText(/None yet\. Select a goal/);
    fireEvent.click(button("Find sufficient conditions"));
    await screen.findByText("Recorded in this inquiry: Find sufficient conditions.");
    const command = posts[0]?.body.command as unknown as {
      records: { kind: string; question?: { form: string } }[];
    };
    expect(command.records.map(({ kind }) => kind)).toEqual(["question", "objective"]);
    expect(command.records[0]?.question?.form).toBe("explore");
    expect(JSON.stringify(posts[0]?.body)).not.toMatch(/provenance/);
  });

  it("offers Use this once an objective is active and records an attempt", async () => {
    const { posts } = stubFetch({ records: storedRecords() });
    renderPanel({
      selections: [
        selection(node, { kind: "hypothesis", id: statementIdSchema.parse("hypothesis:eps") }, [1]),
      ],
    });
    await waitFor(() => expect(button("Use this")).toBeEnabled());
    fireEvent.click(button("Use this"));
    await screen.findByText("Recorded in this inquiry: Use this.");
    expect(posts[0]?.body.command).toMatchObject({
      kind: "record-inquiry",
      records: [{ kind: "attempt", objectiveId: "objective:main", method: { kind: "manual" } }],
    });
  });

  it("constructs an object through the workspace command path and shows its refusal", async () => {
    stubFetch();
    const { runCommand } = renderPanel({ selections: [selection(node, conclusion, [])] });
    await screen.findByText(/None yet\. Select a goal/);
    fireEvent.click(button("Construct an object"));
    const alert = await screen.findByTestId("inquiry-feedback");
    expect(runCommand).toHaveBeenCalledTimes(1);
    const [action, envelope] = runCommand.mock.calls[0] as unknown as [
      string,
      { command: { kind: string; operation: { kind: string; dependencies: string[] } } },
    ];
    expect(action).toBe("Construct an object");
    expect(envelope.command.kind).toBe("kernel-operation");
    expect(envelope.command.operation).toMatchObject({
      kind: "introduce-placeholder",
      dependencies: ["eps"],
    });
    expect(alert).toHaveTextContent(
      "Construct an object rejected (not-a-result-application): The suggestion is not a result application.",
    );
  });

  it("tries the previewed library result as a theorem through the workspace command path", async () => {
    stubFetch();
    const set = {
      id: "suggestion-set:1",
      suggestions: [
        {
          id: "suggestion:1",
          source: "result",
          name: "Continuity of sums",
          artifactId: "result:c",
        },
      ],
    } as unknown as DisplayedSuggestionSet;
    const suggestions: SuggestionState = {
      kind: "ready",
      suggestionSet: set,
      transitionClasses: [],
    };
    const move = {
      kind: "previewed",
      suggestionId: "suggestion:1",
      commandId: "command:preview-1",
      preview: {},
      choices: {},
    } as unknown as MoveState;
    const { runCommand } = renderPanel({ suggestions, move });
    await waitFor(() => expect(button("Try this method")).toBeEnabled());
    runCommand.mockResolvedValueOnce({
      ok: true,
      response: {
        result: { inquiryRecords: [{}, {}, {}] },
      },
    } as unknown as ProtocolCommandOutcome);
    fireEvent.click(button("Try this method"));
    expect(await screen.findByTestId("inquiry-feedback")).toHaveTextContent(
      "Try this method started. Related inquiry details were added.",
    );
    expect(runCommand.mock.calls[0]?.[1]).toMatchObject({
      commandId: "command:preview-1",
      command: { kind: "apply", inquiryMethod: "try-result", suggestion: "suggestion:1" },
    });
  });

  it("disables every action while the workspace is mutating", async () => {
    stubFetch();
    renderPanel({ mutationPending: true, selections: [selection(node, conclusion, [])] });
    await screen.findByText(/None yet\. Select a goal/);
    expect(button("Construct an object")).toBeDisabled();
    expect(button("Find sufficient conditions")).toBeDisabled();
  });
});

// Keep the premise target referenced by fixtures used in other suites.
void PREMISE_TARGET;

describe("InquiryPanel collapsing", () => {
  it("starts collapsed while there is nothing to show, and opens for a selection", async () => {
    stubFetch();
    renderPanel();
    await screen.findByTestId("inquiry-objective");
    const details = screen.getByText(/Show inquiry details/).closest("details")!;
    expect(details).not.toHaveAttribute("open");
    cleanup();

    stubFetch();
    renderPanel({
      selections: [
        selection(node, { kind: "hypothesis", id: statementIdSchema.parse("hypothesis:eps") }, [1]),
      ],
    });
    await screen.findByTestId("inquiry-objective");
    expect(screen.getByText("Hide inquiry details").closest("details")).toHaveAttribute("open");
  });
});

describe("InquiryPanel construction actions", () => {
  it("keeps every construction action visible and says why one cannot apply", async () => {
    stubFetch();
    renderPanel({ node: makeConstructedNode() });
    const entry = await screen.findByTestId("construction-entry");
    const actions = within(entry).getByRole("group", { name: "Actions for delta" });
    for (const name of ["Add requirement", "Add candidate", "Use this candidate", "Abandon"]) {
      expect(within(actions).getByRole("button", { name })).toBeInTheDocument();
    }
    // No candidate yet, and the placeholder is still in the goal: both say so.
    const use = within(actions).getByRole("button", { name: "Use this candidate" });
    expect(use).toBeDisabled();
    expect(use).toHaveAccessibleDescription("Add a candidate for delta first.");
    const abandon = within(actions).getByRole("button", { name: "Abandon" });
    expect(abandon).toBeDisabled();
    expect(abandon).toHaveAccessibleDescription(/still occurs in the proof state/);
    expect(within(actions).getByRole("button", { name: "Add requirement" })).toBeEnabled();
    // Nothing opens, and nothing is sent, until a button is pressed.
    expect(within(entry).queryByTestId("construction-choice")).not.toBeInTheDocument();
  });

  it("adds a candidate chosen from the menu through the workspace command path", async () => {
    stubFetch();
    const { runCommand } = renderPanel({ node: makeConstructedNode() });
    const entry = await screen.findByTestId("construction-entry");
    fireEvent.click(within(entry).getByRole("button", { name: "Add candidate" }));
    const choice = within(entry).getByTestId("construction-choice");
    const record = within(choice).getByRole("button", { name: "Record candidate" });
    expect(record).toBeDisabled();
    expect(choice).toHaveTextContent("Choose one of the items above first.");
    const radios = within(choice).getAllByRole("radio");
    expect(radios.length).toBeGreaterThan(0);
    fireEvent.click(radios[0]!);
    expect(record).toBeEnabled();
    fireEvent.click(record);
    await screen.findByTestId("inquiry-feedback");
    expect(runCommand).toHaveBeenCalledTimes(1);
    const [action, envelope] = runCommand.mock.calls[0] as unknown as [
      string,
      { command: { kind: string; payloadSource: string; operation: { kind: string } } },
    ];
    expect(action).toBe("Add candidate (delta)");
    expect(envelope.command).toMatchObject({
      kind: "kernel-operation",
      payloadSource: "validated-operation",
      operation: { kind: "add-candidate" },
    });
  });

  it("explains each requirement in plain words before recording it", async () => {
    stubFetch();
    renderPanel({ node: makeConstructedNode() });
    const entry = await screen.findByTestId("construction-entry");
    fireEvent.click(within(entry).getByRole("button", { name: "Add requirement" }));
    const choice = within(entry).getByTestId("construction-choice");
    expect(choice).toHaveTextContent(/Sufficient: the proof already needs this/);
    expect(choice).toHaveTextContent(/Hint only: worth investigating; it establishes nothing/);
    fireEvent.click(within(choice).getByRole("button", { name: "Cancel" }));
    expect(within(entry).queryByTestId("construction-choice")).not.toBeInTheDocument();
  });

  it("uses a stored candidate after a confirming choice", async () => {
    stubFetch();
    const { runCommand } = renderPanel({
      node: makeConstructedNode({
        candidates: [{ id: "candidate:eps", value: "eps", attemptId: "attempt:1" }],
      }),
    });
    const entry = await screen.findByTestId("construction-entry");
    fireEvent.click(within(entry).getByRole("button", { name: "Use this candidate" }));
    const choice = within(entry).getByTestId("construction-choice");
    expect(choice).toHaveTextContent(/substituted for delta in every goal and obligation/);
    fireEvent.click(within(choice).getByRole("radio"));
    fireEvent.click(within(choice).getByRole("button", { name: "Use this candidate" }));
    await screen.findByTestId("inquiry-feedback");
    expect(runCommand.mock.calls[0]?.[0]).toBe("Use this candidate (delta)");
    expect(
      (runCommand.mock.calls[0]?.[1] as unknown as { command: { operation: { kind: string } } })
        .command.operation,
    ).toMatchObject({ kind: "resolve-placeholder", candidateId: "candidate:eps" });
  });
});
