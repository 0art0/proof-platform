import {
  binderShape,
  readBinderDeclaration,
  type BinderDeclaration,
  type BinderShape,
  type OperatorDeclaration,
  type PlainMathJson,
} from "@proof/mathjson-model";

/** Structural view of a MathJSON function node in either array or `{ fn }` form. */
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
  const fn = expression.fn;
  const operator = fn[0];
  return typeof operator === "string"
    ? {
        operator,
        operands: fn.slice(1),
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

/**
 * The binder shape of a function node, using built-ins before custom operators. Callers treat a
 * locally bound head as a variable and must not ask for its shape.
 */
export function binderFor(
  parts: FunctionParts,
  operators: readonly OperatorDeclaration[],
): BinderShape | undefined {
  return binderShape(parts.operator, parts.operands.length, operators);
}

/** The declaration at a bound operand of a binder node, or undefined when it is malformed. */
export function boundDeclaration(
  parts: FunctionParts,
  binder: BinderShape,
  index: number,
): BinderDeclaration | undefined {
  const operand = parts.operands[index];
  return operand === undefined ? undefined : readBinderDeclaration(operand, binder.forms);
}

/** A built-in `ForAll`/`Exists` over one untyped symbol, the only quantifier shape the kernel's quantifier rules accept. */
export function readBuiltinQuantifier(
  expression: PlainMathJson,
  operator: "ForAll" | "Exists",
): Readonly<{ symbol: string; body: PlainMathJson }> | undefined {
  const operands = operatorOperands(expression, operator);
  const symbol = operands === undefined ? undefined : symbolValue(operands[0] as PlainMathJson);
  const body = operands?.[1];
  return operands?.length === 2 && symbol !== undefined && body !== undefined
    ? { symbol, body }
    : undefined;
}

/**
 * A built-in `ForAll`/`Exists` whose bound symbol is declared bare (`x`) or typed
 * (`["Element", x, S]`, giving `domain`). The domain belongs to the enclosing scope.
 */
export type ReadQuantifier = Readonly<{
  symbol: string;
  domain?: PlainMathJson;
  body: PlainMathJson;
}>;

export function readQuantifier(
  expression: PlainMathJson,
  operator: "ForAll" | "Exists",
): ReadQuantifier | undefined {
  const parts = functionParts(expression);
  if (parts?.operator !== operator || parts.operands.length !== 2) return undefined;
  const declaration = readBinderDeclaration(parts.operands[0] as PlainMathJson, [
    "symbol",
    "element",
  ]);
  const body = parts.operands[1] as PlainMathJson;
  if (declaration === undefined) return undefined;
  if (declaration.form === "symbol") return { symbol: declaration.name, body };
  const domainIndex = declaration.outerOperands[0] as number;
  const domain = functionParts(parts.operands[0] as PlainMathJson)?.operands[domainIndex];
  return domain === undefined ? undefined : { symbol: declaration.name, domain, body };
}
