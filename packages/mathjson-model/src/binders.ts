import type { PlainMathJson } from "./index";
import type { OperatorDeclaration } from "./contracts";

/**
 * How one bound operand of a binder may declare its variable:
 *
 * - `symbol`: the operand is the bound symbol itself (`["ForAll", "x", body]`);
 * - `element`: `["Element", x, domain]`, a typed declaration whose domain is set-valued;
 * - `limits`: `["Limits", k, lower, upper]`, an index ranging over an interval.
 *
 * The domain and bounds of a declaration belong to the enclosing scope, never to the binder's own
 * scope, so `["ForAll", ["Element", "x", "x"], …]` mentions a free `x` in its domain.
 */
export type BinderDeclarationForm = "symbol" | "element" | "limits";

/** The structural binder contract of one binder node, resolved for its actual operand count. */
export type BinderShape = Readonly<{
  /** Operands that declare bound variables, in binding order. */
  boundOperands: readonly number[];
  /** Operands evaluated inside the binder's scope. */
  scopedOperands: readonly number[];
  /** The declaration forms a bound operand may take. */
  forms: readonly BinderDeclarationForm[];
}>;

/** One variable declared by a bound operand. */
export type BinderDeclaration = Readonly<{
  form: BinderDeclarationForm;
  name: string;
  /** The bound symbol node: the operand itself, or the declaration's first operand. */
  symbol: PlainMathJson;
  /**
   * Operand indices, inside an `element` or `limits` declaration node, of its domain or bounds.
   * They are evaluated in the enclosing scope. Empty for a bare symbol.
   */
  outerOperands: readonly number[];
}>;

/** Built-in binder heads beyond the logical quantifiers (design plan §5.2). */
export const BUILTIN_BINDER_HEADS: ReadonlySet<string> = new Set([
  "ForAll",
  "Exists",
  "Function",
  "Sum",
  "Product",
  "Integrate",
]);

const DECLARATION_HEADS: ReadonlyMap<string, Exclude<BinderDeclarationForm, "symbol">> = new Map([
  ["Element", "element"],
  ["Limits", "limits"],
]);

const QUANTIFIER_SHAPE: BinderShape = Object.freeze({
  boundOperands: Object.freeze([0]),
  scopedOperands: Object.freeze([1]),
  forms: Object.freeze(["symbol", "element"] as const),
});
const BIG_OPERATOR_SHAPE: BinderShape = Object.freeze({
  boundOperands: Object.freeze([1]),
  scopedOperands: Object.freeze([0]),
  forms: Object.freeze(["limits", "element"] as const),
});
const INTEGRAL_SHAPE: BinderShape = Object.freeze({
  boundOperands: Object.freeze([1]),
  scopedOperands: Object.freeze([0]),
  forms: Object.freeze(["limits"] as const),
});

/**
 * The binder shape of a function head, or undefined when the head binds nothing. Built-in heads
 * take precedence over custom operators (which cannot use reserved symbols):
 *
 * - `["ForAll" | "Exists", declaration, body]`, where the declaration is a symbol or `Element`;
 * - `["Function", body, declaration, …]`, a lambda with one or more symbol or `Element` parameters;
 * - `["Sum" | "Product", body, declaration]`, with a `Limits` or `Element` index;
 * - `["Integrate", body, ["Limits", x, lower, upper]]`, a definite integral.
 *
 * A custom binder binds bare symbols at its declared operands. Callers that know a head symbol is
 * locally bound must treat it as a variable instead of calling this function.
 */
export function binderShape(
  operator: string,
  operandCount: number,
  operators: readonly OperatorDeclaration[],
): BinderShape | undefined {
  switch (operator) {
    case "ForAll":
    case "Exists":
      return QUANTIFIER_SHAPE;
    case "Function":
      return {
        boundOperands: Array.from(
          { length: Math.max(operandCount - 1, 0) },
          (_, index) => index + 1,
        ),
        scopedOperands: [0],
        forms: QUANTIFIER_SHAPE.forms,
      };
    case "Sum":
    case "Product":
      return BIG_OPERATOR_SHAPE;
    case "Integrate":
      return INTEGRAL_SHAPE;
    default: {
      const binder = operators.find((candidate) => candidate.symbol === operator)?.binder;
      return binder === undefined
        ? undefined
        : {
            boundOperands: binder.boundOperands,
            scopedOperands: binder.scopedOperands,
            forms: ["symbol"],
          };
    }
  }
}

/**
 * Read the variable declared by a bound operand, or undefined when the operand is not one of the
 * admitted declaration forms. Declaration nodes must have exact arity (`Element` 2, `Limits` 3).
 */
export function readBinderDeclaration(
  operand: PlainMathJson,
  forms: readonly BinderDeclarationForm[],
): BinderDeclaration | undefined {
  const name = symbolName(operand);
  if (name !== undefined) {
    return forms.includes("symbol")
      ? { form: "symbol", name, symbol: operand, outerOperands: [] }
      : undefined;
  }
  const parts = headAndOperands(operand);
  if (parts === undefined) return undefined;
  const form = DECLARATION_HEADS.get(parts.operator);
  if (form === undefined || !forms.includes(form)) return undefined;
  const expectedOperands = form === "element" ? 2 : 3;
  const symbol = parts.operands[0];
  const boundName = symbol === undefined ? undefined : symbolName(symbol);
  if (parts.operands.length !== expectedOperands || symbol === undefined || boundName === undefined)
    return undefined;
  return {
    form,
    name: boundName,
    symbol,
    outerOperands: form === "element" ? [1] : [1, 2],
  };
}

/** Names declared by a binder node's readable bound operands, in binding order. */
export function binderDeclarations(
  operands: readonly PlainMathJson[],
  shape: BinderShape,
): readonly (BinderDeclaration | undefined)[] {
  return shape.boundOperands.map((index) => {
    const operand = operands[index];
    return operand === undefined ? undefined : readBinderDeclaration(operand, shape.forms);
  });
}

function symbolName(expression: PlainMathJson): string | undefined {
  if (typeof expression === "string") return expression;
  if (typeof expression !== "object" || expression === null || Array.isArray(expression)) {
    return undefined;
  }
  const symbol = (expression as Readonly<Record<string, unknown>>).sym;
  return typeof symbol === "string" ? symbol : undefined;
}

function headAndOperands(
  expression: PlainMathJson,
): Readonly<{ operator: string; operands: readonly PlainMathJson[] }> | undefined {
  if (Array.isArray(expression)) {
    const operator = expression[0];
    return typeof operator === "string"
      ? { operator, operands: expression.slice(1) as readonly PlainMathJson[] }
      : undefined;
  }
  if (typeof expression !== "object" || expression === null) return undefined;
  const fn = (expression as Readonly<Record<string, unknown>>).fn;
  if (!Array.isArray(fn) || typeof fn[0] !== "string") return undefined;
  return { operator: fn[0], operands: fn.slice(1) as readonly PlainMathJson[] };
}
