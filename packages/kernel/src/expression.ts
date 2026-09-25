import {
  BUILTIN_BINDER_SPECIFICATIONS,
  type BinderSpecification,
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

/** The binder specification for a function head, using built-ins before custom operators. */
export function binderFor(
  operator: string,
  operators: readonly OperatorDeclaration[],
): BinderSpecification | undefined {
  if (operator === "ForAll" || operator === "Exists") {
    return BUILTIN_BINDER_SPECIFICATIONS[operator];
  }
  return operators.find((candidate) => candidate.symbol === operator)?.binder;
}
