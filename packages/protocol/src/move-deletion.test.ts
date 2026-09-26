import { describe, expect, it } from "vitest";
import {
  deletePreviousMoveCommandSchema,
  deletionReceipt,
  planPreviousMoveDeletion,
  proofDeletionRecordSchema,
  type DeletionPlanEdge,
} from "./index";

const edges: readonly DeletionPlanEdge[] = [
  { id: "edge:a", parentNodeId: "node:root", childNodeId: "node:a", commandId: "command:a" },
  {
    id: "edge:b",
    parentNodeId: "node:a",
    childNodeId: "node:b",
    commandId: "command:b",
    previewId: "preview:b",
  },
  { id: "edge:c", parentNodeId: "node:a", childNodeId: "node:c", commandId: "command:c" },
  { id: "edge:d", parentNodeId: "node:b", childNodeId: "node:d", commandId: "command:d" },
];

describe("planPreviousMoveDeletion", () => {
  it("rejects the root", () => {
    const result = planPreviousMoveDeletion({
      rootNodeId: "node:root",
      currentNodeId: "node:root",
      edges,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("root-has-no-previous-move");
  });

  it("plans a leaf deletion", () => {
    const result = planPreviousMoveDeletion({
      rootNodeId: "node:root",
      currentNodeId: "node:d",
      edges,
    });
    expect(result).toMatchObject({
      ok: true,
      plan: {
        parentNodeId: "node:b",
        deletedNodeIds: ["node:d"],
        deletedEdgeIds: ["edge:d"],
        deletedCommandIds: ["command:d"],
        chosenPreviewIds: [],
        descendantCount: 0,
      },
    });
  });

  it("requires confirmation for descendants and then deletes the whole subtree", () => {
    const refused = planPreviousMoveDeletion({
      rootNodeId: "node:root",
      currentNodeId: "node:a",
      edges,
    });
    expect(refused).toMatchObject({ ok: false, descendantCount: 3 });
    expect(refused.diagnostics[0]?.code).toBe("descendants-require-confirmation");
    expect(refused.diagnostics[0]?.message).toContain("3 descendant nodes");

    const confirmed = planPreviousMoveDeletion({
      rootNodeId: "node:root",
      currentNodeId: "node:a",
      edges,
      confirmDescendants: true,
    });
    expect(confirmed).toMatchObject({
      ok: true,
      plan: {
        parentNodeId: "node:root",
        deletedNodeIds: ["node:a", "node:b", "node:c", "node:d"],
        deletedEdgeIds: ["edge:a", "edge:b", "edge:c", "edge:d"],
        chosenPreviewIds: ["preview:b"],
        descendantCount: 3,
      },
    });
  });

  it("rejects a current node outside the tree", () => {
    const result = planPreviousMoveDeletion({
      rootNodeId: "node:root",
      currentNodeId: "node:missing",
      edges,
    });
    expect(result.diagnostics[0]?.code).toBe("current-node-not-in-tree");
  });
});

describe("move-deletion schemas", () => {
  it("accepts a strict command and rejects unknown fields", () => {
    const command = {
      commandId: "command:delete",
      actor: { id: "actor:human", kind: "human" },
      expectedCurrentNodeId: "node:a",
      confirmDescendants: true,
      reason: "Clicked the wrong move.",
    };
    expect(deletePreviousMoveCommandSchema.safeParse(command).success).toBe(true);
    expect(deletePreviousMoveCommandSchema.safeParse({ ...command, extra: 1 }).success).toBe(false);
  });

  it("validates tombstones without snapshots and derives the receipt", () => {
    const record = {
      id: "deletion:command:delete",
      commandId: "command:delete",
      actor: { id: "actor:human", kind: "human" },
      expectedCurrentNodeId: "node:a",
      confirmDescendants: false,
      parentNodeId: "node:root",
      deletedNodeIds: ["node:a"],
      deletedEdgeIds: ["edge:a"],
      deletedEventIds: ["event:a"],
      deletedCommandIds: ["command:a"],
      deletedSuggestionSetIds: [],
      deletedPreviewIds: [],
      occurredAt: "2026-09-26T12:00:00.000Z",
    };
    const parsed = proofDeletionRecordSchema.parse(record);
    expect(deletionReceipt(parsed)).toEqual({
      deletedNodeIds: ["node:a"],
      deletedEdgeIds: ["edge:a"],
      currentNodeId: "node:root",
    });
    expect(proofDeletionRecordSchema.safeParse({ ...record, state: {} }).success).toBe(false);
    expect(
      proofDeletionRecordSchema.safeParse({
        ...record,
        deletedNodeIds: ["node:a", "node:b"],
        deletedEdgeIds: ["edge:a", "edge:b"],
        deletedCommandIds: ["command:a", "command:b"],
      }).success,
    ).toBe(false);
  });
});
