import {
  freeSymbolNames,
  statementIdSchema,
  type Declaration,
  type OperatorDeclaration,
  type PlainMathJson,
  type StatementId,
} from "@proof/mathjson-model";
import {
  createAssociativeSelection,
  positionAtPath,
  replaceAtPath,
  replaceSelection,
  type LogicalPolarity,
  type SemanticRole,
} from "@proof/selections";
import { binderFor, functionParts, symbolValue } from "./expression";
import { kernelResultIdSchema, type KernelResultId, type ResultInstantiation } from "./results";
import { hasExactKeys, isStrictRecord } from "./runtime";

/**
 * A contiguous operand range `[startOperand, endOperand)` of the associative
 * `Add`/`Multiply`/`And`/`Or` node at a rewrite's `path` (an associative
 * selection lens). The range covers at least two operands and never the whole
 * container; the whole container is addressed by its plain path.
 */
export type RewriteLens = Readonly<{ startOperand: number; endOperand: number }>;

/** Where a deep rewrite's `Equivalent` or `Implies` statement comes from. */
export type RewriteSource =
  | Readonly<{ kind: "hypothesis"; hypothesisId: StatementId }>
  | Readonly<{ kind: "result"; resultId: KernelResultId; instantiation: ResultInstantiation }>;

/**
 * One rewrite occurrence inside a statement. `polarity` is the overall
 * polarity of the position in the sequent, computed by the selection
 * resolver's `positionAtPath` from the statement's base polarity; for a lens it
 * is the polarity of the covered operands. `boundSymbols` are the symbols bound
 * by binders enclosing the occurrence.
 */
export type RewriteOccurrence = Readonly<{
  fragment: PlainMathJson;
  boundSymbols: ReadonlySet<string>;
  polarity: LogicalPolarity;
  role: SemanticRole;
  replace: (replacement: PlainMathJson) => PlainMathJson | undefined;
}>;

/**
 * Locate a path or lens occurrence. Returns undefined when the path does not
 * exist, passes through a binder's bound-symbol operand, or the lens is not a
 * proper contiguous range of an associative node.
 */
export function locateRewriteOccurrence(
  expression: PlainMathJson,
  path: readonly number[],
  lens: RewriteLens | undefined,
  basePolarity: "positive" | "negative",
  declarations: readonly Declaration[],
  operators: readonly OperatorDeclaration[],
): RewriteOccurrence | undefined {
  let current = expression;
  const boundSymbols = new Set<string>();
  for (const operandIndex of path) {
    const parts = functionParts(current);
    if (parts === undefined) return undefined;
    const binder = binderFor(parts.operator, operators);
    if (binder?.boundOperands.includes(operandIndex)) return undefined;
    if (binder?.scopedOperands.includes(operandIndex)) {
      binder.boundOperands.forEach((boundIndex) => {
        const name = symbolValue(parts.operands[boundIndex] as PlainMathJson);
        if (name !== undefined) boundSymbols.add(name);
      });
    }
    const next = parts.operands[operandIndex];
    if (next === undefined) return undefined;
    current = next;
  }

  const root = { polarity: basePolarity, role: "proposition" } as const;
  if (lens === undefined) {
    const position = positionAtPath(expression, path, root, declarations, operators);
    if (position === undefined) return undefined;
    return {
      fragment: current,
      boundSymbols,
      polarity: position.polarity,
      role: position.role,
      replace: (replacement) => {
        const replaced = replaceAtPath(expression, path, structuredClone(replacement));
        return replaced.ok ? replaced.expression : undefined;
      },
    };
  }

  const operandCount = functionParts(current)?.operands.length;
  const selection = createAssociativeSelection(
    expression,
    path,
    lens.startOperand,
    lens.endOperand,
  );
  if (
    selection === undefined ||
    operandCount === undefined ||
    lens.endOperand - lens.startOperand >= operandCount
  ) {
    return undefined;
  }
  const position = positionAtPath(
    expression,
    [...path, lens.startOperand],
    root,
    declarations,
    operators,
  );
  if (position === undefined) return undefined;
  return {
    fragment: selection.fragment,
    boundSymbols,
    polarity: position.polarity,
    role: position.role,
    replace: (replacement) => {
      const replaced = replaceSelection(expression, selection, structuredClone(replacement));
      return replaced.ok ? replaced.expression : undefined;
    },
  };
}

/**
 * True when rewriting would capture: a free symbol of the matched side or the
 * replacement is bound by a binder enclosing the occurrence. A matched side
 * whose free symbol is bound at the occurrence refers to the bound variable,
 * not to the source's symbol, so such a match is rejected as well.
 */
export function rewriteCaptures(
  occurrence: RewriteOccurrence,
  sides: readonly PlainMathJson[],
  operators: readonly OperatorDeclaration[],
): boolean {
  return sides.some((side) =>
    freeSymbolNames(side, { operators }).some((symbol) => occurrence.boundSymbols.has(symbol)),
  );
}

export function isRewriteLens(value: unknown): value is RewriteLens {
  if (!isStrictRecord(value) || !hasExactKeys(value, ["startOperand", "endOperand"])) {
    return false;
  }
  const { startOperand, endOperand } = value;
  return (
    isNonnegativeInteger(startOperand) &&
    isNonnegativeInteger(endOperand) &&
    endOperand - startOperand >= 2
  );
}

export function copyRewriteLens(value: unknown): RewriteLens {
  if (!isRewriteLens(value)) throw new Error("Expected a validated rewrite lens.");
  return { startOperand: value.startOperand, endOperand: value.endOperand };
}

/**
 * Parse a rewrite source. `isInstantiation`/`copyInstantiation` are supplied
 * by the operation parser so both result-carrying operations share one
 * instantiation validator.
 */
export function parseRewriteSource(
  value: unknown,
  isInstantiation: (candidate: unknown) => boolean,
  copyInstantiation: (candidate: unknown) => ResultInstantiation,
): RewriteSource | undefined {
  if (!isStrictRecord(value)) return undefined;
  if (value.kind === "hypothesis" && hasExactKeys(value, ["kind", "hypothesisId"])) {
    const hypothesisId = statementIdSchema.safeParse(value.hypothesisId);
    return hypothesisId.success
      ? { kind: "hypothesis", hypothesisId: hypothesisId.data }
      : undefined;
  }
  if (value.kind === "result" && hasExactKeys(value, ["kind", "resultId", "instantiation"])) {
    const resultId = kernelResultIdSchema.safeParse(value.resultId);
    if (!resultId.success || !isInstantiation(value.instantiation)) return undefined;
    return {
      kind: "result",
      resultId: resultId.data,
      instantiation: copyInstantiation(value.instantiation),
    };
  }
  return undefined;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
