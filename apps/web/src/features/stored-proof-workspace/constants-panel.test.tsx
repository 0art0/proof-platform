// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperatorDeclaration } from "@proof/protocol";
import { ConstantsPanel, describeConstant } from "./constants-panel";
import type { LibraryConstants } from "./library-top-up-contract";
import { useSessionConstants } from "./use-session-constants";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const INTEGER = { kind: "named", id: "sort:integer" };
const operator = (symbol: string, displayName?: string): OperatorDeclaration =>
  ({
    id: `operator:${symbol.toLowerCase()}`,
    symbol,
    signature: { parameters: [INTEGER, INTEGER], result: INTEGER },
    ...(displayName === undefined
      ? {}
      : {
          presentation: {
            displayName,
            latex: {
              template: `\\operatorname{${symbol.toLowerCase()}}\\left(#1, #2\\right)`,
              precedence: "atom",
              parse: {
                trigger: `\\operatorname{${symbol.toLowerCase()}}`,
                notation: "function",
              },
            },
            naturalLanguage: [{ template: `the ${symbol} of #1 and #2`, proposition: false }],
          },
        }),
  }) as unknown as OperatorDeclaration;

const DIVIDES = operator("Divides");
const GCD = operator("Gcd", "greatest common divisor");
const LCM = operator("Lcm", "least common multiple");

function activation(symbol: string, resultName: string | null = "Gcd divides") {
  return {
    symbol,
    sequence: 1,
    commandId: "command:1",
    edgeId: "edge:1",
    nodeId: "node:1",
    resultId: "result:gcd",
    resultName,
    transitionSequence: 1,
    activatedAt: "2026-10-19T10:00:00.000Z",
    topUp: null,
  };
}

function constants(overrides: Partial<LibraryConstants> = {}): LibraryConstants {
  return {
    sessionId: "session:a",
    readOnly: false,
    active: [{ symbol: "Divides", origin: "setup", operator: DIVIDES }],
    available: [
      {
        symbol: "Lcm",
        operator: LCM,
        results: [
          { id: "result:one", name: "Lcm one" },
          { id: "result:two", name: "Lcm two" },
          { id: "result:three", name: "Lcm three" },
          { id: "result:four", name: "Lcm four" },
        ],
      },
    ],
    activated: [],
    ...overrides,
  };
}

describe("ConstantsPanel", () => {
  it("lists the constants in use with their notation and name, and the available ones quietly", () => {
    render(<ConstantsPanel view={{ kind: "ready", constants: constants(), added: [] }} />);
    const panel = screen.getByTestId("constants-panel");
    expect(panel).toHaveTextContent("Constants 1 in use, 1 more available");
    const inUse = within(panel).getByRole("list", { name: "Constants in use" });
    const divides = within(inUse).getByText("Divides").closest("li")!;
    expect(divides).toHaveAttribute("data-origin", "setup");
    expect(divides).toHaveTextContent("from the problem setup");
    expect(divides.querySelector("[data-latex]")).not.toBeNull();

    const available = within(panel).getByRole("list", {
      name: "Constants available from the library",
    });
    const lcm = within(available).getByText("least common multiple").closest("li")!;
    expect(lcm).toHaveTextContent("used by ‘Lcm one’, ‘Lcm two’ and ‘Lcm three’ and 1 more");
    expect(
      within(panel).getByRole("heading", { name: "Available from the library" }),
    ).toBeInTheDocument();
  });

  it("marks a constant a step added, names the result, and announces it briefly", () => {
    render(
      <ConstantsPanel
        view={{
          kind: "ready",
          constants: constants({
            active: [
              { symbol: "Divides", origin: "setup", operator: DIVIDES },
              { symbol: "Gcd", origin: "activated", operator: GCD },
            ],
            available: [],
            activated: [activation("Gcd")],
          }),
          added: ["Gcd"],
        }}
      />,
    );
    const item = screen.getByText("greatest common divisor").closest("li")!;
    expect(item).toHaveAttribute("data-origin", "activated");
    expect(item).toHaveAttribute("data-new", "true");
    expect(item).toHaveTextContent("added when ‘Gcd divides’ was applied");
    expect(screen.getByTestId("constants-added")).toHaveTextContent(
      "A constant was added to this proof: ‘greatest common divisor’, by applying ‘Gcd divides’.",
    );
    expect(screen.getByTestId("constants-new-mark")).toHaveTextContent("new");
    // The other constants are not highlighted.
    expect(screen.getByText("Divides").closest("li")).not.toHaveAttribute("data-new");
  });

  it("says plainly when the result that added a constant is not known, and names several at once", () => {
    render(
      <ConstantsPanel
        view={{
          kind: "ready",
          constants: constants({
            active: [
              { symbol: "Gcd", origin: "activated", operator: GCD },
              { symbol: "Lcm", origin: "activated", operator: LCM },
            ],
            available: [],
            activated: [activation("Gcd", null), activation("Lcm", null)],
          }),
          added: ["Gcd", "Lcm"],
        }}
      />,
    );
    expect(screen.getByText("greatest common divisor").closest("li")).toHaveTextContent(
      "added when a library result was applied",
    );
    expect(screen.getByTestId("constants-added")).toHaveTextContent(
      "Constants were added to this proof: ‘greatest common divisor’ and ‘least common multiple’.",
    );
  });

  it("explains empty lists, a read-only session, loading and failure", () => {
    const { rerender } = render(
      <ConstantsPanel
        view={{
          kind: "ready",
          constants: constants({ active: [], available: [], readOnly: true }),
          added: [],
        }}
      />,
    );
    expect(screen.getByText(/uses no notation of its own yet/)).toBeInTheDocument();
    expect(screen.getByText(/No further constants are waiting in the library/)).toBeInTheDocument();
    expect(
      screen.getByText(/This session is read-only, so its constants cannot change/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("constants-added")).toBeNull();
    expect(screen.queryByTestId("constants-new-mark")).toBeNull();

    rerender(<ConstantsPanel view={{ kind: "loading" }} />);
    expect(screen.getByTestId("constants-loading")).toHaveTextContent("Loading");
    rerender(<ConstantsPanel view={{ kind: "unavailable" }} />);
    expect(screen.getByTestId("constants-unavailable")).toHaveTextContent("could not be loaded");
  });

  it("describes a constant by its notation and name, falling back to its symbol", () => {
    expect(describeConstant(GCD)).toMatchObject({ name: "greatest common divisor" });
    expect(describeConstant(GCD).latex).toContain("gcd");
    expect(describeConstant(DIVIDES)).toEqual({
      name: "Divides",
      latex: expect.stringContaining("Divides"),
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("useSessionConstants", () => {
  function Probe({ reads }: Readonly<{ reads: () => Response | Promise<Response> }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reads()),
    );
    const [nodeId, setNodeId] = useState("node:1");
    const { view } = useSessionConstants("session:a", nodeId);
    return (
      <div>
        <button type="button" onClick={() => setNodeId(`${nodeId}+`)}>
          Move on
        </button>
        <output data-testid="kind">{view.kind}</output>
        <output data-testid="added">{view.kind === "ready" ? view.added.join(",") : ""}</output>
        <output data-testid="active">
          {view.kind === "ready" ? view.constants.active.map(({ symbol }) => symbol).join(",") : ""}
        </output>
      </div>
    );
  }

  it("highlights nothing on the first read, then what a later step added, then nothing again", async () => {
    let activated: ReturnType<typeof activation>[] = [];
    render(
      <Probe
        reads={() =>
          jsonResponse({
            ok: true,
            data: constants({
              active: [
                { symbol: "Divides", origin: "setup", operator: DIVIDES },
                ...activated.map(({ symbol }) => ({
                  symbol,
                  origin: "activated" as const,
                  operator: GCD,
                })),
              ],
              activated,
            }),
          })
        }
      />,
    );
    await waitFor(() => expect(screen.getByTestId("kind")).toHaveTextContent("ready"));
    expect(screen.getByTestId("added")).toHaveTextContent("");

    activated = [activation("Gcd")];
    fireEvent.click(screen.getByRole("button", { name: "Move on" }));
    await waitFor(() => expect(screen.getByTestId("added")).toHaveTextContent("Gcd"));
    expect(screen.getByTestId("active")).toHaveTextContent("Divides,Gcd");

    fireEvent.click(screen.getByRole("button", { name: "Move on" }));
    await waitFor(() => expect(screen.getByTestId("added")).toHaveTextContent(/^$/));
    expect(screen.getByTestId("active")).toHaveTextContent("Divides,Gcd");
  });

  it("keeps the list it had when a later read fails, and is unavailable when none ever worked", async () => {
    let fail = false;
    render(
      <Probe
        reads={() => {
          if (fail) throw new Error("down");
          return jsonResponse({ ok: true, data: constants() });
        }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("kind")).toHaveTextContent("ready"));
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Move on" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByTestId("kind")).toHaveTextContent("ready");
    expect(screen.getByTestId("active")).toHaveTextContent("Divides");
    cleanup();

    render(<Probe reads={() => jsonResponse({ ok: false, error: { code: "x", message: "y" } })} />);
    await waitFor(() => expect(screen.getByTestId("kind")).toHaveTextContent("unavailable"));
  });
});
