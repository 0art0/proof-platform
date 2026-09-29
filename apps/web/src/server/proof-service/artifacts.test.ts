import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveArtifactFinalMaterial,
  deriveTranslationDictionary,
  proofNodeSchema,
} from "@proof/protocol";

vi.mock("server-only", () => ({}));

import { ProofServiceError, exportProofArtifact, uploadProofArtifact } from ".";

const root = proofNodeSchema.parse({
  id: "node:root",
  state: {
    id: "state:root",
    goals: [
      {
        id: "goal:1",
        sequent: {
          context: { declarations: [], hypotheses: [] },
          conclusion: { expression: "True" },
        },
      },
    ],
    obligations: [],
  },
});
const tree = {
  rootNodeId: root.id,
  currentNodeId: root.id,
  nodes: [root],
  edges: [],
  events: [],
  commands: [],
  suggestionSets: [],
  previews: [],
  replaySteps: [],
  deletions: [],
};
const artifact = {
  artifactVersion: 1,
  kind: "proof-artifact",
  digest: `sha256:${"b".repeat(64)}`,
  sessionId: "session:test",
  provenance: { kind: "session" },
  problemSetup: { metadata: null },
  initialState: { rootNodeId: root.id, operators: [] },
  library: { operators: [], additionEvents: [], backgroundRevisions: [], finalLibrary: [] },
  tree,
  interactionEvents: [],
  inquiryRecords: [],
  final: deriveArtifactFinalMaterial(tree),
  translationDictionary: deriveTranslationDictionary([]),
  llmCalls: [],
};
const imported = {
  sessionId: "session:artifact:0123",
  digest: artifact.digest,
  sourceSessionId: "session:test",
  readOnly: true,
  replayed: false,
};

function stubWorker(body: unknown, status: number) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  process.env.PROOF_HTTP_ORIGIN = "http://proof-worker.test";
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PROOF_HTTP_ORIGIN;
});

describe("exportProofArtifact", () => {
  it("relays the worker's artifact unchanged after checking its schema and session", async () => {
    const fetchMock = stubWorker(artifact, 200);
    expect(await exportProofArtifact("session:test")).toEqual({
      ok: true,
      status: 200,
      body: artifact,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://proof-worker.test/proof-sessions/session%3Atest/export",
    );
  });

  it("rejects an artifact of another session or an invalid artifact", async () => {
    stubWorker({ ...artifact, sessionId: "session:other" }, 200);
    await expect(exportProofArtifact("session:test")).rejects.toMatchObject({
      code: "invalid_upstream_response",
      status: 502,
    });
    stubWorker({ ...artifact, extra: 1 }, 200);
    await expect(exportProofArtifact("session:test")).rejects.toBeInstanceOf(ProofServiceError);
  });

  it("returns worker diagnostics as a failed answer", async () => {
    const body = { diagnostics: [{ code: "session-not-found", message: "No session." }] };
    stubWorker(body, 404);
    expect(await exportProofArtifact("session:test")).toEqual({
      ok: false,
      status: 404,
      code: "session-not-found",
      message: "No session.",
      body,
    });
  });
});

describe("uploadProofArtifact", () => {
  it("posts the artifact and returns the created read-only session", async () => {
    const fetchMock = stubWorker(imported, 201);
    expect(await uploadProofArtifact(artifact)).toEqual({ ok: true, status: 201, body: imported });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("http://proof-worker.test/artifacts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(artifact);
  });

  it("checks that the status agrees with the replay flag", async () => {
    stubWorker(imported, 200);
    await expect(uploadProofArtifact(artifact)).rejects.toMatchObject({
      code: "invalid_upstream_response",
    });
  });

  it("returns revalidation diagnostics with their path", async () => {
    const body = {
      diagnostics: [{ code: "digest-mismatch", message: "Changed.", path: ["digest"] }],
    };
    stubWorker(body, 422);
    expect(await uploadProofArtifact(artifact)).toEqual({
      ok: false,
      status: 422,
      code: "digest-mismatch",
      message: "Changed.",
      body,
    });
  });

  it("refuses a non-object artifact without calling the worker", async () => {
    const fetchMock = stubWorker(imported, 201);
    await expect(uploadProofArtifact([artifact])).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
