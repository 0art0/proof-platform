import { afterEach, describe, expect, it } from "vitest";
import { HAND_AUTHORED_MOVES, type MoveDefinition } from "@proof/moves";
import {
  createProofNodeSchema,
  interactionEventSchema,
  type DisplayedSuggestionSet,
  type InteractionEvent,
  type MovePreview,
  type ProofEdge,
} from "@proof/protocol";
import {
  APPROVED_DEFINITIONS,
  approvedCatalog,
  definitionHash,
  type DefinitionCatalog,
} from "../approved-catalog";
import { DEVELOPMENT_PROOF_SESSION_ID, DEVELOPMENT_ROOT_NODE } from "../development-session";
import {
  initializeProofSession,
  listInteractionEvents,
  recordInteractionEvent,
} from "../proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore } from "../memory-proof-store.testing";
import { createProofHttpService, type ProofHttpService } from ".";

/**
 * N19 acceptance (refinement §12): an ordered, node-anchored, idempotent interaction-event log,
 * and previews that record definition hashes so that apply regenerates a stale preview (and
 * records the regeneration) instead of applying stale definitions.
 */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const SPLIT = "move:split-goal-conjunction";
const ROOT_NODE_ID = "node:development-root";
const ROOT_STATE_ID = "state:development-root";
const WEB_ACTOR = { id: "actor:web", kind: "human" } as const;
const FIXED_NOW = () => new Date("2026-09-27T12:00:00.000Z");

/** A mutable catalog: tests replace `moves` to change a definition between preview and apply. */
function mutableDefinitions(): DefinitionCatalog & { moves: readonly MoveDefinition[] } {
  return { moves: HAND_AUTHORED_MOVES, catalog: approvedCatalog };
}

function revisedMoves(moveId: string): readonly MoveDefinition[] {
  return HAND_AUTHORED_MOVES.map((move) =>
    move.id === moveId
      ? { ...move, discoveryContext: "Revised after the preview was shown." }
      : move,
  );
}

const binaryRoot = createProofNodeSchema().parse({
  ...DEVELOPMENT_ROOT_NODE,
  state: {
    ...DEVELOPMENT_ROOT_NODE.state,
    goals: [
      {
        ...DEVELOPMENT_ROOT_NODE.state.goals[0],
        sequent: {
          ...DEVELOPMENT_ROOT_NODE.state.goals[0]?.sequent,
          conclusion: { expression: ["And", "p", "q"] },
        },
      },
    ],
  },
});

const goalSelection = {
  kind: "exact",
  anchor: {
    stateId: ROOT_STATE_ID,
    target: { kind: "goal", id: "goal:development-main" },
    statement: { kind: "conclusion" },
  },
  path: [],
} as const;

type Harness = Readonly<{
  store: MemoryProofStore;
  definitions: DefinitionCatalog & { moves: readonly MoveDefinition[] };
  sessionUrl: string;
  post(path: string, body: unknown): Promise<Response>;
  get(path: string): Promise<Response>;
}>;

async function harness(): Promise<Harness> {
  const store = new MemoryProofStore();
  expect(
    await initializeProofSession(store, {
      sessionId: DEVELOPMENT_PROOF_SESSION_ID,
      rootNode: binaryRoot,
    }),
  ).toMatchObject({ status: "committed" });
  const definitions = mutableDefinitions();
  // The service reads `definitions.moves` on every request, so reassigning it simulates an
  // approved definition changing while the worker keeps running.
  const service = createProofHttpService(store, {
    definitions: {
      get moves() {
        return definitions.moves;
      },
      catalog: (operators) => definitions.catalog(operators),
    },
    now: FIXED_NOW,
  });
  services.push(service);
  const { origin } = await service.listen();
  const sessionUrl = `${origin}/proof-sessions/${DEVELOPMENT_PROOF_SESSION_ID}`;
  return {
    store,
    definitions,
    sessionUrl,
    post: (path, body) =>
      fetch(`${sessionUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    get: (path) => fetch(`${sessionUrl}${path}`),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function displayedSplit(
  h: Harness,
  id = "suggestion-set:events",
): Promise<Readonly<{ set: DisplayedSuggestionSet; splitId: string }>> {
  const response = await h.post("/suggestion-sets", { id, selections: [goalSelection] });
  expect(response.status).toBe(201);
  const set = (await json(response)).suggestionSet as DisplayedSuggestionSet;
  const split = set.suggestions.find(({ artifactId }) => artifactId === SPLIT);
  if (split === undefined) throw new Error("Expected the split suggestion to be displayed.");
  return { set, splitId: split.id };
}

async function events(h: Harness, query = ""): Promise<InteractionEvent[]> {
  const response = await h.get(`/interaction-events${query}`);
  expect(response.status).toBe(200);
  return (await json(response)).events as InteractionEvent[];
}

describe("interaction-event log", () => {
  it("assigns strictly increasing per-session sequence numbers in recording order", async () => {
    const h = await harness();
    expect(
      (
        await h.post("/interaction-events", {
          id: "interaction:1",
          nodeId: ROOT_NODE_ID,
          kind: "selection-changed",
          selections: [goalSelection],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await h.post("/interaction-events", {
          id: "interaction:2",
          nodeId: ROOT_NODE_ID,
          kind: "suggestions-requested",
          suggestionSetId: "suggestion-set:events",
        })
      ).status,
    ).toBe(201);
    const { set, splitId } = await displayedSplit(h);
    const displayed = await h.post("/interaction-events", {
      id: "interaction:3",
      nodeId: ROOT_NODE_ID,
      kind: "suggestions-displayed",
      suggestionSetId: set.id,
      suggestionIds: set.suggestions.map(({ id }) => id),
    });
    expect(displayed.status).toBe(201);
    expect(await json(displayed)).toEqual({
      replayed: false,
      event: {
        id: "interaction:3",
        sequence: 3,
        nodeId: ROOT_NODE_ID,
        stateId: ROOT_STATE_ID,
        actor: WEB_ACTOR,
        recordedAt: "2026-09-27T12:00:00.000Z",
        kind: "suggestions-displayed",
        suggestionSetId: set.id,
        suggestionIds: set.suggestions.map(({ id }) => id),
      },
    });
    for (const [id, body] of [
      ["interaction:4", { kind: "menu-expanded", suggestionSetId: set.id, suggestionId: splitId }],
      [
        "interaction:5",
        {
          kind: "preview-requested",
          suggestionSetId: set.id,
          chosenSuggestionId: splitId,
          commandId: "command:events",
        },
      ],
      [
        "interaction:6",
        { kind: "focus-changed", target: { kind: "goal", id: "goal:development-main" } },
      ],
      ["interaction:7", { kind: "objective-changed", objective: "Split the conjunction first." }],
      [
        "interaction:8",
        { kind: "interaction-ended-without-action", suggestionSetId: set.id, reason: "dismissed" },
      ],
    ] as const) {
      expect(
        (await h.post("/interaction-events", { id, nodeId: ROOT_NODE_ID, ...body })).status,
      ).toBe(201);
    }

    const all = await events(h);
    expect(all.map(({ id, sequence, kind }) => [id, sequence, kind])).toEqual([
      ["interaction:1", 1, "selection-changed"],
      ["interaction:2", 2, "suggestions-requested"],
      ["interaction:3", 3, "suggestions-displayed"],
      ["interaction:4", 4, "menu-expanded"],
      ["interaction:5", 5, "preview-requested"],
      ["interaction:6", 6, "focus-changed"],
      ["interaction:7", 7, "objective-changed"],
      ["interaction:8", 8, "interaction-ended-without-action"],
    ]);
    expect(all.every((event) => interactionEventSchema.safeParse(event).success)).toBe(true);
    expect((await events(h, "?after=5")).map(({ sequence }) => sequence)).toEqual([6, 7, 8]);
    expect((await events(h, "?after=2&limit=2")).map(({ sequence }) => sequence)).toEqual([3, 4]);
    expect(await events(h, "?nodeId=node:elsewhere")).toEqual([]);
    expect((await h.get("/interaction-events?after=-1")).status).toBe(400);
    expect((await h.get("/interaction-events?unknown=1")).status).toBe(400);
  });

  it("replays an identical retry without a new sequence and rejects a conflicting reuse", async () => {
    const h = await harness();
    const event = {
      id: "interaction:retry",
      nodeId: ROOT_NODE_ID,
      kind: "objective-changed",
      objective: "Prove the conjunction.",
    };
    const first = await h.post("/interaction-events", event);
    expect(first.status).toBe(201);
    const retry = await h.post("/interaction-events", event);
    expect(retry.status).toBe(200);
    const replayed = await json(retry);
    expect(replayed).toMatchObject({ replayed: true, event: { sequence: 1 } });
    expect(replayed.event).toEqual((await json(first)).event);

    const conflict = await h.post("/interaction-events", {
      ...event,
      objective: "Something else.",
    });
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({
      diagnostics: [{ code: "interaction-event-conflict" }],
    });
    expect(
      (
        await h.post("/interaction-events", {
          id: "interaction:next",
          nodeId: ROOT_NODE_ID,
          kind: "objective-changed",
          objective: "Next.",
        })
      ).status,
    ).toBe(201);
    expect((await events(h)).map(({ id, sequence }) => [id, sequence])).toEqual([
      ["interaction:retry", 1],
      ["interaction:next", 2],
    ]);
    expect(h.store.interactionEvents.size).toBe(2);
  });

  it("gives concurrent recordings distinct consecutive sequence numbers", async () => {
    const h = await harness();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        recordInteractionEvent(
          h.store,
          DEVELOPMENT_PROOF_SESSION_ID,
          {
            id: `interaction:concurrent-${index}`,
            nodeId: ROOT_NODE_ID,
            kind: "objective-changed",
            objective: `Objective ${index}.`,
          },
          WEB_ACTOR,
        ),
      ),
    );
    const sequences = results.map((result) =>
      result.status === "committed" ? result.event.sequence : -1,
    );
    expect([...sequences].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 12 }, (_unused, index) => index + 1),
    );
    const listed = await listInteractionEvents(h.store, DEVELOPMENT_PROOF_SESSION_ID);
    expect(listed.status === "loaded" ? listed.events.map(({ sequence }) => sequence) : []).toEqual(
      Array.from({ length: 12 }, (_unused, index) => index + 1),
    );
  });

  it("rejects strictness violations, unknown anchors and references outside the anchor node", async () => {
    const h = await harness();
    const { set, splitId } = await displayedSplit(h);
    expect(set.suggestions.length).toBeGreaterThan(1);
    const rejected = async (body: unknown, status: number) => {
      const response = await h.post("/interaction-events", body);
      expect(response.status).toBe(status);
    };
    await rejected(
      {
        id: "interaction:x",
        nodeId: ROOT_NODE_ID,
        kind: "objective-changed",
        objective: "x",
        extra: 1,
      },
      400,
    );
    await rejected(
      {
        id: "interaction:x",
        nodeId: ROOT_NODE_ID,
        kind: "preview-regenerated",
        commandId: "command:x",
        stalePreviewId: "preview:a",
        previewId: "preview:b",
        operationChanged: false,
        changedDefinitions: [],
      },
      400,
    );
    await rejected(
      { id: "interaction:x", nodeId: "node:missing", kind: "objective-changed", objective: "x" },
      400,
    );
    await rejected(
      {
        id: "interaction:x",
        nodeId: ROOT_NODE_ID,
        kind: "selection-changed",
        selections: [
          { ...goalSelection, anchor: { ...goalSelection.anchor, stateId: "state:old" } },
        ],
      },
      400,
    );
    await rejected(
      {
        id: "interaction:x",
        nodeId: ROOT_NODE_ID,
        kind: "suggestions-displayed",
        suggestionSetId: set.id,
        suggestionIds: [...set.suggestions.map(({ id }) => id)].reverse(),
      },
      400,
    );
    await rejected(
      {
        id: "interaction:y",
        nodeId: ROOT_NODE_ID,
        kind: "menu-expanded",
        suggestionSetId: set.id,
        suggestionId: "suggestion:not-displayed",
      },
      400,
    );
    await rejected(
      {
        id: "interaction:y",
        nodeId: ROOT_NODE_ID,
        kind: "preview-rejected",
        previewId: "preview:missing",
        reason: "dismissed",
      },
      400,
    );
    await rejected(
      {
        id: "interaction:y",
        nodeId: ROOT_NODE_ID,
        kind: "focus-changed",
        target: { kind: "obligation", id: "goal:development-main" },
      },
      400,
    );
    // A subsequence of the displayed order is accepted.
    await rejected(
      {
        id: "interaction:z",
        nodeId: ROOT_NODE_ID,
        kind: "suggestions-displayed",
        suggestionSetId: set.id,
        suggestionIds: [splitId],
      },
      201,
    );
    expect(h.store.interactionEvents.size).toBe(1);
  });

  it("rolls back an event whose insert fails and keeps the sequence gap-free", async () => {
    const h = await harness();
    const event = {
      id: "interaction:fail",
      nodeId: ROOT_NODE_ID,
      kind: "objective-changed",
      objective: "x",
    };
    h.store.failAt = "insertInteractionEvent";
    expect(
      await recordInteractionEvent(h.store, DEVELOPMENT_PROOF_SESSION_ID, event, WEB_ACTOR),
    ).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "storage-failure" }],
    });
    h.store.failAt = undefined;
    expect(
      await recordInteractionEvent(h.store, DEVELOPMENT_PROOF_SESSION_ID, event, WEB_ACTOR),
    ).toMatchObject({
      status: "committed",
      replayed: false,
      event: { sequence: 1 },
    });
  });

  it("records a preview rejection and removes events anchored at a deleted move", async () => {
    const h = await harness();
    const { set, splitId } = await displayedSplit(h);
    const choice = {
      commandId: "command:events-delete",
      suggestionSetId: set.id,
      chosenSuggestionId: splitId,
    };
    expect((await h.post("/move-previews", choice)).status).toBe(201);
    expect(
      (
        await h.post("/interaction-events", {
          id: "interaction:rejected",
          nodeId: ROOT_NODE_ID,
          kind: "preview-rejected",
          previewId: "preview:command:events-delete",
          reason: "dismissed",
        })
      ).status,
    ).toBe(201);
    expect((await h.post("/commands", choice)).status).toBe(201);
    const childNodeId = "node:command:events-delete";
    expect(
      (
        await h.post("/interaction-events", {
          id: "interaction:child",
          nodeId: childNodeId,
          kind: "interaction-ended-without-action",
          reason: "navigated",
        })
      ).status,
    ).toBe(201);
    expect((await events(h, `?nodeId=${childNodeId}`)).map(({ id }) => id)).toEqual([
      "interaction:child",
    ]);

    const deleted = await h.post("/delete-previous-move", {
      commandId: "command:events-delete-undo",
      expectedCurrentNodeId: childNodeId,
    });
    expect(deleted.status).toBe(200);
    // The child's events are removed with it, and so is the rejection naming the applied preview.
    expect((await events(h)).map(({ id }) => id)).toEqual([]);
  });
});

describe("preview coherence with changed definitions", () => {
  it("records definition hashes on previews", async () => {
    const h = await harness();
    const { set, splitId } = await displayedSplit(h);
    const response = await h.post("/move-previews", {
      commandId: "command:hashes",
      suggestionSetId: set.id,
      chosenSuggestionId: splitId,
    });
    expect(response.status).toBe(201);
    const move = HAND_AUTHORED_MOVES.find(({ id }) => id === SPLIT);
    expect((await json(response)).preview).toMatchObject({
      definitions: [{ kind: "move", id: SPLIT, hash: definitionHash(move) }],
    });
    expect(definitionHash(move)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(definitionHash({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      definitionHash({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
    expect(APPROVED_DEFINITIONS.moves).toBe(HAND_AUTHORED_MOVES);
  });

  it("regenerates a stale preview on apply, records it, and applies only the confirmed fresh preview", async () => {
    const h = await harness();
    const { set, splitId } = await displayedSplit(h);
    const choice = {
      commandId: "command:stale",
      suggestionSetId: set.id,
      chosenSuggestionId: splitId,
    };
    const previewResponse = await h.post("/move-previews", choice);
    expect(previewResponse.status).toBe(201);
    const stale = (await json(previewResponse)).preview as MovePreview;
    const staleHash = stale.definitions?.[0]?.hash;

    // An approved move definition changes between preview and apply.
    h.definitions.moves = revisedMoves(SPLIT);
    const currentHash = definitionHash(h.definitions.moves.find(({ id }) => id === SPLIT));
    expect(currentHash).not.toBe(staleHash);

    const apply = await h.post("/commands", choice);
    expect(apply.status).toBe(409);
    const regenerated = await json(apply);
    expect(regenerated).toMatchObject({
      status: "preview-regenerated",
      stalePreviewId: "preview:command:stale",
      diagnostics: [{ code: "preview-regenerated" }],
      preview: {
        nodeId: ROOT_NODE_ID,
        suggestionSetId: set.id,
        chosenSuggestionId: splitId,
        definitions: [{ kind: "move", id: SPLIT, hash: currentHash }],
      },
    });
    const fresh = regenerated.preview as MovePreview;
    expect(fresh.id).toMatch(/^preview:command:stale:regenerated:[0-9a-f]{16}$/);

    // Nothing was applied, the stale preview is untouched, and the regeneration is recorded.
    expect(await json(await h.get(""))).toMatchObject({ session: { currentNodeId: ROOT_NODE_ID } });
    expect(h.store.edges.size).toBe(0);
    expect(h.store.previews.size).toBe(2);
    const stored = [...h.store.previews.values()].find(({ id }) => id === stale.id);
    expect(stored?.definitions).toEqual(stale.definitions);
    const logged = await events(h);
    expect(logged).toEqual([
      {
        id: `event:${fresh.id}`,
        sequence: 1,
        nodeId: ROOT_NODE_ID,
        stateId: ROOT_STATE_ID,
        actor: WEB_ACTOR,
        recordedAt: "2026-09-27T12:00:00.000Z",
        kind: "preview-regenerated",
        commandId: "command:stale",
        stalePreviewId: "preview:command:stale",
        previewId: fresh.id,
        operationChanged: false,
        changedDefinitions: [{ kind: "move", id: SPLIT, staleHash, currentHash }],
      },
    ]);

    // Showing the preview again returns the recorded regeneration without a second event.
    const reviewed = await h.post("/move-previews", choice);
    expect(reviewed.status).toBe(200);
    expect(await json(reviewed)).toMatchObject({
      replayed: true,
      regeneratedFrom: "preview:command:stale",
      preview: { id: fresh.id },
    });

    // Repeating the command confirms the regenerated preview, which is what gets applied.
    const confirmed = await h.post("/commands", choice);
    expect(confirmed.status).toBe(201);
    expect(await json(confirmed)).toMatchObject({
      session: { currentNodeId: "node:command:stale" },
      receipt: { commandId: "command:stale" },
    });
    const history = await json(await h.get("/history"));
    const edges = (history.edges as Array<{ edge: ProofEdge }>).map(({ edge }) => edge);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.previewId).toBe(fresh.id);

    const replay = await h.post("/commands", choice);
    expect(replay.status).toBe(200);
    expect(await json(replay)).toMatchObject({ replayed: true });
    expect((await events(h)).map(({ kind }) => kind)).toEqual(["preview-regenerated"]);
    expect(h.store.previews.size).toBe(2);
  });

  it("regenerates again when definitions change a second time", async () => {
    const h = await harness();
    const { set, splitId } = await displayedSplit(h);
    const choice = {
      commandId: "command:twice",
      suggestionSetId: set.id,
      chosenSuggestionId: splitId,
    };
    expect((await h.post("/move-previews", choice)).status).toBe(201);
    h.definitions.moves = revisedMoves(SPLIT);
    const first = await json(await h.post("/commands", choice));
    h.definitions.moves = HAND_AUTHORED_MOVES.map((move) =>
      move.id === SPLIT ? { ...move, discoveryContext: "Revised twice." } : move,
    );
    const second = await h.post("/commands", choice);
    expect(second.status).toBe(409);
    const secondBody = await json(second);
    expect((secondBody.preview as MovePreview).id).not.toBe((first.preview as MovePreview).id);
    expect((await events(h)).map(({ kind, sequence }) => [kind, sequence])).toEqual([
      ["preview-regenerated", 1],
      ["preview-regenerated", 2],
    ]);
    expect(h.store.edges.size).toBe(0);
  });

  it("does not apply a preview whose move was withdrawn from the approved catalog", async () => {
    const h = await harness();
    const { set, splitId } = await displayedSplit(h);
    const choice = {
      commandId: "command:withdrawn",
      suggestionSetId: set.id,
      chosenSuggestionId: splitId,
    };
    expect((await h.post("/move-previews", choice)).status).toBe(201);
    h.definitions.moves = HAND_AUTHORED_MOVES.filter(({ id }) => id !== SPLIT);
    const apply = await h.post("/commands", choice);
    expect(apply.status).toBe(400);
    expect(await json(apply)).toMatchObject({ diagnostics: [{ code: "preview-rejected" }] });
    expect(h.store.edges.size).toBe(0);
    expect(await json(await h.get(""))).toMatchObject({ session: { currentNodeId: ROOT_NODE_ID } });
  });

  it("replays an applied command after a definition change instead of regenerating history", async () => {
    const h = await harness();
    const { set, splitId } = await displayedSplit(h);
    const choice = {
      commandId: "command:applied",
      suggestionSetId: set.id,
      chosenSuggestionId: splitId,
    };
    expect((await h.post("/commands", choice)).status).toBe(201);
    h.definitions.moves = revisedMoves(SPLIT);
    const replay = await h.post("/commands", choice);
    expect(replay.status).toBe(200);
    expect(await json(replay)).toMatchObject({ replayed: true });
    expect(h.store.previews.size).toBe(1);
    expect(await events(h)).toEqual([]);
  });
});
