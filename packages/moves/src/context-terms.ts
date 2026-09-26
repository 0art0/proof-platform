import type { TransitionStatementTarget } from "@proof/kernel";
import {
  BUILTIN_BINDER_SPECIFICATIONS,
  createStatementViewSchema,
  declarationIdSchema,
  freeSymbolNames,
  freshSymbolName,
  mathJsonEquals,
  type BinderSpecification,
  type Declaration,
  type OperatorDeclaration,
  type PlainMathJson,
  type Sort,
} from "@proof/mathjson-model";

/** Structural view of a MathJSON function node in array or `{ fn }` form. */
export type FunctionParts = Readonly<{
  operator: string;
  operands: readonly PlainMathJson[];
  rebuild: (operands: readonly PlainMathJson[]) => PlainMathJson;
}>;

export function functionParts(expression: PlainMathJson): FunctionParts | undefined {
  if (Array.isArray(expression)) {
    const operator = expression[0];
    return typeof operator === "string"
      ? {
          operator,
          operands: expression.slice(1) as readonly PlainMathJson[],
          rebuild: (operands) => [operator, ...operands],
        }
      : undefined;
  }
  if (typeof expression !== "object" || expression === null || !("fn" in expression)) {
    return undefined;
  }
  const operator = expression.fn[0];
  return typeof operator === "string"
    ? {
        operator,
        operands: expression.fn.slice(1),
        rebuild: (operands) => ({ ...expression, fn: [operator, ...operands] }),
      }
    : undefined;
}

export function operatorOperands(
  expression: PlainMathJson,
  operator: string,
): readonly PlainMathJson[] | undefined {
  const parts = functionParts(expression);
  return parts?.operator === operator ? parts.operands : undefined;
}

export function symbolValue(expression: PlainMathJson): string | undefined {
  if (typeof expression === "string") return expression;
  return typeof expression === "object" &&
    expression !== null &&
    !Array.isArray(expression) &&
    "sym" in expression
    ? expression.sym
    : undefined;
}

function binderFor(
  operator: string,
  operators: readonly OperatorDeclaration[],
): BinderSpecification | undefined {
  if (operator === "ForAll" || operator === "Exists")
    return BUILTIN_BINDER_SPECIFICATIONS[operator];
  return operators.find((candidate) => candidate.symbol === operator)?.binder;
}

/** One subexpression of a statement at an operand path. */
export type ContextOccurrence = Readonly<{
  expression: PlainMathJson;
  statement: TransitionStatementTarget;
  path: readonly number[];
}>;

/**
 * Every subexpression of the statements, in order and in preorder, that is
 * meaningful outside its position. Bound-symbol operands of binders and
 * function heads are not subexpressions, and a subexpression that mentions a
 * symbol bound by an enclosing binder is out of scope, so it is skipped.
 */
export function statementOccurrences(
  statements: readonly Readonly<{
    statement: TransitionStatementTarget;
    expression: PlainMathJson;
  }>[],
  operators: readonly OperatorDeclaration[],
): readonly ContextOccurrence[] {
  const occurrences: ContextOccurrence[] = [];
  const visit = (
    expression: PlainMathJson,
    statement: TransitionStatementTarget,
    path: readonly number[],
    bound: ReadonlySet<string>,
  ): void => {
    if (
      bound.size === 0 ||
      !freeSymbolNames(expression, { operators }).some((symbol) => bound.has(symbol))
    ) {
      occurrences.push({ expression, statement, path });
    }
    const parts = functionParts(expression);
    if (parts === undefined) return;
    const binder = binderFor(parts.operator, operators);
    const inner = new Set(bound);
    binder?.boundOperands.forEach((index) => {
      const operand = parts.operands[index];
      const name = operand === undefined ? undefined : symbolValue(operand);
      if (name !== undefined) inner.add(name);
    });
    parts.operands.forEach((operand, index) => {
      if (binder?.boundOperands.includes(index)) return;
      visit(
        operand,
        statement,
        [...path, index],
        binder?.scopedOperands.includes(index) ? inner : bound,
      );
    });
  };
  statements.forEach(({ statement, expression }) => visit(expression, statement, [], new Set()));
  return occurrences;
}

/** Symbols bound by binders enclosing the operand path (not including the node at the path). */
export function boundSymbolsAtPath(
  expression: PlainMathJson,
  path: readonly number[],
  operators: readonly OperatorDeclaration[],
): ReadonlySet<string> | undefined {
  const bound = new Set<string>();
  let current = expression;
  for (const index of path) {
    const parts = functionParts(current);
    if (parts === undefined) return undefined;
    const binder = binderFor(parts.operator, operators);
    if (binder?.boundOperands.includes(index)) return undefined;
    if (binder?.scopedOperands.includes(index)) {
      binder.boundOperands.forEach((boundIndex) => {
        const operand = parts.operands[boundIndex];
        const name = operand === undefined ? undefined : symbolValue(operand);
        if (name !== undefined) bound.add(name);
      });
    }
    const next = parts.operands[index];
    if (next === undefined) return undefined;
    current = next;
  }
  return bound;
}

export function expressionAtPath(
  expression: PlainMathJson,
  path: readonly number[],
): PlainMathJson | undefined {
  let current: PlainMathJson | undefined = expression;
  for (const index of path) {
    const parts: FunctionParts | undefined =
      current === undefined ? undefined : functionParts(current);
    current = parts?.operands[index];
  }
  return current;
}

/**
 * A predicate deciding whether terms have the expected sort using only the
 * local declarations and operators: a fresh predicate of sort
 * `(expected) -> proposition` is applied to the term and validated as a
 * proposition, so every free symbol of the term must be declared. This
 * mirrors the kernel's own instantiation check.
 */
export function sortFilter(
  expected: Sort,
  declarations: readonly Declaration[],
  operators: readonly OperatorDeclaration[],
  candidates: readonly PlainMathJson[],
): (term: PlainMathJson) => boolean {
  const used = new Set<string>([
    ...declarations.map((declaration) => declaration.symbol),
    ...operators.map((operator) => operator.symbol),
  ]);
  candidates.forEach((candidate) => collectSymbolNames(candidate, used));
  const ids = new Set<string>(declarations.map((declaration) => declaration.id));
  let probeId = "declaration:moves-sort-probe";
  for (let suffix = 1; ids.has(probeId); suffix += 1) {
    probeId = `declaration:moves-sort-probe-${suffix}`;
  }
  const probe = freshSymbolName("SortProbe", used);
  let schema: ReturnType<typeof createStatementViewSchema>;
  try {
    schema = createStatementViewSchema({
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
    });
  } catch {
    return () => false;
  }
  return (term) => {
    try {
      return schema.safeParse({ expression: [probe, term] }).success;
    } catch {
      return false;
    }
  };
}

/** A predicate deciding whether expressions are propositions in the local context. */
export function propositionFilter(
  declarations: readonly Declaration[],
  operators: readonly OperatorDeclaration[],
): (expression: PlainMathJson) => boolean {
  let schema: ReturnType<typeof createStatementViewSchema>;
  try {
    schema = createStatementViewSchema({ declarations, operators });
  } catch {
    return () => false;
  }
  return (expression) => {
    try {
      return schema.safeParse({ expression }).success;
    } catch {
      return false;
    }
  };
}

function collectSymbolNames(expression: PlainMathJson, names: Set<string>): void {
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

/** Keep the first of every group of structurally equal entries, preserving order. */
export function dedupeBy<Entry>(
  entries: readonly Entry[],
  key: (entry: Entry) => PlainMathJson,
): readonly Entry[] {
  const kept: Entry[] = [];
  for (const entry of entries) {
    if (!kept.some((existing) => mathJsonEquals(key(existing), key(entry)))) kept.push(entry);
  }
  return kept;
}
