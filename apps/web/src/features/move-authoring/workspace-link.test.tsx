// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createProofNodeSchema } from "@proof/protocol";
import { movesHref, WorkspaceToolbar } from "../stored-proof-workspace/workspace-toolbar";
import { READ_ONLY_REASON } from "../stored-proof-workspace/toolbar-actions";

const node = createProofNodeSchema().parse({
  id: "node:root",
  state: { id: "state:root", goals: [], obligations: [] },
});

afterEach(cleanup);

function toolbar(readOnly: boolean) {
  render(
    <WorkspaceToolbar
      view="formal"
      onViewChange={() => undefined}
      sessionId="session:a b"
      node={node}
      readOnly={readOnly}
    />,
  );
}

describe("the workspace's link to move authoring", () => {
  it("links to the session's moves page", () => {
    toolbar(false);
    expect(screen.getByRole("link", { name: "Author moves" })).toHaveAttribute(
      "href",
      "/sessions/session%3Aa%20b/moves",
    );
    expect(movesHref("session:a b")).toBe("/sessions/session%3Aa%20b/moves");
  });

  it("is disabled, with the read-only reason, for an imported session", () => {
    toolbar(true);
    expect(screen.queryByRole("link", { name: /Author moves/ })).toBeNull();
    const button = screen.getByRole("button", { name: `Author moves (${READ_ONLY_REASON})` });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", READ_ONLY_REASON);
  });
});
