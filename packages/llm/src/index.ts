import {
  backgroundProfileSchema,
  BUILTIN_BINDER_SPECIFICATIONS,
  declarationSchema,
  freeSymbolNames,
  operatorDeclarationSchema,
  plainMathJsonSchema,
  retrievalWildcardSchema,
  sortSchema,
  stableIdentifierSchema,
  type OperatorDeclaration,
  type PlainMathJson,
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  problemDraftSchema,
  problemStatementInputSchema,
  problemSetupLayerIdSchema,
  problemSetupPackIdSchema,
  problemSetupSortIdSchema,
  suggestionSetMatchesNode,
  type DisplayedSuggestionSet,
  type ProofNode,
} from "@proof/protocol";
import { canonicalJsonEquals, jsonValueEquals } from "@proof/mathjson-model";
import { z } from "zod";
import {
  BACKGROUND_PROPOSER_PREVIOUS_SYSTEM_MESSAGE,
  BACKGROUND_PROPOSER_SYSTEM_MESSAGE,
  MAX_EXISTING_OPERATORS,
  backgroundProposerContextSchema,
  backgroundProposerOutputSchema,
  backgroundProposerWireResultSchema,
  describeExistingOperators,
  normalizeBackgroundProposerWireResult,
} from "./background-proposer";
import {
  LIBRARIAN_PREVIOUS_SYSTEM_MESSAGE,
  LIBRARIAN_SYSTEM_MESSAGE,
  librarianContextSchema,
  librarianOutputSchema,
  librarianWireResultSchema,
  normalizeLibrarianWireResult,
} from "./librarian";
import {
  MOVE_AUTHOR_MAX_EXAMPLES,
  MOVE_AUTHOR_PREVIOUS_SYSTEM_MESSAGE,
  MOVE_AUTHOR_SYSTEM_MESSAGE,
  describePrimitives,
  moveAuthorContextSchema,
  moveAuthorFindingSchema,
  moveAuthorOutputSchema,
  moveAuthorProposalSchema,
  moveAuthorWireResultSchema,
  normalizeMoveAuthorWireResult,
  proposalProblem,
  type MoveAuthorContext,
} from "./move-author";
import { abstractSituation } from "./move-author-situation";
import {
  MAX_PLAN_STEPS,
  executorInsufficientContextSchema,
  executorPlanProposalSchema,
  executorResultCardSchema,
  executorWirePlanSchema,
  normalizeWireStep,
  planUsesForbiddenOperation,
  stepResultIds,
  type ExecutorPlanProposal,
  type ExecutorResultCard,
} from "./move-executor-plan";

export * from "./move-executor-plan";
export {
  MOVE_AUTHOR_EXTENSION_KINDS,
  MOVE_AUTHOR_MAX_EXAMPLES,
  MOVE_AUTHOR_MAX_FEEDBACK,
  MOVE_AUTHOR_PARAMETER_KINDS,
  MOVE_AUTHOR_PREVIOUS_SYSTEM_MESSAGE,
  MOVE_AUTHOR_SYSTEM_MESSAGE,
  describePrimitives,
  moveAuthorContextSchema,
  moveAuthorExampleSchema,
  moveAuthorExtensionKindSchema,
  moveAuthorFindingSchema,
  moveAuthorOutputSchema,
  moveAuthorParameterKind,
  moveAuthorProposalSchema,
  moveAuthorWireResultSchema,
  primitiveSpecSchema,
  type MoveAuthorContext,
  type MoveAuthorExample,
  type MoveAuthorExtensionKind,
  type MoveAuthorFinding,
  type MoveAuthorOutput,
  type MoveAuthorProposal,
  type PrimitiveSpec,
} from "./move-author";
export {
  SITUATION_STATE_ID,
  SITUATION_TARGET_ID,
  abstractSituation,
  situationSchema,
  type Situation,
} from "./move-author-situation";
export { compileMoveAuthorProposal, proposedMoveId } from "./move-author-template";

export const SUPPORTED_LLM_ROLES = [
  "topic-extractor",
  "proof-state-formalizer",
  "move-shortlister",
  "background-proposer",
  "move-executor",
  "librarian",
  "move-author",
] as const;
const supportedLlmRoleSchema = z.enum(SUPPORTED_LLM_ROLES);
export type SupportedLlmRole = z.infer<typeof supportedLlmRoleSchema>;
export type RenderedMathematics = Readonly<{ latex: string; naturalLanguage: string }>;

export const llmCallIdSchema = stableIdentifierSchema.brand("LlmCallId");
export type LlmCallId = z.infer<typeof llmCallIdSchema>;

const boundedTextSchema = z.string().min(1).max(20_000);
const shortTextSchema = z.string().min(1).max(500);
const uniqueShortTextsSchema = z
  .array(shortTextSchema)
  .max(64)
  .superRefine((values, context) => addDuplicateIssues(values, context));

export { backgroundProfileSchema, type BackgroundProfile } from "@proof/protocol";
export * from "./transport";
export {
  BACKGROUND_PROPOSER_PREVIOUS_SYSTEM_MESSAGE,
  MAX_BACKGROUND_CONSTANTS,
  MAX_EXISTING_OPERATORS,
  backgroundProposalSchema,
  backgroundProposerOutputSchema,
  type BackgroundConstant,
  type BackgroundProposal,
  type BackgroundProposerContext,
  type BackgroundProposerOutput,
  type ExistingOperator,
} from "./background-proposer";
export {
  MAX_LIBRARIAN_ACTIVATED_CONSTANTS,
  MAX_LIBRARIAN_CONTEXT_CONSTANTS,
  MAX_LIBRARIAN_CONTEXT_RESULTS,
  MAX_LIBRARIAN_NEW_CONSTANTS,
  MAX_LIBRARIAN_RESULTS,
  MAX_LIBRARIAN_SITUATION_SELECTIONS,
  buildLibrarianSituation,
  librarianContextConstants,
  librarianContextSchema,
  librarianNewConstants,
  librarianOutputSchema,
  librarianProposalSchema,
  librarianResultSchema,
  librarianSituationSchema,
  type LibrarianContext,
  type LibrarianExistingResult,
  type LibrarianOutput,
  type LibrarianProposal,
  type LibrarianRequestKind,
  type LibrarianResult,
  type LibrarianSituation,
  type LibrarianTopUpContext,
  type LibrarianTopUpKind,
  type LibrarianUnusableResult,
} from "./librarian";

const topicExtractorContextSchema = z
  .object({
    problem: boundedTextSchema,
    background: backgroundProfileSchema,
    preferences: z
      .object({ domains: uniqueShortTextsSchema, notation: uniqueShortTextsSchema })
      .strict()
      .optional(),
  })
  .strict();

const selectionLocationSchema = z
  .object({
    target: z.object({ kind: z.enum(["goal", "obligation"]), id: stableIdentifierSchema }).strict(),
    statement: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("conclusion") }).strict(),
      z.object({ kind: z.literal("hypothesis"), id: stableIdentifierSchema }).strict(),
    ]),
    occurrence: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("exact"), path: z.array(z.number().int().nonnegative()) })
        .strict(),
      z
        .object({
          kind: z.literal("associative"),
          containerPath: z.array(z.number().int().nonnegative()),
          startOperand: z.number().int().nonnegative(),
          endOperand: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
  })
  .strict();

const selectionPositionSchema = z
  .object({
    polarity: z.enum(["positive", "negative", "mixed", "neutral"]),
    role: z.enum(["proposition", "term", "binder"]),
  })
  .strict();

const shortlisterSelectionSchema = z
  .object({
    id: stableIdentifierSchema,
    location: selectionLocationSchema,
    position: selectionPositionSchema,
    expression: plainMathJsonSchema.optional(),
    abstraction: retrievalWildcardSchema.optional(),
    declarations: z.array(declarationSchema),
    operators: z.array(operatorDeclarationSchema),
  })
  .strict()
  .superRefine((selection, context) => {
    if ((selection.expression === undefined) === (selection.abstraction === undefined)) {
      context.addIssue({
        code: "custom",
        message: "A selection must expose an expression or an abstraction, not both.",
      });
    }
  });
export type ShortlisterSelection = z.infer<typeof shortlisterSelectionSchema>;

const candidateCardSchema = z
  .object({
    id: stableIdentifierSchema,
    source: z.enum(["result", "move"]),
    artifactId: stableIdentifierSchema,
    name: shortTextSchema,
    applicability: z.enum(["applicable", "requires-input"]),
    abstractionFit: z.enum(["not-used", "compatible", "unknown"]),
    reasons: z.array(shortTextSchema).min(1).max(16),
    selectionMatches: z.array(
      z
        .object({
          selectionId: stableIdentifierSchema,
          selectionSlotId: stableIdentifierSchema.optional(),
        })
        .strict(),
    ),
    unresolvedSelectionSlots: z.array(stableIdentifierSchema),
    unresolvedParameters: z.array(stableIdentifierSchema),
  })
  .strict();
type CandidateCard = z.infer<typeof candidateCardSchema>;

/**
 * Why a shortlist was requested: the user pressed the button (`explicit-user`), the user's
 * selections produced a list and automatic ranking was on (`automatic`), or the deterministic
 * list was empty (`deterministic-empty`).
 */
const SHORTLISTER_TRIGGERS = ["deterministic-empty", "explicit-user", "automatic"] as const;
export const shortlisterTriggerSchema = z.enum(SHORTLISTER_TRIGGERS);

/**
 * The reserved Jev option meaning "no displayed candidate is relevant to the selections". It is
 * added to the Choice question next to the candidates and can never be a candidate ID.
 */
export const NONE_RELEVANT_CHOICE_ID = "outcome:none-relevant";
export const NONE_RELEVANT_CRITERION =
  "None of the displayed suggestions is relevant to the selected fragment.";

const moveShortlisterContextSchema = z
  .object({
    nodeId: stableIdentifierSchema,
    stateId: stableIdentifierSchema,
    suggestionSetId: stableIdentifierSchema,
    trigger: shortlisterTriggerSchema,
    selections: z.array(shortlisterSelectionSchema).min(1).max(16),
    candidates: z.array(candidateCardSchema).min(1).max(32),
    maxChoices: z.number().int().min(1).max(8),
  })
  .strict()
  .superRefine((context, refinement) => {
    if (context.candidates.some(({ id }) => id === NONE_RELEVANT_CHOICE_ID)) {
      refinement.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "A candidate cannot use the reserved none-relevant ID.",
      });
    }
  });
export type MoveShortlisterContext = z.infer<typeof moveShortlisterContextSchema>;

/**
 * Where a move description came from: the user's own instruction box, or a technique another
 * service suggested (for example the shortlister's pick) that the user asked to carry out.
 */
const EXECUTOR_SOURCES = ["user-instruction", "shortlisted-technique"] as const;
export const executorSourceSchema = z.enum(EXECUTOR_SOURCES);
export type ExecutorSource = z.infer<typeof executorSourceSchema>;

/** The longest move description the executor is given. */
export const MAX_EXECUTOR_INSTRUCTION_LENGTH = 2_000;
/** The most approved results the executor is shown. */
const MAX_EXECUTOR_RESULTS = 32;
const MAX_EXECUTOR_HYPOTHESES = 64;
const MAX_EXECUTOR_DECLARATIONS = 256;
const MAX_EXECUTOR_OPERATORS = 128;

const executorTargetSchema = z
  .object({ kind: z.enum(["goal", "obligation"]), id: stableIdentifierSchema })
  .strict();

/** A selection as the executor sees it: where it is, its role, and the selected fragment. */
const executorSelectionSchema = z
  .object({
    id: stableIdentifierSchema,
    location: selectionLocationSchema,
    position: selectionPositionSchema,
    expression: plainMathJsonSchema,
  })
  .strict();
export type ExecutorSelection = z.infer<typeof executorSelectionSchema>;

const moveExecutorContextSchema = z
  .object({
    nodeId: stableIdentifierSchema,
    stateId: stableIdentifierSchema,
    instruction: z.string().min(1).max(MAX_EXECUTOR_INSTRUCTION_LENGTH),
    source: executorSourceSchema,
    target: executorTargetSchema,
    selections: z.array(executorSelectionSchema).max(16),
    /** The target sequent only, restricted to the declarations its statements use. */
    sequent: z
      .object({
        declarations: z.array(declarationSchema).max(MAX_EXECUTOR_DECLARATIONS),
        hypotheses: z
          .array(z.object({ id: stableIdentifierSchema, expression: plainMathJsonSchema }).strict())
          .max(MAX_EXECUTOR_HYPOTHESES),
        conclusion: plainMathJsonSchema,
      })
      .strict(),
    /** Active operator declarations: the vocabulary a proposition may use. */
    operators: z.array(operatorDeclarationSchema).max(MAX_EXECUTOR_OPERATORS),
    /** Approved results relevant to the selections. */
    results: z.array(executorResultCardSchema).max(MAX_EXECUTOR_RESULTS),
    maxSteps: z.literal(MAX_PLAN_STEPS),
  })
  .strict()
  .superRefine((context, refinement) => {
    addDuplicateIssues(
      context.results.map(({ id }) => id),
      refinement,
    );
    addDuplicateIssues(
      context.sequent.hypotheses.map(({ id }) => id),
      refinement,
    );
  });
type MoveExecutorContext = z.infer<typeof moveExecutorContextSchema>;

const envelopeBaseShape = {
  id: llmCallIdSchema,
  schemaVersion: z.literal("llm-context/v1"),
};
const topicExtractorEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    role: z.literal("topic-extractor"),
    context: topicExtractorContextSchema,
  })
  .strict();
/** The formalizer is shown at most this many library results. */
export const MAX_FORMALIZER_LIBRARY_RESULTS = 64;
const formalizerLibraryResultSchema = z
  .object({
    id: stableIdentifierSchema,
    name: shortTextSchema,
    description: boundedTextSchema,
    statement: plainMathJsonSchema,
    premises: z.array(plainMathJsonSchema).max(32),
  })
  .strict();
const formalizerContextSchema = z
  .object({
    problem: problemDraftSchema.shape.problem,
    background: backgroundProfileSchema,
    preferences: problemDraftSchema.shape.preferences,
    libraryLayerIds: z.array(problemSetupLayerIdSchema).max(4),
    packs: z.array(problemSetupPackIdSchema).max(7),
    approvedLibrary: z
      .object({
        results: z.array(formalizerLibraryResultSchema).max(MAX_FORMALIZER_LIBRARY_RESULTS),
        operators: z.array(operatorDeclarationSchema).max(128),
        sorts: z.array(problemSetupSortIdSchema).max(11),
      })
      .strict(),
  })
  .strict()
  .superRefine((context, refinement) => {
    addDuplicateIssues(context.libraryLayerIds, refinement);
    addDuplicateIssues(context.packs, refinement);
    addDuplicateIssues(
      context.approvedLibrary.results.map(({ id }) => id),
      refinement,
    );
    addDuplicateIssues(context.approvedLibrary.sorts, refinement);
  });
type ProofStateFormalizerContext = z.infer<typeof formalizerContextSchema>;
const moveShortlisterEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    role: z.literal("move-shortlister"),
    context: moveShortlisterContextSchema,
  })
  .strict();
const proofStateFormalizerEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    role: z.literal("proof-state-formalizer"),
    context: formalizerContextSchema,
  })
  .strict();
const backgroundProposerEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    role: z.literal("background-proposer"),
    context: backgroundProposerContextSchema,
  })
  .strict();
const moveExecutorEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    role: z.literal("move-executor"),
    context: moveExecutorContextSchema,
  })
  .strict();
const moveAuthorEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    role: z.literal("move-author"),
    context: moveAuthorContextSchema,
  })
  .strict();
const librarianEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    role: z.literal("librarian"),
    context: librarianContextSchema,
  })
  .strict();
export const llmContextEnvelopeSchema = z.discriminatedUnion("role", [
  topicExtractorEnvelopeSchema,
  proofStateFormalizerEnvelopeSchema,
  moveShortlisterEnvelopeSchema,
  backgroundProposerEnvelopeSchema,
  moveExecutorEnvelopeSchema,
  librarianEnvelopeSchema,
  moveAuthorEnvelopeSchema,
]);
export type LlmContextEnvelope = z.infer<typeof llmContextEnvelopeSchema>;

export type LlmBoundaryDiagnosticCode =
  | "invalid-request"
  | "stale-evidence"
  | "unsupported-binder-context"
  | "candidate-not-found"
  | "invalid-output"
  | "transport-failed";
/**
 * Safe, closed classification of a transport failure. It is derived from HTTP status and local
 * conditions only; provider text, headers and credentials are never part of it.
 */
const LLM_TRANSPORT_FAILURE_SUBCODES = [
  "rate-limited",
  "server-error",
  "timeout",
  "network",
  "auth",
  "bad-request",
  "invalid-response",
  "missing-confidence",
] as const;
export type LlmTransportFailureSubcode = (typeof LLM_TRANSPORT_FAILURE_SUBCODES)[number];

/** Thrown by transports; only its `subcode` is retained in call evidence. */
export class LlmTransportError extends Error {
  readonly subcode: LlmTransportFailureSubcode;
  constructor(subcode: LlmTransportFailureSubcode) {
    super(`LLM transport failure: ${subcode}`);
    this.name = "LlmTransportError";
    this.subcode = subcode;
  }
}

export type LlmBoundaryDiagnostic = Readonly<{
  code: LlmBoundaryDiagnosticCode;
  message: string;
  subcode?: LlmTransportFailureSubcode | undefined;
}>;
const llmBoundaryDiagnosticSchema: z.ZodType<LlmBoundaryDiagnostic> = z
  .object({
    code: z.enum([
      "invalid-request",
      "stale-evidence",
      "unsupported-binder-context",
      "candidate-not-found",
      "invalid-output",
      "transport-failed",
    ]),
    message: z.string().min(1),
    subcode: z.enum(LLM_TRANSPORT_FAILURE_SUBCODES).optional(),
  })
  .strict();
type LlmBoundaryFailure = Readonly<{
  ok: false;
  diagnostics: readonly [LlmBoundaryDiagnostic];
}>;
export type BuildLlmContextResult =
  | Readonly<{ ok: true; envelope: LlmContextEnvelope; diagnostics: readonly [] }>
  | LlmBoundaryFailure;
export type RoleLlmContextResult<Role extends LlmContextEnvelope["role"]> =
  | Readonly<{
      ok: true;
      envelope: Extract<LlmContextEnvelope, { role: Role }>;
      diagnostics: readonly [];
    }>
  | LlmBoundaryFailure;

const topicExtractorRequestSchema = z
  .object({
    id: llmCallIdSchema,
    problem: boundedTextSchema,
    background: backgroundProfileSchema,
    preferences: topicExtractorContextSchema.shape.preferences,
  })
  .strict();

/** Project the initial problem into a topic-only envelope with no proof-state authority. */
export function buildTopicExtractorContext(input: unknown): BuildLlmContextResult {
  const request = safeParsePlain(topicExtractorRequestSchema, input);
  if (request === undefined) return failure("invalid-request", "The topic request is invalid.");
  return envelopeSuccess({
    id: request.id,
    schemaVersion: "llm-context/v1",
    role: "topic-extractor",
    context: {
      problem: request.problem,
      background: request.background,
      ...(request.preferences === undefined ? {} : { preferences: request.preferences }),
    },
  });
}

const backgroundProposerRequestSchema = z
  .object({
    id: llmCallIdSchema,
    problem: backgroundProposerContextSchema.shape.problem,
    preferences: backgroundProposerContextSchema.shape.preferences,
    /** The operators that already exist (the global registry), which constants may reference. */
    operators: z.array(operatorDeclarationSchema).max(MAX_EXISTING_OPERATORS).optional(),
    revision: backgroundProposerContextSchema.shape.revision,
  })
  .strict();

/**
 * Project the problem statement (and, on a revision, the previous proposal and the user's
 * feedback) into a background-proposer envelope. The previous proposal is validated like any
 * proposal, so a forged one is refused. The existing operators, when supplied, appear in the
 * context as symbol, display name and signature, so that a constant can reference one.
 */
export function buildBackgroundProposerContext(
  input: unknown,
): RoleLlmContextResult<"background-proposer"> {
  const request = safeParsePlain(backgroundProposerRequestSchema, input);
  if (request === undefined) {
    return failure("invalid-request", "The background proposer request is invalid.");
  }
  return envelopeSuccess({
    id: request.id,
    schemaVersion: "llm-context/v1",
    role: "background-proposer",
    context: {
      problem: request.problem,
      ...(request.preferences === undefined ? {} : { preferences: request.preferences }),
      ...(request.operators === undefined
        ? {}
        : { operators: describeExistingOperators(request.operators) }),
      ...(request.revision === undefined ? {} : { revision: request.revision }),
    },
  }) as RoleLlmContextResult<"background-proposer">;
}

const librarianRequestIdSchema = z.looseObject({ id: llmCallIdSchema });

/**
 * Build a librarian envelope. The request is the call ID plus the context: the request kind with
 * the background, the constants to cover and the results already in the library. There is no
 * problem statement in a librarian's context, and a request that carries one (or any other field)
 * is refused.
 */
export function buildLibrarianContext(input: unknown): RoleLlmContextResult<"librarian"> {
  const identified = safeParsePlain(librarianRequestIdSchema, input);
  if (identified === undefined) {
    return failure("invalid-request", "The librarian request is invalid.");
  }
  const { id, ...candidate } = identified;
  const context = safeParsePlain(librarianContextSchema, candidate);
  if (context === undefined) return failure("invalid-request", "The librarian request is invalid.");
  return envelopeSuccess({
    id,
    schemaVersion: "llm-context/v1",
    role: "librarian",
    context,
  }) as RoleLlmContextResult<"librarian">;
}

const proofStateFormalizerRequestSchema = z
  .object({
    id: llmCallIdSchema,
    problem: formalizerContextSchema.shape.problem,
    background: backgroundProfileSchema,
    preferences: formalizerContextSchema.shape.preferences,
    libraryLayerIds: formalizerContextSchema.shape.libraryLayerIds,
    packs: formalizerContextSchema.shape.packs,
    approvedLibrary: formalizerContextSchema.shape.approvedLibrary,
  })
  .strict();

/** Build a bounded setup envelope from the original problem and explicitly approved library. */
export function buildProofStateFormalizerContext(
  input: unknown,
): RoleLlmContextResult<"proof-state-formalizer"> {
  const request = safeParsePlain(proofStateFormalizerRequestSchema, input);
  if (request === undefined) {
    return failure("invalid-request", "The proof-state formalizer request is invalid.");
  }
  return envelopeSuccess({
    id: request.id,
    schemaVersion: "llm-context/v1",
    role: "proof-state-formalizer",
    context: {
      problem: request.problem,
      background: request.background,
      ...(request.preferences === undefined ? {} : { preferences: request.preferences }),
      libraryLayerIds: request.libraryLayerIds,
      packs: request.packs,
      approvedLibrary: request.approvedLibrary,
    },
  }) as RoleLlmContextResult<"proof-state-formalizer">;
}

const moveShortlisterRequestSchema = z
  .object({
    id: llmCallIdSchema,
    node: z.unknown(),
    suggestionSet: z.unknown(),
    candidateIds: z.array(stableIdentifierSchema).min(1).max(32),
    trigger: shortlisterTriggerSchema,
    maxChoices: z.number().int().min(1).max(8).default(5),
    operators: z.array(operatorDeclarationSchema).default([]),
  })
  .strict()
  .superRefine((request, context) => addDuplicateIssues(request.candidateIds, context));

/** Build a minimal local shortlist envelope from recorded deterministic evidence. */
export function buildMoveShortlisterContext(input: unknown): BuildLlmContextResult {
  const request = safeParsePlain(moveShortlisterRequestSchema, input);
  if (request === undefined) {
    return failure("invalid-request", "The move-shortlister request is invalid.");
  }
  const node = safeParsePlain(
    createProofNodeSchema({ operators: request.operators }),
    request.node,
  );
  const suggestionSet = safeParsePlain(displayedSuggestionSetSchema, request.suggestionSet);
  if (node === undefined || suggestionSet === undefined) {
    return failure("invalid-request", "The proof node or displayed suggestions are invalid.");
  }
  if (!suggestionSetMatchesNode(suggestionSet, node, { operators: request.operators })) {
    return failure("stale-evidence", "The displayed suggestions do not belong to this snapshot.");
  }
  const byId = new Map(suggestionSet.suggestions.map((suggestion) => [suggestion.id, suggestion]));
  const candidates = request.candidateIds.map((id) => byId.get(id));
  if (candidates.some((candidate) => candidate === undefined)) {
    return failure("candidate-not-found", "Every shortlist candidate must have been displayed.");
  }
  const selections = selectionSubjects(suggestionSet).map((subject) =>
    projectSelection(subject, node, request.operators),
  );
  if (selections.some((selection) => selection === undefined)) {
    return failure(
      "unsupported-binder-context",
      "This boundary cannot safely project a selection beneath a lexical binder.",
    );
  }
  return envelopeSuccess({
    id: request.id,
    schemaVersion: "llm-context/v1",
    role: "move-shortlister",
    context: {
      nodeId: node.id,
      stateId: node.state.id,
      suggestionSetId: suggestionSet.id,
      trigger: request.trigger,
      selections: selections as ShortlisterSelection[],
      candidates: candidates.map((candidate) => candidateCard(candidate!)),
      maxChoices: Math.min(request.maxChoices, candidates.length),
    },
  });
}

const executorResultInputSchema = z
  .object({
    id: stableIdentifierSchema,
    parameters: z.array(z.object({ symbol: z.string().min(1), sort: sortSchema }).strict()),
    premises: z.array(z.looseObject({ expression: plainMathJsonSchema })),
    conclusion: z.looseObject({ expression: plainMathJsonSchema }),
    directions: z
      .array(z.enum(["forward", "backward"]))
      .min(1)
      .max(2),
  })
  .strict();

const moveExecutorRequestSchema = z
  .object({
    id: llmCallIdSchema,
    node: z.unknown(),
    instruction: z.string(),
    source: executorSourceSchema,
    target: executorTargetSchema,
    /** Resolved selections (the worker resolves the client's descriptors against the node). */
    selections: z.array(z.unknown()).max(16).default([]),
    operators: z.array(operatorDeclarationSchema).default([]),
    /** The approved kernel results; the builder keeps the ones relevant to the selections. */
    results: z.array(z.unknown()).default([]),
    resultNames: z.record(z.string(), z.string()).default({}),
  })
  .strict();

/**
 * Build the move executor's minimal context (design plan §15.3): the described step, the
 * selections, the target sequent (its hypotheses with their IDs, the declarations they use), the
 * active operators and the approved results relevant to the selections. Never the original
 * problem, other goals, history, or other suggestions.
 */
export function buildMoveExecutorContext(input: unknown): RoleLlmContextResult<"move-executor"> {
  const request = safeParsePlain(moveExecutorRequestSchema, input);
  if (request === undefined)
    return failure("invalid-request", "The move-executor request is invalid.");
  const instruction = request.instruction.trim();
  if (instruction.length === 0 || instruction.length > MAX_EXECUTOR_INSTRUCTION_LENGTH) {
    return failure(
      "invalid-request",
      `The move description must be between 1 and ${MAX_EXECUTOR_INSTRUCTION_LENGTH} characters.`,
    );
  }
  const node = safeParsePlain(
    createProofNodeSchema({ operators: request.operators }),
    request.node,
  );
  if (node === undefined) return failure("invalid-request", "The proof node is invalid.");
  const entry = (request.target.kind === "goal" ? node.state.goals : node.state.obligations).find(
    ({ id }) => id === request.target.id,
  );
  if (entry === undefined) {
    return failure("invalid-request", "The target is not in the current proof state.");
  }
  const operators = request.operators;
  const selections: ExecutorSelection[] = [];
  for (const [position, value] of request.selections.entries()) {
    const projected = projectExecutorSelection(`selection:${position + 1}`, value, request.target);
    if (projected === undefined) {
      return failure("invalid-request", "A selection is invalid or does not belong to the target.");
    }
    selections.push(projected);
  }
  const { context } = entry.sequent;
  if (
    context.hypotheses.length > MAX_EXECUTOR_HYPOTHESES ||
    context.declarations.length > MAX_EXECUTOR_DECLARATIONS ||
    operators.length > MAX_EXECUTOR_OPERATORS
  ) {
    return failure("invalid-request", "The target sequent is too large to describe a step on.");
  }
  const statements: PlainMathJson[] = [
    entry.sequent.conclusion.expression,
    ...context.hypotheses.map(({ statement }) => statement.expression),
    ...selections.map(({ expression }) => expression),
  ];
  const used = new Set(
    statements.flatMap((expression) => freeSymbolNames(expression, { operators })),
  );
  const results = relevantExecutorResults(
    request.results,
    request.resultNames,
    selections.length === 0
      ? [entry.sequent.conclusion.expression]
      : selections.map(({ expression }) => expression),
  );
  if (results === undefined) {
    return failure("invalid-request", "An approved result could not be described.");
  }
  return envelopeSuccess({
    id: request.id,
    schemaVersion: "llm-context/v1",
    role: "move-executor",
    context: {
      nodeId: node.id,
      stateId: node.state.id,
      instruction,
      source: request.source,
      target: request.target,
      selections,
      sequent: {
        declarations: context.declarations.filter(({ symbol }) => used.has(symbol)),
        hypotheses: context.hypotheses.map(({ id, statement }) => ({
          id,
          expression: statement.expression,
        })),
        conclusion: entry.sequent.conclusion.expression,
      },
      operators,
      results,
      maxSteps: MAX_PLAN_STEPS,
    },
  }) as RoleLlmContextResult<"move-executor">;
}

const moveAuthorRequestSchema = z
  .object({
    id: llmCallIdSchema,
    /** The stored move-executor call the step came from. */
    executorCallId: stableIdentifierSchema,
    /** That call's stored context, and the stored plan it produced. */
    executorContext: z.unknown(),
    executorPlan: z.unknown(),
    /** On a revision: the previous proposal as stored, the feedback, and the platform's findings. */
    revision: z
      .object({
        previousCallId: stableIdentifierSchema,
        feedback: z.string(),
        previousProposal: z.unknown(),
        previousFindings: z.array(z.unknown()).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Build the move author's minimal context (design plan sections 13.3 and 15.3) from a stored
 * move-executor call whose plan was applied: the user's instruction, the applied step abstracted
 * deterministically (see `abstractSituation`), the kernel primitives generated from the move
 * catalog, the active operators and the supplied results. Never the original problem, other goals,
 * history or branches. Only a step the user described in their own words can be authored from.
 */
export function buildMoveAuthorContext(input: unknown): RoleLlmContextResult<"move-author"> {
  const request = safeParsePlain(moveAuthorRequestSchema, input);
  if (request === undefined) {
    return failure("invalid-request", "The move-author request is invalid.");
  }
  const executed = safeParsePlain(moveExecutorContextSchema, request.executorContext);
  const plan = safeParsePlain(executorPlanProposalSchema, request.executorPlan);
  if (executed === undefined || plan === undefined) {
    return failure("invalid-request", "The stored move-executor call is invalid.");
  }
  if (executed.source !== "user-instruction") {
    return failure(
      "invalid-request",
      "Only a step the user described in their own words can be turned into a move.",
    );
  }
  let revision: MoveAuthorContext["revision"];
  if (request.revision !== undefined) {
    const feedback = request.revision.feedback.trim();
    const previousProposal = safeParsePlain(
      moveAuthorProposalSchema,
      request.revision.previousProposal,
    );
    const previousFindings = z
      .array(moveAuthorFindingSchema)
      .max(20)
      .safeParse(request.revision.previousFindings);
    if (
      feedback.length === 0 ||
      feedback.length > 4_000 ||
      previousProposal === undefined ||
      !previousFindings.success
    ) {
      return failure("invalid-request", "The revision is invalid.");
    }
    revision = {
      previousCallId: request.revision.previousCallId,
      feedback,
      previousProposal,
      previousFindings: previousFindings.data,
    };
  }
  const situation = abstractSituation({
    target: executed.target,
    selections: executed.selections.map(({ location, expression }) => ({ location, expression })),
    sequent: executed.sequent,
    operators: executed.operators,
    results: executed.results,
    steps: plan.steps,
  });
  if (!situation.ok) return failure("invalid-request", situation.reason);
  return envelopeSuccess({
    id: request.id,
    schemaVersion: "llm-context/v1",
    role: "move-author",
    context: {
      executorCallId: request.executorCallId,
      instruction: executed.instruction,
      situation: situation.situation,
      primitives: describePrimitives(),
      operators: executed.operators,
      results: executed.results,
      limits: { maxSteps: MAX_PLAN_STEPS, maxExamples: MOVE_AUTHOR_MAX_EXAMPLES },
      ...(revision === undefined ? {} : { revision }),
    },
  }) as RoleLlmContextResult<"move-author">;
}

/** A resolved selection in the executor's shape; undefined if it is invalid or elsewhere. */
function projectExecutorSelection(
  id: string,
  value: unknown,
  target: Readonly<{ kind: string; id: string }>,
): ExecutorSelection | undefined {
  const parsed = safeParsePlain(resolvedSelectionShapeSchema, value);
  if (parsed === undefined) return undefined;
  const { anchor } = parsed;
  if (anchor.target.kind !== target.kind || anchor.target.id !== target.id) return undefined;
  return safeParsePlain(executorSelectionSchema, {
    id,
    location: {
      target: anchor.target,
      statement: anchor.statement,
      occurrence:
        parsed.kind === "exact"
          ? { kind: "exact", path: parsed.path }
          : {
              kind: "associative",
              containerPath: parsed.containerPath,
              startOperand: parsed.startOperand,
              endOperand: parsed.endOperand,
            },
    },
    position: parsed.position,
    expression: parsed.fragment,
  });
}

/** The parts of a resolved selection that the executor's projection reads. */
const resolvedSelectionShapeSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("exact"),
    anchor: z.looseObject({
      target: executorTargetSchema,
      statement: selectionLocationSchema.shape.statement,
    }),
    path: z.array(z.number().int().nonnegative()),
    fragment: plainMathJsonSchema,
    position: selectionPositionSchema,
  }),
  z.looseObject({
    kind: z.literal("associative"),
    anchor: z.looseObject({
      target: executorTargetSchema,
      statement: selectionLocationSchema.shape.statement,
    }),
    containerPath: z.array(z.number().int().nonnegative()),
    startOperand: z.number().int().nonnegative(),
    endOperand: z.number().int().nonnegative(),
    fragment: plainMathJsonSchema,
    position: selectionPositionSchema,
  }),
]);

/**
 * The approved results whose statements share operators with the focus expressions, best first
 * (most shared operators, then ID), capped. Undefined if a result is malformed.
 */
function relevantExecutorResults(
  inputs: readonly unknown[],
  names: Readonly<Record<string, string>>,
  focus: readonly PlainMathJson[],
): ExecutorResultCard[] | undefined {
  const wanted = new Set(focus.flatMap((expression) => [...operatorHeads(expression)]));
  const scored: { card: ExecutorResultCard; score: number }[] = [];
  for (const input of inputs) {
    const result = safeParsePlain(executorResultInputSchema, input);
    if (result === undefined) return undefined;
    const heads = new Set(
      [
        result.conclusion.expression,
        ...result.premises.map(({ expression }) => expression),
      ].flatMap((expression) => [...operatorHeads(expression)]),
    );
    const score = [...heads].filter((head) => wanted.has(head)).length;
    if (score === 0) continue;
    const name = names[result.id];
    scored.push({
      score,
      card: {
        id: result.id,
        ...(name === undefined || name.length === 0 || name.length > 500 ? {} : { name }),
        parameters: result.parameters,
        premises: result.premises.map(({ expression }) => expression),
        conclusion: result.conclusion.expression,
        directions: result.directions,
      },
    });
  }
  scored.sort((left, right) =>
    left.score !== right.score
      ? right.score - left.score
      : left.card.id < right.card.id
        ? -1
        : left.card.id > right.card.id
          ? 1
          : 0,
  );
  return scored.slice(0, MAX_EXECUTOR_RESULTS).map(({ card }) => card);
}

/** The operator heads of every application in an expression. */
function operatorHeads(expression: PlainMathJson, heads = new Set<string>()): Set<string> {
  const parts = functionParts(expression);
  if (parts === undefined) return heads;
  heads.add(parts.operator);
  parts.operands.forEach((operand) => operatorHeads(operand, heads));
  return heads;
}

const notationProposalSchema = z
  .object({ symbol: shortTextSchema, meaning: shortTextSchema })
  .strict();
const customOperatorSketchSchema = z
  .object({ symbol: shortTextSchema, name: shortTextSchema, arity: z.number().int().nonnegative() })
  .strict();
export const topicManifestProposalSchema = z
  .object({
    kind: z.literal("topic-manifest"),
    domains: uniqueShortTextsSchema,
    objectKinds: uniqueShortTextsSchema,
    vocabulary: uniqueShortTextsSchema,
    notation: z.array(notationProposalSchema).max(64),
    backgroundTopics: uniqueShortTextsSchema,
    customOperators: z.array(customOperatorSketchSchema).max(32),
  })
  .strict();
export type TopicManifestProposal = z.infer<typeof topicManifestProposalSchema>;

const topicInsufficientContextSchema = z
  .object({
    kind: z.literal("insufficient-context"),
    requestedCategories: z
      .array(z.enum(["background-detail", "notation-preference"]))
      .min(1)
      .max(2),
    rationale: shortTextSchema,
  })
  .strict();
const shortlisterInsufficientContextSchema = z
  .object({
    kind: z.literal("insufficient-context"),
    requestedCategories: z
      .array(
        z.enum(["parent-statement", "local-hypothesis", "declaration-sort", "candidate-detail"]),
      )
      .min(1)
      .max(4),
    rationale: shortTextSchema,
  })
  .strict();
const declinedSchema = z.object({ kind: z.literal("declined"), reason: shortTextSchema }).strict();
const moveShortlistProposalSchema = z
  .object({
    kind: z.literal("move-shortlist"),
    choices: z
      .array(
        z.object({ suggestionId: stableIdentifierSchema, rationale: shortTextSchema }).strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

/**
 * The shortlister judged that no displayed candidate is relevant to the selections. It is a
 * validated outcome, distinct from a refusal and from a low-confidence answer (which is kept as a
 * `declined` output and falls back to the deterministic list).
 */
const moveShortlistNoneRelevantSchema = z
  .object({
    kind: z.literal("none-relevant"),
    confidence: z.number().finite().min(0).max(1),
    reason: shortTextSchema,
  })
  .strict();

const topicOutputSchema = z.union([
  topicManifestProposalSchema,
  topicInsufficientContextSchema,
  declinedSchema,
]);
const shortlisterOutputSchema = z.union([
  moveShortlistProposalSchema,
  moveShortlistNoneRelevantSchema,
  shortlisterInsufficientContextSchema,
  declinedSchema,
]);
const executorOutputSchema = z.union([
  executorPlanProposalSchema,
  executorInsufficientContextSchema,
  declinedSchema,
]);
export type { ExecutorPlanProposal };
const executorWireResultSchema = z.union([
  executorWirePlanSchema,
  executorInsufficientContextSchema,
  declinedSchema,
]);
const formalizerInsufficientContextSchema = z
  .object({
    kind: z.literal("insufficient-context"),
    requestedCategories: z
      .array(
        z.enum([
          "background-detail",
          "notation-preference",
          "library-result",
          "operator-definition",
        ]),
      )
      .min(1)
      .max(4),
    rationale: shortTextSchema,
  })
  .strict();
const proofStateFormalizationProposalSchema = z
  .object({
    kind: z.literal("formalization"),
    draft: problemDraftSchema,
  })
  .strict();
const formalizerOutputSchema = z.union([
  proofStateFormalizationProposalSchema,
  formalizerInsufficientContextSchema,
  declinedSchema,
]);

// Strict provider schemas require optional public N26 fields to be present as nullable fields.
// The worker remains the sole conversion point from submitted LaTeX/MathJSON draft inputs to its
// authoritative MathJSON proof state.
const problemSchema = problemDraftSchema.shape.problem;
const backgroundSchema = problemDraftSchema.shape.background;
const preferencesSchema = problemDraftSchema.shape.preferences.unwrap();
const wireBackgroundProfileSchema = z
  .object({
    level: backgroundSchema.shape.level,
    summary: backgroundSchema.shape.summary,
    assumptions: backgroundSchema.shape.assumptions,
    domains: backgroundSchema.shape.domains.unwrap().nullable(),
    maximumLevel: backgroundSchema.shape.maximumLevel.unwrap().nullable(),
  })
  .strict();
const wirePreferencesSchema = z
  .object({
    domains: preferencesSchema.shape.domains.unwrap().nullable(),
    notation: preferencesSchema.shape.notation.unwrap().nullable(),
  })
  .strict();
const wireLatexStatementSchema = problemStatementInputSchema.options[0];
const wireProblemDraftSchema = z
  .object({
    problem: problemSchema,
    background: wireBackgroundProfileSchema,
    preferences: wirePreferencesSchema,
    libraryLayerIds: problemDraftSchema.shape.libraryLayerIds,
    packs: problemDraftSchema.shape.packs,
    declarations: problemDraftSchema.shape.declarations,
    hypotheses: z.array(wireLatexStatementSchema).max(64),
    goals: z.array(wireLatexStatementSchema).min(1).max(16),
  })
  .strict();
const wireFormalizerProposalSchema = z
  .object({
    kind: z.literal("formalization"),
    draft: wireProblemDraftSchema,
  })
  .strict();
const formalizerWireResultSchema = z.union([
  wireFormalizerProposalSchema,
  formalizerInsufficientContextSchema,
  declinedSchema,
]);

export type ValidatedLlmOutput =
  | z.infer<typeof topicOutputSchema>
  | z.infer<typeof shortlisterOutputSchema>
  | z.infer<typeof formalizerOutputSchema>
  | z.infer<typeof backgroundProposerOutputSchema>
  | z.infer<typeof executorOutputSchema>
  | z.infer<typeof librarianOutputSchema>
  | z.infer<typeof moveAuthorOutputSchema>;

const topicWireSchema = z.object({ result: topicOutputSchema }).strict();
const backgroundWireSchema = z.object({ result: backgroundProposerWireResultSchema }).strict();
const librarianWireSchema = z.object({ result: librarianWireResultSchema }).strict();
const shortlisterWireSchema = z.object({ result: shortlisterOutputSchema }).strict();
const formalizerWireSchema = z.object({ result: formalizerWireResultSchema }).strict();
const executorWireSchema = z.object({ result: executorWireResultSchema }).strict();
const moveAuthorWireSchema = z.object({ result: moveAuthorWireResultSchema }).strict();

const jevChoiceResultSchema = z
  .object({
    kind: z.literal("jev-choice"),
    providerRequest: z
      .object({
        model: z.string().min(1).max(200),
        state: moveShortlisterEnvelopeSchema,
        questions: z
          .object({
            shortlist: z
              .object({
                type: z.literal("choice"),
                instructions: boundedTextSchema,
                criteria: z.record(stableIdentifierSchema, shortTextSchema),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    providerOutput: z
      .object({
        type: z.literal("choice"),
        choice: stableIdentifierSchema,
        probabilities: z.record(stableIdentifierSchema, z.number().finite().min(0).max(1)),
        confidence: z.number().finite().min(0).max(1),
      })
      .strict(),
    minimumConfidence: z.number().finite().min(0).max(1),
  })
  .strict();

/** Strict provider JSON schemas, one request root for each supported role. */
export function llmOutputSchemaForRole(role: SupportedLlmRole): z.ZodType {
  if (role === "topic-extractor") return topicWireSchema;
  if (role === "proof-state-formalizer") return formalizerWireSchema;
  if (role === "background-proposer") return backgroundWireSchema;
  if (role === "move-executor") return executorWireSchema;
  if (role === "librarian") return librarianWireSchema;
  if (role === "move-author") return moveAuthorWireSchema;
  return shortlisterWireSchema;
}

const messageSchema = z
  .object({ role: z.enum(["system", "user"]), content: z.string().min(1) })
  .strict();
export const preparedLlmCallSchema = z
  .object({
    id: llmCallIdSchema,
    role: supportedLlmRoleSchema,
    schemaVersion: z.literal("llm-call/v1"),
    envelope: llmContextEnvelopeSchema,
    messages: z.tuple([messageSchema, messageSchema]),
  })
  .strict()
  .superRefine((call, context) => {
    if (call.id !== call.envelope.id || call.role !== call.envelope.role) {
      context.addIssue({ code: "custom", message: "Call identity must match its envelope." });
    }
    if (call.messages[0].role !== "system" || call.messages[1].role !== "user") {
      context.addIssue({ code: "custom", message: "Calls require system and user messages." });
    }
    if (!acceptsSystemMessage(call.role, call.messages[0].content)) {
      context.addIssue({ code: "custom", message: "The system message must match the role." });
    }
    if (!encodesEnvelope(call.messages[1].content, call.envelope)) {
      context.addIssue({
        code: "custom",
        message: "The user message must contain the exact envelope.",
      });
    }
  });
export type PreparedLlmCall = z.infer<typeof preparedLlmCallSchema>;

/**
 * Whether a recorded user message is the JSON text of the envelope. The comparison is structural,
 * not textual: a stored envelope can come back with its MathJSON object keys in another order
 * (PostgreSQL JSONB does this), while the recorded message keeps the text that was sent.
 */
function encodesEnvelope(content: string, envelope: unknown): boolean {
  let sent: unknown;
  try {
    sent = JSON.parse(content);
  } catch {
    return false;
  }
  return canonicalJsonEquals(sent, envelope);
}

export function prepareLlmCall(
  envelopeInput: unknown,
): Readonly<{ ok: true; call: PreparedLlmCall; diagnostics: readonly [] }> | LlmBoundaryFailure {
  const envelope = safeParsePlain(llmContextEnvelopeSchema, envelopeInput);
  if (envelope === undefined) return failure("invalid-request", "The LLM envelope is invalid.");
  const candidate = safeParsePlain(preparedLlmCallSchema, {
    id: envelope.id,
    role: envelope.role,
    schemaVersion: "llm-call/v1",
    envelope,
    messages: [
      { role: "system", content: expectedSystemMessage(envelope.role) },
      { role: "user", content: JSON.stringify(envelope) },
    ],
  });
  return candidate === undefined
    ? failure("invalid-request", "The LLM call could not be prepared.")
    : { ok: true, call: freezeDetached(candidate), diagnostics: [] };
}

const FORMALIZER_BASE_SYSTEM_MESSAGE =
  "Return one structured N26 problem draft, a permitted context request, or a refusal. Mirror the existing proof-state model in the draft: use the supplied problem, background, preferences, library layers, and selected packs exactly; use declarations with admitted sorts; express hypotheses and goals as LaTeX inputs. Do not add a separate presentation AST, a library result, proof steps, or unsupported variable kinds. The worker validates and parses the draft into authoritative plain MathJSON, then presents it for human review. The draft is a proposal, never an approved proof state.";
/** The formalizer message before it listed the built-in symbols (`proof-state-formalizer-v2`). */
const FORMALIZER_PREVIOUS_SYSTEM_MESSAGE = `${FORMALIZER_BASE_SYSTEM_MESSAGE} Formalize using only the operators listed in approvedLibrary.operators (the selected packs' operators and the user's approved background constants), the built-in symbols, and your own declarations; never invent, rename, or redefine an operator. If the problem needs an operator that is not listed, return an insufficient-context request for an operator definition instead of using it. The worker rejects any other operator as an unapproved constant.`;
/**
 * The built-in symbols a formalized statement may use without approval, each with LaTeX that the
 * problem-setup parser reads as that symbol. The worker's tests parse every entry.
 */
export const FORMALIZER_BUILTIN_LATEX: readonly (readonly [symbol: string, latex: string])[] = [
  ["Not", "\\neg p"],
  ["And", "p \\land q"],
  ["Or", "p \\lor q"],
  ["Implies", "p \\implies q"],
  ["Equivalent", "p \\iff q"],
  ["ForAll", "\\forall x, x = x"],
  ["Exists", "\\exists x, x = a"],
  ["Equal", "a = b"],
  ["NotEqual", "a \\ne b"],
  ["Less", "a < b"],
  ["LessEqual", "a \\le b"],
  ["Greater", "a > b"],
  ["GreaterEqual", "a \\ge b"],
  ["Element", "x \\in A"],
  ["NotElement", "x \\notin A"],
  ["Subset", "A \\subset B"],
  ["SubsetEqual", "A \\subseteq B"],
  ["Add", "a + b"],
  ["Subtract", "a - b"],
  ["Negate", "-a"],
  ["Multiply", "a \\cdot b"],
  ["Divide", "\\frac{a}{b}"],
  ["Power", "a^2"],
  ["Abs", "|a|"],
];
const FORMALIZER_SYSTEM_MESSAGE = `${FORMALIZER_BASE_SYSTEM_MESSAGE} Formalize using only the operators listed in approvedLibrary.operators (the selected packs' operators and the user's approved background constants), the built-in symbols, and your own declarations; never invent, rename, or redefine an operator. The built-in symbols are always available, need no approval and are never listed in approvedLibrary.operators, even when that list is empty; write them with exactly this LaTeX: ${FORMALIZER_BUILTIN_LATEX.map(([symbol, latex]) => `${symbol} ${latex}`).join("; ")}. Write implication as \\implies, never \\to or \\rightarrow, which denote a function arrow. Never ask for a definition of a built-in symbol. If the problem needs an operator that is neither listed nor built in, return an insufficient-context request for an operator definition instead of using it. The worker rejects any other operator as an unapproved constant.`;

function expectedSystemMessage(role: SupportedLlmRole): string {
  if (role === "topic-extractor") {
    return "Return only a topic manifest, a permitted context request, or a refusal. Do not solve the problem.";
  }
  if (role === "proof-state-formalizer") return FORMALIZER_SYSTEM_MESSAGE;
  if (role === "background-proposer") return BACKGROUND_PROPOSER_SYSTEM_MESSAGE;
  if (role === "librarian") return LIBRARIAN_SYSTEM_MESSAGE;
  if (role === "move-executor") return MOVE_EXECUTOR_SYSTEM_MESSAGE;
  if (role === "move-author") return MOVE_AUTHOR_SYSTEM_MESSAGE;
  return SHORTLISTER_SYSTEM_MESSAGE;
}

/** The move executor message before it said how targets are closed and kept (`move-executor-v1`). */
const MOVE_EXECUTOR_PREVIOUS_SYSTEM_MESSAGE = `Return one plan of kernel operations that carries out the described step on the supplied target sequent, a permitted context request, or a refusal. Use only the supplied target, hypotheses, declarations, operators and approved results, and refer to existing goals, obligations and hypotheses by their exact supplied IDs. A plan has between 1 and ${MAX_PLAN_STEPS} operations; the kernel applies each to the state the previous one produced, and rejects any step that is not valid. Give every new statement, hypothesis, obligation, declaration or assumption you introduce a short unique label of letters, digits, dots, underscores and hyphens: the platform makes labels globally unique, and later operations refer to the same label. Write every expression as MathJSON: a symbol or number as a plain string or number, an application as [Operator, ...operands]. Operations that mark a sorry or accept an attested inference do not exist for you. The platform previews the plan and a person confirms it; nothing is applied before that. If the description cannot be carried out with the supplied context, return an insufficient-context request or a refusal instead of guessing.`;
const MOVE_EXECUTOR_SYSTEM_MESSAGE = `Return one plan of kernel operations that carries out the described step on the supplied target sequent, a permitted context request, or a refusal. Use only the supplied target, hypotheses, declarations, operators and approved results, and refer to existing goals, obligations and hypotheses by their exact supplied IDs. A plan has between 1 and ${MAX_PLAN_STEPS} operations; the kernel applies each to the state the previous one produced, and rejects any step that is not valid. Give every new statement, hypothesis, obligation, declaration or assumption you introduce a short unique label of letters, digits, dots, underscores and hyphens: the platform makes labels globally unique, and later operations refer to the same label. To close a target with one of its hypotheses use close-by-hypothesis; close-by-assumption closes a target only with an entry of the state's additional assumptions, never with a hypothesis. The targets an operation creates in place of its target, such as the premise targets of apply-result-backward or the children of a case split, stay in the same collection as that target: on a goal they are goals, on an obligation they are obligations; only a field named obligationId or obligationIds creates obligations. Write every expression as MathJSON: a symbol or number as a plain string or number, an application as [Operator, ...operands]. Operations that mark a sorry or accept an attested inference do not exist for you. The platform previews the plan and a person confirms it; nothing is applied before that. If the description cannot be carried out with the supplied context, return an insufficient-context request or a refusal instead of guessing.`;
const SHORTLISTER_SYSTEM_MESSAGE =
  "Shortlist only supplied candidate IDs. Do not propose operations or new mathematics. If every supplied candidate is clearly unrelated to the selected fragment, return a none-relevant outcome with your confidence and a short reason instead of forcing a choice; use it only when no candidate is a plausible next step for the selection, not when the best candidate is merely a weak fit.";
/** The shortlister message before the none-relevant outcome existed. */
const SHORTLISTER_PREVIOUS_SYSTEM_MESSAGE =
  "Shortlist only supplied candidate IDs. Do not propose operations or new mathematics.";

/**
 * System messages a stored call may carry. Formalizer calls recorded before the approved-constants
 * instruction was added, shortlister calls recorded before the none-relevant outcome,
 * background-proposer calls recorded before existing operators were offered, and librarian calls
 * recorded before the top-up request kinds keep their original message, so existing evidence
 * stays readable; new calls are always prepared with the current message.
 */
function acceptsSystemMessage(role: SupportedLlmRole, content: string): boolean {
  return (
    content === expectedSystemMessage(role) ||
    (role === "proof-state-formalizer" &&
      (content === FORMALIZER_BASE_SYSTEM_MESSAGE ||
        content === FORMALIZER_PREVIOUS_SYSTEM_MESSAGE)) ||
    (role === "move-shortlister" && content === SHORTLISTER_PREVIOUS_SYSTEM_MESSAGE) ||
    (role === "background-proposer" && content === BACKGROUND_PROPOSER_PREVIOUS_SYSTEM_MESSAGE) ||
    (role === "librarian" && content === LIBRARIAN_PREVIOUS_SYSTEM_MESSAGE) ||
    (role === "move-author" && content === MOVE_AUTHOR_PREVIOUS_SYSTEM_MESSAGE) ||
    (role === "move-executor" && content === MOVE_EXECUTOR_PREVIOUS_SYSTEM_MESSAGE)
  );
}

export function validateLlmOutput(
  callInput: unknown,
  outputInput: unknown,
):
  | Readonly<{ ok: true; output: ValidatedLlmOutput; diagnostics: readonly [] }>
  | LlmBoundaryFailure {
  const call = safeParsePlain(preparedLlmCallSchema, callInput);
  if (call === undefined) return failure("invalid-request", "The prepared call is invalid.");
  const wrapper = safeParsePlain(z.object({ result: z.unknown() }).strict(), outputInput);
  const candidate = wrapper === undefined ? outputInput : wrapper.result;
  if (call.role === "topic-extractor") {
    const output = safeParsePlain(topicOutputSchema, candidate);
    return output === undefined
      ? failure("invalid-output", "The LLM output is malformed.")
      : { ok: true, output: freezeDetached(output), diagnostics: [] };
  }

  if (call.role === "background-proposer") {
    const wireOutput = safeParsePlain(backgroundProposerWireResultSchema, candidate);
    const output =
      wireOutput === undefined ? undefined : normalizeBackgroundProposerWireResult(wireOutput);
    return output === undefined
      ? failure("invalid-output", "The LLM output is malformed or breaks a background rule.")
      : { ok: true, output: freezeDetached(output), diagnostics: [] };
  }

  if (call.role === "librarian") {
    const wireOutput = safeParsePlain(librarianWireResultSchema, candidate);
    const output =
      wireOutput === undefined || call.envelope.role !== "librarian"
        ? undefined
        : normalizeLibrarianWireResult(wireOutput, call.envelope.context);
    return output === undefined
      ? failure("invalid-output", "The LLM output is malformed or breaks a library rule.")
      : { ok: true, output: freezeDetached(output), diagnostics: [] };
  }

  if (call.role === "proof-state-formalizer") {
    const wireOutput = safeParsePlain(formalizerWireResultSchema, candidate);
    const normalizedWire =
      wireOutput === undefined || call.envelope.role !== "proof-state-formalizer"
        ? undefined
        : normalizeFormalizerWireOutput(wireOutput, call.envelope.context);
    const output = normalizedWire ?? safeParsePlain(formalizerOutputSchema, candidate);
    if (
      output === undefined ||
      call.envelope.role !== "proof-state-formalizer" ||
      (output.kind === "formalization" &&
        !formalizerDraftMatchesContext(output, call.envelope.context))
    ) {
      return failure(
        "invalid-output",
        "The LLM output is malformed or changes approved setup context.",
      );
    }
    return { ok: true, output: freezeDetached(output), diagnostics: [] };
  }

  if (call.role === "move-executor") {
    const wireOutput = safeParsePlain(executorWireResultSchema, candidate);
    const output =
      (wireOutput === undefined ? undefined : normalizeExecutorWireOutput(wireOutput)) ??
      safeParsePlain(executorOutputSchema, candidate);
    if (output === undefined) {
      return failure(
        "invalid-output",
        planUsesForbiddenOperation(candidate) ||
          planUsesForbiddenOperation((candidate as { result?: unknown } | null)?.result)
          ? "The plan uses an operation the move executor may not propose."
          : "The LLM output is malformed.",
      );
    }
    if (
      call.envelope.role !== "move-executor" ||
      (output.kind === "plan" && !executorPlanFitsContext(output, call.envelope.context))
    ) {
      return failure(
        "invalid-output",
        "The plan cites a result that was not supplied or exceeds its bounds.",
      );
    }
    return { ok: true, output: freezeDetached(output), diagnostics: [] };
  }

  if (call.role === "move-author") {
    if (call.envelope.role !== "move-author") {
      return failure("invalid-output", "The LLM output does not belong to this call.");
    }
    const { context } = call.envelope;
    const wireOutput = safeParsePlain(moveAuthorWireResultSchema, candidate);
    if (wireOutput !== undefined) {
      const normalized = normalizeMoveAuthorWireResult(wireOutput, context);
      return normalized.ok
        ? { ok: true, output: freezeDetached(normalized.output), diagnostics: [] }
        : failure("invalid-output", normalized.message);
    }
    // An already normalized output is checked against the same context.
    const output = safeParsePlain(moveAuthorOutputSchema, candidate);
    if (output === undefined) return failure("invalid-output", "The LLM output is malformed.");
    const problem = output.kind === "move-proposal" ? proposalProblem(output, context) : undefined;
    return problem === undefined
      ? { ok: true, output: freezeDetached(output), diagnostics: [] }
      : failure("invalid-output", problem);
  }

  const jevResult = safeParsePlain(jevChoiceResultSchema, candidate);
  if (jevResult !== undefined) {
    if (call.envelope.role !== "move-shortlister") {
      return failure("invalid-output", "Jev output is only valid for a move-shortlister call.");
    }
    const candidates = call.envelope.context.candidates;
    // The Choice question offers every displayed candidate plus the reserved none-relevant option.
    const expectedIds = [...candidates.map(({ id }) => id), NONE_RELEVANT_CHOICE_ID].sort();
    const probabilityIds = Object.keys(jevResult.providerOutput.probabilities).sort();
    const criteria = jevResult.providerRequest.questions.shortlist.criteria;
    const expectedCriteria = {
      ...Object.fromEntries(candidates.map(({ id, name }) => [id, name])),
      [NONE_RELEVANT_CHOICE_ID]: NONE_RELEVANT_CRITERION,
    };
    const probabilities = jevResult.providerOutput.probabilities;
    const probabilityTotal = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
    const highestProbability = Math.max(...Object.values(probabilities));
    const validJevResult =
      jsonValueEquals(jevResult.providerRequest.state, call.envelope) &&
      jsonValueEquals(criteria, expectedCriteria) &&
      jsonValueEquals(probabilityIds, expectedIds) &&
      Math.abs(probabilityTotal - 1) <= 0.02 &&
      probabilities[jevResult.providerOutput.choice] === highestProbability;
    if (!validJevResult) {
      return failure(
        "invalid-output",
        "Jev probabilities or request context do not match the shortlist.",
      );
    }
    const { choice, confidence } = jevResult.providerOutput;
    const output =
      confidence < jevResult.minimumConfidence
        ? {
            kind: "declined" as const,
            reason: "Jev shortlist confidence is below the configured threshold.",
          }
        : choice === NONE_RELEVANT_CHOICE_ID
          ? {
              kind: "none-relevant" as const,
              confidence,
              reason:
                "Jev judged that none of the displayed suggestions is relevant to the selection.",
            }
          : {
              kind: "move-shortlist" as const,
              choices: [
                {
                  suggestionId: choice,
                  rationale:
                    "This candidate had the highest Jev probability and met the confidence threshold.",
                },
              ],
            };
    return { ok: true, output: freezeDetached(output), diagnostics: [] };
  }

  const output = safeParsePlain(shortlisterOutputSchema, candidate);
  if (output === undefined || call.envelope.role !== "move-shortlister") {
    return failure("invalid-output", "The LLM output is malformed.");
  }
  if (output.kind === "move-shortlist") {
    const ids = output.choices.map(({ suggestionId }) => suggestionId);
    const candidates = new Set(call.envelope.context.candidates.map(({ id }) => id));
    if (
      new Set(ids).size !== ids.length ||
      ids.length > call.envelope.context.maxChoices ||
      ids.some((id) => !candidates.has(id))
    ) {
      return failure(
        "invalid-output",
        "The shortlist must contain unique displayed candidates within its bound.",
      );
    }
  }
  return { ok: true, output: freezeDetached(output), diagnostics: [] };
}

/** A wire plan as a stored plan (kernel operations without state IDs); other outputs unchanged. */
function normalizeExecutorWireOutput(
  output: z.infer<typeof executorWireResultSchema>,
): z.infer<typeof executorOutputSchema> | undefined {
  if (output.kind !== "plan") return output;
  return safeParsePlain(executorPlanProposalSchema, {
    kind: "plan",
    steps: output.steps.map((step) => normalizeWireStep(step as Record<string, unknown>)),
    explanation: output.explanation,
  });
}

/** Only results the context supplied may be cited, and the plan stays within its step bound. */
function executorPlanFitsContext(
  plan: ExecutorPlanProposal,
  context: MoveExecutorContext,
): boolean {
  const supplied = new Set(context.results.map(({ id }) => id));
  return (
    plan.steps.length <= context.maxSteps &&
    plan.steps.every((step) => stepResultIds(step).every((id) => supplied.has(id)))
  );
}

function normalizeFormalizerWireOutput(
  output: z.infer<typeof formalizerWireResultSchema>,
  context: ProofStateFormalizerContext,
): z.infer<typeof formalizerOutputSchema> | undefined {
  if (output.kind !== "formalization") return output;
  const { domains, maximumLevel, ...background } = output.draft.background;
  const { preferences: wirePreferences, ...draftWithoutPreferences } = output.draft;
  const normalizedBackground = {
    ...background,
    ...(domains === null ? {} : { domains }),
    ...(maximumLevel === null ? {} : { maximumLevel }),
  };
  const { domains: preferenceDomains, notation } = wirePreferences;
  const preferences =
    preferenceDomains === null && notation === null
      ? context.preferences !== undefined && Object.keys(context.preferences).length === 0
        ? {}
        : undefined
      : {
          ...(preferenceDomains === null ? {} : { domains: preferenceDomains }),
          ...(notation === null ? {} : { notation }),
        };
  const normalized = {
    kind: output.kind,
    draft: {
      ...draftWithoutPreferences,
      background: normalizedBackground,
      ...(preferences === undefined ? {} : { preferences }),
    },
  };
  return safeParsePlain(formalizerOutputSchema, normalized);
}

function formalizerDraftMatchesContext(
  output: z.infer<typeof formalizerOutputSchema>,
  context: ProofStateFormalizerContext,
): boolean {
  if (output.kind !== "formalization") return true;
  return (
    jsonValueEquals(output.draft.problem, context.problem) &&
    jsonValueEquals(output.draft.background, context.background) &&
    jsonValueEquals(output.draft.preferences, context.preferences) &&
    jsonValueEquals(output.draft.libraryLayerIds, context.libraryLayerIds) &&
    jsonValueEquals(output.draft.packs, context.packs)
  );
}

export type LlmTransport = (call: PreparedLlmCall) => Promise<unknown>;
export type LlmCallEvidence = Readonly<{
  id: LlmCallId;
  role: SupportedLlmRole;
  preparedCall: PreparedLlmCall;
  status: "validated" | "rejected" | "transport-failed";
  rawResponse: unknown;
  output?: ValidatedLlmOutput | undefined;
  diagnostics: readonly LlmBoundaryDiagnostic[];
}>;
export const llmCallEvidenceSchema: z.ZodType<LlmCallEvidence> = z
  .object({
    id: llmCallIdSchema,
    role: supportedLlmRoleSchema,
    preparedCall: preparedLlmCallSchema,
    status: z.enum(["validated", "rejected", "transport-failed"]),
    rawResponse: z.unknown(),
    output: z
      .union([
        topicOutputSchema,
        formalizerOutputSchema,
        shortlisterOutputSchema,
        backgroundProposerOutputSchema,
        executorOutputSchema,
        librarianOutputSchema,
        moveAuthorOutputSchema,
      ])
      .optional(),
    diagnostics: z.array(llmBoundaryDiagnosticSchema),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (!Object.hasOwn(evidence, "rawResponse")) {
      context.addIssue({ code: "custom", message: "Evidence must retain the raw response." });
    }
    if (evidence.id !== evidence.preparedCall.id || evidence.role !== evidence.preparedCall.role) {
      context.addIssue({ code: "custom", message: "Evidence identity must match its call." });
    }
    if (
      (evidence.status === "validated") !== (evidence.output !== undefined) ||
      (evidence.status === "validated") !== (evidence.diagnostics.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only validated evidence has an output and no diagnostics.",
      });
    }
    if (
      evidence.status === "transport-failed" &&
      (evidence.diagnostics.length !== 1 || evidence.diagnostics[0]?.code !== "transport-failed")
    ) {
      context.addIssue({ code: "custom", message: "Transport failures require that diagnostic." });
    }
    if (
      evidence.status === "rejected" &&
      (evidence.diagnostics.length !== 1 || evidence.diagnostics[0]?.code !== "invalid-output")
    ) {
      context.addIssue({ code: "custom", message: "Rejected outputs require that diagnostic." });
    }
    if (
      evidence.output !== undefined &&
      ((evidence.role === "topic-extractor" &&
        !topicOutputSchema.safeParse(evidence.output).success) ||
        (evidence.role === "proof-state-formalizer" &&
          !formalizerOutputSchema.safeParse(evidence.output).success) ||
        (evidence.role === "move-shortlister" &&
          !shortlisterOutputSchema.safeParse(evidence.output).success) ||
        (evidence.role === "background-proposer" &&
          !backgroundProposerOutputSchema.safeParse(evidence.output).success) ||
        (evidence.role === "move-executor" &&
          !executorOutputSchema.safeParse(evidence.output).success) ||
        (evidence.role === "librarian" &&
          !librarianOutputSchema.safeParse(evidence.output).success) ||
        (evidence.role === "move-author" &&
          !moveAuthorOutputSchema.safeParse(evidence.output).success))
    ) {
      context.addIssue({ code: "custom", message: "Evidence output must match the call role." });
    }
  });

/** Execute a capability-free transport and retain the exact request and response as evidence. */
export async function executePreparedLlmCall(
  callInput: unknown,
  transport: LlmTransport,
): Promise<LlmCallEvidence> {
  const call = safeParsePlain(preparedLlmCallSchema, callInput);
  if (call === undefined) throw new TypeError("A validated prepared call is required.");
  const preparedCall = freezeDetached(call);
  let rawResponse: unknown;
  try {
    rawResponse = await transport(preparedCall);
  } catch (error: unknown) {
    const subcode = error instanceof LlmTransportError ? error.subcode : undefined;
    return freezeDetached({
      id: preparedCall.id,
      role: preparedCall.role,
      preparedCall,
      status: "transport-failed" as const,
      rawResponse: null,
      diagnostics: [
        {
          code: "transport-failed" as const,
          message: "The LLM transport failed.",
          ...(subcode === undefined ? {} : { subcode }),
        },
      ],
    });
  }
  const detachedRaw = clonePlainData(rawResponse);
  const validated = validateLlmOutput(preparedCall, rawResponse);
  if (!validated.ok) {
    return freezeDetached({
      id: preparedCall.id,
      role: preparedCall.role,
      preparedCall,
      status: "rejected" as const,
      rawResponse: detachedRaw,
      diagnostics: validated.diagnostics,
    });
  }
  return freezeDetached({
    id: preparedCall.id,
    role: preparedCall.role,
    preparedCall,
    status: "validated" as const,
    rawResponse: detachedRaw,
    output: validated.output,
    diagnostics: [],
  });
}

type ConcreteResolvedSelection = Exclude<
  DisplayedSuggestionSet["selection"],
  Readonly<{ kind: "selection-query" }>
>;
type SelectionSubject = Readonly<{
  id: string;
  selection: ConcreteResolvedSelection;
  abstraction?: z.infer<typeof retrievalWildcardSchema> | undefined;
}>;

function selectionSubjects(suggestionSet: DisplayedSuggestionSet): readonly SelectionSubject[] {
  return suggestionSet.selection.kind === "selection-query"
    ? suggestionSet.selection.selections
    : [{ id: "selection:primary", selection: suggestionSet.selection }];
}

function projectSelection(
  subject: SelectionSubject,
  node: ProofNode,
  operators: readonly OperatorDeclaration[],
): ShortlisterSelection | undefined {
  const selection = subject.selection;
  if (selectionCrossesBinder(selection, node, operators)) return undefined;
  const expression = subject.abstraction === undefined ? selection.fragment : undefined;
  const names = expression === undefined ? [] : freeSymbolNames(expression, { operators });
  const nameSet = new Set(names);
  const declarations =
    expression === undefined
      ? []
      : selection.declarations.filter(({ symbol }) => nameSet.has(symbol));
  const operatorSymbols =
    expression === undefined ? new Set<string>() : expressionSymbols(expression);
  const requiredOperators = operators.filter(({ symbol }) => operatorSymbols.has(symbol));
  return shortlisterSelectionSchema.parse({
    id: subject.id,
    location: {
      target: selection.anchor.target,
      statement: selection.anchor.statement,
      occurrence:
        selection.kind === "exact"
          ? { kind: "exact", path: selection.path }
          : {
              kind: "associative",
              containerPath: selection.containerPath,
              startOperand: selection.startOperand,
              endOperand: selection.endOperand,
            },
    },
    position: selection.position,
    ...(expression === undefined ? { abstraction: subject.abstraction } : { expression }),
    declarations,
    operators: requiredOperators,
  });
}

function candidateCard(suggestion: DisplayedSuggestionSet["suggestions"][number]): CandidateCard {
  return {
    id: suggestion.id,
    source: suggestion.source,
    artifactId: suggestion.artifactId,
    name: suggestion.name,
    applicability: suggestion.applicability,
    abstractionFit: suggestion.abstractionFit,
    reasons: [...suggestion.reasons],
    selectionMatches: suggestion.selectionMatches.map(({ selectionId, selectionSlotId }) => ({
      selectionId,
      ...(selectionSlotId === undefined ? {} : { selectionSlotId }),
    })),
    unresolvedSelectionSlots: [...suggestion.unresolvedSelectionSlots],
    unresolvedParameters: [...suggestion.unresolvedParameters],
  };
}

function selectionCrossesBinder(
  selection: ConcreteResolvedSelection,
  node: ProofNode,
  operators: readonly OperatorDeclaration[],
): boolean {
  const collection =
    selection.anchor.target.kind === "goal" ? node.state.goals : node.state.obligations;
  const target = collection.find(({ id }) => id === selection.anchor.target.id);
  const statement = selection.anchor.statement;
  let expression =
    statement.kind === "conclusion"
      ? target?.sequent.conclusion.expression
      : target?.sequent.context.hypotheses.find(({ id }) => id === statement.id)?.statement
          .expression;
  const path = selection.kind === "exact" ? selection.path : selection.containerPath;
  for (const operandIndex of path) {
    if (expression === undefined) return true;
    const parts = functionParts(expression);
    if (parts === undefined) return true;
    const binder =
      operators.find(({ symbol }) => symbol === parts.operator)?.binder ??
      (parts.operator === "ForAll" || parts.operator === "Exists"
        ? BUILTIN_BINDER_SPECIFICATIONS[parts.operator]
        : undefined);
    if (binder?.scopedOperands.includes(operandIndex) === true) return true;
    expression = parts.operands[operandIndex];
  }
  return false;
}

function expressionSymbols(
  expression: PlainMathJson,
  result: Set<string> = new Set(),
): Set<string> {
  if (typeof expression === "string") {
    result.add(expression);
    return result;
  }
  const parts = functionParts(expression);
  if (parts === undefined) return result;
  result.add(parts.operator);
  parts.operands.forEach((operand) => expressionSymbols(operand, result));
  return result;
}

function functionParts(
  expression: PlainMathJson,
): Readonly<{ operator: string; operands: readonly PlainMathJson[] }> | undefined {
  if (Array.isArray(expression)) {
    return typeof expression[0] === "string"
      ? { operator: expression[0], operands: expression.slice(1) as PlainMathJson[] }
      : undefined;
  }
  if (typeof expression !== "object" || expression === null || !("fn" in expression)) {
    return undefined;
  }
  return typeof expression.fn[0] === "string"
    ? { operator: expression.fn[0], operands: expression.fn.slice(1) }
    : undefined;
}

function envelopeSuccess(envelopeInput: unknown): BuildLlmContextResult {
  const envelope = safeParsePlain(llmContextEnvelopeSchema, envelopeInput);
  return envelope === undefined
    ? failure("invalid-request", "The projected context is invalid.")
    : { ok: true, envelope: freezeDetached(envelope), diagnostics: [] };
}

function failure(code: LlmBoundaryDiagnosticCode, message: string): LlmBoundaryFailure {
  return { ok: false, diagnostics: [{ code, message }] };
}

function addDuplicateIssues(values: readonly string[], context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Repeated values are not allowed." });
  }
}

function safeParsePlain<Output>(schema: z.ZodType<Output>, value: unknown): Output | undefined {
  try {
    if (!isPlainData(value)) return undefined;
    const parsed = schema.safeParse(structuredClone(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function clonePlainData(value: unknown): unknown {
  if (!isPlainData(value)) return null;
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

function isPlainData(value: unknown, ancestors: ReadonlySet<object> = new Set()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  const nextAncestors = new Set(ancestors).add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isPlainData(descriptor.value, nextAncestors)
      ) {
        return false;
      }
    }
    return keys.every(
      (key) =>
        key === "length" ||
        (typeof key === "string" && Number.isInteger(Number(key)) && Number(key) >= 0),
    );
  }
  return keys.every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = descriptors[key];
    return (
      descriptor !== undefined &&
      descriptor.enumerable &&
      "value" in descriptor &&
      isPlainData(descriptor.value, nextAncestors)
    );
  });
}

function freezeDetached<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value) as Value);
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
