// @vitest-environment jsdom

import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { readAiCapabilities, readAiPrompts, readCurrentProofSession, readProofSessionMetadata } =
  vi.hoisted(() => ({
    readAiCapabilities: vi.fn(),
    readAiPrompts: vi.fn().mockResolvedValue({ proofDraft: "Draft prompt" }),
    readCurrentProofSession: vi.fn(),
    readProofSessionMetadata: vi.fn(),
  }));
vi.mock("../../../server/proof-service", () => ({
  ProofServiceError: class extends Error {
    status = 500;
    code = "x";
  },
  readAiCapabilities,
  readAiPrompts,
  readCurrentProofSession,
  readProofSessionMetadata,
}));
vi.mock("../../../features/stored-proof-workspace", () => ({
  StoredProofWorkspace: () => null,
}));

import SessionPage from "./page";

const node = { id: "node:root" };
const session = {
  id: "session:test",
  rootNodeId: "node:root",
  currentNodeId: "node:root",
  operators: [],
};

async function workspaceProps() {
  const page = (await SessionPage({
    params: Promise.resolve({ sessionId: "session%3Atest" }),
  })) as ReactElement<{
    children: ReactElement<{
      session: Record<string, unknown>;
      aiShortlist: boolean;
      aiExecutor: boolean;
      aiLibrarian: boolean;
      aiMoveAuthor: boolean;
      aiDraft: boolean;
      aiPlanner: boolean;
      aiTranslator: boolean;
      draftPrompt: string;
    }>;
  }>;
  expect(isValidElement(page)).toBe(true);
  return page.props.children.props;
}

describe("the session page", () => {
  it("passes the stored problem title, statement and background summary to the workspace", async () => {
    readAiCapabilities.mockResolvedValue({
      "background-proposer": false,
      librarian: true,
      "proof-state-formalizer": false,
      "move-shortlister": true,
      "move-executor": true,
      "move-author": true,
      "proof-draft": true,
      "proof-planner": true,
      "step-translator": true,
    });
    readCurrentProofSession.mockResolvedValue({ session, node });
    readProofSessionMetadata.mockResolvedValue({
      problem: { title: "Commute a conjunction", statement: "Show that p and q implies q and p." },
      background: { level: "propositional logic", summary: "Natural deduction.", assumptions: [] },
      libraryLayerIds: [],
    });
    const props = await workspaceProps();
    expect(readProofSessionMetadata).toHaveBeenCalledWith("session:test");
    expect(props.session).toMatchObject({
      id: "session:test",
      title: "Commute a conjunction",
      statement: "Show that p and q implies q and p.",
      background: "Natural deduction.",
    });
    expect(props.aiShortlist).toBe(true);
    expect(props.aiExecutor).toBe(true);
    expect(props.aiLibrarian).toBe(true);
    expect(props.aiMoveAuthor).toBe(true);
    expect(props.aiPlanner).toBe(true);
    expect(props.aiDraft).toBe(true);
    expect(props.aiTranslator).toBe(true);
    expect(props.draftPrompt).toBe("Draft prompt");
  });

  it("opens a session without stored metadata under its id", async () => {
    readAiCapabilities.mockResolvedValue({
      "background-proposer": false,
      librarian: false,
      "proof-state-formalizer": false,
      "move-shortlister": false,
      "move-executor": false,
      "move-author": false,
      "proof-draft": true,
      "proof-planner": true,
      "step-translator": false,
    });
    readCurrentProofSession.mockResolvedValue({ session, node });
    readProofSessionMetadata.mockResolvedValue(undefined);
    const props = await workspaceProps();
    expect(props.session).toEqual(session);
    expect(props.aiShortlist).toBe(false);
    expect(props.aiExecutor).toBe(false);
    expect(props.aiLibrarian).toBe(false);
    expect(props.aiMoveAuthor).toBe(false);
    expect(props.aiPlanner).toBe(true);
    expect(props.aiTranslator).toBe(false);
  });
});
