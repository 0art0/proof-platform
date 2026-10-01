// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPresentation } from "@proof/language";
import { LibraryDrawer } from "./library-drawer";
import { IDLE_DRAG_STATE } from "../gestures/drag-state";
import type { GestureBindings } from "../gestures/use-drag-gestures";
import { EVENTS, LIBRARY } from "./library-fixtures.testing";

const presentation = createPresentation({ operators: [] });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(overrides: { library?: unknown; events?: unknown; failure?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (overrides.failure === true) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "session-not-found", message: "No such session." },
        }),
        { status: 404 },
      );
    }
    const data = url.endsWith("/events")
      ? (overrides.events ?? { sessionId: "session:test", readOnly: false, events: EVENTS })
      : (overrides.library ?? LIBRARY);
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openDrawer(view: "formal" | "natural-language" = "formal") {
  render(<LibraryDrawer sessionId="session:test" presentation={presentation} view={view} />);
  fireEvent.click(screen.getByRole("button", { name: "Library" }));
  await screen.findByRole("search", { name: "Filter library" });
}

describe("LibraryDrawer", () => {
  it("is closed until toggled, then loads the library and events for the session", async () => {
    const fetchMock = stubFetch();
    render(<LibraryDrawer sessionId="session:test" presentation={presentation} view="formal" />);
    const toggle = screen.getByRole("button", { name: "Library" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await screen.findByRole("search", { name: "Filter library" });
    expect(screen.getByText(/Browse the definitions, results and moves/)).toBeVisible();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/proof-sessions/session%3Atest/library",
      "/api/proof-sessions/session%3Atest/library/events",
    ]);
    expect(screen.getByText("5 of 5 artifacts")).toBeInTheDocument();
    // Layers are groups with counts; the text layer summary lists empty layers too.
    expect(
      screen.getByRole("region", { name: "Global (approved catalog and packs)" }),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "Derived in this session" })).toBeVisible();
    expect(screen.getByText(/Initial problem: 0/)).toBeInTheDocument();
  });

  it("searches and filters by kind, domain and layer", async () => {
    stubFetch();
    await openDrawer();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "continuity" } });
    expect(screen.getByText("1 of 5 artifacts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continuity of sums/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Excluded middle/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "definition" } });
    expect(screen.getByText("1 of 5 artifacts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Even number/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "analysis" } });
    expect(screen.getByText("2 of 5 artifacts")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Layer"), { target: { value: "derived" } });
    expect(screen.getByText("1 of 5 artifacts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Session lemma/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "zzz" } });
    expect(screen.getByText("0 of 5 artifacts")).toBeInTheDocument();
  });

  it("labels provenance and approval in text on each row", async () => {
    stubFetch();
    await openDrawer();
    const draft = screen.getByRole("button", { name: /Continuity of sums/ });
    expect(draft).toHaveTextContent("Draft");
    expect(draft).toHaveTextContent("Stored library");
    expect(draft).toHaveTextContent("Curated: reader notes");
    const approved = screen.getByRole("button", { name: /Excluded middle/ });
    expect(approved).toHaveTextContent("Approved");
    expect(approved).toHaveTextContent("Approved catalog");
  });

  it("shows artifact details and navigates between variants and back to the list", async () => {
    stubFetch();
    await openDrawer();
    fireEvent.click(screen.getByRole("button", { name: /^Contrapositive/ }));
    const detail = screen.getByRole("article", { name: "Contrapositive details" });
    expect(within(detail).getAllByText("result:contrapositive").length).toBeGreaterThan(0);
    expect(within(detail).getByText("Global (approved catalog and packs)")).toBeInTheDocument();
    expect(within(detail).getByText("Approved (reviewer reviewer:core)")).toBeInTheDocument();
    expect(
      within(detail).getAllByText("Variant of result:excluded-middle (contrapositive)").length,
    ).toBeGreaterThan(0);
    expect(within(detail).getByText("forward, backward")).toBeInTheDocument();
    expect(detail.querySelector("[data-statement] [data-latex]")).toHaveAttribute(
      "data-latex",
      expect.stringContaining("lor"),
    );
    const premises = within(detail).getByRole("region", { name: "Premises" });
    expect(premises.querySelectorAll("[data-premise]")).toHaveLength(1);
    const variants = within(detail).getByRole("region", { name: "Variants" });
    expect(within(variants).getByText("(this artifact)")).toBeInTheDocument();
    expect(within(variants).getByText("(not in this library)")).toBeInTheDocument();

    fireEvent.click(within(variants).getByRole("button", { name: /Excluded middle/ }));
    expect(screen.getByRole("article", { name: "Excluded middle details" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "← Back to list" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Excluded middle/ })).toHaveFocus(),
    );
  });

  it("renders statements in the natural-language view and shows drafts as not approved", async () => {
    stubFetch();
    await openDrawer("natural-language");
    fireEvent.click(screen.getByRole("button", { name: /Continuity of sums/ }));
    const detail = screen.getByRole("article", { name: "Continuity of sums details" });
    expect(within(detail).getByText("Draft (not approved)")).toBeInTheDocument();
    expect(within(detail).getByText("Reader notes", { exact: false })).toBeDefined();
    expect(detail.querySelector("[data-statement]")?.textContent).toMatch(/not/i);
    expect(within(detail).getByText("No premises.")).toBeInTheDocument();
  });

  it("lists addition events, with diagnostics for rejections", async () => {
    stubFetch();
    await openDrawer();
    fireEvent.click(screen.getByRole("button", { name: /Addition events \(2\)/ }));
    const events = screen.getByRole("list", { name: "Addition events" });
    const [admitted, rejected] = within(events).getAllByRole("listitem");
    expect(admitted).toHaveAttribute("data-decision", "admitted");
    expect(admitted).toHaveTextContent("Admitted");
    expect(admitted).toHaveTextContent("Continuity of sums");
    expect(admitted).toHaveTextContent("by user (user:reader)");
    expect(rejected).toHaveAttribute("data-decision", "rejected");
    expect(rejected).toHaveTextContent("Rejected");
    expect(rejected).toHaveTextContent("Hard result");
    const diagnostics = within(rejected!).getByRole("list", { name: "Rejection diagnostics" });
    expect(diagnostics).toHaveTextContent(
      "level-above-background: The level graduate is too high.",
    );
  });

  it("shows an empty events message and a read-only notice", async () => {
    stubFetch({
      library: { ...LIBRARY, readOnly: true },
      events: { sessionId: "session:test", readOnly: true, events: [] },
    });
    await openDrawer();
    expect(screen.getByText(/Read-only session/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Addition events \(0\)/ }));
    expect(screen.getByText("No additions were recorded.")).toBeInTheDocument();
  });

  it("reports a failed or invalid response", async () => {
    stubFetch({ failure: true });
    render(<LibraryDrawer sessionId="session:test" presentation={presentation} view="formal" />);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No such session.");
    cleanup();

    stubFetch({ library: { sessionId: "session:test" } });
    render(<LibraryDrawer sessionId="session:test" presentation={presentation} view="formal" />);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid response");
  });

  it("moves focus into the drawer on open and Escape closes it, returning focus to the toggle", async () => {
    stubFetch();
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    render(<LibraryDrawer sessionId="session:test" presentation={presentation} view="formal" />);
    const toggle = screen.getByRole("button", { name: "Library" });
    toggle.focus();
    fireEvent.click(toggle);
    await screen.findByRole("search", { name: "Filter library" });
    await waitFor(() => expect(screen.getByLabelText("Search")).toHaveFocus());

    fireEvent.keyDown(screen.getByLabelText("Search"), { key: "Escape" });
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The drawer consumed the Escape, so no proof-selection shortcut saw it.
    expect(outside).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outside);
  });

  it("ignores Escape while focus is outside the drawer, and the Close button works", async () => {
    stubFetch();
    render(<LibraryDrawer sessionId="session:test" presentation={presentation} view="formal" />);
    const toggle = screen.getByRole("button", { name: "Library" });
    fireEvent.click(toggle);
    await screen.findByRole("search", { name: "Filter library" });
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Escape" });
    expect(screen.getByRole("complementary")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Close/ }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  describe("drag gestures", () => {
    const gestures = (): GestureBindings => ({
      enabled: true,
      state: IDLE_DRAG_STATE,
      carrying: undefined,
      pickUp: vi.fn(),
      hover: vi.fn(),
      dropOn: vi.fn(),
      cancel: vi.fn(),
    });

    async function openWith(bindings: GestureBindings | undefined) {
      stubFetch();
      render(
        <LibraryDrawer
          sessionId="session:test"
          presentation={presentation}
          view="formal"
          gestures={bindings}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Library" }));
      await screen.findByRole("search", { name: "Filter library" });
    }

    it("offers a handle on result rows only, and none without a gesture surface", async () => {
      await openWith(undefined);
      expect(document.querySelectorAll("[data-drag-handle]")).toHaveLength(0);
      cleanup();

      await openWith(gestures());
      const results = LIBRARY.entries.filter(({ artifact }) => artifact.kind === "result");
      expect(results.length).toBeGreaterThan(0);
      expect(document.querySelectorAll("[data-drag-handle]")).toHaveLength(results.length);
      expect(screen.getByRole("button", { name: "Drag result Excluded middle" })).toBeVisible();
    });

    it("picks a result up by pointer drag or by keyboard, carrying only its artifact ID", async () => {
      const bindings = gestures();
      await openWith(bindings);
      const handle = screen.getByRole("button", {
        name: "Drag result Excluded middle",
      });
      const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
      fireEvent.dragStart(handle, { dataTransfer });
      await waitFor(() => expect(bindings.pickUp).toHaveBeenCalledTimes(1));
      const source = {
        kind: "result",
        artifactId: "result:excluded-middle",
        label: "Excluded middle",
      };
      expect(bindings.pickUp).toHaveBeenLastCalledWith(source, "pointer");
      expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "Excluded middle");

      fireEvent.keyDown(handle, { key: "Enter" });
      expect(bindings.pickUp).toHaveBeenLastCalledWith(source, "keyboard");
      fireEvent.dragEnd(handle);
      expect(bindings.cancel).toHaveBeenCalled();
    });
  });
});
