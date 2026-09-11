// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  type DisplayedSuggestionSet,
} from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import { proofStateIdSchema } from "@proof/mathjson-model";
import { StoredProofWorkspace } from "./stored-proof-workspace";

vi.mock("../proof-workspace", () => ({
  ProofWorkspace: ({
    onSelectionChange,
  }: {
    onSelectionChange: (selections: readonly AnchoredProofSelection[]) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onSelectionChange([exactSelection([0])])}>
        Select first
      </button>
      <button
        type="button"
        onClick={() => onSelectionChange([exactSelection([1]), exactSelection([2])])}
      >
        Select pair
      </button>
      <button type="button" onClick={() => onSelectionChange([staleSelection()])}>
        Select stale
      </button>
      <button type="button" onClick={() => onSelectionChange([malformedAssociativeSelection()])}>
        Select malformed
      </button>
      <button type="button" onClick={() => onSelectionChange([])}>
        Clear
      </button>
    </div>
  ),
}));

const node = createProofNodeSchema().parse({
  id: "node:test",
  state: {
    id: "state:test",
    goals: [
      {
        id: "goal:test",
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
          conclusion: { expression: ["And", "p", "p", "q"] },
        },
      },
    ],
    obligations: [],
  },
});

const session = { id: "session:test", currentNodeId: node.id, operators: [] } as const;
let uuid = 0;

beforeEach(() => {
  uuid = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
    () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function anchor(stateId: AnchoredProofSelection["anchor"]["stateId"] = node.state.id) {
  return {
    stateId,
    target: { kind: "goal", id: node.state.goals[0]!.id },
    statement: { kind: "conclusion" },
  } as const;
}

function exactSelection(path: readonly number[]): AnchoredProofSelection {
  return { kind: "exact", anchor: anchor(), path };
}

function staleSelection(): AnchoredProofSelection {
  return { kind: "exact", anchor: anchor(proofStateIdSchema.parse("state:old")), path: [0] };
}

function malformedAssociativeSelection(): AnchoredProofSelection {
  return {
    kind: "associative",
    anchor: anchor(),
    containerPath: [],
    startOperand: 0,
    endOperand: 1,
  };
}

function suggestionSet(id: string, name: string, artifactId: string): DisplayedSuggestionSet {
  return displayedSuggestionSetSchema.parse({
    id,
    nodeId: node.id,
    stateId: node.state.id,
    selection: {
      kind: "exact",
      anchor: anchor(),
      path: [0],
      fragment: "p",
      declarations: node.state.goals[0]?.sequent.context.declarations ?? [],
      position: { polarity: "positive", role: "proposition" },
    },
    suggestions: [
      {
        id: `suggestion:${artifactId}`,
        source: "result",
        artifactId,
        patternId: `pattern:${artifactId}`,
        name,
        exactRepresentationMatch: true,
        substitutions: [],
        rank: [0],
        reasons: [`Reason for ${name}`, `Second reason for ${name}`],
        selectionMatches: [
          { selectionId: "selection:primary", patternId: `pattern:${artifactId}` },
        ],
        unresolvedSelectionSlots: [],
        unresolvedParameters: [],
        applicability: "applicable",
        abstractionFit: "not-used",
      },
    ],
    variantGroups: [],
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("StoredProofWorkspace", () => {
  it("rejects malformed anchors and marks stale anchors without making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<StoredProofWorkspace session={session} node={node} />);

    fireEvent.click(screen.getByRole("button", { name: "Select malformed" }));
    expect(screen.getByRole("status")).toHaveTextContent("could not be encoded safely");

    fireEvent.click(screen.getByRole("button", { name: "Select stale" }));
    expect(screen.getByRole("status")).toHaveTextContent("Stale selection");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains server order and reasons without client-side reranking", async () => {
    const set = suggestionSet("suggestion-set:ordered", "Server first", "result:first");
    const second = {
      ...set.suggestions[0],
      id: "suggestion:second",
      artifactId: "result:second",
      patternId: "pattern:second",
      name: "Server second",
      rank: [-1],
      reasons: ["Server-supplied second reason"],
      selectionMatches: [{ selectionId: "selection:primary", patternId: "pattern:second" }],
    };
    const ordered = displayedSuggestionSetSchema.parse({
      ...set,
      suggestions: [set.suggestions[0], second],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ ok: true, data: { suggestionSet: ordered, replayed: false } }),
      ),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));

    const list = await screen.findByTestId("suggestion-list");
    expect([...list.querySelectorAll("h3")].map(({ textContent }) => textContent)).toEqual([
      "Server first",
      "Server second",
    ]);
    expect(screen.getByText("Server-supplied second reason")).toBeVisible();
  });

  it("shows a stale state when the service rejects an outdated snapshot anchor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            ok: false,
            error: {
              code: "suggestion-set-rejected",
              message: "Selection state state:test does not match proof state state:next.",
            },
          },
          400,
        ),
      ),
    );
    render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Stale selection"));
  });

  it("ignores a delayed superseded success that arrives after the newer response", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<StoredProofWorkspace session={session} node={node} />);

    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    fireEvent.click(screen.getByRole("button", { name: "Select pair" }));
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { id: string };
    second.resolve(
      jsonResponse({
        ok: true,
        data: {
          suggestionSet: suggestionSet(secondRequest.id, "New response", "result:new"),
          replayed: false,
        },
      }),
    );
    await screen.findByText("New response");

    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { id: string };
    await act(async () => {
      first.resolve(
        jsonResponse({
          ok: true,
          data: {
            suggestionSet: suggestionSet(firstRequest.id, "Old response", "result:old"),
            replayed: false,
          },
        }),
      );
      await first.promise;
    });
    expect(screen.getByText("New response")).toBeVisible();
    expect(screen.queryByText("Old response")).not.toBeInTheDocument();
  });

  it("ignores late failures and clears a pending menu when the snapshot changes", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending.promise),
    );
    const { rerender } = render(<StoredProofWorkspace session={session} node={node} />);
    fireEvent.click(screen.getByRole("button", { name: "Select first" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading suggestions");

    const nextNode = createProofNodeSchema().parse({
      ...node,
      id: "node:next",
      state: { ...node.state, id: "state:next" },
    });
    rerender(
      <StoredProofWorkspace session={{ ...session, currentNodeId: nextNode.id }} node={nextNode} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Select one or more");

    await act(async () => {
      pending.resolve(
        jsonResponse(
          { ok: false, error: { code: "suggestion-set-rejected", message: "Late rejection" } },
          400,
        ),
      );
      await pending.promise;
    });
    await waitFor(() => expect(screen.getByRole("status")).not.toHaveTextContent("Late rejection"));
  });
});
