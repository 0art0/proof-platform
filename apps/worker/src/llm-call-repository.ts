import {
  MAX_LIBRARIAN_RESULTS,
  backgroundProposalSchema,
  llmCallEvidenceSchema,
  llmCallIdSchema,
  preparedLlmCallSchema,
  topicManifestProposalSchema,
  executePreparedLlmCall,
  type BackgroundProposal,
  type LibrarianContext,
  type LibrarianProposal,
  type LlmCallId,
  type LlmTransport,
} from "@proof/llm";
import { canonicalJsonEquals } from "@proof/mathjson-model";
import { z } from "zod";
import { ProofStoreTransactionError } from "./proof-repository";

const stableStorageIdentifierSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

export const llmCallOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("construction"), id: stableStorageIdentifierSchema }).strict(),
  z.object({ kind: z.literal("proof-session"), id: stableStorageIdentifierSchema }).strict(),
]);
export type LlmCallOwner = z.infer<typeof llmCallOwnerSchema>;

export const llmDispatchConfigurationSchema = z
  .object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    promptVersion: z.string().min(1).max(100),
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
    minimumConfidence: z.number().min(0).max(1).optional(),
  })
  .strict();
export type LlmDispatchConfiguration = z.infer<typeof llmDispatchConfigurationSchema>;

const storedLlmCallBase = {
  owner: llmCallOwnerSchema,
  id: llmCallIdSchema,
  role: preparedLlmCallSchema.shape.role,
  preparedCall: preparedLlmCallSchema,
  dispatch: llmDispatchConfigurationSchema,
};
const dispatchingLlmCallSchema = z
  .object({ ...storedLlmCallBase, status: z.literal("dispatching") })
  .strict();
const completedLlmCallSchema = z
  .object({
    ...storedLlmCallBase,
    status: z.literal("completed"),
    evidence: llmCallEvidenceSchema,
  })
  .strict();
export const storedLlmCallSchema = z
  .discriminatedUnion("status", [dispatchingLlmCallSchema, completedLlmCallSchema])
  .superRefine((record, context) => {
    if (record.id !== record.preparedCall.id || record.role !== record.preparedCall.role) {
      context.addIssue({ code: "custom", message: "Stored call identity must match its request." });
    }
    if (
      record.status === "completed" &&
      (record.evidence.id !== record.id || record.evidence.role !== record.role)
    ) {
      context.addIssue({ code: "custom", message: "Stored evidence must match its request." });
    }
  });
export type StoredLlmCall = z.infer<typeof storedLlmCallSchema>;

const reviewFields = {
  id: stableStorageIdentifierSchema,
  owner: llmCallOwnerSchema,
  callId: llmCallIdSchema,
  reviewerId: stableStorageIdentifierSchema,
  decidedAt: z.string().datetime({ offset: true }),
  rationale: z.string().min(1).max(2_000),
};
const reviewBase = { ...reviewFields, proposal: topicManifestProposalSchema };
export const topicProposalDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      ...reviewBase,
      decision: z.literal("approved"),
      approvedManifestId: stableStorageIdentifierSchema,
    })
    .strict(),
  z.object({ ...reviewBase, decision: z.literal("rejected") }).strict(),
]);
export type TopicProposalDecision = z.infer<typeof topicProposalDecisionSchema>;

/**
 * Review of a background proposal. Its rows share `llm_topic_decisions` with topic reviews (both
 * are keyed by owner and decision ID, and reference a stored call); the approved item's ID is kept
 * in the table's `approved_manifest_id` column, which the record mirrors.
 */
const backgroundReviewBase = { ...reviewFields, proposal: backgroundProposalSchema };
export const backgroundProposalDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      ...backgroundReviewBase,
      decision: z.literal("approved"),
      approvedManifestId: stableStorageIdentifierSchema,
    })
    .strict(),
  z.object({ ...backgroundReviewBase, decision: z.literal("rejected") }).strict(),
]);
export type BackgroundProposalDecision = z.infer<typeof backgroundProposalDecisionSchema>;

/**
 * A person's bulk approval of results of a librarian proposal. Its row shares
 * `llm_topic_decisions` with the other reviews and references the stored call. It names the kept
 * result IDs and nothing else: the artifacts are always read from the stored call, so a decision
 * can never carry mathematics the model did not return. A person who keeps nothing records no
 * decision. The approval's own ID is kept in the table's `approved_manifest_id` column.
 */
export const libraryProposalDecisionSchema = z
  .object({
    ...reviewFields,
    decision: z.literal("approved"),
    approvedManifestId: stableStorageIdentifierSchema,
    approvedResultIds: z
      .array(stableStorageIdentifierSchema)
      .min(1)
      .max(MAX_LIBRARIAN_RESULTS)
      .refine((ids) => new Set(ids).size === ids.length, "Approved result IDs must be unique."),
  })
  .strict();
export type LibraryProposalDecision = z.infer<typeof libraryProposalDecisionSchema>;
/** A review of a proposal that is stored with the exact proposal it reviewed. */
type ProposalReview = TopicProposalDecision | BackgroundProposalDecision;
export type ProposalDecision = ProposalReview | LibraryProposalDecision;

export const approvedTopicManifestSchema = z
  .object({
    id: stableStorageIdentifierSchema,
    owner: llmCallOwnerSchema,
    sourceCallId: llmCallIdSchema,
    decisionId: stableStorageIdentifierSchema,
    manifest: topicManifestProposalSchema,
  })
  .strict();
export type ApprovedTopicManifest = z.infer<typeof approvedTopicManifestSchema>;

/** What an approved background decision makes available: the profile and its constants. */
export type ApprovedBackground = Readonly<{
  id: string;
  owner: LlmCallOwner;
  sourceCallId: LlmCallId;
  decisionId: string;
  proposal: BackgroundProposal;
}>;

export interface LlmCallStoreTransaction {
  readCallForUpdate(owner: LlmCallOwner, callId: LlmCallId): Promise<unknown | undefined>;
  insertCall(record: StoredLlmCall): Promise<void>;
  completeCall(record: StoredLlmCall): Promise<boolean>;
  readDecisionForUpdate(owner: LlmCallOwner, decisionId: string): Promise<unknown | undefined>;
  insertDecision(decision: ProposalDecision): Promise<void>;
}

export interface LlmCallStore {
  transaction<Result>(
    work: (transaction: LlmCallStoreTransaction) => Promise<Result>,
  ): Promise<Result>;
  listCallsForOwner(owner: LlmCallOwner): Promise<readonly unknown[]>;
}

export type LlmCallRepositoryDiagnosticCode =
  | "invalid-request"
  | "call-id-conflict"
  | "call-record-invalid"
  | "call-in-progress-or-uncertain"
  | "call-not-found"
  | "decision-id-conflict"
  | "decision-not-found"
  | "decision-not-approved"
  | "proposal-not-reviewable"
  | "storage-failure"
  | "commit-unknown";
export type LlmCallRepositoryDiagnostic = Readonly<{
  code: LlmCallRepositoryDiagnosticCode;
  message: string;
}>;
type RepositoryFailure = Readonly<{
  status: "rejected" | "uncertain";
  diagnostics: readonly [LlmCallRepositoryDiagnostic];
}>;

export type RunDurableLlmCallResult =
  Readonly<{ status: "completed"; record: StoredLlmCall; replayed: boolean }> | RepositoryFailure;

const runCallInputSchema = z
  .object({
    owner: llmCallOwnerSchema,
    call: preparedLlmCallSchema,
    dispatch: llmDispatchConfigurationSchema,
  })
  .strict();

/** Claim, dispatch outside the transaction, and durably record one immutable LLM call. */
export async function runDurableLlmCall(
  store: LlmCallStore,
  input: unknown,
  transport: LlmTransport,
): Promise<RunDurableLlmCallResult> {
  const request = safeParse(runCallInputSchema, input);
  if (request === undefined)
    return failure("rejected", "invalid-request", "The call request is invalid.");
  const claimed = freezeDetached({
    owner: request.owner,
    id: request.call.id,
    role: request.call.role,
    preparedCall: request.call,
    dispatch: request.dispatch,
    status: "dispatching" as const,
  });

  let claim: { dispatch: true } | { dispatch: false; result: RunDurableLlmCallResult };
  try {
    claim = await store.transaction(async (transaction) => {
      const existingInput = await transaction.readCallForUpdate(claimed.owner, claimed.id);
      if (existingInput === undefined) {
        await transaction.insertCall(claimed);
        return { dispatch: true as const };
      }
      const existing = parseStoredCall(existingInput, claimed.owner, claimed.id);
      if (existing === undefined) {
        return {
          dispatch: false as const,
          result: failure(
            "rejected",
            "call-record-invalid",
            "The stored call failed validation or identity checks.",
          ),
        };
      }
      if (!sameClaim(existing, claimed)) {
        return {
          dispatch: false as const,
          result: failure(
            "rejected",
            "call-id-conflict",
            "The call ID is already bound to a different request or dispatch configuration.",
          ),
        };
      }
      return existing.status === "completed"
        ? {
            dispatch: false as const,
            result: { status: "completed" as const, record: existing, replayed: true },
          }
        : {
            dispatch: false as const,
            result: failure(
              "uncertain",
              "call-in-progress-or-uncertain",
              "The call was claimed previously; its provider outcome may be unknown.",
            ),
          };
    });
  } catch (error: unknown) {
    return storageFailure(error, "The prepared call could not be recorded before dispatch.");
  }
  if (!claim.dispatch) return claim.result;

  const evidence = await executePreparedLlmCall(claimed.preparedCall, transport);
  const completed = freezeDetached({ ...claimed, status: "completed" as const, evidence });
  try {
    return await store.transaction(async (transaction) => {
      const currentInput = await transaction.readCallForUpdate(completed.owner, completed.id);
      const current =
        currentInput === undefined
          ? undefined
          : parseStoredCall(currentInput, completed.owner, completed.id);
      if (current === undefined || !sameClaim(current, completed)) {
        return failure(
          "uncertain",
          "call-record-invalid",
          "The claimed call changed or disappeared after provider dispatch.",
        );
      }
      if (current.status === "completed") {
        return canonicalJsonEquals(current.evidence, evidence)
          ? { status: "completed" as const, record: current, replayed: true }
          : failure(
              "uncertain",
              "call-id-conflict",
              "A different provider outcome was already stored for this call.",
            );
      }
      if (!(await transaction.completeCall(completed))) {
        return failure(
          "uncertain",
          "commit-unknown",
          "The provider returned, but storage did not confirm the outcome update.",
        );
      }
      return { status: "completed" as const, record: completed, replayed: false };
    });
  } catch (error: unknown) {
    return storageFailure(error, "The provider returned, but its durable outcome is uncertain.");
  }
}

export type ReadLlmCallResult =
  Readonly<{ status: "found"; record: StoredLlmCall }> | RepositoryFailure;

/** Read documentary evidence without invoking a transport or revalidating historical output. */
export async function readLlmCall(
  store: LlmCallStore,
  ownerInput: unknown,
  callIdInput: unknown,
): Promise<ReadLlmCallResult> {
  const owner = safeParse(llmCallOwnerSchema, ownerInput);
  const callId = safeParse(llmCallIdSchema, callIdInput) as LlmCallId | undefined;
  if (owner === undefined || callId === undefined) {
    return failure("rejected", "invalid-request", "The call lookup is invalid.");
  }
  try {
    return await store.transaction(async (transaction) => {
      const recordInput = await transaction.readCallForUpdate(owner, callId);
      if (recordInput === undefined) {
        return failure("rejected", "call-not-found", "The LLM call does not exist.");
      }
      const record = parseStoredCall(recordInput, owner, callId);
      return record === undefined
        ? failure("rejected", "call-record-invalid", "The stored call is invalid.")
        : { status: "found" as const, record };
    });
  } catch (error: unknown) {
    return storageFailure(error, "The LLM call could not be read.");
  }
}

export type ListLlmCallsResult =
  Readonly<{ status: "found"; records: readonly StoredLlmCall[] }> | RepositoryFailure;

/** Read an owner's immutable call history without invoking a transport. */
export async function listLlmCalls(
  store: LlmCallStore,
  ownerInput: unknown,
): Promise<ListLlmCallsResult> {
  const owner = safeParse(llmCallOwnerSchema, ownerInput);
  if (owner === undefined) {
    return failure("rejected", "invalid-request", "The LLM call owner is invalid.");
  }
  try {
    const inputs = await store.listCallsForOwner(owner);
    const records = inputs.map((input) => {
      const possibleId =
        typeof input === "object" && input !== null && "id" in input ? input.id : undefined;
      const callId = safeParse(llmCallIdSchema, possibleId) as LlmCallId | undefined;
      return callId === undefined ? undefined : parseStoredCall(input, owner, callId);
    });
    if (records.some((record) => record === undefined)) {
      return failure("rejected", "call-record-invalid", "Stored LLM call history is invalid.");
    }
    return {
      status: "found",
      records: Object.freeze(
        (records as StoredLlmCall[]).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      ),
    };
  } catch (error: unknown) {
    return storageFailure(error, "The LLM call history could not be read.");
  }
}

export type RecordTopicProposalDecisionResult =
  | Readonly<{
      status: "recorded";
      decision: TopicProposalDecision;
      approvedManifest?: ApprovedTopicManifest | undefined;
      replayed: boolean;
    }>
  | RepositoryFailure;

/** Record human review of the exact topic proposal; this has no proof-state capability. */
export async function recordTopicProposalDecision(
  store: LlmCallStore,
  input: unknown,
): Promise<RecordTopicProposalDecisionResult> {
  const recorded = await recordProposalDecision(store, input, {
    schema: topicProposalDecisionSchema,
    role: "topic-extractor",
    outputKind: "topic-manifest",
    label: "topic",
  });
  return recorded.status === "recorded"
    ? decisionResult(recorded.decision, recorded.replayed)
    : recorded;
}

export type RecordBackgroundProposalDecisionResult =
  | Readonly<{
      status: "recorded";
      decision: BackgroundProposalDecision;
      approvedBackground?: ApprovedBackground | undefined;
      replayed: boolean;
    }>
  | RepositoryFailure;

/** Record human review of the exact background proposal; this has no proof-state capability. */
export async function recordBackgroundProposalDecision(
  store: LlmCallStore,
  input: unknown,
): Promise<RecordBackgroundProposalDecisionResult> {
  const recorded = await recordProposalDecision(store, input, {
    schema: backgroundProposalDecisionSchema,
    role: "background-proposer",
    outputKind: "background-proposal",
    label: "background",
  });
  if (recorded.status !== "recorded") return recorded;
  const approvedBackground = approvedBackgroundOf(recorded.decision);
  return freezeDetached({
    status: "recorded" as const,
    decision: recorded.decision,
    ...(approvedBackground === undefined ? {} : { approvedBackground }),
    replayed: recorded.replayed,
  });
}

export type ReadApprovedBackgroundResult =
  Readonly<{ status: "found"; approved: ApprovedBackground }> | RepositoryFailure;

/**
 * Resolve an approved background decision from storage. The constants an approved background
 * contributes are only ever read here, never taken from a request.
 */
export async function readApprovedBackground(
  store: LlmCallStore,
  ownerInput: unknown,
  decisionIdInput: unknown,
): Promise<ReadApprovedBackgroundResult> {
  const owner = safeParse(llmCallOwnerSchema, ownerInput);
  const decisionId = safeParse(stableStorageIdentifierSchema, decisionIdInput);
  if (owner === undefined || decisionId === undefined) {
    return failure("rejected", "invalid-request", "The background decision lookup is invalid.");
  }
  try {
    return await store.transaction(async (transaction) => {
      const recordInput = await transaction.readDecisionForUpdate(owner, decisionId);
      if (recordInput === undefined) {
        return failure(
          "rejected",
          "decision-not-found",
          "The background decision does not exist for this construction.",
        );
      }
      const decision = safeParse(backgroundProposalDecisionSchema, recordInput);
      if (
        decision === undefined ||
        decision.id !== decisionId ||
        !canonicalJsonEquals(decision.owner, owner)
      ) {
        return failure(
          "rejected",
          "decision-not-found",
          "The background decision does not exist for this construction.",
        );
      }
      const approved = approvedBackgroundOf(decision);
      return approved === undefined
        ? failure("rejected", "decision-not-approved", "The background decision was rejected.")
        : { status: "found" as const, approved };
    });
  } catch (error: unknown) {
    return storageFailure(error, "The background decision could not be read.");
  }
}

/** The validated proposal of a completed librarian call, with the context it was made from. */
export type StoredLibraryProposal = Readonly<{
  callId: LlmCallId;
  context: Extract<LibrarianContext, { kind: "initial" }>;
  proposal: LibrarianProposal;
}>;

/** The library proposal a stored call holds, or undefined when it holds none (yet). */
export function libraryProposalOf(record: StoredLlmCall): StoredLibraryProposal | undefined {
  if (
    record.status !== "completed" ||
    record.role !== "librarian" ||
    record.evidence.status !== "validated"
  ) {
    return undefined;
  }
  const output = record.evidence.output;
  const envelope = record.preparedCall.envelope;
  if (
    output?.kind !== "library-proposal" ||
    envelope.role !== "librarian" ||
    envelope.context.kind !== "initial"
  ) {
    return undefined;
  }
  return freezeDetached({ callId: record.id, context: envelope.context, proposal: output });
}

export type RecordLibraryDecisionResult =
  | Readonly<{ status: "recorded"; decision: LibraryProposalDecision; replayed: boolean }>
  | RepositoryFailure;

/**
 * Record a person's bulk approval of results of the library proposal of a stored call. A retried
 * decision with the same ID and content replays; the same ID for another review is a conflict.
 * That the named results were admitted is the caller's check (it needs the admission gate); the
 * approval is checked again whenever it is resolved.
 */
export async function recordLibraryProposalDecision(
  store: LlmCallStore,
  input: unknown,
): Promise<RecordLibraryDecisionResult> {
  const decision = safeParse(libraryProposalDecisionSchema, input);
  if (decision === undefined) {
    return failure("rejected", "invalid-request", "The library decision is invalid.");
  }
  try {
    return await store.transaction(async (transaction) => {
      const existingInput = await transaction.readDecisionForUpdate(decision.owner, decision.id);
      let existing: LibraryProposalDecision | undefined;
      if (existingInput !== undefined) {
        existing = safeParse(libraryProposalDecisionSchema, existingInput);
        if (existing === undefined || !canonicalJsonEquals(existing, decision)) {
          return failure(
            "rejected",
            "decision-id-conflict",
            "The decision ID is already bound to a different review.",
          );
        }
      }
      const callInput = await transaction.readCallForUpdate(decision.owner, decision.callId);
      const call =
        callInput === undefined
          ? undefined
          : parseStoredCall(callInput, decision.owner, decision.callId);
      if (call === undefined || libraryProposalOf(call) === undefined) {
        return failure(
          "rejected",
          "proposal-not-reviewable",
          "The decision must reference the validated library proposal of this call.",
        );
      }
      if (existing !== undefined) {
        return { status: "recorded" as const, decision: existing, replayed: true };
      }
      await transaction.insertDecision(freezeDetached(decision));
      return { status: "recorded" as const, decision, replayed: false };
    });
  } catch (error: unknown) {
    return storageFailure(error, "The library decision could not be recorded.");
  }
}

export type ReadLibraryDecisionResult =
  | Readonly<{
      status: "found";
      decision: LibraryProposalDecision;
      proposal: StoredLibraryProposal;
    }>
  | RepositoryFailure;

/**
 * Resolve a library approval from storage: the decision and the proposal of the call it
 * references. Nothing a request carries takes part, so a client cannot name artifacts.
 */
export async function readLibraryProposalDecision(
  store: LlmCallStore,
  ownerInput: unknown,
  decisionIdInput: unknown,
): Promise<ReadLibraryDecisionResult> {
  const owner = safeParse(llmCallOwnerSchema, ownerInput);
  const decisionId = safeParse(stableStorageIdentifierSchema, decisionIdInput);
  if (owner === undefined || decisionId === undefined) {
    return failure("rejected", "invalid-request", "The library decision lookup is invalid.");
  }
  try {
    return await store.transaction(async (transaction) => {
      const notFound = () =>
        failure(
          "rejected",
          "decision-not-found",
          "The library decision does not exist for this construction.",
        );
      const recordInput = await transaction.readDecisionForUpdate(owner, decisionId);
      if (recordInput === undefined) return notFound();
      const decision = safeParse(libraryProposalDecisionSchema, recordInput);
      if (
        decision === undefined ||
        decision.id !== decisionId ||
        !canonicalJsonEquals(decision.owner, owner)
      ) {
        return notFound();
      }
      const callInput = await transaction.readCallForUpdate(owner, decision.callId);
      const call =
        callInput === undefined ? undefined : parseStoredCall(callInput, owner, decision.callId);
      const proposal = call === undefined ? undefined : libraryProposalOf(call);
      return proposal === undefined
        ? failure(
            "rejected",
            "proposal-not-reviewable",
            "The library decision does not reference a validated library proposal.",
          )
        : { status: "found" as const, decision, proposal };
    });
  } catch (error: unknown) {
    return storageFailure(error, "The library decision could not be read.");
  }
}

function approvedBackgroundOf(
  decision: BackgroundProposalDecision,
): ApprovedBackground | undefined {
  return decision.decision === "approved"
    ? freezeDetached({
        id: decision.approvedManifestId,
        owner: decision.owner,
        sourceCallId: decision.callId,
        decisionId: decision.id,
        proposal: decision.proposal,
      })
    : undefined;
}

type DecisionSpec<Decision extends ProposalReview> = Readonly<{
  schema: z.ZodType<Decision>;
  role: StoredLlmCall["role"];
  outputKind: "topic-manifest" | "background-proposal";
  label: string;
}>;

/**
 * Record one review of the exact validated proposal of a stored call. A retried decision with the
 * same ID and content replays; the same ID for another review, or for the other kind of proposal,
 * is a conflict.
 */
async function recordProposalDecision<Decision extends ProposalReview>(
  store: LlmCallStore,
  input: unknown,
  spec: DecisionSpec<Decision>,
): Promise<
  Readonly<{ status: "recorded"; decision: Decision; replayed: boolean }> | RepositoryFailure
> {
  const decision = safeParse(spec.schema, input);
  if (decision === undefined) {
    return failure(
      "rejected",
      "invalid-request",
      `The ${spec.label} proposal decision is invalid.`,
    );
  }
  try {
    return await store.transaction(async (transaction) => {
      const existingInput = await transaction.readDecisionForUpdate(decision.owner, decision.id);
      let existing: Decision | undefined;
      if (existingInput !== undefined) {
        existing = safeParse(spec.schema, existingInput);
        if (existing === undefined || !canonicalJsonEquals(existing, decision)) {
          return failure(
            "rejected",
            "decision-id-conflict",
            "The decision ID is already bound to a different review.",
          );
        }
      }
      const callInput = await transaction.readCallForUpdate(decision.owner, decision.callId);
      const call =
        callInput === undefined
          ? undefined
          : parseStoredCall(callInput, decision.owner, decision.callId);
      if (
        call?.status !== "completed" ||
        call.role !== spec.role ||
        call.evidence.status !== "validated" ||
        call.evidence.output?.kind !== spec.outputKind ||
        !canonicalJsonEquals(call.evidence.output, decision.proposal)
      ) {
        return failure(
          "rejected",
          "proposal-not-reviewable",
          `The decision must reference the exact validated ${spec.label} proposal for this call.`,
        );
      }
      if (existing !== undefined) {
        return { status: "recorded" as const, decision: existing, replayed: true };
      }
      await transaction.insertDecision(freezeDetached(decision));
      return { status: "recorded" as const, decision, replayed: false };
    });
  } catch (error: unknown) {
    return storageFailure(error, `The ${spec.label} proposal decision could not be recorded.`);
  }
}

function decisionResult(
  decision: TopicProposalDecision,
  replayed: boolean,
): Exclude<RecordTopicProposalDecisionResult, RepositoryFailure> {
  const approvedManifest =
    decision.decision === "approved"
      ? freezeDetached({
          id: decision.approvedManifestId,
          owner: decision.owner,
          sourceCallId: decision.callId,
          decisionId: decision.id,
          manifest: decision.proposal,
        })
      : undefined;
  return freezeDetached({
    status: "recorded" as const,
    decision,
    ...(approvedManifest === undefined ? {} : { approvedManifest }),
    replayed,
  });
}

function parseStoredCall(
  input: unknown,
  owner: LlmCallOwner,
  callId: LlmCallId,
): StoredLlmCall | undefined {
  const record = safeParse(storedLlmCallSchema, input);
  return record !== undefined && canonicalJsonEquals(record.owner, owner) && record.id === callId
    ? freezeDetached(record)
    : undefined;
}

function sameClaim(
  left: Pick<StoredLlmCall, "owner" | "id" | "role" | "preparedCall" | "dispatch">,
  right: Pick<StoredLlmCall, "owner" | "id" | "role" | "preparedCall" | "dispatch">,
): boolean {
  return (
    left.id === right.id &&
    left.role === right.role &&
    canonicalJsonEquals(left.owner, right.owner) &&
    canonicalJsonEquals(left.preparedCall, right.preparedCall) &&
    canonicalJsonEquals(left.dispatch, right.dispatch)
  );
}

function failure(
  status: RepositoryFailure["status"],
  code: LlmCallRepositoryDiagnosticCode,
  message: string,
): RepositoryFailure {
  return freezeDetached({ status, diagnostics: [{ code, message }] });
}

function storageFailure(error: unknown, message: string): RepositoryFailure {
  return error instanceof ProofStoreTransactionError && error.outcome === "commit-unknown"
    ? failure("uncertain", "commit-unknown", message)
    : failure("rejected", "storage-failure", message);
}

function safeParse<Output>(schema: z.ZodType<Output>, input: unknown): Output | undefined {
  try {
    if (!isPlainData(input)) return undefined;
    const result = schema.safeParse(structuredClone(input));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function isPlainData(value: unknown, ancestors: ReadonlySet<object> = new Set()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  const next = new Set(ancestors).add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) return false;
    return keys.every((key) => {
      if (key === "length") return true;
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        return false;
      }
      const descriptor = descriptors[key];
      return (
        descriptor !== undefined &&
        descriptor.enumerable &&
        "value" in descriptor &&
        isPlainData(descriptor.value, next)
      );
    });
  }
  return keys.every((key) => {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    return (
      descriptor !== undefined &&
      descriptor.enumerable &&
      "value" in descriptor &&
      isPlainData(descriptor.value, next)
    );
  });
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
