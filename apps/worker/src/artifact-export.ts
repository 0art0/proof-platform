/**
 * Proof-artifact export (design plan §19, roadmap N27).
 *
 * The exporter copies stored rows only: session, nodes, edges, transition events, command records,
 * displayed suggestion sets, previews, replay-step records, deletion tombstones, interaction events
 * and inquiry records are read in one proof-store transaction, and the library section is read
 * from the library store (or, for a session imported from an artifact, from its import record).
 * Nothing historical is recomputed. The final material and the translation dictionary are derived
 * by the protocol's deterministic functions over those rows, and the finished artifact is parsed
 * with the strict artifact schema before it is returned, so an export is always importable in
 * shape. Exporting the same stored state twice yields the identical artifact and digest.
 */
import { createHash } from "node:crypto";
import { mergeLibraryOperators } from "@proof/library";
import {
  LEGACY_ARTIFACT_VERSION,
  PROOF_ARTIFACT_KIND,
  PROOF_ARTIFACT_VERSION,
  canonicalArtifactJson,
  createMovePreviewSchema,
  createPrepareProofCommandSuccessSchema,
  createProofNodeSchema,
  createTransitionEventSchema,
  deriveArtifactFinalMaterial,
  deriveTranslationDictionary,
  displayedSuggestionSetSchema,
  inquiryRecordSchema,
  interactionEventSchema,
  parseProofArtifact,
  proofArtifactImportRecordSchema,
  proofDeletionRecordSchema,
  previewWithoutStoredEvidence,
  semanticReplayStepRecordSchema,
  withoutEvidenceFields,
  withoutStoredTransitionEvidence,
  type JsonValue,
  type ProofArtifact,
  type ProofArtifactContent,
  type ProofArtifactImportRecord,
  type ProofEdge,
  type ProofNode,
  type ProtocolEnvironment,
} from "@proof/protocol";
import type { z } from "zod";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "./approved-catalog";
import {
  listLibrary,
  listLibraryOperators,
  readAdditionEvents,
  readBackgroundRevisions,
  type LibraryStore,
} from "./library-repository";
import {
  isStrictDataRecord,
  loadSession,
  parseEdgeRecord,
  proofSessionIdSchema,
  safeParse,
  transactionFailure,
  type ProofSession,
  type ProofSessionId,
  type ProofStore,
  type ProofStoreTransaction,
} from "./proof-repository";

export type ArtifactExportFailure = Readonly<{
  status: "rejected" | "uncertain";
  diagnostics: readonly [Readonly<{ code: string; message: string }>];
}>;

export type ExportProofArtifactResult =
  Readonly<{ status: "exported"; artifact: ProofArtifact }> | ArtifactExportFailure;

export type ExportProofArtifactOptions = Readonly<{
  /** The library store; without it a live session exports an empty library section. */
  library?: LibraryStore | undefined;
  definitions?: DefinitionCatalog;
  /** Owner-scoped LLM call rows already read and validated by the worker repository. */
  llmCalls?: ProofArtifact["llmCalls"] | undefined;
}>;

/** Rows read per page from the interaction-event and inquiry logs. */
const PAGE_SIZE = 500;

type StoredRows = Readonly<{
  session: ProofSession;
  nodes: readonly ProofNode[];
  edges: readonly ProofEdge[];
  tree: Omit<ProofArtifact["tree"], "rootNodeId" | "currentNodeId" | "nodes" | "edges">;
  interactionEvents: ProofArtifact["interactionEvents"];
  inquiryRecords: ProofArtifact["inquiryRecords"];
  importRecord: ProofArtifactImportRecord | undefined;
}>;

/** Export a session as a versioned proof artifact built from its stored rows. */
export async function exportProofArtifact(
  store: ProofStore,
  sessionIdInput: unknown,
  options: ExportProofArtifactOptions = {},
): Promise<ExportProofArtifactResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  if (sessionId === undefined) {
    return exportFailure("invalid-session-record", "The proof-session ID is invalid.");
  }
  const definitions = options.definitions ?? APPROVED_DEFINITIONS;
  let rows: StoredRows | ArtifactExportFailure;
  try {
    rows = await store.transaction((transaction) =>
      readStoredRows(transaction, sessionId, definitions),
    );
  } catch (error: unknown) {
    return transactionFailure(error, "The proof session could not be read for export.");
  }
  if ("diagnostics" in rows) return rows;

  const library = await librarySection(rows, options.library, options.llmCalls);
  if ("diagnostics" in library) return library;

  const { session, nodes } = rows;
  // Version 2 stores every transition's evidence and sequence. A session with older rows (written
  // before migration 0013, or imported from a version-1 artifact) cannot: its rows are copied as
  // they are stored, which is the version-1 shape, and are never given derived evidence.
  const current = storesTransitionEvidence(rows);
  const { edges, tree } = current ? rows : legacyShape(rows);
  const content: ProofArtifactContent = {
    artifactVersion: current ? PROOF_ARTIFACT_VERSION : LEGACY_ARTIFACT_VERSION,
    kind: PROOF_ARTIFACT_KIND,
    sessionId: session.id,
    provenance:
      rows.importRecord === undefined
        ? { kind: "session" }
        : {
            kind: "import",
            sourceSessionId: rows.importRecord.sourceSessionId,
            sourceDigest: rows.importRecord.digest,
          },
    problemSetup: { metadata: session.metadata ?? null },
    initialState: { rootNodeId: session.rootNodeId, operators: session.operators },
    library: library.library as ProofArtifact["library"],
    tree: {
      rootNodeId: session.rootNodeId,
      currentNodeId: session.currentNodeId,
      nodes,
      edges,
      ...tree,
    },
    interactionEvents: rows.interactionEvents,
    inquiryRecords: rows.inquiryRecords,
    final: deriveArtifactFinalMaterial({ rootNodeId: session.rootNodeId, nodes, edges }),
    translationDictionary: deriveTranslationDictionary(session.operators),
    llmCalls: library.llmCalls,
  };
  const normalized = JSON.parse(JSON.stringify(content)) as Record<string, JsonValue>;
  const candidate = { ...normalized, digest: artifactDigest(normalized) };
  const parsed = parseProofArtifact(candidate);
  if (!parsed.ok) {
    const [diagnostic] = parsed.diagnostics;
    return exportFailure(
      "invalid-artifact-export",
      `The stored session does not form a valid artifact at ${(diagnostic.path ?? []).join(".")}: ${diagnostic.message}`,
    );
  }
  return { status: "exported", artifact: candidate as unknown as ProofArtifact };
}

/** Whether every stored transition and preview carries its evidence, and every transition a sequence. */
function storesTransitionEvidence(rows: StoredRows): boolean {
  const { edges, tree } = rows;
  const stored = (value: Readonly<{ evidence?: unknown; sequence?: unknown }>) =>
    value.evidence !== undefined && value.sequence !== undefined;
  return (
    edges.every(stored) &&
    tree.events.every(stored) &&
    tree.commands.every(
      ({ prepared, receipt }) => stored(prepared.edge) && stored(prepared.event) && stored(receipt),
    ) &&
    tree.previews.every(
      (preview) =>
        preview.evidence !== undefined &&
        (preview.macro?.steps ?? []).every((step) => step.evidence !== undefined),
    )
  );
}

/** The rows without any stored evidence or sequence: a version-1 artifact's shape. */
function legacyShape(rows: StoredRows): Pick<StoredRows, "edges" | "tree"> {
  return {
    edges: rows.edges.map((edge) => withoutEvidenceFields(edge)),
    tree: {
      ...rows.tree,
      events: rows.tree.events.map((event) => withoutEvidenceFields(event)),
      commands: rows.tree.commands.map(withoutStoredTransitionEvidence),
      previews: rows.tree.previews.map(previewWithoutStoredEvidence),
    },
  };
}

/** `sha256:` of the canonical JSON of an artifact's content (everything except `digest`). */
export function artifactDigest(content: unknown): string {
  const withoutDigest =
    typeof content === "object" && content !== null && !Array.isArray(content)
      ? Object.fromEntries(Object.entries(content).filter(([key]) => key !== "digest"))
      : content;
  return `sha256:${createHash("sha256").update(canonicalArtifactJson(withoutDigest)).digest("hex")}`;
}

async function readStoredRows(
  transaction: ProofStoreTransaction,
  sessionId: ProofSessionId,
  definitions: DefinitionCatalog,
): Promise<StoredRows | ArtifactExportFailure> {
  const loaded = await loadSession(transaction, sessionId, definitions);
  if (!loaded.ok) return loaded.failure;
  const { session, environment } = loaded;

  const nodes = parseAll(await transaction.listNodes(session.id), (input) =>
    parseNodeRow(input, session, environment),
  );
  const edges = parseAll(await transaction.listEdges(session.id), (input) =>
    parseEdgeRecord(input, session, environment),
  );
  const suggestionSets = parseAll(await transaction.listSuggestionSets(session.id), (input) =>
    parseSuggestionSetRow(input, session),
  );
  const previews = parseAll(await transaction.listPreviews(session.id), (input) =>
    safeParse(createMovePreviewSchema(environment), input),
  );
  const events = parseAll(await transaction.listEvents(session.id), (input) =>
    safeParse(createTransitionEventSchema(environment), input),
  );
  const commands = parseAll(await transaction.listCommands(session.id), (input) =>
    safeParse(createPrepareProofCommandSuccessSchema(environment), input),
  );
  const replaySteps = parseAll(await transaction.listReplaySteps(session.id), (input) =>
    safeParse(semanticReplayStepRecordSchema, input),
  );
  const deletions = parseAll(await transaction.listDeletions(session.id), (input) =>
    safeParse(proofDeletionRecordSchema, input),
  );
  const interactionEvents = await readLog(
    (afterSequence) =>
      transaction.listInteractionEvents(session.id, { afterSequence, limit: PAGE_SIZE }),
    (input) =>
      logRecord(
        input,
        session,
        ["sessionId", "eventId", "sequence", "nodeId", "event"],
        (row) => row.eventId,
        (row) => row.event,
        interactionEventSchema,
      ),
  );
  const inquiryRecords = await readLog(
    (afterSequence) =>
      transaction.listInquiryRecords(session.id, { afterSequence, limit: PAGE_SIZE }),
    (input) =>
      logRecord(
        input,
        session,
        ["sessionId", "recordId", "sequence", "commandId", "nodeId", "record"],
        (row) => row.recordId,
        (row) => row.record,
        inquiryRecordSchema,
      ),
  );
  const importInput = await transaction.readArtifactImport(session.id);
  const importRecord =
    importInput === undefined ? undefined : safeParse(proofArtifactImportRecordSchema, importInput);

  if (
    nodes === undefined ||
    edges === undefined ||
    suggestionSets === undefined ||
    previews === undefined ||
    events === undefined ||
    commands === undefined ||
    replaySteps === undefined ||
    deletions === undefined ||
    interactionEvents === undefined ||
    inquiryRecords === undefined ||
    (importInput !== undefined &&
      (importRecord === undefined || importRecord.sessionId !== session.id))
  ) {
    return exportFailure(
      "invalid-proof-history",
      "A stored record failed runtime validation or identity checks during export.",
    );
  }
  // Order by code units here rather than trusting the store's collation, so an artifact does not
  // depend on the store it was exported from.
  const byId = <Row>(rows: readonly Row[], keyOf: (row: Row) => string): Row[] =>
    [...rows].sort((left, right) => compareStrings(keyOf(left), keyOf(right)));
  return {
    session,
    nodes: byId(nodes, ({ id }) => id),
    edges: byId(edges, ({ id }) => id),
    tree: {
      events: byId(events, ({ id }) => id),
      commands: byId(commands, ({ prepared }) => prepared.command.commandId),
      suggestionSets: byId(suggestionSets, ({ id }) => id),
      previews: byId(previews, ({ id }) => id),
      replaySteps: byId(replaySteps, ({ commandId }) => commandId),
      deletions: byId(deletions, ({ id }) => id),
    },
    interactionEvents,
    inquiryRecords,
    importRecord,
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type LibrarySectionResult =
  Readonly<{ library: unknown; llmCalls: ProofArtifact["llmCalls"] }> | ArtifactExportFailure;

async function librarySection(
  rows: StoredRows,
  libraryStore: LibraryStore | undefined,
  llmCalls: ProofArtifact["llmCalls"] | undefined,
): Promise<LibrarySectionResult> {
  const { session, importRecord } = rows;
  // An imported session's library and LLM calls are the static sections of its import record.
  if (importRecord !== undefined) {
    return { library: importRecord.library, llmCalls: importRecord.llmCalls };
  }
  if (libraryStore === undefined) {
    return {
      library: {
        operators: session.operators,
        additionEvents: [],
        backgroundRevisions: [],
        finalLibrary: [],
      },
      llmCalls: llmCalls ?? [],
    };
  }
  const [events, revisions, active, registry] = await Promise.all([
    readAdditionEvents(libraryStore, session.id),
    readBackgroundRevisions(libraryStore, session.id),
    listLibrary(libraryStore, { sessionId: session.id }),
    listLibraryOperators(libraryStore),
  ]);
  if (events.status !== "found") return events;
  if (revisions.status !== "found") return revisions;
  if (active.status !== "found") return active;
  if (registry.status !== "found") return registry;
  const operators = mergeLibraryOperators([
    registry.registrations.map(({ operator }) => operator),
    session.operators,
  ]);
  if (!operators.ok) {
    return exportFailure("invalid-proof-history", operators.message);
  }
  return {
    library: {
      operators: operators.operators,
      additionEvents: events.events,
      backgroundRevisions: revisions.revisions,
      finalLibrary: active.artifacts,
    },
    llmCalls: llmCalls ?? [],
  };
}

function parseAll<Output>(
  inputs: unknown,
  parse: (input: unknown) => Output | undefined,
): Output[] | undefined {
  if (!Array.isArray(inputs)) return undefined;
  const outputs: Output[] = [];
  for (const input of inputs) {
    const output = parse(input);
    if (output === undefined) return undefined;
    outputs.push(output);
  }
  return outputs;
}

async function readLog<Output extends Readonly<{ sequence: number }>>(
  page: (afterSequence: number) => Promise<readonly unknown[]>,
  parse: (input: unknown) => Output | undefined,
): Promise<Output[] | undefined> {
  const outputs: Output[] = [];
  for (let after = 0; ;) {
    const inputs = await page(after);
    const parsed = parseAll(inputs, parse);
    if (parsed === undefined) return undefined;
    for (const output of parsed) {
      if (output.sequence <= after) return undefined;
      after = output.sequence;
      outputs.push(output);
    }
    if (parsed.length < PAGE_SIZE) return outputs;
  }
}

/** One read record of an ordered log, checked against its relational identity columns. */
function logRecord<Output extends Readonly<{ id: string; sequence: number; nodeId: string }>>(
  input: unknown,
  session: ProofSession,
  keys: readonly string[],
  idOf: (row: Readonly<Record<string, unknown>>) => unknown,
  valueOf: (row: Readonly<Record<string, unknown>>) => unknown,
  schema: z.ZodType<Output>,
): Output | undefined {
  if (!isStrictDataRecord(input, keys) || input.sessionId !== session.id) return undefined;
  const value = safeParse(schema, valueOf(input));
  return value !== undefined &&
    value.id === idOf(input) &&
    value.sequence === input.sequence &&
    value.nodeId === input.nodeId &&
    (!("commandId" in input) || input.commandId === (value as { commandId?: unknown }).commandId)
    ? value
    : undefined;
}

function parseNodeRow(
  input: unknown,
  session: ProofSession,
  environment: ProtocolEnvironment,
): ProofNode | undefined {
  if (!isStrictDataRecord(input, ["sessionId", "nodeId", "stateId", "node"])) return undefined;
  const node = safeParse(createProofNodeSchema(environment), input.node);
  return node !== undefined &&
    input.sessionId === session.id &&
    input.nodeId === node.id &&
    input.stateId === node.state.id
    ? node
    : undefined;
}

function parseSuggestionSetRow(
  input: unknown,
  session: ProofSession,
): z.infer<typeof displayedSuggestionSetSchema> | undefined {
  if (
    !isStrictDataRecord(input, [
      "sessionId",
      "suggestionSetId",
      "nodeId",
      "stateId",
      "suggestionSet",
    ])
  ) {
    return undefined;
  }
  const suggestionSet = safeParse(displayedSuggestionSetSchema, input.suggestionSet);
  return suggestionSet !== undefined &&
    input.sessionId === session.id &&
    input.suggestionSetId === suggestionSet.id &&
    input.nodeId === suggestionSet.nodeId &&
    input.stateId === suggestionSet.stateId
    ? suggestionSet
    : undefined;
}

function exportFailure(code: string, message: string): ArtifactExportFailure {
  return { status: "rejected", diagnostics: [{ code, message }] };
}
