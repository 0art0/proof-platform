/**
 * Library store and repository (design plan §12.4, roadmap N12).
 *
 * Library additions are append-only events scoped globally or to one proof session. The repository
 * runs the deterministic admission gate itself; the caller supplies only the artifact, layer,
 * origin and time. Every decision, including a rejection, is recorded as an event, and only an
 * admitted artifact gets an artifact row. An artifact added during a session is listed from then
 * on; stored suggestion sets are never touched, so history stays static.
 *
 * Background revisions update the session's `proof_sessions.metadata.background` and append a
 * revision event in the same transaction. Approved operator declarations are registered globally
 * with a unique symbol.
 */
import {
  admissionRecord,
  admitLibraryArtifact,
  backgroundProfileSchema,
  backgroundRevisionActorSchema,
  backgroundRevisionEventSchema,
  createLibraryAdditionEventSchema,
  createLibraryArtifactSchema,
  libraryAdditionEventIdSchema,
  libraryAdditionOriginSchema,
  libraryLayerSchema,
  libraryOperatorRegistrationSchema,
  mergeLibraryOperators,
  type BackgroundRevisionEvent,
  type LibraryAdditionEvent,
  type LibraryArtifact,
  type LibraryLayer,
  type LibraryOperatorRegistration,
} from "@proof/library";
import {
  proofSessionMetadataSchema,
  type OperatorDeclaration,
  type ProofSessionMetadata,
} from "@proof/protocol";
import { z } from "zod";
import { ProofStoreTransactionError } from "./proof-repository";

const stableStorageIdentifierSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const timestampSchema = z.string().datetime({ offset: true });

/** Deterministic presentation order of the layers in `listLibrary`. */
export const LIBRARY_LAYER_ORDER = libraryLayerSchema.options;

/** The storage scope key: `global`, or `session:<id>` for one proof session. */
export function libraryScopeKey(sessionId: string | undefined): string {
  return sessionId === undefined ? "global" : `session:${sessionId}`;
}

/**
 * The locked session columns the library needs. `readOnly` is true for a session imported from
 * an artifact (migration 0011); its library accepts no additions or revisions.
 */
export type LibrarySessionRow = Readonly<{
  operators: unknown;
  metadata: unknown;
  readOnly?: boolean | undefined;
}>;

/** One `library_artifacts` row: the admitted artifact with its addition ordering. */
export type StoredLibraryArtifactRow = Readonly<{
  sessionId: string | null;
  eventId: string;
  sequence: number;
  artifact: unknown;
}>;

export interface LibraryStoreTransaction {
  /** Lock the session row (`FOR UPDATE`) and return its operators and metadata. */
  lockLibrarySession(sessionId: string): Promise<LibrarySessionRow | undefined>;
  /** Serialize writers of the global scope and the operator registry. */
  lockGlobalLibrary(): Promise<void>;
  proofNodeExists(sessionId: string, nodeId: string): Promise<boolean>;
  readAdditionEvent(sessionId: string | undefined, eventId: string): Promise<unknown | undefined>;
  /** Events of exactly one scope, in sequence order. */
  listAdditionEvents(sessionId: string | undefined): Promise<readonly unknown[]>;
  readLibraryArtifact(
    sessionId: string | undefined,
    artifactId: string,
  ): Promise<unknown | undefined>;
  /** Artifact rows of exactly one scope, in sequence order. */
  listLibraryArtifacts(sessionId: string | undefined): Promise<readonly StoredLibraryArtifactRow[]>;
  insertAdditionEvent(event: LibraryAdditionEvent): Promise<void>;
  /** Insert the artifact row of an admitted event. */
  insertLibraryArtifact(event: LibraryAdditionEvent): Promise<void>;
  listBackgroundRevisions(sessionId: string): Promise<readonly unknown[]>;
  insertBackgroundRevision(event: BackgroundRevisionEvent): Promise<void>;
  updateSessionMetadata(sessionId: string, metadata: ProofSessionMetadata): Promise<boolean>;
  /** Registered operators ordered by symbol. */
  listLibraryOperators(): Promise<readonly unknown[]>;
  insertLibraryOperator(registration: LibraryOperatorRegistration): Promise<void>;
}

export interface LibraryStore {
  libraryTransaction<Result>(
    work: (transaction: LibraryStoreTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export type LibraryRepositoryDiagnosticCode =
  | "invalid-request"
  | "session-not-found"
  | "session-metadata-missing"
  | "invalid-environment"
  | "event-id-conflict"
  | "artifact-id-conflict"
  | "stale-background"
  | "operator-id-conflict"
  | "operator-symbol-conflict"
  | "library-record-invalid"
  | "session-read-only"
  | "storage-failure"
  | "commit-unknown";
export type LibraryRepositoryDiagnostic = Readonly<{
  code: LibraryRepositoryDiagnosticCode;
  message: string;
}>;
export type LibraryRepositoryFailure = Readonly<{
  status: "rejected" | "uncertain";
  diagnostics: readonly [LibraryRepositoryDiagnostic];
}>;

export const libraryAdditionRequestSchema = z
  .object({
    id: libraryAdditionEventIdSchema,
    sessionId: stableStorageIdentifierSchema.optional(),
    occurredAt: timestampSchema,
    layer: libraryLayerSchema,
    origin: libraryAdditionOriginSchema,
    artifact: z.unknown(),
  })
  .strict()
  .refine((request) => (request.layer === "global") === (request.sessionId === undefined), {
    message: "Only global-layer additions are outside a session.",
  });
export type LibraryAdditionRequest = z.infer<typeof libraryAdditionRequestSchema>;

export type AddLibraryArtifactResult =
  | Readonly<{
      status: "recorded";
      /** Whether the gate admitted the artifact; a rejection is recorded but adds nothing. */
      admitted: boolean;
      event: LibraryAdditionEvent;
      replayed: boolean;
    }>
  | LibraryRepositoryFailure;

/** Gate and atomically record one library addition; admitted artifacts join their scope. */
export async function addLibraryArtifact(
  store: LibraryStore,
  input: unknown,
): Promise<AddLibraryArtifactResult> {
  const request = safeParse(libraryAdditionRequestSchema, input);
  if (request === undefined) {
    return failure("rejected", "invalid-request", "The library addition request is invalid.");
  }
  const { sessionId } = request;
  try {
    return await store.libraryTransaction(async (transaction) => {
      const scope = await lockScope(transaction, sessionId);
      if ("status" in scope) return scope;
      if (scope.session?.readOnly === true) return readOnlySession(sessionId);
      const operators = await environmentOperators(transaction, scope.session);
      if (operators === undefined) {
        return failure("rejected", "invalid-environment", "The operator environment is invalid.");
      }
      const eventSchema = createLibraryAdditionEventSchema({ operators });

      const existingInput = await transaction.readAdditionEvent(sessionId, request.id);
      if (existingInput !== undefined) {
        const existing = safeParse(eventSchema, existingInput);
        if (existing === undefined) {
          return failure("rejected", "library-record-invalid", "The stored event is invalid.");
        }
        return sameRequest(existing, request)
          ? freezeDetached({
              status: "recorded" as const,
              admitted: existing.admission.decision === "admitted",
              event: existing,
              replayed: true,
            })
          : failure("rejected", "event-id-conflict", "The event ID is bound to another addition.");
      }

      const artifact = safeParse(createLibraryArtifactSchema({ operators }), request.artifact);
      if (artifact === undefined || artifact.layer !== request.layer) {
        return failure(
          "rejected",
          "invalid-request",
          "The artifact must be valid and declare the requested layer.",
        );
      }

      let profile: z.infer<typeof backgroundProfileSchema> | undefined;
      let revisions: readonly BackgroundRevisionEvent[] = [];
      if (sessionId !== undefined) {
        const background = await sessionBackground(transaction, sessionId, scope.session);
        if ("status" in background) return background;
        ({ profile, revisions } = background);
      }
      const proofNodeIds =
        artifact.provenance.kind === "derived" &&
        artifact.provenance.sessionId === sessionId &&
        sessionId !== undefined &&
        (await transaction.proofNodeExists(sessionId, artifact.provenance.proofNodeId))
          ? [artifact.provenance.proofNodeId]
          : [];

      const gate = admitLibraryArtifact({
        artifact,
        layer: request.layer,
        sessionId,
        profile,
        revisions,
        proofNodeIds,
        environment: { operators },
      });
      if (gate.ok) {
        const conflicting =
          (await transaction.readLibraryArtifact(sessionId, artifact.id)) ??
          (sessionId === undefined
            ? undefined
            : await transaction.readLibraryArtifact(undefined, artifact.id));
        if (conflicting !== undefined) {
          return failure(
            "rejected",
            "artifact-id-conflict",
            `The artifact ${artifact.id} is already in the active library.`,
          );
        }
      }

      const sequence = (await transaction.listAdditionEvents(sessionId)).length;
      const event = safeParse(eventSchema, {
        id: request.id,
        ...(sessionId === undefined ? {} : { sessionId }),
        sequence,
        occurredAt: request.occurredAt,
        artifact,
        layer: request.layer,
        origin: request.origin,
        classification: artifact.classification,
        admission: admissionRecord(gate),
        approval: artifact.approval,
      });
      if (event === undefined) {
        return failure("rejected", "invalid-request", "The addition does not form a valid event.");
      }
      await transaction.insertAdditionEvent(event);
      if (gate.ok) await transaction.insertLibraryArtifact(event);
      return freezeDetached({
        status: "recorded" as const,
        admitted: gate.ok,
        event,
        replayed: false,
      });
    });
  } catch (error: unknown) {
    return storageFailure(error, "The library addition could not be recorded atomically.");
  }
}

const listLibraryInputSchema = z
  .object({
    sessionId: stableStorageIdentifierSchema.optional(),
    layers: z.array(libraryLayerSchema).optional(),
  })
  .strict();

export type ListLibraryResult =
  Readonly<{ status: "found"; artifacts: readonly LibraryArtifact[] }> | LibraryRepositoryFailure;

/**
 * The active library: global artifacts plus the session's layers, ordered by layer (in
 * `LIBRARY_LAYER_ORDER`), then addition sequence, then artifact ID.
 */
export async function listLibrary(store: LibraryStore, input: unknown): Promise<ListLibraryResult> {
  const request = safeParse(listLibraryInputSchema, input);
  if (request === undefined) {
    return failure("rejected", "invalid-request", "The library listing request is invalid.");
  }
  try {
    return await store.libraryTransaction(async (transaction) => {
      const scope = await lockScope(transaction, request.sessionId, false);
      if ("status" in scope) return scope;
      const operators = await environmentOperators(transaction, scope.session);
      if (operators === undefined) {
        return failure("rejected", "invalid-environment", "The operator environment is invalid.");
      }
      const artifactSchema = createLibraryArtifactSchema({ operators });
      const rows = [
        ...(await transaction.listLibraryArtifacts(undefined)),
        ...(request.sessionId === undefined
          ? []
          : await transaction.listLibraryArtifacts(request.sessionId)),
      ];
      const entries: { artifact: LibraryArtifact; sequence: number }[] = [];
      for (const row of rows) {
        const artifact = safeParse(artifactSchema, row.artifact);
        if (artifact === undefined) {
          return failure("rejected", "library-record-invalid", "A stored artifact is invalid.");
        }
        entries.push({ artifact, sequence: row.sequence });
      }
      const layers = request.layers === undefined ? undefined : new Set(request.layers);
      const artifacts = entries
        .filter(({ artifact }) => layers === undefined || layers.has(artifact.layer))
        .sort(
          (left, right) =>
            layerRank(left.artifact.layer) - layerRank(right.artifact.layer) ||
            left.sequence - right.sequence ||
            compareStrings(left.artifact.id, right.artifact.id),
        )
        .map(({ artifact }) => artifact);
      return freezeDetached({ status: "found" as const, artifacts });
    });
  } catch (error: unknown) {
    return storageFailure(error, "The library could not be read.");
  }
}

export type ReadAdditionEventsResult =
  Readonly<{ status: "found"; events: readonly LibraryAdditionEvent[] }> | LibraryRepositoryFailure;

/** Addition events of one scope (the session's, or the global scope), in sequence order. */
export async function readAdditionEvents(
  store: LibraryStore,
  sessionIdInput?: unknown,
): Promise<ReadAdditionEventsResult> {
  const sessionId =
    sessionIdInput === undefined
      ? undefined
      : safeParse(stableStorageIdentifierSchema, sessionIdInput);
  if (sessionIdInput !== undefined && sessionId === undefined) {
    return failure("rejected", "invalid-request", "The session ID is invalid.");
  }
  try {
    return await store.libraryTransaction(async (transaction) => {
      const scope = await lockScope(transaction, sessionId, false);
      if ("status" in scope) return scope;
      const operators = await environmentOperators(transaction, scope.session);
      if (operators === undefined) {
        return failure("rejected", "invalid-environment", "The operator environment is invalid.");
      }
      const schema = createLibraryAdditionEventSchema({ operators });
      const events: LibraryAdditionEvent[] = [];
      for (const input of await transaction.listAdditionEvents(sessionId)) {
        const event = safeParse(schema, input);
        if (event === undefined || event.sessionId !== sessionId) {
          return failure("rejected", "library-record-invalid", "A stored event is invalid.");
        }
        events.push(event);
      }
      return freezeDetached({ status: "found" as const, events });
    });
  } catch (error: unknown) {
    return storageFailure(error, "The library addition events could not be read.");
  }
}

export const backgroundRevisionRequestSchema = z
  .object({
    id: backgroundRevisionEventSchema.shape.id,
    occurredAt: timestampSchema,
    previous: backgroundProfileSchema,
    revised: backgroundProfileSchema,
    reason: z.string().min(1).max(2_000),
    actor: backgroundRevisionActorSchema,
  })
  .strict();
export type BackgroundRevisionRequest = z.infer<typeof backgroundRevisionRequestSchema>;

export type ReviseBackgroundResult =
  | Readonly<{
      status: "recorded";
      event: BackgroundRevisionEvent;
      metadata: ProofSessionMetadata;
      replayed: boolean;
    }>
  | LibraryRepositoryFailure;

/**
 * Explicitly revise a session's background profile. `previous` must be the current profile, so a
 * concurrent revision is detected instead of overwritten.
 */
export async function reviseBackground(
  store: LibraryStore,
  sessionIdInput: unknown,
  input: unknown,
): Promise<ReviseBackgroundResult> {
  const sessionId = safeParse(stableStorageIdentifierSchema, sessionIdInput);
  const request = safeParse(backgroundRevisionRequestSchema, input);
  if (sessionId === undefined || request === undefined) {
    return failure("rejected", "invalid-request", "The background revision request is invalid.");
  }
  try {
    return await store.libraryTransaction(async (transaction) => {
      const session = await transaction.lockLibrarySession(sessionId);
      if (session === undefined) {
        return failure("rejected", "session-not-found", "The proof session does not exist.");
      }
      if (session.readOnly === true) return readOnlySession(sessionId);
      const metadata = parseMetadata(session.metadata);
      if (metadata === undefined) {
        return failure(
          "rejected",
          "session-metadata-missing",
          "The session has no metadata with a background profile to revise.",
        );
      }
      const revisions = await parsedRevisions(transaction, sessionId);
      if (revisions === undefined) {
        return failure("rejected", "library-record-invalid", "A stored revision is invalid.");
      }
      const existing = revisions.find((revision) => revision.id === request.id);
      if (existing !== undefined) {
        return sameJson(
          { ...existing, sessionId, sequence: existing.sequence },
          {
            ...request,
            sessionId,
            sequence: existing.sequence,
          },
        )
          ? freezeDetached({
              status: "recorded" as const,
              event: existing,
              metadata,
              replayed: true,
            })
          : failure(
              "rejected",
              "event-id-conflict",
              "The revision ID is bound to another revision.",
            );
      }
      if (!sameJson(metadata.background, request.previous)) {
        return failure(
          "rejected",
          "stale-background",
          "The revision does not start from the session's current background profile.",
        );
      }
      const event = safeParse(backgroundRevisionEventSchema, {
        ...request,
        sessionId,
        sequence: revisions.length,
      });
      const revisedMetadata = safeParse(proofSessionMetadataSchema, {
        ...metadata,
        background: request.revised,
      });
      if (event === undefined || revisedMetadata === undefined) {
        return failure("rejected", "invalid-request", "The revision must change the profile.");
      }
      await transaction.insertBackgroundRevision(event);
      if (!(await transaction.updateSessionMetadata(sessionId, revisedMetadata))) {
        throw new Error("The locked session row could not be updated.");
      }
      return freezeDetached({
        status: "recorded" as const,
        event,
        metadata: revisedMetadata,
        replayed: false,
      });
    });
  } catch (error: unknown) {
    return storageFailure(error, "The background revision could not be recorded atomically.");
  }
}

export type ReadBackgroundRevisionsResult =
  | Readonly<{ status: "found"; revisions: readonly BackgroundRevisionEvent[] }>
  | LibraryRepositoryFailure;

export async function readBackgroundRevisions(
  store: LibraryStore,
  sessionIdInput: unknown,
): Promise<ReadBackgroundRevisionsResult> {
  const sessionId = safeParse(stableStorageIdentifierSchema, sessionIdInput);
  if (sessionId === undefined) {
    return failure("rejected", "invalid-request", "The session ID is invalid.");
  }
  try {
    return await store.libraryTransaction(async (transaction) => {
      if ((await transaction.lockLibrarySession(sessionId)) === undefined) {
        return failure("rejected", "session-not-found", "The proof session does not exist.");
      }
      const revisions = await parsedRevisions(transaction, sessionId);
      return revisions === undefined
        ? failure("rejected", "library-record-invalid", "A stored revision is invalid.")
        : freezeDetached({ status: "found" as const, revisions });
    });
  } catch (error: unknown) {
    return storageFailure(error, "The background revisions could not be read.");
  }
}

export type RegisterLibraryOperatorResult =
  | Readonly<{ status: "registered"; registration: LibraryOperatorRegistration; replayed: boolean }>
  | LibraryRepositoryFailure;

/** Persist an approved operator declaration in the global registry; symbols are unique. */
export async function registerLibraryOperator(
  store: LibraryStore,
  input: unknown,
): Promise<RegisterLibraryOperatorResult> {
  const registration = safeParse(libraryOperatorRegistrationSchema, input);
  if (registration === undefined) {
    return failure("rejected", "invalid-request", "The operator registration is invalid.");
  }
  try {
    return await store.libraryTransaction(async (transaction) => {
      await transaction.lockGlobalLibrary();
      const existing = await parsedOperators(transaction);
      if (existing === undefined) {
        return failure("rejected", "library-record-invalid", "A registered operator is invalid.");
      }
      const same = existing.find(({ operator }) => operator.id === registration.operator.id);
      if (same !== undefined) {
        return sameJson(same, registration)
          ? freezeDetached({ status: "registered" as const, registration: same, replayed: true })
          : failure("rejected", "operator-id-conflict", "The operator ID is already registered.");
      }
      if (existing.some(({ operator }) => operator.symbol === registration.operator.symbol)) {
        return failure(
          "rejected",
          "operator-symbol-conflict",
          `The operator symbol ${registration.operator.symbol} is already registered.`,
        );
      }
      const merged = mergeLibraryOperators([
        existing.map(({ operator }) => operator),
        [registration.operator],
      ]);
      if (!merged.ok) return failure("rejected", "invalid-environment", merged.message);
      await transaction.insertLibraryOperator(registration);
      return freezeDetached({ status: "registered" as const, registration, replayed: false });
    });
  } catch (error: unknown) {
    return storageFailure(error, "The operator could not be registered atomically.");
  }
}

export type ListLibraryOperatorsResult =
  | Readonly<{ status: "found"; registrations: readonly LibraryOperatorRegistration[] }>
  | LibraryRepositoryFailure;

export async function listLibraryOperators(
  store: LibraryStore,
): Promise<ListLibraryOperatorsResult> {
  try {
    return await store.libraryTransaction(async (transaction) => {
      const registrations = await parsedOperators(transaction);
      return registrations === undefined
        ? failure("rejected", "library-record-invalid", "A registered operator is invalid.")
        : freezeDetached({ status: "found" as const, registrations });
    });
  } catch (error: unknown) {
    return storageFailure(error, "The operator registry could not be read.");
  }
}

type LockedScope = Readonly<{ session: LibrarySessionRow | undefined }>;

async function lockScope(
  transaction: LibraryStoreTransaction,
  sessionId: string | undefined,
  lockGlobal = true,
): Promise<LockedScope | LibraryRepositoryFailure> {
  if (sessionId === undefined) {
    if (lockGlobal) await transaction.lockGlobalLibrary();
    return { session: undefined };
  }
  const session = await transaction.lockLibrarySession(sessionId);
  return session === undefined
    ? failure("rejected", "session-not-found", "The proof session does not exist.")
    : { session };
}

async function environmentOperators(
  transaction: LibraryStoreTransaction,
  session: LibrarySessionRow | undefined,
): Promise<readonly OperatorDeclaration[] | undefined> {
  const registrations = await parsedOperators(transaction);
  if (registrations === undefined) return undefined;
  const sessionOperators = session === undefined ? [] : session.operators;
  if (!Array.isArray(sessionOperators)) return undefined;
  const merged = mergeLibraryOperators([
    registrations.map(({ operator }) => operator),
    sessionOperators as readonly unknown[],
  ]);
  return merged.ok ? merged.operators : undefined;
}

async function sessionBackground(
  transaction: LibraryStoreTransaction,
  sessionId: string,
  session: LibrarySessionRow | undefined,
): Promise<
  | Readonly<{
      profile: z.infer<typeof backgroundProfileSchema> | undefined;
      revisions: readonly BackgroundRevisionEvent[];
    }>
  | LibraryRepositoryFailure
> {
  const metadata = session?.metadata == null ? undefined : parseMetadata(session.metadata);
  if (session?.metadata != null && metadata === undefined) {
    return failure("rejected", "library-record-invalid", "The session metadata is invalid.");
  }
  const revisions = await parsedRevisions(transaction, sessionId);
  if (revisions === undefined) {
    return failure("rejected", "library-record-invalid", "A stored revision is invalid.");
  }
  const last = revisions.at(-1);
  if (last !== undefined && !sameJson(last.revised, metadata?.background)) {
    return failure(
      "rejected",
      "library-record-invalid",
      "The session background differs from its recorded revisions.",
    );
  }
  return { profile: revisions[0]?.previous ?? metadata?.background, revisions };
}

async function parsedRevisions(
  transaction: LibraryStoreTransaction,
  sessionId: string,
): Promise<readonly BackgroundRevisionEvent[] | undefined> {
  const revisions: BackgroundRevisionEvent[] = [];
  for (const input of await transaction.listBackgroundRevisions(sessionId)) {
    const revision = safeParse(backgroundRevisionEventSchema, input);
    if (revision?.sessionId !== sessionId) return undefined;
    revisions.push(revision);
  }
  return revisions;
}

async function parsedOperators(
  transaction: LibraryStoreTransaction,
): Promise<readonly LibraryOperatorRegistration[] | undefined> {
  const registrations: LibraryOperatorRegistration[] = [];
  for (const input of await transaction.listLibraryOperators()) {
    const registration = safeParse(libraryOperatorRegistrationSchema, input);
    if (registration === undefined) return undefined;
    registrations.push(registration);
  }
  return registrations;
}

function parseMetadata(input: unknown): ProofSessionMetadata | undefined {
  return input == null ? undefined : safeParse(proofSessionMetadataSchema, input);
}

function sameRequest(event: LibraryAdditionEvent, request: LibraryAdditionRequest): boolean {
  return (
    event.sessionId === request.sessionId &&
    event.layer === request.layer &&
    event.occurredAt === request.occurredAt &&
    sameJson(event.origin, request.origin) &&
    sameJson(event.artifact, request.artifact)
  );
}

function layerRank(layer: LibraryLayer): number {
  return LIBRARY_LAYER_ORDER.indexOf(layer);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failure(
  status: LibraryRepositoryFailure["status"],
  code: LibraryRepositoryDiagnosticCode,
  message: string,
): LibraryRepositoryFailure {
  return freezeDetached({ status, diagnostics: [{ code, message }] as const });
}

function readOnlySession(sessionId: string | undefined): LibraryRepositoryFailure {
  return failure(
    "rejected",
    "session-read-only",
    `The proof session ${sessionId ?? ""} is read-only; it was imported from an artifact.`,
  );
}

function storageFailure(error: unknown, message: string): LibraryRepositoryFailure {
  return error instanceof ProofStoreTransactionError && error.outcome === "commit-unknown"
    ? failure("uncertain", "commit-unknown", message)
    : failure("rejected", "storage-failure", message);
}

function safeParse<Output>(schema: z.ZodType<Output>, input: unknown): Output | undefined {
  try {
    const result = schema.safeParse(structuredClone(input));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Key-order-insensitive JSON equality, so JSONB round trips compare equal. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function freezeDetached<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value) as Value);
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
