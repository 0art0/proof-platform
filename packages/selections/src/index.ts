import { mathJsonEquals, type PlainMathJson } from "@proof/mathjson-model";

/** Zero-based operand indices. The operator stored at array index 0 is never part of a path. */
export type OperandPath = readonly number[];
export type DisplayRange = readonly [start: number, end: number];

export type ExactSelection = Readonly<{
  kind: "exact";
  path: OperandPath;
  fragment: PlainMathJson;
  displayRange?: DisplayRange;
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
  displayRange?: DisplayRange;
}>;

export type FallbackSelection = Readonly<{
  kind: "fallback";
  path: OperandPath;
  fragment: PlainMathJson;
  requestedFragment: PlainMathJson;
  reason: string;
  displayRange?: DisplayRange;
}>;

export type ResolvedSelection = ExactSelection | AssociativeSelectionLens | FallbackSelection;

export type SelectionHint = Readonly<{
  /** Semantic paths found at the start and end of the MathLive range. */
  paths?: readonly OperandPath[];
  /** Used when equal expressions occur more than once and display metadata is unavailable. */
  occurrence?: number;
  displayRange?: DisplayRange;
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
