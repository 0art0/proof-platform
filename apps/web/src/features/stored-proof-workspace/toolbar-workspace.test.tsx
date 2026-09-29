// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProofNodeSchema, type ProofNode } from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import { StoredProofWorkspace } from "./stored-proof-workspace";

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

function makeNode(id: string, goals: number): ProofNode {
  return createProofNodeSchema().parse({
    id,
    state: {
      id: id.replace("node:", "state:"),
      goals: Array.from({ length: goals }, () => ({
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
            ],
            hypotheses: [],
          },
          conclusion: { expression: "p" },
        },
      })),
      obligations: [],
    },
  });
}

const root = makeNode("node:root", 1);
const closed = makeNode("node:closed", 0);
const session = { id: "session:test", rootNodeId: root.id, currentNodeId: root.id, operators: [] };

type Route = (init: RequestInit | undefined) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((suffix) => url.endsWith(suffix));
    if (key !== undefined) return routes[key]!(init);
    if (url.endsWith("/interaction-events")) return json({ ok: true, data: {} }, 201);
    if (url.endsWith("/suggestion-sets")) {
      return json({ ok: false, error: { code: "unavailable", message: "Not in this test." } }, 503);
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function protocolResponse(commandId: string, nodeId: string) {
  return {
    commandId,
    kind: "sorry",
    actor: { id: "actor:web", kind: "human" },
    replayed: false,
    cursor: {
      nodeId,
      stateId: nodeId.replace("node:", "state:"),
      eventSequence: 0,
      inquirySequence: 0,
    },
    aliases: {
      nodeId,
      stateId: nodeId.replace("node:", "state:"),
      goals: [],
      obligations: [],
      hypotheses: [],
    },
    delta: {
      from: { nodeId: root.id, stateId: root.state.id },
      to: { nodeId, stateId: nodeId.replace("node:", "state:") },
      goals: { added: [], removed: ["goal:main"], updated: [] },
      obligations: { added: [], removed: [], updated: [] },
      assumptionsAdded: ["assumption:x"],
      assumptionsRemoved: [],
    },
    result: {},
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

describe("toolbar actions in the stored workspace", () => {
  it("sends Mark sorry through the protocol proxy and moves to the resulting node", async () => {
    let current: { session: typeof session; node: ProofNode } = { session, node: root };
    let posted: Record<string, unknown> | undefined;
    const fetchMock = stubFetch({
      "/history": () =>
        json({
          ok: true,
          data: { session: current.session, nodes: [current.node], edges: [] },
        }),
      "/protocol-commands": (init) => {
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        current = { session: { ...session, currentNodeId: closed.id }, node: closed };
        return json({ ok: true, data: protocolResponse(String(posted.commandId), closed.id) }, 201);
      },
      "/proof-sessions/session%3Atest": () =>
        json({ ok: true, data: { session: current.session, node: current.node } }),
    });
    render(<StoredProofWorkspace session={session} node={root} />);
    fireEvent.click(screen.getByRole("button", { name: "Select goal" }));
    const sorry = screen.getByRole("button", { name: "Mark sorry" });
    await waitFor(() => expect(sorry).toBeEnabled());
    fireEvent.click(sorry);

    await screen.findByText(/Mark sorry committed; now at node:closed\./);
    expect(screen.getByTestId("workspace-node")).toHaveTextContent("node:closed");
    expect(posted).toMatchObject({
      actor: { id: "actor:web", kind: "human" },
      basis: { nodeId: "node:root" },
      command: { kind: "sorry", target: { kind: "goal", id: "goal:main" } },
    });
    const commandCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/protocol-commands"),
    );
    expect(commandCall?.[0]).toBe("/api/proof-sessions/session%3Atest/protocol-commands");
    expect(commandCall?.[1]).toMatchObject({ method: "POST" });
    // The selection of the old snapshot no longer applies.
    expect(screen.getByRole("button", { name: "Mark sorry" })).toBeDisabled();
  });

  it("shows a stale-basis refusal as a readable message and keeps the node", async () => {
    stubFetch({
      "/history": () => json({ ok: true, data: { session, nodes: [root], edges: [] } }),
      "/protocol-commands": () =>
        json(
          {
            ok: false,
            error: {
              code: "stale-alias",
              message: "The command was based on node node:root, but the session is at node:other.",
            },
            details: {
              diagnostics: [
                {
                  code: "stale-alias",
                  message:
                    "The command was based on node node:root, but the session is at node:other.",
                },
              ],
            },
          },
          409,
        ),
    });
    render(<StoredProofWorkspace session={session} node={root} />);
    fireEvent.click(screen.getByRole("button", { name: "Select goal" }));
    const split = screen.getByRole("button", { name: "Case split on selection" });
    await waitFor(() => expect(split).toBeEnabled());
    fireEvent.click(split);
    expect(
      await screen.findByText(
        "Case split rejected (stale-alias): The command was based on node node:root, but the session is at node:other. The session changed since this view was loaded; reload the workspace and try again.",
      ),
    ).toHaveAttribute("data-state", "rejected");
    expect(screen.getByTestId("workspace-node")).toHaveTextContent("node:root");
  });

  it("reports an unreachable proof service instead of failing silently", async () => {
    stubFetch({
      "/history": () => json({ ok: true, data: { session, nodes: [root], edges: [] } }),
      "/protocol-commands": () => {
        throw new TypeError("network down");
      },
    });
    render(<StoredProofWorkspace session={session} node={root} />);
    fireEvent.click(screen.getByRole("button", { name: "Select goal" }));
    const sorry = screen.getByRole("button", { name: "Mark sorry" });
    await waitFor(() => expect(sorry).toBeEnabled());
    fireEvent.click(sorry);
    expect(
      await screen.findByText(
        "Mark sorry rejected (unavailable): The proof service could not be reached. Try again once the proof service is available.",
      ),
    ).toBeVisible();
  });
});
