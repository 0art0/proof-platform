import {
  mathJsonEquals,
  operatorDeclarationsSchema,
  type OperatorDeclaration,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { binderFor, functionParts, symbolValue } from "./expression";

export type AlphaEquivalenceEnvironment = Readonly<{
  operators?: readonly OperatorDeclaration[];
}>;

/**
 * Decide whether two plain MathJSON expressions differ only by consistent
 * renaming of bound symbols, for the built-in quantifiers and every custom
 * binder in the operator environment.
 *
 * Everything else is compared exactly: free symbols by name, literals and
 * wrapper metadata (such as `comment`) by value, and the array/object form of
 * every node. A string symbol and an object-form symbol are never equivalent.
 * An invalid operator environment or malformed binder yields `false`.
 */
export function alphaEquivalent(
  left: PlainMathJson,
  right: PlainMathJson,
  environment: AlphaEquivalenceEnvironment = {},
): boolean {
  const operators = operatorDeclarationsSchema.safeParse(environment.operators ?? []);
  return operators.success && alphaEquivalentWithOperators(left, right, operators.data);
}

/** Kernel-internal variant for an operator environment that is already validated. */
export function alphaEquivalentWithOperators(
  left: PlainMathJson,
  right: PlainMathJson,
  operators: readonly OperatorDeclaration[],
): boolean {
  if (mathJsonEquals(left, right)) return true;
  return compare(left, right, new Map(), new Map(), 0, operators);
}

/** Bound symbols map to the binder depth that introduced them (a de Bruijn level). */
type Scope = ReadonlyMap<string, number>;

function compare(
  left: PlainMathJson,
  right: PlainMathJson,
  leftScope: Scope,
  rightScope: Scope,
  depth: number,
  operators: readonly OperatorDeclaration[],
): boolean {
  const leftSymbol = symbolValue(left);
  const rightSymbol = symbolValue(right);
  if (leftSymbol !== undefined || rightSymbol !== undefined) {
    return (
      leftSymbol !== undefined &&
      rightSymbol !== undefined &&
      sameSymbolReference(leftSymbol, rightSymbol, leftScope, rightScope) &&
      sameNodeMetadata(left, right, "sym")
    );
  }

  const leftParts = functionParts(left);
  const rightParts = functionParts(right);
  if (leftParts === undefined || rightParts === undefined) {
    return leftParts === undefined && rightParts === undefined && mathJsonEquals(left, right);
  }
  if (
    leftParts.operands.length !== rightParts.operands.length ||
    !sameSymbolReference(leftParts.operator, rightParts.operator, leftScope, rightScope) ||
    !sameNodeMetadata(left, right, "fn")
  ) {
    return false;
  }

  // A locally bound head is a variable, never a binder; built-in and operator
  // symbols cannot be bound, so both heads resolve to the same specification.
  const binder = leftScope.has(leftParts.operator)
    ? undefined
    : binderFor(leftParts.operator, operators);
  if (binder === undefined) {
    return leftParts.operands.every((operand, index) =>
      compare(
        operand,
        rightParts.operands[index] as PlainMathJson,
        leftScope,
        rightScope,
        depth,
        operators,
      ),
    );
  }

  const leftInner = new Map(leftScope);
  const rightInner = new Map(rightScope);
  let innerDepth = depth;
  for (const index of binder.boundOperands) {
    const leftBound = leftParts.operands[index];
    const rightBound = rightParts.operands[index];
    const leftName = leftBound === undefined ? undefined : symbolValue(leftBound);
    const rightName = rightBound === undefined ? undefined : symbolValue(rightBound);
    if (
      leftBound === undefined ||
      rightBound === undefined ||
      leftName === undefined ||
      rightName === undefined ||
      !sameNodeMetadata(leftBound, rightBound, "sym")
    ) {
      return false;
    }
    leftInner.set(leftName, innerDepth);
    rightInner.set(rightName, innerDepth);
    innerDepth += 1;
  }
  const boundOperands = new Set(binder.boundOperands);
  const scopedOperands = new Set(binder.scopedOperands);
  return leftParts.operands.every((operand, index) => {
    if (boundOperands.has(index)) return true;
    const scoped = scopedOperands.has(index);
    return compare(
      operand,
      rightParts.operands[index] as PlainMathJson,
      scoped ? leftInner : leftScope,
      scoped ? rightInner : rightScope,
      scoped ? innerDepth : depth,
      operators,
    );
  });
}

function sameSymbolReference(
  left: string,
  right: string,
  leftScope: Scope,
  rightScope: Scope,
): boolean {
  const leftLevel = leftScope.get(left);
  const rightLevel = rightScope.get(right);
  if (leftLevel !== undefined || rightLevel !== undefined) return leftLevel === rightLevel;
  return left === right;
}

/** Compare a node's form and every field except the one holding its name or operands. */
export function sameNodeMetadata(
  left: PlainMathJson,
  right: PlainMathJson,
  structuralKey: "sym" | "fn",
): boolean {
  if (typeof left === "string" || typeof right === "string") {
    return typeof left === "string" && typeof right === "string";
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right);
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  return mathJsonEquals(
    withoutKey(left, structuralKey) as PlainMathJson,
    withoutKey(right, structuralKey) as PlainMathJson,
  );
}

function withoutKey(record: object, key: string): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key));
}
