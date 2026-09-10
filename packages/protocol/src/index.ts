import {
  applyTransition,
  kernelOperationSchema,
  type KernelOperation,
  type TransitionClass,
} from "@proof/kernel";
import {
  createExecutableProofStateSchema,
  declarationsSchema,
  operatorDeclarationsSchema,
  plainMathJsonSchema,
  proofStateIdSchema,
  retrievalWildcardSchema,
  stableIdentifierSchema,
  statementIdSchema,
  type ExecutableProofState,
  type OperatorDeclaration,
  type StatementId,
} from "@proof/mathjson-model";
import { moveIdSchema, planMove, type MoveId } from "@proof/moves";
import {
  type RetrievalIndex,
  type ResolvedRetrievalSelection,
  type RetrievalSuggestion,
  type RetrievalVariantGroup,
} from "@proof/retrieval";
import {
  ASSOCIATIVE_OPERATORS,
  createAssociativeSelection,
  resolveProofSelection,
  resolveProofSelectionQuery,
  selectionSubjectIdSchema,
  type ResolvedProofSelection,
  type ResolvedProofSelectionQuery,
} from "@proof/selections";
import { z } from "zod";

export {
  BUILTIN_BINDER_SPECIFICATIONS,
  declarationSchema,
  freeSymbolNames,
  operatorDeclarationSchema,
  plainMathJsonSchema,
  retrievalWildcardSchema,
  stableIdentifierSchema,
} from "@proof/mathjson-model";
export type { OperatorDeclaration, PlainMathJson } from "@proof/mathjson-model";

export const actorIdSchema = stableIdentifierSchema.brand("ActorId");
export type ActorId = z.infer<typeof actorIdSchema>;
export const commandIdSchema = stableIdentifierSchema.brand("CommandId");
export type CommandId = z.infer<typeof commandIdSchema>;
export const proofNodeIdSchema = stableIdentifierSchema.brand("ProofNodeId");
export type ProofNodeId = z.infer<typeof proofNodeIdSchema>;
export const proofEdgeIdSchema = stableIdentifierSchema.brand("ProofEdgeId");
export type ProofEdgeId = z.infer<typeof proofEdgeIdSchema>;
export const transitionEventIdSchema = stableIdentifierSchema.brand("TransitionEventId");
export type TransitionEventId = z.infer<typeof transitionEventIdSchema>;
export const suggestionSetIdSchema = stableIdentifierSchema.brand("SuggestionSetId");
export type SuggestionSetId = z.infer<typeof suggestionSetIdSchema>;
export const suggestionIdSchema = stableIdentifierSchema.brand("SuggestionId");
export type SuggestionId = z.infer<typeof suggestionIdSchema>;
export const movePreviewIdSchema = stableIdentifierSchema.brand("MovePreviewId");
export type MovePreviewId = z.infer<typeof movePreviewIdSchema>;

export const actorSchema = z
  .object({ id: actorIdSchema, kind: z.enum(["human", "agent"]) })
  .strict();
export type Actor = z.infer<typeof actorSchema>;

const statementAnchorSchema = z
  .object({
    stateId: proofStateIdSchema,
    target: z.object({ kind: z.enum(["goal", "obligation"]), id: statementIdSchema }).strict(),
    statement: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("conclusion") }).strict(),
      z.object({ kind: z.literal("hypothesis"), id: statementIdSchema }).strict(),
    ]),
  })
  .strict();

const operandPathSchema = z.array(z.number().int().nonnegative());
const selectionPositionSchema = z
  .object({
    polarity: z.enum(["positive", "negative", "mixed", "neutral"]),
    role: z.enum(["proposition", "term", "binder"]),
  })
  .strict();
const resolvedExactProofSelectionSchema = z
  .object({
    kind: z.literal("exact"),
    anchor: statementAnchorSchema,
    path: operandPathSchema,
    fragment: plainMathJsonSchema,
    declarations: declarationsSchema,
    position: selectionPositionSchema,
  })
  .strict();
const resolvedAssociativeProofSelectionSchema = z
  .object({
    kind: z.literal("associative"),
    anchor: statementAnchorSchema,
    containerPath: operandPathSchema,
    startOperand: z.number().int().nonnegative(),
    endOperand: z.number().int().nonnegative(),
    displayRange: z
      .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      .optional(),
    operator: z.enum(ASSOCIATIVE_OPERATORS),
    container: plainMathJsonSchema,
    coveredOperandPaths: z.array(operandPathSchema).min(2),
    fragment: plainMathJsonSchema,
    declarations: declarationsSchema,
    position: selectionPositionSchema,
  })
  .strict()
  .superRefine((selection, context) => {
    if (selection.endOperand - selection.startOperand < 2) {
      addLinkIssue(context, "An associative proof selection must cover at least two operands.");
      return;
    }
    if (
      selection.displayRange !== undefined &&
      selection.displayRange[1] <= selection.displayRange[0]
    ) {
      addLinkIssue(context, "An associative display range must be nonempty and ordered.");
    }
    const localLens = createAssociativeSelection(
      selection.container,
      [],
      selection.startOperand,
      selection.endOperand,
      selection.displayRange,
    );
    const expectedPaths = Array.from(
      { length: selection.endOperand - selection.startOperand },
      (_unused, index) => [...selection.containerPath, selection.startOperand + index],
    );
    if (
      localLens === undefined ||
      localLens.operator !== selection.operator ||
      !jsonEquals(localLens.fragment, selection.fragment) ||
      !jsonEquals(selection.coveredOperandPaths, expectedPaths)
    ) {
      addLinkIssue(context, "The associative proof-selection lens is internally inconsistent.");
    }
  });

export const resolvedProofSelectionSchema: z.ZodType<ResolvedProofSelection> = z.discriminatedUnion(
  "kind",
  [resolvedExactProofSelectionSchema, resolvedAssociativeProofSelectionSchema],
);

const resolvedProofSelectionQuerySubjectSchema = z
  .object({
    id: selectionSubjectIdSchema,
    selection: resolvedProofSelectionSchema,
    abstraction: retrievalWildcardSchema.optional(),
  })
  .strict();

export const resolvedProofSelectionQuerySchema: z.ZodType<ResolvedProofSelectionQuery> = z
  .object({
    kind: z.literal("selection-query"),
    stateId: proofStateIdSchema,
    selections: z.array(resolvedProofSelectionQuerySubjectSchema).min(1).max(16),
  })
  .strict()
  .superRefine((query, context) => {
    const ids = query.selections.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      addLinkIssue(context, "Resolved selection-query subject IDs must be unique.");
    }
    if (query.selections.some(({ selection }) => selection.anchor.stateId !== query.stateId)) {
      addLinkIssue(context, "Every resolved query selection must use the query snapshot.");
    }
    const wildcardById = new Map<string, unknown>();
    const wildcardIdBySymbol = new Map<string, string>();
    query.selections.forEach(({ abstraction }) => {
      if (abstraction === undefined) return;
      const previous = wildcardById.get(abstraction.id);
      if (previous !== undefined && !jsonEquals(previous, abstraction)) {
        addLinkIssue(context, "Repeated query wildcard IDs must retain one specification.");
      }
      const previousId = wildcardIdBySymbol.get(abstraction.symbol);
      if (previousId !== undefined && previousId !== abstraction.id) {
        addLinkIssue(context, "Distinct query wildcard IDs cannot share one display symbol.");
      }
      wildcardById.set(abstraction.id, abstraction);
      wildcardIdBySymbol.set(abstraction.symbol, abstraction.id);
    });
  });

export const resolvedRetrievalSelectionSchema: z.ZodType<ResolvedRetrievalSelection> = z.union([
  resolvedProofSelectionSchema,
  resolvedProofSelectionQuerySchema,
]);

export const retrievalSuggestionSchema: z.ZodType<RetrievalSuggestion> = z
  .object({
    id: suggestionIdSchema,
    source: z.enum(["result", "move"]),
    artifactId: stableIdentifierSchema,
    patternId: stableIdentifierSchema,
    name: z.string().min(1),
    exactRepresentationMatch: z.boolean(),
    substitutions: z.array(
      z.object({ symbol: z.string().min(1), expression: plainMathJsonSchema }).strict(),
    ),
    rank: z.array(z.number()).min(1),
    reasons: z.array(z.string().min(1)).min(1),
    selectionMatches: z
      .array(
        z
          .object({
            selectionId: selectionSubjectIdSchema,
            patternId: stableIdentifierSchema.optional(),
            selectionSlotId: stableIdentifierSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    unresolvedSelectionSlots: z.array(stableIdentifierSchema),
    unresolvedParameters: z.array(stableIdentifierSchema),
    applicability: z.enum(["applicable", "requires-input"]),
    abstractionFit: z.enum(["not-used", "compatible", "unknown"]),
    variantFamilyId: stableIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((suggestion, context) => {
    const symbols = suggestion.substitutions.map(({ symbol }) => symbol);
    if (new Set(symbols).size !== symbols.length || !isSortedStrings(symbols)) {
      addLinkIssue(context, "Suggestion substitutions must use unique, sorted symbols.");
    }
    const selectionMatchKeys = suggestion.selectionMatches.map(selectionMatchKey);
    if (
      new Set(selectionMatchKeys).size !== selectionMatchKeys.length ||
      !isSortedSelectionMatches(suggestion.selectionMatches)
    ) {
      addLinkIssue(context, "Suggestion selection matches must be unique and sorted.");
    }
    for (const unresolved of [
      suggestion.unresolvedSelectionSlots,
      suggestion.unresolvedParameters,
    ]) {
      if (new Set(unresolved).size !== unresolved.length || !isSortedStrings(unresolved)) {
        addLinkIssue(context, "Suggestion unresolved-input IDs must be unique and sorted.");
      }
    }
    if (
      suggestion.applicability === "applicable" &&
      (suggestion.unresolvedSelectionSlots.length > 0 ||
        suggestion.unresolvedParameters.length > 0 ||
        suggestion.abstractionFit !== "not-used")
    ) {
      addLinkIssue(context, "An applicable suggestion cannot retain unresolved query input.");
    }
    if (
      suggestion.abstractionFit !== "not-used" &&
      (suggestion.exactRepresentationMatch || suggestion.applicability !== "requires-input")
    ) {
      addLinkIssue(
        context,
        "An abstraction-backed suggestion is non-exact and requires concrete input.",
      );
    }
  });

export const retrievalVariantGroupSchema: z.ZodType<RetrievalVariantGroup> = z
  .object({
    familyId: stableIdentifierSchema,
    name: z.string().min(1),
    suggestionIds: z.array(suggestionIdSchema).min(2),
  })
  .strict();

export type DisplayedSuggestionSet = Readonly<{
  id: SuggestionSetId;
  nodeId: ProofNodeId;
  stateId: ExecutableProofState["id"];
  selection: ResolvedRetrievalSelection;
  suggestions: readonly RetrievalSuggestion[];
  variantGroups: readonly RetrievalVariantGroup[];
}>;

export const displayedSuggestionSetSchema: z.ZodType<DisplayedSuggestionSet> = z
  .object({
    id: suggestionSetIdSchema,
    nodeId: proofNodeIdSchema,
    stateId: proofStateIdSchema,
    selection: resolvedRetrievalSelectionSchema,
    suggestions: z.array(retrievalSuggestionSchema),
    variantGroups: z.array(retrievalVariantGroupSchema),
  })
  .strict()
  .superRefine((suggestionSet, context) => {
    const selectionStateId =
      suggestionSet.selection.kind === "selection-query"
        ? suggestionSet.selection.stateId
        : suggestionSet.selection.anchor.stateId;
    if (suggestionSet.stateId !== selectionStateId) {
      addLinkIssue(context, "The suggestion set state does not match its resolved selection.");
    }
    const expectedSelectionIds =
      suggestionSet.selection.kind === "selection-query"
        ? suggestionSet.selection.selections.map(({ id }) => id)
        : ["selection:primary"];
    const queryUsesAbstraction =
      suggestionSet.selection.kind === "selection-query" &&
      suggestionSet.selection.selections.some(({ abstraction }) => abstraction !== undefined);
    suggestionSet.suggestions.forEach((suggestion) => {
      const matchedSelectionIds = suggestion.selectionMatches.map(({ selectionId }) => selectionId);
      if (
        new Set(matchedSelectionIds).size !== matchedSelectionIds.length ||
        expectedSelectionIds.length !== matchedSelectionIds.length ||
        expectedSelectionIds.some((id) => !matchedSelectionIds.includes(id))
      ) {
        addLinkIssue(context, "Every suggestion must account for every selected occurrence once.");
      }
      const assignedSlots = suggestion.selectionMatches.flatMap(({ selectionSlotId }) =>
        selectionSlotId === undefined ? [] : [selectionSlotId],
      );
      if (new Set(assignedSlots).size !== assignedSlots.length) {
        addLinkIssue(context, "A move suggestion cannot assign two selections to one slot.");
      }
      if (
        suggestion.source === "result" &&
        (suggestion.selectionMatches.length !== 1 ||
          suggestion.selectionMatches[0]?.selectionSlotId !== undefined ||
          suggestion.selectionMatches[0]?.patternId !== suggestion.patternId)
      ) {
        addLinkIssue(
          context,
          "A result suggestion must link its pattern to one selection without a move slot.",
        );
      }
      if (
        suggestion.source === "move" &&
        suggestion.selectionMatches.some(({ selectionSlotId }) => selectionSlotId === undefined)
      ) {
        addLinkIssue(context, "Every selected occurrence in a move suggestion needs a slot.");
      }
      if (
        suggestion.source === "move" &&
        !suggestion.selectionMatches.some(({ patternId }) => patternId === suggestion.patternId)
      ) {
        addLinkIssue(context, "A move suggestion must link its primary pattern to a selection.");
      }
      if (
        suggestion.source === "move" &&
        suggestion.unresolvedSelectionSlots.some((slotId) => assignedSlots.includes(slotId))
      ) {
        addLinkIssue(context, "An assigned move slot cannot also be unresolved.");
      }
      if (queryUsesAbstraction !== (suggestion.abstractionFit !== "not-used")) {
        addLinkIssue(
          context,
          "Suggestion abstraction evidence must match the abstractions in its concrete query.",
        );
      }
    });
    const suggestionIds = suggestionSet.suggestions.map(({ id }) => id);
    if (new Set(suggestionIds).size !== suggestionIds.length) {
      addLinkIssue(context, "Displayed suggestion IDs must be unique.");
    }
    for (let index = 1; index < suggestionSet.suggestions.length; index += 1) {
      if (
        compareSuggestionEvidence(
          suggestionSet.suggestions[index - 1] as RetrievalSuggestion,
          suggestionSet.suggestions[index] as RetrievalSuggestion,
        ) > 0
      ) {
        addLinkIssue(context, "Displayed suggestions must retain deterministic rank order.");
        break;
      }
    }
    const byId = new Map(
      suggestionSet.suggestions.map((suggestion) => [suggestion.id, suggestion]),
    );
    const familyIds = new Set<string>();
    if (!isSortedStrings(suggestionSet.variantGroups.map(({ familyId }) => familyId))) {
      addLinkIssue(context, "Variant groups must retain deterministic family order.");
    }
    suggestionSet.variantGroups.forEach((group) => {
      if (
        familyIds.has(group.familyId) ||
        new Set(group.suggestionIds).size !== group.suggestionIds.length
      ) {
        addLinkIssue(context, "Variant groups and their suggestion references must be unique.");
      }
      familyIds.add(group.familyId);
      group.suggestionIds.forEach((id) => {
        if (byId.get(id)?.variantFamilyId !== group.familyId) {
          addLinkIssue(context, "A variant group must reference suggestions in that exact family.");
        }
      });
      const exactFamilySuggestions = suggestionSet.suggestions
        .filter(({ variantFamilyId }) => variantFamilyId === group.familyId)
        .map(({ id }) => id);
      if (!jsonEquals(group.suggestionIds, exactFamilySuggestions)) {
        addLinkIssue(
          context,
          "A variant group must retain every displayed family member in order.",
        );
      }
    });
    const displayedFamilies = new Set(
      suggestionSet.suggestions
        .map(({ variantFamilyId }) => variantFamilyId)
        .filter((familyId): familyId is string => familyId !== undefined),
    );
    displayedFamilies.forEach((familyId) => {
      const memberCount = suggestionSet.suggestions.filter(
        ({ variantFamilyId }) => variantFamilyId === familyId,
      ).length;
      if (memberCount >= 2 && !familyIds.has(familyId)) {
        addLinkIssue(context, "Every displayed multi-member family requires a variant group.");
      }
    });
  });

export type PrepareDisplayedSuggestionSetResult =
  | Readonly<{ ok: true; suggestionSet: DisplayedSuggestionSet; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly [ProtocolDiagnostic] }>;

/** Zod adapter over the kernel's guarded parser; the operation vocabulary stays kernel-owned. */
export const kernelOperationAdapterSchema: z.ZodType<KernelOperation> = z
  .unknown()
  .transform((value, context) => {
    try {
      const parsed = kernelOperationSchema.safeParse(value);
      if (parsed.success) return parsed.data;
    } catch {
      // Hostile proxies and accessors are ordinary validation failures here.
    }
    context.addIssue({ code: "custom", message: "Invalid kernel operation." });
    return z.NEVER;
  });

export const applyKernelCommandSchema = z
  .object({
    commandId: commandIdSchema,
    kind: z.literal("apply-kernel-operation"),
    actor: actorSchema,
    parentNodeId: proofNodeIdSchema,
    resultNodeId: proofNodeIdSchema,
    edgeId: proofEdgeIdSchema,
    eventId: transitionEventIdSchema,
    moveId: moveIdSchema.optional(),
    suggestionSetId: suggestionSetIdSchema.optional(),
    chosenSuggestionId: suggestionIdSchema.optional(),
    previewId: movePreviewIdSchema.optional(),
    operation: kernelOperationAdapterSchema,
  })
  .strict()
  .superRefine((command, context) => {
    const hasSuggestionSet = command.suggestionSetId !== undefined;
    const hasChosenSuggestion = command.chosenSuggestionId !== undefined;
    if (hasSuggestionSet !== hasChosenSuggestion) {
      addLinkIssue(context, "Suggestion-set and chosen-suggestion IDs must be supplied together.");
    }
    if (hasSuggestionSet && command.moveId === undefined) {
      addLinkIssue(context, "A suggestion-backed primitive must identify its selected move.");
    }
    if (
      command.previewId !== undefined &&
      (!hasSuggestionSet || !hasChosenSuggestion || command.moveId === undefined)
    ) {
      addLinkIssue(context, "A preview reference requires complete displayed-move evidence.");
    }
  });
export type ApplyKernelCommand = z.infer<typeof applyKernelCommandSchema>;

export type ProtocolEnvironment = Readonly<{
  operators?: readonly OperatorDeclaration[];
}>;

export type ProofNode = Readonly<{
  id: ProofNodeId;
  state: ExecutableProofState;
}>;

export function createProofNodeSchema(environment: ProtocolEnvironment = {}): z.ZodType<ProofNode> {
  return z
    .object({
      id: proofNodeIdSchema,
      state: createExecutableProofStateSchema(environment),
    })
    .strict();
}

export const proofNodeSchema = createProofNodeSchema();

const prepareSuggestionSetInputSchema = z
  .object({
    id: suggestionSetIdSchema,
    selection: z.unknown(),
    options: z.unknown().optional(),
  })
  .strict();

/** Run deterministic retrieval once and detach the exact list shown to the user or agent. */
export function prepareDisplayedSuggestionSet(
  index: RetrievalIndex,
  currentNodeInput: unknown,
  requestInput: unknown,
  environment: ProtocolEnvironment = {},
): PrepareDisplayedSuggestionSetResult {
  try {
    const node = safeZodParse(createProofNodeSchema(environment), currentNodeInput);
    if (node === undefined) {
      return protocolFailure("invalid-current-node", "The suggestion request node is invalid.");
    }
    const request = safeZodParse(prepareSuggestionSetInputSchema, requestInput);
    if (request === undefined) {
      return protocolFailure("invalid-command", "The suggestion request is invalid.");
    }
    const query = index.query(node.state, request.selection, request.options ?? {});
    if (!query.ok) {
      return protocolFailure(
        "invalid-command",
        query.diagnostics[0]?.message ?? "Deterministic retrieval rejected the request.",
      );
    }
    const candidate = safeZodParse(displayedSuggestionSetSchema, {
      id: request.id,
      nodeId: node.id,
      stateId: node.state.id,
      selection: query.selection,
      suggestions: query.suggestions,
      variantGroups: query.variantGroups,
    });
    if (candidate === undefined || !suggestionSetMatchesNode(candidate, node, environment)) {
      return protocolFailure(
        "invalid-prepared-record",
        "The displayed suggestion set failed its snapshot-link invariants.",
      );
    }
    const suggestionSet = freezeDetached(candidate);
    return suggestionSet === undefined
      ? protocolFailure(
          "invalid-prepared-record",
          "The displayed suggestion set could not be detached.",
        )
      : { ok: true, suggestionSet, diagnostics: [] };
  } catch {
    return protocolFailure(
      "invalid-command",
      "The suggestion preparation boundary could not inspect its input safely.",
    );
  }
}

export const transitionClassSchema = z.enum(["equivalence", "strengthening", "weakening"]);

export const proofEdgeSchema = z
  .object({
    id: proofEdgeIdSchema,
    commandId: commandIdSchema,
    parentNodeId: proofNodeIdSchema,
    childNodeId: proofNodeIdSchema,
    moveId: moveIdSchema.optional(),
    suggestionSetId: suggestionSetIdSchema.optional(),
    chosenSuggestionId: suggestionIdSchema.optional(),
    previewId: movePreviewIdSchema.optional(),
    operation: kernelOperationAdapterSchema,
    transitionClass: transitionClassSchema,
  })
  .strict()
  .superRefine((edge, context) => addSuggestionReferenceIssues(edge, context));
export type ProofEdge = z.infer<typeof proofEdgeSchema>;

export function createProofEdgeSchema(
  environment: ProtocolEnvironment = {},
): typeof proofEdgeSchema {
  operatorDeclarationsSchema.parse(environment.operators ?? []);
  return proofEdgeSchema;
}

export const statementCollectionDeltaSchema = z
  .object({
    added: z.array(statementIdSchema),
    removed: z.array(statementIdSchema),
    updated: z.array(statementIdSchema),
  })
  .strict();
export type StatementCollectionDelta = z.infer<typeof statementCollectionDeltaSchema>;

export const proofStateDeltaSchema = z
  .object({
    goals: statementCollectionDeltaSchema,
    obligations: statementCollectionDeltaSchema,
  })
  .strict();
export type ProofStateDelta = z.infer<typeof proofStateDeltaSchema>;

export type MovePreview = Readonly<{
  id: MovePreviewId;
  nodeId: ProofNodeId;
  stateId: ExecutableProofState["id"];
  suggestionSetId: SuggestionSetId;
  chosenSuggestionId: SuggestionId;
  moveId: MoveId;
  operation: KernelOperation;
  transitionClass: TransitionClass;
  beforeState: ExecutableProofState;
  afterState: ExecutableProofState;
  delta: ProofStateDelta;
}>;

export function createMovePreviewSchema(
  environment: ProtocolEnvironment = {},
): z.ZodType<MovePreview> {
  const stateSchema = createExecutableProofStateSchema(environment);
  return z
    .object({
      id: movePreviewIdSchema,
      nodeId: proofNodeIdSchema,
      stateId: proofStateIdSchema,
      suggestionSetId: suggestionSetIdSchema,
      chosenSuggestionId: suggestionIdSchema,
      moveId: moveIdSchema,
      operation: kernelOperationAdapterSchema,
      transitionClass: transitionClassSchema,
      beforeState: stateSchema,
      afterState: stateSchema,
      delta: proofStateDeltaSchema,
    })
    .strict()
    .superRefine((preview, context) => {
      if (preview.stateId !== preview.beforeState.id) {
        addLinkIssue(context, "The preview state ID does not match its before-state snapshot.");
      }
      if (preview.operation.expectedStateId !== preview.beforeState.id) {
        addLinkIssue(context, "The preview operation does not target its before-state snapshot.");
      }
      if (preview.operation.resultStateId !== preview.afterState.id) {
        addLinkIssue(context, "The preview operation does not produce its after-state snapshot.");
      }
      if (!jsonEquals(preview.delta, computeDelta(preview.beforeState, preview.afterState))) {
        addLinkIssue(context, "The preview delta does not match its evidence snapshots.");
      }
    });
}

export const movePreviewSchema = createMovePreviewSchema();

const prepareMovePreviewInputSchema = z
  .object({
    id: movePreviewIdSchema,
    suggestionSetId: suggestionSetIdSchema,
    chosenSuggestionId: suggestionIdSchema,
    moveId: moveIdSchema,
    operation: kernelOperationAdapterSchema,
  })
  .strict();

export type PrepareMovePreviewResult =
  | Readonly<{ ok: true; preview: MovePreview; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly [ProtocolDiagnostic] }>;

/** Build a concrete, kernel-validated preview without mutating proof state. */
export function prepareMovePreview(
  currentNodeInput: unknown,
  suggestionSetInput: unknown,
  requestInput: unknown,
  environment: ProtocolEnvironment = {},
): PrepareMovePreviewResult {
  try {
    const node = safeZodParse(createProofNodeSchema(environment), currentNodeInput);
    const suggestionSet = safeZodParse(displayedSuggestionSetSchema, suggestionSetInput);
    const request = safeZodParse(prepareMovePreviewInputSchema, requestInput);
    if (node === undefined || suggestionSet === undefined || request === undefined) {
      return protocolFailure(
        "preview-rejected",
        "The move-preview request or evidence is invalid.",
      );
    }
    if (
      request.suggestionSetId !== suggestionSet.id ||
      !suggestionSetMatchesNode(suggestionSet, node, environment) ||
      !chosenSuggestionMatchesMove(suggestionSet, request.chosenSuggestionId, request.moveId)
    ) {
      return protocolFailure(
        "preview-rejected",
        "The requested move was not displayed for this proof snapshot.",
      );
    }
    const planned = planMove(
      node.state,
      { moveId: request.moveId, operation: request.operation },
      environment,
    );
    if (!planned.ok) {
      return protocolFailure(
        "preview-rejected",
        planned.diagnostics[0]?.message ?? "The move preview was rejected.",
      );
    }
    const candidate = safeZodParse(createMovePreviewSchema(environment), {
      id: request.id,
      nodeId: node.id,
      stateId: node.state.id,
      suggestionSetId: suggestionSet.id,
      chosenSuggestionId: request.chosenSuggestionId,
      moveId: request.moveId,
      operation: planned.operation,
      transitionClass: planned.preview.transitionClass,
      beforeState: node.state,
      afterState: planned.preview.state,
      delta: computeDelta(node.state, planned.preview.state),
    });
    const preview = candidate === undefined ? undefined : freezeDetached(candidate);
    return preview === undefined
      ? protocolFailure("preview-rejected", "The move preview could not be detached safely.")
      : { ok: true, preview, diagnostics: [] };
  } catch {
    return protocolFailure(
      "preview-rejected",
      "The move-preview boundary could not inspect its input safely.",
    );
  }
}

export type TransitionEvent = Readonly<{
  id: TransitionEventId;
  kind: "kernel-transition";
  commandId: CommandId;
  actor: Actor;
  parentNodeId: ProofNodeId;
  childNodeId: ProofNodeId;
  edgeId: ProofEdgeId;
  moveId?: MoveId | undefined;
  suggestionSetId?: SuggestionSetId | undefined;
  chosenSuggestionId?: SuggestionId | undefined;
  previewId?: MovePreviewId | undefined;
  operation: KernelOperation;
  transitionClass: TransitionClass;
  beforeState: ExecutableProofState;
  afterState: ExecutableProofState;
  delta: ProofStateDelta;
}>;

export function createTransitionEventSchema(
  environment: ProtocolEnvironment = {},
): z.ZodType<TransitionEvent> {
  const stateSchema = createExecutableProofStateSchema(environment);
  return z
    .object({
      id: transitionEventIdSchema,
      kind: z.literal("kernel-transition"),
      commandId: commandIdSchema,
      actor: actorSchema,
      parentNodeId: proofNodeIdSchema,
      childNodeId: proofNodeIdSchema,
      edgeId: proofEdgeIdSchema,
      moveId: moveIdSchema.optional(),
      suggestionSetId: suggestionSetIdSchema.optional(),
      chosenSuggestionId: suggestionIdSchema.optional(),
      previewId: movePreviewIdSchema.optional(),
      operation: kernelOperationAdapterSchema,
      transitionClass: transitionClassSchema,
      beforeState: stateSchema,
      afterState: stateSchema,
      delta: proofStateDeltaSchema,
    })
    .strict()
    .superRefine((event, context) => {
      addSuggestionReferenceIssues(event, context);
      if (event.operation.expectedStateId !== event.beforeState.id) {
        addLinkIssue(context, "Operation expected-state ID does not match before-state evidence.");
      }
      if (event.operation.resultStateId !== event.afterState.id) {
        addLinkIssue(context, "Operation result-state ID does not match after-state evidence.");
      }
      if (!jsonEquals(event.delta, computeDelta(event.beforeState, event.afterState))) {
        addLinkIssue(context, "The recorded state delta does not match the evidence snapshots.");
      }
    });
}

export const transitionEventSchema = createTransitionEventSchema();

export type PreparedProofCommand = Readonly<{
  command: ApplyKernelCommand;
  parent: ProofNode;
  node: ProofNode;
  edge: ProofEdge;
  event: TransitionEvent;
}>;

export function createPreparedProofCommandSchema(
  environment: ProtocolEnvironment = {},
): z.ZodType<PreparedProofCommand> {
  return z
    .object({
      command: applyKernelCommandSchema,
      parent: createProofNodeSchema(environment),
      node: createProofNodeSchema(environment),
      edge: createProofEdgeSchema(environment),
      event: createTransitionEventSchema(environment),
    })
    .strict()
    .superRefine((prepared, context) => addPreparedLinkIssues(prepared, context));
}

export const preparedProofCommandSchema = createPreparedProofCommandSchema();

export const proofCommandReceiptSchema = z
  .object({
    commandId: commandIdSchema,
    nodeId: proofNodeIdSchema,
    edgeId: proofEdgeIdSchema,
    eventId: transitionEventIdSchema,
    resultStateId: proofStateIdSchema,
    transitionClass: transitionClassSchema,
  })
  .strict();
export type ProofCommandReceipt = z.infer<typeof proofCommandReceiptSchema>;

export type ProtocolDiagnosticCode =
  | "invalid-context"
  | "invalid-current-node"
  | "invalid-command"
  | "actor-mismatch"
  | "command-id-conflict"
  | "stale-parent"
  | "kernel-rejected"
  | "move-rejected"
  | "preview-rejected"
  | "suggestion-evidence-invalid"
  | "invalid-prepared-record";

export const protocolDiagnosticSchema = z
  .object({
    code: z.enum([
      "invalid-context",
      "invalid-current-node",
      "invalid-command",
      "actor-mismatch",
      "command-id-conflict",
      "stale-parent",
      "kernel-rejected",
      "move-rejected",
      "preview-rejected",
      "suggestion-evidence-invalid",
      "invalid-prepared-record",
    ]),
    message: z.string(),
  })
  .strict();
export type ProtocolDiagnostic = z.infer<typeof protocolDiagnosticSchema>;

export type PrepareProofCommandSuccess = Readonly<{
  ok: true;
  prepared: PreparedProofCommand;
  receipt: ProofCommandReceipt;
  diagnostics: readonly [];
}>;

export type PrepareProofCommandFailure = Readonly<{
  ok: false;
  diagnostics: readonly [ProtocolDiagnostic];
}>;

export type PrepareProofCommandResult = PrepareProofCommandSuccess | PrepareProofCommandFailure;

export function createPrepareProofCommandSuccessSchema(
  environment: ProtocolEnvironment = {},
): z.ZodType<PrepareProofCommandSuccess> {
  return z
    .object({
      ok: z.literal(true),
      prepared: createPreparedProofCommandSchema(environment),
      receipt: proofCommandReceiptSchema,
      diagnostics: z.tuple([]),
    })
    .strict()
    .superRefine((result, context) => {
      const { prepared, receipt } = result;
      if (
        receipt.commandId !== prepared.command.commandId ||
        receipt.nodeId !== prepared.node.id ||
        receipt.edgeId !== prepared.edge.id ||
        receipt.eventId !== prepared.event.id ||
        receipt.resultStateId !== prepared.node.state.id ||
        receipt.transitionClass !== prepared.edge.transitionClass
      ) {
        addLinkIssue(context, "The receipt does not identify its prepared records exactly.");
      }
    });
}

export function createPrepareProofCommandResultSchema(
  environment: ProtocolEnvironment = {},
): z.ZodType<PrepareProofCommandResult> {
  return z.union([
    createPrepareProofCommandSuccessSchema(environment),
    z
      .object({
        ok: z.literal(false),
        diagnostics: z.tuple([protocolDiagnosticSchema]),
      })
      .strict(),
  ]);
}

export const prepareProofCommandResultSchema = createPrepareProofCommandResultSchema();

export type PrepareProofCommandContext = Readonly<{
  /** Trusted request provenance. It is recorded, but grants no mathematical authority. */
  trustedActor: unknown;
  operators?: unknown;
  previous?: unknown;
  suggestionSet?: unknown;
  preview?: unknown;
}>;

const prepareContextSchema = z
  .object({
    trustedActor: actorSchema,
    operators: operatorDeclarationsSchema.optional(),
    previous: z.unknown().optional(),
    suggestionSet: z.unknown().optional(),
    preview: z.unknown().optional(),
  })
  .strict();

/**
 * Validate and prepare records for one atomic persistence transaction.
 *
 * This function does not write storage, allocate IDs, authorize an actor, or
 * provide cross-process idempotency. A persistence service must atomically
 * enforce identifier uniqueness and command-ID uniqueness when storing the
 * returned bundle.
 */
export function prepareProofCommand(
  currentNodeInput: unknown,
  commandInput: unknown,
  contextInput: PrepareProofCommandContext,
): PrepareProofCommandResult {
  try {
    return prepareProofCommandInternal(currentNodeInput, commandInput, contextInput);
  } catch {
    return protocolFailure(
      "invalid-command",
      "The command preparation boundary could not inspect its input safely.",
    );
  }
}

function prepareProofCommandInternal(
  currentNodeInput: unknown,
  commandInput: unknown,
  contextInput: PrepareProofCommandContext,
): PrepareProofCommandResult {
  const contextResult = safeZodParse(prepareContextSchema, contextInput);
  if (contextResult === undefined) {
    return protocolFailure("invalid-context", "The trusted command context is invalid.");
  }
  const environment: ProtocolEnvironment = {
    ...(contextResult.operators === undefined ? {} : { operators: contextResult.operators }),
  };

  let nodeSchema: z.ZodType<ProofNode>;
  try {
    nodeSchema = createProofNodeSchema(environment);
  } catch {
    return protocolFailure("invalid-context", "The operator environment is invalid.");
  }
  const currentNode = safeZodParse(nodeSchema, currentNodeInput);
  if (currentNode === undefined) {
    return protocolFailure("invalid-current-node", "The current proof node is invalid.");
  }
  const command = safeZodParse(applyKernelCommandSchema, commandInput);
  if (command === undefined) {
    return protocolFailure("invalid-command", "The command does not match its strict schema.");
  }
  if (!jsonEquals(command.actor, contextResult.trustedActor)) {
    return protocolFailure(
      "actor-mismatch",
      "Command provenance does not exactly match the trusted actor context.",
    );
  }

  const suggestionSet =
    contextResult.suggestionSet === undefined
      ? undefined
      : safeZodParse(displayedSuggestionSetSchema, contextResult.suggestionSet);
  if (contextResult.suggestionSet !== undefined && suggestionSet === undefined) {
    return protocolFailure(
      "suggestion-evidence-invalid",
      "The displayed suggestion evidence is invalid.",
    );
  }
  const preview =
    contextResult.preview === undefined
      ? undefined
      : safeZodParse(createMovePreviewSchema(environment), contextResult.preview);
  if (contextResult.preview !== undefined && preview === undefined) {
    return protocolFailure("preview-rejected", "The stored move-preview evidence is invalid.");
  }

  if (contextResult.previous !== undefined) {
    const previous = safeZodParse(
      createPrepareProofCommandSuccessSchema(environment),
      contextResult.previous,
    );
    if (previous === undefined) {
      return protocolFailure("invalid-prepared-record", "The prior prepared result is invalid.");
    }
    if (previous.prepared.command.commandId === command.commandId) {
      if (!jsonEquals(previous.prepared.command, command)) {
        return protocolFailure(
          "command-id-conflict",
          "The command ID was already used for a different validated command.",
        );
      }
      if (
        !suggestionEvidenceMatchesCommand(
          command,
          suggestionSet,
          previous.prepared.parent,
          environment,
        )
      ) {
        return protocolFailure(
          "suggestion-evidence-invalid",
          "The command is not linked to valid suggestion evidence for its recorded parent.",
        );
      }
      if (
        !previewEvidenceMatchesCommand(
          command,
          preview,
          suggestionSet,
          previous.prepared.parent,
          environment,
        )
      ) {
        return protocolFailure(
          "preview-rejected",
          "The command is not linked to valid preview evidence for its recorded parent.",
        );
      }
      if (!verifiedByKernel(previous, environment)) {
        return protocolFailure(
          "invalid-prepared-record",
          "The prior prepared result is not reproduced by its recorded kernel transition.",
        );
      }
      if (conflictsWithRecordedNode(currentNode, previous)) {
        return protocolFailure(
          "invalid-current-node",
          "The current node contradicts recorded evidence with the same node identity.",
        );
      }
      if (isFrozenSuccess(contextResult.previous)) {
        return contextResult.previous;
      }
      return (
        freezeDetached(previous) ??
        protocolFailure("invalid-prepared-record", "The prior result could not be detached.")
      );
    }
  }

  if (command.parentNodeId !== currentNode.id) {
    return protocolFailure("stale-parent", "The command does not target the current proof node.");
  }
  if (command.resultNodeId === currentNode.id) {
    return protocolFailure("invalid-command", "A result node requires a fresh node ID.");
  }
  if (!suggestionEvidenceMatchesCommand(command, suggestionSet, currentNode, environment)) {
    return protocolFailure(
      "suggestion-evidence-invalid",
      "The command is not linked to valid suggestion evidence for its parent.",
    );
  }
  if (!previewEvidenceMatchesCommand(command, preview, suggestionSet, currentNode, environment)) {
    return protocolFailure(
      "preview-rejected",
      "The command is not linked to valid preview evidence for its parent.",
    );
  }

  const transition = applyCommandTransition(currentNode, command, environment);
  if (!transition.ok) {
    return transition;
  }

  const node: ProofNode = { id: command.resultNodeId, state: transition.state };
  const edge: ProofEdge = {
    id: command.edgeId,
    commandId: command.commandId,
    parentNodeId: currentNode.id,
    childNodeId: node.id,
    ...(command.moveId === undefined ? {} : { moveId: command.moveId }),
    ...(command.suggestionSetId === undefined || command.chosenSuggestionId === undefined
      ? {}
      : {
          suggestionSetId: command.suggestionSetId,
          chosenSuggestionId: command.chosenSuggestionId,
        }),
    ...(command.previewId === undefined ? {} : { previewId: command.previewId }),
    operation: command.operation,
    transitionClass: transition.transitionClass,
  };
  const event: TransitionEvent = {
    id: command.eventId,
    kind: "kernel-transition",
    commandId: command.commandId,
    actor: command.actor,
    parentNodeId: currentNode.id,
    childNodeId: node.id,
    edgeId: edge.id,
    ...(command.moveId === undefined ? {} : { moveId: command.moveId }),
    ...(command.suggestionSetId === undefined || command.chosenSuggestionId === undefined
      ? {}
      : {
          suggestionSetId: command.suggestionSetId,
          chosenSuggestionId: command.chosenSuggestionId,
        }),
    ...(command.previewId === undefined ? {} : { previewId: command.previewId }),
    operation: command.operation,
    transitionClass: transition.transitionClass,
    beforeState: currentNode.state,
    afterState: node.state,
    delta: computeDelta(currentNode.state, node.state),
  };
  const candidate: PreparedProofCommand = { command, parent: currentNode, node, edge, event };
  const prepared = safeZodParse(createPreparedProofCommandSchema(environment), candidate);
  if (prepared === undefined) {
    return protocolFailure(
      "invalid-prepared-record",
      "The prepared records failed their cross-link invariants.",
    );
  }
  const receipt: ProofCommandReceipt = {
    commandId: command.commandId,
    nodeId: node.id,
    edgeId: edge.id,
    eventId: event.id,
    resultStateId: node.state.id,
    transitionClass: edge.transitionClass,
  };
  const result: PrepareProofCommandSuccess = {
    ok: true,
    prepared,
    receipt,
    diagnostics: [],
  };
  return (
    freezeDetached(result) ??
    protocolFailure("invalid-prepared-record", "The prepared records could not be detached.")
  );
}

type AppliedCommandTransition =
  | Readonly<{
      ok: true;
      state: ExecutableProofState;
      transitionClass: TransitionClass;
    }>
  | PrepareProofCommandFailure;

function applyCommandTransition(
  currentNode: ProofNode,
  command: ApplyKernelCommand,
  environment: ProtocolEnvironment,
): AppliedCommandTransition {
  if (command.moveId !== undefined) {
    const planned = planMove(
      currentNode.state,
      { moveId: command.moveId, operation: command.operation },
      environment,
    );
    if (!planned.ok) {
      return protocolFailure(
        "move-rejected",
        planned.diagnostics[0]?.message ?? "The selected move could not be planned.",
      );
    }
    return {
      ok: true,
      state: planned.preview.state,
      transitionClass: planned.preview.transitionClass,
    };
  }

  const transition = applyTransition(currentNode.state, command.operation, environment);
  if (!transition.ok) {
    const kernelCode = transition.diagnostics[0]?.code ?? "unknown";
    return protocolFailure("kernel-rejected", `Kernel rejected the operation: ${kernelCode}.`);
  }
  return transition;
}

function verifiedByKernel(
  previous: PrepareProofCommandSuccess,
  environment: ProtocolEnvironment,
): boolean {
  const transition = applyCommandTransition(
    previous.prepared.parent,
    previous.prepared.command,
    environment,
  );
  return (
    transition.ok &&
    transition.transitionClass === previous.prepared.edge.transitionClass &&
    jsonEquals(transition.state, previous.prepared.node.state)
  );
}

function conflictsWithRecordedNode(
  current: ProofNode,
  previous: PrepareProofCommandSuccess,
): boolean {
  for (const recorded of [previous.prepared.parent, previous.prepared.node]) {
    if (current.id === recorded.id && !jsonEquals(current, recorded)) return true;
  }
  return false;
}

function addPreparedLinkIssues(prepared: PreparedProofCommand, context: z.RefinementCtx): void {
  const { command, parent, node, edge, event } = prepared;
  if (
    command.resultNodeId !== node.id ||
    command.edgeId !== edge.id ||
    command.eventId !== event.id ||
    command.commandId !== edge.commandId ||
    command.commandId !== event.commandId ||
    command.moveId !== edge.moveId ||
    command.moveId !== event.moveId ||
    command.suggestionSetId !== edge.suggestionSetId ||
    command.suggestionSetId !== event.suggestionSetId ||
    command.chosenSuggestionId !== edge.chosenSuggestionId ||
    command.chosenSuggestionId !== event.chosenSuggestionId ||
    command.previewId !== edge.previewId ||
    command.previewId !== event.previewId ||
    command.parentNodeId !== parent.id ||
    command.parentNodeId !== edge.parentNodeId ||
    command.parentNodeId !== event.parentNodeId ||
    node.id !== edge.childNodeId ||
    node.id !== event.childNodeId ||
    edge.id !== event.edgeId ||
    edge.transitionClass !== event.transitionClass ||
    !jsonEquals(command.actor, event.actor) ||
    command.operation.resultStateId !== node.state.id ||
    command.operation.expectedStateId !== parent.state.id ||
    !jsonEquals(command.operation, edge.operation) ||
    !jsonEquals(command.operation, event.operation) ||
    !jsonEquals(parent.state, event.beforeState) ||
    !jsonEquals(node.state, event.afterState)
  ) {
    addLinkIssue(context, "Prepared command records are not linked consistently.");
  }
}

function addLinkIssue(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: "custom", message });
}

function addSuggestionReferenceIssues(
  record: Readonly<{
    moveId?: MoveId | undefined;
    suggestionSetId?: SuggestionSetId | undefined;
    chosenSuggestionId?: SuggestionId | undefined;
    previewId?: MovePreviewId | undefined;
  }>,
  context: z.RefinementCtx,
): void {
  const hasSuggestionSet = record.suggestionSetId !== undefined;
  const hasChosenSuggestion = record.chosenSuggestionId !== undefined;
  if (hasSuggestionSet !== hasChosenSuggestion) {
    addLinkIssue(context, "Suggestion-set and chosen-suggestion IDs must be supplied together.");
  }
  if (hasSuggestionSet && record.moveId === undefined) {
    addLinkIssue(context, "Suggestion-backed evidence must identify its selected move.");
  }
  if (
    record.previewId !== undefined &&
    (!hasSuggestionSet || !hasChosenSuggestion || record.moveId === undefined)
  ) {
    addLinkIssue(context, "A preview reference requires complete displayed-move evidence.");
  }
}

/** Re-resolve a displayed selection against its exact proof-node snapshot. */
export function suggestionSetMatchesNode(
  suggestionSet: DisplayedSuggestionSet,
  node: ProofNode,
  environment: ProtocolEnvironment,
): boolean {
  if (suggestionSet.nodeId !== node.id || suggestionSet.stateId !== node.state.id) return false;
  if (suggestionSet.selection.kind === "selection-query") {
    const queryRequest = {
      kind: "selection-query",
      selections: suggestionSet.selection.selections.map(({ id, selection, abstraction }) => ({
        id,
        selection: selectionRequestFromResolved(selection),
        ...(abstraction === undefined ? {} : { abstraction }),
      })),
    };
    const resolved = resolveProofSelectionQuery(node.state, queryRequest, environment);
    return resolved.ok && jsonEquals(resolved.query, suggestionSet.selection);
  }
  const resolved = resolveProofSelection(
    node.state,
    selectionRequestFromResolved(suggestionSet.selection),
    environment,
  );
  return resolved.ok && jsonEquals(resolved.selection, suggestionSet.selection);
}

function selectionRequestFromResolved(selection: ResolvedProofSelection): unknown {
  return selection.kind === "exact"
    ? {
        kind: selection.kind,
        anchor: selection.anchor,
        path: selection.path,
      }
    : {
        kind: selection.kind,
        anchor: selection.anchor,
        containerPath: selection.containerPath,
        startOperand: selection.startOperand,
        endOperand: selection.endOperand,
        ...(selection.displayRange === undefined ? {} : { displayRange: selection.displayRange }),
      };
}

function suggestionEvidenceMatchesCommand(
  command: ApplyKernelCommand,
  suggestionSet: DisplayedSuggestionSet | undefined,
  parent: ProofNode,
  environment: ProtocolEnvironment,
): boolean {
  if (command.suggestionSetId === undefined || command.chosenSuggestionId === undefined) {
    return suggestionSet === undefined;
  }
  if (
    suggestionSet === undefined ||
    suggestionSet.id !== command.suggestionSetId ||
    !suggestionSetMatchesNode(suggestionSet, parent, environment)
  ) {
    return false;
  }
  const chosen = suggestionSet.suggestions.find(
    (suggestion) => suggestion.id === command.chosenSuggestionId,
  );
  return chosen?.source === "move" && chosen.artifactId === command.moveId;
}

function chosenSuggestionMatchesMove(
  suggestionSet: DisplayedSuggestionSet,
  chosenSuggestionId: SuggestionId,
  moveId: MoveId,
): boolean {
  const chosen = suggestionSet.suggestions.find(
    (suggestion) => suggestion.id === chosenSuggestionId,
  );
  return chosen?.source === "move" && chosen.artifactId === moveId;
}

function previewEvidenceMatchesCommand(
  command: ApplyKernelCommand,
  preview: MovePreview | undefined,
  suggestionSet: DisplayedSuggestionSet | undefined,
  parent: ProofNode,
  environment: ProtocolEnvironment,
): boolean {
  if (command.previewId === undefined) return preview === undefined;
  if (
    preview === undefined ||
    suggestionSet === undefined ||
    command.suggestionSetId === undefined ||
    command.chosenSuggestionId === undefined ||
    command.moveId === undefined ||
    preview.id !== command.previewId ||
    preview.nodeId !== parent.id ||
    preview.stateId !== parent.state.id ||
    preview.suggestionSetId !== command.suggestionSetId ||
    preview.chosenSuggestionId !== command.chosenSuggestionId ||
    preview.moveId !== command.moveId ||
    !jsonEquals(preview.operation, command.operation) ||
    !jsonEquals(preview.beforeState, parent.state) ||
    !chosenSuggestionMatchesMove(suggestionSet, preview.chosenSuggestionId, preview.moveId)
  ) {
    return false;
  }
  const planned = planMove(
    parent.state,
    { moveId: preview.moveId, operation: preview.operation },
    environment,
  );
  return (
    planned.ok &&
    planned.preview.transitionClass === preview.transitionClass &&
    jsonEquals(planned.preview.state, preview.afterState)
  );
}

function computeDelta(before: ExecutableProofState, after: ExecutableProofState): ProofStateDelta {
  return {
    goals: collectionDelta(before.goals, after.goals),
    obligations: collectionDelta(before.obligations, after.obligations),
  };
}

function collectionDelta(
  before: readonly Readonly<{ id: StatementId }>[],
  after: readonly Readonly<{ id: StatementId }>[],
): StatementCollectionDelta {
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  return {
    added: after.filter((entry) => !beforeById.has(entry.id)).map((entry) => entry.id),
    removed: before.filter((entry) => !afterById.has(entry.id)).map((entry) => entry.id),
    updated: after
      .filter((entry) => {
        const previous = beforeById.get(entry.id);
        return previous !== undefined && !jsonEquals(previous, entry);
      })
      .map((entry) => entry.id),
  };
}

function protocolFailure(
  code: ProtocolDiagnosticCode,
  message: string,
): PrepareProofCommandFailure {
  return { ok: false, diagnostics: [{ code, message }] };
}

function safeZodParse<Output>(schema: z.ZodType<Output>, value: unknown): Output | undefined {
  try {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonEquals(left[key], right[key]))
  );
}

function isSortedStrings(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function selectionMatchKey(match: RetrievalSuggestion["selectionMatches"][number]): string {
  return `${match.selectionSlotId ?? ""}\u0000${match.selectionId}\u0000${match.patternId ?? ""}`;
}

function isSortedSelectionMatches(matches: RetrievalSuggestion["selectionMatches"]): boolean {
  return matches.every(
    (match, index) =>
      index === 0 || selectionMatchKey(matches[index - 1]!) < selectionMatchKey(match),
  );
}

function compareSuggestionEvidence(left: RetrievalSuggestion, right: RetrievalSuggestion): number {
  const length = Math.max(left.rank.length, right.rank.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (right.rank[index] ?? 0) - (left.rank[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeDetached<Value>(value: Value): Value | undefined {
  try {
    return deepFreeze(structuredClone(value) as Value);
  } catch {
    return undefined;
  }
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

function isFrozenSuccess(value: unknown): value is PrepareProofCommandSuccess {
  return isRecord(value) && value.ok === true && isDeeplyFrozen(value);
}

function isDeeplyFrozen(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined && "value" in descriptor && isDeeplyFrozen(descriptor.value, seen)
    );
  });
}
