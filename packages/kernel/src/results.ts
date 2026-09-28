import {
  createStatementViewSchema,
  declarationIdSchema,
  declarationsSchema,
  freeSymbolNames,
  freshSymbolName,
  mathJsonEquals,
  operatorDeclarationsSchema,
  plainMathJsonSchema,
  sortSchema,
  stableIdentifierSchema,
  substituteMathJson,
  type ContextualSequent,
  type Declaration,
  type OperatorDeclaration,
  type PlainMathJson,
  type Sort,
  type StatementView,
} from "@proof/mathjson-model";
import { alphaEquivalentWithOperators, sameNodeMetadata } from "./alpha-equivalence";
import { binderFor, boundDeclaration, functionParts, symbolValue } from "./expression";
import { denseArrayValues, hasExactKeys, isStrictRecord } from "./runtime";

/**
 * Identifier of an applicable result in the kernel environment. Library
 * artifact IDs (for example `result:modus-ponens`) are valid kernel result IDs;
 * the kernel never dereferences them outside its own catalog.
 */
export const kernelResultIdSchema = stableIdentifierSchema.brand("KernelResultId");
export type KernelResultId = ReturnType<typeof kernelResultIdSchema.parse>;

export const RESULT_APPLICATION_DIRECTIONS = ["forward", "backward"] as const;
export type ResultApplicationDirection = (typeof RESULT_APPLICATION_DIRECTIONS)[number];

/** A universally quantified pattern variable of a result. */
export type KernelResultParameter = Readonly<{ symbol: string; sort: Sort }>;

/**
 * The kernel's minimal structural description of an approved result:
 * `∀ parameters. premises ⇒ conclusion`. The kernel does not depend on the
 * library package; callers adapt library results into this shape.
 *
 * Premises and the conclusion are propositions whose free symbols are
 * parameters. Because an untyped built-in binder (`["ForAll", "x", body]`)
 * takes its bound symbol's sort from the declarations in scope, such a bound
 * symbol must also be listed as a parameter; it never occurs free, so it needs
 * no instantiation. Typed binders (`["ForAll", ["Element", "x", S], body]`)
 * are self-contained and need no such parameter.
 */
export type KernelResult = Readonly<{
  id: KernelResultId;
  parameters: readonly KernelResultParameter[];
  premises: readonly StatementView[];
  conclusion: StatementView;
  directions: readonly ResultApplicationDirection[];
}>;

/** Terms for the result's free parameters, keyed by parameter symbol. */
export type ResultInstantiation = Readonly<Record<string, PlainMathJson>>;

export type ResultCatalogIssue = Readonly<{ message: string; path: readonly PropertyKey[] }>;

export type ResultCatalogParseResult =
  | Readonly<{ ok: true; results: readonly KernelResult[] }>
  | Readonly<{ ok: false; issue: ResultCatalogIssue }>;

const RESULT_KEYS = ["id", "parameters", "premises", "conclusion", "directions"] as const;

/**
 * Validate a result catalog against an already validated operator environment
 * and return a detached copy. IDs must be unique; parameter symbols must be
 * unique, non-reserved, and distinct from operators; premises and the
 * conclusion must be propositions over the parameters; directions must be a
 * non-empty set of `forward`/`backward`.
 */
export function parseKernelResultCatalog(
  value: unknown,
  operators: readonly OperatorDeclaration[],
): ResultCatalogParseResult {
  try {
    const entries = denseArrayValues(value);
    if (entries === undefined) return catalogIssue("The result catalog must be a dense array.", []);
    const ids = new Set<string>();
    const results: KernelResult[] = [];
    for (const [index, entry] of entries.entries()) {
      const parsed = parseKernelResult(entry, operators);
      if (!parsed.ok) {
        return catalogIssue(parsed.issue.message, [index, ...parsed.issue.path]);
      }
      if (ids.has(parsed.result.id)) {
        return catalogIssue(`The result ID ${parsed.result.id} is not unique.`, [index, "id"]);
      }
      ids.add(parsed.result.id);
      results.push(parsed.result);
    }
    return { ok: true, results };
  } catch {
    return catalogIssue("The result catalog could not be inspected safely.", []);
  }
}

type ResultParse =
  Readonly<{ ok: true; result: KernelResult }> | Readonly<{ ok: false; issue: ResultCatalogIssue }>;

function parseKernelResult(value: unknown, operators: readonly OperatorDeclaration[]): ResultParse {
  if (!isStrictRecord(value) || !hasExactKeys(value, RESULT_KEYS)) {
    return resultIssue(
      "A kernel result must contain exactly id, parameters, premises, conclusion, and directions.",
      [],
    );
  }
  const id = kernelResultIdSchema.safeParse(value.id);
  if (!id.success) return resultIssue("The result ID is invalid.", ["id"]);

  const parameterEntries = denseArrayValues(value.parameters);
  if (parameterEntries === undefined) {
    return resultIssue("Result parameters must be a dense array.", ["parameters"]);
  }
  const operatorSymbols = new Set(operators.map((operator) => operator.symbol));
  const parameters: KernelResultParameter[] = [];
  for (const [index, entry] of parameterEntries.entries()) {
    if (!isStrictRecord(entry) || !hasExactKeys(entry, ["symbol", "sort"])) {
      return resultIssue("A result parameter must contain exactly symbol and sort.", [
        "parameters",
        index,
      ]);
    }
    const sort = sortSchema.safeParse(entry.sort);
    if (typeof entry.symbol !== "string" || !sort.success) {
      return resultIssue("A result parameter requires a symbol and a valid sort.", [
        "parameters",
        index,
      ]);
    }
    if (operatorSymbols.has(entry.symbol)) {
      return resultIssue("A result parameter cannot reuse an operator symbol.", [
        "parameters",
        index,
        "symbol",
      ]);
    }
    parameters.push({ symbol: entry.symbol, sort: sort.data });
  }
  const declarations = parameterDeclarations(parameters);
  if (declarations === undefined) {
    return resultIssue("Result parameter symbols must be unique and non-reserved.", ["parameters"]);
  }

  const statementSchema = createStatementViewSchema({ declarations, operators });
  const premiseEntries = denseArrayValues(value.premises);
  if (premiseEntries === undefined) {
    return resultIssue("Result premises must be a dense array.", ["premises"]);
  }
  const premises: StatementView[] = [];
  for (const [index, entry] of premiseEntries.entries()) {
    const premise = statementSchema.safeParse(entry);
    if (!premise.success) {
      return resultIssue("A result premise must be a proposition over the parameters.", [
        "premises",
        index,
      ]);
    }
    premises.push(premise.data);
  }
  const conclusion = statementSchema.safeParse(value.conclusion);
  if (!conclusion.success) {
    return resultIssue("The result conclusion must be a proposition over the parameters.", [
      "conclusion",
    ]);
  }

  const directionEntries = denseArrayValues(value.directions);
  if (
    directionEntries === undefined ||
    directionEntries.length === 0 ||
    new Set(directionEntries).size !== directionEntries.length ||
    directionEntries.some(
      (direction) => !(RESULT_APPLICATION_DIRECTIONS as readonly unknown[]).includes(direction),
    )
  ) {
    return resultIssue("Result directions must be a non-empty set of forward and backward.", [
      "directions",
    ]);
  }

  return {
    ok: true,
    result: structuredClone({
      id: id.data,
      parameters,
      premises,
      conclusion: conclusion.data,
      directions: directionEntries as ResultApplicationDirection[],
    }),
  };
}

function parameterDeclarations(
  parameters: readonly KernelResultParameter[],
): readonly Declaration[] | undefined {
  const parsed = declarationsSchema.safeParse(
    parameters.map((parameter, index) => ({
      id: `declaration:result-parameter-${index}`,
      symbol: parameter.symbol,
      sort: parameter.sort,
      role: "universal-parameter",
    })),
  );
  return parsed.success ? parsed.data : undefined;
}

/** Parameters that occur free in the conclusion or a premise, in declaration order. */
export function freeResultParameters(
  result: KernelResult,
  operators: readonly OperatorDeclaration[],
): readonly KernelResultParameter[] {
  const free = new Set<string>();
  [result.conclusion, ...result.premises].forEach((statement) =>
    freeSymbolNames(statement.expression, { operators }).forEach((symbol) => free.add(symbol)),
  );
  return result.parameters.filter((parameter) => free.has(parameter.symbol));
}

export type ResultInstanceFailureCode =
  | "result-not-found"
  | "direction-not-permitted"
  | "missing-instantiation"
  | "invalid-instantiation"
  | "replacement-failed";

export type ResultInstance =
  | Readonly<{
      ok: true;
      premises: readonly PlainMathJson[];
      conclusion: PlainMathJson;
    }>
  | Readonly<{ ok: false; code: ResultInstanceFailureCode; message: string }>;

/**
 * Kernel-internal: find a result, check its direction, check that the
 * instantiation covers exactly its free parameters with terms that are
 * well-sorted and in scope in the target's local context, and instantiate its
 * premises and conclusion with one simultaneous capture-avoiding substitution.
 */
export function instantiateResultInContext(
  results: readonly KernelResult[],
  resultId: KernelResultId,
  direction: ResultApplicationDirection,
  instantiation: ResultInstantiation,
  sequent: ContextualSequent,
  operators: readonly OperatorDeclaration[],
): ResultInstance {
  const result = results.find((candidate) => candidate.id === resultId);
  if (result === undefined) {
    return instanceFailure("result-not-found", `No result ${resultId} is in the environment.`);
  }
  if (!result.directions.includes(direction)) {
    return instanceFailure(
      "direction-not-permitted",
      `The result ${resultId} is not approved for ${direction} application.`,
    );
  }

  const required = freeResultParameters(result, operators);
  const requiredSymbols = new Set(required.map((parameter) => parameter.symbol));
  const missing = required.find((parameter) => !Object.hasOwn(instantiation, parameter.symbol));
  if (missing !== undefined) {
    return instanceFailure(
      "missing-instantiation",
      `The instantiation does not supply a term for parameter ${missing.symbol}.`,
    );
  }
  const unknown = Object.keys(instantiation).find((symbol) => !requiredSymbols.has(symbol));
  if (unknown !== undefined) {
    return instanceFailure(
      "invalid-instantiation",
      `The instantiation names ${unknown}, which is not a free parameter of the result.`,
    );
  }

  const substitutions = required.map((parameter) => ({
    symbol: parameter.symbol,
    replacement: instantiation[parameter.symbol] as PlainMathJson,
  }));
  for (const [index, parameter] of required.entries()) {
    const term = substitutions[index]?.replacement as PlainMathJson;
    if (!termHasSortInContext(term, parameter.sort, sequent.context.declarations, operators)) {
      return instanceFailure(
        "invalid-instantiation",
        `The term for parameter ${parameter.symbol} is not well-sorted and in scope in the target's local context.`,
      );
    }
  }

  const instantiate = (expression: PlainMathJson): PlainMathJson | undefined => {
    const substituted = substituteMathJson(expression, substitutions, { operators });
    return substituted.ok ? structuredClone(substituted.expression) : undefined;
  };
  const conclusion = instantiate(result.conclusion.expression);
  const premises = result.premises.map((premise) => instantiate(premise.expression));
  if (conclusion === undefined || premises.some((premise) => premise === undefined)) {
    return instanceFailure(
      "replacement-failed",
      "The capture-avoiding instantiation of the result could not be constructed.",
    );
  }
  return { ok: true, premises: premises as PlainMathJson[], conclusion };
}

/**
 * Decide whether a term has the expected sort using only the local
 * declarations and operators. A fresh predicate symbol of sort
 * `(expected) -> proposition` is declared, and its application to the term is
 * checked as a proposition, so every free symbol of the term must be declared.
 */
export function termHasSortInContext(
  term: PlainMathJson,
  expected: Sort,
  declarations: readonly Declaration[],
  operators: readonly OperatorDeclaration[],
): boolean {
  const usedSymbols = new Set<string>([
    ...declarations.map((declaration) => declaration.symbol),
    ...operators.map((operator) => operator.symbol),
  ]);
  collectSymbolNames(term, usedSymbols);
  const usedIds = new Set<string>(declarations.map((declaration) => declaration.id));
  let probeId = "declaration:kernel-sort-probe";
  for (let suffix = 1; usedIds.has(probeId); suffix += 1) {
    probeId = `declaration:kernel-sort-probe-${suffix}`;
  }
  const probe = freshSymbolName("SortProbe", usedSymbols);
  try {
    return createStatementViewSchema({
      declarations: [
        ...declarations,
        {
          id: declarationIdSchema.parse(probeId),
          symbol: probe,
          sort: {
            kind: "function",
            signature: { parameters: [expected], result: { kind: "proposition" } },
          },
          role: "universal-parameter",
        },
      ],
      operators,
    }).safeParse({ expression: [probe, term] }).success;
  } catch {
    return false;
  }
}

export function collectSymbolNames(expression: PlainMathJson, names: Set<string>): void {
  const symbol = symbolValue(expression);
  if (symbol !== undefined) {
    names.add(symbol);
    return;
  }
  const parts = functionParts(expression);
  if (parts === undefined) return;
  names.add(parts.operator);
  parts.operands.forEach((operand) => collectSymbolNames(operand, names));
}

export type ResultMatchDiagnostic = Readonly<{
  code: "invalid-environment" | "invalid-result" | "invalid-proposition" | "conclusion-mismatch";
  message: string;
}>;

export type ResultMatch =
  | Readonly<{
      ok: true;
      /** Terms for every free parameter that the conclusion determines. */
      instantiation: ResultInstantiation;
      /** Free parameters that occur only in premises; the caller must choose them. */
      unboundParameters: readonly string[];
      diagnostics: readonly [];
    }>
  | Readonly<{ ok: false; diagnostics: readonly [ResultMatchDiagnostic] }>;

/**
 * Compute an instantiation by first-order matching of the result conclusion
 * against a statement. Free parameters are pattern variables; symbols bound
 * inside the conclusion match bound symbols of the statement up to renaming,
 * and a parameter never matches a term that mentions a symbol bound inside
 * the statement. A parameter in function position matches a non-binding head
 * symbol. Sorts and scope are not checked here; the kernel checks them when
 * the result is applied. The output is detached and frozen.
 */
export function matchResultConclusion(
  resultInput: unknown,
  statementInput: unknown,
  environment: Readonly<{ operators?: readonly OperatorDeclaration[] }> = {},
): ResultMatch {
  try {
    const operators = operatorDeclarationsSchema.safeParse(environment.operators ?? []);
    if (!operators.success) {
      return matchFailure("invalid-environment", "The operator environment is invalid.");
    }
    const parsed = parseKernelResult(resultInput, operators.data);
    if (!parsed.ok) return matchFailure("invalid-result", parsed.issue.message);
    if (
      !isStrictRecord(statementInput) ||
      !hasExactKeys(statementInput, ["expression"]) ||
      !plainMathJsonSchema.safeParse(statementInput.expression).success
    ) {
      return matchFailure("invalid-proposition", "The statement must be a plain MathJSON view.");
    }
    const subject = structuredClone(statementInput.expression as PlainMathJson);
    const required = freeResultParameters(parsed.result, operators.data);
    const bindings = new Map<string, PlainMathJson>();
    const matched = matchPattern(
      parsed.result.conclusion.expression,
      subject,
      new Map(),
      new Map(),
      0,
      new Set(required.map((parameter) => parameter.symbol)),
      bindings,
      operators.data,
    );
    if (!matched) {
      return matchFailure(
        "conclusion-mismatch",
        "The statement is not an instance of the result conclusion.",
      );
    }
    return deepFreeze({
      ok: true,
      instantiation: Object.fromEntries(
        required
          .filter((parameter) => bindings.has(parameter.symbol))
          .map((parameter) => [parameter.symbol, bindings.get(parameter.symbol) as PlainMathJson]),
      ),
      unboundParameters: required
        .filter((parameter) => !bindings.has(parameter.symbol))
        .map((parameter) => parameter.symbol),
      diagnostics: [] as const,
    });
  } catch {
    return matchFailure("invalid-result", "The match inputs could not be inspected safely.");
  }
}

/**
 * First-order matching of an arbitrary expression (term or proposition) against a subject, with
 * the same rules as `matchResultConclusion`: the free occurrences of `parameters` in `pattern` are
 * pattern variables, bound symbols match up to renaming, and a variable never captures a symbol
 * bound inside the subject. Returns the bindings of the variables that occur, or undefined when
 * the subject is not an instance. Sorts are not checked.
 */
export function matchExpressionPattern(
  pattern: PlainMathJson,
  subject: PlainMathJson,
  parameters: readonly string[],
  environment: Readonly<{ operators?: readonly OperatorDeclaration[] }> = {},
): ResultInstantiation | undefined {
  try {
    const operators = operatorDeclarationsSchema.safeParse(environment.operators ?? []);
    if (
      !operators.success ||
      !plainMathJsonSchema.safeParse(pattern).success ||
      !plainMathJsonSchema.safeParse(subject).success
    ) {
      return undefined;
    }
    const bindings = new Map<string, PlainMathJson>();
    const matched = matchPattern(
      pattern,
      subject,
      new Map(),
      new Map(),
      0,
      new Set(parameters),
      bindings,
      operators.data,
    );
    return matched ? deepFreeze(Object.fromEntries(bindings)) : undefined;
  } catch {
    return undefined;
  }
}

/** Bound symbols map to the binder depth that introduced them. */
type Scope = ReadonlyMap<string, number>;

function matchPattern(
  pattern: PlainMathJson,
  subject: PlainMathJson,
  patternScope: Scope,
  subjectScope: Scope,
  depth: number,
  parameters: ReadonlySet<string>,
  bindings: Map<string, PlainMathJson>,
  operators: readonly OperatorDeclaration[],
): boolean {
  const patternSymbol = symbolValue(pattern);
  if (patternSymbol !== undefined) {
    if (!patternScope.has(patternSymbol) && parameters.has(patternSymbol)) {
      return bindParameter(patternSymbol, subject, subjectScope, bindings, operators);
    }
    const subjectSymbol = symbolValue(subject);
    return (
      subjectSymbol !== undefined &&
      sameReference(patternSymbol, subjectSymbol, patternScope, subjectScope) &&
      sameNodeMetadata(pattern, subject, "sym")
    );
  }

  const patternParts = functionParts(pattern);
  const subjectParts = functionParts(subject);
  if (patternParts === undefined || subjectParts === undefined) {
    return (
      patternParts === undefined && subjectParts === undefined && mathJsonEquals(pattern, subject)
    );
  }
  if (
    patternParts.operands.length !== subjectParts.operands.length ||
    !sameNodeMetadata(pattern, subject, "fn")
  ) {
    return false;
  }

  const headIsParameter =
    !patternScope.has(patternParts.operator) && parameters.has(patternParts.operator);
  if (headIsParameter) {
    if (
      subjectScope.has(subjectParts.operator) ||
      binderFor(subjectParts, operators) !== undefined ||
      !bindParameter(
        patternParts.operator,
        subjectParts.operator,
        subjectScope,
        bindings,
        operators,
      )
    ) {
      return false;
    }
  } else if (
    !sameReference(patternParts.operator, subjectParts.operator, patternScope, subjectScope)
  ) {
    return false;
  }

  const binder =
    headIsParameter || patternScope.has(patternParts.operator)
      ? undefined
      : binderFor(patternParts, operators);
  if (binder === undefined) {
    return patternParts.operands.every((operand, index) =>
      matchPattern(
        operand,
        subjectParts.operands[index] as PlainMathJson,
        patternScope,
        subjectScope,
        depth,
        parameters,
        bindings,
        operators,
      ),
    );
  }

  const patternInner = new Map(patternScope);
  const subjectInner = new Map(subjectScope);
  let innerDepth = depth;
  for (const index of binder.boundOperands) {
    const patternDeclaration = boundDeclaration(patternParts, binder, index);
    const subjectDeclaration = boundDeclaration(subjectParts, binder, index);
    if (
      patternDeclaration === undefined ||
      subjectDeclaration === undefined ||
      patternDeclaration.form !== subjectDeclaration.form ||
      !sameNodeMetadata(patternDeclaration.symbol, subjectDeclaration.symbol, "sym")
    ) {
      return false;
    }
    if (patternDeclaration.form !== "symbol") {
      // Typed domains and bounds are matched in the enclosing scope.
      const patternNode = patternParts.operands[index] as PlainMathJson;
      const subjectNode = subjectParts.operands[index] as PlainMathJson;
      const patternOperands = functionParts(patternNode)?.operands ?? [];
      const subjectOperands = functionParts(subjectNode)?.operands ?? [];
      if (
        !sameNodeMetadata(patternNode, subjectNode, "fn") ||
        !patternDeclaration.outerOperands.every((outer) =>
          matchPattern(
            patternOperands[outer] as PlainMathJson,
            subjectOperands[outer] as PlainMathJson,
            patternScope,
            subjectScope,
            depth,
            parameters,
            bindings,
            operators,
          ),
        )
      ) {
        return false;
      }
    }
    patternInner.set(patternDeclaration.name, innerDepth);
    subjectInner.set(subjectDeclaration.name, innerDepth);
    innerDepth += 1;
  }
  const boundOperands = new Set(binder.boundOperands);
  const scopedOperands = new Set(binder.scopedOperands);
  return patternParts.operands.every((operand, index) => {
    if (boundOperands.has(index)) return true;
    const scoped = scopedOperands.has(index);
    return matchPattern(
      operand,
      subjectParts.operands[index] as PlainMathJson,
      scoped ? patternInner : patternScope,
      scoped ? subjectInner : subjectScope,
      scoped ? innerDepth : depth,
      parameters,
      bindings,
      operators,
    );
  });
}

function bindParameter(
  symbol: string,
  term: PlainMathJson,
  subjectScope: Scope,
  bindings: Map<string, PlainMathJson>,
  operators: readonly OperatorDeclaration[],
): boolean {
  if (freeSymbolNames(term, { operators }).some((name) => subjectScope.has(name))) return false;
  const existing = bindings.get(symbol);
  if (existing !== undefined) return alphaEquivalentWithOperators(existing, term, operators);
  bindings.set(symbol, structuredClone(term));
  return true;
}

function sameReference(
  pattern: string,
  subject: string,
  patternScope: Scope,
  subjectScope: Scope,
): boolean {
  const patternLevel = patternScope.get(pattern);
  const subjectLevel = subjectScope.get(subject);
  if (patternLevel !== undefined || subjectLevel !== undefined) {
    return patternLevel === subjectLevel;
  }
  return pattern === subject;
}

function catalogIssue(
  message: string,
  path: readonly PropertyKey[],
): Extract<ResultCatalogParseResult, { ok: false }> {
  return { ok: false, issue: { message, path } };
}

function resultIssue(message: string, path: readonly PropertyKey[]): ResultParse {
  return { ok: false, issue: { message, path } };
}

function instanceFailure(
  code: ResultInstanceFailureCode,
  message: string,
): Extract<ResultInstance, { ok: false }> {
  return { ok: false, code, message };
}

function matchFailure(code: ResultMatchDiagnostic["code"], message: string): ResultMatch {
  return { ok: false, diagnostics: [{ code, message }] };
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
