/**
 * The worker's single command path for inquiry records (refinement §3–§4, §12.1). A command is
 * validated against stored nodes, suggestion sets, transitions and earlier records by the pure
 * protocol `prepareInquiryCommand`, then its records are inserted in one transaction under the
 * session lock. The command ID makes it idempotent: an identical retry replays the stored records
 * and different content under the same ID is a conflict. Nothing here touches proof state.
 */
import {
  actorSchema,
  commandIdSchema,
  inquiryCommandReferences,
  inquiryRecordInputFields,
  inquiryRecordSchema,
  prepareInquiryCommand,
  proofNodeIdSchema,
  recordInquiryCommandRequestSchema,
  type InquiryContextEdge,
  type InquiryContextNode,
  type InquiryContextSuggestionSet,
  type InquiryDiagnosticCode,
  type Actor,
  type InquiryRecord,
  type ProofNode,
  type RecordInquiryCommandRequest,
  type ProtocolEnvironment,
  type SuggestionSetId,
} from "@proof/protocol";
import { z } from "zod";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "./approved-catalog";
import {
  isStrictDataRecord,
  jsonEquals,
  loadNode,
  loadSession,
  loadSuggestionSet,
  parseEdgeRecord,
  proofSessionIdSchema,
  repositoryFailure,
  safeParse,
  transactionFailure,
  freezeDetached,
  type ProofSession,
  type ProofSessionId,
  type ProofStore,
  type ProofStoreTransaction,
  type RepositoryFailure,
} from "./proof-repository";

export type RecordInquiryCommandResult =
  | Readonly<{
      status: "committed";
      records: readonly InquiryRecord[];
      replayed: boolean;
    }>
  | RepositoryFailure;

export type ListInquiryRecordsResult =
  Readonly<{ status: "loaded"; records: readonly InquiryRecord[] }> | RepositoryFailure;

export type RecordInquiryCommandOptions = Readonly<{
  definitions?: DefinitionCatalog;
  now?: () => Date;
}>;

export const inquiryRecordQuerySchema = z
  .object({
    nodeId: proofNodeIdSchema.optional(),
    commandId: commandIdSchema.optional(),
    afterSequence: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

/** More than any command holds, so a replay read sees every record of the command. */
const COMMAND_RECORD_LIMIT = 64;
/** Status changes read per subject when folding its current status. */
const STATUS_HISTORY_LIMIT = 10_000;

/** Record one inquiry command: validate every reference, then insert its records atomically. */
export async function recordInquiryCommand(
  store: ProofStore,
  sessionIdInput: unknown,
  requestInput: unknown,
  trustedActorInput: unknown,
  options: RecordInquiryCommandOptions = {},
): Promise<RecordInquiryCommandResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const request = safeParse(recordInquiryCommandRequestSchema, requestInput);
  const actor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || request === undefined || actor === undefined) {
    return repositoryFailure(
      "rejected",
      "inquiry-command-rejected",
      "The session ID, inquiry command, or trusted actor is invalid.",
    );
  }
  try {
    return await store.transaction((transaction) =>
      recordInquiryCommandWithin(transaction, sessionId, request, actor, options),
    );
  } catch (error: unknown) {
    return transactionFailure(error, "The inquiry command could not be recorded.");
  }
}

/**
 * Record one validated inquiry command inside the caller's transaction, taking the session lock.
 * A rejection writes nothing.
 */
export async function recordInquiryCommandWithin(
  transaction: ProofStoreTransaction,
  sessionId: ProofSessionId,
  request: RecordInquiryCommandRequest,
  actor: Actor,
  options: RecordInquiryCommandOptions = {},
): Promise<RecordInquiryCommandResult> {
  const definitions = options.definitions ?? APPROVED_DEFINITIONS;
  const loadedSession = await loadSession(transaction, sessionId, definitions);
  if (!loadedSession.ok) return loadedSession.failure;
  const { session, environment } = loadedSession;

  const stored = await readRecords(transaction, session, {
    commandId: request.commandId,
    afterSequence: 0,
    limit: COMMAND_RECORD_LIMIT,
  });
  if (stored === undefined) return invalidStoredRecord();
  if (stored.length > 0) {
    const identical =
      stored.length === request.records.length &&
      stored.every(
        (record, index) =>
          record.nodeId === request.nodeId &&
          record.actor.id === actor.id &&
          record.actor.kind === actor.kind &&
          jsonEquals(inquiryRecordInputFields(record), request.records[index]),
      );
    return identical
      ? { status: "committed" as const, records: stored, replayed: true }
      : repositoryFailure(
          "rejected",
          "inquiry-command-conflict",
          "The inquiry command ID is already recorded with different content.",
        );
  }

  const references = inquiryCommandReferences(request);
  const nodes = new Map<string, InquiryContextNode>();
  for (const nodeId of references.nodeIds) {
    const loaded = await loadNode(
      transaction,
      session,
      environment,
      nodeId as ProofNode["id"],
      "inquiry-command-rejected",
      "invalid-current-node",
    );
    if (loaded.ok) {
      nodes.set(nodeId, loaded.node);
    } else if (loaded.failure.diagnostics[0].code !== "inquiry-command-rejected") {
      return loaded.failure;
    }
  }

  // Earlier records it references, and any stored record already using one of its IDs.
  const records = new Map<string, InquiryRecord>();
  for (const recordId of new Set([
    ...references.recordIds,
    ...request.records.map(({ id }) => id),
  ])) {
    const input = await transaction.readInquiryRecord(session.id, recordId);
    if (input === undefined) continue;
    const record = parseInquiryReadRecord(input, session, recordId);
    if (record === undefined) return invalidStoredRecord();
    records.set(record.id, record);
  }
  for (const subjectId of references.statusSubjectIds) {
    const history = await readRecords(transaction, session, {
      referencing: subjectId,
      afterSequence: 0,
      limit: STATUS_HISTORY_LIMIT,
    });
    if (history === undefined) return invalidStoredRecord();
    for (const record of history) {
      if (record.kind === "status-change") records.set(record.id, record);
    }
  }

  const suggestionSets = new Map<string, InquiryContextSuggestionSet>();
  for (const suggestionSetId of references.suggestionSetIds) {
    const loaded = await loadSuggestionSet(
      transaction,
      session,
      suggestionSetId as SuggestionSetId,
    );
    if (loaded.ok) {
      suggestionSets.set(suggestionSetId, loaded.suggestionSet);
    } else if (loaded.failure.diagnostics[0].code !== "suggestion-set-not-found") {
      return loaded.failure;
    }
  }

  const edges = new Map<string, InquiryContextEdge>();
  if (references.transitionChildNodeIds.length > 0) {
    const loaded = await loadEdgesByChild(transaction, session, environment);
    if (loaded === undefined) {
      return repositoryFailure(
        "rejected",
        "invalid-edge-record",
        "A stored proof edge failed runtime validation or relational identity checks.",
      );
    }
    for (const childNodeId of references.transitionChildNodeIds) {
      const edge = loaded.get(childNodeId);
      if (edge === undefined) continue;
      edges.set(childNodeId, edge);
      if (nodes.has(edge.parentNodeId)) continue;
      const parent = await loadNode(
        transaction,
        session,
        environment,
        edge.parentNodeId as ProofNode["id"],
        "invalid-edge-record",
        "invalid-current-node",
      );
      if (!parent.ok) return parent.failure;
      nodes.set(edge.parentNodeId, parent.node);
    }
  }

  const lastSequence = await transaction.lastInquirySequence(session.id);
  if (!Number.isInteger(lastSequence) || lastSequence < 0) {
    throw new Error("The stored inquiry-record sequence is invalid.");
  }
  const prepared = prepareInquiryCommand(
    request,
    {
      actor,
      nodes,
      records,
      suggestionSets,
      edges,
      methods: approvedMethods(definitions, session),
    },
    {
      firstSequence: lastSequence + 1,
      recordedAt: (options.now?.() ?? new Date()).toISOString(),
    },
  );
  if (!prepared.ok) {
    const diagnostic = prepared.diagnostics[0];
    return repositoryFailure(
      "rejected",
      diagnosticCode(diagnostic.code),
      diagnostic.recordIndex === undefined
        ? diagnostic.message
        : `Record ${diagnostic.recordIndex}: ${diagnostic.message}`,
    );
  }
  for (const record of prepared.records) {
    await transaction.insertInquiryRecord(session.id, record);
  }
  return { status: "committed" as const, records: prepared.records, replayed: false };
}

/** Read a session's inquiry records in sequence order, optionally for one anchor or command. */
export async function listInquiryRecords(
  store: ProofStore,
  sessionIdInput: unknown,
  queryInput: unknown = {},
): Promise<ListInquiryRecordsResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const query = safeParse(inquiryRecordQuerySchema, queryInput);
  if (sessionId === undefined || query === undefined) {
    return repositoryFailure(
      "rejected",
      "inquiry-command-rejected",
      "The session ID or inquiry-record query is invalid.",
    );
  }
  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const records = await readRecords(transaction, loadedSession.session, query);
      return records === undefined ? invalidStoredRecord() : { status: "loaded" as const, records };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The inquiry records could not be read.");
  }
}

/** Records read per page when a method reads the whole inquiry history. */
const HISTORY_PAGE_SIZE = 500;

/**
 * The session's inquiry records recorded before the command `commandId`: every record when the
 * command is new, and the records preceding its first record when it is already stored. A method
 * derives its command from these, so a retry re-derives exactly the stored command.
 */
export async function inquiryRecordsBefore(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  commandId: string,
): Promise<readonly InquiryRecord[] | undefined> {
  const own = await readRecords(transaction, session, { commandId, afterSequence: 0, limit: 1 });
  if (own === undefined) return undefined;
  const before = own[0]?.sequence ?? Number.POSITIVE_INFINITY;
  const records: InquiryRecord[] = [];
  for (let after = 0; ;) {
    const page = await readRecords(transaction, session, {
      afterSequence: after,
      limit: HISTORY_PAGE_SIZE,
    });
    if (page === undefined) return undefined;
    for (const record of page) {
      if (record.sequence >= before) return records;
      records.push(record);
    }
    const last = page.at(-1);
    if (page.length < HISTORY_PAGE_SIZE || last === undefined) return records;
    after = last.sequence;
  }
}

function diagnosticCode(code: InquiryDiagnosticCode) {
  return code === "record-id-conflict"
    ? ("inquiry-command-conflict" as const)
    : ("inquiry-command-rejected" as const);
}

function invalidStoredRecord(): RepositoryFailure {
  return repositoryFailure(
    "rejected",
    "invalid-inquiry-record",
    "A stored inquiry record failed runtime validation or identity checks.",
  );
}

/** The approved moves and library results an attempt or decision may name. */
function approvedMethods(definitions: DefinitionCatalog, session: ProofSession) {
  return {
    moves: new Set<string>(definitions.moves.map(({ id }) => id)),
    results: new Set<string>(definitions.catalog(session.operators).results.map(({ id }) => id)),
  };
}

async function readRecords(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  query: Parameters<ProofStoreTransaction["listInquiryRecords"]>[1],
): Promise<readonly InquiryRecord[] | undefined> {
  const inputs = await transaction.listInquiryRecords(session.id, query);
  if (!Array.isArray(inputs)) return undefined;
  const records: InquiryRecord[] = [];
  for (const input of inputs) {
    const record = parseInquiryReadRecord(input, session);
    if (
      record === undefined ||
      (records.length > 0 && record.sequence <= (records.at(-1)?.sequence ?? 0))
    ) {
      return undefined;
    }
    records.push(record);
  }
  return records;
}

async function loadEdgesByChild(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  environment: ProtocolEnvironment,
): Promise<ReadonlyMap<string, InquiryContextEdge> | undefined> {
  const inputs = await transaction.listEdges(session.id);
  if (!Array.isArray(inputs)) return undefined;
  const edges = new Map<string, InquiryContextEdge>();
  for (const input of inputs) {
    const edge = parseEdgeRecord(input, session, environment);
    if (edge === undefined) return undefined;
    edges.set(edge.childNodeId, edge);
  }
  return edges;
}

function parseInquiryReadRecord(
  input: unknown,
  session: ProofSession,
  expectedRecordId?: string,
): InquiryRecord | undefined {
  if (
    !isStrictDataRecord(input, [
      "sessionId",
      "recordId",
      "sequence",
      "commandId",
      "nodeId",
      "record",
    ])
  ) {
    return undefined;
  }
  const record = safeParse(inquiryRecordSchema, input.record);
  if (
    record === undefined ||
    safeParse(proofSessionIdSchema, input.sessionId) !== session.id ||
    input.recordId !== record.id ||
    (expectedRecordId !== undefined && record.id !== expectedRecordId) ||
    input.sequence !== record.sequence ||
    input.commandId !== record.commandId ||
    input.nodeId !== record.nodeId
  ) {
    return undefined;
  }
  return freezeDetached(record);
}
