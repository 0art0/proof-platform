import {
  PROBLEM_SETUP_SORT_CHOICES,
  PROBLEM_SETUP_SORT_IDS,
  RESERVED_BUILTIN_SYMBOLS,
  backgroundProfileSchema,
  operatorDeclarationSchema,
  problemSetupSortIdSchema,
  problemSetupSymbolSchema,
  problemSetupSort,
  stableIdentifierSchema,
  type OperatorDeclaration,
  type ProblemSetupSortId,
} from "@proof/protocol";
import { z } from "zod";

/**
 * The background proposer (`docs/ai-agents-architecture.md` section 1). From the problem statement
 * alone it proposes the background relative to which a proof will be motivated, and the constants
 * (operator declarations) that suffice to formalize the problem. The proposal is evidence only; the
 * user accepts it, and the worker later hands the accepted constants to the formalizer.
 *
 * This module is self-contained on purpose: `index.ts` composes these schemas into the role's
 * envelope, output validation and evidence, and nothing here depends on `index.ts`.
 */

const shortTextSchema = z.string().min(1).max(500);
const uniqueShortTextsSchema = z
  .array(shortTextSchema)
  .max(64)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "Repeated values are not allowed." });
    }
  });

/** At most this many constants per proposal; the formalizer context bounds its operators at 128. */
export const MAX_BACKGROUND_CONSTANTS = 32;
const MAX_CONSTANT_PARAMETERS = 6;
const MAX_FEEDBACK_LENGTH = 4_000;

const KNOWN_SORT_KEYS: ReadonlySet<string> = new Set(
  PROBLEM_SETUP_SORT_CHOICES.map(({ sort }) => canonicalJson(sort)),
);
const SORT_ID_BY_KEY: ReadonlyMap<string, ProblemSetupSortId> = new Map(
  PROBLEM_SETUP_SORT_CHOICES.map(
    ({ id, sort }) => [canonicalJson(sort), problemSetupSortIdSchema.parse(id)] as const,
  ),
);

/** JSON with sorted object keys, so structurally equal values compare equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const backgroundConstantSchema = z
  .object({ operator: operatorDeclarationSchema, rationale: shortTextSchema })
  .strict();
export type BackgroundConstant = z.infer<typeof backgroundConstantSchema>;

/**
 * The deterministic rules for a list of proposed constants, shared by every role that may declare
 * operators. Each constant parses as an `OperatorDeclaration` (which already refuses reserved
 * built-in symbols); ids, symbols and LaTeX parse triggers are unique; symbols are plain
 * identifiers; each constant has at least one operand; and every sort in a signature is one of the
 * problem setup's known sorts. `path` locates the list in the validated value.
 */
export function addConstantIssues(
  operators: readonly OperatorDeclaration[],
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  const ids = new Set<string>();
  const symbols = new Set<string>();
  const triggers = new Set<string>();
  operators.forEach((operator, index) => {
    const at = (...rest: PropertyKey[]) => [...path, index, "operator", ...rest];
    if (ids.has(operator.id)) {
      context.addIssue({
        code: "custom",
        message: `The operator ID ${operator.id} is declared twice.`,
        path: at("id"),
      });
    }
    ids.add(operator.id);
    if (symbols.has(operator.symbol)) {
      context.addIssue({
        code: "custom",
        message: `The operator symbol ${operator.symbol} is declared twice.`,
        path: at("symbol"),
      });
    }
    symbols.add(operator.symbol);
    if (!problemSetupSymbolSchema.safeParse(operator.symbol).success) {
      context.addIssue({
        code: "custom",
        message: "A constant's symbol must be a plain identifier.",
        path: at("symbol"),
      });
    }
    const trigger = operator.presentation?.latex?.parse?.trigger;
    if (trigger !== undefined) {
      if (triggers.has(trigger)) {
        context.addIssue({
          code: "custom",
          message: `The LaTeX parse trigger ${trigger} is used twice.`,
          path: at("presentation", "latex", "parse", "trigger"),
        });
      }
      triggers.add(trigger);
    }
    if (operator.signature.parameters.length === 0) {
      context.addIssue({
        code: "custom",
        message:
          "A constant is an operator with at least one operand; declare named objects as variables.",
        path: at("signature", "parameters"),
      });
    }
    [...operator.signature.parameters, operator.signature.result].forEach((sort) => {
      if (!KNOWN_SORT_KEYS.has(canonicalJson(sort))) {
        context.addIssue({
          code: "custom",
          message: `The operator ${operator.symbol} uses a sort that is not a known sort.`,
          path: at("signature"),
        });
      }
    });
  });
}

/** A constant's signature in the problem setup's sort-menu names, when every sort is on the menu. */
function menuSignature(
  operator: OperatorDeclaration,
): Readonly<{ parameters: ProblemSetupSortId[]; result: ProblemSetupSortId }> | undefined {
  const parameters = operator.signature.parameters.map((sort) =>
    SORT_ID_BY_KEY.get(canonicalJson(sort)),
  );
  const result = SORT_ID_BY_KEY.get(canonicalJson(operator.signature.result));
  if (result === undefined || parameters.some((id) => id === undefined)) return undefined;
  return { parameters: parameters as ProblemSetupSortId[], result };
}
/**
 * A validated proposal. Deterministic rules beyond the shape: every constant parses as an
 * `OperatorDeclaration` (which already refuses reserved built-in symbols, so built-ins are never
 * redeclared and stay available to every formalization); ids, symbols and LaTeX parse triggers
 * are unique; symbols are plain identifiers; and every sort in a signature is one of the problem
 * setup's known sorts.
 */
export const backgroundProposalSchema = z
  .object({
    kind: z.literal("background-proposal"),
    background: backgroundProfileSchema,
    constants: z.array(backgroundConstantSchema).max(MAX_BACKGROUND_CONSTANTS),
  })
  .strict()
  .superRefine((proposal, context) => {
    addConstantIssues(
      proposal.constants.map(({ operator }) => operator),
      context,
      ["constants"],
    );
  });
export type BackgroundProposal = z.infer<typeof backgroundProposalSchema>;

/** At most this many existing operators are shown to the proposer. */
export const MAX_EXISTING_OPERATORS = 128;

/**
 * An operator that already exists (one of the pack operators, i.e. the global registry), as the
 * proposer sees it: its symbol, display name and signature in the sort-menu names a constant uses.
 * A constant with exactly this symbol and signature is a reference to the existing operator.
 */
const existingOperatorSchema = z
  .object({
    symbol: problemSetupSymbolSchema,
    displayName: shortTextSchema,
    parameters: z.array(problemSetupSortIdSchema).max(16),
    result: problemSetupSortIdSchema,
  })
  .strict();
export type ExistingOperator = z.infer<typeof existingOperatorSchema>;

/**
 * The existing operators as the proposer's context shows them. An operator whose signature uses a
 * sort outside the problem setup's sort menu cannot be referenced by a constant, so it is omitted.
 */
export function describeExistingOperators(
  operators: readonly OperatorDeclaration[],
): readonly ExistingOperator[] {
  return operators.flatMap((operator) => {
    const signature = menuSignature(operator);
    return signature === undefined
      ? []
      : [
          {
            symbol: operator.symbol,
            displayName: operator.presentation?.displayName ?? operator.symbol,
            parameters: signature.parameters,
            result: signature.result,
          },
        ];
  });
}

/**
 * The proposer's context: the problem, optional preferences, the existing operators it may
 * reference (absent on calls recorded before they were offered), and (on revision) the prior
 * round.
 */
export const backgroundProposerContextSchema = z
  .object({
    problem: z.string().min(1).max(20_000),
    preferences: z
      .object({ domains: uniqueShortTextsSchema, notation: uniqueShortTextsSchema })
      .strict()
      .optional(),
    operators: z.array(existingOperatorSchema).max(MAX_EXISTING_OPERATORS).optional(),
    revision: z
      .object({
        previousCallId: stableIdentifierSchema,
        previousProposal: backgroundProposalSchema,
        feedback: z.string().min(1).max(MAX_FEEDBACK_LENGTH),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BackgroundProposerContext = z.infer<typeof backgroundProposerContextSchema>;

const backgroundInsufficientContextSchema = z
  .object({
    kind: z.literal("insufficient-context"),
    requestedCategories: z
      .array(z.enum(["problem-detail", "level-preference", "notation-preference"]))
      .min(1)
      .max(3),
    rationale: shortTextSchema,
  })
  .strict();
const backgroundDeclinedSchema = z
  .object({ kind: z.literal("declined"), reason: shortTextSchema })
  .strict();

/** What a validated call can output: the proposal, a context request, or a refusal. */
export const backgroundProposerOutputSchema = z.union([
  backgroundProposalSchema,
  backgroundInsufficientContextSchema,
  backgroundDeclinedSchema,
]);
export type BackgroundProposerOutput = z.infer<typeof backgroundProposerOutputSchema>;

// Strict provider schemas require every property to be present, so optional public fields appear
// as nullable fields and a constant's signature uses the setup's sort menu names. The validated
// output is the normalized form below, in which each constant is a full `OperatorDeclaration`.
const profileShape = backgroundProfileSchema.shape;
const wireBackgroundProfileSchema = z
  .object({
    level: profileShape.level,
    summary: profileShape.summary,
    assumptions: profileShape.assumptions,
    domains: profileShape.domains.unwrap().nullable(),
    maximumLevel: profileShape.maximumLevel.unwrap().nullable(),
  })
  .strict();

const presentationShape = operatorDeclarationSchema.shape.presentation.unwrap().shape;
const latexShape = presentationShape.latex.unwrap().shape;
export const wireOperatorSchema = z
  .object({
    id: stableIdentifierSchema,
    symbol: problemSetupSymbolSchema,
    displayName: shortTextSchema,
    parameters: z.array(problemSetupSortIdSchema).min(1).max(MAX_CONSTANT_PARAMETERS),
    result: problemSetupSortIdSchema,
    latex: z
      .object({
        template: shortTextSchema,
        precedence: latexShape.precedence,
        parse: z
          .object({
            trigger: shortTextSchema,
            notation: latexShape.parse.unwrap().shape.notation,
          })
          .strict()
          .nullable(),
      })
      .strict(),
    naturalLanguage: z
      .object({ template: shortTextSchema, negated: shortTextSchema.nullable() })
      .strict(),
  })
  .strict();
const wireBackgroundProposalSchema = z
  .object({
    kind: z.literal("background-proposal"),
    background: wireBackgroundProfileSchema,
    constants: z
      .array(z.object({ operator: wireOperatorSchema, rationale: shortTextSchema }).strict())
      .max(MAX_BACKGROUND_CONSTANTS),
  })
  .strict();

/** The provider-facing result: strict, nullable-optional, and sort names instead of sort trees. */
export const backgroundProposerWireResultSchema = z.union([
  wireBackgroundProposalSchema,
  backgroundInsufficientContextSchema,
  backgroundDeclinedSchema,
]);
export type BackgroundProposerWireResult = z.infer<typeof backgroundProposerWireResultSchema>;

/**
 * Convert a provider result into the validated output. Every deterministic rule of
 * `backgroundProposalSchema` runs here; `undefined` means the output is rejected.
 */
export function normalizeBackgroundProposerWireResult(
  output: BackgroundProposerWireResult,
): BackgroundProposerOutput | undefined {
  if (output.kind !== "background-proposal") return output;
  const { domains, maximumLevel, ...profile } = output.background;
  const normalized = {
    kind: output.kind,
    background: {
      ...profile,
      ...(domains === null ? {} : { domains }),
      ...(maximumLevel === null ? {} : { maximumLevel }),
    },
    constants: output.constants.map(({ operator, rationale }) => ({
      operator: wireOperatorToDeclarationInput(operator),
      rationale,
    })),
  };
  try {
    const parsed = backgroundProposerOutputSchema.safeParse(normalized);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** An operator as the provider wrote it, in the unvalidated shape of an `OperatorDeclaration`. */
export function wireOperatorToDeclarationInput(
  operator: z.infer<typeof wireOperatorSchema>,
): unknown {
  const { latex, naturalLanguage } = operator;
  return {
    id: operator.id,
    symbol: operator.symbol,
    signature: {
      parameters: operator.parameters.map((id) => problemSetupSort(id)),
      result: problemSetupSort(operator.result),
    },
    presentation: {
      displayName: operator.displayName,
      latex: {
        template: latex.template,
        precedence: latex.precedence,
        ...(latex.parse === null ? {} : { parse: latex.parse }),
      },
      naturalLanguage: [
        {
          template: naturalLanguage.template,
          ...(naturalLanguage.negated === null ? {} : { negated: naturalLanguage.negated }),
        },
      ],
    },
  };
}

export const RESERVED_SYMBOL_LIST = [...RESERVED_BUILTIN_SYMBOLS].join(", ");
export const SORT_NAME_LIST = PROBLEM_SETUP_SORT_IDS.join(", ");

/** How a role must declare a constant (an operator); shared by every role that may declare one. */
export const OPERATOR_DECLARATION_GUIDANCE =
  "Declare each constant as an operator with at least one operand: a unique id, a plain-identifier symbol that is used consistently, a display name, a signature built only from these sort names: " +
  `${SORT_NAME_LIST}; a LaTeX template whose placeholders #1, #2, ... number the operands in signature order, with a precedence class and, if the notation can be typed, a parse trigger (a LaTeX command that occurs in the template) and notation; and a natural-language template that renders every operand with the same placeholders, plus, for a relation, an optional negated template that does too. `;

const BACKGROUND_PROPOSER_INTRODUCTION =
  "Propose the mathematical background and the constants for the supplied problem. Return only a background proposal, a permitted context request, or a refusal. Do not solve or prove the problem. " +
  "The background profile states the level and the knowledge relative to which a proof of this problem will be motivated. " +
  "The constants are the operators, relations and functions of the problem's own vocabulary that its hypotheses and goals use beyond the built-in symbols. The constants must suffice to formalize the problem: after the user accepts them, the formalizer may use only the built-in symbols and these constants, so include every operator the statement needs and none it does not need. " +
  `The reserved built-in symbols are always available and must never be declared as constants: ${RESERVED_SYMBOL_LIST}. ` +
  "Variables and named objects are not constants; the formalizer declares them. ";
const BACKGROUND_PROPOSER_CONCLUSION =
  "Give every constant a one-line rationale. " +
  "When the context contains a revision, apply the user's feedback to the previous proposal and return a complete replacement proposal, keeping what the feedback does not change.";

/**
 * The system message of calls recorded before existing operators were offered in the context. A
 * stored call may still carry it, so evidence stays readable; new calls use the current message.
 */
export const BACKGROUND_PROPOSER_PREVIOUS_SYSTEM_MESSAGE =
  BACKGROUND_PROPOSER_INTRODUCTION + OPERATOR_DECLARATION_GUIDANCE + BACKGROUND_PROPOSER_CONCLUSION;

/** The role's fixed system message; new calls are prepared with it. */
export const BACKGROUND_PROPOSER_SYSTEM_MESSAGE =
  BACKGROUND_PROPOSER_INTRODUCTION +
  "Some operators already exist: context.operators lists them with their symbol, display name and signature (in the sort names below), and they come from the available notation packs. To use an existing operator, declare a constant with exactly its symbol and exactly its signature, and its existing notation is used; never give an existing symbol another signature, and never reuse an existing operator's id or LaTeX parse trigger for a different symbol. When context.operators is absent or empty, no existing operators are known. " +
  OPERATOR_DECLARATION_GUIDANCE +
  BACKGROUND_PROPOSER_CONCLUSION;
