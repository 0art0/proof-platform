// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactDownload, ArtifactUpload } from "./artifact-actions";
import { LandingActions } from "./landing-actions";

const artifact = { artifactVersion: 1, kind: "proof-artifact", sessionId: "session:source" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, status: number) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function choose(text: string) {
  const file = new File([text], "session.proof-artifact.json", { type: "application/json" });
  fireEvent.change(screen.getByLabelText("Artifact file"), { target: { files: [file] } });
}

describe("ArtifactUpload", () => {
  it("uploads the chosen file and opens the new read-only session", async () => {
    const fetchMock = stubFetch(
      {
        ok: true,
        data: {
          sessionId: "session:artifact:0123",
          digest: `sha256:${"a".repeat(64)}`,
          sourceSessionId: "session:source",
          readOnly: true,
          replayed: false,
        },
      },
      201,
    );
    const navigate = vi.fn();
    render(<ArtifactUpload navigate={navigate} />);
    const upload = screen.getByRole("button", { name: "Open proof file" });
    expect(upload).toBeDisabled();

    choose(JSON.stringify(artifact));
    expect(upload).toBeEnabled();
    fireEvent.click(upload);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith("/sessions/session%3Aartifact%3A0123"),
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/artifacts");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual(artifact);
  });

  it("lists the worker's diagnostics for a rejected artifact and stays on the page", async () => {
    stubFetch(
      {
        ok: false,
        error: { code: "transition-not-reproduced", message: "Edge 2 differs." },
        details: {
          diagnostics: [
            {
              code: "transition-not-reproduced",
              message: "Edge 2 differs.",
              path: ["tree", "edges", 2],
            },
          ],
        },
      },
      422,
    );
    const navigate = vi.fn();
    render(<ArtifactUpload navigate={navigate} />);
    choose(JSON.stringify(artifact));
    fireEvent.click(screen.getByRole("button", { name: "Open proof file" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The artifact was not imported: Edge 2 differs.");
    expect(alert).toHaveTextContent("transition-not-reproduced at tree.edges.2");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps the technical details collapsed behind the one-line message", async () => {
    stubFetch(
      {
        ok: false,
        error: { code: "x", message: "Edge 2 differs." },
        details: { diagnostics: [{ code: "x", message: "Edge 2 differs.", path: ["a"] }] },
      },
      422,
    );
    render(<ArtifactUpload navigate={vi.fn()} />);
    choose(JSON.stringify(artifact));
    fireEvent.click(screen.getByRole("button", { name: "Open proof file" }));
    const alert = await screen.findByRole("alert");
    const details = alert.querySelector("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(details?.querySelector("summary")).toHaveTextContent("Technical details");
    expect(alert.querySelector("p")).toHaveTextContent("The artifact was not imported");
  });

  it("refuses a file that is not JSON without calling the service", async () => {
    const fetchMock = stubFetch({}, 500);
    render(<ArtifactUpload navigate={vi.fn()} />);
    choose("{not json");
    fireEvent.click(screen.getByRole("button", { name: "Open proof file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The file is not valid JSON.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ArtifactDownload", () => {
  function enter() {
    fireEvent.change(screen.getByLabelText("Saved proof ID to download"), {
      target: { value: " session:development " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download artifact" }));
  }

  it("opens the export proxy directly for a shared session", async () => {
    const fetchMock = stubFetch({ ok: true, data: { visibility: "shared" } }, 200);
    const navigate = vi.fn();
    render(<ArtifactDownload navigate={navigate} />);
    enter();
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        "/api/proof-sessions/session%3Adevelopment/export",
      ),
    );
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/proof-sessions/session%3Adevelopment/visibility",
      expect.anything(),
    );
    expect(screen.queryByText(/is private/)).toBeNull();
  });

  it("requires an acknowledgement for a private session before exporting", async () => {
    stubFetch({ ok: true, data: { visibility: "private" } }, 200);
    const navigate = vi.fn();
    render(<ArtifactDownload navigate={navigate} />);
    enter();
    expect(await screen.findByText("This session is private. Export it anyway?")).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      "/api/proof-sessions/session%3Adevelopment/export?confirmPrivateExport=true",
    );
  });

  it("requests nothing when the acknowledgement is cancelled", async () => {
    stubFetch({ ok: true, data: { visibility: "private" } }, 200);
    const navigate = vi.fn();
    render(<ArtifactDownload navigate={navigate} />);
    enter();
    await screen.findByText("This session is private. Export it anyway?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/is private/)).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows a readable error when the visibility cannot be read", async () => {
    stubFetch({ ok: false, error: { message: "gone" } }, 404);
    const navigate = vi.fn();
    render(<ArtifactDownload navigate={navigate} />);
    enter();
    expect(await screen.findByRole("alert")).toHaveTextContent(/visibility could not be read/);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("LandingActions", () => {
  it("offers the three ways to begin and keeps less common actions tucked away", () => {
    render(<LandingActions developmentSessionId="session:development" />);
    expect(screen.getByRole("heading", { name: "Open a proof file" })).toBeInTheDocument();
    expect(screen.getByLabelText("Artifact file")).toBeEnabled();
    expect(screen.getByRole("link", { name: "Start a new problem" })).toHaveAttribute(
      "href",
      "/problems/new",
    );
    expect(screen.getByRole("heading", { name: "Resume a saved proof" })).toBeInTheDocument();
    expect(screen.getByText("Download a saved proof").closest("details")).not.toHaveAttribute(
      "open",
    );
    expect(screen.getByText("Open an example proof").closest("details")).not.toHaveAttribute(
      "open",
    );
    fireEvent.click(screen.getByText("Download a saved proof"));
    expect(screen.getByRole("button", { name: "Download artifact" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Open an example proof"));
    expect(screen.getByRole("link", { name: "Explore the example proof" })).toHaveAttribute(
      "href",
      "/sessions/session%3Adevelopment",
    );
    expect(screen.getByText("Download a saved proof")).toBeInTheDocument();
  });
});
