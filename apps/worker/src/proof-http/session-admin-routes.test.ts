import { afterEach, describe, expect, it } from "vitest";
import { ARTIFACT_SESSION_ID, startArtifactService } from "../artifact.testing";
import { importedSessionId } from "../artifact-import";
import { MemoryLibraryStore } from "../memory-library-store";
import type { ProofHttpService } from "./index";

/** N36: session privacy and deletion over HTTP. No authentication: not access control. */

const services: ProofHttpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function scenario() {
  return startArtifactService(services, ARTIFACT_SESSION_ID, new MemoryLibraryStore());
}

const json = (body: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("private-by-default export", () => {
  it("refuses to export a private session without the acknowledgement", async () => {
    const { origin } = await scenario();
    const url = `${origin}/proof-sessions/${encodeURIComponent(ARTIFACT_SESSION_ID)}/export`;

    const refused = await fetch(url);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      diagnostics: [{ code: "private-export-unconfirmed" }],
    });
    expect((await fetch(`${url}?confirmPrivateExport=false`)).status).toBe(403);
    expect((await fetch(`${url}?confirmPrivateExport=yes`)).status).toBe(403);

    const confirmed = await fetch(`${url}?confirmPrivateExport=true`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("content-disposition")).toContain("attachment");
  });

  it("exports a shared session without the acknowledgement, and private again after unsharing", async () => {
    const { origin } = await scenario();
    const base = `${origin}/proof-sessions/${encodeURIComponent(ARTIFACT_SESSION_ID)}`;

    expect((await fetch(`${base}/visibility`)).status).toBe(200);
    expect(await (await fetch(`${base}/visibility`)).json()).toEqual({
      sessionId: ARTIFACT_SESSION_ID,
      visibility: "private",
    });
    const shared = await fetch(`${base}/visibility`, json({ visibility: "shared" }));
    expect(shared.status).toBe(200);
    expect(await shared.json()).toEqual({ sessionId: ARTIFACT_SESSION_ID, visibility: "shared" });
    expect((await fetch(`${base}/export`)).status).toBe(200);

    await fetch(`${base}/visibility`, json({ visibility: "private" }));
    expect((await fetch(`${base}/export`)).status).toBe(403);
  });

  it("answers an unknown session's export with 404, not with the privacy refusal", async () => {
    const { origin } = await scenario();
    expect((await fetch(`${origin}/proof-sessions/session:missing/export`)).status).toBe(404);
  });

  it("offers no way to enumerate sessions", async () => {
    const { origin } = await scenario();
    for (const path of ["/proof-sessions", "/proof-sessions/", "/sessions"]) {
      expect((await fetch(`${origin}${path}`)).status, path).toBe(404);
    }
  });
});

describe("PATCH /proof-sessions/:id/visibility", () => {
  it("validates the method, media type and body", async () => {
    const { origin } = await scenario();
    const url = `${origin}/proof-sessions/${encodeURIComponent(ARTIFACT_SESSION_ID)}/visibility`;

    const post = await fetch(url, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, PATCH");
    expect(
      (await fetch(url, { method: "PATCH", headers: { "content-type": "text/plain" }, body: "x" }))
        .status,
    ).toBe(415);
    expect((await fetch(url, json({ visibility: "public" }))).status).toBe(400);
    expect((await fetch(url, json({ visibility: "shared", extra: 1 }))).status).toBe(400);
    expect(
      (
        await fetch(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "{not json",
        })
      ).status,
    ).toBe(400);
    const missing = await fetch(
      `${origin}/proof-sessions/session:missing/visibility`,
      json({ visibility: "shared" }),
    );
    expect(missing.status).toBe(404);
  });
});

describe("DELETE /proof-sessions/:id", () => {
  it("hard-deletes the session with 204 and then answers 404", async () => {
    const { origin, exportArtifact } = await scenario();
    const url = `${origin}/proof-sessions/${encodeURIComponent(ARTIFACT_SESSION_ID)}`;
    expect((await fetch(url)).status).toBe(200);
    await exportArtifact();

    const deleted = await fetch(url, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect((await fetch(url)).status).toBe(404);
    expect((await fetch(`${url}/export?confirmPrivateExport=true`)).status).toBe(404);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${origin}/proof-sessions/not%20valid`, { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("leaves the other methods of the session route unchanged", async () => {
    const { origin } = await scenario();
    const put = await fetch(`${origin}/proof-sessions/${encodeURIComponent(ARTIFACT_SESSION_ID)}`, {
      method: "PUT",
    });
    expect(put.status).toBe(405);
  });

  it("deletes an imported read-only session and its import record", async () => {
    const source = await scenario();
    const artifact = await source.exportArtifact();
    const target = await startArtifactService(
      services,
      "session:placeholder",
      new MemoryLibraryStore(),
    );
    const upload = () =>
      fetch(`${target.origin}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(artifact),
      });
    const created = await upload();
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    expect(sessionId).toBe(importedSessionId(artifact.digest));
    const url = `${target.origin}/proof-sessions/${encodeURIComponent(sessionId)}`;

    // Imported sessions are private, read-only, and still deletable.
    expect(await (await fetch(`${url}/visibility`)).json()).toMatchObject({
      visibility: "private",
    });
    expect((await fetch(`${url}/export`)).status).toBe(403);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(url)).status).toBe(404);

    // The import record went with it: the same artifact creates a fresh session, not a replay.
    const again = await upload();
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({ sessionId, replayed: false });
  });
});
