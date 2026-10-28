// Failure results and the parsing, freezing and comparison helpers shared by every repository
// module.

import type { z } from "zod";
import { ProofStoreTransactionError, ReadOnlySessionError } from "./proof-repository-store";

export class SerializedStaleCommandError extends Error {
  constructor() {
    super("The locked session pointer changed before it could be advanced.");
    this.name = "SerializedStaleCommandError";
  }
}

export type RepositoryDiagnosticCode =
  | "invalid-initial-session"
  | "session-not-found"
  | "invalid-session-record"
  | "current-node-not-found"
  | "invalid-current-node"
  | "invalid-command-record"
  | "invalid-suggestion-set-record"
  | "suggestion-set-not-found"
  | "suggestion-set-rejected"
  | "invalid-preview-record"
  | "preview-not-found"
  | "preview-rejected"
  | "macro-step-failed"
  | "plan-step-failed"
  | "invalid-edge-record"
  | "invalid-proof-history"
  | "backtrack-rejected"
  | "serialized-stale-backtrack"
  | "command-rejected"
  | "command-deleted"
  | "delete-rejected"
  | "delete-requires-confirmation"
  | "invalid-deletion-record"
  | "serialized-stale-delete"
  | "serialized-stale-command"
  | "backtrack-with-information-rejected"
  | "backtrack-symbols-unavailable"
  | "backtrack-with-information-conflict"
  | "interaction-event-rejected"
  | "interaction-event-conflict"
  | "invalid-interaction-event-record"
  | "replay-rejected"
  | "replay-conflict"
  | "invalid-replay-record"
  | "inquiry-command-rejected"
  | "inquiry-command-conflict"
  | "invalid-inquiry-record"
  | "session-read-only"
  | "storage-failure"
  | "commit-unknown";

export type RepositoryDiagnostic = Readonly<{
  code: RepositoryDiagnosticCode;
  message: string;
}>;

export type RepositoryFailure = Readonly<{
  status: "rejected" | "uncertain";
  diagnostics: readonly [RepositoryDiagnostic];
}>;

export function transactionFailure(error: unknown, fallbackMessage: string): RepositoryFailure {
  const readOnly =
    error instanceof ReadOnlySessionError
      ? error
      : error instanceof ProofStoreTransactionError && error.cause instanceof ReadOnlySessionError
        ? error.cause
        : undefined;
  if (readOnly !== undefined) {
    return repositoryFailure("rejected", "session-read-only", readOnly.message);
  }
  // Stores wrap callback failures in a rolled-back error; the stale-pointer cause stays meaningful.
  const staleCause =
    error instanceof ProofStoreTransactionError &&
    error.outcome === "rolled-back" &&
    error.cause instanceof SerializedStaleCommandError
      ? error.cause
      : undefined;
  if (staleCause !== undefined) {
    return repositoryFailure("rejected", "serialized-stale-command", staleCause.message);
  }
  if (error instanceof SerializedStaleCommandError) {
    return repositoryFailure("rejected", "serialized-stale-command", error.message);
  }
  if (error instanceof ProofStoreTransactionError && error.outcome === "commit-unknown") {
    return repositoryFailure("uncertain", "commit-unknown", error.message);
  }
  return repositoryFailure(
    "rejected",
    "storage-failure",
    error instanceof Error ? error.message : fallbackMessage,
  );
}

export function freezeDetached<Value>(value: Value): Value | undefined {
  try {
    return deepFreeze(structuredClone(value) as Value);
  } catch {
    return undefined;
  }
}

export function repositoryFailure<Status extends "rejected" | "uncertain">(
  status: Status,
  code: RepositoryDiagnosticCode,
  message: string,
): Readonly<{ status: Status; diagnostics: readonly [RepositoryDiagnostic] }> {
  return { status, diagnostics: [{ code, message }] };
}

export function safeParse<Output>(schema: z.ZodType<Output>, value: unknown): Output | undefined {
  try {
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function isDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.enumerable && "value" in descriptor,
  );
}

export function isStrictDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (!isDataRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => typeof key === "string" && expectedKeys.includes(key))
  );
}

export function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index]))
    );
  }
  if (!isDataRecord(left) || !isDataRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonEquals(left[key], right[key]))
  );
}

import { deepFreeze } from "@proof/mathjson-model";

export { deepFreeze };
