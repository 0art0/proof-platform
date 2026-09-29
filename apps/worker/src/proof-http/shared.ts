/**
 * Flows shared by the resource routes and the command envelope (roadmap N25): the same
 * repository calls run for a web request and an agent command, so neither path owns logic the
 * other lacks. Each flow returns a discriminated result; rendering stays with the caller.
 */
import {
  stableIdentifierSchema,
  suggestionIdSchema,
  transitionClassSchema,
  type displayedSuggestionSetSchema,
  type suggestionSetIdSchema,
  type Actor,
  type DisplayedSuggestionSet,
  type MovePreview,
  type ProofNode,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { createRetrievalIndex, type RetrievalIndex } from "@proof/retrieval";
import { z } from "zod";
import type { DefinitionCatalog } from "../approved-catalog";
import { executeTryResultCommand } from "../inquiry-methods";
import type { LibraryStore } from "../library-repository";
import {
  derivedMoveRecordIds,
  executeProofCommand,
  loadCurrentProofSession,
  materializeMoveChoice,
  recordDisplayedSuggestionSet,
  recordMovePreview,
  type ExecuteProofCommandResult,
  type moveChoiceSchema,
  type MoveRequiresInput,
  type ProofSession,
  type ProofStore,
  type RepositoryFailure,
} from "../proof-repository";

export type ServiceContext = Readonly<{
  store: ProofStore;
  definitions: DefinitionCatalog;
  now: (() => Date) | undefined;
  /** The library store; library commands are unavailable without it. */
  library: LibraryStore | undefined;
}>;

const operandPathSchema = z.array(z.number().int().nonnegative());
const displayRangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([start, end]) => end > start, "A display range must be nonempty and ordered.");
const statementAnchorSchema = z
  .object({
    stateId: stableIdentifierSchema,
    target: z.object({ kind: z.enum(["goal", "obligation"]), id: stableIdentifierSchema }).strict(),
    statement: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("conclusion") }).strict(),
      z.object({ kind: z.literal("hypothesis"), id: stableIdentifierSchema }).strict(),
    ]),
  })
  .strict();

export const proofHttpSelectionDescriptorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exact"),
      anchor: statementAnchorSchema,
      path: operandPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("associative"),
      anchor: statementAnchorSchema,
      containerPath: operandPathSchema,
      startOperand: z.number().int().nonnegative(),
      endOperand: z.number().int().nonnegative(),
      displayRange: displayRangeSchema.optional(),
    })
    .strict()
    .refine(
      ({ startOperand, endOperand }) => endOperand - startOperand >= 2,
      "An associative range must contain at least two operands.",
    ),
]);
export type ProofHttpSelectionDescriptor = z.infer<typeof proofHttpSelectionDescriptorSchema>;

export const proofHttpTransitionClassificationSchema = z
  .object({ suggestionId: suggestionIdSchema, transitionClass: transitionClassSchema })
  .strict();

// ---------------------------------------------------------------------------------------------
// Failure statuses
// ---------------------------------------------------------------------------------------------

const NOT_FOUND = new Set([
  "session-not-found",
  "suggestion-set-not-found",
  "preview-not-found",
  "current-node-not-found",
]);
const CONFLICT = new Set([
  "serialized-stale-command",
  "serialized-stale-backtrack",
  "serialized-stale-delete",
  "delete-requires-confirmation",
  "command-deleted",
  "interaction-event-conflict",
  "inquiry-command-conflict",
  "backtrack-with-information-conflict",
  "replay-conflict",
  // Library repository conflicts.
  "event-id-conflict",
  "artifact-id-conflict",
  "stale-background",
  "operator-id-conflict",
  "operator-symbol-conflict",
]);
const REJECTED = new Set([
  "suggestion-set-rejected",
  "preview-rejected",
  "command-rejected",
  "backtrack-rejected",
  "delete-rejected",
  "interaction-event-rejected",
  "inquiry-command-rejected",
  "backtrack-with-information-rejected",
  "replay-rejected",
  "invalid-request",
]);

/** The HTTP status of a repository (or library repository) failure. */
export function repositoryFailureStatus(
  failure: Readonly<{ status: "rejected" | "uncertain"; diagnostics: readonly [{ code: string }] }>,
): number {
  const code = failure.diagnostics[0].code;
  if (failure.status === "uncertain") return 503;
  if (NOT_FOUND.has(code)) return 404;
  if (CONFLICT.has(code)) return 409;
  if (code === "backtrack-symbols-unavailable") return 422;
  if (REJECTED.has(code)) return 400;
  return 500;
}

// ---------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------

export function approvedRetrievalIndex(
  definitions: DefinitionCatalog,
  operators: NonNullable<ProtocolEnvironment["operators"]>,
): Readonly<{ ok: true; index: RetrievalIndex }> | Readonly<{ ok: false; message: string }> {
  const catalog = definitions.catalog(operators);
  const result = createRetrievalIndex(
    {
      results: catalog.results,
      moves: definitions.moves,
      variantFamilies: catalog.variantFamilies,
    },
    { operators },
  );
  return result.ok
    ? { ok: true, index: result.index }
    : { ok: false, message: result.diagnostics[0]?.message ?? "The approved catalog is invalid." };
}

export function transitionClassesFor(
  definitions: DefinitionCatalog,
  suggestionSet: z.infer<typeof displayedSuggestionSetSchema>,
): readonly z.infer<typeof proofHttpTransitionClassificationSchema>[] {
  const moves = new Map<string, DefinitionCatalog["moves"][number]>(
    definitions.moves.map((move) => [move.id, move]),
  );
  return suggestionSet.suggestions.flatMap((suggestion) => {
    if (suggestion.source !== "move") return [];
    const move = moves.get(suggestion.artifactId);
    const suggestionId = suggestionIdSchema.safeParse(suggestion.id);
    return move === undefined || !suggestionId.success
      ? []
      : [{ suggestionId: suggestionId.data, transitionClass: move.transitionClass }];
  });
}

export type RecordSuggestionsResult =
  | Readonly<{ status: "recorded"; suggestionSet: DisplayedSuggestionSet; replayed: boolean }>
  | Readonly<{ status: "invalid-catalog"; message: string }>
  | Readonly<{ status: "failed"; failure: RepositoryFailure }>;

/** Retrieve and record one displayed suggestion set for snapshot-anchored selections. */
export async function recordSuggestions(
  { store, definitions }: ServiceContext,
  sessionId: string,
  suggestionSetId: z.infer<typeof suggestionSetIdSchema>,
  selections: readonly ProofHttpSelectionDescriptor[],
): Promise<RecordSuggestionsResult> {
  const loaded = await loadCurrentProofSession(store, sessionId);
  if (loaded.status !== "loaded") return { status: "failed", failure: loaded };
  const index = approvedRetrievalIndex(definitions, loaded.session.operators);
  if (!index.ok) return { status: "invalid-catalog", message: index.message };
  const requestSelection =
    selections.length === 1
      ? selections[0]
      : {
          kind: "selection-query" as const,
          selections: selections.map((selection, position) => ({
            id: `selection:request-${position + 1}`,
            selection,
          })),
        };
  const recorded = await recordDisplayedSuggestionSet(store, index.index, sessionId, {
    id: suggestionSetId,
    selection: requestSelection,
  });
  if (recorded.status !== "committed") return { status: "failed", failure: recorded };
  return { status: "recorded", suggestionSet: recorded.suggestionSet, replayed: recorded.replayed };
}

// ---------------------------------------------------------------------------------------------
// Displayed move choices: preview and apply
// ---------------------------------------------------------------------------------------------

export type MoveChoice = z.infer<typeof moveChoiceSchema>;

export type PreviewMoveChoiceResult =
  | Readonly<{
      status: "previewed";
      preview: MovePreview;
      replayed: boolean;
      regeneratedFrom?: string | undefined;
      operators: ProofSession["operators"];
    }>
  | Readonly<{ status: "requires-input"; input: MoveRequiresInput }>
  | Readonly<{ status: "stale-preview" }>
  | Readonly<{ status: "failed"; failure: RepositoryFailure }>;

/** Materialize a displayed choice with its menu choices and record its preview. */
export async function previewMoveChoice(
  { store, definitions, now }: ServiceContext,
  sessionId: string,
  choice: MoveChoice,
  actor: Actor,
): Promise<PreviewMoveChoiceResult> {
  const materialized = await materializeMoveChoice(store, sessionId, choice, definitions);
  if (materialized.status === "requires-input") {
    return { status: "requires-input", input: materialized };
  }
  if (materialized.status !== "materialized") return { status: "failed", failure: materialized };
  const recorded = await recordMovePreview(store, sessionId, materialized.request, {
    definitions,
    regeneration: { commandId: choice.commandId, actor },
    ...(now === undefined ? {} : { now }),
  });
  if (recorded.status !== "committed") return { status: "failed", failure: recorded };
  const loaded = await loadCurrentProofSession(store, sessionId);
  if (loaded.status !== "loaded") return { status: "failed", failure: loaded };
  if (recorded.preview.nodeId !== loaded.node.id) return { status: "stale-preview" };
  return {
    status: "previewed",
    preview: recorded.preview,
    replayed: recorded.replayed,
    regeneratedFrom: recorded.regeneratedFrom,
    operators: loaded.session.operators,
  };
}

export type ApplyMoveChoiceResult =
  | Readonly<{
      status: "applied";
      executed: Extract<ExecuteProofCommandResult, { status: "committed" }> & {
        records?: readonly unknown[];
      };
      session: ProofSession;
      node: ProofNode;
    }>
  | Readonly<{ status: "requires-input"; input: MoveRequiresInput }>
  | Readonly<{
      status: "preview-regenerated";
      stalePreviewId: string;
      preview: MovePreview;
      operators: ProofSession["operators"];
    }>
  | Readonly<{ status: "failed"; failure: RepositoryFailure }>;

/**
 * Apply a displayed choice through the single command path. A choice whose approved definitions
 * changed since its preview is regenerated and recorded instead, never applied unseen.
 */
export async function applyMoveChoice(
  context: ServiceContext,
  sessionId: string,
  choice: MoveChoice,
  inquiryMethod: "try-result" | undefined,
  actor: Actor,
): Promise<ApplyMoveChoiceResult> {
  const { store, definitions, now } = context;
  const materialized = await materializeMoveChoice(store, sessionId, choice, definitions);
  if (materialized.status === "requires-input") {
    return { status: "requires-input", input: materialized };
  }
  if (materialized.status !== "materialized") return { status: "failed", failure: materialized };
  const recordedPreview = await recordMovePreview(store, sessionId, materialized.request, {
    definitions,
    regeneration: { commandId: choice.commandId, actor },
    ...(now === undefined ? {} : { now }),
  });
  if (recordedPreview.status !== "committed") return { status: "failed", failure: recordedPreview };
  if (recordedPreview.regeneratedFrom !== undefined && !recordedPreview.replayed) {
    const loaded = await loadCurrentProofSession(store, sessionId);
    if (loaded.status !== "loaded") return { status: "failed", failure: loaded };
    return {
      status: "preview-regenerated",
      stalePreviewId: recordedPreview.regeneratedFrom,
      preview: recordedPreview.preview,
      operators: loaded.session.operators,
    };
  }
  const { preview } = recordedPreview;
  const ids = derivedMoveRecordIds(choice.commandId);
  const proofCommand = {
    commandId: choice.commandId,
    kind: "apply-kernel-operation",
    actor,
    parentNodeId: preview.nodeId,
    resultNodeId: ids.resultNodeId,
    edgeId: ids.edgeId,
    eventId: ids.eventId,
    moveId: preview.moveId,
    suggestionSetId: preview.suggestionSetId,
    chosenSuggestionId: preview.chosenSuggestionId,
    previewId: preview.id,
    operation: preview.operation,
    ...(preview.menuSelection === undefined ? {} : { menuSelection: preview.menuSelection }),
  };
  const executed =
    inquiryMethod === "try-result"
      ? await executeTryResultCommand(store, sessionId, proofCommand, actor, {
          definitions,
          ...(now === undefined ? {} : { now }),
        })
      : await executeProofCommand(store, sessionId, proofCommand, actor, definitions);
  if (executed.status !== "committed") return { status: "failed", failure: executed };
  const loaded = await loadCurrentProofSession(store, sessionId);
  if (loaded.status !== "loaded") return { status: "failed", failure: loaded };
  return { status: "applied", executed, session: loaded.session, node: loaded.node };
}
