import { parsePlainMathJson, renderMathJson, type PlainMathJson } from "@proof/mathjson-model";
import {
  expressionAtPath,
  formatOperandPath,
  listExpressionPaths,
  resolveSelection,
  type AnchoredProofSelection,
  type DisplayRange,
  type OperandPath,
  type ResolvedSelection,
  type StatementAnchor,
} from "@proof/selections";

type MathLiveSelection = Readonly<{
  ranges: readonly DisplayRange[];
  direction?: "forward" | "backward" | "none";
}>;

export type MathLiveSelectionPort = Readonly<{
  selection: MathLiveSelection;
  selectionIsCollapsed: boolean;
  position: number;
  lastOffset: number;
  getValue: (selection: MathLiveSelection | DisplayRange, format: "math-json") => string;
  getElementInfo: (
    offset: number,
  ) => Readonly<{ data?: Readonly<Record<string, string | undefined>> }> | undefined;
}>;

export type AnchoredMathLiveSelection = Readonly<{
  /** The strict snapshot-relative occurrence suitable for proof selection APIs. */
  selection: AnchoredProofSelection;
  /** Projection evidence used to explain an exact, associative, or snapped interpretation. */
  interpretation: ResolvedSelection;
}>;

const PATH_KEY_PREFIX = "proof-path-";

/**
 * Adds transient leaf metadata to the LaTeX projection. The annotations never
 * enter stored MathJSON; MathLive exposes them through `getElementInfo()` so
 * repeated equal leaves can be mapped back to their exact occurrence.
 */
export function renderInteractiveLatex(expression: PlainMathJson): string {
  const rendered = renderMathJson(expression);
  if (!rendered.ok) return "\\text{Unable to render MathJSON}";

  const insertions: Array<Readonly<{ start: number; end: number; replacement: string }>> = [];
  const protectedRanges = nameRanges(rendered.latex);
  let cursor = 0;

  for (const path of listExpressionPaths(expression)) {
    const fragment = expressionAtPath(expression, path);
    if (fragment === undefined || listExpressionPaths(fragment).length !== 1) continue;
    const leaf = renderMathJson(fragment);
    if (!leaf.ok || leaf.latex.length === 0) continue;

    const start = findLeaf(rendered.latex, leaf.latex, cursor, protectedRanges);
    if (start < 0) continue;
    const end = start + leaf.latex.length;
    const key = `${PATH_KEY_PREFIX}${path.length}`;
    insertions.push({
      start,
      end,
      replacement: `\\htmlData{${key}=${formatOperandPath(path)}}{${leaf.latex}}`,
    });
    cursor = end;
  }

  let annotated = rendered.latex;
  for (const insertion of insertions.reverse()) {
    annotated = `${annotated.slice(0, insertion.start)}${insertion.replacement}${annotated.slice(
      insertion.end,
    )}`;
  }
  return `\\htmlData{${PATH_KEY_PREFIX}0=root}{${annotated}}`;
}

type Range = Readonly<{ start: number; end: number }>;

/**
 * The parts of rendered LaTeX that are names, not mathematics: command names (`\mathrm`) and the
 * text arguments of name commands (`{Gcd}` in `\mathrm{Gcd}`). A leaf such as `a` or `c` must not
 * be found inside them; annotating there would split `\mathrm` into `\m…thrm`.
 */
function nameRanges(latex: string): readonly Range[] {
  const ranges: Range[] = [];
  for (const match of latex.matchAll(/\\[A-Za-z]+/g)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  const named =
    /\\(?:mathrm|operatorname|text|textrm|textit|mathit|mathbf|mathsf|mathtt|mathcal|mathbb)\{([^{}]*)\}/g;
  for (const match of latex.matchAll(named)) {
    const open = match.index + match[0].length - match[1]!.length - 1;
    ranges.push({ start: open, end: open + match[1]!.length + 2 });
  }
  return ranges;
}

/**
 * The first occurrence of `leaf` at or after `from` that neither starts nor ends inside a name: a
 * name may lie wholly within the occurrence (the leaf `\mathrm{ab}` contains one), never across
 * its boundary.
 */
function findLeaf(latex: string, leaf: string, from: number, names: readonly Range[]): number {
  const cuts = (position: number) =>
    names.some(({ start, end }) => position > start && position < end);
  for (let start = latex.indexOf(leaf, from); start >= 0; start = latex.indexOf(leaf, start + 1)) {
    if (!cuts(start) && !cuts(start + leaf.length)) return start;
  }
  return -1;
}

export function operandPathFromElementData(
  data: Readonly<Record<string, string | undefined>> | undefined,
): OperandPath | undefined {
  if (!data) return undefined;
  const candidates = Object.entries(data)
    .flatMap(([key, value]) => {
      if (!key.startsWith(PATH_KEY_PREFIX) || value === undefined) return [];
      const depth = Number(key.slice(PATH_KEY_PREFIX.length));
      const path = parseOperandPath(value);
      return Number.isInteger(depth) && path !== undefined ? [{ depth, path }] : [];
    })
    .sort((left, right) => right.depth - left.depth);
  return candidates[0]?.path;
}

function parseOperandPath(value: string): OperandPath | undefined {
  if (value === "root") return [];
  const path = value.split(".").map(Number);
  return path.length > 0 && path.every((part) => Number.isInteger(part) && part >= 0)
    ? path
    : undefined;
}

export function readMathLiveSelection(
  field: MathLiveSelectionPort,
  expression: PlainMathJson,
): ResolvedSelection {
  if (field.selectionIsCollapsed) {
    const path = pathNearOffset(field, field.position, 1) ?? [];
    const fragment = expressionAtPath(expression, path);
    if (fragment === undefined) {
      return {
        kind: "fallback",
        path: [],
        fragment: expression,
        requestedFragment: expression,
        reason: "Stale display metadata was snapped to the statement root.",
      };
    }
    return {
      kind: "exact",
      path,
      fragment,
    };
  }

  const range = field.selection.ranges[0];
  if (!range) return resolveSelection(expression, ["Error", "No display range"]);

  const requested = parsePlainMathJson(field.getValue(field.selection, "math-json"));
  const paths = [pathNearOffset(field, range[0], 1), pathNearOffset(field, range[1], -1)].filter(
    (path): path is OperandPath => path !== undefined,
  );

  return resolveSelection(expression, requested ?? ["Error", "Unreadable display range"], {
    paths,
    displayRange: range,
  });
}

/**
 * Interprets a MathLive range while retaining the complete owning statement
 * identity. A visible subtree fallback becomes an exact anchored occurrence;
 * its fallback evidence remains available to the caller for UI feedback.
 */
export function readAnchoredMathLiveSelection(
  field: MathLiveSelectionPort,
  expression: PlainMathJson,
  anchor: StatementAnchor,
): AnchoredMathLiveSelection {
  const interpretation = readMathLiveSelection(field, expression);
  const selection: AnchoredProofSelection =
    interpretation.kind === "associative"
      ? {
          kind: "associative",
          anchor,
          containerPath: interpretation.containerPath,
          startOperand: interpretation.startOperand,
          endOperand: interpretation.endOperand,
          ...(interpretation.displayRange === undefined
            ? {}
            : { displayRange: interpretation.displayRange }),
        }
      : {
          kind: "exact",
          anchor,
          path: interpretation.path,
        };

  return { selection, interpretation };
}

function pathNearOffset(
  field: MathLiveSelectionPort,
  offset: number,
  direction: -1 | 1,
): OperandPath | undefined {
  let root: OperandPath | undefined;
  for (const delta of [0, direction, direction * 2, -direction, direction * 3, -direction * 2]) {
    const candidateOffset = Math.max(0, Math.min(field.lastOffset, offset + delta));
    const path = operandPathFromElementData(field.getElementInfo(candidateOffset)?.data);
    if (path && path.length > 0) return path;
    if (path) root = path;
  }
  return root;
}
