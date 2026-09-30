// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportAction } from "./export-action";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubVisibility(visibility: string, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: status === 200, data: { visibility } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ExportAction", () => {
  it("downloads a shared session directly, with no acknowledgement", async () => {
    const fetchMock = stubVisibility("shared");
    const startDownload = vi.fn();
    render(<ExportAction sessionId="session:test" startDownload={startDownload} />);
    fireEvent.click(screen.getByRole("button", { name: "Export proof" }));
    await waitFor(() =>
      expect(startDownload).toHaveBeenCalledExactlyOnceWith(
        "/api/proof-sessions/session%3Atest/export",
        "session-test.proof.json",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/proof-sessions/session%3Atest/visibility",
      expect.anything(),
    );
  });

  it("asks a private session for confirmation before requesting the export", async () => {
    stubVisibility("private");
    const startDownload = vi.fn();
    render(<ExportAction sessionId="session:test" startDownload={startDownload} />);
    fireEvent.click(screen.getByRole("button", { name: "Export proof" }));
    const dialog = await screen.findByRole("dialog", { name: "Export a private session" });
    expect(dialog).toHaveTextContent("This session is private. Export it anyway?");
    expect(startDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
    expect(startDownload).toHaveBeenCalledExactlyOnceWith(
      "/api/proof-sessions/session%3Atest/export?confirmPrivateExport=true",
      "session-test.proof.json",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("requests nothing when the acknowledgement is cancelled", async () => {
    stubVisibility("private");
    const startDownload = vi.fn();
    render(<ExportAction sessionId="session:test" startDownload={startDownload} />);
    fireEvent.click(screen.getByRole("button", { name: "Export proof" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(startDownload).not.toHaveBeenCalled();
  });

  it("shows a readable error when the visibility cannot be read", async () => {
    stubVisibility("private", 502);
    const startDownload = vi.fn();
    render(<ExportAction sessionId="session:test" startDownload={startDownload} />);
    fireEvent.click(screen.getByRole("button", { name: "Export proof" }));
    expect(await screen.findByText(/visibility could not be read/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(startDownload).not.toHaveBeenCalled();
  });

  it("shows a readable error when the service cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const startDownload = vi.fn();
    render(<ExportAction sessionId="session:test" startDownload={startDownload} />);
    fireEvent.click(screen.getByRole("button", { name: "Export proof" }));
    expect(await screen.findByText(/could not be reached/)).toBeInTheDocument();
    expect(startDownload).not.toHaveBeenCalled();
  });
});
