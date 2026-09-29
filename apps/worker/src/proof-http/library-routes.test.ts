import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ProofArtifact } from "@proof/protocol";
import { importedSessionId } from "../artifact-import";
import {
  ARTIFACT_SESSION_ID,
  buildArtifactScenario,
  libraryResult,
  startArtifactService,
} from "../artifact.testing";
import { addLibraryArtifact } from "../library-repository";
import { MemoryLibraryStore } from "../memory-library-store";
import type { ProofHttpService } from ".";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** N32 over HTTP: the read-only library and addition-event views. */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const at = (second: number) => `2026-09-29T11:00:0${second}.000Z`;

async function addTo(store: MemoryLibraryStore, id: string, artifactId: string, level: string) {
  const artifact = libraryResult(artifactId, { domains: ["logic"], level });
  return addLibraryArtifact(store, {
    id,
    sessionId: ARTIFACT_SESSION_ID,
    occurredAt: at(1),
    layer: artifact.layer,
    origin: { kind: "user", actorId: "user:reader" },
    artifact,
  });
}

async function getJson(url: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as Json };
}

describe("GET /proof-sessions/:id/library", () => {
  it("lists the approved catalog and the session layers with their stored records", async () => {
    const scenario = await startArtifactService(services);
    expect(await addTo(scenario.store, "addition:1", "result:logic", "foundational")).toMatchObject(
      { admitted: true },
    );
    const { status, body } = await getJson(
      `${scenario.origin}/proof-sessions/${ARTIFACT_SESSION_ID}/library`,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ sessionId: ARTIFACT_SESSION_ID, readOnly: false });
    const entries = body.entries as { source: string; artifact: Json }[];
    const catalog = entries.filter(({ source }) => source === "approved-catalog");
    const stored = entries.filter(({ source }) => source === "stored-library");
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every(({ artifact }) => artifact.layer === "global")).toBe(true);
    expect(catalog[0]?.artifact).toMatchObject({
      kind: "result",
      classification: { domains: expect.any(Array) },
      provenance: expect.any(Object),
      approval: { status: "approved" },
      statement: expect.any(Object),
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.artifact).toMatchObject({
      id: "result:logic",
      layer: "proof-time-background",
      approval: { status: "approved", reviewerId: "reviewer:test" },
      provenance: { kind: "curated" },
    });
    expect(Array.isArray(body.variantFamilies)).toBe(true);
  });

  it("answers 404 for an unknown session and 405 for other methods", async () => {
    const scenario = await startArtifactService(services);
    for (const path of ["library", "library/events"]) {
      const missing = await getJson(`${scenario.origin}/proof-sessions/session:missing/${path}`);
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ diagnostics: [{ code: "session-not-found" }] });
      const post = await fetch(`${scenario.origin}/proof-sessions/${ARTIFACT_SESSION_ID}/${path}`, {
        method: "POST",
      });
      expect(post.status).toBe(405);
    }
  });
});

describe("GET /proof-sessions/:id/library/events", () => {
  it("lists admitted and rejected additions with diagnostics, without changing them", async () => {
    const scenario = await startArtifactService(services);
    await addTo(scenario.store, "addition:1", "result:logic", "foundational");
    // The background allows undergraduate at most, so a graduate result is rejected and recorded.
    expect(await addTo(scenario.store, "addition:2", "result:hard", "graduate")).toMatchObject({
      admitted: false,
    });
    const { status, body } = await getJson(
      `${scenario.origin}/proof-sessions/${ARTIFACT_SESSION_ID}/library/events`,
    );
    expect(status).toBe(200);
    const events = body.events as Json[];
    expect(events.map(({ id }) => id)).toEqual(["addition:1", "addition:2"]);
    expect(events[0]?.admission).toEqual({ decision: "admitted", diagnostics: [] });
    expect(events[1]?.admission).toMatchObject({
      decision: "rejected",
      diagnostics: [{ code: "level-above-background" }],
    });
    expect(events[1]?.artifact).toMatchObject({ id: "result:hard" });
    // A rejection adds no artifact row.
    const library = await getJson(
      `${scenario.origin}/proof-sessions/${ARTIFACT_SESSION_ID}/library`,
    );
    expect(
      (library.body.entries as { artifact: Json }[]).some(
        ({ artifact }) => artifact.id === "result:hard",
      ),
    ).toBe(false);
  });
});

describe("an imported read-only session", () => {
  let artifact: ProofArtifact;
  beforeAll(async () => {
    const built: ProofHttpService[] = [];
    const scenario = await buildArtifactScenario(built);
    artifact = await scenario.exportArtifact();
    await Promise.all(built.map((service) => service.close()));
  }, 60_000);

  it("shows the artifact's static library and addition events", async () => {
    const target = await startArtifactService(
      services,
      "session:placeholder",
      new MemoryLibraryStore(),
    );
    const upload = await fetch(`${target.origin}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(artifact),
    });
    expect(upload.status).toBe(201);
    const id = encodeURIComponent(importedSessionId(artifact.digest));
    const library = await getJson(`${target.origin}/proof-sessions/${id}/library`);
    expect(library.status).toBe(200);
    expect(library.body.readOnly).toBe(true);
    const stored = (library.body.entries as { source: string; artifact: Json }[])
      .filter(({ source }) => source === "stored-library")
      .map(({ artifact: entry }) => entry.id);
    expect(stored).toEqual(artifact.library.finalLibrary.map(({ id: artifactId }) => artifactId));
    expect(stored).toContain("result:logic");

    const events = await getJson(`${target.origin}/proof-sessions/${id}/library/events`);
    expect(events.status).toBe(200);
    expect(events.body.readOnly).toBe(true);
    expect((events.body.events as Json[]).map(({ id: eventId }) => eventId)).toEqual(
      artifact.library.additionEvents.map(({ id: eventId }) => eventId),
    );
    expect(
      (events.body.events as Json[]).some(({ admission }) => admission.decision === "rejected"),
    ).toBe(true);
  });
});
