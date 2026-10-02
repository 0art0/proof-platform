/**
 * Flows shared by the resource routes and the command envelope (roadmap N25): the same
 * repository calls run for a web request and an agent command, so neither path owns logic the
 * other lacks. Each flow returns a discriminated result; rendering stays with the caller.
 */
import {
  retrievalWildcardSchema,
  stableIdentifierSchema,
  suggestionIdSchema,
  transitionClassSchema,
  type displayedSuggestionSetSchema,
  type suggestionSetIdSchema,
  type Actor,
  type DisplayedSuggestionSet,
  type MovePreview,
  type PrepareProofCommandSuccess,
  type ProofNode,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { createRetrievalIndex, type RetrievalIndex } from "@proof/retrieval";
import { resolveProofSelection } from "@proof/selections";
import { z } from "zod";
import type { DefinitionCatalog } from "../approved-catalog";
import type { AiRuntime } from "../ai-runtime";
import { executeTryResultCommand } from "../inquiry-methods";
import type { LibraryStore } from "../library-repository";
import type { LlmCallStore } from "../llm-call-repository";
import {
  derivedMoveRecordIds,
  executeMacroPreview,
  executeProofCommand,
  loadCurrentProofSession,
  materializeMoveChoice,
  recordDisplayedSuggestionSet,
  recordMovePreview,
  repositoryFailure,
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
  llmCalls?: LlmCallStore | undefined;
  ai?: AiRuntime | undefined;
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
      abstraction: retrievalWildcardSchema.optional(),
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
      abstraction: retrievalWildcardSchema.optional(),
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
  "draft-not-found",
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
  "draft-already-reviewed",
  // Writes to a session imported from an artifact (N27).
  "session-read-only",
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
  "review-notes-required",
]);

/** Move-authoring refusals of well-formed requests (N35). */
const MOVE_AUTHORING_INVALID = new Set([
  "invalid-template",
  "move-validation-failed",
  "draft-corrupt",
  "library-admission-rejected",
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
  if (MOVE_AUTHORING_INVALID.has(code)) return 422;
  // A later macro step failed to re-match or apply: the request is well-formed, nothing was written.
  if (code === "macro-step-failed") return 422;
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
      // A macro is retrieved by its first step's contract; later steps re-match at preview time.
      moves: [...definitions.moves, ...(definitions.macros ?? []).map(({ move }) => move)],
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
  // A macro's class is the one composed from its steps, not its first primitive's.
  const classes = new Map<string, z.infer<typeof transitionClassSchema>>([
    ...definitions.moves.map((move) => [move.id, move.transitionClass] as const),
    ...(definitions.macros ?? []).map(
      ({ move, template }) => [move.id, template.transitionClass] as const,
    ),
  ]);
  return suggestionSet.suggestions.flatMap((suggestion) => {
    if (suggestion.source !== "move") return [];
    const transitionClass = classes.get(suggestion.artifactId);
    const suggestionId = suggestionIdSchema.safeParse(suggestion.id);
    return transitionClass === undefined || !suggestionId.success
      ? []
      : [{ suggestionId: suggestionId.data, transitionClass }];
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
  const abstracting = selections.some(({ abstraction }) => abstraction !== undefined);
  if (abstracting) {
    const mismatch = abstractionSortMismatch(loaded.node.state, selections, loaded.session);
    if (mismatch !== undefined) {
      return {
        status: "failed",
        failure: repositoryFailure("rejected", "suggestion-set-rejected", mismatch),
      };
    }
  }
  const requestSelection =
    selections.length === 1 && !abstracting
      ? selections[0]
      : {
          kind: "selection-query" as const,
          selections: selections.map(({ abstraction, ...selection }, position) => ({
            id: `selection:request-${position + 1}`,
            selection,
            ...(abstraction === undefined ? {} : { abstraction }),
          })),
        };
  const recorded = await recordDisplayedSuggestionSet(store, index.index, sessionId, {
    id: suggestionSetId,
    selection: requestSelection,
  });
  if (recorded.status !== "committed") return { status: "failed", failure: recorded };
  return { status: "recorded", suggestionSet: recorded.suggestionSet, replayed: recorded.replayed };
}

/**
 * An abstraction is retrieval-only and sort-preserving: a proposition wildcard may replace only a
 * proposition occurrence and a term-sorted wildcard only a term occurrence. Returns the reason an
 * abstraction does not fit its occurrence, or undefined when every abstraction is well-formed.
 */
function abstractionSortMismatch(
  state: ProofNode["state"],
  selections: readonly ProofHttpSelectionDescriptor[],
  session: ProofSession,
): string | undefined {
  for (const { abstraction, ...selection } of selections) {
    if (abstraction === undefined) continue;
    const resolved = resolveProofSelection(state, selection, { operators: session.operators });
    if (!resolved.ok) return resolved.diagnostics[0].message;
    const { role } = resolved.selection.position;
    if (role === "binder") return "A binder declaration cannot be abstracted for retrieval.";
    if (abstraction.sort === undefined) continue;
    const wildcardRole = abstraction.sort.kind === "proposition" ? "proposition" : "term";
    if (wildcardRole !== role) {
      return `The abstraction sort (${abstraction.sort.kind}) does not match the selected ${role} occurrence.`;
    }
  }
  return undefined;
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
        /** For a macro application: every step's prepared result, in order (`result` is the last). */
        macroResults?: readonly PrepareProofCommandSuccess[];
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
  if (preview.macro !== undefined) {
    if (inquiryMethod !== undefined) {
      return {
        status: "failed",
        failure: repositoryFailure(
          "rejected",
          "command-rejected",
          "A multi-step macro cannot be tried as an inquiry method.",
        ),
      };
    }
    const applied = await executeMacroPreview(
      store,
      sessionId,
      { commandId: choice.commandId, previewId: preview.id },
      actor,
      definitions,
    );
    if (applied.status !== "committed") return { status: "failed", failure: applied };
    const last = applied.results.at(-1);
    const loadedMacro = await loadCurrentProofSession(store, sessionId);
    if (last === undefined || loadedMacro.status !== "loaded") {
      return {
        status: "failed",
        failure:
          loadedMacro.status === "loaded"
            ? repositoryFailure("rejected", "command-rejected", "The macro recorded no steps.")
            : loadedMacro,
      };
    }
    return {
      status: "applied",
      executed: {
        status: "committed",
        result: last,
        replayed: applied.replayed,
        macroResults: applied.results,
      },
      session: loadedMacro.session,
      node: loadedMacro.node,
    };
  }
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
