// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORCHESTRATOR_POLL_INTERVAL_MS, OrchestratorDashboard } from "./orchestrator-dashboard";

const statusData = {
  todo: {
    id: "project",
    title: "Proof Platform",
    status: "in_progress",
    taskId: null,
    children: [
      {
        id: "todo-stage-1",
        title: "Stage 1",
        status: "in_progress",
        taskId: null,
        children: [
          {
            id: "task-dashboard",
            title: "Local dashboard",
            status: "in_progress",
            taskId: "task-dashboard",
            children: [],
          },
        ],
      },
    ],
  },
  tasks: [
    {
      id: "task-dashboard",
      title: "Build the local dashboard",
      status: "running",
      attempt: 2,
      failureCount: 1,
      maxAttempts: 3,
      todoPath: ["Stage 1"],
      dependencies: ["task-gateway"],
      summary: "The dashboard shell is running.",
      error: "A prior attempt timed out.",
    },
  ],
} as const;

const messagesData = {
  messages: [
    {
      id: "msg-123456789abc",
      content: "Build the local dashboard",
      status: "completed",
      reply: "Created one bounded task.",
      threadId: "thread-1",
      nextWakeAt: null,
      lastError: null,
      createdAt: "2026-09-07T08:00:00+00:00",
      updatedAt: "2026-09-07T08:01:00+00:00",
    },
  ],
} as const;

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulFetch() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("/status")) return response({ ok: true, data: statusData });
    if (url.includes("/messages")) return response({ ok: true, data: messagesData });
    if (url.includes("/intent")) {
      return response(
        {
          ok: true,
          data: {
            messageId: "msg-abcdef123456",
            status: "pending",
            next: "Read the reply later.",
          },
        },
        202,
      );
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local orchestrator dashboard", () => {
  it("renders the durable TODO, task detail, status labels, and reply history", async () => {
    vi.stubGlobal("fetch", successfulFetch());
    render(<OrchestratorDashboard />);

    expect(screen.getByText("Reading durable state")).toBeInTheDocument();
    expect(await screen.findByText("Local dashboard")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Build the local dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Attempt 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("1 used · 2 remaining")).toBeInTheDocument();
    expect(screen.getByText("task-gateway")).toBeInTheDocument();
    expect(screen.getByText("A prior attempt timed out.")).toBeInTheDocument();
    expect(screen.getByText("Created one bounded task.")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("submits a validated intent and confirms its durable message ID", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<OrchestratorDashboard />);
    await screen.findByText("Local dashboard");

    fireEvent.change(screen.getByLabelText("Development intent"), {
      target: { value: "Implement the next bounded slice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to supervisor" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Intent msg-abcdef123456 is safely queued as pending.",
    );
    const intentCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/intent"));
    expect(intentCall?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ message: "Implement the next bounded slice" }),
    });
  });

  it("refreshes manually and keeps last-known data visible after an error", async () => {
    let shouldFail = false;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (shouldFail) throw new Error("offline");
      return String(input).includes("/status")
        ? response({ ok: true, data: statusData })
        : response({ ok: true, data: messagesData });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<OrchestratorDashboard />);
    await screen.findByText("Local dashboard");

    shouldFail = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));

    expect(await screen.findByText(/Showing the last known durable state/)).toBeInTheDocument();
    expect(screen.getByText("Local dashboard")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("shows a recoverable empty error state when the first read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        response(
          {
            ok: false,
            error: { code: "gateway_unavailable", message: "Supervisor is not running." },
          },
          503,
        ),
      ),
    );
    render(<OrchestratorDashboard />);

    expect(
      await screen.findByRole("heading", { name: "The control room is out of reach" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Supervisor is not running/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("polls while visible and pauses polling while the document is hidden", async () => {
    vi.useFakeTimers();
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<OrchestratorDashboard />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ORCHESTRATOR_POLL_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    hidden = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ORCHESTRATOR_POLL_INTERVAL_MS * 2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
