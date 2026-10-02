import { z } from "zod";
import { isPlainMathJson, type PlainMathJson } from "./index";
import {
  binderShape,
  readBinderDeclaration,
  type BinderDeclaration,
  type BinderShape,
} from "./binders";

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

/** Opaque reference to an externally recorded attestation. The kernel never dereferences it. */
export const attestationIdSchema = stableIdentifierSchema.brand("AttestationId");
export type AttestationId = z.infer<typeof attestationIdSchema>;

/** Construction tasks (refinement §5) and the records they accumulate. */
export const constructionTaskIdSchema = stableIdentifierSchema.brand("ConstructionTaskId");
export type ConstructionTaskId = z.infer<typeof constructionTaskIdSchema>;

export const constructionRequirementIdSchema = stableIdentifierSchema.brand(
  "ConstructionRequirementId",
);
export type ConstructionRequirementId = z.infer<typeof constructionRequirementIdSchema>;

export const constructionCandidateIdSchema =
  stableIdentifierSchema.brand("ConstructionCandidateId");
export type ConstructionCandidateId = z.infer<typeof constructionCandidateIdSchema>;

/**
 * Opaque reference to the discovery attempt (a command, edge, or branch) that produced a
 * construction record. It is recorded, never dereferenced.
 */
export const constructionAttemptIdSchema = stableIdentifierSchema.brand("ConstructionAttemptId");
export type ConstructionAttemptId = z.infer<typeof constructionAttemptIdSchema>;

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
  // Term-language constructors and binders (design plan §5.2, §5.4).
  "Function",
  "Apply",
  "Tuple",
  "Set",
  "List",
  "At",
  "Sum",
  "Product",
  "Integrate",
  "Limit",
  "Limits",
  "PositiveInfinity",
  "NegativeInfinity",
  // Standard sets, usable as the domain of a typed binder `["Element", x, S]`.
  "NonNegativeIntegers",
  "Integers",
  "RationalNumbers",
  "RealNumbers",
  "ComplexNumbers",
  "Booleans",
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

/**
 * Precedence/fixity classes for operator LaTeX templates, from tightest to loosest. An `atom`
 * template delimits its own operands (for example `\operatorname{gcd}\left(#1, #2\right)`), so
 * operands are never parenthesized; every other class parenthesizes operands that bind no tighter.
 */
export const OPERATOR_LATEX_PRECEDENCES = [
  "atom",
  "postfix",
  "prefix",
  "power",
  "multiplicative",
  "additive",
  "relation",
  "conjunction",
  "disjunction",
  "implication",
  "equivalence",
] as const;
export const operatorLatexPrecedenceSchema = z.enum(OPERATOR_LATEX_PRECEDENCES);
export type OperatorLatexPrecedence = z.infer<typeof operatorLatexPrecedenceSchema>;

const LATEX_COMMAND_TRIGGER_PATTERN = /^\\[A-Za-z]+$/;
const LATEX_NAMED_FUNCTION_TRIGGER_PATTERN = /^\\(?:operatorname|mathrm)\{[A-Za-z][A-Za-z0-9]*\}$/;

/**
 * How LaTeX input is parsed back into this operator. `trigger` is a LaTeX command such as
 * `\divides`, or for `function` notation also `\operatorname{name}`.
 */
export const operatorLatexParseSchema = z
  .object({
    trigger: z.string().min(1),
    notation: z.enum(["function", "infix", "prefix"]),
  })
  .strict();
export type OperatorLatexParse = z.infer<typeof operatorLatexParseSchema>;

/** `#1`, `#2`, ... refer to the operator's operands in signature order. `\#` is a literal hash. */
export const operatorLatexPresentationSchema = z
  .object({
    template: z.string().min(1),
    precedence: operatorLatexPrecedenceSchema,
    parse: operatorLatexParseSchema.optional(),
  })
  .strict();
export type OperatorLatexPresentation = z.infer<typeof operatorLatexPresentationSchema>;

/**
 * A natural-language template. Placeholders outside `$...$` are rendered as natural language,
 * inside `$...$` as raw LaTeX. `proposition` marks a clause ("#1 divides #2") rather than a noun
 * phrase ("the greatest common divisor of #1 and #2"); it defaults to the signature's result.
 * `negated` is the clause for the negation of a proposition-valued operator.
 */
export const operatorNaturalLanguageTemplateSchema = z
  .object({
    template: z.string().min(1),
    proposition: z.boolean().optional(),
    negated: z.string().min(1).optional(),
  })
  .strict();
export type OperatorNaturalLanguageTemplate = z.infer<typeof operatorNaturalLanguageTemplateSchema>;

/** Optional presentation metadata. The first natural-language template is the preferred one. */
export const operatorPresentationSchema = z
  .object({
    displayName: z.string().min(1),
    latex: operatorLatexPresentationSchema.optional(),
    naturalLanguage: z.array(operatorNaturalLanguageTemplateSchema).min(1).optional(),
    domains: z.array(z.string().min(1)).optional(),
    notations: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type OperatorPresentation = z.infer<typeof operatorPresentationSchema>;

export type OperatorTemplateSegment =
  Readonly<{ kind: "text"; text: string }> | Readonly<{ kind: "operand"; index: number }>;

/**
 * Split an operator template into literal text and zero-based operand references. Returns
 * `undefined` for a malformed template: an unescaped `#` not followed by a positive index.
 */
export function operatorTemplateSegments(
  template: string,
): readonly OperatorTemplateSegment[] | undefined {
  const segments: OperatorTemplateSegment[] = [];
  let text = "";
  let position = 0;
  while (position < template.length) {
    const character = template[position];
    if (character === "\\" && template[position + 1] === "#") {
      text += "\\#";
      position += 2;
      continue;
    }
    if (character !== "#") {
      text += character;
      position += 1;
      continue;
    }
    const digits = /^[1-9]\d*/.exec(template.slice(position + 1))?.[0];
    if (digits === undefined) return undefined;
    if (text.length > 0) segments.push(Object.freeze({ kind: "text", text }));
    text = "";
    segments.push(Object.freeze({ kind: "operand", index: Number(digits) - 1 }));
    position += 1 + digits.length;
  }
  if (text.length > 0) segments.push(Object.freeze({ kind: "text", text }));
  return Object.freeze(segments);
}

function addTemplateIssues(
  template: string,
  arity: number,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  const segments = operatorTemplateSegments(template);
  if (segments === undefined) {
    context.addIssue({
      code: "custom",
      message: "A template placeholder must be # followed by a positive operand index.",
      path: [...path],
    });
    return;
  }
  const referenced = new Set<number>();
  for (const segment of segments) {
    if (segment.kind !== "operand") continue;
    referenced.add(segment.index);
    if (segment.index >= arity) {
      context.addIssue({
        code: "custom",
        message: `Placeholder #${segment.index + 1} is outside the operator's signature.`,
        path: [...path],
      });
    }
  }
  for (let index = 0; index < arity; index += 1) {
    if (!referenced.has(index)) {
      context.addIssue({
        code: "custom",
        message: `The template does not render operand #${index + 1}.`,
        path: [...path],
      });
    }
  }
}

function addPresentationIssues(
  presentation: OperatorPresentation,
  signature: Signature,
  context: z.RefinementCtx,
): void {
  const arity = signature.parameters.length;
  const latex = presentation.latex;
  if (latex !== undefined) {
    addTemplateIssues(latex.template, arity, context, ["presentation", "latex", "template"]);
    const parse = latex.parse;
    if (parse !== undefined) {
      const path = ["presentation", "latex", "parse"];
      const validTrigger =
        LATEX_COMMAND_TRIGGER_PATTERN.test(parse.trigger) ||
        (parse.notation === "function" && LATEX_NAMED_FUNCTION_TRIGGER_PATTERN.test(parse.trigger));
      if (!validTrigger) {
        context.addIssue({
          code: "custom",
          message: "A parse trigger must be a LaTeX command such as \\name.",
          path: [...path, "trigger"],
        });
      } else if (!latex.template.includes(parse.trigger)) {
        context.addIssue({
          code: "custom",
          message: "The parse trigger must occur in the serialization template.",
          path: [...path, "trigger"],
        });
      }
      if (parse.notation === "infix" && arity !== 2) {
        context.addIssue({
          code: "custom",
          message: "An infix parse trigger requires a binary operator.",
          path: [...path, "notation"],
        });
      }
      if (parse.notation === "prefix" && arity !== 1) {
        context.addIssue({
          code: "custom",
          message: "A prefix parse trigger requires a unary operator.",
          path: [...path, "notation"],
        });
      }
    }
  }

  const propositionValued = signature.result.kind === "proposition";
  presentation.naturalLanguage?.forEach((entry, index) => {
    const path = ["presentation", "naturalLanguage", index];
    addTemplateIssues(entry.template, arity, context, [...path, "template"]);
    if (entry.proposition !== undefined && entry.proposition !== propositionValued) {
      context.addIssue({
        code: "custom",
        message: "The proposition flag must agree with the operator's result sort.",
        path: [...path, "proposition"],
      });
    }
    if (entry.negated !== undefined) {
      if (!propositionValued) {
        context.addIssue({
          code: "custom",
          message: "Only proposition-valued operators can have a negated template.",
          path: [...path, "negated"],
        });
      }
      addTemplateIssues(entry.negated, arity, context, [...path, "negated"]);
    }
  });
}

export const operatorDeclarationSchema = z
  .object({
    id: operatorIdSchema,
    symbol: symbolSchema,
    signature: signatureSchema,
    binder: binderSpecificationSchema.optional(),
    presentation: operatorPresentationSchema.optional(),
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
    if (operator.presentation !== undefined) {
      addPresentationIssues(operator.presentation, operator.signature, context);
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
    const triggers = new Set<string>();
    operators.forEach((operator, index) => {
      const trigger = operator.presentation?.latex?.parse?.trigger;
      if (trigger === undefined) return;
      if (triggers.has(trigger)) {
        context.addIssue({
          code: "custom",
          message: "Each LaTeX parse trigger must be unique in its scope.",
          path: [index, "presentation", "latex", "parse", "trigger"],
        });
      }
      triggers.add(trigger);
    });
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
const SET_SORT_ID = "sort:set" as SortId;
const LIST_SORT_ID = "sort:list" as SortId;
const TUPLE_SORT_ID = "sort:tuple" as SortId;
const SEQUENCE_SORT_ID = "sort:sequence" as SortId;
const NATURAL_SORT: NamedSort = Object.freeze({ kind: "named", id: "sort:natural" as SortId });
const INTEGER_SORT: NamedSort = Object.freeze({ kind: "named", id: "sort:integer" as SortId });
const REAL_SORT: NamedSort = Object.freeze({ kind: "named", id: "sort:real" as SortId });

/** Member sorts of the standard Compute Engine sets that may type a binder. */
const STANDARD_SET_MEMBER_SORTS: ReadonlyMap<string, Sort> = new Map<string, Sort>([
  ["NonNegativeIntegers", NATURAL_SORT],
  ["Integers", INTEGER_SORT],
  ["RationalNumbers", Object.freeze({ kind: "named", id: "sort:rational" as SortId })],
  ["RealNumbers", REAL_SORT],
  ["ComplexNumbers", Object.freeze({ kind: "named", id: "sort:complex" as SortId })],
  ["Booleans", PROPOSITION_SORT],
]);

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

/**
 * Check an expression against an expected sort. Collection, tuple, and lambda literals are checked
 * structurally, so `["Set"]`, `["Tuple", 1, 2]`, and `["Function", 1, "x"]` validate where their
 * sort is known from context although it cannot be inferred bottom-up. An untyped lambda
 * parameter takes the expected parameter sort. Everything else is inferred and compared.
 */
function validatesAsSort(
  expression: PlainMathJson,
  expected: Sort,
  environment: ScopedEnvironment,
): boolean {
  const structural = checkLiteralAgainstSort(expression, expected, environment);
  if (structural !== undefined) return structural;
  const actual = inferExpressionSort(expression, environment);
  return actual !== undefined && inferredSortMatches(actual, expected);
}

function checkLiteralAgainstSort(
  expression: PlainMathJson,
  expected: Sort,
  environment: ScopedEnvironment,
): boolean | undefined {
  const parts = functionParts(expression);
  if (parts === undefined || environment.bindings.has(parts.operator)) return undefined;
  const { operator, operands } = parts;
  if ((operator === "Set" || operator === "List") && expected.kind === "named") {
    const member = collectionMemberSort(expected, operator === "Set" ? SET_SORT_ID : LIST_SORT_ID);
    if (member === undefined) return undefined;
    return operands.every((operand) => validatesAsSort(operand, member, environment));
  }
  if (operator === "Tuple" && expected.kind === "named" && expected.id === TUPLE_SORT_ID) {
    const components = expected.arguments ?? [];
    return (
      operands.length >= 1 &&
      components.length === operands.length &&
      operands.every((operand, index) =>
        validatesAsSort(operand, components[index] as Sort, environment),
      )
    );
  }
  if (operator === "Function" && expected.kind === "function") {
    const scope = functionLiteralScope(operands, environment, expected.signature.parameters);
    return (
      scope !== undefined &&
      scope.parameters.length === expected.signature.parameters.length &&
      scope.parameters.every((parameter, index) =>
        sortEquals(parameter, expected.signature.parameters[index] as Sort),
      ) &&
      validatesAsSort(operands[0] as PlainMathJson, expected.signature.result, scope.environment)
    );
  }
  return undefined;
}

function inferExpressionSort(
  expression: PlainMathJson,
  environment: ScopedEnvironment,
): InferredSort | undefined {
  if (typeof expression === "number") return numericLiteralSort(expression);

  const symbol = symbolValue(expression);
  if (symbol !== undefined) {
    if (symbol === "True" || symbol === "False") return PROPOSITION_SORT;
    const bound = environment.bindings.get(symbol);
    if (bound !== undefined) return bound;
    const member = STANDARD_SET_MEMBER_SORTS.get(symbol);
    return member === undefined ? undefined : setSort(member);
  }

  const numberValue = expressionObjectValue(expression, "num");
  if (typeof numberValue === "string") return numericLiteralSort(numberValue);
  if (isExpressionObject(expression, "str")) return STRING_SORT;
  if (isExpressionObject(expression, "dict")) return DICTIONARY_SORT;

  const parts = functionParts(expression);
  if (parts === undefined) return undefined;

  // A locally bound head is a function variable, never a built-in constructor.
  const termSort = environment.bindings.has(parts.operator)
    ? undefined
    : inferTermConstructorSort(parts.operator, parts.operands, environment);
  if (termSort !== undefined) return termSort === "invalid" ? undefined : termSort;

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

/**
 * Sort rules for the built-in term constructors and binders (design plan §5.2, §5.4). Returns
 * undefined for any other head and `"invalid"` for an ill-formed use of a constructor head.
 *
 * - `ForAll`/`Exists` bind a symbol (sorted by the enclosing bindings, as before) or a typed
 *   `["Element", x, S]` whose domain `S` has sort `set<T>`, giving `x : T`. Bodies are
 *   propositions. Quantified variables may have function and predicate sorts.
 * - `["Function", body, p1, …, pn]` has sort `(T1, …, Tn) -> B` for parameter sorts `Ti` and body
 *   sort `B`.
 * - `["Apply", f, a1, …, an]` applies a function-sorted term; so does a bound or declared function
 *   variable in head position.
 * - `Tuple` has sort `tuple<T1, …, Tn>`; `Set` and `List` literals have sort `set<T>`/`list<T>`.
 * - `["At", c, i]` indexes a `list<T>` or `sequence<T>` by an integer, a tuple by a literal
 *   position (1-based), or a unary function (an indexed family) by its parameter sort.
 * - `["Sum" | "Product", body, ["Limits", k, lower, upper]]` sums a numeric body over an integer
 *   (or natural) index; the index may instead range over `["Element", k, S]`.
 * - `["Integrate", body, ["Limits", x, a, b]]` is a real definite integral.
 * - `["Limit", f, point]` takes the limit of a unary numeric function literal or term at a point.
 *   An untyped lambda parameter takes the point's sort, or `real` for a literal point.
 *
 * Summation, integration, and limit bounds may be `PositiveInfinity` or `NegativeInfinity`.
 */
function inferTermConstructorSort(
  operator: string,
  operands: readonly PlainMathJson[],
  environment: ScopedEnvironment,
): InferredSort | "invalid" | undefined {
  switch (operator) {
    case "ForAll":
    case "Exists": {
      const scope = binderScope(operator, operands, environment, () => []);
      return scope !== undefined &&
        validatesAsSort(operands[1] as PlainMathJson, PROPOSITION_SORT, scope)
        ? PROPOSITION_SORT
        : "invalid";
    }
    case "Function":
      return inferFunctionLiteralSort(operands, environment, []) ?? "invalid";
    case "Apply": {
      const [head, ...argumentsList] = operands;
      if (head === undefined) return "invalid";
      const applicable = inferApplicableSignature(head, argumentsList, environment);
      if (applicable === undefined) return "invalid";
      const { parameters, result } = applicable;
      return parameters.length === argumentsList.length &&
        argumentsList.every((argument, index) =>
          validatesAsSort(argument, parameters[index] as Sort, environment),
        )
        ? result
        : "invalid";
    }
    case "Tuple": {
      if (operands.length === 0) return "invalid";
      const components = operands.map((operand) => concreteSort(operand, environment));
      return components.every((component) => component !== undefined)
        ? namedSort(TUPLE_SORT_ID, components as Sort[])
        : "invalid";
    }
    case "Set":
    case "List": {
      if (operands.length === 0) return "invalid";
      const member = inferCompatibleOperandSort(operands, environment, true);
      return member !== undefined && !isNumericLiteralSort(member)
        ? namedSort(operator === "Set" ? SET_SORT_ID : LIST_SORT_ID, [member])
        : "invalid";
    }
    case "At":
      return operands.length === 2
        ? (inferIndexSort(
            operands[0] as PlainMathJson,
            operands[1] as PlainMathJson,
            environment,
          ) ?? "invalid")
        : "invalid";
    case "Sum":
    case "Product": {
      const scope = binderScope(operator, operands, environment, () => []);
      if (scope === undefined) return "invalid";
      const body = inferExpressionSort(operands[0] as PlainMathJson, scope);
      return body !== undefined && isNumericInferredSort(body) ? body : "invalid";
    }
    case "Integrate": {
      const scope = binderScope(operator, operands, environment, () => []);
      return scope !== undefined && validatesAsSort(operands[0] as PlainMathJson, REAL_SORT, scope)
        ? REAL_SORT
        : "invalid";
    }
    case "Limit":
      return inferLimitSort(operands, environment) ?? "invalid";
    case "Limits":
    case "PositiveInfinity":
    case "NegativeInfinity":
      // Declaration and bound markers are only meaningful inside their binders.
      return "invalid";
    default:
      return undefined;
  }
}

/**
 * Validate a binder node's declarations and return the scope of its scoped operands.
 * `untypedParameterSorts` supplies sorts for bare symbol declarations (by declaration position);
 * without one, a bare symbol takes its sort from the enclosing bindings.
 */
function binderScope(
  operator: string,
  operands: readonly PlainMathJson[],
  environment: ScopedEnvironment,
  untypedParameterSorts: () => readonly (Sort | undefined)[],
): ScopedEnvironment | undefined {
  const shape = binderShape(operator, operands.length, environment.operators);
  if (shape === undefined || !builtinBinderArityMatches(operator, operands.length)) {
    return undefined;
  }
  const declarations = readShapeDeclarations(operands, shape);
  if (declarations === undefined) return undefined;
  const bindings = new Map(environment.bindings);
  const names = new Set<string>();
  const overrides = untypedParameterSorts();
  for (const [position, declaration] of declarations.entries()) {
    if (
      names.has(declaration.name) ||
      RESERVED_BUILTIN_SYMBOLS.has(declaration.name) ||
      environment.operators.some((candidate) => candidate.symbol === declaration.name)
    ) {
      return undefined;
    }
    const sort = declarationSort(
      operator,
      operands[shape.boundOperands[position] as number] as PlainMathJson,
      declaration,
      environment,
      overrides[position],
    );
    if (sort === undefined) return undefined;
    names.add(declaration.name);
    bindings.set(declaration.name, sort);
  }
  return { ...environment, bindings };
}

/**
 * The sorts a built-in binder node gives the symbols it binds, inside its scope, given the sorts
 * of the enclosing bindings. Returns undefined for a non-binder head or an ill-formed binder.
 * Custom binders take their bound sorts from their signatures instead.
 */
export function builtinBinderSorts(
  operator: string,
  operands: readonly PlainMathJson[],
  bindings: ReadonlyMap<string, Sort>,
  operators: readonly OperatorDeclaration[],
): ReadonlyMap<string, Sort> | undefined {
  if (!["ForAll", "Exists", "Function", "Sum", "Product", "Integrate"].includes(operator)) {
    return undefined;
  }
  const scope = binderScope(
    operator,
    operands,
    { declarations: [], operators, bindings },
    () => [],
  );
  const shape = binderShape(operator, operands.length, operators);
  const declarations = shape === undefined ? undefined : readShapeDeclarations(operands, shape);
  if (scope === undefined || declarations === undefined) return undefined;
  return new Map(
    declarations.map((declaration) => [
      declaration.name,
      scope.bindings.get(declaration.name) as Sort,
    ]),
  );
}

function builtinBinderArityMatches(operator: string, operandCount: number): boolean {
  return operator === "Function" ? operandCount >= 2 : operandCount === 2;
}

function readShapeDeclarations(
  operands: readonly PlainMathJson[],
  shape: BinderShape,
): readonly BinderDeclaration[] | undefined {
  const declarations: BinderDeclaration[] = [];
  for (const index of shape.boundOperands) {
    const operand = operands[index];
    const declaration =
      operand === undefined ? undefined : readBinderDeclaration(operand, shape.forms);
    if (declaration === undefined) return undefined;
    declarations.push(declaration);
  }
  return declarations;
}

/** The sort a declaration gives its bound symbol. Domains and bounds use the enclosing scope. */
function declarationSort(
  operator: string,
  operand: PlainMathJson,
  declaration: BinderDeclaration,
  environment: ScopedEnvironment,
  untypedSort: Sort | undefined,
): Sort | undefined {
  if (declaration.form === "symbol") {
    const bound = untypedSort ?? environment.bindings.get(declaration.name);
    return bound === undefined || isNumericLiteralSort(bound) ? undefined : bound;
  }
  const declarationOperands = functionParts(operand)?.operands ?? [];
  if (declaration.form === "element") {
    const domain = inferExpressionSort(declarationOperands[1] as PlainMathJson, environment);
    if (domain === undefined || isNumericLiteralSort(domain) || domain.kind !== "named") {
      return undefined;
    }
    return collectionMemberSort(domain, SET_SORT_ID);
  }

  const bounds = [declarationOperands[1], declarationOperands[2]] as PlainMathJson[];
  const finite = bounds.filter((bound) => !isInfinitySymbol(bound));
  if (operator === "Integrate") {
    return finite.every((bound) => validatesAsSort(bound, REAL_SORT, environment))
      ? REAL_SORT
      : undefined;
  }
  // Sum/Product: an integer index, natural when every finite bound is natural.
  if (finite.length === 0) return undefined;
  const boundSort = inferCompatibleOperandSort(finite, environment, false);
  if (boundSort === undefined) return undefined;
  if (isNumericLiteralSort(boundSort)) {
    if (!boundSort.integer) return undefined;
    return finite.every((bound) => validatesAsSort(bound, NATURAL_SORT, environment))
      ? NATURAL_SORT
      : INTEGER_SORT;
  }
  return sortEquals(boundSort, NATURAL_SORT) || sortEquals(boundSort, INTEGER_SORT)
    ? boundSort
    : undefined;
}

function inferFunctionLiteralSort(
  operands: readonly PlainMathJson[],
  environment: ScopedEnvironment,
  untypedParameterSorts: readonly (Sort | undefined)[],
): FunctionSort | undefined {
  const signature = inferLambdaSignature(operands, environment, untypedParameterSorts);
  return signature === undefined || isNumericLiteralSort(signature.result)
    ? undefined
    : {
        kind: "function",
        signature: { parameters: signature.parameters, result: signature.result },
      };
}

/**
 * A lambda literal's parameter sorts and body sort. The body may be an unresolved numeric literal
 * (a constant function), which only an application or a limit can use without an expected sort.
 */
function inferLambdaSignature(
  operands: readonly PlainMathJson[],
  environment: ScopedEnvironment,
  untypedParameterSorts: readonly (Sort | undefined)[],
): Readonly<{ parameters: readonly Sort[]; result: InferredSort }> | undefined {
  const scope = functionLiteralScope(operands, environment, untypedParameterSorts);
  if (scope === undefined) return undefined;
  const result = inferExpressionSort(operands[0] as PlainMathJson, scope.environment);
  return result === undefined ? undefined : { parameters: scope.parameters, result };
}

function functionLiteralScope(
  operands: readonly PlainMathJson[],
  environment: ScopedEnvironment,
  untypedParameterSorts: readonly (Sort | undefined)[],
): Readonly<{ environment: ScopedEnvironment; parameters: readonly Sort[] }> | undefined {
  const scope = binderScope("Function", operands, environment, () => untypedParameterSorts);
  if (scope === undefined) return undefined;
  const parameters = operands.slice(1).map((operand) => {
    const name = readBinderDeclaration(operand, ["symbol", "element"])?.name;
    return scope.bindings.get(name as string) as Sort;
  });
  return { environment: scope, parameters };
}

/**
 * The signature of an applied head. A lambda literal's untyped parameters are sorted by the
 * concrete sorts of the arguments.
 */
function inferApplicableSignature(
  head: PlainMathJson,
  argumentsList: readonly PlainMathJson[],
  environment: ScopedEnvironment,
  untypedParameterSorts?: readonly (Sort | undefined)[],
): Readonly<{ parameters: readonly Sort[]; result: InferredSort }> | undefined {
  const parts = functionParts(head);
  if (parts?.operator === "Function") {
    const argumentSorts =
      untypedParameterSorts ?? argumentsList.map((argument) => concreteSort(argument, environment));
    return inferLambdaSignature(parts.operands, environment, argumentSorts);
  }
  const sort = inferExpressionSort(head, environment);
  return sort !== undefined && !isNumericLiteralSort(sort) && sort.kind === "function"
    ? sort.signature
    : undefined;
}

function inferIndexSort(
  container: PlainMathJson,
  index: PlainMathJson,
  environment: ScopedEnvironment,
): Sort | undefined {
  const sort = inferExpressionSort(container, environment);
  if (sort === undefined || isNumericLiteralSort(sort)) return undefined;
  if (sort.kind === "function") {
    const [parameter, ...rest] = sort.signature.parameters;
    return parameter !== undefined &&
      rest.length === 0 &&
      validatesAsSort(index, parameter, environment)
      ? sort.signature.result
      : undefined;
  }
  if (sort.kind !== "named") return undefined;
  if (sort.id === TUPLE_SORT_ID) {
    const position = integerLiteralValue(index);
    const components = sort.arguments ?? [];
    return position !== undefined && position >= 1 && position <= components.length
      ? components[position - 1]
      : undefined;
  }
  const member =
    collectionMemberSort(sort, LIST_SORT_ID) ?? collectionMemberSort(sort, SEQUENCE_SORT_ID);
  return member !== undefined &&
    (validatesAsSort(index, NATURAL_SORT, environment) ||
      validatesAsSort(index, INTEGER_SORT, environment))
    ? member
    : undefined;
}

function inferLimitSort(
  operands: readonly PlainMathJson[],
  environment: ScopedEnvironment,
): InferredSort | undefined {
  const [functionTerm, point] = operands;
  if (operands.length !== 2 || functionTerm === undefined || point === undefined) return undefined;
  const infinite = isInfinitySymbol(point);
  const pointSort = infinite ? undefined : inferExpressionSort(point, environment);
  if (!infinite && pointSort === undefined) return undefined;
  const literalParameter =
    pointSort === undefined || isNumericLiteralSort(pointSort) ? REAL_SORT : pointSort;
  const signature = inferApplicableSignature(
    functionTerm,
    [],
    environment,
    // An untyped limit variable takes the point's sort.
    [literalParameter],
  );
  if (signature === undefined) return undefined;
  const [parameter, ...rest] = signature.parameters;
  if (
    parameter === undefined ||
    rest.length > 0 ||
    !isNumericSort(parameter) ||
    !isNumericInferredSort(signature.result)
  ) {
    return undefined;
  }
  return infinite || validatesAsSort(point, parameter, environment) ? signature.result : undefined;
}

/** An inferred sort that is not an unresolved numeric literal. */
function concreteSort(expression: PlainMathJson, environment: ScopedEnvironment): Sort | undefined {
  const sort = inferExpressionSort(expression, environment);
  return sort === undefined || isNumericLiteralSort(sort) ? undefined : sort;
}

function collectionMemberSort(sort: NamedSort, id: SortId): Sort | undefined {
  return sort.id === id && sort.arguments?.length === 1 ? sort.arguments[0] : undefined;
}

function namedSort(id: SortId, argumentsList: readonly Sort[]): NamedSort {
  return { kind: "named", id, arguments: argumentsList };
}

function setSort(member: Sort): NamedSort {
  return namedSort(SET_SORT_ID, [member]);
}

function isInfinitySymbol(expression: PlainMathJson): boolean {
  const symbol = symbolValue(expression);
  return symbol === "PositiveInfinity" || symbol === "NegativeInfinity";
}

function integerLiteralValue(expression: PlainMathJson): number | undefined {
  const value =
    typeof expression === "number"
      ? expression
      : Number(expressionObjectValue(expression, "num") ?? Number.NaN);
  return Number.isSafeInteger(value) ? value : undefined;
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
    if (element === undefined) return false;
    if (!isNumericLiteralSort(element)) {
      return validatesAsSort(operands[1] as PlainMathJson, setSort(element), environment);
    }
    const container = inferExpressionSort(operands[1] as PlainMathJson, environment);
    if (container === undefined || isNumericLiteralSort(container) || container.kind !== "named") {
      return false;
    }
    const memberSort = collectionMemberSort(container, SET_SORT_ID);
    return memberSort !== undefined && inferredSortMatches(element, memberSort);
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

  let deferred = false;
  for (const operand of operands) {
    const current = inferExpressionSort(operand, environment);
    if (current === undefined) {
      // A literal such as `["Set"]` or an untyped lambda may still check against a sibling's sort.
      deferred = true;
      continue;
    }
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
  return deferred ? undefined : fallback;
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

  const binder = boundNames.has(parts.operator)
    ? undefined
    : binderShape(parts.operator, parts.operands.length, operators);
  if (binder === undefined) {
    parts.operands.forEach((operand) => freeSymbolNames(operand, operators, boundNames, result));
    return result;
  }

  const scopedOperands = new Set(binder.scopedOperands);
  const nestedNames = new Set(boundNames);
  const declarations = new Map<number, BinderDeclaration>();
  binder.boundOperands.forEach((index) => {
    const operand = parts.operands[index];
    const declaration =
      operand === undefined ? undefined : readBinderDeclaration(operand, binder.forms);
    if (declaration === undefined) return;
    declarations.set(index, declaration);
    nestedNames.add(declaration.name);
  });

  parts.operands.forEach((operand, index) => {
    const declaration = declarations.get(index);
    if (declaration !== undefined) {
      // A declaration's domain or bounds are evaluated outside the binder's scope.
      const declarationOperands = functionParts(operand)?.operands ?? [];
      declaration.outerOperands.forEach((outerIndex) => {
        const outer = declarationOperands[outerIndex];
        if (outer !== undefined) freeSymbolNames(outer, operators, boundNames, result);
      });
      return;
    }
    if (binder.boundOperands.includes(index)) return;
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

/**
 * Why an obligation exists. Library identifiers are plain stable identifiers here because this
 * package cannot depend on the library's branded artifact IDs.
 */
export const obligationProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("premise-of-result"), resultId: stableIdentifierSchema }).strict(),
  z
    .object({
      kind: z.literal("side-condition"),
      resultId: stableIdentifierSchema,
      sideConditionId: stableIdentifierSchema,
    })
    .strict(),
  z.object({ kind: z.literal("user") }).strict(),
  z.object({ kind: z.literal("case") }).strict(),
  z.object({ kind: z.literal("suffices") }).strict(),
  /**
   * The membership `t ∈ S` required to instantiate the typed universal hypothesis `hypothesisId`
   * (`∀x∈S, …`) at a term `t` that no local hypothesis already places in `S`.
   */
  z.object({ kind: z.literal("binder-membership"), hypothesisId: statementIdSchema }).strict(),
  /** A sufficient requirement of a construction task, created when the task was resolved. */
  z
    .object({
      kind: z.literal("construction-requirement"),
      taskId: constructionTaskIdSchema,
      requirementId: constructionRequirementIdSchema,
    })
    .strict(),
]);
export type ObligationProvenance = z.infer<typeof obligationProvenanceSchema>;

const obligationShapeSchema = z
  .object({
    id: statementIdSchema,
    sequent: rawContextualSequentSchema,
    provenance: obligationProvenanceSchema.optional(),
  })
  .strict();

export type Obligation = z.infer<typeof obligationShapeSchema>;

export const assumptionIdSchema = stableIdentifierSchema.brand("AssumptionId");
export type AssumptionId = z.infer<typeof assumptionIdSchema>;

export const assumptionOriginSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("sorry"),
      sourceTarget: z
        .object({ kind: z.enum(["goal", "obligation"]), id: statementIdSchema })
        .strict(),
      sorryId: stableIdentifierSchema.optional(),
    })
    .strict(),
]);
export type AssumptionOrigin = z.infer<typeof assumptionOriginSchema>;

/**
 * A state-global additional assumption (design plan §11). Its statement is closed: apart from
 * built-in and declared operators, every symbol is bound inside it. `declarations` only supply the
 * sorts of those bound symbols, exactly as a context supplies sorts for quantified conclusions.
 */
const additionalAssumptionShapeSchema = z
  .object({
    id: assumptionIdSchema,
    declarations: z.array(declarationSchema),
    statement: rawStatementViewSchema,
    origin: assumptionOriginSchema,
  })
  .strict()
  .superRefine((assumption, context) => {
    addUniqueFieldIssues(assumption.declarations, "id", "declaration ID", context, [
      "declarations",
    ]);
    addUniqueFieldIssues(assumption.declarations, "symbol", "declaration symbol", context, [
      "declarations",
    ]);
    assumption.declarations.forEach((declaration, index) => {
      if (declaration.role === "construction-metavariable") {
        context.addIssue({
          code: "custom",
          message: "Additional-assumption binders cannot be construction metavariables.",
          path: ["declarations", index, "role"],
        });
      }
    });
  });

export type AdditionalAssumption = z.infer<typeof additionalAssumptionShapeSchema>;

const targetReferenceSchema = z
  .object({ kind: z.enum(["goal", "obligation"]), id: statementIdSchema })
  .strict();

/**
 * How a requirement's role is supported (refinement §5.2). `target` records that the requirement
 * was the conclusion of an open goal or obligation of the proof state, which the state already
 * requires, so it is (jointly) sufficient. `attestation` records an external argument that the
 * kernel does not judge. `none` means no implication is established; it is the only evidence of
 * a heuristic requirement and never evidence for a necessary or sufficient one.
 */
export const constructionRequirementEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("target"), target: targetReferenceSchema }).strict(),
  z.object({ kind: z.literal("attestation"), attestationId: attestationIdSchema }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type ConstructionRequirementEvidence = z.infer<typeof constructionRequirementEvidenceSchema>;

/**
 * Necessary: the intended property implies it, so it can exclude candidates. Sufficient: it
 * implies the intended property. Heuristic: worth investigating, with no established
 * implication. Only sufficient requirements ever become obligations, and no requirement ever
 * becomes a hypothesis.
 */
export const CONSTRUCTION_REQUIREMENT_ROLES = ["necessary", "sufficient", "heuristic"] as const;
export type ConstructionRequirementRole = (typeof CONSTRUCTION_REQUIREMENT_ROLES)[number];

/** A requirement is a proposition over the task's scope that mentions its placeholder. */
export const constructionRequirementSchema = z
  .object({
    id: constructionRequirementIdSchema,
    role: z.enum(CONSTRUCTION_REQUIREMENT_ROLES),
    statement: rawStatementViewSchema,
    evidence: constructionRequirementEvidenceSchema,
    attemptId: constructionAttemptIdSchema,
  })
  .strict();
export type ConstructionRequirement = z.infer<typeof constructionRequirementSchema>;

/** A candidate construction: a term over the task's allowed dependencies. */
export const constructionCandidateSchema = z
  .object({
    id: constructionCandidateIdSchema,
    value: plainMathJsonSchema,
    attemptId: constructionAttemptIdSchema,
  })
  .strict();
export type ConstructionCandidate = z.infer<typeof constructionCandidateSchema>;

/**
 * Where a construction task came from. An existential goal records the target and its
 * existential conclusion at introduction. An auxiliary request may name the task that requested
 * it; that task is then allowed to depend on it.
 */
export const constructionOriginSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("existential-goal"),
      target: targetReferenceSchema,
      statement: rawStatementViewSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("auxiliary-request"),
      description: z.string().min(1),
      requestedBy: constructionTaskIdSchema.optional(),
    })
    .strict(),
]);
export type ConstructionOrigin = z.infer<typeof constructionOriginSchema>;

export const CONSTRUCTION_TASK_STATUSES = [
  "unresolved",
  "partially-specified",
  "resolved",
  "abandoned",
] as const;
export type ConstructionTaskStatus = (typeof CONSTRUCTION_TASK_STATUSES)[number];

const constructionTaskBaseShape = {
  id: constructionTaskIdSchema,
  /** The registered placeholder operator. Occurrences apply it to the allowed declarations. */
  symbol: symbolSchema,
  displayName: z.string().min(1),
  sort: sortSchema,
  origin: constructionOriginSchema,
  /** The local context in which the task was introduced. */
  scope: proofContextShapeSchema,
  allowedDependencies: z
    .object({
      /** Scope declarations the construction may mention, in placeholder-parameter order. */
      declarations: z.array(symbolSchema),
      /** Other tasks whose placeholders it may use, directly or through their dependencies. */
      tasks: z.array(constructionTaskIdSchema),
    })
    .strict(),
  requirements: z.array(constructionRequirementSchema),
  candidates: z.array(constructionCandidateSchema),
};

/**
 * A construction task (refinement §5.1). `unresolved` has no requirements yet and
 * `partially-specified` has at least one; both are open, and only open placeholders may occur in
 * goals and obligations. A resolved task names the chosen candidate and the obligations its
 * remaining sufficient requirements became. Closed task records are static history.
 */
export const constructionTaskShapeSchema = z.discriminatedUnion("status", [
  z.object({ ...constructionTaskBaseShape, status: z.literal("unresolved") }).strict(),
  z.object({ ...constructionTaskBaseShape, status: z.literal("partially-specified") }).strict(),
  z
    .object({
      ...constructionTaskBaseShape,
      status: z.literal("resolved"),
      resolution: z
        .object({
          candidateId: constructionCandidateIdSchema,
          attemptId: constructionAttemptIdSchema,
          obligationIds: z.array(statementIdSchema),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...constructionTaskBaseShape,
      status: z.literal("abandoned"),
      abandonment: z.object({ attemptId: constructionAttemptIdSchema }).strict(),
    })
    .strict(),
]);
export type ConstructionTask = z.infer<typeof constructionTaskShapeSchema>;

export function isOpenConstructionTask(task: Pick<ConstructionTask, "status">): boolean {
  return task.status === "unresolved" || task.status === "partially-specified";
}

/**
 * The registered placeholder operator of a task: its parameters are the sorts of the allowed
 * scope declarations, in order, and its result is the task's sort. Undefined when an allowed
 * declaration is missing from the scope.
 */
export function constructionPlaceholderOperator(
  task: ConstructionTask,
): OperatorDeclaration | undefined {
  const parameters: Sort[] = [];
  for (const symbol of task.allowedDependencies.declarations) {
    const declaration = task.scope.declarations.find((candidate) => candidate.symbol === symbol);
    if (declaration === undefined) return undefined;
    parameters.push(declaration.sort);
  }
  const id = operatorIdSchema.safeParse(`construction-placeholder:${task.id}`);
  if (!id.success) return undefined;
  return {
    id: id.data,
    symbol: task.symbol,
    signature: { parameters, result: task.sort },
    presentation: { displayName: task.displayName },
  };
}

/**
 * Placeholder operators of a state's construction tasks: by default only the open ones, which
 * are the ones goals and obligations may mention.
 */
export function constructionPlaceholderOperators(
  state: Readonly<{ constructions?: readonly ConstructionTask[] | undefined }>,
  options: Readonly<{ includeClosed?: boolean }> = {},
): readonly OperatorDeclaration[] {
  return (state.constructions ?? [])
    .filter((task) => options.includeClosed === true || isOpenConstructionTask(task))
    .map(constructionPlaceholderOperator)
    .filter((operator): operator is OperatorDeclaration => operator !== undefined);
}

/**
 * The tasks each task may depend on: the transitive closure of `allowedDependencies.tasks`.
 * Returns undefined when the allowed-dependency graph has a cycle or names an unknown task.
 */
export function constructionDependencyClosure(
  tasks: readonly Pick<ConstructionTask, "id" | "allowedDependencies">[],
): ReadonlyMap<string, ReadonlySet<string>> | undefined {
  const byId = new Map(tasks.map((task) => [task.id as string, task]));
  const closures = new Map<string, ReadonlySet<string>>();
  const visiting = new Set<string>();
  const visit = (id: string): ReadonlySet<string> | undefined => {
    const known = closures.get(id);
    if (known !== undefined) return known;
    const task = byId.get(id);
    if (task === undefined || visiting.has(id)) return undefined;
    visiting.add(id);
    const closure = new Set<string>();
    for (const dependency of task.allowedDependencies.tasks) {
      const nested = visit(dependency);
      if (nested === undefined) return undefined;
      closure.add(dependency);
      nested.forEach((member) => closure.add(member));
    }
    visiting.delete(id);
    closures.set(id, closure);
    return closure;
  };
  for (const task of tasks) {
    if (visit(task.id) === undefined) return undefined;
  }
  return closures;
}

const rawProofStateSchema = z
  .object({
    id: proofStateIdSchema,
    goals: z.array(goalShapeSchema),
    obligations: z.array(obligationShapeSchema),
    /** State-global closed assumptions; absent means none. */
    assumptions: z.array(additionalAssumptionShapeSchema).optional(),
    /** Construction tasks and their placeholders (refinement §5); absent means none. */
    constructions: z.array(constructionTaskShapeSchema).optional(),
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
  const environmentOperators = operatorDeclarationsSchema.parse(options.operators ?? []);
  return rawProofStateSchema.superRefine((proofState, context) => {
    addUniqueFieldIssues(
      [...proofState.goals, ...proofState.obligations],
      "id",
      "goal or obligation ID",
      context,
    );

    // Goals and obligations may mention the placeholders of open construction tasks.
    const operators = [
      ...environmentOperators,
      ...addConstructionIssues(proofState.constructions ?? [], environmentOperators, context),
    ];
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

    // Additional assumptions are closed and never mention a placeholder.
    const assumptions = proofState.assumptions ?? [];
    addUniqueFieldIssues(assumptions, "id", "assumption ID", context, ["assumptions"]);
    assumptions.forEach((assumption, index) => {
      addAssumptionIssues(assumption, environmentOperators, context, ["assumptions", index]);
    });
  });
}

/**
 * Validate construction tasks and return the placeholder operators of the open ones. Records of
 * an open task may mention only open placeholders; records of a closed task are history and may
 * mention any task's placeholder.
 */
function addConstructionIssues(
  tasks: readonly ConstructionTask[],
  operators: readonly OperatorDeclaration[],
  context: z.RefinementCtx,
): readonly OperatorDeclaration[] {
  if (tasks.length === 0) return [];
  const prefix = ["constructions"];
  addUniqueFieldIssues(tasks, "id", "construction task ID", context, prefix);
  addUniqueFieldIssues(tasks, "symbol", "placeholder symbol", context, prefix);
  const operatorSymbols = new Set(operators.map((operator) => operator.symbol));
  const taskIds = new Set<string>(tasks.map((task) => task.id));
  const placeholders = new Map<string, OperatorDeclaration>();

  tasks.forEach((task, index) => {
    const path = [...prefix, index];
    if (RESERVED_BUILTIN_SYMBOLS.has(task.symbol) || operatorSymbols.has(task.symbol)) {
      context.addIssue({
        code: "custom",
        message: "A placeholder symbol cannot be a built-in or environment operator.",
        path: [...path, "symbol"],
      });
      return;
    }
    const scopeSymbols = new Set(task.scope.declarations.map((declaration) => declaration.symbol));
    const allowed = task.allowedDependencies;
    allowed.declarations.forEach((symbol, position) => {
      if (!scopeSymbols.has(symbol) || allowed.declarations.indexOf(symbol) !== position) {
        context.addIssue({
          code: "custom",
          message: "Allowed declarations must be distinct symbols declared in the task's scope.",
          path: [...path, "allowedDependencies", "declarations", position],
        });
      }
    });
    allowed.tasks.forEach((id, position) => {
      if (!taskIds.has(id) || id === task.id || allowed.tasks.indexOf(id) !== position) {
        context.addIssue({
          code: "custom",
          message: "Allowed task dependencies must be distinct other tasks of the same state.",
          path: [...path, "allowedDependencies", "tasks", position],
        });
      }
    });
    const operator = constructionPlaceholderOperator(task);
    if (operator !== undefined) placeholders.set(task.id, operator);
  });

  const closures = constructionDependencyClosure(
    tasks.map((task) => ({
      id: task.id,
      allowedDependencies: {
        ...task.allowedDependencies,
        tasks: task.allowedDependencies.tasks.filter((id) => taskIds.has(id)),
      },
    })),
  );
  if (closures === undefined) {
    context.addIssue({
      code: "custom",
      message: "Construction task dependencies cannot be cyclic.",
      path: prefix,
    });
  }

  const allPlaceholders = [...placeholders.values()];
  const openPlaceholders = tasks
    .filter((task) => isOpenConstructionTask(task) && placeholders.has(task.id))
    .map((task) => placeholders.get(task.id) as OperatorDeclaration);
  const taskBySymbol = new Map(tasks.map((task) => [task.symbol, task]));

  tasks.forEach((task, index) => {
    const path = [...prefix, index];
    const recordOperators = [
      ...operators,
      ...(isOpenConstructionTask(task) ? openPlaceholders : allPlaceholders),
    ];
    const environment = addContextIssues(
      task.scope,
      recordOperators,
      context,
      [...path, "scope"],
      false,
    );
    addUniqueFieldIssues(task.requirements, "id", "requirement ID", context, [
      ...path,
      "requirements",
    ]);
    addUniqueFieldIssues(task.candidates, "id", "candidate ID", context, [...path, "candidates"]);

    if (task.status === "unresolved" && task.requirements.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A task with requirements is partially specified, not unresolved.",
        path: [...path, "status"],
      });
    }
    if (task.status === "partially-specified" && task.requirements.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A partially specified task must have at least one requirement.",
        path: [...path, "status"],
      });
    }
    if (
      task.status === "resolved" &&
      !task.candidates.some((candidate) => candidate.id === task.resolution.candidateId)
    ) {
      context.addIssue({
        code: "custom",
        message: "A resolved task must name one of its recorded candidates.",
        path: [...path, "resolution", "candidateId"],
      });
    }

    task.requirements.forEach((requirement, requirementIndex) => {
      const requirementPath = [...path, "requirements", requirementIndex];
      if (!isPropositionExpression(requirement.statement.expression, environment)) {
        context.addIssue({
          code: "custom",
          message: "A requirement must be a proposition in its task's scope.",
          path: [...requirementPath, "statement", "expression"],
        });
      }
      if (!requirementEvidenceMatchesRole(requirement)) {
        context.addIssue({
          code: "custom",
          message:
            "A heuristic requirement has no evidence; a necessary one needs an attestation; a sufficient one needs an attestation or an open target.",
          path: [...requirementPath, "evidence"],
        });
      }
    });

    const parameters = task.scope.declarations.filter((declaration) =>
      task.allowedDependencies.declarations.includes(declaration.symbol),
    );
    const candidateEnvironment: ValidatedStatementEnvironment = {
      declarations: parameters,
      operators: recordOperators,
      bindings: new Map(parameters.map((declaration) => [declaration.symbol, declaration.sort])),
    };
    const reachable = closures?.get(task.id) ?? new Set<string>();
    task.candidates.forEach((candidate, candidateIndex) => {
      const candidatePath = [...path, "candidates", candidateIndex, "value"];
      const usesForbiddenTask = [...freeSymbolNames(candidate.value, operators)].some((symbol) => {
        const used = taskBySymbol.get(symbol);
        return used !== undefined && !reachable.has(used.id);
      });
      if (usesForbiddenTask) {
        context.addIssue({
          code: "custom",
          message: "A candidate may use only placeholders of the task's allowed dependencies.",
          path: candidatePath,
        });
      } else if (!validatesAsSort(candidate.value, task.sort, candidateEnvironment)) {
        context.addIssue({
          code: "custom",
          message: "A candidate must have the task's sort using only the allowed declarations.",
          path: candidatePath,
        });
      }
    });
  });
  return openPlaceholders;
}

/**
 * The role/evidence rule: a heuristic requirement has evidence `none`, and only a heuristic one
 * does; `target` evidence supports only a sufficient requirement.
 */
export function requirementEvidenceMatchesRole(
  requirement: Pick<ConstructionRequirement, "role" | "evidence">,
): boolean {
  const evidence = requirement.evidence.kind;
  return (
    (requirement.role === "heuristic") === (evidence === "none") &&
    (evidence !== "target" || requirement.role === "sufficient")
  );
}

function addAssumptionIssues(
  assumption: AdditionalAssumption,
  operators: readonly OperatorDeclaration[],
  context: z.RefinementCtx,
  prefix: readonly PropertyKey[],
): void {
  const environment = addContextIssues(
    { declarations: assumption.declarations, hypotheses: [] },
    operators,
    context,
    prefix,
    false,
  );
  const operatorSymbols = new Set(operators.map((operator) => operator.symbol));
  const openSymbols = [...freeSymbolNames(assumption.statement.expression, operators)].filter(
    (symbol) => !RESERVED_BUILTIN_SYMBOLS.has(symbol) && !operatorSymbols.has(symbol),
  );
  if (openSymbols.length > 0) {
    context.addIssue({
      code: "custom",
      message: `An additional assumption must be closed; free symbols: ${openSymbols.join(", ")}.`,
      path: [...prefix, "statement", "expression"],
    });
    return;
  }
  if (!isPropositionExpression(assumption.statement.expression, environment)) {
    context.addIssue({
      code: "custom",
      message: "An additional assumption must be proposition-valued.",
      path: [...prefix, "statement", "expression"],
    });
  }
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
