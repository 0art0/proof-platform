import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  analyzeBacktrackProofSession,
  previewSemanticReplayProofSession,
  readCurrentProofSession,
} from ".";

const SESSION_ID = "session:test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

afterEach(() => vi.unstubAllGlobals());

const analysis = {
  sourceNodeId: "node:child",
  sourceTarget: { kind: "goal", id: "goal:main" },
  proposition: ["Not", "p"],
  freeSymbols: ["p"],
  operators: ["Not"],
  declarations: [
    {
      id: "declaration:p",
      symbol: "p",
      sort: { kind: "proposition" },
      role: "universal-parameter",
    },
  ],
  ancestors: [
    {
      nodeId: "node:root",
      distance: 1,
      target: { kind: "goal", id: "goal:main" },
      eligible: true,
      unavailableSymbols: [],
      wellFormed: true,
    },
  ],
  closestEligibleAncestorNodeId: "node:root",
};

const report = {
  targetNodeId: "node:target",
  complete: true,
  steps: [
    {
      index: 1,
      sourceEdgeId: "edge:source-1",
      status: "exact",
      commandId: "command:replay-1:replay:1",
      resultNodeId: "node:replayed-1",
      transitionClass: "equivalence",
      selections: [],
      substitutions: [],
      resultSubstitutions: [],
      parameters: [],
      obligations: [],
      alternatives: [],
    },
  ],
  substitutions: [],
  finalNodeId: "node:replayed-1",
};

describe("dry-run proof-service functions", () => {
  it("posts the backtrack analysis request and returns the validated analysis", async () => {
    const request = {
      sourceNodeId: "node:child",
      sourceTarget: { kind: "goal", id: "goal:main" },
      proposition: ["Not", "p"],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ analysis }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.PROOF_HTTP_ORIGIN = "http://proof-worker.test";

    await expect(analyzeBacktrackProofSession(SESSION_ID, request)).resolves.toEqual({ analysis });
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL("http://proof-worker.test/proof-sessions/session%3Atest/backtrack-analysis"),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(request),
    });
  });

  it("rejects an invalid analysis request before contacting the worker and relays refusals", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      analyzeBacktrackProofSession(SESSION_ID, { sourceNodeId: "node:child", actor: "x" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ analysis: { ...analysis, extra: true } })),
    );
    await expect(
      analyzeBacktrackProofSession(SESSION_ID, {
        sourceNodeId: "node:child",
        proposition: ["Not", "p"],
      }),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
  });

  it("posts the replay preview with the commit command ID and returns only the report", async () => {
    const request = {
      commandId: "command:replay-1",
      source: { fromNodeId: "node:a", toNodeId: "node:b" },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ report, finalNode: { id: "x" } }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.PROOF_HTTP_ORIGIN = "http://proof-worker.test";

    await expect(previewSemanticReplayProofSession(SESSION_ID, request)).resolves.toEqual({
      report,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(
      new URL("http://proof-worker.test/proof-sessions/session%3Atest/replay-preview"),
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(request),
    });
  });

  it("rejects a malformed report and a malformed request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ report: { ...report, complete: false } })),
    );
    await expect(
      previewSemanticReplayProofSession(SESSION_ID, {
        source: { fromNodeId: "node:a", toNodeId: "node:b" },
      }),
    ).rejects.toMatchObject({ code: "invalid_upstream_response" });
    await expect(
      previewSemanticReplayProofSession(SESSION_ID, { source: {} }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("dry-run refusals", () => {
  it.each([
    [
      "backtrack-with-information-rejected",
      analyzeBacktrackProofSession,
      { sourceNodeId: "node:a", proposition: "p" },
    ],
    [
      "replay-rejected",
      previewSemanticReplayProofSession,
      { source: { fromNodeId: "node:a", toNodeId: "node:b" } },
    ],
  ])("relays the worker's %s diagnostic with its message", async (code, call, request) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ diagnostics: [{ code, message: "Refused by the worker." }] }, 422),
        ),
    );
    await expect(call(SESSION_ID, request)).rejects.toMatchObject({
      code,
      message: "Refused by the worker.",
    });
  });
});

describe("the current session's read-only marker", () => {
  it("passes readOnly and visibility through, and rejects any other extra field", async () => {
    const node = {
      id: "node:test",
      state: { id: "state:test", goals: [], obligations: [] },
    };
    const session = {
      id: SESSION_ID,
      rootNodeId: "node:test",
      currentNodeId: "node:test",
      operators: [],
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ session: { ...session, readOnly: true, visibility: "shared" }, node }),
        ),
    );
    const loaded = await readCurrentProofSession(SESSION_ID);
    expect(loaded.session).toMatchObject({ readOnly: true, visibility: "shared" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ session: { ...session, readOnly: false }, node })),
    );
    await expect(readCurrentProofSession(SESSION_ID)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });
});
