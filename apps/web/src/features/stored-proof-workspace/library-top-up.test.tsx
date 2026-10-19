// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnchoredProofSelection } from "@proof/selections";
import { describeTopUpFailure, describeTopUpOutcome } from "./library-top-up-contract";
import { TopUpNotice, useLibraryTopUp } from "./library-top-up";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ACTIVATION = {
  symbol: "Gcd",
  edgeId: "edge:1",
  nodeId: "node:1",
  resultId: "result:library-gcd",
  sequence: 1,
  topUp: null,
};
function constants(activated: readonly unknown[] = []) {
  return {
    ok: true,
    data: {
      sessionId: "session:a",
      readOnly: false,
      active: ["Divides"],
      dormant: [],
      activated,
    },
  };
}
const TOPPED_UP = {
  ok: true,
  data: {
    status: "topped-up",
    requestKind: "new-constants",
    addedCount: 2,
    added: [
      { id: "result:one", name: "One" },
      { id: "result:two", name: "Two" },
    ],
    rejected: [],
  },
};

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };

/** Answer the constants read and the top-up route; every request is recorded. */
function stubWorker(options: {
  activated?: () => readonly unknown[];
  topUp?: () => Response | Promise<Response>;
}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/library/constants")) {
        return jsonResponse(constants(options.activated?.() ?? []));
      }
      return options.topUp?.() ?? jsonResponse(TOPPED_UP);
    }),
  );
  return calls;
}
const topUpCalls = (calls: readonly Call[]) =>
  calls.filter(({ url }) => url.endsWith("/ai-library-top-up"));

function Harness({
  enabled = true,
  initialNode = "node:1",
  selections = [],
}: Readonly<{
  enabled?: boolean;
  initialNode?: string;
  selections?: readonly AnchoredProofSelection[];
}>) {
  const [nodeId, setNodeId] = useState(initialNode);
  const topUp = useLibraryTopUp({
    sessionId: "session:a",
    nodeId,
    enabled,
    createId: (prefix) => `${prefix}-fixed`,
  });
  return (
    <div>
      <button type="button" onClick={() => setNodeId(`${nodeId}+`)}>
        Move on
      </button>
      <button type="button" onClick={() => void topUp.findMoreResults(selections)}>
        Find
      </button>
      <TopUpNotice status={topUp.status} />
      <output data-testid="status">{topUp.status.kind}</output>
    </div>
  );
}

const SELECTION: AnchoredProofSelection = {
  kind: "exact",
  anchor: {
    stateId: "state:a" as never,
    target: { kind: "goal", id: "goal:a" as never },
    statement: { kind: "conclusion" },
  },
  path: [0],
};

describe("automatic new-constants top-up", () => {
  it("asks once for each constant a step activated, silently, and says only what it added", async () => {
    const calls = stubWorker({ activated: () => [ACTIVATION] });
    render(<Harness />);

    expect(await screen.findByText(/The library now has 2 results about Gcd/)).toBeVisible();
    expect(topUpCalls(calls)).toHaveLength(1);
    expect(topUpCalls(calls)[0]).toMatchObject({
      method: "POST",
      url: "/api/proof-sessions/session%3Aa/ai-library-top-up",
      body: { id: "llm-call:new-constants-fixed", kind: "new-constants", constants: ["Gcd"] },
    });
    // There is no "Looking for more results…": the request ran in the background.
    expect(screen.queryByText("Looking for more results…")).toBeNull();

    // Another step re-reads the constants but asks nothing more about the same constant.
    fireEvent.click(screen.getByRole("button", { name: "Move on" }));
    await waitFor(() =>
      expect(calls.filter(({ url }) => url.endsWith("/library/constants"))).toHaveLength(2),
    );
    expect(topUpCalls(calls)).toHaveLength(1);
  });

  it("asks about nothing that a recorded top-up already covered", async () => {
    const calls = stubWorker({
      activated: () => [{ ...ACTIVATION, topUp: { callId: "llm-call:x" } }],
    });
    render(<Harness />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(topUpCalls(calls)).toHaveLength(0);
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
  });

  it("sends nothing when the librarian is unavailable or the session is read-only", async () => {
    const calls = stubWorker({ activated: () => [ACTIVATION] });
    render(<Harness enabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Move on" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(0);
  });

  it.each([
    [
      "a rate limit",
      429,
      { ok: false, error: { code: "ai-rate-limited", message: "Retry later." } },
    ],
    ["a disabled role", 503, { ok: false, error: { code: "ai-disabled", message: "Off." } }],
    ["a stale answer", 409, { ok: false, error: { code: "stale-evidence", message: "Moved." } }],
    [
      "nothing left to cover",
      409,
      { ok: false, error: { code: "no-new-constants", message: "None." } },
    ],
  ])("falls back silently on %s", async (_label, status, answer) => {
    const calls = stubWorker({
      activated: () => [ACTIVATION],
      topUp: () => jsonResponse(answer, status),
    });
    render(<Harness />);
    await waitFor(() => expect(topUpCalls(calls)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    expect(screen.queryByTestId("library-top-up-status")).toBeNull();
  });

  it("says nothing when the top-up added nothing, or answered with a refusal", async () => {
    for (const answer of [
      { ok: true, data: { ...TOPPED_UP.data, addedCount: 0, added: [] } },
      { ok: true, data: { status: "declined", result: { reason: "Covered." } } },
    ]) {
      cleanup();
      const calls = stubWorker({
        activated: () => [ACTIVATION],
        topUp: () => jsonResponse(answer),
      });
      render(<Harness />);
      await waitFor(() => expect(topUpCalls(calls)).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.queryByTestId("library-top-up-status")).toBeNull();
    }
  });

  it("does not update anything when the page is gone before the answer arrives", async () => {
    let release: (response: Response) => void = () => undefined;
    const calls = stubWorker({
      activated: () => [ACTIVATION],
      topUp: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    const view = render(<Harness />);
    await waitFor(() => expect(topUpCalls(calls)).toHaveLength(1));
    view.unmount();
    release(jsonResponse(TOPPED_UP));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(topUpCalls(calls)).toHaveLength(1);
  });

  it("survives an unreachable service and an unreadable answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    render(<Harness />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, data: { nonsense: 1 } })),
    );
    render(<Harness />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
  });
});

describe("find more results", () => {
  it("announces the request, then what was added, and sends the concrete selections", async () => {
    let release: (response: Response) => void = () => undefined;
    const calls = stubWorker({
      topUp: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    render(<Harness selections={[SELECTION]} />);
    fireEvent.click(screen.getByRole("button", { name: "Find" }));

    expect(await screen.findByText("Looking for more results…")).toBeVisible();
    release(
      jsonResponse({ ok: true, data: { ...TOPPED_UP.data, requestKind: "no-relevant-results" } }),
    );
    expect(
      await screen.findByText(
        "Added 2 results to the library. Ask for suggestions again to use them.",
      ),
    ).toBeVisible();
    expect(topUpCalls(calls)[0]).toMatchObject({
      method: "POST",
      body: {
        id: "llm-call:find-more-fixed",
        kind: "no-relevant-results",
        expectedCurrentNodeId: "node:1",
        selections: [{ kind: "exact", anchor: SELECTION.anchor, path: [0] }],
      },
    });
    expect(topUpCalls(calls)[0]?.body?.["selections"]).toEqual([
      { kind: "exact", anchor: SELECTION.anchor, path: [0] },
    ]);
  });

  it("ignores a second request while one is running", async () => {
    let release: (response: Response) => void = () => undefined;
    const calls = stubWorker({
      topUp: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    render(<Harness selections={[SELECTION]} />);
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await screen.findByText("Looking for more results…");
    expect(topUpCalls(calls)).toHaveLength(1);
    release(jsonResponse(TOPPED_UP));
    await screen.findByText(/Added 2 results/);
  });

  it("asks the user to select something first when nothing is selected", async () => {
    const calls = stubWorker({});
    render(<Harness selections={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(
      await screen.findByText("Select part of the statement first, then ask for more results."),
    ).toBeVisible();
    expect(topUpCalls(calls)).toHaveLength(0);
  });

  it.each([
    [429, { ok: false, error: { code: "ai-rate-limited", message: "x" } }, /Too many AI requests/],
    [503, { ok: false, error: { code: "ai-disabled", message: "x" } }, /unavailable right now/],
    [409, { ok: false, error: { code: "session-read-only", message: "x" } }, /read-only/],
    [409, { ok: false, error: { code: "stale-evidence", message: "x" } }, /moved on/],
    [
      409,
      {
        ok: false,
        error: { code: "background-undeclared", message: "Revise the background first." },
      },
      /Revise the background first\./,
    ],
  ])("explains a %s plainly", async (status, answer, expected) => {
    stubWorker({ topUp: () => jsonResponse(answer, status) });
    render(<Harness selections={[SELECTION]} />);
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText(expected)).toBeVisible();
    expect(screen.getByTestId("status")).toHaveTextContent("failed");
  });

  it("reports an unreachable service and an unreadable answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    render(<Harness selections={[SELECTION]} />);
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText("The proof service could not be reached.")).toBeVisible();
    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true, data: { nonsense: 1 } })),
    );
    render(<Harness selections={[SELECTION]} />);
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(
      await screen.findByText("The proof service returned an invalid response."),
    ).toBeVisible();
  });
});

describe("what the page says", () => {
  it("words a top-up outcome", () => {
    const base = {
      status: "topped-up" as const,
      requestKind: "no-relevant-results" as const,
      rejected: [],
    };
    expect(
      describeTopUpOutcome({ ...base, addedCount: 1, added: [{ id: "r", name: "R" }] }),
    ).toEqual({
      added: 1,
      message: "Added 1 result to the library. Ask for suggestions again to use it.",
    });
    expect(describeTopUpOutcome({ ...base, addedCount: 0, added: [] }).message).toBe(
      "No new results were added: the library already covers this.",
    );
    expect(
      describeTopUpOutcome({
        ...base,
        addedCount: 0,
        added: [],
        rejected: [{ id: "r", name: "R", reasons: ["This repeats the library result Foo."] }],
      }).message,
    ).toBe("No new results were added: this repeats the library result Foo.");
    expect(
      describeTopUpOutcome({ status: "declined", result: { reason: "Nothing to add." } }),
    ).toEqual({ added: 0, message: "No new results were added: nothing to add." });
    expect(describeTopUpOutcome({ status: "insufficient-context", result: {} }).message).toMatch(
      /needs more detail/,
    );
    expect(describeTopUpFailure(500, "x", "The worker's words.")).toBe("The worker's words.");
  });
});
