import {
  BUILTIN_BINDER_SPECIFICATIONS,
  declarationSchema,
  freeSymbolNames,
  operatorDeclarationSchema,
  plainMathJsonSchema,
  retrievalWildcardSchema,
  stableIdentifierSchema,
  type OperatorDeclaration,
  type PlainMathJson,
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  suggestionSetMatchesNode,
  type DisplayedSuggestionSet,
  type ProofNode,
} from "@proof/protocol";
import { z } from "zod";

export const LLM_ROLES = [
  "topic-extractor",
  "librarian",
  "proof-state-formalizer",
  "move-shortlister",
  "move-executor",
  "attestor",
  "background-gatekeeper",
  "generality-reviewer",
  "stateful-proof-agent",
] as const;
export const llmRoleSchema = z.enum(LLM_ROLES);
export type LlmRole = z.infer<typeof llmRoleSchema>;

export const SUPPORTED_LLM_ROLES = ["topic-extractor", "move-shortlister"] as const;
export const supportedLlmRoleSchema = z.enum(SUPPORTED_LLM_ROLES);
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

export const backgroundProfileSchema = z
  .object({
    level: shortTextSchema,
    summary: boundedTextSchema,
    assumptions: uniqueShortTextsSchema,
  })
  .strict();
export type BackgroundProfile = z.infer<typeof backgroundProfileSchema>;

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
export type TopicExtractorContext = z.infer<typeof topicExtractorContextSchema>;

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

const shortlisterSelectionSchema = z
  .object({
    id: stableIdentifierSchema,
    location: selectionLocationSchema,
    position: z
      .object({
        polarity: z.enum(["positive", "negative", "mixed", "neutral"]),
        role: z.enum(["proposition", "term", "binder"]),
      })
      .strict(),
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
export type CandidateCard = z.infer<typeof candidateCardSchema>;

const moveShortlisterContextSchema = z
  .object({
    nodeId: stableIdentifierSchema,
    stateId: stableIdentifierSchema,
    suggestionSetId: stableIdentifierSchema,
    trigger: z.enum(["deterministic-empty", "explicit-user"]),
    selections: z.array(shortlisterSelectionSchema).min(1).max(16),
    candidates: z.array(candidateCardSchema).min(1).max(32),
    maxChoices: z.number().int().min(1).max(8),
  })
  .strict();
export type MoveShortlisterContext = z.infer<typeof moveShortlisterContextSchema>;

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
const moveShortlisterEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    role: z.literal("move-shortlister"),
    context: moveShortlisterContextSchema,
  })
  .strict();
export const llmContextEnvelopeSchema = z.discriminatedUnion("role", [
  topicExtractorEnvelopeSchema,
  moveShortlisterEnvelopeSchema,
]);
export type LlmContextEnvelope = z.infer<typeof llmContextEnvelopeSchema>;

export type LlmBoundaryDiagnosticCode =
  | "invalid-request"
  | "stale-evidence"
  | "unsupported-binder-context"
  | "candidate-not-found"
  | "invalid-output"
  | "transport-failed";
export type LlmBoundaryDiagnostic = Readonly<{
  code: LlmBoundaryDiagnosticCode;
  message: string;
}>;
export const llmBoundaryDiagnosticSchema: z.ZodType<LlmBoundaryDiagnostic> = z
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
  })
  .strict();
type LlmBoundaryFailure = Readonly<{
  ok: false;
  diagnostics: readonly [LlmBoundaryDiagnostic];
}>;
export type BuildLlmContextResult =
  | Readonly<{ ok: true; envelope: LlmContextEnvelope; diagnostics: readonly [] }>
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

const moveShortlisterRequestSchema = z
  .object({
    id: llmCallIdSchema,
    node: z.unknown(),
    suggestionSet: z.unknown(),
    candidateIds: z.array(stableIdentifierSchema).min(1).max(32),
    trigger: z.enum(["deterministic-empty", "explicit-user"]),
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
export const moveShortlistProposalSchema = z
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
export type MoveShortlistProposal = z.infer<typeof moveShortlistProposalSchema>;

const topicOutputSchema = z.union([
  topicManifestProposalSchema,
  topicInsufficientContextSchema,
  declinedSchema,
]);
const shortlisterOutputSchema = z.union([
  moveShortlistProposalSchema,
  shortlisterInsufficientContextSchema,
  declinedSchema,
]);
export type ValidatedLlmOutput =
  z.infer<typeof topicOutputSchema> | z.infer<typeof shortlisterOutputSchema>;

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
    if (call.messages[0].content !== expectedSystemMessage(call.role)) {
      context.addIssue({ code: "custom", message: "The system message must match the role." });
    }
    if (call.messages[1].content !== JSON.stringify(call.envelope)) {
      context.addIssue({
        code: "custom",
        message: "The user message must contain the exact envelope.",
      });
    }
  });
export type PreparedLlmCall = z.infer<typeof preparedLlmCallSchema>;

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

function expectedSystemMessage(role: SupportedLlmRole): string {
  return role === "topic-extractor"
    ? "Return only a topic manifest, a permitted context request, or a refusal. Do not solve the problem."
    : "Shortlist only supplied candidate IDs. Do not propose operations or new mathematics.";
}

export function validateLlmOutput(
  callInput: unknown,
  outputInput: unknown,
):
  | Readonly<{ ok: true; output: ValidatedLlmOutput; diagnostics: readonly [] }>
  | LlmBoundaryFailure {
  const call = safeParsePlain(preparedLlmCallSchema, callInput);
  if (call === undefined) return failure("invalid-request", "The prepared call is invalid.");
  if (call.role === "topic-extractor") {
    const output = safeParsePlain(topicOutputSchema, outputInput);
    return output === undefined
      ? failure("invalid-output", "The LLM output is malformed.")
      : { ok: true, output: freezeDetached(output), diagnostics: [] };
  }
  const output = safeParsePlain(shortlisterOutputSchema, outputInput);
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
    output: z.union([topicOutputSchema, shortlisterOutputSchema]).optional(),
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
        (evidence.role === "move-shortlister" &&
          !shortlisterOutputSchema.safeParse(evidence.output).success))
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
  } catch {
    return freezeDetached({
      id: preparedCall.id,
      role: preparedCall.role,
      preparedCall,
      status: "transport-failed" as const,
      rawResponse: null,
      diagnostics: [{ code: "transport-failed" as const, message: "The LLM transport failed." }],
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
