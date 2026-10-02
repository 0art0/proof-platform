// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConditionalLemmaPanel } from "./conditional-lemma-panel";
import { LemmaReviewSection, type LemmaReviewHandler } from "./lemma-review";
import {
  ALREADY_SAVED,
  NOT_CLOSED,
  READY,
  USES_SORRY,
  candidates,
  lemmaDraft,
  lemmaReviewed,
} from "./lemma-fixtures.testing";
import type { LemmaCandidates } from "./api-contract";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const COMMITTED = {
  commandId: "command:x",
  kind: "extract-conditional-lemma",
  actor: { id: "actor:web", kind: "human" },
  replayed: false,
  cursor: { nodeId: "node:root", stateId: "state:root", eventSequence: 0, inquirySequence: 2 },
  aliases: {
    nodeId: "node:root",
    stateId: "state:root",
    goals: [],
    obligations: [],
    hypotheses: [],
  },
  delta: {
    from: { nodeId: "node:root", stateId: "state:root" },
    to: { nodeId: "node:root", stateId: "state:root" },
    goals: { added: [], removed: [], updated: [] },
    obligations: { added: [], removed: [], updated: [] },
    assumptionsAdded: [],
    assumptionsRemoved: [],
  },
  result: {},
};

function committed(init: RequestInit | undefined): Response {
  const { commandId } = JSON.parse(String(init?.body)) as { commandId: string };
  return new Response(JSON.stringify({ ok: true, data: { ...COMMITTED, commandId } }), {
    status: 201,
  });
}

function stub(data: LemmaCandidates, command?: (init: RequestInit | undefined) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/protocol-commands")) return command?.(init) ?? committed(init);
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function panel(props: { readOnly?: boolean; view?: "formal" | "natural-language" } = {}) {
  return render(
    <ConditionalLemmaPanel
      sessionId="session:test"
      view={props.view ?? "formal"}
      readOnly={props.readOnly ?? false}
      busy={false}
      refreshKey={0}
    />,
  );
}

async function openPanel() {
  fireEvent.click(screen.getByText(/Show the steps you could save/));
  await screen.findByRole("list");
}

describe("ConditionalLemmaPanel", () => {
  it("explains what a lemma is and loads nothing until opened", () => {
    const fetchMock = stub(candidates([READY]));
    panel();
    expect(screen.getByText(/A lemma is a result you proved here/)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists steps, disables unfinished and sorry steps with a reason, and previews a ready one", async () => {
    stub(candidates([READY, NOT_CLOSED, USES_SORRY, ALREADY_SAVED]));
    panel();
    await openPanel();
    expect(screen.getByText("1 of 4 steps can be saved now.")).toBeInTheDocument();

    const items = screen.getAllByRole("listitem").filter((item) => "lemmaStatus" in item.dataset);
    const notClosed = items.find((item) => item.dataset.lemmaNode === "node:open")!;
    expect(within(notClosed).getByRole("button", { name: "Save as a lemma" })).toBeDisabled();
    expect(within(notClosed).getByText(/not finished yet/)).toBeInTheDocument();
    const sorry = items.find((item) => item.dataset.lemmaNode === "node:sorry")!;
    expect(within(sorry).getByText(/closed with a sorry/)).toBeInTheDocument();
    const saved = items.find((item) => item.dataset.lemmaNode === "node:saved")!;
    expect(within(saved).getByText(/Already saved as a draft/)).toBeInTheDocument();

    const ready = items.find((item) => item.dataset.lemmaNode === "node:root")!;
    expect(within(ready).queryByTestId("lemma-preview")).not.toBeInTheDocument();
    fireEvent.click(within(ready).getByRole("button", { name: /Preview the lemma for p/ }));
    const preview = within(ready).getByTestId("lemma-preview");
    expect(within(preview).getByText(/It keeps 1 hypothesis the proof used/)).toBeInTheDocument();
    expect(preview.querySelector("[data-kept]")?.textContent).toContain("p");
    expect(preview.querySelector("[data-unused]")?.textContent).toContain("q");
    expect(preview.querySelector("[data-unused]")?.textContent).toContain("r");
    expect(preview.querySelector("[data-lemma-statement] [data-latex]")).toHaveAttribute(
      "data-latex",
      "p \\implies p",
    );
  });

  it("shows the natural-language rendering in the prose view", async () => {
    stub(candidates([READY]));
    panel({ view: "natural-language" });
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: /Preview the lemma/ }));
    expect(screen.getByText(/if/, { selector: "[data-lemma-statement] span" })).toBeInTheDocument();
  });

  it("saves through one command envelope with no mathematics and says it is a draft", async () => {
    const fetchMock = stub(candidates([READY]));
    panel();
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: /Preview the lemma/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save as a lemma" }));
    await screen.findByText(/Saved as a draft lemma/);
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/protocol-commands"));
    const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      actor: { id: "actor:web", kind: "human" },
      command: {
        kind: "extract-conditional-lemma",
        nodeId: "node:root",
        target: { kind: "goal", id: "goal:main" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("renderings");
    // The list is read again after saving.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/conditional-lemmas")),
      ).toHaveLength(2),
    );
  });

  it("reports a refused save and keeps the same command ID for a retry", async () => {
    let failing = true;
    const fetchMock = stub(candidates([READY]), (init) =>
      failing
        ? new Response(
            JSON.stringify({
              ok: false,
              error: { code: "lemma-already-saved", message: "Already saved." },
            }),
            { status: 409 },
          )
        : committed(init),
    );
    panel();
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: /Preview the lemma/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save as a lemma" }));
    await screen.findByRole("alert");
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Save as a lemma" }));
    await screen.findByText(/Saved as a draft lemma/);
    const ids = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/protocol-commands"))
      .map(([, init]) => (JSON.parse(String(init?.body)) as { commandId: string }).commandId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("disables saving with the read-only reason", async () => {
    stub(candidates([READY], true));
    panel({ readOnly: true });
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: /Preview the lemma/ }));
    expect(screen.getByRole("button", { name: "Save as a lemma" })).toBeDisabled();
    expect(screen.getByText(/This session is read-only/)).toBeInTheDocument();
  });

  it("explains an empty session", async () => {
    stub(candidates([]));
    panel();
    fireEvent.click(screen.getByText(/Show the steps you could save/));
    await screen.findByText(/No steps yet/);
  });
});

describe("LemmaReviewSection", () => {
  const draft = lemmaDraft();

  function review(
    entries = [draft],
    onReview: LemmaReviewHandler = vi.fn<LemmaReviewHandler>(async () => ({ ok: true })),
    readOnly = false,
  ) {
    render(
      <LemmaReviewSection
        artifact={draft.artifact}
        entries={entries}
        readOnly={readOnly}
        onReview={onReview}
      />,
    );
    return onReview;
  }

  it("approves a pending draft", async () => {
    const onReview = review();
    expect(screen.getByText(/offered as a suggestion here/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve lemma" }));
    await waitFor(() =>
      expect(onReview).toHaveBeenCalledWith("result:lemma.command:save", "approved", ""),
    );
  });

  it("needs notes to reject, then records them", async () => {
    const onReview = review();
    const reject = screen.getByRole("button", { name: "Reject lemma" });
    expect(reject).toBeDisabled();
    expect(screen.getByText("Add a note to enable rejecting.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: "Too weak." } });
    expect(reject).toBeEnabled();
    fireEvent.click(reject);
    await waitFor(() =>
      expect(onReview).toHaveBeenCalledWith("result:lemma.command:save", "rejected", "Too weak."),
    );
  });

  it("shows a failure from the review", async () => {
    review(
      [draft],
      vi.fn<LemmaReviewHandler>(async () => ({ ok: false, message: "Review refused." })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve lemma" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Review refused.");
  });

  it("is disabled in a read-only session", () => {
    review([draft], undefined, true);
    expect(screen.getByRole("button", { name: "Approve lemma" })).toBeDisabled();
    expect(screen.getByText(/This session is read-only/)).toBeInTheDocument();
  });

  it("shows the recorded decision instead of the buttons once reviewed", () => {
    review([draft, lemmaReviewed("rejected", "Too weak.")]);
    expect(screen.queryByRole("button", { name: "Approve lemma" })).not.toBeInTheDocument();
    expect(screen.getByText(/was rejected and is not offered/)).toBeInTheDocument();
    expect(screen.getByText("Notes: Too weak.")).toBeInTheDocument();
  });

  it("shows nothing for an ordinary library result", () => {
    const ordinary = lemmaDraft({ layer: "global", provenance: { kind: "curated", source: "x" } });
    render(
      <LemmaReviewSection
        artifact={ordinary.artifact}
        entries={[ordinary]}
        readOnly={false}
        onReview={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Lemma review")).not.toBeInTheDocument();
  });
});
