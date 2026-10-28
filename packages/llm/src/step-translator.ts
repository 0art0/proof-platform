/**
 * The step translator (`docs/motivated-proof-plans.md` section 4): Jev turns one step of a stored
 * proof plan into one of the actions the platform displays. Jev answers Choice questions, so the
 * role asks either which candidate action carries out the step (`action`) or which displayed item
 * each of the chosen suggestion's menus needs (`menus`).
 *
 * The context is minimal (design plan section 15.3): the one step, the claim its step list proves,
 * the focused goal, the moves already applied for the step and the candidates the platform
 * computed. Never the problem text, the rest of the plan or other branches.
 *
 * This module is self-contained on purpose: `index.ts` composes these schemas into the role's
 * envelope, output validation and evidence, and nothing here depends on `index.ts`.
 */
import { stableIdentifierSchema } from "@proof/protocol";
import { jsonValueEquals } from "@proof/mathjson-model";
import { z } from "zod";
import { proofPlanClaimSchema, proofPlanStepSchema, proofPlanStepFormSchema } from "./proof-plan";

export const MAX_TRANSLATOR_CANDIDATES = 48;
export const MAX_TRANSLATOR_MENUS = 8;
export const MAX_TRANSLATOR_MENU_ITEMS = 48;
const MAX_CRITERION_LENGTH = 500;

/** Reserved options. They are never candidate or item IDs. */
export const NO_MOVE_CHOICE_ID = "outcome:no-move";
export const STEP_REALIZED_CHOICE_ID = "outcome:step-realized";
export const NO_FITTING_ITEM_CHOICE_ID = "outcome:no-fitting-item";
export const NO_MOVE_CRITERION =
  "None of the listed actions carries out this proof step or a part of it.";
export const STEP_REALIZED_CRITERION = "The actions already taken carry out this proof step.";
export const NO_FITTING_ITEM_CRITERION =
  "None of the listed values is the one this proof step needs.";
const RESERVED_IDS: ReadonlySet<string> = new Set([
  NO_MOVE_CHOICE_ID,
  STEP_REALIZED_CHOICE_ID,
  NO_FITTING_ITEM_CHOICE_ID,
]);

const labelSchema = z.string().min(1).max(MAX_CRITERION_LENGTH);
const latexSchema = z.string().min(1).max(2_000);

const planReferenceSchema = z
  .object({
    callId: stableIdentifierSchema,
    stepId: z.string().min(1).max(48),
    number: z.string().min(1).max(40),
    form: proofPlanStepFormSchema,
  })
  .strict();

/** The step as the plan states it, with each `actsOn` entry resolved to what it names. */
const translatorStepSchema = proofPlanStepSchema
  .pick({ claim: true, variables: true, assumptions: true, term: true, by: true, motivation: true })
  .extend({
    actsOn: z
      .array(
        z
          .object({ reference: z.string().min(1).max(48), statement: latexSchema.nullable() })
          .strict(),
      )
      .max(8),
  })
  .strict();

const focusSchema = z
  .object({
    targetId: stableIdentifierSchema,
    conclusion: latexSchema,
    hypotheses: z
      .array(z.object({ id: stableIdentifierSchema, statement: latexSchema }).strict())
      .max(64),
  })
  .strict();

const candidateSchema = z
  .object({
    id: stableIdentifierSchema,
    label: labelSchema,
    source: z.enum(["result", "move"]),
    artifactId: stableIdentifierSchema,
    selections: z.array(latexSchema).min(1).max(8),
    reasons: z.array(z.string().min(1).max(500)).max(16),
  })
  .strict();
export type TranslatorCandidate = z.infer<typeof candidateSchema>;

const menuSchema = z
  .object({
    parameterId: stableIdentifierSchema,
    label: labelSchema,
    items: z
      .array(z.object({ id: stableIdentifierSchema, label: labelSchema }).strict())
      .min(1)
      .max(MAX_TRANSLATOR_MENU_ITEMS),
  })
  .strict();
export type TranslatorMenu = z.infer<typeof menuSchema>;

const actionContextSchema = z
  .object({
    kind: z.literal("action"),
    plan: planReferenceSchema,
    step: translatorStepSchema,
    enclosingClaim: proofPlanClaimSchema,
    focus: focusSchema,
    movesSoFar: z.array(labelSchema).max(8),
    candidates: z.array(candidateSchema).max(MAX_TRANSLATOR_CANDIDATES),
    /** Whether `outcome:step-realized` is offered (only after a move, when no check decides). */
    offerRealized: z.boolean(),
  })
  .strict();

const menusContextSchema = z
  .object({
    kind: z.literal("menus"),
    plan: planReferenceSchema,
    step: translatorStepSchema,
    focus: focusSchema,
    suggestion: z.object({ name: labelSchema, artifactId: stableIdentifierSchema }).strict(),
    menus: z.array(menuSchema).min(1).max(MAX_TRANSLATOR_MENUS),
  })
  .strict();

export const stepTranslatorContextSchema = z
  .discriminatedUnion("kind", [actionContextSchema, menusContextSchema])
  .superRefine((context, refinement) => {
    const ids =
      context.kind === "action"
        ? context.candidates.map(({ id }) => id)
        : context.menus.flatMap(({ items }) => items.map(({ id }) => id));
    if (ids.some((id) => RESERVED_IDS.has(id))) {
      refinement.addIssue({
        code: "custom",
        message: "A choice cannot use a reserved outcome ID.",
      });
    }
    if (context.kind === "action" && new Set(ids).size !== ids.length) {
      refinement.addIssue({ code: "custom", message: "Candidate IDs must be unique." });
    }
    if (context.kind === "menus") {
      const parameters = context.menus.map(({ parameterId }) => parameterId);
      if (new Set(parameters).size !== parameters.length) {
        refinement.addIssue({ code: "custom", message: "Menus must be for distinct parameters." });
      }
    }
  });
export type StepTranslatorContext = z.infer<typeof stepTranslatorContextSchema>;

export type JevQuestion = Readonly<{
  type: "choice";
  instructions: string;
  criteria: Readonly<Record<string, string>>;
}>;

const ACTION_INSTRUCTIONS =
  "The state describes one step of a structured proof and the actions the proof platform offers on the focused goal. Choose the action that carries out this step, or the first part of it when it needs several actions. Choose the no-move option only if no listed action does any part of the step. Choose the step-realized option, when offered, only if the actions already taken carry out the whole step.";
const MENU_INSTRUCTIONS =
  "The state describes one step of a structured proof and the action chosen to carry it out. Choose the listed value of this parameter that the step needs. Choose the no-fitting-value option only if none of the listed values is it.";

/** The Choice questions of a translator call, derived from its context alone. */
export function translatorQuestions(
  context: StepTranslatorContext,
): Readonly<Record<string, JevQuestion>> {
  if (context.kind === "action") {
    return {
      action: {
        type: "choice",
        instructions: ACTION_INSTRUCTIONS,
        criteria: {
          ...Object.fromEntries(context.candidates.map(({ id, label }) => [id, label])),
          [NO_MOVE_CHOICE_ID]: NO_MOVE_CRITERION,
          ...(context.offerRealized ? { [STEP_REALIZED_CHOICE_ID]: STEP_REALIZED_CRITERION } : {}),
        },
      },
    };
  }
  return Object.fromEntries(
    context.menus.map((menu, index) => [
      menuQuestionId(index),
      {
        type: "choice" as const,
        instructions: `${MENU_INSTRUCTIONS} Parameter: ${menu.label}.`,
        criteria: {
          ...Object.fromEntries(menu.items.map(({ id, label }) => [id, label])),
          [NO_FITTING_ITEM_CHOICE_ID]: NO_FITTING_ITEM_CRITERION,
        },
      },
    ]),
  );
}

export function menuQuestionId(index: number): string {
  return `menu-${index + 1}`;
}

const probabilitiesSchema = z.record(z.string().min(1), z.number().finite().min(0).max(1));

/** What the transport stores: the exact request and Jev's answer to every question. */
export const jevChoicesResultSchema = z
  .object({
    kind: z.literal("jev-choices"),
    providerRequest: z
      .object({
        model: z.string().min(1).max(200),
        state: z.unknown(),
        questions: z.record(z.string().min(1), z.unknown()),
      })
      .strict(),
    providerOutput: z.record(
      z.string().min(1),
      z
        .object({
          choice: z.string().min(1),
          probabilities: probabilitiesSchema,
          confidence: z.number().finite().min(0).max(1),
        })
        .strict(),
    ),
  })
  .strict();

const answerSchema = z
  .object({
    choice: z.string().min(1),
    confidence: z.number().finite().min(0).max(1),
    /** Every option, most probable first (ties in option order). */
    ranked: z
      .array(
        z
          .object({ id: z.string().min(1), probability: z.number().finite().min(0).max(1) })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type TranslatorAnswer = z.infer<typeof answerSchema>;

export const stepTranslatorOutputSchema = z
  .object({
    kind: z.literal("translator-choices"),
    answers: z.record(z.string().min(1), answerSchema),
  })
  .strict();
export type StepTranslatorOutput = z.infer<typeof stepTranslatorOutputSchema>;

/**
 * Check Jev's answers against the call: the request is exactly the envelope and the questions the
 * context implies, every question has a distribution over exactly its options, and each choice is
 * that distribution's most probable option.
 */
export function normalizeJevChoices(
  raw: z.infer<typeof jevChoicesResultSchema>,
  envelope: unknown,
  context: StepTranslatorContext,
): Readonly<{ ok: true; output: StepTranslatorOutput }> | Readonly<{ ok: false; message: string }> {
  const questions = translatorQuestions(context);
  if (
    !jsonValueEquals(raw.providerRequest.state, envelope) ||
    !jsonValueEquals(raw.providerRequest.questions, questions)
  ) {
    return { ok: false, message: "The Jev request does not match the translator call." };
  }
  const answers: Record<string, TranslatorAnswer> = {};
  for (const [questionId, question] of Object.entries(questions)) {
    const answer = raw.providerOutput[questionId];
    if (answer === undefined) return { ok: false, message: `Jev did not answer ${questionId}.` };
    const options = Object.keys(question.criteria);
    const given = Object.keys(answer.probabilities);
    if (!jsonValueEquals([...given].sort(), [...options].sort())) {
      return { ok: false, message: `Jev's ${questionId} probabilities are not over its options.` };
    }
    const total = Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0);
    const highest = Math.max(...Object.values(answer.probabilities));
    if (Math.abs(total - 1) > 0.02 || answer.probabilities[answer.choice] !== highest) {
      return {
        ok: false,
        message: `Jev's ${questionId} answer is not a distribution with its choice on top.`,
      };
    }
    const ranked = options
      .map((id, order) => ({ id, order, probability: answer.probabilities[id]! }))
      .sort((left, right) => right.probability - left.probability || left.order - right.order)
      .map(({ id, probability }) => ({ id, probability }));
    answers[questionId] = { choice: answer.choice, confidence: answer.confidence, ranked };
  }
  if (Object.keys(raw.providerOutput).some((questionId) => !(questionId in questions))) {
    return { ok: false, message: "Jev answered a question that was not asked." };
  }
  return { ok: true, output: { kind: "translator-choices", answers } };
}

/** Truncate a label to the criterion limit without splitting a surrogate pair. */
export function criterionLabel(text: string): string {
  const characters = [...text];
  return characters.length <= MAX_CRITERION_LENGTH
    ? text
    : `${characters.slice(0, MAX_CRITERION_LENGTH - 1).join("")}…`;
}

/** Jev is called through `/v1/evaluate`; there is no chat system message, but calls record one. */
export const STEP_TRANSLATOR_SYSTEM_MESSAGE =
  "Choose only among the supplied candidate actions, menu items and reserved outcomes. Do not propose operations or new mathematics.";
