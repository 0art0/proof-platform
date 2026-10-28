// The persistence contract of the proof repository: the stored session shape, the transaction
// interface a store implements, the store errors, and the guard that refuses writes to read-only
// sessions.

import {
  createProofNodeSchema,
  proofSessionMetadataSchema,
  proofNodeIdSchema,
  type ApplyKernelCommand,
  type ConstantActivation,
  type DisplayedSuggestionSet,
  type InteractionEvent,
  type InteractionEventId,
  type InquiryRecord,
  type MovePreview,
  type MovePreviewId,
  type PrepareProofCommandSuccess,
  type ProofEdge,
  type ProofDeletionRecord,
  type ProofNode,
  type ProofArtifactImportRecord,
  type ProofSessionMetadata,
  type ProtocolEnvironment,
  type SuggestionSetId,
  type TransitionEvent,
  type SemanticReplayStepRecord,
} from "@proof/protocol";
import { z } from "zod";

export const stableStorageIdentifierSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const proofSessionIdSchema = stableStorageIdentifierSchema.brand("ProofSessionId");

export type ProofSessionId = z.infer<typeof proofSessionIdSchema>;

export type OperatorDeclaration = NonNullable<ProtocolEnvironment["operators"]>[number];

export const operatorEnvironmentSchema: z.ZodType<readonly OperatorDeclaration[]> = z
  .unknown()
  .transform((value, context) => {
    if (!Array.isArray(value)) {
      context.addIssue({ code: "custom", message: "Operators must be an array." });
      return z.NEVER;
    }
    try {
      const operators = value as readonly OperatorDeclaration[];
      createProofNodeSchema({ operators });
      return operators;
    } catch {
      context.addIssue({ code: "custom", message: "The operator environment is invalid." });
      return z.NEVER;
    }
  });

export type ProofSession = Readonly<{
  id: ProofSessionId;
  rootNodeId: ProofNode["id"];
  currentNodeId: ProofNode["id"];
  operators: readonly OperatorDeclaration[];
  /** Documentary session context; absent for sessions created before migration 0003. */
  metadata?: ProofSessionMetadata | undefined;
  /**
   * Present on a session created by importing an artifact (migration 0011). Every write to a
   * read-only session is refused by `guardReadOnlySessions` with `session-read-only`.
   */
  readOnly?: true | undefined;
  /**
   * Who may see the session (migration 0012). Absent means `private`, the default of every new
   * session; the stores write and report only the non-default `shared`.
   */
  visibility?: "shared" | undefined;
}>;

/** A session's visibility; sessions are private unless explicitly shared. */
export type SessionVisibility = "private" | "shared";

export function sessionVisibility(session: Readonly<{ visibility?: unknown }>): SessionVisibility {
  return session.visibility === "shared" ? "shared" : "private";
}

export const proofSessionSchema: z.ZodType<ProofSession> = z
  .object({
    id: proofSessionIdSchema,
    rootNodeId: proofNodeIdSchema,
    currentNodeId: proofNodeIdSchema,
    operators: operatorEnvironmentSchema,
    metadata: proofSessionMetadataSchema.optional(),
    readOnly: z.literal(true).optional(),
    visibility: z.literal("shared").optional(),
  })
  .strict();

/** Relational identities are retained beside JSONB so both representations are checked. */
export type StoredProofNodeRecord = Readonly<{
  sessionId: ProofSessionId;
  nodeId: ProofNode["id"];
  stateId: ProofNode["state"]["id"];
  node: unknown;
}>;

/** Relational identities are retained beside JSONB so both representations are checked. */
export type StoredDisplayedSuggestionSetRecord = Readonly<{
  sessionId: ProofSessionId;
  suggestionSetId: SuggestionSetId;
  nodeId: ProofNode["id"];
  stateId: ProofNode["state"]["id"];
  suggestionSet: unknown;
}>;

/** Relational identities are retained beside JSONB so both representations are checked. */
export type StoredProofEdgeRecord = Readonly<{
  sessionId: ProofSessionId;
  edgeId: ProofEdge["id"];
  parentNodeId: ProofNode["id"];
  childNodeId: ProofNode["id"];
  commandId: ApplyKernelCommand["commandId"];
  suggestionSetId: SuggestionSetId | null;
  chosenSuggestionId: string | null;
  previewId: MovePreviewId | null;
  edge: unknown;
}>;

/** The live records "Delete previous move" asks a store to remove, in dependency order. */
export type ProofRecordDeletionRequest = Readonly<{
  nodeIds: readonly ProofNode["id"][];
  edgeIds: readonly ProofEdge["id"][];
  commandIds: readonly ApplyKernelCommand["commandId"][];
  /** Previews chosen by deleted edges; removed only when no retained edge still references one. */
  chosenPreviewIds: readonly MovePreviewId[];
}>;

/** The IDs a store actually removed from each table (unvalidated until the repository checks). */
export type ProofRecordDeletionResult = Readonly<{
  /** Interaction events anchored at deleted nodes or naming a deleted chosen preview. */
  interactionEventIds: readonly string[];
  eventIds: readonly string[];
  edgeIds: readonly string[];
  previewIds: readonly string[];
  suggestionSetIds: readonly string[];
  commandIds: readonly string[];
  nodeIds: readonly string[];
}>;

export interface ProofStoreTransaction {
  lockSession(sessionId: ProofSessionId): Promise<unknown | undefined>;
  readNode(sessionId: ProofSessionId, nodeId: ProofNode["id"]): Promise<unknown | undefined>;
  readCommand(
    sessionId: ProofSessionId,
    commandId: ApplyKernelCommand["commandId"],
  ): Promise<unknown | undefined>;
  readSuggestionSet(
    sessionId: ProofSessionId,
    suggestionSetId: SuggestionSetId,
  ): Promise<unknown | undefined>;
  readPreview(sessionId: ProofSessionId, previewId: MovePreviewId): Promise<unknown | undefined>;
  listEdges(sessionId: ProofSessionId): Promise<readonly unknown[]>;
  insertSession(session: ProofSession): Promise<void>;
  insertNode(sessionId: ProofSessionId, node: ProofNode): Promise<void>;
  insertSuggestionSet(
    sessionId: ProofSessionId,
    suggestionSet: DisplayedSuggestionSet,
  ): Promise<void>;
  insertPreview(sessionId: ProofSessionId, preview: MovePreview): Promise<void>;
  insertEdge(sessionId: ProofSessionId, edge: ProofEdge): Promise<void>;
  insertEvent(sessionId: ProofSessionId, event: TransitionEvent): Promise<void>;
  insertCommand(sessionId: ProofSessionId, result: PrepareProofCommandSuccess): Promise<void>;
  advanceCurrentNode(
    sessionId: ProofSessionId,
    expectedNodeId: ProofNode["id"],
    nextNodeId: ProofNode["id"],
  ): Promise<boolean>;
  repointCurrentNode(
    sessionId: ProofSessionId,
    expectedNodeId: ProofNode["id"],
    targetNodeId: ProofNode["id"],
  ): Promise<boolean>;
  /**
   * The deletion tombstone issued by this command ID, or else the one that deleted the apply
   * command with this ID.
   */
  readDeletion(
    sessionId: ProofSessionId,
    commandId: ApplyKernelCommand["commandId"],
  ): Promise<unknown | undefined>;
  /**
   * Remove events of the deleted edges, the edges, previews anchored at deleted nodes or chosen by
   * deleted edges, suggestion sets anchored at deleted nodes, command records, then the nodes.
   */
  deleteProofRecords(
    sessionId: ProofSessionId,
    request: ProofRecordDeletionRequest,
  ): Promise<ProofRecordDeletionResult>;
  insertDeletion(sessionId: ProofSessionId, deletion: ProofDeletionRecord): Promise<void>;
  /** `{ sessionId, eventId, sequence, nodeId, event }` for one interaction event, if present. */
  readInteractionEvent(
    sessionId: ProofSessionId,
    eventId: InteractionEventId,
  ): Promise<unknown | undefined>;
  /** The highest interaction-event sequence in the session, or 0. Called under the session lock. */
  lastInteractionSequence(sessionId: ProofSessionId): Promise<number>;
  insertInteractionEvent(sessionId: ProofSessionId, event: InteractionEvent): Promise<void>;
  /** The highest transition sequence among the session's edges, or 0. Called under the session lock. */
  lastTransitionSequence(sessionId: ProofSessionId): Promise<number>;
  /** Interaction-event records in increasing sequence order, in the read-record shape. */
  listInteractionEvents(
    sessionId: ProofSessionId,
    query: InteractionEventQuery,
  ): Promise<readonly unknown[]>;
  /** The semantic-replay record of one replayed step, by the step's command ID, if any. */
  readReplayStep(
    sessionId: ProofSessionId,
    commandId: ApplyKernelCommand["commandId"],
  ): Promise<unknown | undefined>;
  insertReplayStep(sessionId: ProofSessionId, record: SemanticReplayStepRecord): Promise<void>;
  /** `{ sessionId, recordId, sequence, commandId, nodeId, record }` for one inquiry record. */
  readInquiryRecord(sessionId: ProofSessionId, recordId: string): Promise<unknown | undefined>;
  /** The highest inquiry-record sequence in the session, or 0. Called under the session lock. */
  lastInquirySequence(sessionId: ProofSessionId): Promise<number>;
  insertInquiryRecord(sessionId: ProofSessionId, record: InquiryRecord): Promise<void>;
  /** Inquiry-record read records in increasing sequence order. */
  listInquiryRecords(
    sessionId: ProofSessionId,
    query: InquiryRecordQuery,
  ): Promise<readonly unknown[]>;
  /**
   * Mark the session read-only (migration 0011). Returns false when the session does not exist;
   * marking an already read-only session is itself a refused write. Only the artifact importer
   * calls this, as its last write.
   */
  markSessionReadOnly(sessionId: ProofSessionId): Promise<boolean>;
  /**
   * Set `proof_sessions.visibility` (migration 0012). Returns false when the session does not
   * exist. Not a proof write: it is allowed on a read-only session.
   */
  setSessionVisibility(sessionId: ProofSessionId, visibility: SessionVisibility): Promise<boolean>;
  /**
   * Hard-delete the session and every dependent row (nodes, suggestion sets, previews, edges,
   * events, commands, deletion tombstones, interaction events, inquiry records, replay steps,
   * artifact-import record, session-scoped library rows and proof-session LLM call records).
   * Returns false when the session does not exist. Allowed on a read-only session.
   */
  deleteSession(sessionId: ProofSessionId): Promise<boolean>;
  /** Every node of the session, in the `readNode` record shape, ordered by node ID. */
  listNodes(sessionId: ProofSessionId): Promise<readonly unknown[]>;
  /** Every suggestion set, in the `readSuggestionSet` record shape, ordered by ID. */
  listSuggestionSets(sessionId: ProofSessionId): Promise<readonly unknown[]>;
  /** Every stored preview record, ordered by ID. */
  listPreviews(sessionId: ProofSessionId): Promise<readonly unknown[]>;
  /** Every stored transition-event record, ordered by ID. */
  listEvents(sessionId: ProofSessionId): Promise<readonly unknown[]>;
  /** Every stored command result, ordered by command ID. */
  listCommands(sessionId: ProofSessionId): Promise<readonly unknown[]>;
  /** Every semantic-replay step record, ordered by step command ID. */
  listReplaySteps(sessionId: ProofSessionId): Promise<readonly unknown[]>;
  /** Every deletion tombstone, ordered by ID. */
  listDeletions(sessionId: ProofSessionId): Promise<readonly unknown[]>;
  /** The artifact-import record of an imported session, if any. */
  readArtifactImport(sessionId: ProofSessionId): Promise<unknown | undefined>;
  insertArtifactImport(record: ProofArtifactImportRecord): Promise<void>;
  /**
   * The session's constant activations (migration 0018) in activation order. They are append-only
   * history: neither backtracking nor "Delete previous move" removes one.
   */
  listConstantActivations(sessionId: ProofSessionId): Promise<readonly unknown[]>;
  /**
   * Append one constant activation. The caller writes it in the transaction of the step that
   * triggered it, before it stores the step, and under the session lock.
   */
  insertConstantActivation(
    sessionId: ProofSessionId,
    activation: ConstantActivation,
  ): Promise<void>;
}

export type InquiryRecordQuery = Readonly<{
  nodeId?: ProofNode["id"] | undefined;
  /** Only the records of this inquiry command. */
  commandId?: string | undefined;
  /** Only records that reference this inquiry record. */
  referencing?: string | undefined;
  afterSequence: number;
  limit: number;
}>;

export type InteractionEventQuery = Readonly<{
  nodeId?: ProofNode["id"] | undefined;
  afterSequence: number;
  limit: number;
}>;

export interface ProofStore {
  transaction<Result>(
    work: (transaction: ProofStoreTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export class ProofStoreTransactionError extends Error {
  readonly outcome: "rolled-back" | "commit-unknown";
  override readonly cause: unknown;

  constructor(outcome: "rolled-back" | "commit-unknown", message: string, cause?: unknown) {
    super(message);
    this.name = "ProofStoreTransactionError";
    this.outcome = outcome;
    this.cause = cause;
  }
}

/** A write was attempted on a read-only (imported) session; the transaction rolls back. */
export class ReadOnlySessionError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`The proof session ${sessionId} is read-only; it was imported from an artifact.`);
    this.name = "ReadOnlySessionError";
    this.sessionId = sessionId;
  }
}

/** Whether a `lockSession` record marks its session read-only. */
export function isReadOnlySessionRecord(record: unknown): boolean {
  return (
    typeof record === "object" &&
    record !== null &&
    (record as Readonly<{ readOnly?: unknown }>).readOnly === true
  );
}

/**
 * Enforce read-only sessions at the transaction layer. Both stores wrap every transaction they
 * hand out, so every repository path (resource routes, the command envelope, inquiry commands and
 * methods, deletion, backtracking, replay, interaction events) is covered without per-route
 * checks. Each write first learns, once per transaction and session, whether its session is
 * read-only (from the repository's own `lockSession` when that already ran, otherwise by taking
 * the session lock); a write to a read-only session throws `ReadOnlySessionError`, which rolls the
 * transaction back and surfaces as `session-read-only`. `markSessionReadOnly` is itself a write:
 * after it the session accepts no further writes, even in the same transaction.
 */
export function guardReadOnlySessions(inner: ProofStoreTransaction): ProofStoreTransaction {
  const known = new Map<string, boolean>();
  const writable = async (sessionId: ProofSessionId): Promise<void> => {
    let readOnly = known.get(sessionId);
    if (readOnly === undefined) {
      readOnly = isReadOnlySessionRecord(await inner.lockSession(sessionId));
      known.set(sessionId, readOnly);
    }
    if (readOnly) throw new ReadOnlySessionError(sessionId);
  };
  // Every method is listed (no spread), so a new transaction method must be classified here.
  return {
    readNode: (sessionId, nodeId) => inner.readNode(sessionId, nodeId),
    readCommand: (sessionId, commandId) => inner.readCommand(sessionId, commandId),
    readSuggestionSet: (sessionId, id) => inner.readSuggestionSet(sessionId, id),
    readPreview: (sessionId, previewId) => inner.readPreview(sessionId, previewId),
    listEdges: (sessionId) => inner.listEdges(sessionId),
    readDeletion: (sessionId, commandId) => inner.readDeletion(sessionId, commandId),
    readInteractionEvent: (sessionId, eventId) => inner.readInteractionEvent(sessionId, eventId),
    lastInteractionSequence: (sessionId) => inner.lastInteractionSequence(sessionId),
    lastTransitionSequence: (sessionId) => inner.lastTransitionSequence(sessionId),
    listInteractionEvents: (sessionId, query) => inner.listInteractionEvents(sessionId, query),
    readReplayStep: (sessionId, commandId) => inner.readReplayStep(sessionId, commandId),
    readInquiryRecord: (sessionId, recordId) => inner.readInquiryRecord(sessionId, recordId),
    lastInquirySequence: (sessionId) => inner.lastInquirySequence(sessionId),
    listInquiryRecords: (sessionId, query) => inner.listInquiryRecords(sessionId, query),
    listNodes: (sessionId) => inner.listNodes(sessionId),
    listSuggestionSets: (sessionId) => inner.listSuggestionSets(sessionId),
    listPreviews: (sessionId) => inner.listPreviews(sessionId),
    listEvents: (sessionId) => inner.listEvents(sessionId),
    listCommands: (sessionId) => inner.listCommands(sessionId),
    listReplaySteps: (sessionId) => inner.listReplaySteps(sessionId),
    listDeletions: (sessionId) => inner.listDeletions(sessionId),
    readArtifactImport: (sessionId) => inner.readArtifactImport(sessionId),
    listConstantActivations: (sessionId) => inner.listConstantActivations(sessionId),
    // Privacy and deletion are administrative, not proof writes: a read-only (imported) session
    // must stay deletable and its visibility changeable.
    setSessionVisibility: (sessionId, visibility) =>
      inner.setSessionVisibility(sessionId, visibility),
    deleteSession: (sessionId) => inner.deleteSession(sessionId),
    lockSession: async (sessionId) => {
      const record = await inner.lockSession(sessionId);
      known.set(sessionId, isReadOnlySessionRecord(record));
      return record;
    },
    insertSession: async (session) => {
      // A session becomes read-only only through `markSessionReadOnly`, after its rows exist.
      if (session.readOnly === true) throw new ReadOnlySessionError(session.id);
      await inner.insertSession(session);
      known.set(session.id, false);
    },
    insertNode: async (sessionId, node) => {
      await writable(sessionId);
      return inner.insertNode(sessionId, node);
    },
    insertSuggestionSet: async (sessionId, suggestionSet) => {
      await writable(sessionId);
      return inner.insertSuggestionSet(sessionId, suggestionSet);
    },
    insertPreview: async (sessionId, preview) => {
      await writable(sessionId);
      return inner.insertPreview(sessionId, preview);
    },
    insertEdge: async (sessionId, edge) => {
      await writable(sessionId);
      return inner.insertEdge(sessionId, edge);
    },
    insertEvent: async (sessionId, event) => {
      await writable(sessionId);
      return inner.insertEvent(sessionId, event);
    },
    insertCommand: async (sessionId, result) => {
      await writable(sessionId);
      return inner.insertCommand(sessionId, result);
    },
    advanceCurrentNode: async (sessionId, expectedNodeId, nextNodeId) => {
      await writable(sessionId);
      return inner.advanceCurrentNode(sessionId, expectedNodeId, nextNodeId);
    },
    repointCurrentNode: async (sessionId, expectedNodeId, targetNodeId) => {
      await writable(sessionId);
      return inner.repointCurrentNode(sessionId, expectedNodeId, targetNodeId);
    },
    deleteProofRecords: async (sessionId, request) => {
      await writable(sessionId);
      return inner.deleteProofRecords(sessionId, request);
    },
    insertDeletion: async (sessionId, deletion) => {
      await writable(sessionId);
      return inner.insertDeletion(sessionId, deletion);
    },
    insertInteractionEvent: async (sessionId, event) => {
      await writable(sessionId);
      return inner.insertInteractionEvent(sessionId, event);
    },
    insertReplayStep: async (sessionId, record) => {
      await writable(sessionId);
      return inner.insertReplayStep(sessionId, record);
    },
    insertInquiryRecord: async (sessionId, record) => {
      await writable(sessionId);
      return inner.insertInquiryRecord(sessionId, record);
    },
    insertArtifactImport: async (record) => {
      await writable(record.sessionId as ProofSessionId);
      return inner.insertArtifactImport(record);
    },
    insertConstantActivation: async (sessionId, activation) => {
      await writable(sessionId);
      return inner.insertConstantActivation(sessionId, activation);
    },
    markSessionReadOnly: async (sessionId) => {
      await writable(sessionId);
      const marked = await inner.markSessionReadOnly(sessionId);
      if (marked) known.set(sessionId, true);
      return marked;
    },
  };
}
