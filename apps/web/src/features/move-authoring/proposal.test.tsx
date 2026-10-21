// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProofNode } from "@proof/protocol";
import { MoveAuthoring } from "./move-authoring";
import { fixtureHistory } from "./history-fixture.testing";
import {
  proposalHref,
  readStashedMoveProposal,
  stashMoveProposal,
  type MoveProposal,
} from "./proposal-contract";
import { FAILING_VALIDATION, proposedAnswer, proposedTemplate } from "./proposal.testing";
import type { AuthoredMoves } from "./api-contract";

/** The existing authoring form, prefilled from a model's proposal ("Save as reusable move"). */

vi.mock("../proof-workspace", () => ({
  ProofWorkspace: ({ node }: { node: ProofNode }) => (
    <span data-testid="workspace-node">{node.id}</span>
  ),
}));

const history = fixtureHistory();
const SESSION_ID = "session:test";
const session = { id: SESSION_ID, operators: [] } as const;
const PROPOSAL_ID = "llm-call:author-1";

type Route = (init: RequestInit | undefined, url: string) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const EMPTY_MOVES: AuthoredMoves = { sessionId: SESSION_ID, moves: [] };

function stubFetch(routes: Readonly<Record<string, Route>> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((suffix) => url.endsWith(suffix));
    if (key !== undefined) return routes[key]!(init, url);
    if (url.endsWith("/history")) {
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

const bodyOf = (init: RequestInit | undefined) =>
  JSON.parse(String(init?.body)) as Record<string, unknown>;

function committed(commandId: string, result: Record<string, unknown>) {
  const cursor = {
    nodeId: "node:contraposition-root",
    stateId: "state:contraposition-root",
    eventSequence: 0,
    inquirySequence: 0,
  };
  return {
    commandId,
    kind: "author-move-draft",
    actor: { id: "actor:web", kind: "human" },
    replayed: false,
    cursor,
    aliases: {
      nodeId: cursor.nodeId,
      stateId: cursor.stateId,
      goals: [],
      obligations: [],
      hypotheses: [],
    },
    delta: {
      from: { nodeId: cursor.nodeId, stateId: cursor.stateId },
      to: { nodeId: cursor.nodeId, stateId: cursor.stateId },
      goals: { added: [], removed: [], updated: [] },
      obligations: { added: [], removed: [], updated: [] },
      assumptionsAdded: [],
      assumptionsRemoved: [],
    },
    result,
  };
}

function stash(overrides: Record<string, unknown> = {}) {
  stashMoveProposal(SESSION_ID, proposedAnswer(overrides) as unknown as MoveProposal);
}

beforeEach(() => {
  window.sessionStorage.clear();
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

async function open(props: Partial<Parameters<typeof MoveAuthoring>[0]> = {}) {
  render(<MoveAuthoring session={session} proposalId={PROPOSAL_ID} canRevise {...props} />);
  await screen.findByTestId("move-proposal");
}

describe("opening a model's proposal in the authoring form", () => {
  it("prefills the existing form: name, description, pattern, plan, class and examples", async () => {
    stubFetch();
    stash();
    await open();
    expect(screen.getByTestId("draft-source")).toHaveTextContent("the model's proposal");
    expect(screen.getByLabelText("Name")).toHaveValue("Prove the contrapositive");
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Reduce an implication goal to the implication between the negations of its parts.",
    );
    expect(screen.getByTestId("move-id")).toHaveTextContent(
      "authored:prove-the-contrapositive-331fedf4",
    );
    const patterns = screen.getByRole("region", { name: "Patterns" });
    expect(within(patterns).getByText("Implies(A, B)")).toBeInTheDocument();
    const plan = screen.getByRole("region", { name: "Plan" });
    expect(within(plan).getByText("Suffices to show", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByLabelText("This move is")).toHaveValue("strengthening");
    const examples = screen.getByRole("region", { name: "Examples" });
    expect(examples).toHaveTextContent("The source situation");
    // The form is the ordinary one: editing works and saving is the ordinary action.
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("shows the motivation, the honest classification and the kernel's result per example", async () => {
    stubFetch();
    stash();
    await open();
    const panel = screen.getByTestId("move-proposal");
    expect(screen.getByTestId("proposal-motivation")).toHaveTextContent(
      "The user replaced the goal A implies B by its contrapositive.",
    );
    const classification = screen.getByTestId("proposal-classification");
    expect(classification).toHaveAttribute("data-kind", "macro");
    expect(classification).toHaveTextContent("A macro.");
    expect(classification).toHaveTextContent("The model says: One suffices step");
    expect(screen.getByTestId("proposal-validation")).toHaveTextContent(
      "Every example behaves as stated.",
    );
    for (const id of ["example:source", "example:compound", "example:not-an-implication"]) {
      const line = within(panel).getByText(id, { selector: "strong" }).closest("li")!;
      expect(line).toHaveAttribute("data-ok", "true");
      expect(line).toHaveTextContent("As expected.");
    }
    expect(within(panel).queryByRole("dialog")).toBeNull();
  });

  it("shows validation failures plainly, beside the example they concern, and keeps the form editable", async () => {
    stubFetch();
    stash({ validation: FAILING_VALIDATION });
    await open();
    expect(screen.getByTestId("proposal-validation")).toHaveTextContent(
      "The move does not pass validation yet (1 problem).",
    );
    const line = within(screen.getByTestId("move-proposal"))
      .getByText("example:compound", { selector: "strong" })
      .closest("li")!;
    expect(line).toHaveAttribute("data-ok", "false");
    expect(line).toHaveTextContent("Example outcome differs");
    expect(line).toHaveTextContent("differs from the expected one");
    expect(screen.getByLabelText("Name")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
  });

  it("lists generality notes for the reviewer without treating them as failures", async () => {
    stubFetch();
    stash({
      generality: [
        {
          code: "examples-alike",
          message: "Every positive example has the same shape up to renaming symbols.",
        },
      ],
    });
    await open();
    expect(screen.getByTestId("proposal-generality")).toHaveTextContent(
      "same shape up to renaming symbols",
    );
    expect(screen.getByTestId("proposal-validation")).toHaveTextContent(
      "Every example behaves as stated.",
    );
  });

  it("says plainly when the proposal is no longer available in this tab", async () => {
    stubFetch();
    render(<MoveAuthoring session={session} proposalId="llm-call:gone" canRevise />);
    expect(await screen.findByTestId("proposal-missing")).toHaveTextContent(
      /no longer available in this browser tab/,
    );
    expect(screen.queryByTestId("move-proposal")).toBeNull();
  });
});

describe("submitting through the existing command", () => {
  it("saves the (possibly edited) template as an author-move-draft that names both calls", async () => {
    let envelope: Record<string, unknown> | undefined;
    stubFetch({
      "/protocol-commands": (init) => {
        envelope = bodyOf(init);
        return json(
          {
            ok: true,
            data: committed(String(envelope["commandId"]), {
              artifactId: "authored:prove-the-contrapositive-331fedf4.draft.x",
              moveId: "authored:prove-the-contrapositive-331fedf4",
              revision: 1,
              definitionDigest: `sha256:${"0".repeat(64)}`,
              provenance: { kind: "generated", role: "move-author" },
              status: "draft",
              validation: { ok: true, report: {} },
            }),
          },
          201,
        );
      },
    });
    stash();
    await open();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Prove the contrapositive (edited)" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    expect(envelope).toMatchObject({
      actor: { id: "actor:web", kind: "human" },
      command: {
        kind: "author-move-draft",
        payloadSource: "reviewed-authoring",
        template: { name: "Prove the contrapositive (edited)" },
        proposal: {
          role: "move-author",
          callId: PROPOSAL_ID,
          executorCallId: "llm-call:execute-1",
        },
      },
    });
    expect(await screen.findByTestId("authoring-notice")).toHaveTextContent(
      "linked to the model's proposal",
    );
  });

  it("drops the link when the move is started from something else", async () => {
    let envelope: Record<string, unknown> | undefined;
    stubFetch({
      "/protocol-commands": (init) => {
        envelope = bodyOf(init);
        return json({ ok: false, error: { code: "invalid-template", message: "x" } }, 422);
      },
    });
    stash();
    await open();
    await screen.findByLabelText("Kernel operation");
    fireEvent.change(screen.getByLabelText("Kernel operation"), {
      target: { value: "move:split-goal-conjunction" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start from this primitive" }));
    expect(screen.queryByTestId("move-proposal")).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Split" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Split it." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    });
    const command = envelope?.["command"] as Record<string, unknown>;
    expect(command["kind"]).toBe("author-move-draft");
    expect(command).not.toHaveProperty("proposal");
  });

  it("cannot be saved while the model classes it as a new principle", async () => {
    stubFetch();
    stash({
      classification: { kind: "principle", rationale: "It needs a new lemma." },
      blocked: { code: "principle-not-a-move", message: "A move cannot add a result." },
    });
    await open();
    expect(screen.getByTestId("proposal-classification")).toHaveAttribute("data-kind", "principle");
    expect(screen.getByTestId("proposal-blocked")).toHaveTextContent("A move cannot add a result.");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Save" })).toHaveTextContent(
      /new mathematical principle/,
    );
  });
});

describe("revising with feedback", () => {
  const revised = () =>
    proposedAnswer({
      callId: "llm-call:author-2",
      revisedCallId: PROPOSAL_ID,
      motivation: "Revised: the antecedent may be a conjunction.",
    });

  it("asks for a revision of the stored proposal and replaces the form with the answer", async () => {
    let request: Record<string, unknown> | undefined;
    stubFetch({
      "/ai-move-author": (init) => {
        request = bodyOf(init);
        return json({ ok: true, data: revised() });
      },
    });
    stash();
    await open();
    const revise = screen.getByRole("button", { name: "Revise with feedback" });
    expect(revise).toBeDisabled();
    expect(screen.getByTestId("move-proposal")).toHaveTextContent("Say what to change first.");
    fireEvent.change(screen.getByLabelText("What should change?"), {
      target: { value: "Also allow a conjunction." },
    });
    expect(revise).toBeEnabled();
    await act(async () => {
      fireEvent.click(revise);
    });
    expect(request).toEqual({
      id: "llm-call:author-00000000-0000-4000-8000-000000000001",
      executorCallId: "llm-call:execute-1",
      revision: { previousCallId: PROPOSAL_ID, feedback: "Also allow a conjunction." },
    });
    expect(screen.getByTestId("proposal-motivation")).toHaveTextContent(
      "Revised: the antecedent may be a conjunction.",
    );
    expect(screen.getByTestId("authoring-notice")).toHaveTextContent("revised proposal");
    // The address follows the open proposal, so a reload opens the same one.
    expect(window.location.search).toBe("?proposal=llm-call%3Aauthor-2");
  });

  it("keeps the current proposal and says why when the revision fails or is declined", async () => {
    stubFetch({
      "/ai-move-author": () =>
        json({ ok: false, error: { code: "ai-rate-limited", message: "Retry later." } }, 429),
    });
    stash();
    await open();
    fireEvent.change(screen.getByLabelText("What should change?"), { target: { value: "More." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revise with feedback" }));
    });
    expect(screen.getByTestId("revision-failure")).toHaveTextContent(/Too many AI requests/);
    expect(screen.getByTestId("proposal-motivation")).toHaveTextContent(
      "The user replaced the goal A implies B by its contrapositive.",
    );
  });

  it("is disabled, with the reason, when no provider is configured or the session is read-only", async () => {
    stubFetch();
    stash();
    await open({ canRevise: false });
    expect(screen.getByRole("button", { name: "Revise with feedback" })).toBeDisabled();
    expect(screen.getByTestId("move-proposal")).toHaveTextContent(
      "Revising is unavailable: no AI provider is configured for this service.",
    );
    cleanup();
    stash();
    await open({ session: { ...session, readOnly: true } });
    expect(screen.getByTestId("move-proposal")).toHaveTextContent(/read-only/);
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
  });
});

describe("a saved draft that a model proposed", () => {
  const generated = {
    kind: "generated",
    role: "move-author",
    contextId: PROPOSAL_ID,
    sourceContextId: "llm-call:execute-1",
  };
  const savedMoves = (): AuthoredMoves => ({
    sessionId: SESSION_ID,
    moves: [
      {
        moveId: "authored:prove-the-contrapositive-331fedf4",
        name: "Prove the contrapositive",
        retrievable: false,
        revisions: [
          {
            draftArtifactId: "authored:prove-the-contrapositive-331fedf4.draft.x",
            provenance: generated,
            revision: 1,
            authorId: "actor:web",
            status: "draft",
            definitionDigest: `sha256:${"0".repeat(64)}`,
            template: proposedTemplate(),
          },
        ],
      },
    ],
  });

  it("shows where it came from, and a revision in the editor keeps the link", async () => {
    let envelope: Record<string, unknown> | undefined;
    stubFetch({
      "/authored-moves": () => json({ ok: true, data: savedMoves() }),
      "/protocol-commands": (init) => {
        envelope = bodyOf(init);
        return json({ ok: false, error: { code: "invalid-template", message: "x" } }, 422);
      },
    });
    render(<MoveAuthoring session={session} />);
    const provenance = await screen.findByTestId("revision-provenance");
    expect(provenance).toHaveTextContent("Proposed by a model");
    expect(provenance).toHaveTextContent(PROPOSAL_ID);
    expect(provenance).toHaveTextContent("llm-call:execute-1");
    expect(provenance).toHaveTextContent("approves nothing");
    fireEvent.click(screen.getByRole("button", { name: /Revise revision 1/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Save draft" }));
    });
    expect(envelope?.["command"]).toMatchObject({
      proposal: { role: "move-author", callId: PROPOSAL_ID, executorCallId: "llm-call:execute-1" },
    });
  });
});

describe("the hand-over from the workspace", () => {
  it("builds the authoring address and keeps only a proposal that still parses", () => {
    expect(proposalHref("/sessions/session%3Aa/moves", "llm-call:author-1")).toBe(
      "/sessions/session%3Aa/moves?proposal=llm-call%3Aauthor-1",
    );
    expect(readStashedMoveProposal(SESSION_ID, "llm-call:none")).toBeUndefined();
    window.sessionStorage.setItem(
      "proof-platform:move-proposal:session:test:llm-call:bad",
      JSON.stringify({ status: "proposed" }),
    );
    expect(readStashedMoveProposal(SESSION_ID, "llm-call:bad")).toBeUndefined();
    window.sessionStorage.setItem("proof-platform:move-proposal:session:test:llm-call:text", "{");
    expect(readStashedMoveProposal(SESSION_ID, "llm-call:text")).toBeUndefined();
    stash();
    expect(readStashedMoveProposal(SESSION_ID, PROPOSAL_ID)?.callId).toBe(PROPOSAL_ID);
  });
});
