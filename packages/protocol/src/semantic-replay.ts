/**
 * Semantic replay (design plan §16.4).
 *
 * An applied step is described by a semantic plan rather than by raw operand paths: its move
 * (or approved result), each selection as a statement role plus the selected fragment, which is
 * re-matched as a pattern, and each menu parameter as the chosen item's origin and value. A plan
 * is derived deterministically from the records stored when the step was applied (the displayed
 * suggestion set, the chosen suggestion and the edge's recorded menus), or, for a step that a
 * replay created, read back from the plan recorded with it.
 *
 * Replaying a sequence onto a target node re-matches every step against the snapshot the
 * previous replayed step produced. Pattern variables are the fragment's free symbols declared in
 * the source context; a variable bound to a different expression is a changed substitution, and
 * the correspondence is carried forward, so an alpha-renamed or perturbed state adapts
 * consistently. Statement identities are carried forward too: a source target or hypothesis
 * corresponds to the one it was matched with, and generated IDs correspond position by position.
 * Menu parameters are chosen again from the regenerated menus: first the item whose value is the
 * recorded value under the correspondence, then the item with the corresponding origin (the same
 * selection slot, the conclusion, the corresponding hypothesis or subterm).
 *
 * Every replayed step is an ordinary `apply-kernel-operation` command with fresh IDs, validated
 * by `prepareProofCommand` against its own parent. Nothing here writes; the worker persists the
 * prepared records. The report lists each step as exact or adapted with its changed
 * substitutions and parameters and the obligations it created (marking those the source step did
 * not create), the first failure, and candidate repairs: alternate selections a caller can force
 * with an override.
 */
import {
  alphaEquivalent,
  composeTransitionClasses,
  kernelOperationSchema,
  matchExpressionPattern,
  type KernelOperation,
  type KernelResult,
} from "@proof/kernel";
import {
  binderShape,
  freeSymbolNames,
  parseStatementView,
  plainMathJsonSchema,
  sortEquals,
  sortSchema,
  stableIdentifierSchema,
  statementIdSchema,
  substituteMathJson,
  type OperatorDeclaration,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { runMovePlan, type AuthoredMoveTemplate } from "@proof/moves/authoring";
import {
  commandIdGenerator,
  materializeMoveOperation,
  materializeResultApplication,
  type MaterializationResult,
  type MoveDefinition,
  type MoveIdGenerator,
  type MoveSelectionInput,
  type ParameterMenu,
  type ParameterMenuItem,
} from "@proof/moves";
import { z } from "zod";
import {
  prepareProofCommand,
  RESULT_APPLICATION_MOVE_IDS,
  type DisplayedSuggestionSet,
  type PrepareProofCommandSuccess,
  type ProofEdge,
  type ProofNode,
} from "./index";
import { menuParameterIdSchema, parameterMenuItemSchema } from "./parameter-menus";

// Local copies of the branded identifiers in `index.ts`: the brands are structural, so values
// parsed here are interchangeable with those schemas' outputs without an evaluation-order cycle.
const actorIdSchema = stableIdentifierSchema.brand("ActorId");
const commandIdSchema = stableIdentifierSchema.brand("CommandId");
const proofNodeIdSchema = stableIdentifierSchema.brand("ProofNodeId");
const proofEdgeIdSchema = stableIdentifierSchema.brand("ProofEdgeId");
const moveIdSchema = stableIdentifierSchema.brand("MoveId");

/** The maximum number of steps one replay may carry. */
export const MAX_REPLAY_STEPS = 64;
/** The maximum number of materialize-and-validate attempts per step. */
const MAX_ATTEMPTS_PER_STEP = 24;
/** The maximum number of candidates listed per slot as alternatives or repairs. */
const MAX_LISTED_CANDIDATES = 5;

const operationSchema: z.ZodType<KernelOperation> = z.unknown().transform((value, context) => {
  try {
    const parsed = kernelOperationSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  } catch {
    // Hostile values are ordinary validation failures.
  }
  context.addIssue({ code: "custom", message: "Invalid kernel operation." });
  return z.NEVER;
});

const operandPathSchema = z.array(z.number().int().nonnegative()).max(64);

export const replayTargetSchema = z
  .object({ kind: z.enum(["goal", "obligation"]), id: statementIdSchema })
  .strict();
export type ReplayTarget = z.infer<typeof replayTargetSchema>;

/** Which statement of a target a selection sits in: its conclusion or one hypothesis. */
export const replayStatementSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("conclusion") }).strict(),
  z.object({ role: z.literal("hypothesis"), id: statementIdSchema }).strict(),
]);
export type ReplayStatement = z.infer<typeof replayStatementSchema>;

export const replayOccurrenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), path: operandPathSchema }).strict(),
  z
    .object({
      kind: z.literal("associative"),
      containerPath: operandPathSchema,
      startOperand: z.number().int().nonnegative(),
      endOperand: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type ReplayOccurrence = z.infer<typeof replayOccurrenceSchema>;

/** A pattern variable: a symbol declared in the recorded context, with its sort. */
const variablesSchema = z
  .array(z.object({ symbol: z.string().min(1), sort: sortSchema }).strict())
  .max(256);
export type ReplayVariable = z.infer<typeof variablesSchema>[number];

/** One selection of a step: where it was, and the fragment re-matched as a pattern. */
export const semanticSelectionSchema = z
  .object({
    /** The move's selection slot (`occurrence` for a result application). */
    slotId: stableIdentifierSchema,
    target: replayTargetSchema,
    statement: replayStatementSchema,
    occurrence: replayOccurrenceSchema,
    fragment: plainMathJsonSchema,
    /** The fragment's free symbols declared in its context: the pattern variables. */
    variables: variablesSchema,
  })
  .strict();
export type SemanticSelection = z.infer<typeof semanticSelectionSchema>;

/** One menu parameter of a step: the chosen item's origin and value, never its item ID. */
export const semanticParameterSchema = z
  .object({
    parameterId: menuParameterIdSchema,
    origin: parameterMenuItemSchema.shape.origin,
    value: parameterMenuItemSchema.shape.value,
    /** Pattern variables of a term or proposition value. */
    variables: variablesSchema,
  })
  .strict();
export type SemanticParameter = z.infer<typeof semanticParameterSchema>;

const substitutionsSchema = z
  .array(z.object({ symbol: z.string().min(1), expression: plainMathJsonSchema }).strict())
  .max(64);

export const semanticStepSchema = z
  .object({
    moveId: moveIdSchema,
    source: z.enum(["move", "result"]),
    /** Present exactly for a displayed library-result suggestion. */
    result: z
      .object({
        resultId: stableIdentifierSchema,
        direction: z.enum(["forward", "backward"]),
        substitutions: substitutionsSchema,
      })
      .strict()
      .optional(),
    selections: z.array(semanticSelectionSchema).min(1).max(16),
    parameters: z.array(semanticParameterSchema).max(32),
    /** The operation the step applied; its generated IDs are paired with the replayed ones. */
    operation: operationSchema,
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
    /** Conclusions of the obligations the step created. */
    obligations: z.array(plainMathJsonSchema).max(64),
    /**
     * Present exactly for the application of an approved multi-step macro (N45): `moveId` is the
     * macro's authored move, `selections` and `parameters` are its first step's, and every step
     * is recorded so later identities correspond. The macro is applied again, as one step.
     */
    macro: z
      .object({
        steps: z
          .array(
            z
              .object({
                id: stableIdentifierSchema,
                moveId: moveIdSchema,
                operation: operationSchema,
              })
              .strict(),
          )
          .min(2)
          .max(16),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((step, context) => {
    if (step.macro !== undefined && step.source !== "move") {
      context.addIssue({ code: "custom", message: "Only a move step can be a macro application." });
    }
    if ((step.source === "result") !== (step.result !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Exactly a result-application step records its result.",
      });
    }
    const slots = step.selections.map(({ slotId }) => slotId);
    const parameters = step.parameters.map(({ parameterId }) => parameterId);
    if (new Set(slots).size !== slots.length || new Set(parameters).size !== parameters.length) {
      context.addIssue({ code: "custom", message: "Slots and parameters must be unique." });
    }
    if (
      new Set(step.selections.map(({ target }) => `${target.kind}\u0000${target.id}`)).size !== 1
    ) {
      context.addIssue({ code: "custom", message: "Every selection must share one target." });
    }
  });
export type SemanticStep = z.infer<typeof semanticStepSchema>;

/** Where a step with no displayed suggestion came from. */
export const operationStepOriginSchema = z.enum(["backtrack", "raw-operation"]);
export type OperationStepOrigin = z.infer<typeof operationStepOriginSchema>;

/**
 * The plan of a step applied without a displayed suggestion (N45): a backtracking case split or
 * auto-close, or a raw kernel-operation command. It is derived from the stored operation alone.
 * The first selection (`target`) is the pattern the operation's target is re-matched by: the
 * whole conclusion of the target, or the rewritten occurrence for a rewrite operation. Every
 * hypothesis the operation names is a further selection (`ref:<n>`). Free symbols of those
 * fragments are pattern variables; other expressions of the operation are mapped through the
 * resulting correspondence. Identifiers the operation names that already existed are listed in
 * `referenced`; every other identifier is generated afresh.
 */
export const semanticOperationStepSchema = z
  .object({
    source: z.literal("operation"),
    origin: operationStepOriginSchema,
    /** The primitive move the stored edge names, if any (a step of a replayed macro). */
    moveId: moveIdSchema.optional(),
    selections: z.array(semanticSelectionSchema).min(1).max(16),
    referenced: z.array(z.string().min(1)).max(256),
    operation: operationSchema,
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
    obligations: z.array(plainMathJsonSchema).max(64),
  })
  .strict()
  .superRefine((step, context) => {
    const slots = step.selections.map(({ slotId }) => slotId);
    if (
      new Set(slots).size !== slots.length ||
      step.selections[0]?.slotId !== "target" ||
      new Set(step.selections.map(({ target }) => `${target.kind}\u0000${target.id}`)).size !== 1
    ) {
      context.addIssue({
        code: "custom",
        message: "An operation step starts with its target and shares one target.",
      });
    }
  });
export type SemanticOperationStep = z.infer<typeof semanticOperationStepSchema>;

/** Any step plan the replay can re-match. */
export const semanticPlanSchema = z.union([semanticStepSchema, semanticOperationStepSchema]);
export type SemanticPlan = z.infer<typeof semanticPlanSchema>;

export const replayStepSourceSchema = z.enum(["suggestion", "backtrack", "raw-operation", "macro"]);
export type ReplayStepSource = z.infer<typeof replayStepSourceSchema>;

/** How a plan's step was originally applied. */
export function replayStepSource(plan: SemanticPlan | undefined): ReplayStepSource {
  if (plan === undefined) return "suggestion";
  if (plan.source === "operation") return plan.origin;
  return plan.macro === undefined ? "suggestion" : "macro";
}

/** Force one listed candidate for a slot of a step (1-based step index). */
export const replayOverrideSchema = z
  .object({
    stepIndex: z.number().int().min(1).max(MAX_REPLAY_STEPS),
    slotId: stableIdentifierSchema,
    candidateId: z.string().min(1).max(2048),
  })
  .strict();
export type ReplayOverride = z.infer<typeof replayOverrideSchema>;

const replayRequestShape = {
  /** The steps are the edges on the path from `fromNodeId` down to `toNodeId`. */
  source: z.object({ fromNodeId: proofNodeIdSchema, toNodeId: proofNodeIdSchema }).strict(),
  /** Defaults to the session's current node. */
  targetNodeId: proofNodeIdSchema.optional(),
  /** The target in the target node that corresponds to the first step's target. */
  focus: replayTargetSchema.optional(),
  /** At most one per step and slot. */
  overrides: z
    .array(replayOverrideSchema)
    .max(64)
    .refine(
      (overrides) =>
        new Set(overrides.map(({ stepIndex, slotId }) => `${stepIndex}:${slotId}`)).size ===
        overrides.length,
      "At most one override per step and slot.",
    )
    .optional(),
} as const;

/**
 * A dry run: the report only. `commandId` is the ID a commit would use; the predicted records,
 * and so the candidate IDs of later steps, are derived from it.
 */
export const semanticReplayPreviewRequestSchema = z
  .object({ commandId: commandIdSchema.optional(), ...replayRequestShape })
  .strict();
export type SemanticReplayPreviewRequest = z.infer<typeof semanticReplayPreviewRequestSchema>;

/** Replay and commit fresh nodes, as one idempotent command. */
export const semanticReplayCommandSchema = z
  .object({
    commandId: commandIdSchema,
    actor: z.object({ id: actorIdSchema, kind: z.enum(["human", "agent"]) }).strict(),
    expectedCurrentNodeId: proofNodeIdSchema,
    ...replayRequestShape,
  })
  .strict();
export type SemanticReplayCommand = z.infer<typeof semanticReplayCommandSchema>;

/**
 * How a candidate occurrence relates to the recorded fragment: `identical` under the
 * correspondence established so far, `renamed` when it binds a pattern variable to a different
 * expression for the first time, `conflict` when it contradicts the correspondence (or maps two
 * variables to one symbol), and `shape` when only the head operator and arity agree.
 */
export const replayMatchSchema = z.enum(["identical", "renamed", "conflict", "shape"]);
export type ReplayMatch = z.infer<typeof replayMatchSchema>;

export const replayCandidateSchema = z
  .object({
    /** Stable within a replay request: pass it back as an override. */
    id: z.string().min(1),
    target: replayTargetSchema,
    statement: replayStatementSchema,
    occurrence: replayOccurrenceSchema,
    fragment: plainMathJsonSchema,
    match: replayMatchSchema,
  })
  .strict();
export type ReplayCandidate = z.infer<typeof replayCandidateSchema>;

const slotCandidatesSchema = z
  .object({ slotId: stableIdentifierSchema, candidates: z.array(replayCandidateSchema) })
  .strict();

export const replayDiagnosticCodeSchema = z.enum([
  "step-not-replayable",
  "move-unavailable",
  "no-matching-selection",
  "invalid-override",
  "parameter-unavailable",
  "materialization-failed",
  "command-rejected",
]);
export type ReplayDiagnosticCode = z.infer<typeof replayDiagnosticCodeSchema>;

const replayDiagnosticSchema = z
  .object({ code: replayDiagnosticCodeSchema, message: z.string().min(1) })
  .strict();

const substitutionChangeSchema = z
  .object({ symbol: z.string().min(1), expression: plainMathJsonSchema })
  .strict();

export const replayStepReportSchema = z
  .object({
    index: z.number().int().min(1),
    sourceEdgeId: proofEdgeIdSchema,
    moveId: moveIdSchema.optional(),
    /**
     * How the source step was applied: from a displayed suggestion, by backtracking with
     * information, as a raw kernel operation, or as one macro application (N45). Absent in
     * reports recorded earlier, which were all from displayed suggestions.
     */
    source: replayStepSourceSchema.optional(),
    status: z.enum(["exact", "adapted", "failed", "not-attempted"]),
    /** The replayed command, for an exact or adapted step; a macro's last command. */
    commandId: commandIdSchema.optional(),
    /** Every command a macro step applied, in order; absent for a single-command step. */
    commandIds: z.array(commandIdSchema).min(2).max(16).optional(),
    resultNodeId: proofNodeIdSchema.optional(),
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]).optional(),
    /** The chosen occurrence per slot. */
    selections: z
      .array(
        z.object({ slotId: stableIdentifierSchema, candidate: replayCandidateSchema }).strict(),
      )
      .max(16),
    /** Pattern variables this step first bound to a different expression. */
    substitutions: z.array(substitutionChangeSchema).max(256),
    /** Result-suggestion substitutions that changed under the correspondence. */
    resultSubstitutions: z.array(substitutionChangeSchema).max(64),
    /** Menu parameters whose value changed, and how the new item was found. */
    parameters: z
      .array(
        z
          .object({
            parameterId: menuParameterIdSchema,
            match: z.enum(["value", "origin"]),
            from: parameterMenuItemSchema.shape.value,
            to: parameterMenuItemSchema.shape.value,
          })
          .strict(),
      )
      .max(32),
    /** Obligations the replayed step created; `inSource` is false for new ones. */
    obligations: z
      .array(
        z
          .object({ id: statementIdSchema, expression: plainMathJsonSchema, inSource: z.boolean() })
          .strict(),
      )
      .max(64),
    /** Other occurrences that match the recorded fragments (not validated). */
    alternatives: z.array(slotCandidatesSchema).max(16),
    diagnostic: replayDiagnosticSchema.optional(),
  })
  .strict();
export type ReplayStepReport = z.infer<typeof replayStepReportSchema>;

export const semanticReplayReportSchema = z
  .object({
    targetNodeId: proofNodeIdSchema,
    complete: z.boolean(),
    steps: z.array(replayStepReportSchema).min(1).max(MAX_REPLAY_STEPS),
    /** Every pattern variable bound to a different expression, in first-use order. */
    substitutions: z.array(substitutionChangeSchema).max(256),
    firstFailure: z
      .object({
        index: z.number().int().min(1),
        diagnostic: replayDiagnosticSchema,
        /** Alternate selections for the failed step, usable as overrides. */
        repairs: z.array(slotCandidatesSchema).max(16),
      })
      .strict()
      .optional(),
    /** The node the last replayed step created; the target when nothing was replayed. */
    finalNodeId: proofNodeIdSchema,
  })
  .strict()
  .superRefine((report, context) => {
    const failed = report.steps.findIndex(({ status }) => status === "failed");
    if (
      report.complete !== (failed === -1) ||
      (failed === -1) !== (report.firstFailure === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A report is complete exactly without failures.",
      });
    }
    if (report.firstFailure !== undefined && report.firstFailure.index !== failed + 1) {
      context.addIssue({ code: "custom", message: "The first failure must be the failed step." });
    }
  });
export type SemanticReplayReport = z.infer<typeof semanticReplayReportSchema>;

/** The command ID of the `index`-th (1-based) replayed step. */
export function semanticReplayStepCommandId(commandId: string, index: number): string {
  return `${commandId}:replay:${index}`;
}

/**
 * The persisted record of one replayed step: its plan in the replayed branch's terms (so the step
 * can be replayed again), its report, and the replay request, which makes the command idempotent.
 */
export const semanticReplayStepRecordSchema = z
  .object({
    /** The replayed step's apply command. */
    commandId: commandIdSchema,
    replayCommandId: commandIdSchema,
    index: z.number().int().min(1).max(MAX_REPLAY_STEPS),
    count: z.number().int().min(1).max(MAX_REPLAY_STEPS),
    /** The node the step created. */
    nodeId: proofNodeIdSchema,
    sourceEdgeId: proofEdgeIdSchema,
    /** The replay command without its ID, exactly as received. */
    request: z
      .object({
        actor: z.object({ id: actorIdSchema, kind: z.enum(["human", "agent"]) }).strict(),
        expectedCurrentNodeId: proofNodeIdSchema,
        ...replayRequestShape,
      })
      .strict(),
    /** The node the replay started from. */
    targetNodeId: proofNodeIdSchema,
    plan: semanticPlanSchema,
    report: replayStepReportSchema,
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.index > record.count ||
      record.commandId !== semanticReplayStepCommandId(record.replayCommandId, record.index) ||
      record.report.index !== record.index ||
      record.report.commandId !== record.commandId ||
      record.report.resultNodeId !== record.nodeId ||
      record.report.sourceEdgeId !== record.sourceEdgeId ||
      (record.report.status !== "exact" && record.report.status !== "adapted")
    ) {
      context.addIssue({
        code: "custom",
        message: "A replayed-step record must identify its step, command and node consistently.",
      });
    }
  });
export type SemanticReplayStepRecord = z.infer<typeof semanticReplayStepRecordSchema>;

export type SemanticReplayDiagnostic = Readonly<{ code: string; message: string }>;

// --------------------------------------------------------------------------------------------
// Deriving plans from stored records
// --------------------------------------------------------------------------------------------

export type SemanticStepDerivationInput = Readonly<{
  parent: ProofNode;
  child: ProofNode;
  edge: Pick<
    ProofEdge,
    | "id"
    | "parentNodeId"
    | "childNodeId"
    | "moveId"
    | "suggestionSetId"
    | "chosenSuggestionId"
    | "operation"
    | "transitionClass"
    | "menuSelection"
  >;
  /** The displayed suggestion set the edge's chosen suggestion came from. */
  suggestionSet?: DisplayedSuggestionSet;
  operators?: readonly OperatorDeclaration[];
}>;

export type SemanticStepDerivationResult =
  | Readonly<{ ok: true; step: SemanticStep; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly [SemanticReplayDiagnostic] }>;

type ResolvedSelection = Extract<
  DisplayedSuggestionSet["selection"],
  { kind: "exact" | "associative" }
>;

/**
 * The semantic plan of one suggestion-backed step, from the parent and child snapshots, the edge
 * and the displayed suggestion set, all as stored when the step was applied.
 */
export function deriveSemanticStep(
  input: SemanticStepDerivationInput,
): SemanticStepDerivationResult {
  try {
    return derive(input);
  } catch {
    return deriveFailure("The stored step could not be inspected safely.");
  }
}

function derive(input: SemanticStepDerivationInput): SemanticStepDerivationResult {
  const { parent, child, edge, suggestionSet } = input;
  const operators = input.operators ?? [];
  if (edge.parentNodeId !== parent.id || edge.childNodeId !== child.id) {
    return deriveFailure("The step's snapshots do not belong to its edge.");
  }
  if (
    edge.moveId === undefined ||
    edge.suggestionSetId === undefined ||
    edge.chosenSuggestionId === undefined ||
    suggestionSet === undefined
  ) {
    return deriveFailure(
      "The step was not applied from a displayed suggestion, so it has no recorded selections.",
    );
  }
  if (suggestionSet.id !== edge.suggestionSetId || suggestionSet.nodeId !== parent.id) {
    return deriveFailure("The suggestion set is not the one the step was applied from.");
  }
  const chosen = suggestionSet.suggestions.find(({ id }) => id === edge.chosenSuggestionId);
  if (chosen === undefined) return deriveFailure("The chosen suggestion is not in its set.");

  const selections: SemanticSelection[] = [];
  const matches =
    chosen.source === "result"
      ? chosen.selectionMatches
          .filter(({ patternId }) => patternId === chosen.patternId)
          .slice(0, 1)
          .map((match) => ({ ...match, selectionSlotId: "occurrence" }))
      : chosen.selectionMatches;
  for (const match of matches) {
    if (match.selectionSlotId === undefined) continue;
    const resolved = resolvedSelectionById(suggestionSet, match.selectionId);
    if (resolved === undefined) return deriveFailure("A matched selection is not in its set.");
    const selection = semanticSelection(parent, match.selectionSlotId, resolved, operators);
    if (selection === undefined) return deriveFailure("A selection does not address its target.");
    selections.push(selection);
  }
  if (selections.length === 0) return deriveFailure("The step has no matched selection.");

  const parameters: SemanticParameter[] = [];
  const menuSelection = edge.menuSelection;
  const target = selections[0]?.target;
  const entry = target === undefined ? undefined : findEntry(parent, target.id);
  for (const [parameterId, itemId] of Object.entries(menuSelection?.choices ?? {})) {
    const item = menuSelection?.menus
      .find((menu) => menu.parameterId === parameterId)
      ?.items.find(({ id }) => id === itemId);
    if (item === undefined) return deriveFailure("A recorded menu choice is not in its menu.");
    parameters.push({
      parameterId,
      origin: item.origin,
      value: item.value,
      variables: valueVariables(item.value, entry, operators),
    });
  }

  const operation = edge.operation;
  const result =
    chosen.source === "result" ? resultEvidence(chosen.artifactId, operation, chosen) : undefined;
  if (chosen.source === "result" && result === undefined) {
    return deriveFailure("The result application does not record its direction.");
  }
  const parentObligations = new Set(parent.state.obligations.map(({ id }) => id));
  const candidate = {
    moveId: edge.moveId,
    source: chosen.source,
    ...(result === undefined ? {} : { result }),
    selections,
    parameters,
    operation,
    transitionClass: edge.transitionClass,
    obligations: child.state.obligations
      .filter(({ id }) => !parentObligations.has(id))
      .map(({ sequent }) => sequent.conclusion.expression),
  };
  const parsed = semanticStepSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, step: freezeDetached(parsed.data), diagnostics: [] }
    : deriveFailure("The derived plan failed its schema.");
}

function resultEvidence(
  resultId: string,
  operation: KernelOperation,
  suggestion: DisplayedSuggestionSet["suggestions"][number],
): SemanticStep["result"] | undefined {
  const direction =
    operation.kind === "apply-result-backward"
      ? "backward"
      : operation.kind === "apply-result-forward"
        ? "forward"
        : operation.kind === "rewrite-with-equivalence"
          ? operation.direction
          : undefined;
  return direction === undefined
    ? undefined
    : {
        resultId,
        direction,
        substitutions: suggestion.substitutions.map(({ symbol, expression }) => ({
          symbol,
          expression,
        })),
      };
}

function resolvedSelectionById(
  suggestionSet: DisplayedSuggestionSet,
  selectionId: string,
): ResolvedSelection | undefined {
  if (suggestionSet.selection.kind !== "selection-query") {
    return selectionId === "selection:primary"
      ? (suggestionSet.selection as ResolvedSelection)
      : undefined;
  }
  return suggestionSet.selection.selections.find(({ id }) => id === selectionId)?.selection as
    ResolvedSelection | undefined;
}

function semanticSelection(
  node: ProofNode,
  slotId: string,
  selection: ResolvedSelection,
  operators: readonly OperatorDeclaration[],
): SemanticSelection | undefined {
  const entry = findEntry(node, selection.anchor.target.id);
  if (entry === undefined) return undefined;
  const statement: ReplayStatement =
    selection.anchor.statement.kind === "conclusion"
      ? { role: "conclusion" }
      : { role: "hypothesis", id: selection.anchor.statement.id };
  const occurrence: ReplayOccurrence =
    selection.kind === "exact"
      ? { kind: "exact", path: [...selection.path] }
      : {
          kind: "associative",
          containerPath: [...selection.containerPath],
          startOperand: selection.startOperand,
          endOperand: selection.endOperand,
        };
  return {
    slotId,
    target: { kind: selection.anchor.target.kind, id: selection.anchor.target.id },
    statement,
    occurrence,
    fragment: selection.fragment,
    variables: fragmentVariables(selection.fragment, entry, operators),
  };
}

// --------------------------------------------------------------------------------------------
// Deriving plans without a displayed suggestion (N45)
// --------------------------------------------------------------------------------------------

export type OperationStepDerivationInput = Readonly<{
  parent: ProofNode;
  child: ProofNode;
  edge: Pick<
    ProofEdge,
    "id" | "parentNodeId" | "childNodeId" | "moveId" | "operation" | "transitionClass"
  >;
  /** `backtrack` for the case split and auto-close of backtracking with information. */
  origin?: OperationStepOrigin;
  operators?: readonly OperatorDeclaration[];
}>;

export type OperationStepDerivationResult =
  | Readonly<{ ok: true; step: SemanticOperationStep; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly [SemanticReplayDiagnostic] }>;

const REWRITE_OPERATIONS = new Set([
  "rewrite-with-equality",
  "rewrite-with-equivalence",
  "rewrite-with-implication",
]);

/** Keys whose values are mathematics, mapped through the symbol correspondence. */
const EXPRESSION_KEYS = new Set(["proposition", "term", "witness"]);

/** Keys of the operation's own addressing, rebuilt from the re-matched occurrence. */
const ADDRESS_KEYS = new Set(["target", "statement", "path", "lens"]);

function isIdentifierKey(key: string): boolean {
  return (key === "id" || /Ids?$/.test(key)) && !STATE_ID_KEYS.has(key);
}

/**
 * The plan of one step applied without a displayed suggestion, from the stored operation and the
 * parent and child snapshots: the target as a pattern, the hypotheses it names as further
 * patterns, and the operation itself as the template to rebuild.
 */
export function deriveOperationStep(
  input: OperationStepDerivationInput,
): OperationStepDerivationResult {
  try {
    return deriveOperation(input);
  } catch {
    return operationFailure("The stored step could not be inspected safely.");
  }
}

function deriveOperation(input: OperationStepDerivationInput): OperationStepDerivationResult {
  const { parent, child, edge } = input;
  const operators = input.operators ?? [];
  if (edge.parentNodeId !== parent.id || edge.childNodeId !== child.id) {
    return operationFailure("The step's snapshots do not belong to its edge.");
  }
  const operation = edge.operation as unknown as Readonly<Record<string, unknown>>;
  const target = operation.target as ReplayTarget | undefined;
  const entry = target === undefined ? undefined : findEntry(parent, target.id);
  if (target === undefined || entry === undefined) {
    return operationFailure("The operation's target is not in the parent snapshot.");
  }
  const selectionTarget: ReplayTarget = { kind: target.kind, id: target.id };
  const hypotheses = entry.sequent.context.hypotheses;
  const known = stateStrings(parent.state);

  let anchor: SemanticSelection;
  let anchorHypothesis: string | undefined;
  if (REWRITE_OPERATIONS.has(edge.operation.kind)) {
    const addressed = rewriteAnchor(operation, entry, selectionTarget, operators);
    if (addressed === undefined) {
      return operationFailure("The rewritten occurrence is not in the parent snapshot.");
    }
    anchor = addressed;
    anchorHypothesis =
      addressed.statement.role === "hypothesis" ? addressed.statement.id : undefined;
  } else {
    anchor = {
      slotId: "target",
      target: selectionTarget,
      statement: { role: "conclusion" },
      occurrence: { kind: "exact", path: [] },
      fragment: entry.sequent.conclusion.expression,
      variables: fragmentVariables(entry.sequent.conclusion.expression, entry, operators),
    };
  }

  const referenced = referencedIdentifiers(operation, known);
  const selections: SemanticSelection[] = [anchor];
  for (const id of referenced) {
    if (id === anchorHypothesis) continue;
    const hypothesis = hypotheses.find((candidate) => candidate.id === id);
    if (hypothesis === undefined) continue;
    const expression = hypothesis.statement.expression;
    selections.push({
      slotId: `ref:${selections.length}`,
      target: selectionTarget,
      statement: { role: "hypothesis", id: hypothesis.id },
      occurrence: { kind: "exact", path: [] },
      fragment: expression,
      variables: fragmentVariables(expression, entry, operators),
    });
  }

  const parentObligations = new Set(parent.state.obligations.map(({ id }) => id));
  const candidate = {
    source: "operation" as const,
    origin: input.origin ?? "raw-operation",
    ...(edge.moveId === undefined ? {} : { moveId: edge.moveId }),
    selections,
    referenced,
    operation: edge.operation,
    transitionClass: edge.transitionClass,
    obligations: child.state.obligations
      .filter(({ id }) => !parentObligations.has(id))
      .map(({ sequent }) => sequent.conclusion.expression),
  };
  const parsed = semanticOperationStepSchema.safeParse(candidate);
  return parsed.success
    ? { ok: true, step: freezeDetached(parsed.data), diagnostics: [] }
    : operationFailure("The derived operation plan failed its schema.");
}

function operationFailure(message: string): OperationStepDerivationResult {
  return { ok: false, diagnostics: [{ code: "step-not-replayable", message }] };
}

/** The occurrence a rewrite operation addresses, as the anchor selection. */
function rewriteAnchor(
  operation: Readonly<Record<string, unknown>>,
  entry: Entry,
  target: ReplayTarget,
  operators: readonly OperatorDeclaration[],
): SemanticSelection | undefined {
  const statement = operation.statement as { kind?: unknown; id?: unknown } | undefined;
  const path = operation.path;
  if (
    statement === undefined ||
    !Array.isArray(path) ||
    !path.every((index) => typeof index === "number")
  ) {
    return undefined;
  }
  const replayStatement: ReplayStatement | undefined =
    statement.kind === "conclusion"
      ? { role: "conclusion" }
      : statement.kind === "hypothesis" && typeof statement.id === "string"
        ? { role: "hypothesis", id: statement.id as never }
        : undefined;
  if (replayStatement === undefined) return undefined;
  const expression =
    replayStatement.role === "conclusion"
      ? entry.sequent.conclusion.expression
      : entry.sequent.context.hypotheses.find(({ id }) => id === replayStatement.id)?.statement
          .expression;
  const container = expression === undefined ? undefined : expressionAt(expression, path);
  if (container === undefined) return undefined;
  const lens = operation.lens as { startOperand?: unknown; endOperand?: unknown } | undefined;
  let occurrence: ReplayOccurrence;
  let fragment: PlainMathJson;
  if (lens === undefined) {
    occurrence = { kind: "exact", path: [...(path as number[])] };
    fragment = container;
  } else {
    const parts = functionParts(container);
    if (
      parts === undefined ||
      typeof lens.startOperand !== "number" ||
      typeof lens.endOperand !== "number" ||
      lens.endOperand > parts.operands.length
    ) {
      return undefined;
    }
    occurrence = {
      kind: "associative",
      containerPath: [...(path as number[])],
      startOperand: lens.startOperand,
      endOperand: lens.endOperand,
    };
    fragment = parts.rebuild(parts.operands.slice(lens.startOperand, lens.endOperand));
  }
  return {
    slotId: "target",
    target,
    statement: replayStatement,
    occurrence,
    fragment,
    variables: fragmentVariables(fragment, entry, operators),
  };
}

function expressionAt(
  expression: PlainMathJson,
  path: readonly unknown[],
): PlainMathJson | undefined {
  let current = expression;
  for (const index of path) {
    const parts = functionParts(current);
    const next = typeof index === "number" ? parts?.operands[index] : undefined;
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

/** Every string in a snapshot's state: its identifiers, among much else. */
function stateStrings(state: ProofNode["state"]): Set<string> {
  const strings = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") strings.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) Object.values(value).forEach(visit);
  };
  visit(state);
  return strings;
}

/**
 * The identifiers an operation names that already existed in the snapshot it was applied to, in
 * first-use order, excluding its target and the addresses of a rewrite.
 */
function referencedIdentifiers(
  operation: Readonly<Record<string, unknown>>,
  known: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  const visit = (value: unknown, key: string): void => {
    if (typeof value === "string") {
      if (isIdentifierKey(key) && known.has(value) && !found.includes(value)) found.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
    } else if (isRecord(value)) {
      for (const [field, item] of Object.entries(value)) {
        if (!EXPRESSION_KEYS.has(field) && field !== "instantiation") visit(item, field);
      }
    }
  };
  for (const [field, item] of Object.entries(operation)) {
    if (!ADDRESS_KEYS.has(field) && !EXPRESSION_KEYS.has(field) && field !== "instantiation") {
      visit(item, field);
    }
  }
  return found;
}

export type MacroStepDerivationInput = Readonly<{
  /** The snapshot the application started from, and the one its last step produced. */
  parent: ProofNode;
  child: ProofNode;
  /** The application's edges in step order, as recorded with their macro link. */
  edges: readonly Pick<
    ProofEdge,
    "id" | "parentNodeId" | "childNodeId" | "moveId" | "operation" | "transitionClass" | "macro"
  >[];
  /** The stored macro preview the application was applied from. */
  preview: Readonly<{
    id: string;
    suggestionSetId: string;
    chosenSuggestionId: string;
    menuSelection?: SemanticStepDerivationInput["edge"]["menuSelection"];
  }>;
  suggestionSet: DisplayedSuggestionSet;
  operators?: readonly OperatorDeclaration[];
}>;

/**
 * The plan of a whole macro application: the first step's selections and menu choices, as the
 * displayed suggestion recorded them, and every step's operation. The edges must be one complete,
 * consecutive application.
 */
export function deriveMacroStep(input: MacroStepDerivationInput): SemanticStepDerivationResult {
  try {
    const { edges, parent, child, preview } = input;
    const first = edges[0];
    const last = edges.at(-1);
    const link = first?.macro;
    if (first === undefined || last === undefined || link === undefined || edges.length < 2) {
      return deriveFailure("A macro application has at least two steps.");
    }
    const consistent = edges.every(
      (edge, position) =>
        edge.macro?.previewId === preview.id &&
        edge.macro.moveId === link.moveId &&
        edge.macro.stepIndex === position + 1 &&
        edge.macro.stepCount === edges.length &&
        edge.moveId !== undefined &&
        (position === 0 || edge.parentNodeId === edges[position - 1]?.childNodeId),
    );
    if (!consistent || first.parentNodeId !== parent.id || last.childNodeId !== child.id) {
      return deriveFailure("The macro's steps are not one complete, consecutive application.");
    }
    const derived = derive({
      parent,
      child,
      edge: {
        id: first.id,
        parentNodeId: parent.id,
        childNodeId: child.id,
        moveId: link.moveId,
        suggestionSetId: preview.suggestionSetId as never,
        chosenSuggestionId: preview.chosenSuggestionId as never,
        operation: first.operation,
        transitionClass: composeTransitionClasses(
          edges.map(({ transitionClass }) => transitionClass),
        ),
        ...(preview.menuSelection === undefined ? {} : { menuSelection: preview.menuSelection }),
      },
      suggestionSet: input.suggestionSet,
      ...(input.operators === undefined ? {} : { operators: input.operators }),
    });
    if (!derived.ok) return derived;
    const parsed = semanticStepSchema.safeParse({
      ...derived.step,
      macro: {
        steps: edges.map((edge) => ({
          id: edge.macro?.stepId,
          moveId: edge.moveId,
          operation: edge.operation,
        })),
      },
    });
    return parsed.success
      ? { ok: true, step: freezeDetached(parsed.data), diagnostics: [] }
      : deriveFailure("The derived macro plan failed its schema.");
  } catch {
    return deriveFailure("The stored macro application could not be inspected safely.");
  }
}

// --------------------------------------------------------------------------------------------
// Replay
// --------------------------------------------------------------------------------------------

export type SemanticReplaySourceStep = Readonly<{
  sourceEdgeId: string;
  /** The plan, or undefined with the reason the step cannot be replayed. */
  step?: SemanticPlan;
  unavailable?: string;
}>;

export type SemanticReplayRecordIds = (commandId: string) => Readonly<{
  resultNodeId: string;
  edgeId: string;
  eventId: string;
  resultStateId: string;
}>;

export type SemanticReplayInput = Readonly<{
  steps: readonly SemanticReplaySourceStep[];
  target: ProofNode;
  focus?: ReplayTarget | undefined;
  overrides?: readonly ReplayOverride[] | undefined;
  /** The replay command ID; step command IDs are `semanticReplayStepCommandId` of it. */
  commandId: string;
  actor: Readonly<{ id: string; kind: "human" | "agent" }>;
  recordIds: SemanticReplayRecordIds;
  operators?: readonly OperatorDeclaration[];
  results?: readonly KernelResult[];
  /** The approved move catalog. */
  moves: readonly MoveDefinition[];
  /** The approved multi-step macros (N45): a macro step is applied again through its template. */
  macros?: readonly Readonly<{ move: MoveDefinition; template: AuthoredMoveTemplate }>[];
}>;

/** One replayed step, ready to persist. */
export type SemanticReplayedStep = Readonly<{
  index: number;
  sourceEdgeId: string;
  /** The step's command; the LAST command of a macro step. */
  prepared: PrepareProofCommandSuccess;
  /** The commands a macro step applied before `prepared`, in order; empty for other steps. */
  preceding: readonly PrepareProofCommandSuccess[];
  /** The step's plan in the replayed branch's terms, recorded so it can be replayed again. */
  plan: SemanticPlan;
  report: ReplayStepReport;
}>;

export type SemanticReplayResult =
  | Readonly<{
      ok: true;
      report: SemanticReplayReport;
      /** The replayed prefix: every step when `report.complete`. */
      replayed: readonly SemanticReplayedStep[];
      /** The node the last replayed step created, or the target. */
      finalNode: ProofNode;
      diagnostics: readonly [];
    }>
  | Readonly<{ ok: false; diagnostics: readonly [SemanticReplayDiagnostic] }>;

type Entry = ProofNode["state"]["goals"][number];

type Correspondence = {
  /** Source symbol → expression in the replayed branch. */
  symbols: Map<string, PlainMathJson>;
  /** First-use order of symbol bindings. */
  order: string[];
  /** Source statement or assumption ID → replayed ID. */
  ids: Map<string, string>;
};

type Candidate = ReplayCandidate &
  Readonly<{
    bindings: Readonly<Record<string, PlainMathJson>>;
    rank: readonly number[];
  }>;

type Attempt =
  | Readonly<{
      ok: true;
      /** The step's (last) command. */
      prepared: PrepareProofCommandSuccess;
      /** A macro's earlier commands. */
      preceding: readonly PrepareProofCommandSuccess[];
      /** The first (or only) operation, and every operation a macro applied. */
      operation: KernelOperation;
      operations: readonly KernelOperation[];
      moveId: string | undefined;
      chosen: readonly Readonly<{ slotId: string; candidate: Candidate }>[];
      parameters: readonly Readonly<{
        recorded: SemanticParameter;
        item: ParameterMenuItem;
        match: "same" | "value" | "origin";
        bindings: Readonly<Record<string, PlainMathJson>>;
      }>[];
      resultSubstitutions: readonly Readonly<{ symbol: string; expression: PlainMathJson }>[];
      menuEntry: Entry;
    }>
  | Readonly<{ ok: false; code: ReplayDiagnosticCode; message: string }>;

/**
 * Re-match every step onto the target node, in order, stopping at the first step that fails.
 * The result is a dry run: prepared commands and a report, nothing persisted.
 */
export function planSemanticReplay(input: SemanticReplayInput): SemanticReplayResult {
  try {
    return replay(input);
  } catch {
    return {
      ok: false,
      diagnostics: [{ code: "invalid-input", message: "The replay could not be planned safely." }],
    };
  }
}

function replay(input: SemanticReplayInput): SemanticReplayResult {
  if (input.steps.length === 0 || input.steps.length > MAX_REPLAY_STEPS) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "invalid-input",
          message: `A replay carries between 1 and ${MAX_REPLAY_STEPS} steps.`,
        },
      ],
    };
  }
  const operators = input.operators ?? [];
  const correspondence: Correspondence = { symbols: new Map(), order: [], ids: new Map() };
  const firstTarget = input.steps[0]?.step?.selections[0]?.target;
  if (input.focus !== undefined && firstTarget !== undefined) {
    correspondence.ids.set(firstTarget.id, input.focus.id);
  }
  let node = input.target;
  const reports: ReplayStepReport[] = [];
  const replayed: SemanticReplayedStep[] = [];
  let firstFailure: SemanticReplayReport["firstFailure"];

  for (const [position, source] of input.steps.entries()) {
    const index = position + 1;
    const sourceEdgeId = proofEdgeIdSchema.parse(source.sourceEdgeId);
    if (firstFailure !== undefined) {
      reports.push(emptyStepReport(index, sourceEdgeId, source.step, "not-attempted"));
      continue;
    }
    const step = source.step;
    if (step === undefined) {
      const diagnostic = {
        code: "step-not-replayable" as const,
        message: source.unavailable ?? "The step has no semantic plan.",
      };
      reports.push({ ...emptyStepReport(index, sourceEdgeId, undefined, "failed"), diagnostic });
      firstFailure = { index, diagnostic, repairs: [] };
      continue;
    }
    const outcome = replayStep(input, step, index, sourceEdgeId, node, correspondence, operators);
    if (!outcome.ok) {
      const diagnostic = { code: outcome.code, message: outcome.message };
      reports.push({
        ...emptyStepReport(index, sourceEdgeId, step, "failed"),
        diagnostic,
      });
      firstFailure = { index, diagnostic, repairs: outcome.repairs };
      continue;
    }
    reports.push(outcome.report);
    replayed.push({
      index,
      sourceEdgeId,
      prepared: outcome.prepared,
      preceding: outcome.preceding,
      plan: outcome.plan,
      report: outcome.report,
    });
    node = outcome.prepared.prepared.node;
  }

  const report = semanticReplayReportSchema.parse({
    targetNodeId: input.target.id,
    complete: firstFailure === undefined,
    steps: reports,
    substitutions: correspondence.order.flatMap((symbol) => {
      const expression = correspondence.symbols.get(symbol);
      return expression === undefined || isSymbol(expression, symbol)
        ? []
        : [{ symbol, expression }];
    }),
    ...(firstFailure === undefined ? {} : { firstFailure }),
    finalNodeId: node.id,
  });
  return {
    ok: true,
    report: freezeDetached(report),
    replayed: freezeDetached(replayed),
    finalNode: freezeDetached(node),
    diagnostics: [],
  };
}

function emptyStepReport(
  index: number,
  sourceEdgeId: ReplayStepReport["sourceEdgeId"],
  step: SemanticPlan | undefined,
  status: "failed" | "not-attempted",
): ReplayStepReport {
  return {
    index,
    sourceEdgeId,
    ...(step?.moveId === undefined ? {} : { moveId: step.moveId }),
    source: replayStepSource(step),
    status,
    selections: [],
    substitutions: [],
    resultSubstitutions: [],
    parameters: [],
    obligations: [],
    alternatives: [],
  };
}

type StepOutcome =
  | Readonly<{
      ok: true;
      prepared: PrepareProofCommandSuccess;
      preceding: readonly PrepareProofCommandSuccess[];
      plan: SemanticPlan;
      report: ReplayStepReport;
    }>
  | Readonly<{
      ok: false;
      code: ReplayDiagnosticCode;
      message: string;
      repairs: z.infer<typeof slotCandidatesSchema>[];
    }>;

function replayStep(
  input: SemanticReplayInput,
  step: SemanticPlan,
  index: number,
  sourceEdgeId: ReplayStepReport["sourceEdgeId"],
  node: ProofNode,
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
): StepOutcome {
  const macro =
    step.source === "move" && step.macro !== undefined
      ? input.macros?.find(({ move }) => move.id === step.moveId)
      : undefined;
  if (step.source === "move" && step.macro !== undefined && macro === undefined) {
    return {
      ok: false,
      code: "move-unavailable",
      message:
        `The macro ${step.moveId} is not approved in this session, so its application cannot be ` +
        "replayed. Approve the macro in this session, or replay a path that does not use it.",
      repairs: [],
    };
  }
  const move =
    step.source === "move" && step.macro === undefined
      ? input.moves.find(({ id }) => id === step.moveId)
      : undefined;
  if (step.source === "move" && step.macro === undefined && move === undefined) {
    return {
      ok: false,
      code: "move-unavailable",
      message: `The move ${step.moveId} is not in the approved catalog.`,
      repairs: [],
    };
  }

  // Candidate occurrences per slot across the whole snapshot, best first.
  const perSlot = new Map<string, Candidate[]>();
  for (const selection of step.selections) {
    const found = slotCandidates(node, selection, correspondence, operators);
    // An operation plan addresses whole statements: never a subterm of one.
    const wholeStatement =
      step.source === "operation" &&
      selection.occurrence.kind === "exact" &&
      selection.occurrence.path.length === 0;
    perSlot.set(
      selection.slotId,
      wholeStatement
        ? found.filter(
            ({ occurrence }) => occurrence.kind === "exact" && occurrence.path.length === 0,
          )
        : found,
    );
  }
  const overrides = new Map(
    (input.overrides ?? [])
      .filter(({ stepIndex }) => stepIndex === index)
      .map(({ slotId, candidateId }) => [slotId, candidateId]),
  );
  for (const [slotId, candidateId] of overrides) {
    const forced = perSlot.get(slotId)?.find(({ id }) => id === candidateId);
    if (forced === undefined) {
      return {
        ok: false,
        code: "invalid-override",
        message: `The override for slot ${slotId} does not name a listed candidate.`,
        repairs: listed(step, perSlot, () => true),
      };
    }
    perSlot.set(slotId, [forced]);
  }
  const usable = (slotId: string): Candidate[] =>
    (perSlot.get(slotId) ?? []).filter(
      (candidate) =>
        overrides.has(slotId) || candidate.match === "identical" || candidate.match === "renamed",
    );

  // Targets where every slot has a usable candidate, in the order of their best candidates.
  const targetKeys: string[] = [];
  const firstSlot = step.selections[0]?.slotId ?? "";
  for (const candidate of usable(firstSlot)) {
    const key = targetKey(candidate.target);
    if (targetKeys.includes(key)) continue;
    if (
      step.selections.every(({ slotId }) =>
        usable(slotId).some((item) => targetKey(item.target) === key),
      )
    ) {
      targetKeys.push(key);
    }
  }
  if (targetKeys.length === 0) {
    return {
      ok: false,
      code: "no-matching-selection",
      message: "No target has an occurrence of every recorded selection.",
      repairs: listed(step, perSlot, () => true),
    };
  }

  const failures: Extract<Attempt, { ok: false }>[] = [];
  let attempts = 0;
  let success: Extract<Attempt, { ok: true }> | undefined;
  search: for (const key of targetKeys) {
    const lists = step.selections.map(({ slotId }) => ({
      slotId,
      candidates: usable(slotId).filter((candidate) => targetKey(candidate.target) === key),
    }));
    for (const assignment of assignments(lists)) {
      if (attempts >= MAX_ATTEMPTS_PER_STEP) break search;
      attempts += 1;
      const attempt = attemptAssignment(
        input,
        step,
        move,
        macro,
        index,
        node,
        assignment,
        correspondence,
        operators,
      );
      if (attempt.ok) {
        success = attempt;
        break search;
      }
      failures.push(attempt);
    }
  }
  if (success === undefined) {
    const failure = failures[0] ?? {
      code: "no-matching-selection" as const,
      message: "No consistent assignment of the recorded selections was found.",
    };
    return {
      ok: false,
      code: failure.code,
      message: failure.message,
      repairs: listed(step, perSlot, () => true),
    };
  }

  // Record the correspondence the step established.
  const substitutions: { symbol: string; expression: PlainMathJson }[] = [];
  const bind = (bindings: Readonly<Record<string, PlainMathJson>>): void => {
    for (const [symbol, expression] of Object.entries(bindings)) {
      if (correspondence.symbols.has(symbol)) continue;
      correspondence.symbols.set(symbol, expression);
      correspondence.order.push(symbol);
      if (!isSymbol(expression, symbol)) substitutions.push({ symbol, expression });
    }
  };
  for (const { candidate } of success.chosen) {
    // A forced conflicting or shape-only occurrence establishes no correspondence.
    if (candidate.match === "identical" || candidate.match === "renamed") bind(candidate.bindings);
  }
  for (const parameter of success.parameters) bind(parameter.bindings);
  for (const [slotIndex, selection] of step.selections.entries()) {
    const chosen = success.chosen[slotIndex]?.candidate;
    if (chosen === undefined) continue;
    correspondence.ids.set(selection.target.id, chosen.target.id);
    if (selection.statement.role === "hypothesis" && chosen.statement.role === "hypothesis") {
      correspondence.ids.set(selection.statement.id, chosen.statement.id);
    }
  }
  pairIdentifiers(step.operation, success.operation, correspondence.ids);
  if (step.source === "move" && step.macro !== undefined) {
    for (const [position, recorded] of step.macro.steps.entries()) {
      pairIdentifiers(recorded.operation, success.operations[position], correspondence.ids);
    }
  }

  const prepared = success.prepared;
  const commands = [...success.preceding, prepared];
  const after = prepared.prepared.node.state;
  const addedObligations = commands.flatMap(
    ({ prepared: { event } }) => event.delta.obligations.added,
  );
  const expectedObligations = step.obligations.map((expression) =>
    mapExpression(expression, correspondence, operators),
  );
  const obligations = addedObligations.flatMap((id) => {
    const obligation = after.obligations.find((candidate) => candidate.id === id);
    if (obligation === undefined) return [];
    const expression = obligation.sequent.conclusion.expression;
    return [
      {
        id,
        expression,
        inSource: expectedObligations.some(
          (expected) =>
            expected !== undefined && alphaEquivalent(expected, expression, { operators }),
        ),
      },
    ];
  });
  const changedParameters = success.parameters.flatMap(({ recorded, item, match }) =>
    match === "same"
      ? []
      : [
          {
            parameterId: recorded.parameterId,
            match: match === "value" ? ("value" as const) : ("origin" as const),
            from: recorded.value,
            to: itemValue(item),
          },
        ],
  );
  // Exact: nothing had to be adapted beyond the correspondence earlier steps established.
  const exact =
    success.chosen.every(({ candidate }) => candidate.match === "identical") &&
    substitutions.length === 0 &&
    success.parameters.every(
      ({ match, bindings }) => match !== "origin" && Object.keys(bindings).length === 0,
    ) &&
    obligations.every(({ inSource }) => inSource) &&
    obligations.length === step.obligations.length;

  const report: ReplayStepReport = {
    index,
    sourceEdgeId,
    ...(success.moveId === undefined ? {} : { moveId: moveIdSchema.parse(success.moveId) }),
    source: replayStepSource(step),
    status: exact ? "exact" : "adapted",
    commandId: prepared.prepared.command.commandId,
    ...(commands.length < 2
      ? {}
      : { commandIds: commands.map(({ prepared: { command } }) => command.commandId) }),
    resultNodeId: prepared.prepared.node.id,
    transitionClass: composeTransitionClasses(
      commands.map(({ prepared: { edge } }) => edge.transitionClass),
    ),
    selections: success.chosen.map(({ slotId, candidate }) => ({
      slotId,
      candidate: publicCandidate(candidate),
    })),
    substitutions,
    resultSubstitutions: [...success.resultSubstitutions],
    parameters: changedParameters,
    obligations,
    alternatives: listed(
      step,
      perSlot,
      (candidate, slotId) =>
        (candidate.match === "identical" || candidate.match === "renamed") &&
        success.chosen.find((chosen) => chosen.slotId === slotId)?.candidate.id !== candidate.id,
    ),
  };

  // A macro step's later replay goes command by command: its record holds the last command's plan.
  const plan =
    step.source === "operation" || step.macro !== undefined
      ? replayedOperationPlan(step, prepared, operators)
      : replayedPlan(step, success, prepared, operators);
  if (plan === undefined) {
    return {
      ok: false,
      code: "command-rejected",
      message: "The replayed step's plan could not be recorded.",
      repairs: [],
    };
  }
  return { ok: true, prepared, preceding: success.preceding, plan, report };
}

/** The plan of a replayed operation, derived from the command it created. */
function replayedOperationPlan(
  step: SemanticPlan,
  prepared: PrepareProofCommandSuccess,
  operators: readonly OperatorDeclaration[],
): SemanticOperationStep | undefined {
  const { parent, node, edge } = prepared.prepared;
  const derived = deriveOperation({
    parent,
    child: node,
    edge,
    origin: step.source === "operation" ? step.origin : "raw-operation",
    operators,
  });
  return derived.ok ? derived.step : undefined;
}

/** Assignments to try: every slot's best candidate, then one slot varied at a time. */
function* assignments(
  lists: readonly Readonly<{ slotId: string; candidates: readonly Candidate[] }>[],
): Generator<readonly Readonly<{ slotId: string; candidate: Candidate }>[]> {
  const best = lists.map(({ slotId, candidates }) => ({ slotId, candidate: candidates[0] }));
  if (best.some(({ candidate }) => candidate === undefined)) return;
  const base = best as { slotId: string; candidate: Candidate }[];
  yield base;
  for (const [position, { candidates }] of lists.entries()) {
    for (const candidate of candidates.slice(1)) {
      yield base.map((entry, index) => (index === position ? { ...entry, candidate } : entry));
    }
  }
}

function attemptAssignment(
  input: SemanticReplayInput,
  step: SemanticPlan,
  move: MoveDefinition | undefined,
  macro: NonNullable<SemanticReplayInput["macros"]>[number] | undefined,
  index: number,
  node: ProofNode,
  chosen: readonly Readonly<{ slotId: string; candidate: Candidate }>[],
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
): Attempt {
  // Bindings from all slots must agree with each other and with the correspondence.
  const merged = new Map(correspondence.symbols);
  for (const { candidate } of chosen) {
    if (candidate.match !== "identical" && candidate.match !== "renamed") continue;
    if (!mergeInto(merged, candidate.bindings, operators)) {
      return {
        ok: false,
        code: "no-matching-selection",
        message: "The recorded selections match with inconsistent substitutions.",
      };
    }
  }
  const view: Correspondence = { ...correspondence, symbols: merged };
  const target = chosen[0]?.candidate.target;
  const entry = target === undefined ? undefined : findEntry(node, target.id);
  if (target === undefined || entry === undefined) {
    return { ok: false, code: "no-matching-selection", message: "The chosen target is missing." };
  }
  const selections: Record<string, MoveSelectionInput> = {};
  for (const { slotId, candidate } of chosen) {
    selections[slotId] = moveSelectionInput(node, candidate);
  }

  const stepCommandId = semanticReplayStepCommandId(input.commandId, index);
  const ids = input.recordIds(stepCommandId);
  const generator: MoveIdGenerator = {
    ...commandIdGenerator(stepCommandId),
    resultStateId: ids.resultStateId,
  };
  const environment = {
    operators,
    ...(input.results === undefined ? {} : { results: input.results }),
  };
  if (step.source === "operation") {
    return attemptOperation(input, step, node, chosen, view, stepCommandId, ids, generator, entry);
  }
  if (macro !== undefined && step.macro !== undefined) {
    return attemptMacro(
      input,
      step,
      macro,
      node,
      chosen,
      selections,
      view,
      merged,
      stepCommandId,
      environment,
      entry,
    );
  }
  const resultSubstitutions: { symbol: string; expression: PlainMathJson }[] = [];
  const mappedSubstitutions = (step.result?.substitutions ?? []).map(({ symbol, expression }) => {
    const mapped = mapExpression(expression, view, operators) ?? expression;
    if (!alphaEquivalent(mapped, expression, { operators })) {
      resultSubstitutions.push({ symbol, expression: mapped });
    }
    return { symbol, expression: mapped };
  });

  const choices: Record<string, string> = {};
  const parameters: Extract<Attempt, { ok: true }>["parameters"][number][] = [];
  let materialized: MaterializationResult | undefined;
  for (let round = 0; round <= step.parameters.length + 1; round += 1) {
    materialized =
      step.source === "result" && step.result !== undefined
        ? materializeResultApplication(
            {
              state: node.state,
              resultId: step.result.resultId,
              direction: step.result.direction,
              target,
              substitutions: mappedSubstitutions,
              ...(selections.occurrence === undefined ? {} : { occurrence: selections.occurrence }),
              menuChoices: choices,
            },
            environment,
            generator,
          )
        : materializeMoveOperation({
            state: node.state,
            move: move as MoveDefinition,
            selections,
            menuChoices: choices,
            idGenerator: generator,
            env: environment,
          });
    if (materialized.ok || materialized.diagnostics[0].code !== "requires-input") break;
    const unavailable = chooseParameters(
      step,
      materialized.missingParameters,
      materialized.menus,
      view,
      merged,
      choices,
      parameters,
      operators,
    );
    if (unavailable !== undefined) return unavailable;
  }
  if (materialized === undefined || !materialized.ok) {
    return {
      ok: false,
      code: "materialization-failed",
      message: materialized?.diagnostics[0]?.message ?? "The step could not be materialized again.",
    };
  }
  const operation = materialized.operation;
  const moveId =
    step.source === "move"
      ? step.moveId
      : input.moves.find(
          (definition) =>
            RESULT_APPLICATION_MOVE_IDS.includes(definition.id) &&
            definition.implementation.operationKind === operation.kind,
        )?.id;
  if (moveId === undefined) {
    return {
      ok: false,
      code: "move-unavailable",
      message: "No approved result-application move applies the replayed operation.",
    };
  }
  const authoredMoves = input.moves.filter(({ id }) => id.startsWith("authored:"));
  const prepared = prepareProofCommand(
    node,
    {
      commandId: stepCommandId,
      kind: "apply-kernel-operation",
      actor: input.actor,
      parentNodeId: node.id,
      resultNodeId: ids.resultNodeId,
      edgeId: ids.edgeId,
      eventId: ids.eventId,
      moveId,
      operation,
    },
    {
      trustedActor: input.actor,
      operators,
      ...(input.results === undefined ? {} : { results: input.results }),
      ...(authoredMoves.length === 0 ? {} : { moves: authoredMoves }),
    },
  );
  if (!prepared.ok) {
    return {
      ok: false,
      code: "command-rejected",
      message: prepared.diagnostics[0].message,
    };
  }
  return {
    ok: true,
    prepared,
    preceding: [],
    operation,
    operations: [operation],
    moveId,
    chosen,
    parameters,
    resultSubstitutions,
    menuEntry: entry,
  };
}

/** Choose, from regenerated menus, the items corresponding to the recorded choices. */
function chooseParameters(
  step: SemanticStep,
  missing: readonly string[],
  menus: readonly ParameterMenu[],
  view: Correspondence,
  merged: Map<string, PlainMathJson>,
  choices: Record<string, string>,
  parameters: Extract<Attempt, { ok: true }>["parameters"][number][],
  operators: readonly OperatorDeclaration[],
): Extract<Attempt, { ok: false }> | undefined {
  for (const parameterId of missing) {
    const recorded = step.parameters.find((parameter) => parameter.parameterId === parameterId);
    const menu = menus.find((candidate) => candidate.parameterId === parameterId);
    const picked =
      recorded === undefined || menu === undefined
        ? undefined
        : pickItem(menu, recorded, view, operators);
    if (recorded === undefined || picked === undefined) {
      return {
        ok: false,
        code: "parameter-unavailable",
        message:
          recorded === undefined
            ? `The replayed move asks for ${parameterId}, which the step did not choose.`
            : `No item of the ${parameterId} menu corresponds to the recorded choice.`,
      };
    }
    choices[parameterId] = picked.item.id;
    parameters.push({ recorded, ...picked });
    mergeInto(merged, picked.bindings, operators);
  }
  return undefined;
}

type MacroSource = NonNullable<SemanticReplayInput["macros"]>[number];

/**
 * Apply an approved macro again as one replay step: its template runs on the node from the
 * re-matched first-step selections, and every step becomes an ordinary validated command. The
 * last command takes the step's command ID; earlier ones are `<step>:macro:<i>`.
 */
function attemptMacro(
  input: SemanticReplayInput,
  step: SemanticStep,
  macro: MacroSource,
  node: ProofNode,
  chosen: readonly Readonly<{ slotId: string; candidate: Candidate }>[],
  selections: Readonly<Record<string, MoveSelectionInput>>,
  view: Correspondence,
  merged: Map<string, PlainMathJson>,
  stepCommandId: string,
  environment: Readonly<{
    operators: readonly OperatorDeclaration[];
    results?: readonly KernelResult[];
  }>,
  entry: Entry,
): Attempt {
  const operators = environment.operators;
  const choices: Record<string, string> = {};
  const parameters: Extract<Attempt, { ok: true }>["parameters"][number][] = [];
  let run: ReturnType<typeof runMovePlan> | undefined;
  for (let round = 0; round <= step.parameters.length + 1; round += 1) {
    run = runMovePlan(
      macro.template,
      node.state,
      selections as Parameters<typeof runMovePlan>[2],
      choices,
      environment,
      stepCommandId,
    );
    if (run.ok || run.diagnostic.code !== "requires-input") break;
    const unavailable = chooseParameters(
      step,
      run.diagnostic.missingParameters ?? [],
      run.diagnostic.menus ?? [],
      view,
      merged,
      choices,
      parameters,
      operators,
    );
    if (unavailable !== undefined) return unavailable;
  }
  if (run === undefined || !run.ok) {
    const total = macro.template.plan.steps.length;
    return {
      ok: false,
      code: "materialization-failed",
      message:
        run === undefined
          ? "The macro could not be applied again."
          : `Macro step ${run.diagnostic.stepIndex + 1} of ${total} could not be applied again: ${run.diagnostic.message}`,
    };
  }
  const count = run.steps.length;
  const authoredMoves = input.moves.filter(({ id }) => id.startsWith("authored:"));
  const commands: PrepareProofCommandSuccess[] = [];
  let parent = node;
  for (const [position, applied] of run.steps.entries()) {
    const commandId =
      position === count - 1 ? stepCommandId : `${stepCommandId}:macro:${position + 1}`;
    const ids = input.recordIds(commandId);
    const prepared = prepareProofCommand(
      parent,
      {
        commandId,
        kind: "apply-kernel-operation",
        actor: input.actor,
        parentNodeId: parent.id,
        resultNodeId: ids.resultNodeId,
        edgeId: ids.edgeId,
        eventId: ids.eventId,
        moveId: applied.moveId,
        operation: applied.operation,
      },
      {
        trustedActor: input.actor,
        operators,
        ...(input.results === undefined ? {} : { results: input.results }),
        ...(authoredMoves.length === 0 ? {} : { moves: authoredMoves }),
      },
    );
    if (!prepared.ok) {
      return {
        ok: false,
        code: "command-rejected",
        message: `Macro step ${position + 1} of ${count} was rejected: ${prepared.diagnostics[0].message}`,
      };
    }
    commands.push(prepared);
    parent = prepared.prepared.node;
  }
  const last = commands.at(-1);
  const first = run.operations[0];
  if (last === undefined || first === undefined) {
    return { ok: false, code: "materialization-failed", message: "The macro produced no steps." };
  }
  return {
    ok: true,
    prepared: last,
    preceding: commands.slice(0, -1),
    operation: first,
    operations: run.operations,
    moveId: step.moveId,
    chosen,
    parameters,
    resultSubstitutions: [],
    menuEntry: entry,
  };
}

/**
 * Rebuild a stored operation on the target: the target, statements and occurrence come from the
 * re-matched selections, mathematics through the symbol correspondence, identifiers that existed
 * through the identity correspondence, and every generated identifier afresh.
 */
function attemptOperation(
  input: SemanticReplayInput,
  step: SemanticOperationStep,
  node: ProofNode,
  chosen: readonly Readonly<{ slotId: string; candidate: Candidate }>[],
  view: Correspondence,
  stepCommandId: string,
  ids: ReturnType<SemanticReplayRecordIds>,
  generator: MoveIdGenerator,
  entry: Entry,
): Attempt {
  const operators = input.operators ?? [];
  const anchor = chosen[0]?.candidate;
  if (anchor === undefined) {
    return { ok: false, code: "no-matching-selection", message: "The chosen target is missing." };
  }
  const hypotheses = new Map<string, string>();
  for (const [position, recorded] of step.selections.entries()) {
    const candidate = chosen[position]?.candidate;
    if (recorded.statement.role === "hypothesis" && candidate?.statement.role === "hypothesis") {
      hypotheses.set(recorded.statement.id, candidate.statement.id);
    }
  }
  const referenced = new Set(step.referenced);
  const present = stateStrings(node.state);
  const generatedIds = new Map<string, string>();
  const counters = new Map<string, number>();
  let problem: string | undefined;

  const resolve = (id: string, key: string): string => {
    const mapped = hypotheses.get(id);
    if (mapped !== undefined) return mapped;
    if (referenced.has(id)) {
      const carried = view.ids.get(id);
      if (carried !== undefined && present.has(carried)) return carried;
      if (present.has(id)) return id;
      problem ??= `The operation names ${id}, which has no counterpart in the target.`;
      return id;
    }
    const known = generatedIds.get(id);
    if (known !== undefined) return known;
    const position = (counters.get(key) ?? 0) + 1;
    counters.set(key, position);
    const fresh = /ssumption/.test(key)
      ? generator.assumptionId(key, position)
      : generator.statementId(key, position);
    generatedIds.set(id, fresh);
    return fresh;
  };
  const mapMath = (value: unknown): unknown => {
    const mapped = plainMathJsonSchema.safeParse(value);
    const expression = mapped.success ? mapExpression(mapped.data, view, operators) : undefined;
    if (expression === undefined) {
      problem ??= "An expression of the operation could not be mapped onto the target.";
      return value;
    }
    return expression;
  };
  const walk = (value: unknown, key: string): unknown => {
    if (EXPRESSION_KEYS.has(key)) return mapMath(value);
    if (key === "instantiation" && isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([symbol, item]) => [symbol, mapMath(item)]),
      );
    }
    if (typeof value === "string") return isIdentifierKey(key) ? resolve(value, key) : value;
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([field, item]) => [field, walk(item, field)]),
      );
    }
    return value;
  };

  const recorded = step.operation as unknown as Readonly<Record<string, unknown>>;
  const rewrite = REWRITE_OPERATIONS.has(step.operation.kind);
  const rebuilt: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(recorded)) {
    if (key === "expectedStateId") rebuilt[key] = node.state.id;
    else if (key === "resultStateId") rebuilt[key] = ids.resultStateId;
    else if (key === "target") rebuilt[key] = { kind: anchor.target.kind, id: anchor.target.id };
    else if (rewrite && key === "statement") {
      rebuilt[key] =
        anchor.statement.role === "conclusion"
          ? { kind: "conclusion" }
          : { kind: "hypothesis", id: anchor.statement.id };
    } else if (rewrite && key === "path") {
      rebuilt[key] =
        anchor.occurrence.kind === "exact"
          ? anchor.occurrence.path
          : anchor.occurrence.containerPath;
    } else if (rewrite && key === "lens") {
      if (anchor.occurrence.kind === "associative") {
        rebuilt[key] = {
          startOperand: anchor.occurrence.startOperand,
          endOperand: anchor.occurrence.endOperand,
        };
      }
    } else rebuilt[key] = walk(value, key);
  }
  if (problem !== undefined) {
    return { ok: false, code: "materialization-failed", message: problem };
  }
  const parsed = kernelOperationSchema.safeParse(rebuilt);
  if (!parsed.success) {
    return {
      ok: false,
      code: "materialization-failed",
      message: "The operation could not be rebuilt on the target.",
    };
  }
  const operation = parsed.data;
  const authoredMoves = input.moves.filter(({ id }) => id.startsWith("authored:"));
  const prepared = prepareProofCommand(
    node,
    {
      commandId: stepCommandId,
      kind: "apply-kernel-operation",
      actor: input.actor,
      parentNodeId: node.id,
      resultNodeId: ids.resultNodeId,
      edgeId: ids.edgeId,
      eventId: ids.eventId,
      ...(step.moveId === undefined ? {} : { moveId: step.moveId }),
      operation,
    },
    {
      trustedActor: input.actor,
      operators,
      ...(input.results === undefined ? {} : { results: input.results }),
      ...(authoredMoves.length === 0 ? {} : { moves: authoredMoves }),
    },
  );
  if (!prepared.ok) {
    return { ok: false, code: "command-rejected", message: prepared.diagnostics[0].message };
  }
  return {
    ok: true,
    prepared,
    preceding: [],
    operation,
    operations: [operation],
    moveId: step.moveId,
    chosen,
    parameters: [],
    resultSubstitutions: [],
    menuEntry: entry,
  };
}

/** The adapted plan, in the replayed branch's terms. */
function replayedPlan(
  step: SemanticStep,
  success: Extract<Attempt, { ok: true }>,
  prepared: PrepareProofCommandSuccess,
  operators: readonly OperatorDeclaration[],
): SemanticStep | undefined {
  const entry = success.menuEntry;
  const after = prepared.prepared.node.state;
  const candidate = {
    moveId: success.moveId,
    source: step.source,
    ...(step.result === undefined
      ? {}
      : {
          result: {
            ...step.result,
            substitutions: step.result.substitutions.map((substitution) => ({
              symbol: substitution.symbol,
              expression:
                success.resultSubstitutions.find(({ symbol }) => symbol === substitution.symbol)
                  ?.expression ?? substitution.expression,
            })),
          },
        }),
    selections: success.chosen.map(({ slotId, candidate: chosen }) => ({
      slotId,
      target: chosen.target,
      statement: chosen.statement,
      occurrence: chosen.occurrence,
      fragment: chosen.fragment,
      variables: fragmentVariables(chosen.fragment, entry, operators),
    })),
    parameters: success.parameters.map(({ recorded, item }) => ({
      parameterId: recorded.parameterId,
      origin: item.origin,
      value: itemValue(item),
      variables: valueVariables(itemValue(item), entry, operators),
    })),
    operation: success.operation,
    transitionClass: prepared.prepared.edge.transitionClass,
    obligations: prepared.prepared.event.delta.obligations.added.flatMap((id) => {
      const obligation = after.obligations.find((candidate) => candidate.id === id);
      return obligation === undefined ? [] : [obligation.sequent.conclusion.expression];
    }),
  };
  const parsed = semanticStepSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

// --------------------------------------------------------------------------------------------
// Candidate occurrences
// --------------------------------------------------------------------------------------------

/** Every occurrence of the recorded fragment's shape in the snapshot, ranked best first. */
function slotCandidates(
  node: ProofNode,
  selection: SemanticSelection,
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
): Candidate[] {
  const candidates: Candidate[] = [];
  const entries: [ReplayTarget["kind"], Entry][] = [
    ...node.state.goals.map((entry) => ["goal", entry] as [ReplayTarget["kind"], Entry]),
    ...node.state.obligations.map(
      (entry) => ["obligation", entry as Entry] as [ReplayTarget["kind"], Entry],
    ),
  ];
  const mappedTarget = correspondence.ids.get(selection.target.id);
  const mappedHypothesis =
    selection.statement.role === "hypothesis"
      ? correspondence.ids.get(selection.statement.id)
      : undefined;
  const names = selection.variables.map(({ symbol }) => symbol);
  let order = 0;
  for (const [targetIndex, [kind, entry]] of entries.entries()) {
    const target: ReplayTarget = { kind, id: entry.id };
    const targetRank =
      (mappedTarget === entry.id
        ? 0
        : mappedTarget === undefined && selection.target.id === entry.id
          ? 1
          : 2) + (kind === selection.target.kind ? 0 : 1);
    const statements: [ReplayStatement, PlainMathJson][] = [
      [{ role: "conclusion" }, entry.sequent.conclusion.expression],
      ...entry.sequent.context.hypotheses.map(
        (hypothesis) =>
          [{ role: "hypothesis", id: hypothesis.id }, hypothesis.statement.expression] as [
            ReplayStatement,
            PlainMathJson,
          ],
      ),
    ];
    for (const [statement, expression] of statements) {
      const statementRank =
        selection.statement.role === "conclusion"
          ? statement.role === "conclusion"
            ? 0
            : 3
          : statement.role === "conclusion"
            ? 3
            : statement.id === (mappedHypothesis ?? selection.statement.id)
              ? mappedHypothesis === undefined
                ? 1
                : 0
              : 2;
      for (const found of occurrencesOf(expression, selection, operators)) {
        order += 1;
        const matched = matchExpressionPattern(selection.fragment, found.subject, names, {
          operators,
        });
        const bindings =
          matched !== undefined && bindingsFitSorts(matched, selection.variables, entry, operators)
            ? matched
            : undefined;
        const match: ReplayMatch | undefined =
          bindings !== undefined
            ? classify(bindings, correspondence, operators)
            : sameShape(selection.fragment, found.subject)
              ? "shape"
              : undefined;
        if (match === undefined) continue;
        candidates.push({
          id: candidateId(target, statement, found.occurrence),
          target,
          statement,
          occurrence: found.occurrence,
          fragment: found.subject,
          match,
          bindings: bindings ?? {},
          rank: [
            matchRank(match),
            targetRank,
            statementRank,
            sameOccurrence(found.occurrence, selection.occurrence) ? 0 : 1,
            targetIndex,
            order,
          ],
        });
      }
    }
  }
  return candidates.sort(compareRanks);
}

function classify(
  bindings: Readonly<Record<string, PlainMathJson>>,
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
): ReplayMatch {
  const images = new Map<string, string>();
  for (const [symbol, expression] of correspondence.symbols) {
    const name = symbolName(expression);
    if (name !== undefined) images.set(name, symbol);
  }
  let identical = true;
  const local = new Map<string, string>();
  for (const [symbol, expression] of Object.entries(bindings)) {
    const known = correspondence.symbols.get(symbol);
    if (known !== undefined) {
      if (!alphaEquivalent(known, expression, { operators })) return "conflict";
    } else {
      // A different source symbol already corresponds to this image: not a renaming.
      const name = symbolName(expression);
      const owner = name === undefined ? undefined : (images.get(name) ?? local.get(name));
      if (owner !== undefined && owner !== symbol) return "conflict";
      if (name !== undefined) local.set(name, symbol);
    }
    if (known === undefined && !isSymbol(expression, symbol)) identical = false;
  }
  return identical ? "identical" : "renamed";
}

function matchRank(match: ReplayMatch): number {
  return match === "identical" ? 0 : match === "renamed" ? 1 : match === "conflict" ? 2 : 3;
}

function compareRanks(left: Candidate, right: Candidate): number {
  for (let index = 0; index < Math.max(left.rank.length, right.rank.length); index += 1) {
    const difference = (left.rank[index] ?? 0) - (right.rank[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

type Found = Readonly<{ occurrence: ReplayOccurrence; subject: PlainMathJson }>;

/** Occurrences of the selection's kind in one statement, in preorder. */
function occurrencesOf(
  expression: PlainMathJson,
  selection: SemanticSelection,
  operators: readonly OperatorDeclaration[],
): Found[] {
  const found: Found[] = [];
  const recorded = selection.occurrence;
  const width = recorded.kind === "associative" ? recorded.endOperand - recorded.startOperand : 0;
  const head = functionParts(selection.fragment)?.operator;
  const visit = (node: PlainMathJson, path: readonly number[]): void => {
    const parts = functionParts(node);
    if (recorded.kind === "exact") {
      found.push({ occurrence: { kind: "exact", path: [...path] }, subject: node });
    } else if (parts !== undefined && parts.operator === head && parts.operands.length > width) {
      for (let start = 0; start + width <= parts.operands.length; start += 1) {
        found.push({
          occurrence: {
            kind: "associative",
            containerPath: [...path],
            startOperand: start,
            endOperand: start + width,
          },
          subject: parts.rebuild(parts.operands.slice(start, start + width)),
        });
      }
    }
    if (parts === undefined || found.length > 4096) return;
    const shape = binderShape(parts.operator, parts.operands.length, operators);
    parts.operands.forEach((operand, index) => {
      if (shape?.boundOperands.includes(index)) return;
      visit(operand, [...path, index]);
    });
  };
  visit(expression, []);
  return found;
}

function sameShape(left: PlainMathJson, right: PlainMathJson): boolean {
  const leftParts = functionParts(left);
  const rightParts = functionParts(right);
  if (leftParts === undefined || rightParts === undefined) return false;
  return (
    leftParts.operator === rightParts.operator &&
    leftParts.operands.length === rightParts.operands.length
  );
}

function sameOccurrence(left: ReplayOccurrence, right: ReplayOccurrence): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function candidateId(
  target: ReplayTarget,
  statement: ReplayStatement,
  occurrence: ReplayOccurrence,
): string {
  const where = statement.role === "conclusion" ? "conclusion" : `hypothesis:${statement.id}`;
  const at =
    occurrence.kind === "exact"
      ? `exact:${occurrence.path.join(".")}`
      : `associative:${occurrence.containerPath.join(".")}[${occurrence.startOperand},${occurrence.endOperand}]`;
  return `${target.kind}:${target.id}/${where}/${at}`;
}

function publicCandidate(candidate: Candidate): ReplayCandidate {
  return {
    id: candidate.id,
    target: candidate.target,
    statement: candidate.statement,
    occurrence: candidate.occurrence,
    fragment: candidate.fragment,
    match: candidate.match,
  };
}

function listed(
  step: SemanticPlan,
  perSlot: ReadonlyMap<string, readonly Candidate[]>,
  keep: (candidate: Candidate, slotId: string) => boolean,
): z.infer<typeof slotCandidatesSchema>[] {
  return step.selections.flatMap(({ slotId }) => {
    const candidates = (perSlot.get(slotId) ?? [])
      .filter((candidate) => keep(candidate, slotId))
      .slice(0, MAX_LISTED_CANDIDATES)
      .map(publicCandidate);
    return candidates.length === 0 ? [] : [{ slotId, candidates }];
  });
}

function moveSelectionInput(node: ProofNode, candidate: Candidate): MoveSelectionInput {
  const anchor = {
    stateId: node.state.id,
    target: candidate.target,
    statement:
      candidate.statement.role === "conclusion"
        ? ({ kind: "conclusion" } as const)
        : ({ kind: "hypothesis", id: candidate.statement.id } as const),
  };
  return candidate.occurrence.kind === "exact"
    ? { kind: "exact", anchor, path: candidate.occurrence.path }
    : {
        kind: "associative",
        anchor,
        containerPath: candidate.occurrence.containerPath,
        startOperand: candidate.occurrence.startOperand,
        endOperand: candidate.occurrence.endOperand,
      };
}

// --------------------------------------------------------------------------------------------
// Parameters
// --------------------------------------------------------------------------------------------

/**
 * The item of a regenerated menu for a recorded choice: the item whose value is the recorded
 * value under the correspondence, else the item with the corresponding origin, else an item whose
 * value is an instance of the recorded value's pattern.
 */
function pickItem(
  menu: ParameterMenu,
  recorded: SemanticParameter,
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
):
  | Readonly<{
      item: ParameterMenuItem;
      match: "same" | "value" | "origin";
      bindings: Readonly<Record<string, PlainMathJson>>;
    }>
  | undefined {
  const expected = mapValue(recorded.value, correspondence, operators);
  if (expected !== undefined) {
    const same = menu.items.find((item) => valuesEqual(itemValue(item), expected, operators));
    if (same !== undefined) {
      return {
        item: same,
        match: valuesEqual(expected, recorded.value, operators) ? "same" : "value",
        bindings: {},
      };
    }
  }
  const byOrigin = menu.items.find((item) =>
    originCorresponds(recorded.origin, item.origin, correspondence),
  );
  if (byOrigin !== undefined) {
    return {
      item: byOrigin,
      match: "origin",
      bindings: valueBindings(recorded, byOrigin, operators),
    };
  }
  for (const item of menu.items) {
    const bindings = valueBindings(recorded, item, operators);
    if (
      Object.keys(bindings).length > 0 &&
      classify(bindings, correspondence, operators) === "renamed"
    ) {
      return { item, match: "value", bindings };
    }
  }
  return undefined;
}

function valueBindings(
  recorded: SemanticParameter,
  item: ParameterMenuItem,
  operators: readonly OperatorDeclaration[],
): Readonly<Record<string, PlainMathJson>> {
  const from = recorded.value;
  const to = item.value;
  if ((from.kind !== "term" && from.kind !== "proposition") || from.kind !== to.kind) return {};
  const names = recorded.variables.map(({ symbol }) => symbol);
  return matchExpressionPattern(from.expression, to.expression, names, { operators }) ?? {};
}

function originCorresponds(
  recorded: SemanticParameter["origin"],
  candidate: ParameterMenuItem["origin"],
  correspondence: Correspondence,
): boolean {
  const mapped = (id: string): string => correspondence.ids.get(id) ?? id;
  switch (recorded.kind) {
    case "selection":
      return candidate.kind === "selection" && candidate.slotId === recorded.slotId;
    case "conclusion":
      return candidate.kind === "conclusion";
    case "hypothesis":
      return (
        candidate.kind === "hypothesis" && candidate.hypothesisId === mapped(recorded.hypothesisId)
      );
    case "subterm-of": {
      if (candidate.kind !== "subterm-of") return false;
      const statementMatches =
        recorded.statement.kind === "conclusion"
          ? candidate.statement.kind === "conclusion"
          : candidate.statement.kind === "hypothesis" &&
            candidate.statement.id === mapped(recorded.statement.id);
      return statementMatches && JSON.stringify(candidate.path) === JSON.stringify(recorded.path);
    }
    case "result":
      return candidate.kind === "result" && candidate.resultId === recorded.resultId;
    case "assumption":
      return (
        candidate.kind === "assumption" && candidate.assumptionId === mapped(recorded.assumptionId)
      );
    default:
      return false;
  }
}

type MenuValueRecord = SemanticParameter["value"];

/** A menu item's value as a recorded value (the same JSON; only the brands differ). */
function itemValue(item: ParameterMenuItem): MenuValueRecord {
  return item.value as unknown as MenuValueRecord;
}

function mapValue(
  value: MenuValueRecord,
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
): MenuValueRecord | undefined {
  const mapped = (id: string): string => correspondence.ids.get(id) ?? id;
  switch (value.kind) {
    case "term":
    case "proposition": {
      const expression = mapExpression(value.expression, correspondence, operators);
      return expression === undefined ? undefined : { kind: value.kind, expression };
    }
    case "rewrite-source": {
      if (value.source.kind === "hypothesis") {
        return {
          kind: "rewrite-source",
          source: {
            kind: "hypothesis",
            hypothesisId: statementIdSchema.parse(mapped(value.source.hypothesisId)),
          },
        };
      }
      const instantiation: Record<string, PlainMathJson> = {};
      for (const [symbol, expression] of Object.entries(value.source.instantiation)) {
        const replaced = mapExpression(expression, correspondence, operators);
        if (replaced === undefined) return undefined;
        instantiation[symbol] = replaced;
      }
      return { kind: "rewrite-source", source: { ...value.source, instantiation } };
    }
    case "assumption":
      return {
        kind: "assumption",
        assumptionId: stableIdentifierSchema.parse(mapped(value.assumptionId)),
      };
    default:
      return value;
  }
}

function valuesEqual(
  left: MenuValueRecord,
  right: MenuValueRecord,
  operators: readonly OperatorDeclaration[],
): boolean {
  if (left.kind !== right.kind) return false;
  if (
    (left.kind === "term" || left.kind === "proposition") &&
    (right.kind === "term" || right.kind === "proposition")
  ) {
    return alphaEquivalent(left.expression, right.expression, { operators });
  }
  if (left.kind === "rewrite-source" && right.kind === "rewrite-source") {
    if (left.source.kind === "result" && right.source.kind === "result") {
      const leftEntries = Object.entries(left.source.instantiation);
      return (
        left.source.resultId === right.source.resultId &&
        leftEntries.length === Object.keys(right.source.instantiation).length &&
        leftEntries.every(([symbol, expression]) => {
          const other = (right.source as { instantiation: Record<string, PlainMathJson> })
            .instantiation[symbol];
          return other !== undefined && alphaEquivalent(expression, other, { operators });
        })
      );
    }
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

// --------------------------------------------------------------------------------------------
// Correspondence helpers
// --------------------------------------------------------------------------------------------

/** Apply the symbol correspondence to a source expression (capture-avoiding). */
function mapExpression(
  expression: PlainMathJson,
  correspondence: Correspondence,
  operators: readonly OperatorDeclaration[],
): PlainMathJson | undefined {
  const substitutions = [...correspondence.symbols].flatMap(([symbol, replacement]) =>
    isSymbol(replacement, symbol) ? [] : [{ symbol, replacement }],
  );
  if (substitutions.length === 0) return expression;
  const substituted = substituteMathJson(expression, substitutions, { operators });
  return substituted.ok ? substituted.expression : undefined;
}

function mergeInto(
  symbols: Map<string, PlainMathJson>,
  bindings: Readonly<Record<string, PlainMathJson>>,
  operators: readonly OperatorDeclaration[],
): boolean {
  const entries = Object.entries(bindings);
  const consistent = entries.every(([symbol, expression]) => {
    const known = symbols.get(symbol);
    return known === undefined || alphaEquivalent(known, expression, { operators });
  });
  if (consistent) entries.forEach(([symbol, expression]) => symbols.set(symbol, expression));
  return consistent;
}

const STATE_ID_KEYS = new Set(["expectedStateId", "resultStateId"]);

/**
 * Pair identifiers position by position between the recorded and the replayed operation:
 * generated statement and assumption IDs, hypotheses and targets.
 */
function pairIdentifiers(
  recorded: unknown,
  replayed: unknown,
  ids: Map<string, string>,
  key = "",
): void {
  if (typeof recorded === "string" && typeof replayed === "string") {
    if ((key === "id" || /Ids?$/.test(key)) && !STATE_ID_KEYS.has(key) && !ids.has(recorded)) {
      ids.set(recorded, replayed);
    }
    return;
  }
  if (Array.isArray(recorded) && Array.isArray(replayed)) {
    if (recorded.length !== replayed.length) return;
    recorded.forEach((value, index) => pairIdentifiers(value, replayed[index], ids, key));
    return;
  }
  if (isRecord(recorded) && isRecord(replayed)) {
    for (const [field, value] of Object.entries(recorded)) {
      if (
        field === "instantiation" ||
        field === "proposition" ||
        field === "term" ||
        field === "witness"
      ) {
        continue;
      }
      pairIdentifiers(value, replayed[field], ids, field);
    }
  }
}

function fragmentVariables(
  fragment: PlainMathJson,
  entry: Entry | undefined,
  operators: readonly OperatorDeclaration[],
): ReplayVariable[] {
  const declarations = entry?.sequent.context.declarations ?? [];
  return freeSymbolNames(fragment, { operators }).flatMap((symbol) => {
    const declaration = declarations.find((candidate) => candidate.symbol === symbol);
    return declaration === undefined ? [] : [{ symbol, sort: declaration.sort }];
  });
}

/**
 * Whether each binding can stand for its variable in the candidate's context: a declared symbol
 * must have the variable's sort, and a proposition variable needs a proposition. Other compound
 * terms are left to the kernel, which checks every replayed operation.
 */
function bindingsFitSorts(
  bindings: Readonly<Record<string, PlainMathJson>>,
  variables: readonly ReplayVariable[],
  entry: Entry,
  operators: readonly OperatorDeclaration[],
): boolean {
  const declarations = entry.sequent.context.declarations;
  return Object.entries(bindings).every(([symbol, expression]) => {
    const variable = variables.find((candidate) => candidate.symbol === symbol);
    if (variable === undefined) return true;
    const name = symbolName(expression);
    const declaration =
      name === undefined ? undefined : declarations.find((candidate) => candidate.symbol === name);
    if (declaration !== undefined) return sortEquals(declaration.sort, variable.sort);
    if (variable.sort.kind === "proposition") {
      return parseStatementView(expression, { declarations, operators }) !== undefined;
    }
    return name === undefined;
  });
}

function valueVariables(
  value: MenuValueRecord,
  entry: Entry | undefined,
  operators: readonly OperatorDeclaration[],
): ReplayVariable[] {
  return value.kind === "term" || value.kind === "proposition"
    ? fragmentVariables(value.expression, entry, operators)
    : [];
}

function findEntry(node: ProofNode, id: string): Entry | undefined {
  return (
    node.state.goals.find((goal) => goal.id === id) ??
    (node.state.obligations.find((obligation) => obligation.id === id) as Entry | undefined)
  );
}

function targetKey(target: ReplayTarget): string {
  return `${target.kind}\u0000${target.id}`;
}

type Parts = Readonly<{
  operator: string;
  operands: readonly PlainMathJson[];
  rebuild: (operands: readonly PlainMathJson[]) => PlainMathJson;
}>;

function functionParts(expression: PlainMathJson): Parts | undefined {
  if (Array.isArray(expression)) {
    const operator = expression[0];
    return typeof operator === "string"
      ? {
          operator,
          operands: expression.slice(1) as readonly PlainMathJson[],
          rebuild: (operands) => [operator, ...operands] as PlainMathJson,
        }
      : undefined;
  }
  if (typeof expression !== "object" || expression === null || !("fn" in expression)) {
    return undefined;
  }
  const operator = expression.fn[0];
  return typeof operator === "string"
    ? {
        operator,
        operands: expression.fn.slice(1) as readonly PlainMathJson[],
        rebuild: (operands) => ({ ...expression, fn: [operator, ...operands] }) as PlainMathJson,
      }
    : undefined;
}

function symbolName(expression: PlainMathJson): string | undefined {
  if (typeof expression === "string") return expression;
  return typeof expression === "object" &&
    expression !== null &&
    !Array.isArray(expression) &&
    "sym" in expression &&
    typeof expression.sym === "string"
    ? expression.sym
    : undefined;
}

function isSymbol(expression: PlainMathJson, symbol: string): boolean {
  return symbolName(expression) === symbol;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveFailure(message: string): SemanticStepDerivationResult {
  return { ok: false, diagnostics: [{ code: "step-not-replayable", message }] };
}

function freezeDetached<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}
