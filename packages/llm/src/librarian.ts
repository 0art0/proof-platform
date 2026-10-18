import {
  RESERVED_BUILTIN_SYMBOLS,
  backgroundClassificationSchema,
  backgroundLevelSchema,
  backgroundProfileSchema,
  declarationSchema,
  operatorDeclarationSchema,
  plainMathJsonSchema,
  problemSetupSort,
  problemSetupSortIdSchema,
  problemSetupSymbolSchema,
  stableIdentifierSchema,
  type OperatorDeclaration,
  type PlainMathJson,
} from "@proof/protocol";
import { applicationDirectionSchema, applicationRequirementSchema } from "@proof/library";
import { z } from "zod";
import {
  OPERATOR_DECLARATION_GUIDANCE,
  RESERVED_SYMBOL_LIST,
  SORT_NAME_LIST,
  addConstantIssues,
  backgroundConstantSchema,
  wireOperatorSchema,
  wireOperatorToDeclarationInput,
} from "./background-proposer";

/**
 * The librarian (`docs/ai-agents-architecture.md` section 2). From a background profile and the
 * constants to cover it proposes general library results: standard statements about exactly those
 * constants at that background level. It never sees the problem statement, so nothing it returns
 * can be fitted to a particular problem. Its proposal is evidence only; the worker runs every
 * result through the deterministic admission gate, and a person approves what is kept.
 *
 * The context is a union discriminated by `kind`. Only `initial` (the results a problem starts
 * with) exists today; the later request kinds extend the union without reshaping the proposal.
 *
 * Like `background-proposer.ts`, this module is self-contained: `index.ts` composes these schemas
 * into the role's envelope, output validation and evidence.
 */

const shortTextSchema = z.string().min(1).max(500);

/** At most this many results per call. */
export const MAX_LIBRARIAN_RESULTS = 40;
/** At most this many operators a call may declare for its results. */
export const MAX_LIBRARIAN_NEW_CONSTANTS = 16;
/** The context shows at most this many existing results and constants. */
export const MAX_LIBRARIAN_CONTEXT_RESULTS = 128;
export const MAX_LIBRARIAN_CONTEXT_CONSTANTS = 128;
const MAX_RESULT_PARAMETERS = 12;
const MAX_RESULT_PREMISES = 8;
const MAX_RESULT_PATTERNS = 8;
/** A statement, premise or pattern is a small formula, not a document. */
const MAX_EXPRESSION_NODES = 400;
const MAX_EXPRESSION_DEPTH = 24;

/** The prefixes of the identifiers the librarian's results get; they cannot clash with the packs'. */
const RESULT_ID_PREFIX = "result:library-";

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

/** A result already in the library, shown so that the librarian does not repeat it. */
const existingResultSchema = z
  .object({ id: stableIdentifierSchema, name: shortTextSchema, statement: plainMathJsonSchema })
  .strict();
export type LibrarianExistingResult = z.infer<typeof existingResultSchema>;

const initialContextSchema = z
  .object({
    kind: z.literal("initial"),
    /** The background the results are classified against. */
    background: backgroundProfileSchema,
    /** The operators the results may use besides the built-in symbols. */
    constants: z.array(operatorDeclarationSchema).max(MAX_LIBRARIAN_CONTEXT_CONSTANTS),
    existingResults: z.array(existingResultSchema).max(MAX_LIBRARIAN_CONTEXT_RESULTS),
  })
  .strict()
  .superRefine((context, refinement) => {
    addDuplicates(
      context.constants.map(({ symbol }) => symbol),
      "constant symbol",
      refinement,
      ["constants"],
    );
    addDuplicates(
      context.existingResults.map(({ id }) => id),
      "existing result ID",
      refinement,
      ["existingResults"],
    );
  });

/** The librarian's context, by request kind. The problem statement is deliberately not a field. */
export const librarianContextSchema = z.discriminatedUnion("kind", [initialContextSchema]);
export type LibrarianContext = z.infer<typeof librarianContextSchema>;
export type LibrarianRequestKind = LibrarianContext["kind"];

// ---------------------------------------------------------------------------------------------
// Validated output
// ---------------------------------------------------------------------------------------------

const universalParameterSchema = declarationSchema.refine(
  (declaration) => declaration.role === "universal-parameter",
  "A result parameter is a universal parameter.",
);
const expressionSchema = z.object({ expression: plainMathJsonSchema }).strict();

/**
 * A proposed result in the library's result shape, without the fields the worker owns (kind,
 * renderings, provenance, approval, layer, related artifacts, priority and side conditions). Its
 * mathematics is checked by the admission gate, not here, so one ill-typed result cannot discard
 * the others.
 */
export const librarianResultSchema = z
  .object({
    id: stableIdentifierSchema,
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    classification: backgroundClassificationSchema,
    parameters: z.array(universalParameterSchema).max(MAX_RESULT_PARAMETERS),
    statement: expressionSchema,
    premises: z.array(expressionSchema).max(MAX_RESULT_PREMISES),
    applicationDirections: z.array(applicationDirectionSchema).min(1).max(2),
    patterns: z
      .array(
        z
          .object({
            id: stableIdentifierSchema,
            expression: plainMathJsonSchema,
            direction: applicationDirectionSchema,
            requirement: applicationRequirementSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_RESULT_PATTERNS),
  })
  .strict()
  .superRefine((result, context) => {
    addDuplicates(result.applicationDirections, "application direction", context, [
      "applicationDirections",
    ]);
    addDuplicates(
      result.parameters.map(({ symbol }) => symbol),
      "parameter symbol",
      context,
      ["parameters"],
    );
    addDuplicates(
      result.patterns.map(({ id }) => id),
      "pattern ID",
      context,
      ["patterns"],
    );
    result.patterns.forEach((pattern, index) => {
      if (!result.applicationDirections.includes(pattern.direction)) {
        context.addIssue({
          code: "custom",
          message: "A pattern direction must be listed as an application direction.",
          path: ["patterns", index, "direction"],
        });
      }
    });
  });
export type LibrarianResult = z.infer<typeof librarianResultSchema>;

/** A result the provider returned that cannot even be read as a result (a shape problem). */
const unusableResultSchema = z
  .object({ id: stableIdentifierSchema, reason: shortTextSchema })
  .strict();
export type LibrarianUnusableResult = z.infer<typeof unusableResultSchema>;

/**
 * A validated proposal: at most 40 results in all (readable ones in `results`, unreadable ones in
 * `unusable` with a plain reason), unique IDs, and any new constants checked exactly like a
 * background proposal's (unique ids, symbols and triggers, plain-identifier symbols, a known-sort
 * signature). Which constants a result needs and whether it holds is the worker's check.
 */
export const librarianProposalSchema = z
  .object({
    kind: z.literal("library-proposal"),
    results: z.array(librarianResultSchema).max(MAX_LIBRARIAN_RESULTS),
    unusable: z.array(unusableResultSchema).max(MAX_LIBRARIAN_RESULTS),
    newConstants: z.array(backgroundConstantSchema).max(MAX_LIBRARIAN_NEW_CONSTANTS),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.results.length + proposal.unusable.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A proposal contains at least one result; otherwise decline.",
        path: ["results"],
      });
    }
    if (proposal.results.length + proposal.unusable.length > MAX_LIBRARIAN_RESULTS) {
      context.addIssue({
        code: "custom",
        message: `A proposal contains at most ${MAX_LIBRARIAN_RESULTS} results.`,
        path: ["results"],
      });
    }
    addDuplicates(
      [...proposal.results.map(({ id }) => id), ...proposal.unusable.map(({ id }) => id)],
      "result ID",
      context,
      ["results"],
    );
    addConstantIssues(
      proposal.newConstants.map(({ operator }) => operator),
      context,
      ["newConstants"],
    );
  });
export type LibrarianProposal = z.infer<typeof librarianProposalSchema>;

export const librarianInsufficientContextSchema = z
  .object({
    kind: z.literal("insufficient-context"),
    requestedCategories: z
      .array(z.enum(["background-detail", "constant-detail"]))
      .min(1)
      .max(2),
    rationale: shortTextSchema,
  })
  .strict();
export const librarianDeclinedSchema = z
  .object({ kind: z.literal("declined"), reason: shortTextSchema })
  .strict();

/** What a validated call can output: the proposal, a context request, or a refusal. */
export const librarianOutputSchema = z.union([
  librarianProposalSchema,
  librarianInsufficientContextSchema,
  librarianDeclinedSchema,
]);
export type LibrarianOutput = z.infer<typeof librarianOutputSchema>;

// ---------------------------------------------------------------------------------------------
// Provider (wire) schema
// ---------------------------------------------------------------------------------------------

// A MathJSON formula is a number, a symbol string, or an array whose first element is the head and
// whose remaining elements are formulas. The recursive node is the only recursion on the wire.
type WireNode = number | string | WireNode[];
const wireNodeSchema: z.ZodType<WireNode> = z.lazy(() =>
  z.union([z.number(), z.string(), z.array(wireNodeSchema)]),
);

const wireResultSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(2_000),
    domains: z.array(shortTextSchema).min(1).max(8),
    level: backgroundLevelSchema,
    parameters: z
      .array(
        z.object({ symbol: problemSetupSymbolSchema, sort: problemSetupSortIdSchema }).strict(),
      )
      .max(MAX_RESULT_PARAMETERS),
    premises: z.array(wireNodeSchema).max(MAX_RESULT_PREMISES),
    statement: wireNodeSchema,
    applicationDirections: z.array(applicationDirectionSchema).min(1).max(2),
    patterns: z
      .array(
        z
          .object({
            expression: wireNodeSchema,
            direction: applicationDirectionSchema,
            section: applicationRequirementSchema.shape.section,
            polarity: applicationRequirementSchema.shape.polarity,
            role: applicationRequirementSchema.shape.role,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_RESULT_PATTERNS),
  })
  .strict();
type WireResult = z.infer<typeof wireResultSchema>;

const wireLibraryProposalSchema = z
  .object({
    kind: z.literal("library-proposal"),
    results: z.array(wireResultSchema).max(MAX_LIBRARIAN_RESULTS),
    newConstants: z
      .array(z.object({ operator: wireOperatorSchema, rationale: shortTextSchema }).strict())
      .max(MAX_LIBRARIAN_NEW_CONSTANTS),
  })
  .strict();

/** The provider-facing result: strict, with sort names and recursive MathJSON formulas. */
export const librarianWireResultSchema = z.union([
  wireLibraryProposalSchema,
  librarianInsufficientContextSchema,
  librarianDeclinedSchema,
]);
export type LibrarianWireResult = z.infer<typeof librarianWireResultSchema>;

/**
 * Convert a provider result into the validated output. A new constant that repeats or clashes with
 * a context constant rejects the output (`undefined`), like any breach of the constants rules; a
 * result that cannot be read as a result (formulas that are not plain MathJSON, or too large;
 * a clashing parameter name; inconsistent directions) is set aside as `unusable` with its reason.
 */
export function normalizeLibrarianWireResult(
  output: LibrarianWireResult,
  context: LibrarianContext,
): LibrarianOutput | undefined {
  if (output.kind !== "library-proposal") return output;
  const newConstants = output.newConstants.map(({ operator, rationale }) => ({
    operator: wireOperatorToDeclarationInput(operator),
    rationale,
  }));
  const taken = {
    symbols: new Set(context.constants.map(({ symbol }) => symbol)),
    ids: new Set<string>(context.constants.map(({ id }) => id)),
    triggers: new Set(
      context.constants.flatMap((operator) => {
        const trigger = operator.presentation?.latex?.parse?.trigger;
        return trigger === undefined ? [] : [trigger];
      }),
    ),
  };
  const symbols = new Set<string>(taken.symbols);
  for (const { operator } of output.newConstants) {
    const trigger = operator.latex.parse?.trigger;
    if (
      taken.symbols.has(operator.symbol) ||
      taken.ids.has(operator.id) ||
      (trigger !== undefined && taken.triggers.has(trigger))
    ) {
      return undefined;
    }
    symbols.add(operator.symbol);
  }

  const results: unknown[] = [];
  const unusable: LibrarianUnusableResult[] = [];
  for (const wire of output.results) {
    const built = buildResult(wire, symbols);
    if (built.ok) results.push(built.result);
    else unusable.push({ id: `${RESULT_ID_PREFIX}${wire.slug}`, reason: built.reason });
  }
  try {
    const parsed = librarianOutputSchema.safeParse({
      kind: output.kind,
      results,
      unusable,
      newConstants,
    });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

type BuiltResult =
  Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; reason: string }>;

function buildResult(wire: WireResult, operatorSymbols: ReadonlySet<string>): BuiltResult {
  const slug = wire.slug;
  const unreadable = (reason: string): BuiltResult => ({ ok: false, reason });

  const symbols = new Set<string>();
  for (const { symbol } of wire.parameters) {
    if (symbols.has(symbol)) return unreadable(`The parameter ${symbol} is declared twice.`);
    symbols.add(symbol);
    if (RESERVED_BUILTIN_SYMBOLS.has(symbol) || operatorSymbols.has(symbol)) {
      return unreadable(`The parameter ${symbol} has the name of a built-in symbol or operator.`);
    }
  }
  const classification = backgroundClassificationSchema.safeParse({
    domains: wire.domains,
    level: wire.level,
  });
  if (!classification.success) return unreadable("The background classification is invalid.");
  if (new Set(wire.applicationDirections).size !== wire.applicationDirections.length) {
    return unreadable("An application direction is repeated.");
  }
  if (wire.patterns.some(({ direction }) => !wire.applicationDirections.includes(direction))) {
    return unreadable("A pattern has a direction that is not an application direction.");
  }

  const formulas = [wire.statement, ...wire.premises, ...wire.patterns.map((p) => p.expression)];
  for (const formula of formulas) {
    if (!plainMathJsonSchema.safeParse(formula).success) {
      return unreadable("A formula is not plain MathJSON (an array starts with a symbol name).");
    }
    if (!withinSize(formula as PlainMathJson)) {
      return unreadable("A formula is larger than a library statement may be.");
    }
  }

  return {
    ok: true,
    result: {
      id: `${RESULT_ID_PREFIX}${slug}`,
      name: wire.name,
      description: wire.description,
      classification: classification.data,
      parameters: wire.parameters.map(({ symbol, sort }) => ({
        id: `declaration:library-${slug}-${symbol}`,
        symbol,
        sort: problemSetupSort(sort),
        role: "universal-parameter" as const,
      })),
      statement: { expression: wire.statement },
      premises: wire.premises.map((expression) => ({ expression })),
      applicationDirections: wire.applicationDirections,
      patterns: wire.patterns.map(({ expression, direction, section, polarity, role }, index) => ({
        id: `pattern:library-${slug}-${index + 1}`,
        expression,
        direction,
        requirement: { section, polarity, role },
      })),
    },
  };
}

function withinSize(formula: PlainMathJson): boolean {
  let nodes = 0;
  const visit = (node: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_EXPRESSION_NODES || depth > MAX_EXPRESSION_DEPTH) return false;
    return !Array.isArray(node) || node.every((child) => visit(child, depth + 1));
  };
  return visit(formula, 1);
}

function addDuplicates(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `Each ${label} must be unique.`,
        path: [...path, index],
      });
    }
    seen.add(value);
  });
}

// ---------------------------------------------------------------------------------------------
// System message
// ---------------------------------------------------------------------------------------------

/** The new constants the proposal's results need, as full declarations. */
export function librarianNewConstants(proposal: LibrarianProposal): readonly OperatorDeclaration[] {
  return proposal.newConstants.map(({ operator }) => operator);
}

/** The role's fixed system message; stored calls are checked against it. */
export const LIBRARIAN_SYSTEM_MESSAGE =
  "Propose general library results for the supplied background and constants. Return only a library proposal, a permitted context request, or a refusal. " +
  "You are given no problem and must not try to guess one: do not solve, prove or hint at any particular problem. " +
  "A library result is a standard, general fact that a reader at this background level would cite without proof: a statement over named parameters, with optional premises. " +
  "Propose the standard results about exactly these constants (the operators in context.constants, together with the built-in symbols) that a mathematician at this background level would reach for: basic properties such as reflexivity, symmetry, transitivity, monotonicity, closure, cancellation, distributivity, equivalent characterizations, and how the constants interact with each other and with the built-in symbols. " +
  "Keep every result general. Do not propose problem-specific lemmas, special cases with concrete numbers, results that merely restate a likely goal, or anything that works as a disguised solution. " +
  "Do not repeat any result in context.existingResults, and do not propose trivial reformulations of your own results. " +
  `Return at most ${MAX_LIBRARIAN_RESULTS} results; fewer is better than padding, and prefer the most broadly useful. ` +
  "If every result you would add is already in context.existingResults, return a refusal that says so. " +
  `Each result needs: a slug (lowercase letters, digits and hyphens, unique in your answer); a name; a one or two sentence description; its background classification, with domains and a level (one of foundational, secondary, undergraduate, graduate, research), where each domain must be exactly one of context.background.domains when that list is given and the level must not exceed context.background.maximumLevel when that is given; its parameters; its premises; its statement; its application directions; and its patterns. ` +
  `Parameters are the named variables of the result, each a plain-identifier symbol with a sort chosen from these names: ${SORT_NAME_LIST}. A parameter symbol must not be a built-in symbol or an operator symbol. Every symbol used in a formula must be a parameter, a built-in symbol, an operator from context.constants or one of your new constants, or a variable bound by a quantifier. ` +
  `The statement and every premise are propositions written as plain MathJSON: a number, a symbol name, or an array whose first element is the operator or function name followed by its operands, for example ["Implies", ["SubsetEqual", "A", "B"], ["SubsetEqual", "B", "C"]]. A quantifier is ["ForAll", "x", body] or ["ForAll", ["Element", "x", domain], body], and likewise "Exists". Each formula must be well-sorted: operands have the sorts the operator's signature demands. The built-in symbols are: ${RESERVED_SYMBOL_LIST}. ` +
  "A rule with premises is stated as premises plus a statement (the conclusion), not as a nested implication; an equivalence or equation is a statement with no premises. " +
  "Application directions say how the result can be used in a proof: forward derives consequences from a selected hypothesis or term, backward reduces or closes a selected goal. " +
  "A pattern is the part of the result a reader would select to use it, written over the result's parameters, with a direction from the result's application directions and a requirement: section (goal, hypothesis, obligation or any), polarity (positive, negative, mixed, neutral or any) and role (proposition, term, binder or any). " +
  "For a rule P1, ..., Pn proves C, give a forward pattern on P1 (section hypothesis, polarity negative, role proposition) and a backward pattern on C (section goal, polarity positive, role proposition). For an equivalence, give a pattern on each side (section any, polarity any, role proposition). For an equation, give term patterns (section any, polarity any, role term). " +
  "A pattern must not be a bare parameter symbol, which would match everything, and its role is proposition only when the pattern itself is a proposition. " +
  "If your results need an operator that is not in context.constants, declare it in newConstants with a one-line rationale; declare only operators that your results use, and never redeclare an operator from context.constants or a built-in symbol. " +
  OPERATOR_DECLARATION_GUIDANCE +
  "If the background or the constants are too thin to propose results, return a context request instead.";
