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
    const upload = screen.getByRole("button", { name: "Upload artifact" });
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
    fireEvent.click(screen.getByRole("button", { name: "Upload artifact" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The artifact was not imported: Edge 2 differs.");
    expect(alert).toHaveTextContent("transition-not-reproduced at tree.edges.2");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("refuses a file that is not JSON without calling the service", async () => {
    const fetchMock = stubFetch({}, 500);
    render(<ArtifactUpload navigate={vi.fn()} />);
    choose("{not json");
    fireEvent.click(screen.getByRole("button", { name: "Upload artifact" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The file is not valid JSON.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ArtifactDownload", () => {
  it("opens the export proxy for the entered session", () => {
    const navigate = vi.fn();
    render(<ArtifactDownload navigate={navigate} />);
    fireEvent.change(screen.getByLabelText("Session ID to download"), {
      target: { value: " session:development " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Download artifact" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      "/api/proof-sessions/session%3Adevelopment/export",
    );
  });
});

describe("LandingActions", () => {
  it("offers the three actions with upload enabled", () => {
    render(<LandingActions developmentSessionId="session:development" />);
    expect(screen.getByRole("heading", { name: "Upload artifact" })).toBeInTheDocument();
    expect(screen.getByLabelText("Artifact file")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download artifact" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enter a new problem" })).toHaveAttribute(
      "href",
      "/problems/new",
    );
  });
});
