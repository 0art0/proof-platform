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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const backgroundConstantSchema = z
  .object({ operator: operatorDeclarationSchema, rationale: shortTextSchema })
  .strict();
export type BackgroundConstant = z.infer<typeof backgroundConstantSchema>;

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
    const ids = new Set<string>();
    const symbols = new Set<string>();
    const triggers = new Set<string>();
    proposal.constants.forEach(({ operator }, index) => {
      const at = (...path: PropertyKey[]) => ["constants", index, "operator", ...path];
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
  });
export type BackgroundProposal = z.infer<typeof backgroundProposalSchema>;

/** The proposer's context: the problem, optional preferences, and (on revision) the prior round. */
export const backgroundProposerContextSchema = z
  .object({
    problem: z.string().min(1).max(20_000),
    preferences: z
      .object({ domains: uniqueShortTextsSchema, notation: uniqueShortTextsSchema })
      .strict()
      .optional(),
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

export const backgroundInsufficientContextSchema = z
  .object({
    kind: z.literal("insufficient-context"),
    requestedCategories: z
      .array(z.enum(["problem-detail", "level-preference", "notation-preference"]))
      .min(1)
      .max(3),
    rationale: shortTextSchema,
  })
  .strict();
export const backgroundDeclinedSchema = z
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
const wireOperatorSchema = z
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

function wireOperatorToDeclarationInput(operator: z.infer<typeof wireOperatorSchema>): unknown {
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

const RESERVED_SYMBOL_LIST = [...RESERVED_BUILTIN_SYMBOLS].join(", ");
const SORT_NAME_LIST = PROBLEM_SETUP_SORT_IDS.join(", ");

/** The role's fixed system message; stored calls are checked against it. */
export const BACKGROUND_PROPOSER_SYSTEM_MESSAGE =
  "Propose the mathematical background and the constants for the supplied problem. Return only a background proposal, a permitted context request, or a refusal. Do not solve or prove the problem. " +
  "The background profile states the level and the knowledge relative to which a proof of this problem will be motivated. " +
  "The constants are the operators, relations and functions of the problem's own vocabulary that its hypotheses and goals use beyond the built-in symbols. The constants must suffice to formalize the problem: after the user accepts them, the formalizer may use only the built-in symbols and these constants, so include every operator the statement needs and none it does not need. " +
  `The reserved built-in symbols are always available and must never be declared as constants: ${RESERVED_SYMBOL_LIST}. ` +
  "Variables and named objects are not constants; the formalizer declares them. " +
  "Declare each constant as an operator with at least one operand: a unique id, a plain-identifier symbol that is used consistently, a display name, a signature built only from these sort names: " +
  `${SORT_NAME_LIST}; a LaTeX template whose placeholders #1, #2, ... number the operands in signature order, with a precedence class and, if the notation can be typed, a parse trigger (a LaTeX command that occurs in the template) and notation; and a natural-language template that renders every operand with the same placeholders, plus, for a relation, an optional negated template that does too. ` +
  "Give every constant a one-line rationale. " +
  "When the context contains a revision, apply the user's feedback to the previous proposal and return a complete replacement proposal, keeping what the feedback does not change.";
