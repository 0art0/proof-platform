/**
 * Guards and detaching copies for the fields of a kernel operation. A guard (`isXxx`) reports
 * whether an untrusted value has the field's strict shape without invoking accessors; the copy
 * (`copyXxx`) of a guarded value is a detached, dense snapshot.
 */
import {
  declarationIdSchema,
  plainMathJsonSchema,
  statementIdSchema,
  type DeclarationId,
  type PlainMathJson,
  type StatementId,
} from "@proof/mathjson-model";
import type { ResultInstantiation } from "./results";
import { denseArrayValues, isStrictRecord } from "./runtime";

export function copyPlainMathJson(value: unknown): PlainMathJson {
  const parsed = plainMathJsonSchema.parse(value);
  return structuredClone(parsed);
}

export function copyOperandPath(value: unknown): readonly number[] {
  if (!Array.isArray(value)) throw new Error("Expected a validated operand path.");
  return Array.from({ length: value.length }, (_unused, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("Expected a dense operand path.");
    }
    return descriptor.value as number;
  });
}

export function isOperandPath(value: unknown): value is readonly number[] {
  if (!Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !Number.isInteger(Number(key))) ||
        (key !== "length" && (Number(key) < 0 || Number(key) >= value.length)),
    )
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "number" ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0
    ) {
      return false;
    }
  }
  return true;
}

export function optionalStatementId(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, StatementId>> {
  return value[key] === undefined ? {} : { [key]: statementIdSchema.parse(value[key]) };
}

export function optionalDeclarationId(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, DeclarationId>> {
  return value[key] === undefined ? {} : { [key]: declarationIdSchema.parse(value[key]) };
}

export function copyStatementIds(value: unknown): readonly StatementId[] {
  if (!Array.isArray(value)) throw new Error("Expected a validated statement-ID array.");
  return Array.from({ length: value.length }, (_unused, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("Expected a dense statement-ID array.");
    }
    return statementIdSchema.parse(descriptor.value);
  });
}

export function copyStatementIdPair(value: unknown): readonly [StatementId, StatementId] {
  const ids = copyStatementIds(value);
  if (ids.length !== 2) throw new Error("Expected exactly two validated statement IDs.");
  return [ids[0] as StatementId, ids[1] as StatementId];
}

export function isInstantiation(value: unknown): value is ResultInstantiation {
  return (
    isStrictRecord(value) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && key.length > 0) &&
    Object.values(value).every((term) => plainMathJsonSchema.safeParse(term).success)
  );
}

export function copyInstantiation(value: unknown): ResultInstantiation {
  if (!isStrictRecord(value)) throw new Error("Expected a validated instantiation.");
  return Object.fromEntries(
    Object.entries(value).map(([symbol, term]) => [symbol, copyPlainMathJson(term)]),
  );
}

export function isOptionalStatementIdArray(
  value: unknown,
): value is readonly (StatementId | null)[] {
  const entries = denseArrayValues(value);
  return (
    entries !== undefined &&
    entries.every((entry) => entry === null || statementIdSchema.safeParse(entry).success)
  );
}

export function copyOptionalStatementIds(value: unknown): readonly (StatementId | null)[] {
  const entries = denseArrayValues(value);
  if (entries === undefined) throw new Error("Expected a validated premise hypothesis list.");
  return entries.map((entry) => (entry === null ? null : statementIdSchema.parse(entry)));
}

export function isStatementIdArray(
  value: unknown,
  minimumLength = 2,
): value is readonly StatementId[] {
  if (!Array.isArray(value) || value.length < minimumLength) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !Number.isInteger(Number(key))) ||
        (key !== "length" && (Number(key) < 0 || Number(key) >= value.length)),
    )
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return false;
    if (!statementIdSchema.safeParse(descriptor.value).success) return false;
  }
  return true;
}
