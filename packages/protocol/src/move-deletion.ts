import { stableIdentifierSchema } from "@proof/mathjson-model";
import { z } from "zod";

// Local copies of the branded identifiers in `index.ts`: the brands are structural, so values
// parsed here are interchangeable with those schemas' outputs without an import cycle.
const actorIdSchema = stableIdentifierSchema.brand("ActorId");
const commandIdSchema = stableIdentifierSchema.brand("CommandId");
const proofNodeIdSchema = stableIdentifierSchema.brand("ProofNodeId");
const proofEdgeIdSchema = stableIdentifierSchema.brand("ProofEdgeId");
const transitionEventIdSchema = stableIdentifierSchema.brand("TransitionEventId");
const suggestionSetIdSchema = stableIdentifierSchema.brand("SuggestionSetId");
const movePreviewIdSchema = stableIdentifierSchema.brand("MovePreviewId");

export const proofDeletionIdSchema = stableIdentifierSchema.brand("ProofDeletionId");
export type ProofDeletionId = z.infer<typeof proofDeletionIdSchema>;

const deletionActorSchema = z
  .object({ id: actorIdSchema, kind: z.enum(["human", "agent"]) })
  .strict();

/**
 * "Delete previous move" (design plan §16.2): remove the edge whose child is the current node,
 * together with that child and, when explicitly confirmed, every descendant of it.
 */
export const deletePreviousMoveCommandSchema = z
  .object({
    commandId: commandIdSchema,
    actor: deletionActorSchema,
    expectedCurrentNodeId: proofNodeIdSchema,
    confirmDescendants: z.boolean().optional(),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();
export type DeletePreviousMoveCommand = z.infer<typeof deletePreviousMoveCommandSchema>;

export const deletePreviousMoveReceiptSchema = z
  .object({
    deletedNodeIds: z.array(proofNodeIdSchema).min(1),
    deletedEdgeIds: z.array(proofEdgeIdSchema).min(1),
    currentNodeId: proofNodeIdSchema,
  })
  .strict();
export type DeletePreviousMoveReceipt = z.infer<typeof deletePreviousMoveReceiptSchema>;

function uniqueIds<Schema extends z.ZodType<string>>(schema: Schema) {
  return z
    .array(schema)
    .refine((values) => new Set(values).size === values.length, "IDs must be unique.");
}

/**
 * The audit tombstone of one deletion. It records only identities, never the deleted snapshots,
 * suggestions, or operations: deleted accidental work does not appear in documentary replay.
 */
export const proofDeletionRecordSchema = z
  .object({
    id: proofDeletionIdSchema,
    commandId: commandIdSchema,
    actor: deletionActorSchema,
    reason: z.string().min(1).max(500).optional(),
    expectedCurrentNodeId: proofNodeIdSchema,
    confirmDescendants: z.boolean(),
    parentNodeId: proofNodeIdSchema,
    deletedNodeIds: uniqueIds(proofNodeIdSchema).min(1),
    deletedEdgeIds: uniqueIds(proofEdgeIdSchema).min(1),
    deletedEventIds: uniqueIds(transitionEventIdSchema),
    deletedCommandIds: uniqueIds(commandIdSchema).min(1),
    deletedSuggestionSetIds: uniqueIds(suggestionSetIdSchema),
    deletedPreviewIds: uniqueIds(movePreviewIdSchema),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.deletedNodeIds.length !== record.deletedEdgeIds.length ||
      record.deletedCommandIds.length !== record.deletedEdgeIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Each deleted node must have exactly one deleted edge and command.",
      });
    }
    if (record.deletedNodeIds[0] !== record.expectedCurrentNodeId) {
      context.addIssue({
        code: "custom",
        message: "The first deleted node must be the node the deletion started from.",
      });
    }
    if (record.deletedNodeIds.includes(record.parentNodeId)) {
      context.addIssue({ code: "custom", message: "The parent node cannot itself be deleted." });
    }
    if (record.deletedNodeIds.length > 1 && !record.confirmDescendants) {
      context.addIssue({
        code: "custom",
        message: "Deleting descendants requires explicit confirmation.",
      });
    }
  });
export type ProofDeletionRecord = z.infer<typeof proofDeletionRecordSchema>;

/** The receipt a deletion (or its idempotent retry) returns. */
export function deletionReceipt(record: ProofDeletionRecord): DeletePreviousMoveReceipt {
  return Object.freeze({
    deletedNodeIds: [...record.deletedNodeIds],
    deletedEdgeIds: [...record.deletedEdgeIds],
    currentNodeId: record.parentNodeId,
  });
}

/** The edge fields a deletion plan needs; `ProofEdge` satisfies this shape. */
export type DeletionPlanEdge = Readonly<{
  id: string;
  parentNodeId: string;
  childNodeId: string;
  commandId: string;
  previewId?: string | undefined;
}>;

export type PreviousMoveDeletionPlan = Readonly<{
  parentNodeId: string;
  /** The current node first, then its descendants in breadth-first, edge-ID order. */
  deletedNodeIds: readonly string[];
  /** Aligned with `deletedNodeIds`: the edge entering each deleted node. */
  deletedEdgeIds: readonly string[];
  deletedCommandIds: readonly string[];
  /** Previews chosen by deleted edges (they are anchored at the deleted edges' parents). */
  chosenPreviewIds: readonly string[];
  descendantCount: number;
}>;

export type MoveDeletionDiagnosticCode =
  "root-has-no-previous-move" | "current-node-not-in-tree" | "descendants-require-confirmation";

export type PlanPreviousMoveDeletionResult =
  | Readonly<{ ok: true; plan: PreviousMoveDeletionPlan; diagnostics: readonly [] }>
  | Readonly<{
      ok: false;
      diagnostics: readonly [Readonly<{ code: MoveDeletionDiagnosticCode; message: string }>];
      descendantCount?: number;
    }>;

/**
 * Plan the removal of the latest move at `currentNodeId` from a validated rooted tree.
 * The root has no previous move; a current node with descendants requires `confirmDescendants`.
 */
export function planPreviousMoveDeletion(
  input: Readonly<{
    rootNodeId: string;
    currentNodeId: string;
    edges: readonly DeletionPlanEdge[];
    confirmDescendants?: boolean | undefined;
  }>,
): PlanPreviousMoveDeletionResult {
  if (input.currentNodeId === input.rootNodeId) {
    return failure("root-has-no-previous-move", "The root node has no previous move to delete.");
  }
  const entering = input.edges.find(({ childNodeId }) => childNodeId === input.currentNodeId);
  if (entering === undefined) {
    return failure(
      "current-node-not-in-tree",
      "The current node is not the child of any retained edge.",
    );
  }
  const byParent = new Map<string, DeletionPlanEdge[]>();
  for (const edge of input.edges) {
    const children = byParent.get(edge.parentNodeId) ?? [];
    children.push(edge);
    byParent.set(edge.parentNodeId, children);
  }
  const deletedEdges: DeletionPlanEdge[] = [entering];
  const visited = new Set<string>([input.currentNodeId]);
  for (let index = 0; index < deletedEdges.length; index += 1) {
    const parent = deletedEdges[index]?.childNodeId;
    if (parent === undefined) continue;
    const children = [...(byParent.get(parent) ?? [])].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    for (const edge of children) {
      if (visited.has(edge.childNodeId) || edge.childNodeId === entering.parentNodeId) {
        return failure("current-node-not-in-tree", "The retained history is not a rooted tree.");
      }
      visited.add(edge.childNodeId);
      deletedEdges.push(edge);
    }
  }
  const descendantCount = deletedEdges.length - 1;
  if (descendantCount > 0 && input.confirmDescendants !== true) {
    return {
      ...failure(
        "descendants-require-confirmation",
        `Deleting this move also deletes ${descendantCount} descendant node${
          descendantCount === 1 ? "" : "s"
        }; resend with confirmDescendants to delete the whole subtree.`,
      ),
      descendantCount,
    };
  }
  const chosenPreviewIds = [
    ...new Set(
      deletedEdges.flatMap(({ previewId }) => (previewId === undefined ? [] : [previewId])),
    ),
  ];
  return {
    ok: true,
    plan: Object.freeze({
      parentNodeId: entering.parentNodeId,
      deletedNodeIds: Object.freeze(deletedEdges.map(({ childNodeId }) => childNodeId)),
      deletedEdgeIds: Object.freeze(deletedEdges.map(({ id }) => id)),
      deletedCommandIds: Object.freeze(deletedEdges.map(({ commandId }) => commandId)),
      chosenPreviewIds: Object.freeze(chosenPreviewIds),
      descendantCount,
    }),
    diagnostics: [],
  };
}

function failure(
  code: MoveDeletionDiagnosticCode,
  message: string,
): Readonly<{
  ok: false;
  diagnostics: readonly [Readonly<{ code: MoveDeletionDiagnosticCode; message: string }>];
}> {
  return { ok: false, diagnostics: [{ code, message }] };
}
