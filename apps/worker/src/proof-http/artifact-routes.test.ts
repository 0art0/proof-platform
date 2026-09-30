import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  proofArtifactImportResponseSchema,
  proofArtifactRejectionResponseSchema,
  type ProofArtifact,
  type ProofNode,
} from "@proof/protocol";
import { artifactDigest } from "../artifact-export";
import { importedSessionId } from "../artifact-import";
import {
  ARTIFACT_SESSION_ID,
  buildArtifactScenario,
  contrapositionProblem,
  startArtifactService,
} from "../artifact.testing";
import { MemoryLibraryStore } from "../memory-library-store";
import type { ProofHttpService } from ".";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
import { artifactFileName } from "./artifact-routes";

/** N27 over HTTP: export, upload (201/200/422/409), and read-only enforcement of every route. */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

let artifact: ProofArtifact;

beforeAll(async () => {
  const built: ProofHttpService[] = [];
  const scenario = await buildArtifactScenario(built);
  artifact = await scenario.exportArtifact();
  await Promise.all(built.map((service) => service.close()));
}, 60_000);

async function upload(origin: string, body: unknown, contentType = "application/json") {
  const response = await fetch(`${origin}/artifacts`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

/** A fresh service holding only a placeholder session, to upload into. */
async function target() {
  return startArtifactService(services, "session:placeholder", new MemoryLibraryStore());
}

describe("GET /proof-sessions/:id/export", () => {
  it("returns the artifact as an attachment and 404 for an unknown session", async () => {
    const scenario = await startArtifactService(services);
    const response = await fetch(
      `${scenario.origin}/proof-sessions/${ARTIFACT_SESSION_ID}/export?confirmPrivateExport=true`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="session-artifact-source.proof-artifact.json"',
    );
    const exported = (await response.json()) as ProofArtifact;
    expect(exported).toMatchObject({ artifactVersion: 1, sessionId: ARTIFACT_SESSION_ID });
    expect(exported.digest).toBe(artifactDigest(exported));

    const missing = await fetch(`${scenario.origin}/proof-sessions/session:missing/export`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ diagnostics: [{ code: "session-not-found" }] });
    const wrongMethod = await fetch(
      `${scenario.origin}/proof-sessions/${ARTIFACT_SESSION_ID}/export`,
      { method: "POST" },
    );
    expect(wrongMethod.status).toBe(405);
    expect(artifactFileName("session:a/b c")).toBe("session-a-b-c.proof-artifact.json");
  });
});

describe("POST /artifacts", () => {
  it("creates a read-only session, replays an identical upload, and re-exports it", async () => {
    const service = await target();
    const created = await upload(service.origin, artifact);
    expect(created.status).toBe(201);
    expect(proofArtifactImportResponseSchema.parse(created.body)).toEqual({
      sessionId: importedSessionId(artifact.digest),
      digest: artifact.digest,
      sourceSessionId: ARTIFACT_SESSION_ID,
      readOnly: true,
      replayed: false,
    });
    const replayed = await upload(service.origin, artifact);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ sessionId: created.body.sessionId, replayed: true });

    const session = await fetch(
      `${service.origin}/proof-sessions/${encodeURIComponent(created.body.sessionId)}`,
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      session: { currentNodeId: artifact.tree.currentNodeId },
    });
    const reexported = await service.exportArtifact(created.body.sessionId);
    expect(reexported.provenance).toEqual({
      kind: "import",
      sourceSessionId: ARTIFACT_SESSION_ID,
      sourceDigest: artifact.digest,
    });
    expect(reexported.tree).toEqual(artifact.tree);
  });

  it("answers 422 with a precise diagnostic, and writes nothing, for a tampered upload", async () => {
    const service = await target();
    const forged = structuredClone(artifact) as Json;
    forged.final.solved = !forged.final.solved;
    const response = await upload(service.origin, { ...forged, digest: artifactDigest(forged) });
    expect(response.status).toBe(422);
    expect(proofArtifactRejectionResponseSchema.parse(response.body).diagnostics).toEqual([
      expect.objectContaining({ code: "final-material-mismatch", path: ["final"] }),
    ]);
    const stale = await upload(service.origin, forged);
    expect(stale.status).toBe(422);
    expect(stale.body.diagnostics[0].code).toBe("digest-mismatch");
    const lookup = await fetch(
      `${service.origin}/proof-sessions/${encodeURIComponent(importedSessionId(artifactDigest(forged)))}`,
    );
    expect(lookup.status).toBe(404);
  });

  it("answers 409 when the derived session ID holds other content", async () => {
    const store = new MemoryLibraryStore();
    await startArtifactService([], importedSessionId(artifact.digest), store);
    const service = await startArtifactService(services, "session:placeholder", store);
    const response = await upload(service.origin, artifact);
    expect(response.status).toBe(409);
    expect(response.body.diagnostics[0].code).toBe("session-conflict");
  });

  it("rejects malformed requests", async () => {
    const service = await target();
    expect((await upload(service.origin, artifact, "text/plain")).status).toBe(415);
    expect((await upload(service.origin, "{not json")).status).toBe(400);
    expect((await upload(service.origin, { artifactVersion: 7 })).body).toMatchObject({
      diagnostics: [{ code: "unsupported-version" }],
    });
    const wrongMethod = await fetch(`${service.origin}/artifacts`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
  });
});

describe("GET /proof-sessions/:id of an imported session", () => {
  it("exposes the read-only marker, and only for an imported session", async () => {
    const service = await target();
    const created = await upload(service.origin, artifact);
    const session = async (id: string) =>
      (
        (await (
          await fetch(`${service.origin}/proof-sessions/${encodeURIComponent(id)}`)
        ).json()) as Json
      ).session as Json;
    expect((await session(created.body.sessionId as string)).readOnly).toBe(true);
    expect(await session("session:placeholder")).not.toHaveProperty("readOnly");
  });
});

describe("a read-only imported session", () => {
  it("refuses every mutation route and command with 409 session-read-only", async () => {
    const service = await target();
    const created = await upload(service.origin, artifact);
    expect(created.status).toBe(201);
    const sessionId = created.body.sessionId as string;
    const url = `${service.origin}/proof-sessions/${encodeURIComponent(sessionId)}`;
    const post = (path: string, body: unknown) =>
      fetch(`${url}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const current = ((await (await fetch(url)).json()) as { node: ProofNode }).node;
    const rootNodeId = artifact.tree.rootNodeId;
    const firstStepNode = "node:command:contraposition-1";
    const goal = current.state.goals[0];
    if (goal === undefined) throw new Error("The imported cursor has no open goal.");
    const human = { id: "actor:web", kind: "human" };
    const before = await service.exportArtifact(sessionId);

    const attempts: readonly (readonly [string, () => Promise<Response>])[] = [
      [
        "suggestion-sets",
        () =>
          post("suggestion-sets", {
            id: "suggestion-set:read-only",
            selections: [
              {
                kind: "exact",
                anchor: {
                  stateId: current.state.id,
                  target: { kind: "goal", id: goal.id },
                  statement: { kind: "conclusion" },
                },
                path: [],
              },
            ],
          }),
      ],
      [
        "backtrack",
        () => post("backtrack", { expectedCurrentNodeId: current.id, targetNodeId: rootNodeId }),
      ],
      [
        "delete-previous-move",
        () =>
          post("delete-previous-move", {
            commandId: "command:read-only-delete",
            expectedCurrentNodeId: current.id,
          }),
      ],
      [
        "backtrack-with-information",
        () =>
          post("backtrack-with-information", {
            commandId: "command:read-only-cases",
            expectedCurrentNodeId: current.id,
            sourceNodeId: current.id,
            proposition: "p",
          }),
      ],
      [
        "replay",
        () =>
          post("replay", {
            commandId: "command:read-only-replay",
            expectedCurrentNodeId: current.id,
            source: { fromNodeId: firstStepNode, toNodeId: "node:command:contraposition-2" },
          }),
      ],
      [
        "interaction-events",
        () =>
          post("interaction-events", {
            id: "interaction:read-only",
            nodeId: current.id,
            kind: "suggestions-requested",
            suggestionSetId: "suggestion-set:read-only",
          }),
      ],
      [
        "inquiry-commands",
        () =>
          post("inquiry-commands", {
            commandId: "inquiry:read-only",
            nodeId: current.id,
            records: [
              {
                id: "question:read-only",
                kind: "question",
                question: {
                  form: "establish",
                  proposition: {
                    kind: "target",
                    nodeId: current.id,
                    target: { kind: "goal", id: goal.id },
                  },
                },
              },
            ],
          }),
      ],
      [
        "protocol-commands sorry",
        () =>
          post("protocol-commands", {
            commandId: "command:read-only-sorry",
            actor: human,
            basis: { nodeId: current.id },
            command: { kind: "sorry", target: "g1" },
          }),
      ],
      [
        "protocol-commands request-suggestions",
        () =>
          post("protocol-commands", {
            commandId: "command:read-only-suggest",
            actor: human,
            basis: { nodeId: current.id },
            command: {
              kind: "request-suggestions",
              selections: [{ target: "g1", statement: "conclusion", path: [] }],
            },
          }),
      ],
      [
        "protocol-commands delete-previous-move",
        () =>
          post("protocol-commands", {
            commandId: "command:read-only-envelope-delete",
            actor: human,
            basis: { nodeId: current.id },
            command: { kind: "delete-previous-move" },
          }),
      ],
      [
        "protocol-commands backtrack",
        () =>
          post("protocol-commands", {
            commandId: "command:read-only-envelope-backtrack",
            actor: human,
            basis: { nodeId: current.id },
            command: { kind: "backtrack", targetNodeId: rootNodeId },
          }),
      ],
    ];
    for (const [label, attempt] of attempts) {
      const response = await attempt();
      const body = (await response.json()) as { diagnostics?: { code: string }[] };
      expect([label, response.status, body.diagnostics?.[0]?.code]).toEqual([
        label,
        409,
        "session-read-only",
      ]);
    }

    // Reads still work, and nothing was written.
    expect((await fetch(`${url}/history`)).status).toBe(200);
    expect((await fetch(`${url}/observe?view=summary`)).status).toBe(200);
    expect(await service.exportArtifact(sessionId)).toEqual(before);
    expect(contrapositionProblem().id).toBe("corpus:contraposition");
  });
});
