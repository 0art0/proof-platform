/**
 * A session's constants (`docs/ai-agents-architecture.md` section 2).
 *
 * - **Setup operators**: the selected packs' operators, the accepted background's constants, and
 *   any library constant the problem statement itself uses. They are stored on the session.
 * - **Library constants**: operator declarations that library results of the session need and the
 *   effective operators do not declare. A result carries them (`LibraryResult.operators`); the
 *   session's catalog (`DefinitionCatalog.libraryConstants`) collects them. They are *available*:
 *   retrievable and previewable, but not part of any state and not parseable in notation.
 * - **Activated constants**: library constants that a committed step activated. The command
 *   service appends a `ConstantActivation` record in the step's own transaction, before it stores
 *   the step.
 * - **Effective operators**: setup operators followed by the activated constants, in activation
 *   order. Everything that parses, validates or executes (nodes, previews, the kernel, parsing,
 *   the move executor's context, export) uses them.
 *
 * Everything here is pure. Reading and writing the records belongs to the repository.
 */
import { mergeLibraryOperators, type LibraryResult } from "@proof/library";
import type { OperatorDeclaration } from "@proof/mathjson-model";
import type { DefinitionCatalog } from "./approved-catalog";

/** The library constants that results declare, deduplicated by symbol in first-seen order. */
export function libraryConstantsOf(
  results: readonly Pick<LibraryResult, "operators">[],
): readonly OperatorDeclaration[] {
  const bySymbol = new Map<string, OperatorDeclaration>();
  for (const result of results) {
    for (const operator of result.operators ?? []) {
      if (!bySymbol.has(operator.symbol)) bySymbol.set(operator.symbol, operator);
    }
  }
  return [...bySymbol.values()];
}

/**
 * The operators extended by `extra`: declarations whose symbol is already an operator are
 * skipped (a repeat is a reference; a different declaration of the symbol is a clash that
 * admission refused, and is left out here too), and one that would clash on identifier or LaTeX
 * trigger is left out. Returns the operators themselves when nothing is added.
 */
export function extendOperators(
  operators: readonly OperatorDeclaration[],
  extra: readonly OperatorDeclaration[],
): readonly OperatorDeclaration[] {
  let current = operators;
  for (const declaration of extra) {
    if (current.some(({ symbol }) => symbol === declaration.symbol)) continue;
    const merged = mergeLibraryOperators([current, [declaration]]);
    if (merged.ok) current = merged.operators;
  }
  return current;
}

/** The operators plus the session library's constants: what retrieval and previews work in. */
export function catalogOperators(
  operators: readonly OperatorDeclaration[],
  definitions: Pick<DefinitionCatalog, "libraryConstants">,
): readonly OperatorDeclaration[] {
  return extendOperators(operators, definitions.libraryConstants ?? []);
}

/** The session library's constants that the operators do not declare: the available ones. */
export function availableConstants(
  operators: readonly OperatorDeclaration[],
  definitions: Pick<DefinitionCatalog, "libraryConstants">,
): readonly OperatorDeclaration[] {
  const declared = new Set(operators.map(({ symbol }) => symbol));
  const wide = catalogOperators(operators, definitions);
  return wide.filter(({ symbol }) => !declared.has(symbol));
}

/**
 * The library constants the given library results need that the operators do not declare, in
 * order. A result unknown to the catalog needs none: applying it fails in the kernel, not here.
 */
export function missingConstants(
  definitions: DefinitionCatalog,
  operators: readonly OperatorDeclaration[],
  resultIds: readonly string[],
): readonly OperatorDeclaration[] {
  if (resultIds.length === 0 || (definitions.libraryConstants ?? []).length === 0) return [];
  const wide = catalogOperators(operators, definitions);
  const catalog = definitions.catalog(wide).results;
  const declared = new Set(operators.map(({ symbol }) => symbol));
  const needed = new Map<string, OperatorDeclaration>();
  for (const id of resultIds) {
    const result = catalog.find((candidate) => candidate.id === id);
    for (const operator of result?.operators ?? []) {
      if (!declared.has(operator.symbol) && !needed.has(operator.symbol)) {
        needed.set(operator.symbol, operator);
      }
    }
  }
  return [...needed.values()];
}

/** What applying one operation adds to the constants: the result it uses and its new constants. */
export type StepConstants = Readonly<{
  resultId: string;
  constants: readonly OperatorDeclaration[];
}>;

/**
 * The library constants a kernel operation would activate in the given operators: those of the
 * library result it applies (a result application, or a rewrite using a result) that the
 * operators do not declare. `undefined` when the step needs none. The operation is untrusted
 * input; anything that is not a result application needs no constant.
 */
export function stepConstants(
  definitions: DefinitionCatalog,
  operators: readonly OperatorDeclaration[],
  operation: unknown,
): StepConstants | undefined {
  const resultIds = untrustedResultIds(operation);
  for (const resultId of resultIds) {
    const constants = missingConstants(definitions, operators, [resultId]);
    if (constants.length > 0) return { resultId, constants };
  }
  return undefined;
}

/**
 * The library constants a sequence of raw operations would activate, step by step: each step is
 * judged in the operators the earlier steps' constants extended. `operators` are the operators
 * after the whole sequence; `perStep[i]` is what step `i` itself activates.
 */
export function sequenceConstants(
  definitions: DefinitionCatalog,
  operators: readonly OperatorDeclaration[],
  operations: readonly unknown[],
): Readonly<{
  perStep: readonly (StepConstants | undefined)[];
  /** The operators in force when step `i` runs (those before it, plus its own constants). */
  stepOperators: readonly (readonly OperatorDeclaration[])[];
  operators: readonly OperatorDeclaration[];
  constants: readonly OperatorDeclaration[];
}> {
  let current = operators;
  const perStep: (StepConstants | undefined)[] = [];
  const stepOperators: (readonly OperatorDeclaration[])[] = [];
  const constants: OperatorDeclaration[] = [];
  for (const operation of operations) {
    const step = stepConstants(definitions, current, operation);
    if (step !== undefined) {
      current = extendOperators(current, step.constants);
      constants.push(...step.constants);
    }
    perStep.push(step);
    stepOperators.push(current);
  }
  return { perStep, stepOperators, operators: current, constants };
}

/** The result IDs of an unvalidated operation value; none when it is not a result application. */
export function untrustedResultIds(operation: unknown): readonly string[] {
  if (typeof operation !== "object" || operation === null) return [];
  const record = operation as Readonly<Record<string, unknown>>;
  const source = record["source"];
  if (
    (record["kind"] === "rewrite-with-equivalence" ||
      record["kind"] === "rewrite-with-implication") &&
    typeof source === "object" &&
    source !== null &&
    (source as Readonly<Record<string, unknown>>)["kind"] === "result" &&
    typeof (source as Readonly<Record<string, unknown>>)["resultId"] === "string"
  ) {
    return [(source as { resultId: string }).resultId];
  }
  if (
    (record["kind"] === "apply-result-backward" || record["kind"] === "apply-result-forward") &&
    typeof record["resultId"] === "string"
  ) {
    return [record["resultId"]];
  }
  return [];
}
