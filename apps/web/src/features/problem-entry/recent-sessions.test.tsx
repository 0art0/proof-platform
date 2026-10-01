// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundView } from "./not-found-view";
import { RecentSessionsList } from "./recent-sessions-list";
import { RECENT_SESSIONS_KEY, readRecentSessions, recordRecentSession } from "./recent-sessions";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("recent sessions", () => {
  it("records newest first, keeps titles and removes duplicates", () => {
    recordRecentSession({ id: "session:a", title: "Alpha" });
    recordRecentSession({ id: "session:b" });
    recordRecentSession({ id: "session:a" });
    expect(readRecentSessions()).toEqual([
      { id: "session:a", title: "Alpha" },
      { id: "session:b" },
    ]);
  });

  it("lists them with titles and links, and ignores corrupt storage", async () => {
    recordRecentSession({ id: "session:a", title: "Alpha" });
    render(<RecentSessionsList />);
    const link = await screen.findByRole("link", { name: "Alpha" });
    expect(link).toHaveAttribute("href", "/sessions/session%3Aa");
    cleanup();

    window.localStorage.setItem(RECENT_SESSIONS_KEY, "{not json");
    render(<RecentSessionsList />);
    expect(screen.queryByRole("heading", { name: "Recent proofs" })).toBeNull();
  });

  it("renders nothing and does not throw when localStorage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => recordRecentSession({ id: "session:a" })).not.toThrow();
    expect(readRecentSessions()).toEqual([]);
    render(<RecentSessionsList />);
    await waitFor(() => expect(screen.queryByText("Recent proofs")).toBeNull());
  });

  it("moves an opened session to the front", async () => {
    recordRecentSession({ id: "session:a", title: "Alpha" });
    recordRecentSession({ id: "session:b", title: "Beta" });
    render(<RecentSessionsList />);
    fireEvent.click(await screen.findByRole("link", { name: "Alpha" }));
    expect(readRecentSessions()[0]?.id).toBe("session:a");
  });
});

describe("NotFoundView", () => {
  it("offers a way back to the start and to a new problem", () => {
    render(<NotFoundView title="Session not found" message="No such session." />);
    expect(screen.getByRole("heading", { name: "Session not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the start" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Enter a new problem" })).toHaveAttribute(
      "href",
      "/problems/new",
    );
  });
});
