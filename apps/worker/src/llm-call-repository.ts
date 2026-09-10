import {
  llmCallEvidenceSchema,
  llmCallIdSchema,
  preparedLlmCallSchema,
  topicManifestProposalSchema,
  executePreparedLlmCall,
  type LlmCallId,
  type LlmTransport,
} from "@proof/llm";
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

const reviewBase = {
  id: stableStorageIdentifierSchema,
  owner: llmCallOwnerSchema,
  callId: llmCallIdSchema,
  reviewerId: stableStorageIdentifierSchema,
  decidedAt: z.string().datetime({ offset: true }),
  proposal: topicManifestProposalSchema,
  rationale: z.string().min(1).max(2_000),
};
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

export interface LlmCallStoreTransaction {
  readCallForUpdate(owner: LlmCallOwner, callId: LlmCallId): Promise<unknown | undefined>;
  insertCall(record: StoredLlmCall): Promise<void>;
  completeCall(record: StoredLlmCall): Promise<boolean>;
  readDecisionForUpdate(owner: LlmCallOwner, decisionId: string): Promise<unknown | undefined>;
  insertDecision(decision: TopicProposalDecision): Promise<void>;
}

export interface LlmCallStore {
  transaction<Result>(
    work: (transaction: LlmCallStoreTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export type LlmCallRepositoryDiagnosticCode =
  | "invalid-request"
  | "call-id-conflict"
  | "call-record-invalid"
  | "call-in-progress-or-uncertain"
  | "call-not-found"
  | "decision-id-conflict"
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
        return sameJson(current.evidence, evidence)
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
  const decision = safeParse(topicProposalDecisionSchema, input);
  if (decision === undefined) {
    return failure("rejected", "invalid-request", "The topic proposal decision is invalid.");
  }
  try {
    return await store.transaction(async (transaction) => {
      const existingInput = await transaction.readDecisionForUpdate(decision.owner, decision.id);
      let existing: TopicProposalDecision | undefined;
      if (existingInput !== undefined) {
        existing = safeParse(topicProposalDecisionSchema, existingInput);
        if (existing === undefined || !sameJson(existing, decision)) {
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
        call.role !== "topic-extractor" ||
        call.evidence.status !== "validated" ||
        call.evidence.output?.kind !== "topic-manifest" ||
        !sameJson(call.evidence.output, decision.proposal)
      ) {
        return failure(
          "rejected",
          "proposal-not-reviewable",
          "The decision must reference the exact validated topic proposal for this call.",
        );
      }
      if (existing !== undefined) return decisionResult(existing, true);
      await transaction.insertDecision(freezeDetached(decision));
      return decisionResult(decision, false);
    });
  } catch (error: unknown) {
    return storageFailure(error, "The topic proposal decision could not be recorded.");
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
  return record !== undefined && sameJson(record.owner, owner) && record.id === callId
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
    sameJson(left.owner, right.owner) &&
    sameJson(left.preparedCall, right.preparedCall) &&
    sameJson(left.dispatch, right.dispatch)
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

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
