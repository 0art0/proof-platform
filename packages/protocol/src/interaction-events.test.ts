import { describe, expect, it } from "vitest";
import {
  CLIENT_INTERACTION_EVENT_KINDS,
  definitionChanges,
  definitionReferencesSchema,
  interactionEventListSchema,
  interactionEventRequestFields,
  interactionEventSchema,
  previewRegeneratedResponseSchema,
  recordInteractionEventRequestSchema,
} from ".";

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;

const anchor = {
  stateId: "state:one",
  target: { kind: "goal", id: "goal:one" },
  statement: { kind: "conclusion" },
} as const;

const recorded = {
  sequence: 1,
  stateId: "state:one",
  actor: { id: "actor:web", kind: "human" },
  recordedAt: "2026-09-27T12:00:00.000Z",
} as const;

describe("interaction-event requests", () => {
  it("accepts every client kind strictly and never the worker-only regeneration kind", () => {
    const requests = [
      { kind: "selection-changed", selections: [{ kind: "exact", anchor, path: [0] }] },
      { kind: "selection-changed", selections: [] },
      { kind: "suggestions-requested", suggestionSetId: "suggestion-set:one" },
      {
        kind: "suggestions-displayed",
        suggestionSetId: "suggestion-set:one",
        suggestionIds: ["suggestion:a", "suggestion:b"],
      },
      {
        kind: "preview-requested",
        suggestionSetId: "suggestion-set:one",
        chosenSuggestionId: "suggestion:a",
        commandId: "command:one",
      },
      { kind: "preview-rejected", previewId: "preview:one", reason: "superseded" },
      {
        kind: "menu-expanded",
        suggestionSetId: "suggestion-set:one",
        suggestionId: "suggestion:a",
        parameterId: "disjunctIndex",
      },
      { kind: "focus-changed", target: { kind: "obligation", id: "obligation:one" } },
      { kind: "objective-changed", objective: "Find a witness." },
      { kind: "interaction-ended-without-action", reason: "selection-cleared" },
    ];
    expect(new Set(requests.map(({ kind }) => kind))).toEqual(
      new Set(CLIENT_INTERACTION_EVENT_KINDS),
    );
    for (const request of requests) {
      const full = { id: "interaction:one", nodeId: "node:one", ...request };
      expect(recordInteractionEventRequestSchema.safeParse(full).success).toBe(true);
      expect(recordInteractionEventRequestSchema.safeParse({ ...full, sequence: 1 }).success).toBe(
        false,
      );
    }
    expect(
      recordInteractionEventRequestSchema.safeParse({
        id: "interaction:one",
        nodeId: "node:one",
        kind: "preview-regenerated",
        commandId: "command:one",
        stalePreviewId: "preview:a",
        previewId: "preview:b",
        operationChanged: false,
        changedDefinitions: [],
      }).success,
    ).toBe(false);
    expect(
      recordInteractionEventRequestSchema.safeParse({
        id: "interaction:one",
        nodeId: "node:one",
        kind: "objective-changed",
        objective: "",
      }).success,
    ).toBe(false);
  });
});

describe("recorded interaction events", () => {
  it("requires selections anchored to the event snapshot and unique displayed IDs", () => {
    const selection = {
      id: "interaction:one",
      nodeId: "node:one",
      ...recorded,
      kind: "selection-changed",
      selections: [{ kind: "exact", anchor, path: [] }],
    };
    expect(interactionEventSchema.safeParse(selection).success).toBe(true);
    expect(
      interactionEventSchema.safeParse({
        ...selection,
        selections: [{ kind: "exact", anchor: { ...anchor, stateId: "state:other" }, path: [] }],
      }).success,
    ).toBe(false);
    expect(
      interactionEventSchema.safeParse({
        id: "interaction:two",
        nodeId: "node:one",
        ...recorded,
        kind: "suggestions-displayed",
        suggestionSetId: "suggestion-set:one",
        suggestionIds: ["suggestion:a", "suggestion:a"],
      }).success,
    ).toBe(false);
    expect(interactionEventSchema.safeParse({ ...selection, sequence: 0 }).success).toBe(false);
  });

  it("separates worker-assigned fields for idempotent replay comparison", () => {
    const event = interactionEventSchema.parse({
      id: "interaction:one",
      nodeId: "node:one",
      ...recorded,
      kind: "objective-changed",
      objective: "Find a witness.",
    });
    expect(interactionEventRequestFields(event)).toEqual({
      id: "interaction:one",
      nodeId: "node:one",
      kind: "objective-changed",
      objective: "Find a witness.",
    });
  });

  it("lists events only in strictly increasing sequence order", () => {
    const event = (id: string, sequence: number) => ({
      id,
      nodeId: "node:one",
      ...recorded,
      sequence,
      kind: "objective-changed",
      objective: id,
    });
    expect(
      interactionEventListSchema.safeParse([event("interaction:a", 1), event("interaction:b", 3)])
        .success,
    ).toBe(true);
    expect(
      interactionEventListSchema.safeParse([event("interaction:a", 2), event("interaction:b", 2)])
        .success,
    ).toBe(false);
    expect(
      interactionEventListSchema.safeParse([event("interaction:a", 3), event("interaction:b", 1)])
        .success,
    ).toBe(false);
  });

  it("requires a regenerated preview to have a new ID", () => {
    const regenerated = {
      id: "event:preview:b",
      nodeId: "node:one",
      ...recorded,
      kind: "preview-regenerated",
      commandId: "command:one",
      stalePreviewId: "preview:a",
      previewId: "preview:b",
      operationChanged: true,
      changedDefinitions: [
        { kind: "move", id: "move:one", staleHash: hash("a"), currentHash: hash("b") },
      ],
    };
    expect(interactionEventSchema.safeParse(regenerated).success).toBe(true);
    expect(
      interactionEventSchema.safeParse({ ...regenerated, previewId: "preview:a" }).success,
    ).toBe(false);
    expect(
      previewRegeneratedResponseSchema.safeParse({
        status: "preview-regenerated",
        stalePreviewId: "preview:a",
        preview: {},
        diagnostics: [{ code: "preview-regenerated", message: "Changed." }],
      }).success,
    ).toBe(true);
  });
});

describe("definition references", () => {
  it("are sha256 hashes, unique, and ordered by kind then ID", () => {
    const result = { kind: "library-result", id: "result:a", hash: hash("1") };
    const move = { kind: "move", id: "move:a", hash: hash("2") };
    expect(definitionReferencesSchema.safeParse([result, move]).success).toBe(true);
    expect(definitionReferencesSchema.safeParse([move, result]).success).toBe(false);
    expect(definitionReferencesSchema.safeParse([move, move]).success).toBe(false);
    expect(definitionReferencesSchema.safeParse([]).success).toBe(false);
    expect(definitionReferencesSchema.safeParse([{ ...move, hash: "md5:00" }]).success).toBe(false);
  });

  it("report exactly the definitions whose content changed", () => {
    const stale = [
      { kind: "library-result", id: "result:a", hash: hash("1") },
      { kind: "move", id: "move:a", hash: hash("2") },
      { kind: "move", id: "move:gone", hash: hash("3") },
    ] as const;
    const current = [
      { kind: "library-result", id: "result:a", hash: hash("1") },
      { kind: "move", id: "move:a", hash: hash("4") },
      { kind: "move", id: "move:new", hash: hash("5") },
    ] as const;
    expect(definitionChanges(stale, current)).toEqual([
      { kind: "move", id: "move:a", staleHash: hash("2"), currentHash: hash("4") },
      { kind: "move", id: "move:gone", staleHash: hash("3") },
      { kind: "move", id: "move:new", currentHash: hash("5") },
    ]);
    expect(definitionChanges(stale, stale)).toEqual([]);
  });
});
