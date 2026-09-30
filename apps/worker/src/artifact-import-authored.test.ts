import { afterEach, describe, expect, it } from "vitest";
import type { ProofArtifact } from "@proof/protocol";
import { artifactDigest, exportProofArtifact } from "./artifact-export";
import { importProofArtifact, validateProofArtifact } from "./artifact-import";
import { ARTIFACT_SESSION_ID, startArtifactService } from "./artifact.testing";
import { definitionHash } from "./approved-catalog";
import { MemoryLibraryStore } from "./memory-library-store";
import { template } from "./proof-http/authored-move.testing";
import type { ProofHttpService } from "./proof-http";

/**
 * N27 follow-up: a session whose edges applied an approved authored move (N35) exports and imports,
 * revalidated with the base catalog plus the moves approved in the artifact's own library section.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const services: ProofHttpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const HUMAN = { id: "actor:human-1", kind: "human" } as const;
const REVIEWER = { id: "actor:human-reviewer", kind: "human" } as const;
const AGENT = { id: "actor:agent-1", kind: "agent" } as const;
const MOVE_ID = "authored:intro-negation";

async function exportWithAppliedAuthoredMove(): Promise<ProofArtifact> {
  const scenario = await startArtifactService(services);
  let counter = 0;
  const command = async (actor: unknown, body: Json, basis?: Json): Promise<Json> => {
    counter += 1;
    const response = await scenario.post("protocol-commands", {
      commandId: `command:authored-${counter}`,
      actor,
      ...(basis === undefined ? {} : { basis }),
      command: body,
    });
    const json = (await response.json()) as Json;
    expect(response.status, JSON.stringify(json)).toBe(201);
    return json;
  };
  const drafted = await command(HUMAN, {
    kind: "author-move-draft",
    template: template(MOVE_ID),
    payloadSource: "reviewed-authoring",
  });
  await command(REVIEWER, {
    kind: "review-move-draft",
    draftArtifactId: drafted["result"].artifactId,
    decision: "approved",
    notes: "Looks right.",
    payloadSource: "reviewed-authoring",
  });
  const observed = (await (await scenario.get("observe?view=full")).json()) as Json;
  const displayed = (
    await command(
      AGENT,
      {
        kind: "request-suggestions",
        selections: [{ target: observed["targets"][0].alias, statement: "conclusion", path: [] }],
      },
      { nodeId: observed["cursor"].nodeId },
    )
  )["result"].displayed as Json;
  const authored = (displayed["suggestions"] as Json[]).find(
    ({ artifactId }) => artifactId === MOVE_ID,
  );
  expect(authored).toBeDefined();
  await command(
    AGENT,
    { kind: "apply", suggestion: authored?.["alias"] },
    { nodeId: observed["cursor"].nodeId, suggestionSetId: displayed["suggestionSetId"] },
  );
  const exported = await exportProofArtifact(scenario.store, ARTIFACT_SESSION_ID, {
    library: scenario.store,
  });
  if (exported.status !== "exported") throw new Error(JSON.stringify(exported));
  return exported.artifact;
}

function redigest(artifact: Json): Json {
  return { ...artifact, digest: artifactDigest(artifact) };
}

function reviewedMoves(artifact: Json): Json[] {
  return (artifact["library"].additionEvents as Json[]).filter(
    ({ artifact: a }) => a.kind === "move" && a.review !== undefined,
  );
}

describe("artifact import of authored moves", () => {
  it("round-trips a session that applied an approved authored move, using only its own library", async () => {
    const artifact = await exportWithAppliedAuthoredMove();
    expect(artifact.tree.edges.some((edge) => edge.moveId === MOVE_ID)).toBe(true);
    // A fresh store has no authored moves of its own: only the artifact's library counts.
    const result = await importProofArtifact(new MemoryLibraryStore(), artifact);
    expect(result, JSON.stringify(result)).toMatchObject({ status: "imported", replayed: false });
  });

  it("rejects the artifact when its library no longer approves the applied move", async () => {
    const artifact = await exportWithAppliedAuthoredMove();
    const forged = structuredClone(artifact) as Json;
    forged["library"].additionEvents = [];
    forged["library"].finalLibrary = [];
    expect(validateProofArtifact(redigest(forged)).ok).toBe(false);
  });

  it.each([
    [
      "an example removed (too few examples)",
      (move: Json) => {
        move["template"].examples.pop();
      },
    ],
    [
      "a declared transition class that the plan does not compose",
      (move: Json) => {
        move["template"].transitionClass = "strengthening";
      },
    ],
  ])(
    "rejects an approved move template altered with %s and a recomputed digest",
    async (_l, edit) => {
      const artifact = await exportWithAppliedAuthoredMove();
      const forged = structuredClone(artifact) as Json;
      const reviewed = reviewedMoves(forged);
      expect(reviewed.length).toBeGreaterThan(0);
      for (const event of reviewed) {
        edit(event["artifact"]);
        event["artifact"].definitionDigest = definitionHash(event["artifact"].template);
        event["artifact"].review.definitionDigest = event["artifact"].definitionDigest;
      }
      expect(validateProofArtifact(redigest(forged)).ok).toBe(false);
    },
  );

  it("rejects a recorded move digest that no longer describes its template", async () => {
    const artifact = await exportWithAppliedAuthoredMove();
    const forged = structuredClone(artifact) as Json;
    for (const event of reviewedMoves(forged)) {
      event["artifact"].definitionDigest = `sha256:${"0".repeat(64)}`;
    }
    expect(validateProofArtifact(redigest(forged)).ok).toBe(false);
  });
});
