import { z } from "zod";
import { isPlainMathJson, type PlainMathJson } from "./index";

const STABLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** Identifiers are persisted identities, never array positions or display names. */
export const stableIdentifierSchema = z
  .string()
  .min(1)
  .regex(
    STABLE_IDENTIFIER_PATTERN,
    "Identifiers must start with an alphanumeric character and contain only stable ID characters.",
  );

export const declarationIdSchema = stableIdentifierSchema.brand("DeclarationId");
export type DeclarationId = z.infer<typeof declarationIdSchema>;

export const operatorIdSchema = stableIdentifierSchema.brand("OperatorId");
export type OperatorId = z.infer<typeof operatorIdSchema>;

export const sortIdSchema = stableIdentifierSchema.brand("SortId");
export type SortId = z.infer<typeof sortIdSchema>;

export const statementIdSchema = stableIdentifierSchema.brand("StatementId");
export type StatementId = z.infer<typeof statementIdSchema>;

export const proofStateIdSchema = stableIdentifierSchema.brand("ProofStateId");
export type ProofStateId = z.infer<typeof proofStateIdSchema>;

export const wildcardIdSchema = stableIdentifierSchema.brand("WildcardId");
export type WildcardId = z.infer<typeof wildcardIdSchema>;

/** A Zod boundary for persisted, unboxed MathJSON. It does not transform its input. */
export const plainMathJsonSchema = z.custom<PlainMathJson>(isPlainMathJson, {
  message: "Expected serializable plain MathJSON.",
});

export type PropositionSort = Readonly<{ kind: "proposition" }>;

export type NamedSort = Readonly<{
  kind: "named";
  id: SortId;
  arguments?: readonly Sort[] | undefined;
}>;

export type FunctionSort = Readonly<{
  kind: "function";
  signature: Signature;
}>;

export type Sort = PropositionSort | NamedSort | FunctionSort;

export type Signature = Readonly<{
  parameters: readonly Sort[];
  result: Sort;
}>;

export const propositionSortSchema: z.ZodType<PropositionSort> = z
  .object({ kind: z.literal("proposition") })
  .strict();

export const signatureSchema: z.ZodType<Signature> = z.lazy(() =>
  z
    .object({
      parameters: z.array(sortSchema),
      result: sortSchema,
    })
    .strict(),
);

export const sortSchema: z.ZodType<Sort> = z.lazy(() =>
  z.union([
    propositionSortSchema,
    z
      .object({
        kind: z.literal("named"),
        id: sortIdSchema,
        arguments: z.array(sortSchema).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("function"),
        signature: signatureSchema,
      })
      .strict(),
  ]),
);

export const PROPOSITION_SORT: PropositionSort = Object.freeze({ kind: "proposition" });

export function sortEquals(left: Sort, right: Sort): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "proposition" && right.kind === "proposition") return true;
  if (left.kind === "function" && right.kind === "function") {
    return signatureEquals(left.signature, right.signature);
  }
  if (left.kind !== "named" || right.kind !== "named" || left.id !== right.id) return false;

  const leftArguments = left.arguments ?? [];
  const rightArguments = right.arguments ?? [];
  return (
    leftArguments.length === rightArguments.length &&
    leftArguments.every((argument, index) => {
      const rightArgument = rightArguments[index];
      return rightArgument !== undefined && sortEquals(argument, rightArgument);
    })
  );
}

export function signatureEquals(left: Signature, right: Signature): boolean {
  return (
    left.parameters.length === right.parameters.length &&
    left.parameters.every((parameter, index) => {
      const rightParameter = right.parameters[index];
      return rightParameter !== undefined && sortEquals(parameter, rightParameter);
    }) &&
    sortEquals(left.result, right.result)
  );
}

const symbolSchema = z.string().min(1);

export const RESERVED_BUILTIN_SYMBOLS: ReadonlySet<string> = new Set([
  "True",
  "False",
  "Not",
  "Implies",
  "Equivalent",
  "And",
  "Or",
  "ForAll",
  "Exists",
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
  "Add",
  "Multiply",
  "Subtract",
  "Divide",
  "Power",
  "Negate",
  "Abs",
  "Max",
  "Min",
]);

const declarationBaseShape = {
  id: declarationIdSchema,
  symbol: symbolSchema,
  sort: sortSchema,
};

export const universalParameterDeclarationSchema = z
  .object({
    ...declarationBaseShape,
    role: z.literal("universal-parameter"),
  })
  .strict();

export type UniversalParameterDeclaration = z.infer<typeof universalParameterDeclarationSchema>;

export const localWitnessDeclarationSchema = z
  .object({
    ...declarationBaseShape,
    role: z.literal("local-witness"),
  })
  .strict();

export type LocalWitnessDeclaration = z.infer<typeof localWitnessDeclarationSchema>;

export const constructionResolutionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unresolved") }).strict(),
  z
    .object({
      status: z.literal("resolved"),
      value: plainMathJsonSchema,
    })
    .strict(),
]);

export const constructionMetavariableDeclarationSchema = z
  .object({
    ...declarationBaseShape,
    role: z.literal("construction-metavariable"),
    resolution: constructionResolutionSchema,
  })
  .strict();

export type ConstructionMetavariableDeclaration = z.infer<
  typeof constructionMetavariableDeclarationSchema
>;

/** Retrieval wildcards are query-only values and are deliberately not declarations. */
export const retrievalWildcardSchema = z
  .object({
    id: wildcardIdSchema,
    symbol: symbolSchema,
    role: z.literal("retrieval-wildcard"),
    sort: sortSchema.optional(),
  })
  .strict();

export type RetrievalWildcard = z.infer<typeof retrievalWildcardSchema>;

export const declarationSchema = z
  .discriminatedUnion("role", [
    universalParameterDeclarationSchema,
    localWitnessDeclarationSchema,
    constructionMetavariableDeclarationSchema,
  ])
  .superRefine((declaration, context) => {
    if (RESERVED_BUILTIN_SYMBOLS.has(declaration.symbol)) {
      context.addIssue({
        code: "custom",
        message: "A declaration cannot shadow a reserved built-in symbol.",
        path: ["symbol"],
      });
    }
  });

export type Declaration = z.infer<typeof declarationSchema>;

export const declarationsSchema = z
  .array(declarationSchema)
  .superRefine((declarations, context) => {
    addUniqueFieldIssues(declarations, "id", "declaration ID", context);
    addUniqueFieldIssues(declarations, "symbol", "declaration symbol", context);
  });

export const symbolSpecificationSchema = z.union([declarationSchema, retrievalWildcardSchema]);
export type SymbolSpecification = z.infer<typeof symbolSpecificationSchema>;

const operandIndexSchema = z.number().int().nonnegative();

/**
 * The first binding contract supports direct symbol operands with explicit
 * scope operands. More complex patterns must be added deliberately rather than
 * being guessed by traversal code.
 */
export type DirectSymbolBinderSpecification = Readonly<{
  kind: "direct-symbols";
  boundOperands: readonly number[];
  scopedOperands: readonly number[];
}>;

export const directSymbolBinderSpecificationSchema: z.ZodType<DirectSymbolBinderSpecification> = z
  .object({
    kind: z.literal("direct-symbols"),
    boundOperands: z.array(operandIndexSchema).min(1),
    scopedOperands: z.array(operandIndexSchema).min(1),
  })
  .strict()
  .superRefine((binder, context) => {
    addDuplicateIndexIssues(binder.boundOperands, "boundOperands", context);
    addDuplicateIndexIssues(binder.scopedOperands, "scopedOperands", context);

    const bound = new Set(binder.boundOperands);
    binder.scopedOperands.forEach((operand, index) => {
      if (bound.has(operand)) {
        context.addIssue({
          code: "custom",
          message: "A binder operand cannot also be one of its scoped operands.",
          path: ["scopedOperands", index],
        });
      }
    });
  });

export type BinderSpecification = DirectSymbolBinderSpecification;
export const binderSpecificationSchema = directSymbolBinderSpecificationSchema;

function addDuplicateIndexIssues(
  values: readonly number[],
  field: "boundOperands" | "scopedOperands",
  context: z.RefinementCtx,
): void {
  const seen = new Set<number>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: "Binder operand indices must be unique.",
        path: [field, index],
      });
    }
    seen.add(value);
  });
}

export const operatorDeclarationSchema = z
  .object({
    id: operatorIdSchema,
    symbol: symbolSchema,
    signature: signatureSchema,
    binder: binderSpecificationSchema.optional(),
  })
  .strict()
  .superRefine((operator, context) => {
    if (RESERVED_BUILTIN_SYMBOLS.has(operator.symbol)) {
      context.addIssue({
        code: "custom",
        message: "A custom operator cannot replace a reserved built-in operator.",
        path: ["symbol"],
      });
    }
    if (operator.binder === undefined) return;
    const parameterCount = operator.signature.parameters.length;
    for (const field of ["boundOperands", "scopedOperands"] as const) {
      operator.binder[field].forEach((operand, index) => {
        if (operand >= parameterCount) {
          context.addIssue({
            code: "custom",
            message: `Binder operand ${operand} is outside the operator's signature.`,
            path: ["binder", field, index],
          });
        }
      });
    }
  });

export type OperatorDeclaration = z.infer<typeof operatorDeclarationSchema>;

export const operatorDeclarationsSchema = z
  .array(operatorDeclarationSchema)
  .superRefine((operators, context) => {
    addUniqueFieldIssues(operators, "id", "operator ID", context);
    addUniqueFieldIssues(operators, "symbol", "operator symbol", context);
  });

export const BUILTIN_BINDER_SPECIFICATIONS = Object.freeze({
  ForAll: Object.freeze({
    kind: "direct-symbols" as const,
    boundOperands: Object.freeze([0]),
    scopedOperands: Object.freeze([1]),
  }),
  Exists: Object.freeze({
    kind: "direct-symbols" as const,
    boundOperands: Object.freeze([0]),
    scopedOperands: Object.freeze([1]),
  }),
});

export type StatementView = Readonly<{
  /** The exact authoritative MathJSON object supplied by the caller. */
  expression: PlainMathJson;
}>;

export type StatementEnvironment = Readonly<{
  declarations?: readonly Declaration[];
  operators?: readonly OperatorDeclaration[];
}>;

const rawStatementViewSchema: z.ZodType<StatementView> = z
  .object({ expression: plainMathJsonSchema })
  .strict();

/** Build a proposition-valued view validator for an explicit signature environment. */
export function createStatementViewSchema(
  environment: StatementEnvironment = {},
): z.ZodType<StatementView> {
  const validatedEnvironment = parseStatementEnvironment(environment);
  return rawStatementViewSchema.superRefine((view, context) => {
    if (!isPropositionExpression(view.expression, validatedEnvironment)) {
      context.addIssue({
        code: "custom",
        message:
          "The MathJSON expression is not proposition-valued in the supplied signature environment.",
        path: ["expression"],
      });
    }
  });
}

export const statementViewSchema = createStatementViewSchema();

export function parseStatementView(
  expression: unknown,
  environment: StatementEnvironment = {},
): StatementView | undefined {
  const parsed = createStatementViewSchema(environment).safeParse({ expression });
  return parsed.success ? parsed.data : undefined;
}

export function isStatementView(
  value: unknown,
  environment: StatementEnvironment = {},
): value is StatementView {
  return createStatementViewSchema(environment).safeParse(value).success;
}

type ValidatedStatementEnvironment = Readonly<{
  declarations: readonly Declaration[];
  operators: readonly OperatorDeclaration[];
  bindings: ReadonlyMap<string, Sort>;
}>;

function parseStatementEnvironment(
  environment: StatementEnvironment,
): ValidatedStatementEnvironment {
  const declarations = declarationsSchema.parse(environment.declarations ?? []);
  const operators = operatorDeclarationsSchema.parse(environment.operators ?? []);
  const operatorSymbols = new Set(operators.map((operator) => operator.symbol));
  const collision = declarations.find((declaration) => operatorSymbols.has(declaration.symbol));
  if (collision !== undefined) {
    throw new Error(
      `The symbol ${collision.symbol} cannot be both a local declaration and an operator.`,
    );
  }
  return {
    declarations,
    operators,
    bindings: new Map(declarations.map((declaration) => [declaration.symbol, declaration.sort])),
  };
}

const LOGICAL_ARITIES: Readonly<Record<string, number | "variadic">> = Object.freeze({
  Not: 1,
  Implies: 2,
  Equivalent: 2,
  And: "variadic",
  Or: "variadic",
});

const RELATION_ARITIES: Readonly<Record<string, number | "variadic">> = Object.freeze({
  Equal: "variadic",
  NotEqual: "variadic",
  Less: "variadic",
  LessEqual: "variadic",
  Greater: "variadic",
  GreaterEqual: "variadic",
  Element: 2,
  NotElement: 2,
  Subset: 2,
  SubsetEqual: 2,
  Superset: 2,
  SupersetEqual: 2,
});

const HOMOGENEOUS_TERM_ARITIES: Readonly<Record<string, number | "variadic">> = Object.freeze({
  Add: "variadic",
  Multiply: "variadic",
  Subtract: 2,
  Divide: 2,
  Power: 2,
  Negate: 1,
  Abs: 1,
  Max: "variadic",
  Min: "variadic",
});

type NumericLiteralSort = Readonly<{
  kind: "numeric-literal";
  natural: boolean;
  integer: boolean;
}>;
type InferredSort = Sort | NumericLiteralSort;

const NUMERIC_SORT_IDS = new Set([
  "sort:natural",
  "sort:integer",
  "sort:rational",
  "sort:real",
  "sort:complex",
]);

const STRING_SORT = Object.freeze({
  kind: "named" as const,
  id: "sort:string" as SortId,
});
const DICTIONARY_SORT = Object.freeze({
  kind: "named" as const,
  id: "sort:dictionary" as SortId,
});

type ScopedEnvironment = Omit<ValidatedStatementEnvironment, "bindings"> &
  Readonly<{ bindings: ReadonlyMap<string, InferredSort> }>;

function isPropositionExpression(
  expression: PlainMathJson,
  environment: ValidatedStatementEnvironment,
): boolean {
  return validatesAsSort(expression, PROPOSITION_SORT, environment);
}

function arityMatches(actual: number, expected: number | "variadic"): boolean {
  return expected === "variadic" ? actual >= 2 : actual === expected;
}

function validatesAsSort(
  expression: PlainMathJson,
  expected: Sort,
  environment: ScopedEnvironment,
): boolean {
  const actual = inferExpressionSort(expression, environment);
  return actual !== undefined && inferredSortMatches(actual, expected);
}

function inferExpressionSort(
  expression: PlainMathJson,
  environment: ScopedEnvironment,
): InferredSort | undefined {
  if (typeof expression === "number") return numericLiteralSort(expression);

  const symbol = symbolValue(expression);
  if (symbol !== undefined) {
    if (symbol === "True" || symbol === "False") return PROPOSITION_SORT;
    return environment.bindings.get(symbol);
  }

  const numberValue = expressionObjectValue(expression, "num");
  if (typeof numberValue === "string") return numericLiteralSort(numberValue);
  if (isExpressionObject(expression, "str")) return STRING_SORT;
  if (isExpressionObject(expression, "dict")) return DICTIONARY_SORT;

  const parts = functionParts(expression);
  if (parts === undefined) return undefined;

  if (parts.operator === "ForAll" || parts.operator === "Exists") {
    return inferBuiltinBinderSort(parts.operands, environment);
  }

  const logicalArity = LOGICAL_ARITIES[parts.operator];
  if (logicalArity !== undefined) {
    if (!arityMatches(parts.operands.length, logicalArity)) return undefined;
    return parts.operands.every((operand) =>
      validatesAsSort(operand, PROPOSITION_SORT, environment),
    )
      ? PROPOSITION_SORT
      : undefined;
  }

  const relationArity = RELATION_ARITIES[parts.operator];
  if (relationArity !== undefined) {
    if (!arityMatches(parts.operands.length, relationArity)) return undefined;
    return validateRelationOperands(parts.operator, parts.operands, environment)
      ? PROPOSITION_SORT
      : undefined;
  }

  const termArity = HOMOGENEOUS_TERM_ARITIES[parts.operator];
  if (termArity !== undefined) {
    if (!arityMatches(parts.operands.length, termArity)) return undefined;
    const operandSort = inferCompatibleOperandSort(parts.operands, environment, false);
    return operandSort !== undefined && isNumericInferredSort(operandSort)
      ? operandSort
      : undefined;
  }

  const operator = environment.operators.find((candidate) => candidate.symbol === parts.operator);
  const declaredSort = environment.bindings.get(parts.operator);
  const signature =
    operator?.signature ?? (declaredSort?.kind === "function" ? declaredSort.signature : undefined);
  if (signature === undefined || signature.parameters.length !== parts.operands.length) {
    return undefined;
  }

  return validateSignatureApplication(parts.operands, signature, operator?.binder, environment)
    ? signature.result
    : undefined;
}

function inferBuiltinBinderSort(
  operands: readonly PlainMathJson[],
  environment: ScopedEnvironment,
): InferredSort | undefined {
  if (operands.length !== 2) return undefined;
  const boundSymbol = symbolValue(operands[0] as PlainMathJson);
  if (boundSymbol === undefined) return undefined;

  const boundSort = environment.bindings.get(boundSymbol);
  if (boundSort === undefined) return undefined;
  const bindings = new Map(environment.bindings);
  bindings.set(boundSymbol, boundSort);
  const scopedEnvironment: ScopedEnvironment = { ...environment, bindings };
  return validatesAsSort(operands[1] as PlainMathJson, PROPOSITION_SORT, scopedEnvironment)
    ? PROPOSITION_SORT
    : undefined;
}

function validateSignatureApplication(
  operands: readonly PlainMathJson[],
  signature: Signature,
  binder: BinderSpecification | undefined,
  environment: ScopedEnvironment,
): boolean {
  if (binder === undefined) {
    return operands.every((operand, index) => {
      const expected = signature.parameters[index];
      return expected !== undefined && validatesAsSort(operand, expected, environment);
    });
  }

  const boundIndices = new Set(binder.boundOperands);
  const scopedIndices = new Set(binder.scopedOperands);
  const bindings = new Map(environment.bindings);
  const boundNames = new Set<string>();

  for (const index of binder.boundOperands) {
    const operand = operands[index];
    const parameterSort = signature.parameters[index];
    const name = operand === undefined ? undefined : symbolValue(operand);
    if (
      name === undefined ||
      parameterSort === undefined ||
      boundNames.has(name) ||
      RESERVED_BUILTIN_SYMBOLS.has(name) ||
      environment.operators.some((operator) => operator.symbol === name)
    ) {
      return false;
    }
    boundNames.add(name);
    bindings.set(name, parameterSort);
  }

  const scopedEnvironment: ScopedEnvironment = { ...environment, bindings };
  return operands.every((operand, index) => {
    if (boundIndices.has(index)) return true;
    const expected = signature.parameters[index];
    if (expected === undefined) return false;
    return validatesAsSort(
      operand,
      expected,
      scopedIndices.has(index) ? scopedEnvironment : environment,
    );
  });
}

function validateRelationOperands(
  operator: string,
  operands: readonly PlainMathJson[],
  environment: ScopedEnvironment,
): boolean {
  if (operator === "Element" || operator === "NotElement") {
    const element = inferExpressionSort(operands[0] as PlainMathJson, environment);
    const container = inferExpressionSort(operands[1] as PlainMathJson, environment);
    if (element === undefined || container === undefined) return false;
    if (!isNumericLiteralSort(container) && container.kind === "named") {
      const memberSort = container.id === "sort:set" ? container.arguments?.[0] : undefined;
      return memberSort !== undefined && inferredSortMatches(element, memberSort);
    }
    return false;
  }

  const isEquality = operator === "Equal" || operator === "NotEqual";
  const inferred = inferCompatibleOperandSort(operands, environment, isEquality);
  if (inferred === undefined) return false;

  if (
    operator === "Subset" ||
    operator === "SubsetEqual" ||
    operator === "Superset" ||
    operator === "SupersetEqual"
  ) {
    return isSetSort(inferred);
  }

  return isEquality || isNumericInferredSort(inferred);
}

function inferCompatibleOperandSort(
  operands: readonly PlainMathJson[],
  environment: ScopedEnvironment,
  allowProposition: boolean,
): InferredSort | undefined {
  let concrete: Sort | undefined;
  let fallback: InferredSort | undefined;

  for (const operand of operands) {
    const current = inferExpressionSort(operand, environment);
    if (current === undefined) return undefined;
    fallback ??= current;
    if (isNumericLiteralSort(current)) continue;
    if (!allowProposition && current.kind === "proposition") return undefined;
    if (concrete !== undefined && !sortEquals(concrete, current)) return undefined;
    concrete = current;
  }

  if (concrete !== undefined) {
    return operands.every((operand) => validatesAsSort(operand, concrete, environment))
      ? concrete
      : undefined;
  }
  return fallback;
}

function inferredSortMatches(actual: InferredSort, expected: Sort): boolean {
  if (isNumericLiteralSort(actual)) return numericLiteralMatches(actual, expected);
  return sortEquals(actual, expected);
}

function isNumericInferredSort(sort: InferredSort): boolean {
  return isNumericLiteralSort(sort) || isNumericSort(sort);
}

function isNumericSort(sort: Sort): boolean {
  return sort.kind === "named" && NUMERIC_SORT_IDS.has(sort.id);
}

function isSetSort(sort: InferredSort): boolean {
  return !isNumericLiteralSort(sort) && sort.kind === "named" && sort.id === "sort:set";
}

function isNumericLiteralSort(sort: InferredSort): sort is NumericLiteralSort {
  return sort.kind === "numeric-literal";
}

function numericLiteralSort(value: number | string): NumericLiteralSort | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return {
      kind: "numeric-literal",
      natural: Number.isInteger(value) && value >= 0,
      integer: Number.isInteger(value),
    };
  }
  if (value === "NaN" || value === "-Infinity" || value === "+Infinity") return undefined;
  return {
    kind: "numeric-literal",
    natural: /^\d+$/.test(value),
    integer: /^-?\d+$/.test(value),
  };
}

function numericLiteralMatches(literal: NumericLiteralSort, expected: Sort): boolean {
  if (expected.kind !== "named") return false;
  if (expected.id === "sort:natural") return literal.natural;
  if (expected.id === "sort:integer") return literal.integer;
  return (
    expected.id === "sort:rational" || expected.id === "sort:real" || expected.id === "sort:complex"
  );
}

function isExpressionObject(expression: PlainMathJson, property: "num" | "str" | "dict"): boolean {
  return (
    typeof expression === "object" &&
    expression !== null &&
    !Array.isArray(expression) &&
    property in expression
  );
}

function expressionObjectValue(
  expression: PlainMathJson,
  property: "num" | "str" | "dict",
): unknown {
  if (!isExpressionObject(expression, property)) return undefined;
  return (expression as Readonly<Record<string, unknown>>)[property];
}

function symbolValue(expression: PlainMathJson): string | undefined {
  if (typeof expression === "string") return expression;
  if (typeof expression !== "object" || expression === null || Array.isArray(expression)) {
    return undefined;
  }
  const symbol = (expression as Readonly<Record<string, unknown>>).sym;
  return typeof symbol === "string" ? symbol : undefined;
}

function functionParts(
  expression: PlainMathJson,
): Readonly<{ operator: string; operands: readonly PlainMathJson[] }> | undefined {
  if (Array.isArray(expression)) {
    const operator = expression[0];
    if (typeof operator !== "string") return undefined;
    return { operator, operands: expression.slice(1) as readonly PlainMathJson[] };
  }
  if (typeof expression !== "object" || expression === null) return undefined;

  const fn = (expression as Readonly<Record<string, unknown>>).fn;
  if (!Array.isArray(fn) || typeof fn[0] !== "string") return undefined;
  return { operator: fn[0], operands: fn.slice(1) as readonly PlainMathJson[] };
}

function freeSymbolNames(
  expression: PlainMathJson,
  operators: readonly OperatorDeclaration[],
  boundNames: ReadonlySet<string> = new Set(),
  result: Set<string> = new Set(),
): Set<string> {
  const symbol = symbolValue(expression);
  if (symbol !== undefined) {
    if (!boundNames.has(symbol)) result.add(symbol);
    return result;
  }

  const parts = functionParts(expression);
  if (parts === undefined) return result;
  if (!boundNames.has(parts.operator)) result.add(parts.operator);

  const binder =
    parts.operator === "ForAll" || parts.operator === "Exists"
      ? BUILTIN_BINDER_SPECIFICATIONS[parts.operator]
      : operators.find((operator) => operator.symbol === parts.operator)?.binder;
  if (binder === undefined) {
    parts.operands.forEach((operand) => freeSymbolNames(operand, operators, boundNames, result));
    return result;
  }

  const boundOperands = new Set(binder.boundOperands);
  const scopedOperands = new Set(binder.scopedOperands);
  const nestedNames = new Set(boundNames);
  binder.boundOperands.forEach((index) => {
    const operand = parts.operands[index];
    const name = operand === undefined ? undefined : symbolValue(operand);
    if (name !== undefined) nestedNames.add(name);
  });

  parts.operands.forEach((operand, index) => {
    if (boundOperands.has(index)) return;
    freeSymbolNames(
      operand,
      operators,
      scopedOperands.has(index) ? nestedNames : boundNames,
      result,
    );
  });
  return result;
}

function cyclicConstructionSymbols(
  proofContext: ProofContext,
  operators: readonly OperatorDeclaration[],
): ReadonlySet<string> {
  const constructions = new Map(
    proofContext.declarations
      .filter(
        (declaration): declaration is ConstructionMetavariableDeclaration =>
          declaration.role === "construction-metavariable",
      )
      .map((declaration) => [declaration.symbol, declaration]),
  );
  const dependencies = new Map<string, ReadonlySet<string>>();

  constructions.forEach((declaration, symbol) => {
    if (declaration.resolution.status !== "resolved") {
      dependencies.set(symbol, new Set());
      return;
    }
    dependencies.set(
      symbol,
      new Set(
        [...freeSymbolNames(declaration.resolution.value, operators)].filter((name) =>
          constructions.has(name),
        ),
      ),
    );
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();

  const visit = (symbol: string): void => {
    if (visited.has(symbol)) return;
    if (visiting.has(symbol)) {
      const start = stack.lastIndexOf(symbol);
      stack.slice(start).forEach((member) => cyclic.add(member));
      return;
    }

    visiting.add(symbol);
    stack.push(symbol);
    dependencies.get(symbol)?.forEach(visit);
    stack.pop();
    visiting.delete(symbol);
    visited.add(symbol);
  };

  constructions.forEach((_declaration, symbol) => visit(symbol));
  return cyclic;
}

export const hypothesisShapeSchema = z
  .object({
    id: statementIdSchema,
    statement: rawStatementViewSchema,
  })
  .strict();

export type Hypothesis = z.infer<typeof hypothesisShapeSchema>;

const proofContextShapeSchema = z
  .object({
    declarations: z.array(declarationSchema),
    hypotheses: z.array(hypothesisShapeSchema),
  })
  .strict()
  .superRefine((proofContext, context) => {
    addUniqueFieldIssues(proofContext.declarations, "id", "declaration ID", context, [
      "declarations",
    ]);
    addUniqueFieldIssues(proofContext.declarations, "symbol", "declaration symbol", context, [
      "declarations",
    ]);
    addUniqueFieldIssues(proofContext.hypotheses, "id", "hypothesis ID", context, ["hypotheses"]);
  });

export type ProofContext = z.infer<typeof proofContextShapeSchema>;

export function createProofContextSchema(
  environment: Omit<StatementEnvironment, "declarations"> = {},
): z.ZodType<ProofContext> {
  const operators = operatorDeclarationsSchema.parse(environment.operators ?? []);
  return proofContextShapeSchema.superRefine((proofContext, context) => {
    addContextIssues(proofContext, operators, context, [], false);
  });
}

/** Semantic proof-context validation with the built-in operator environment. */
export const proofContextSchema = createProofContextSchema();

const rawContextualSequentSchema = z
  .object({
    context: proofContextShapeSchema,
    conclusion: rawStatementViewSchema,
  })
  .strict();

export type ContextualSequent = z.infer<typeof rawContextualSequentSchema>;

export function createContextualSequentSchema(
  environment: Omit<StatementEnvironment, "declarations"> = {},
): z.ZodType<ContextualSequent> {
  const operators = operatorDeclarationsSchema.parse(environment.operators ?? []);
  return rawContextualSequentSchema.superRefine((sequent, context) => {
    addStatementIssues(sequent, operators, context);
  });
}

export const contextualSequentSchema = createContextualSequentSchema();

function addStatementIssues(
  sequent: ContextualSequent,
  operators: readonly OperatorDeclaration[],
  context: z.RefinementCtx,
  prefix: readonly PropertyKey[] = [],
): void {
  const environment = addContextIssues(sequent.context, operators, context, prefix);
  if (!isPropositionExpression(sequent.conclusion.expression, environment)) {
    context.addIssue({
      code: "custom",
      message: "A conclusion must be proposition-valued in its own sequent context.",
      path: [...prefix, "conclusion", "expression"],
    });
  }
}

function addContextIssues(
  proofContext: ProofContext,
  operators: readonly OperatorDeclaration[],
  context: z.RefinementCtx,
  prefix: readonly PropertyKey[] = [],
  nestedInSequent = true,
): ValidatedStatementEnvironment {
  const contextPath = nestedInSequent ? [...prefix, "context"] : [...prefix];
  const operatorSymbols = new Set(operators.map((operator) => operator.symbol));
  proofContext.declarations.forEach((declaration, index) => {
    if (operatorSymbols.has(declaration.symbol)) {
      context.addIssue({
        code: "custom",
        message: "A local declaration cannot shadow an operator in the same environment.",
        path: [...contextPath, "declarations", index, "symbol"],
      });
    }
  });

  const environment: ValidatedStatementEnvironment = {
    declarations: proofContext.declarations,
    operators,
    bindings: new Map(
      proofContext.declarations.map((declaration) => [declaration.symbol, declaration.sort]),
    ),
  };

  proofContext.declarations.forEach((declaration, index) => {
    if (
      declaration.role === "construction-metavariable" &&
      declaration.resolution.status === "resolved" &&
      !validatesAsSort(declaration.resolution.value, declaration.sort, environment)
    ) {
      context.addIssue({
        code: "custom",
        message: "A resolved construction value must have the declaration's sort.",
        path: [...contextPath, "declarations", index, "resolution", "value"],
      });
    }
  });

  const cyclicSymbols = cyclicConstructionSymbols(proofContext, operators);
  proofContext.declarations.forEach((declaration, index) => {
    if (declaration.role === "construction-metavariable" && cyclicSymbols.has(declaration.symbol)) {
      context.addIssue({
        code: "custom",
        message: "Resolved construction values cannot contain a dependency cycle.",
        path: [...contextPath, "declarations", index, "resolution"],
      });
    }
  });

  proofContext.hypotheses.forEach((hypothesis, index) => {
    if (!isPropositionExpression(hypothesis.statement.expression, environment)) {
      context.addIssue({
        code: "custom",
        message: "A hypothesis must be proposition-valued in its own context.",
        path: [...contextPath, "hypotheses", index, "statement", "expression"],
      });
    }
  });

  return environment;
}

const goalShapeSchema = z
  .object({
    id: statementIdSchema,
    sequent: rawContextualSequentSchema,
  })
  .strict();

export type Goal = z.infer<typeof goalShapeSchema>;

const obligationShapeSchema = z
  .object({
    id: statementIdSchema,
    sequent: rawContextualSequentSchema,
  })
  .strict();

export type Obligation = z.infer<typeof obligationShapeSchema>;

const rawProofStateSchema = z
  .object({
    id: proofStateIdSchema,
    goals: z.array(goalShapeSchema),
    obligations: z.array(obligationShapeSchema),
  })
  .strict();

export type ProofState = z.infer<typeof rawProofStateSchema>;
declare const executableProofStateBrand: unique symbol;
export type ExecutableProofState = ProofState &
  Readonly<{ [executableProofStateBrand]: "ExecutableProofState" }>;

export type ProofStateSchemaOptions = Readonly<{
  operators?: readonly OperatorDeclaration[];
}>;

function createValidatedProofStateSchema(
  options: ProofStateSchemaOptions = {},
  executable: boolean,
): z.ZodType<ProofState> {
  const operators = operatorDeclarationsSchema.parse(options.operators ?? []);
  return rawProofStateSchema.superRefine((proofState, context) => {
    addUniqueFieldIssues(
      [...proofState.goals, ...proofState.obligations],
      "id",
      "goal or obligation ID",
      context,
    );

    proofState.goals.forEach((goal, index) => {
      addStatementIssues(goal.sequent, operators, context, ["goals", index, "sequent"]);
      if (executable) {
        addUnresolvedConstructionIssues(goal.sequent, context, ["goals", index, "sequent"]);
      }
    });
    proofState.obligations.forEach((obligation, index) => {
      addStatementIssues(obligation.sequent, operators, context, ["obligations", index, "sequent"]);
      if (executable) {
        addUnresolvedConstructionIssues(obligation.sequent, context, [
          "obligations",
          index,
          "sequent",
        ]);
      }
    });
  });
}

export function createProofStateSchema(
  options: ProofStateSchemaOptions = {},
): z.ZodType<ProofState> {
  return createValidatedProofStateSchema(options, false);
}

export function createExecutableProofStateSchema(
  options: ProofStateSchemaOptions = {},
): z.ZodType<ExecutableProofState> {
  return createValidatedProofStateSchema(options, true).transform(
    (proofState) => proofState as ExecutableProofState,
  );
}

/** Draft states may retain explicit, unresolved construction tasks. */
export const proofStateSchema = createProofStateSchema();

/** Only this schema admits a state to executable kernel operations. */
export const executableProofStateSchema = createExecutableProofStateSchema();

function addUnresolvedConstructionIssues(
  sequent: ContextualSequent,
  context: z.RefinementCtx,
  prefix: readonly PropertyKey[],
): void {
  sequent.context.declarations.forEach((declaration, index) => {
    if (
      declaration.role === "construction-metavariable" &&
      declaration.resolution.status === "unresolved"
    ) {
      context.addIssue({
        code: "custom",
        message: "Executable proof states cannot contain unresolved construction metavariables.",
        path: [...prefix, "context", "declarations", index, "resolution"],
      });
    }
  });
}

function addUniqueFieldIssues<T extends Readonly<Record<K, unknown>>, K extends keyof T>(
  values: readonly T[],
  field: K,
  label: string,
  context: z.RefinementCtx,
  prefix: readonly PropertyKey[] = [],
): void {
  const seen = new Set<unknown>();
  values.forEach((value, index) => {
    if (seen.has(value[field])) {
      context.addIssue({
        code: "custom",
        message: `Each ${label} must be unique in its scope.`,
        path: [...prefix, index, field],
      });
    }
    seen.add(value[field]);
  });
}
