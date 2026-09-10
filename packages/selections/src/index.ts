import {
  createProofStateSchema,
  mathJsonEquals,
  operatorDeclarationsSchema,
  proofStateIdSchema,
  retrievalWildcardSchema,
  stableIdentifierSchema,
  statementIdSchema,
  type Declaration,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofState,
  type ProofStateId,
  type ProofStateSchemaOptions,
  type RetrievalWildcard,
  type Sort,
  type StatementId,
} from "@proof/mathjson-model";

/** Zero-based operand indices. The operator stored at array index 0 is never part of a path. */
export type OperandPath = readonly number[];
export type DisplayRange = readonly [start: number, end: number];

export type ExactSelection = Readonly<{
  kind: "exact";
  path: OperandPath;
  fragment: PlainMathJson;
  displayRange?: DisplayRange | undefined;
}>;

export type AssociativeSelectionLens = Readonly<{
  kind: "associative";
  operator: AssociativeOperator;
  containerPath: OperandPath;
  container: PlainMathJson;
  startOperand: number;
  endOperand: number;
  coveredOperandPaths: readonly OperandPath[];
  fragment: PlainMathJson;
  displayRange?: DisplayRange | undefined;
}>;

export type FallbackSelection = Readonly<{
  kind: "fallback";
  path: OperandPath;
  fragment: PlainMathJson;
  requestedFragment: PlainMathJson;
  reason: string;
  displayRange?: DisplayRange | undefined;
}>;

export type ResolvedSelection = ExactSelection | AssociativeSelectionLens | FallbackSelection;

export type SelectionHint = Readonly<{
  /** Semantic paths found at the start and end of the MathLive range. */
  paths?: readonly OperandPath[];
  /** Used when equal expressions occur more than once and display metadata is unavailable. */
  occurrence?: number;
  displayRange?: DisplayRange | undefined;
}>;

export type SelectionDiagnostic = Readonly<{
  code: "invalid-path" | "invalid-associative-range" | "replacement-failed";
  message: string;
  path: OperandPath;
}>;

export type SelectionTransformResult =
  | Readonly<{
      ok: true;
      expression: PlainMathJson;
      diagnostics: readonly [];
    }>
  | Readonly<{
      ok: false;
      expression: PlainMathJson;
      diagnostics: readonly SelectionDiagnostic[];
    }>;

export const ASSOCIATIVE_OPERATORS = ["Add", "Multiply", "And", "Or"] as const;
export type AssociativeOperator = (typeof ASSOCIATIVE_OPERATORS)[number];

type FunctionParts = Readonly<{
  operator: string;
  operands: readonly PlainMathJson[];
  rebuild: (operands: readonly PlainMathJson[]) => PlainMathJson;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function functionParts(expression: PlainMathJson): FunctionParts | undefined {
  if (Array.isArray(expression)) {
    const operator = expression[0];
    if (typeof operator !== "string") return undefined;
    return {
      operator,
      operands: expression.slice(1) as readonly PlainMathJson[],
      rebuild: (operands) => [operator, ...operands],
    };
  }

  if (!isRecord(expression)) return undefined;
  const expressionRecord: Readonly<Record<string, unknown>> = expression;
  if (Array.isArray(expressionRecord.fn) && typeof expressionRecord.fn[0] === "string") {
    const operator = expressionRecord.fn[0];
    return {
      operator,
      operands: expressionRecord.fn.slice(1) as readonly PlainMathJson[],
      rebuild: (operands) => ({ ...expressionRecord, fn: [operator, ...operands] }),
    };
  }

  return undefined;
}

function isAssociativeOperator(operator: string): operator is AssociativeOperator {
  return (ASSOCIATIVE_OPERATORS as readonly string[]).includes(operator);
}

export function formatOperandPath(path: OperandPath): string {
  return path.length === 0 ? "root" : path.join(".");
}

export function operandPathEquals(left: OperandPath, right: OperandPath): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isOperandPathPrefix(prefix: OperandPath, path: OperandPath): boolean {
  return prefix.length <= path.length && prefix.every((value, index) => value === path[index]);
}

export function parentOperandPath(path: OperandPath): OperandPath | undefined {
  return path.length === 0 ? undefined : path.slice(0, -1);
}

export function expressionAtPath(
  expression: PlainMathJson,
  path: OperandPath,
): PlainMathJson | undefined {
  let current = expression;
  for (const operandIndex of path) {
    if (!Number.isInteger(operandIndex) || operandIndex < 0) return undefined;
    const parts = functionParts(current);
    const next = parts?.operands[operandIndex];
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

export function findExactPaths(
  expression: PlainMathJson,
  fragment: PlainMathJson,
): readonly OperandPath[] {
  const matches: OperandPath[] = [];

  walkExpressions(expression, [], (candidate, path) => {
    if (mathJsonEquals(candidate, fragment)) matches.push(path);
  });

  return matches;
}

export function listExpressionPaths(expression: PlainMathJson): readonly OperandPath[] {
  const paths: OperandPath[] = [];
  walkExpressions(expression, [], (_candidate, path) => paths.push(path));
  return paths;
}

function walkExpressions(
  expression: PlainMathJson,
  path: OperandPath,
  visit: (expression: PlainMathJson, path: OperandPath) => void,
): void {
  visit(expression, path);
  const parts = functionParts(expression);
  parts?.operands.forEach((operand, index) => walkExpressions(operand, [...path, index], visit));
}

export function replaceAtPath(
  expression: PlainMathJson,
  path: OperandPath,
  replacement: PlainMathJson,
): SelectionTransformResult {
  if (path.length === 0) return { ok: true, expression: replacement, diagnostics: [] };

  const [operandIndex, ...rest] = path;
  if (operandIndex === undefined || !Number.isInteger(operandIndex) || operandIndex < 0) {
    return invalidPath(expression, path);
  }

  const parts = functionParts(expression);
  const operand = parts?.operands[operandIndex];
  if (!parts || operand === undefined) return invalidPath(expression, path);

  const replaced = replaceAtPath(operand, rest, replacement);
  if (!replaced.ok) return invalidPath(expression, path);

  const operands = [...parts.operands];
  operands[operandIndex] = replaced.expression;
  return { ok: true, expression: parts.rebuild(operands), diagnostics: [] };
}

function invalidPath(expression: PlainMathJson, path: OperandPath): SelectionTransformResult {
  return {
    ok: false,
    expression,
    diagnostics: [
      {
        code: "invalid-path",
        message: `No MathJSON expression exists at operand path ${formatOperandPath(path)}.`,
        path,
      },
    ],
  };
}

export function createAssociativeSelection(
  expression: PlainMathJson,
  containerPath: OperandPath,
  startOperand: number,
  endOperand: number,
  displayRange?: DisplayRange,
): AssociativeSelectionLens | undefined {
  const container = expressionAtPath(expression, containerPath);
  if (container === undefined) return undefined;
  const parts = functionParts(container);
  if (
    !parts ||
    !isAssociativeOperator(parts.operator) ||
    !Number.isInteger(startOperand) ||
    !Number.isInteger(endOperand) ||
    startOperand < 0 ||
    endOperand > parts.operands.length ||
    endOperand - startOperand < 2
  ) {
    return undefined;
  }

  const selectedOperands = parts.operands.slice(startOperand, endOperand);
  return {
    kind: "associative",
    operator: parts.operator,
    containerPath,
    container,
    startOperand,
    endOperand,
    coveredOperandPaths: selectedOperands.map((_operand, index) => [
      ...containerPath,
      startOperand + index,
    ]),
    fragment: parts.rebuild(selectedOperands),
    ...(displayRange === undefined ? {} : { displayRange }),
  };
}

export function replaceSelection(
  expression: PlainMathJson,
  selection: ResolvedSelection,
  replacement: PlainMathJson,
): SelectionTransformResult {
  if (selection.kind !== "associative") {
    return replaceAtPath(expression, selection.path, replacement);
  }

  const container = expressionAtPath(expression, selection.containerPath);
  const parts = container === undefined ? undefined : functionParts(container);
  if (
    container === undefined ||
    !parts ||
    !mathJsonEquals(container, selection.container) ||
    parts.operator !== selection.operator ||
    selection.startOperand < 0 ||
    selection.endOperand > parts.operands.length ||
    selection.endOperand - selection.startOperand < 2
  ) {
    return {
      ok: false,
      expression,
      diagnostics: [
        {
          code: "invalid-associative-range",
          message: "The associative selection no longer matches its containing expression.",
          path: selection.containerPath,
        },
      ],
    };
  }

  const operands = [
    ...parts.operands.slice(0, selection.startOperand),
    replacement,
    ...parts.operands.slice(selection.endOperand),
  ];
  return replaceAtPath(expression, selection.containerPath, parts.rebuild(operands));
}

export function resolveSelection(
  expression: PlainMathJson,
  requestedFragment: PlainMathJson,
  hint: SelectionHint = {},
): ResolvedSelection {
  const exactPaths = findExactPaths(expression, requestedFragment);
  if (exactPaths.length > 0) {
    const path = choosePath(exactPaths, hint);
    return {
      kind: "exact",
      path,
      fragment: expressionAtPath(expression, path) ?? requestedFragment,
      ...(hint.displayRange === undefined ? {} : { displayRange: hint.displayRange }),
    };
  }

  const associative = findAssociativeSelections(expression, requestedFragment, hint.displayRange);
  if (associative.length > 0) return chooseLens(associative, hint);

  const fallbackPath = fallbackPathFor(expression, requestedFragment, hint.paths ?? []);
  return {
    kind: "fallback",
    path: fallbackPath,
    fragment: expressionAtPath(expression, fallbackPath) ?? expression,
    requestedFragment,
    reason:
      "The displayed range was not an exact subtree or a supported contiguous associative range, so it was snapped to the nearest subtree.",
    ...(hint.displayRange === undefined ? {} : { displayRange: hint.displayRange }),
  };
}

function choosePath(paths: readonly OperandPath[], hint: SelectionHint): OperandPath {
  const hintedPaths = hint.paths?.filter((path) => expressionPathIsUsable(path)) ?? [];
  if (hintedPaths.length > 0) {
    const scored = paths
      .map((candidate) => ({
        candidate,
        score: hintedPaths.filter(
          (path) => isOperandPathPrefix(candidate, path) || isOperandPathPrefix(path, candidate),
        ).length,
      }))
      .sort(
        (left, right) => right.score - left.score || right.candidate.length - left.candidate.length,
      );
    if (scored[0] && scored[0].score > 0) return scored[0].candidate;
  }

  const occurrence = hint.occurrence ?? 0;
  return paths[occurrence] ?? paths[0] ?? [];
}

function expressionPathIsUsable(path: OperandPath): boolean {
  return path.every((part) => Number.isInteger(part) && part >= 0);
}

function findAssociativeSelections(
  expression: PlainMathJson,
  fragment: PlainMathJson,
  displayRange?: DisplayRange,
): readonly AssociativeSelectionLens[] {
  const matches: AssociativeSelectionLens[] = [];

  walkExpressions(expression, [], (candidate, path) => {
    const parts = functionParts(candidate);
    if (!parts || !isAssociativeOperator(parts.operator)) return;

    for (let start = 0; start < parts.operands.length; start += 1) {
      for (let end = start + 2; end <= parts.operands.length; end += 1) {
        const lens = createAssociativeSelection(expression, path, start, end, displayRange);
        if (lens && mathJsonEquals(lens.fragment, fragment)) matches.push(lens);
      }
    }
  });

  return matches;
}

function chooseLens(
  lenses: readonly AssociativeSelectionLens[],
  hint: SelectionHint,
): AssociativeSelectionLens {
  const hintedPaths = hint.paths ?? [];
  const containingHints = lenses.filter((lens) =>
    hintedPaths.every((hintedPath) =>
      lens.coveredOperandPaths.some((covered) => isOperandPathPrefix(covered, hintedPath)),
    ),
  );
  const candidates = containingHints.length > 0 ? containingHints : lenses;
  const occurrence = hint.occurrence ?? 0;
  return candidates[occurrence] ?? candidates[0] ?? lenses[0]!;
}

function fallbackPathFor(
  expression: PlainMathJson,
  requestedFragment: PlainMathJson,
  hintedPaths: readonly OperandPath[],
): OperandPath {
  const validHints = hintedPaths.filter(
    (path) => expressionPathIsUsable(path) && expressionAtPath(expression, path) !== undefined,
  );
  if (validHints.length > 0) return commonAncestor(validHints);

  const requestedLeaves = leafCounts(requestedFragment);
  let best: Readonly<{ path: OperandPath; leafCount: number }> | undefined;
  walkExpressions(expression, [], (candidate, path) => {
    const candidateLeaves = leafCounts(candidate);
    if (!containsCounts(candidateLeaves.counts, requestedLeaves.counts)) return;
    if (
      !best ||
      candidateLeaves.total < best.leafCount ||
      (candidateLeaves.total === best.leafCount && path.length > best.path.length)
    ) {
      best = { path, leafCount: candidateLeaves.total };
    }
  });
  return best?.path ?? [];
}

function commonAncestor(paths: readonly OperandPath[]): OperandPath {
  const [first, ...rest] = paths;
  if (!first) return [];
  let length = first.length;
  for (const path of rest) {
    length = Math.min(length, path.length);
    let index = 0;
    while (index < length && first[index] === path[index]) index += 1;
    length = index;
  }
  return first.slice(0, length);
}

function leafCounts(expression: PlainMathJson): Readonly<{
  counts: ReadonlyMap<string, number>;
  total: number;
}> {
  const counts = new Map<string, number>();
  let total = 0;
  walkExpressions(expression, [], (candidate) => {
    if (functionParts(candidate)) return;
    const key = JSON.stringify(candidate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  });
  return { counts, total };
}

function containsCounts(
  available: ReadonlyMap<string, number>,
  requested: ReadonlyMap<string, number>,
): boolean {
  for (const [key, count] of requested) {
    if ((available.get(key) ?? 0) < count) return false;
  }
  return true;
}

export type StatementAnchor = Readonly<{
  stateId: ProofStateId;
  target: Readonly<{
    kind: "goal" | "obligation";
    id: StatementId;
  }>;
  statement: Readonly<{ kind: "conclusion" }> | Readonly<{ kind: "hypothesis"; id: StatementId }>;
}>;

export type AnchoredExactSelection = Readonly<{
  kind: "exact";
  anchor: StatementAnchor;
  path: OperandPath;
}>;

export type AnchoredAssociativeSelection = Readonly<{
  kind: "associative";
  anchor: StatementAnchor;
  containerPath: OperandPath;
  startOperand: number;
  endOperand: number;
  displayRange?: DisplayRange | undefined;
}>;

export type AnchoredProofSelection = AnchoredExactSelection | AnchoredAssociativeSelection;

export type LogicalPolarity = "positive" | "negative" | "mixed" | "neutral";
export type SemanticRole = "proposition" | "term" | "binder";

export type SelectionPosition = Readonly<{
  polarity: LogicalPolarity;
  role: SemanticRole;
}>;

export type ResolvedExactProofSelection = AnchoredExactSelection &
  Readonly<{
    /** Exact authoritative subtree, including its original representation and metadata. */
    fragment: PlainMathJson;
    declarations: readonly Declaration[];
    position: SelectionPosition;
  }>;

export type ResolvedAssociativeProofSelection = AnchoredAssociativeSelection &
  Omit<
    AssociativeSelectionLens,
    "kind" | "containerPath" | "startOperand" | "endOperand" | "displayRange"
  > &
  Readonly<{
    declarations: readonly Declaration[];
    position: SelectionPosition;
  }>;

export type ResolvedProofSelection =
  ResolvedExactProofSelection | ResolvedAssociativeProofSelection;

export const selectionSubjectIdSchema = stableIdentifierSchema.brand("SelectionSubjectId");
export type SelectionSubjectId = ReturnType<typeof selectionSubjectIdSchema.parse>;

export type ProofSelectionQuerySubject = Readonly<{
  id: SelectionSubjectId;
  selection: AnchoredProofSelection;
  /** Query-only: the authoritative selected fragment remains unchanged. */
  abstraction?: RetrievalWildcard | undefined;
}>;

export type ProofSelectionQuery = Readonly<{
  kind: "selection-query";
  selections: readonly ProofSelectionQuerySubject[];
}>;

export type ResolvedProofSelectionQuerySubject = Readonly<{
  id: SelectionSubjectId;
  selection: ResolvedProofSelection;
  abstraction?: RetrievalWildcard | undefined;
}>;

export type ResolvedProofSelectionQuery = Readonly<{
  kind: "selection-query";
  stateId: ProofStateId;
  selections: readonly ResolvedProofSelectionQuerySubject[];
}>;

export type ProofSelectionDiagnosticCode =
  | "invalid-state"
  | "invalid-selection"
  | "stale-state"
  | "target-not-found"
  | "hypothesis-not-found"
  | "invalid-path"
  | "invalid-associative-range"
  | "duplicate-selection"
  | "overlapping-selection"
  | "invalid-abstraction";

export type ProofSelectionDiagnostic = Readonly<{
  code: ProofSelectionDiagnosticCode;
  message: string;
}>;

export type ProofSelectionFailure = Readonly<{
  ok: false;
  diagnostics: readonly [ProofSelectionDiagnostic];
}>;

export type ResolveProofSelectionResult =
  | Readonly<{
      ok: true;
      selection: ResolvedProofSelection;
      diagnostics: readonly [];
    }>
  | ProofSelectionFailure;

export type ResolveProofSelectionQueryResult =
  | Readonly<{
      ok: true;
      query: ResolvedProofSelectionQuery;
      diagnostics: readonly [];
    }>
  | ProofSelectionFailure;

/** Resolve a stable set of independent occurrences and optional query-only abstractions. */
export function resolveProofSelectionQuery(
  state: ProofState,
  queryInput: unknown,
  environment: ProofStateSchemaOptions = {},
): ResolveProofSelectionQueryResult {
  try {
    const query = parseProofSelectionQuery(queryInput);
    if (query === undefined) {
      return proofSelectionFailure(
        "invalid-selection",
        "The selection query is not strict snapshot-anchored data.",
      );
    }
    const resolved: ResolvedProofSelectionQuerySubject[] = [];
    for (const subject of query.selections) {
      const result = resolveProofSelection(state, subject.selection, environment);
      if (!result.ok) return result;
      if (subject.abstraction !== undefined && result.selection.position.role === "binder") {
        return proofSelectionFailure(
          "invalid-abstraction",
          "Binder declarations cannot be replaced by ordinary retrieval wildcards.",
        );
      }
      resolved.push({
        id: subject.id,
        selection: result.selection,
        ...(subject.abstraction === undefined ? {} : { abstraction: subject.abstraction }),
      });
    }

    const occurrenceKeys = resolved.map(({ selection }) => selectionOccurrenceKey(selection));
    if (new Set(occurrenceKeys).size !== occurrenceKeys.length) {
      return proofSelectionFailure(
        "duplicate-selection",
        "A selection query cannot contain the same occurrence more than once.",
      );
    }
    for (let left = 0; left < resolved.length; left += 1) {
      for (let right = left + 1; right < resolved.length; right += 1) {
        if (selectionsOverlap(resolved[left]!.selection, resolved[right]!.selection)) {
          return proofSelectionFailure(
            "overlapping-selection",
            "A selection query cannot contain overlapping occurrences.",
          );
        }
      }
    }
    const wildcardById = new Map<string, RetrievalWildcard>();
    const wildcardIdBySymbol = new Map<string, string>();
    for (const { abstraction } of resolved) {
      if (abstraction === undefined) continue;
      const previous = wildcardById.get(abstraction.id);
      if (previous !== undefined && !plainDataEquals(previous, abstraction)) {
        return proofSelectionFailure(
          "invalid-abstraction",
          "Repeated retrieval-wildcard IDs must carry the same specification.",
        );
      }
      const previousId = wildcardIdBySymbol.get(abstraction.symbol);
      if (previousId !== undefined && previousId !== abstraction.id) {
        return proofSelectionFailure(
          "invalid-abstraction",
          "Different retrieval wildcards cannot share one display symbol.",
        );
      }
      wildcardById.set(abstraction.id, abstraction);
      wildcardIdBySymbol.set(abstraction.symbol, abstraction.id);
    }

    const stateId = resolved[0]?.selection.anchor.stateId;
    if (stateId === undefined) {
      return proofSelectionFailure("invalid-selection", "A selection query cannot be empty.");
    }
    const detached = freezeDetached({
      kind: "selection-query" as const,
      stateId,
      selections: resolved,
    });
    return detached === undefined
      ? proofSelectionFailure("invalid-selection", "The selection query could not be detached.")
      : { ok: true, query: detached, diagnostics: [] };
  } catch {
    return proofSelectionFailure(
      "invalid-selection",
      "The selection-query boundary could not inspect its input safely.",
    );
  }
}

/**
 * Resolve an exact occurrence or deterministic associative lens from a proof-state snapshot.
 * Caller-provided fragments, contexts, and polarity labels are not part of the input contract.
 */
export function resolveProofSelection(
  state: ProofState,
  selection: unknown,
  environment: ProofStateSchemaOptions = {},
): ResolveProofSelectionResult {
  let parsedState: ProofState | undefined;
  let operators: readonly OperatorDeclaration[] = [];
  try {
    operators = operatorDeclarationsSchema.parse(environment.operators ?? []);
    const result = createProofStateSchema({ operators }).safeParse(state);
    if (result.success) parsedState = result.data;
  } catch {
    parsedState = undefined;
  }
  if (parsedState === undefined) {
    return proofSelectionFailure(
      "invalid-state",
      "The supplied value is not a valid draft proof state for this environment.",
    );
  }

  let parsedSelection: AnchoredProofSelection | undefined;
  try {
    parsedSelection = parseAnchoredProofSelection(selection);
  } catch {
    parsedSelection = undefined;
  }
  if (parsedSelection === undefined) {
    return proofSelectionFailure(
      "invalid-selection",
      "The selection is not a strict snapshot-anchored exact or associative selection.",
    );
  }
  if (parsedSelection.anchor.stateId !== parsedState.id) {
    return proofSelectionFailure(
      "stale-state",
      `Selection state ${parsedSelection.anchor.stateId} does not match proof state ${parsedState.id}.`,
    );
  }

  try {
    const targetCollection =
      parsedSelection.anchor.target.kind === "goal" ? parsedState.goals : parsedState.obligations;
    const target = targetCollection.find(
      (candidate) => candidate.id === parsedSelection.anchor.target.id,
    );
    if (target === undefined) {
      return proofSelectionFailure(
        "target-not-found",
        `The anchored ${parsedSelection.anchor.target.kind} does not exist.`,
      );
    }

    const statement = parsedSelection.anchor.statement;
    const expression =
      statement.kind === "conclusion"
        ? target.sequent.conclusion.expression
        : target.sequent.context.hypotheses.find((candidate) => candidate.id === statement.id)
            ?.statement.expression;
    if (expression === undefined) {
      return proofSelectionFailure(
        "hypothesis-not-found",
        "The anchored hypothesis does not exist in the target's local context.",
      );
    }

    const rootPosition: SelectionPosition = {
      polarity: statement.kind === "conclusion" ? "positive" : "negative",
      role: "proposition",
    };
    if (parsedSelection.kind === "associative") {
      const lens = createAssociativeSelection(
        expression,
        parsedSelection.containerPath,
        parsedSelection.startOperand,
        parsedSelection.endOperand,
        parsedSelection.displayRange,
      );
      if (lens === undefined) {
        return proofSelectionFailure(
          "invalid-associative-range",
          "The anchored range is not a supported contiguous associative selection.",
        );
      }
      const position = positionAtPath(
        expression,
        [...parsedSelection.containerPath, parsedSelection.startOperand],
        rootPosition,
        target.sequent.context.declarations,
        operators,
      );
      if (position === undefined) {
        return proofSelectionFailure(
          "invalid-associative-range",
          "The anchored associative range has no valid semantic position.",
        );
      }
      return {
        ok: true,
        selection: {
          ...parsedSelection,
          operator: lens.operator,
          container: lens.container,
          coveredOperandPaths: lens.coveredOperandPaths,
          fragment: lens.fragment,
          declarations: target.sequent.context.declarations,
          position,
        },
        diagnostics: [],
      };
    }

    const fragment = expressionAtPath(expression, parsedSelection.path);
    if (fragment === undefined) {
      return proofSelectionFailure(
        "invalid-path",
        `No expression exists at operand path ${formatOperandPath(parsedSelection.path)}.`,
      );
    }

    const position = positionAtPath(
      expression,
      parsedSelection.path,
      rootPosition,
      target.sequent.context.declarations,
      operators,
    );
    if (position === undefined) {
      return proofSelectionFailure(
        "invalid-path",
        `No expression exists at operand path ${formatOperandPath(parsedSelection.path)}.`,
      );
    }

    return {
      ok: true,
      selection: {
        ...parsedSelection,
        fragment,
        declarations: target.sequent.context.declarations,
        position,
      },
      diagnostics: [],
    };
  } catch {
    return proofSelectionFailure(
      "invalid-state",
      "The proof state could not be traversed safely after validation.",
    );
  }
}

function proofSelectionFailure(
  code: ProofSelectionDiagnosticCode,
  message: string,
): ProofSelectionFailure {
  return { ok: false, diagnostics: [{ code, message }] };
}

function parseProofSelectionQuery(value: unknown): ProofSelectionQuery | undefined {
  if (
    !isStrictRecord(value, ["kind", "selections"]) ||
    value.kind !== "selection-query" ||
    !Array.isArray(value.selections) ||
    !isDenseDataArray(value.selections) ||
    value.selections.length < 1 ||
    value.selections.length > 16
  ) {
    return undefined;
  }
  const selections: ProofSelectionQuerySubject[] = [];
  const ids = new Set<string>();
  for (const input of value.selections) {
    if (!isDataRecord(input)) return undefined;
    const hasAbstraction = Object.hasOwn(input, "abstraction");
    if (
      !hasExactKeys(
        input,
        hasAbstraction ? ["id", "selection", "abstraction"] : ["id", "selection"],
      )
    ) {
      return undefined;
    }
    const id = selectionSubjectIdSchema.safeParse(input.id);
    const selection = parseAnchoredProofSelection(input.selection);
    const abstraction = hasAbstraction ? safeParseRetrievalWildcard(input.abstraction) : undefined;
    if (
      !id.success ||
      ids.has(id.data) ||
      selection === undefined ||
      (hasAbstraction && abstraction === undefined)
    ) {
      return undefined;
    }
    ids.add(id.data);
    selections.push({
      id: id.data,
      selection,
      ...(abstraction === undefined ? {} : { abstraction }),
    });
  }
  return { kind: "selection-query", selections };
}

function safeParseRetrievalWildcard(value: unknown): RetrievalWildcard | undefined {
  if (!isDataRecord(value)) return undefined;
  const parsed = retrievalWildcardSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function selectionOccurrenceKey(selection: ResolvedProofSelection): string {
  return JSON.stringify(
    selection.kind === "exact"
      ? [selection.anchor, "exact", selection.path]
      : [
          selection.anchor,
          "associative",
          selection.containerPath,
          selection.startOperand,
          selection.endOperand,
        ],
  );
}

function selectionsOverlap(left: ResolvedProofSelection, right: ResolvedProofSelection): boolean {
  if (!plainDataEquals(left.anchor, right.anchor)) return false;
  const leftPaths = selectionCoveragePaths(left);
  const rightPaths = selectionCoveragePaths(right);
  return leftPaths.some((leftPath) =>
    rightPaths.some(
      (rightPath) =>
        isOperandPathPrefix(leftPath, rightPath) || isOperandPathPrefix(rightPath, leftPath),
    ),
  );
}

function selectionCoveragePaths(selection: ResolvedProofSelection): readonly OperandPath[] {
  return selection.kind === "exact" ? [selection.path] : selection.coveredOperandPaths;
}

function parseAnchoredProofSelection(value: unknown): AnchoredProofSelection | undefined {
  if (!isDataRecord(value)) return undefined;
  if (value.kind === "exact") return parseAnchoredExactSelection(value);
  if (value.kind === "associative") return parseAnchoredAssociativeSelection(value);
  return undefined;
}

function parseAnchoredExactSelection(value: unknown): AnchoredExactSelection | undefined {
  if (!isStrictRecord(value, ["kind", "anchor", "path"]) || value.kind !== "exact") {
    return undefined;
  }
  const anchor = parseStatementAnchor(value.anchor);
  const path = parseOperandPath(value.path);
  return anchor === undefined || path === undefined ? undefined : { kind: "exact", anchor, path };
}

function parseAnchoredAssociativeSelection(
  value: unknown,
): AnchoredAssociativeSelection | undefined {
  if (!isDataRecord(value) || value.kind !== "associative") return undefined;
  const keys = ["kind", "anchor", "containerPath", "startOperand", "endOperand"];
  const hasDisplayRange = Object.hasOwn(value, "displayRange");
  if (!hasExactKeys(value, hasDisplayRange ? [...keys, "displayRange"] : keys)) return undefined;
  const anchor = parseStatementAnchor(value.anchor);
  const containerPath = parseOperandPath(value.containerPath);
  const startOperand = parseNonnegativeInteger(value.startOperand);
  const endOperand = parseNonnegativeInteger(value.endOperand);
  const displayRange = hasDisplayRange ? parseDisplayRange(value.displayRange) : undefined;
  if (
    anchor === undefined ||
    containerPath === undefined ||
    startOperand === undefined ||
    endOperand === undefined ||
    endOperand - startOperand < 2 ||
    (hasDisplayRange && displayRange === undefined)
  ) {
    return undefined;
  }
  return {
    kind: "associative",
    anchor,
    containerPath,
    startOperand,
    endOperand,
    ...(displayRange === undefined ? {} : { displayRange }),
  };
}

function parseStatementAnchor(value: unknown): StatementAnchor | undefined {
  if (!isStrictRecord(value, ["stateId", "target", "statement"])) return undefined;
  const stateId = proofStateIdSchema.safeParse(value.stateId);
  if (!stateId.success) return undefined;
  const target = parseTargetAnchor(value.target);
  const statement = parseStatementReference(value.statement);
  if (target === undefined || statement === undefined) return undefined;
  return { stateId: stateId.data, target, statement };
}

function parseTargetAnchor(value: unknown): StatementAnchor["target"] | undefined {
  if (!isStrictRecord(value, ["kind", "id"])) return undefined;
  if (value.kind !== "goal" && value.kind !== "obligation") return undefined;
  const id = statementIdSchema.safeParse(value.id);
  return id.success ? { kind: value.kind, id: id.data } : undefined;
}

function parseStatementReference(value: unknown): StatementAnchor["statement"] | undefined {
  if (!isDataRecord(value)) return undefined;
  if (value.kind === "conclusion" && hasExactKeys(value, ["kind"])) {
    return { kind: "conclusion" };
  }
  if (
    value.kind === "hypothesis" &&
    hasExactKeys(value, ["kind", "id"]) &&
    statementIdSchema.safeParse(value.id).success
  ) {
    return { kind: "hypothesis", id: value.id as StatementId };
  }
  return undefined;
}

function parseOperandPath(value: unknown): OperandPath | undefined {
  if (!Array.isArray(value) || !isDenseDataArray(value)) return undefined;
  const path: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const part = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    if (typeof part !== "number" || !Number.isInteger(part) || part < 0) return undefined;
    path.push(part);
  }
  return path;
}

function parseNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseDisplayRange(value: unknown): DisplayRange | undefined {
  if (!Array.isArray(value) || !isDenseDataArray(value) || value.length !== 2) return undefined;
  const start = parseNonnegativeInteger(value[0]);
  const end = parseNonnegativeInteger(value[1]);
  return start === undefined || end === undefined || end <= start ? undefined : [start, end];
}

function isStrictRecord(
  value: unknown,
  keys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  return isDataRecord(value) && hasExactKeys(value, keys);
}

function isDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDenseDataArray(value: readonly unknown[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)),
    )
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return false;
    }
  }
  return true;
}

function plainDataEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => plainDataEquals(entry, right[index]))
    );
  }
  if (!isDataRecord(left) || !isDataRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && plainDataEquals(left[key], right[key]),
    )
  );
}

function freezeDetached<Value>(value: Value): Value | undefined {
  try {
    return deepFreeze(structuredClone(value) as Value);
  } catch {
    return undefined;
  }
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

const RELATION_OPERATORS = new Set([
  "Equal",
  "NotEqual",
  "Less",
  "LessEqual",
  "Greater",
  "GreaterEqual",
  "Element",
  "NotElement",
  "Subset",
  "SubsetEqual",
  "Superset",
  "SupersetEqual",
]);

function positionAtPath(
  expression: PlainMathJson,
  path: OperandPath,
  root: SelectionPosition,
  declarations: readonly Declaration[],
  operators: readonly OperatorDeclaration[],
): SelectionPosition | undefined {
  let currentExpression = expression;
  let currentPosition = root;
  let bindings = new Map(declarations.map((declaration) => [declaration.symbol, declaration.sort]));
  for (const operandIndex of path) {
    const parts = functionParts(currentExpression);
    const operand = parts?.operands[operandIndex];
    if (parts === undefined || operand === undefined) return undefined;
    currentPosition = childPosition(
      parts.operator,
      operandIndex,
      currentPosition,
      bindings,
      operators,
    );
    bindings = scopedBindings(parts, operandIndex, bindings, operators);
    currentExpression = operand;
  }
  return currentPosition;
}

function childPosition(
  operator: string,
  operandIndex: number,
  parent: SelectionPosition,
  bindings: ReadonlyMap<string, Sort>,
  operators: readonly OperatorDeclaration[],
): SelectionPosition {
  const local = localChildPosition(operator, operandIndex, parent.polarity, bindings, operators);
  if (local.polarity === "neutral") return local;
  if (parent.polarity === "neutral") return { ...local, polarity: "neutral" };
  if (parent.polarity === "mixed") return { ...local, polarity: "mixed" };
  return local;
}

function localChildPosition(
  operator: string,
  operandIndex: number,
  parentPolarity: LogicalPolarity,
  bindings: ReadonlyMap<string, Sort>,
  operators: readonly OperatorDeclaration[],
): SelectionPosition {
  if (operator === "Not" && operandIndex === 0) {
    return { polarity: flipPolarity(parentPolarity), role: "proposition" };
  }
  if (operator === "Implies" && operandIndex < 2) {
    return {
      polarity: operandIndex === 0 ? flipPolarity(parentPolarity) : parentPolarity,
      role: "proposition",
    };
  }
  if (operator === "Equivalent") return { polarity: "mixed", role: "proposition" };
  if (operator === "And" || operator === "Or") {
    return { polarity: parentPolarity, role: "proposition" };
  }
  if (operator === "ForAll" || operator === "Exists") {
    return operandIndex === 0
      ? { polarity: "neutral", role: "binder" }
      : { polarity: parentPolarity, role: "proposition" };
  }
  if (RELATION_OPERATORS.has(operator)) return { polarity: "neutral", role: "term" };

  const customOperator = operators.find((candidate) => candidate.symbol === operator);
  if (customOperator?.binder?.boundOperands.includes(operandIndex) === true) {
    return { polarity: "neutral", role: "binder" };
  }
  const declaredSort = bindings.get(operator);
  const signature =
    customOperator?.signature ??
    (declaredSort?.kind === "function" ? declaredSort.signature : undefined);
  const parameter = signature?.parameters[operandIndex];
  return parameter !== undefined && isPropositionSort(parameter)
    ? { polarity: "mixed", role: "proposition" }
    : { polarity: "neutral", role: "term" };
}

function scopedBindings(
  parts: FunctionParts,
  selectedOperand: number,
  bindings: ReadonlyMap<string, Sort>,
  operators: readonly OperatorDeclaration[],
): Map<string, Sort> {
  const customOperator = operators.find((candidate) => candidate.symbol === parts.operator);
  const builtinBinder =
    parts.operator === "ForAll" || parts.operator === "Exists"
      ? { boundOperands: [0], scopedOperands: [1] }
      : undefined;
  const binder = customOperator?.binder ?? builtinBinder;
  if (binder === undefined || !binder.scopedOperands.includes(selectedOperand)) {
    return new Map(bindings);
  }

  const next = new Map(bindings);
  for (const boundOperand of binder.boundOperands) {
    const boundExpression = parts.operands[boundOperand];
    const symbol = boundExpression === undefined ? undefined : directSymbol(boundExpression);
    const sort =
      customOperator?.signature.parameters[boundOperand] ??
      (symbol === undefined ? undefined : bindings.get(symbol));
    if (symbol !== undefined && sort !== undefined) next.set(symbol, sort);
  }
  return next;
}

function directSymbol(expression: PlainMathJson): string | undefined {
  if (typeof expression === "string") return expression;
  if (typeof expression !== "object" || expression === null || Array.isArray(expression)) {
    return undefined;
  }
  return "sym" in expression && typeof expression.sym === "string" ? expression.sym : undefined;
}

function isPropositionSort(sort: Sort): boolean {
  return sort.kind === "proposition";
}

function flipPolarity(polarity: LogicalPolarity): LogicalPolarity {
  if (polarity === "positive") return "negative";
  if (polarity === "negative") return "positive";
  return polarity;
}
