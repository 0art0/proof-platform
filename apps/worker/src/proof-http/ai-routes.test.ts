import { afterEach, describe, expect, it } from "vitest";
import {
  DEVELOPMENT_PROOF_SESSION_ID,
  DEVELOPMENT_ROOT_NODE,
  ensureDevelopmentProofSession,
} from "../development-session";
import type { ProofStore } from "../proof-repository";
import { InspectableMemoryProofStore, key } from "../memory-proof-store.testing";
import { createProofNodeSchema } from "@proof/protocol";
import { createProofHttpService, type ProofHttpService } from ".";

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function runningService(store: ProofStore): Promise<string> {
  const service = createProofHttpService(store, { env: {} });
  services.push(service);
  return (await service.listen()).origin;
}

function goalAnchor() {
  return {
    stateId: "state:development-root",
    target: { kind: "goal", id: "goal:development-main" },
    statement: { kind: "conclusion" },
  } as const;
}

describe("AI HTTP route safety", () => {
  it("returns no stale deterministic candidates when the stored set belongs to an older node and AI is disabled", async () => {
    const store = new InspectableMemoryProofStore();
    await ensureDevelopmentProofSession(store);
    const origin = await runningService(store);
    const created = await fetch(
      `${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}/suggestion-sets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "suggestion-set:ai-old-node",
          selections: [{ kind: "exact", anchor: goalAnchor(), path: [] }],
        }),
      },
    );
    expect(created.status).toBe(201);
    const { suggestionSet } = (await created.json()) as {
      suggestionSet: { suggestions: Array<{ id: string }> };
    };
    const candidateId = suggestionSet.suggestions[0]?.id;
    expect(candidateId).toBeDefined();

    const child = createProofNodeSchema().parse({
      ...DEVELOPMENT_ROOT_NODE,
      id: "node:development-ai-child",
      state: { ...DEVELOPMENT_ROOT_NODE.state, id: "state:development-ai-child" },
    });
    store.nodes.set(key(DEVELOPMENT_PROOF_SESSION_ID, child.id), child);
    const session = store.sessions.get(DEVELOPMENT_PROOF_SESSION_ID);
    if (session === undefined) throw new Error("The test session was not initialized.");
    store.sessions.set(DEVELOPMENT_PROOF_SESSION_ID, { ...session, currentNodeId: child.id });

    const response = await fetch(
      `${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}/ai/shortlist`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "llm-call:stale-disabled",
          expectedCurrentNodeId: child.id,
          suggestionSetId: "suggestion-set:ai-old-node",
          candidateIds: [candidateId],
          trigger: "explicit-user",
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "stale",
      provenance: "deterministic",
      fallbackCandidateIds: [],
    });
  });
});
