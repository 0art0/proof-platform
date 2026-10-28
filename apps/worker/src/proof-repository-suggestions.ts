// Displayed suggestion sets and move previews: reading and recording them.

import {
  createMovePreviewSchema,
  definitionChanges,
  prepareDisplayedSuggestionSet,
  prepareMovePreview,
  suggestionSetMatchesNode,
  suggestionSetIdSchema,
  type Actor,
  type ApplyKernelCommand,
  type DisplayedSuggestionSet,
  type MovePreview,
  type MovePreviewId,
  type SuggestionSetId,
} from "@proof/protocol";
import type { RetrievalIndex } from "@proof/retrieval";
import { sequenceConstants } from "./session-constants";
import { APPROVED_DEFINITIONS, definitionHash, type DefinitionCatalog } from "./approved-catalog";
import {
  proofSessionIdSchema,
  type ProofSessionId,
  type ProofStoreTransaction,
  type ProofStore,
} from "./proof-repository-store";
import {
  type RepositoryFailure,
  repositoryFailure,
  safeParse,
  isDataRecord,
  isStrictDataRecord,
  jsonEquals,
  freezeDetached,
  transactionFailure,
} from "./proof-repository-core";
import {
  loadSession,
  loadNode,
  loadSuggestionSet,
  parseSuggestionSetRecord,
  frozenEnvironment,
  suggestionSetIdFromUnknown,
  movePreviewIdFromUnknown,
} from "./proof-repository-records";
import { appendInteractionEvent } from "./proof-repository-interaction";

export type RecordDisplayedSuggestionSetResult =
  | Readonly<{
      status: "committed";
      suggestionSet: DisplayedSuggestionSet;
      replayed: boolean;
    }>
  | RepositoryFailure;

export type ReadDisplayedSuggestionSetResult =
  Readonly<{ status: "loaded"; suggestionSet: DisplayedSuggestionSet }> | RepositoryFailure;

export type RecordMovePreviewResult =
  | Readonly<{
      status: "committed";
      preview: MovePreview;
      replayed: boolean;
      /**
       * Present when the preview with the requested ID was built from definitions that have since
       * changed: `preview` is then a regenerated preview and this is the stale preview's ID.
       */
      regeneratedFrom?: MovePreviewId;
    }>
  | RepositoryFailure;

export type RecordMovePreviewOptions = Readonly<{
  definitions?: DefinitionCatalog;
  /**
   * Allows regenerating a stale preview for this command and records who caused it. Without it
   * a preview ID whose stored evidence differs from the request is rejected.
   */
  regeneration?: Readonly<{ commandId: ApplyKernelCommand["commandId"]; actor: Actor }>;
  now?: () => Date;
}>;

/** Read immutable displayed evidence against the historical node it records. */
export async function readDisplayedSuggestionSet(
  store: ProofStore,
  sessionIdInput: unknown,
  suggestionSetIdInput: unknown,
): Promise<ReadDisplayedSuggestionSetResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const suggestionSetId = safeParse(suggestionSetIdSchema, suggestionSetIdInput) as
    SuggestionSetId | undefined;
  if (sessionId === undefined || suggestionSetId === undefined) {
    return repositoryFailure(
      "rejected",
      "suggestion-set-rejected",
      "The session ID or suggestion-set ID is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const loadedSuggestionSet = await loadSuggestionSet(
        transaction,
        loadedSession.session,
        suggestionSetId,
      );
      if (!loadedSuggestionSet.ok) return loadedSuggestionSet.failure;
      const loadedNode = await loadNode(
        transaction,
        loadedSession.session,
        loadedSession.environment,
        loadedSuggestionSet.suggestionSet.nodeId,
        "current-node-not-found",
        "invalid-current-node",
      );
      if (!loadedNode.ok) return loadedNode.failure;
      if (
        loadedSuggestionSet.suggestionSet.stateId !== loadedNode.node.state.id ||
        !suggestionSetMatchesNode(
          loadedSuggestionSet.suggestionSet,
          loadedNode.node,
          loadedSession.environment,
        )
      ) {
        return repositoryFailure(
          "rejected",
          "invalid-suggestion-set-record",
          "The stored suggestion set does not match its historical proof-node snapshot.",
        );
      }

      return { status: "loaded" as const, suggestionSet: loadedSuggestionSet.suggestionSet };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The displayed suggestion set could not be read.");
  }
}

/** Run retrieval and atomically retain the exact ordered evidence; retries must reproduce it. */
export async function recordDisplayedSuggestionSet(
  store: ProofStore,
  index: RetrievalIndex,
  sessionIdInput: unknown,
  requestInput: unknown,
): Promise<RecordDisplayedSuggestionSetResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const suggestionSetId = suggestionSetIdFromUnknown(requestInput, "id");
  if (sessionId === undefined || suggestionSetId === undefined) {
    return repositoryFailure(
      "rejected",
      "suggestion-set-rejected",
      "The session ID or suggestion-set request is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;

      const loadedCurrentNode = await loadNode(
        transaction,
        session,
        environment,
        session.currentNodeId,
        "current-node-not-found",
        "invalid-current-node",
      );
      if (!loadedCurrentNode.ok) return loadedCurrentNode.failure;
      const currentNode = loadedCurrentNode.node;

      const prepared = prepareDisplayedSuggestionSet(index, currentNode, requestInput, environment);
      if (!prepared.ok) {
        return repositoryFailure(
          "rejected",
          "suggestion-set-rejected",
          prepared.diagnostics[0]?.message ?? "The suggestion request was rejected.",
        );
      }

      const existingInput = await transaction.readSuggestionSet(session.id, suggestionSetId);
      if (existingInput !== undefined) {
        const loadedExisting = parseSuggestionSetRecord(existingInput, session, suggestionSetId);
        if (
          loadedExisting === undefined ||
          !suggestionSetMatchesNode(loadedExisting, currentNode, environment)
        ) {
          return repositoryFailure(
            "rejected",
            "invalid-suggestion-set-record",
            "The stored suggestion set failed runtime validation or snapshot identity checks.",
          );
        }
        if (!jsonEquals(loadedExisting, prepared.suggestionSet)) {
          return repositoryFailure(
            "rejected",
            "suggestion-set-rejected",
            "The suggestion-set ID is already anchored to a different request or result.",
          );
        }
        return { status: "committed" as const, suggestionSet: loadedExisting, replayed: true };
      }

      await transaction.insertSuggestionSet(session.id, prepared.suggestionSet);
      return {
        status: "committed" as const,
        suggestionSet: prepared.suggestionSet,
        replayed: false,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The suggestion-set transaction failed.");
  }
}

/**
 * Persist one concrete move preview without advancing the proof session.
 *
 * With `options.regeneration`, a preview ID whose stored evidence was built for the same displayed
 * choice but from different approved definitions (or a different resulting operation) is stale:
 * a fresh preview is recorded under a derived ID, together with a `preview-regenerated`
 * interaction event, and returned with `regeneratedFrom` (refinement §12.2).
 */
export async function recordMovePreview(
  store: ProofStore,
  sessionIdInput: unknown,
  requestInput: unknown,
  options: RecordMovePreviewOptions = {},
): Promise<RecordMovePreviewResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const previewId = movePreviewIdFromUnknown(requestInput, "id");
  const suggestionSetId = suggestionSetIdFromUnknown(requestInput, "suggestionSetId");
  if (sessionId === undefined || previewId === undefined || suggestionSetId === undefined) {
    return repositoryFailure(
      "rejected",
      "preview-rejected",
      "The session ID or move-preview request is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(
        transaction,
        sessionId,
        options.definitions ?? APPROVED_DEFINITIONS,
      );
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;

      const existingInput = await transaction.readPreview(session.id, previewId);
      let stale: MovePreview | undefined;
      if (existingInput !== undefined) {
        const existing = safeParse(createMovePreviewSchema(environment), existingInput);
        if (existing === undefined || existing.id !== previewId) {
          return repositoryFailure(
            "rejected",
            "invalid-preview-record",
            "The stored move preview failed runtime validation or identity checks.",
          );
        }
        if (!movePreviewRequestMatches(existing, requestInput)) {
          if (options.regeneration === undefined || !sameDisplayedChoice(existing, requestInput)) {
            return repositoryFailure(
              "rejected",
              "preview-rejected",
              "The preview ID is already linked to a different move-preview request.",
            );
          }
          if (await previewWasApplied(transaction, session.id, existing.id)) {
            // History is static: an applied preview is replayed, never regenerated.
            const detached = freezeDetached(existing);
            return detached === undefined
              ? repositoryFailure(
                  "rejected",
                  "invalid-preview-record",
                  "The stored move preview could not be detached safely.",
                )
              : { status: "committed" as const, preview: detached, replayed: true };
          }
          stale = existing;
        } else {
          const detached = freezeDetached(existing);
          return detached === undefined
            ? repositoryFailure(
                "rejected",
                "invalid-preview-record",
                "The stored move preview could not be detached safely.",
              )
            : { status: "committed" as const, preview: detached, replayed: true };
        }
      }

      const freshId =
        stale === undefined ? previewId : regeneratedPreviewId(stale.id, requestInput);
      const freshRequest =
        stale === undefined ? requestInput : { ...(requestInput as object), id: freshId };
      if (stale !== undefined) {
        const regeneratedInput = await transaction.readPreview(session.id, freshId);
        if (regeneratedInput !== undefined) {
          const regenerated = safeParse(createMovePreviewSchema(environment), regeneratedInput);
          const detached = regenerated === undefined ? undefined : freezeDetached(regenerated);
          if (
            detached === undefined ||
            detached.id !== freshId ||
            !movePreviewRequestMatches(detached, freshRequest)
          ) {
            return repositoryFailure(
              "rejected",
              "invalid-preview-record",
              "The stored regenerated preview failed validation or identity checks.",
            );
          }
          return {
            status: "committed" as const,
            preview: detached,
            replayed: true,
            regeneratedFrom: stale.id,
          };
        }
      }

      const suggestionSetInput = await transaction.readSuggestionSet(session.id, suggestionSetId);
      if (suggestionSetInput === undefined) {
        return repositoryFailure(
          "rejected",
          "suggestion-set-not-found",
          "The preview references a suggestion set that does not exist in this session.",
        );
      }
      const suggestionSet = parseSuggestionSetRecord(suggestionSetInput, session, suggestionSetId);
      if (suggestionSet === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-suggestion-set-record",
          "The stored suggestion set failed runtime validation or identity checks.",
        );
      }

      const loadedCurrentNode = await loadNode(
        transaction,
        session,
        environment,
        session.currentNodeId,
        "current-node-not-found",
        "invalid-current-node",
      );
      if (!loadedCurrentNode.ok) return loadedCurrentNode.failure;
      const currentNode = loadedCurrentNode.node;

      // A previewed step that applies a library result using constants the session has not
      // activated is previewed in the operators extended with them, and the preview says so
      // (`MovePreview.constants`). Nothing is activated until the step is applied.
      const ahead = sequenceConstants(
        options.definitions ?? APPROVED_DEFINITIONS,
        session.operators,
        previewOperations(freshRequest),
      );
      const previewEnvironment =
        ahead.constants.length === 0
          ? environment
          : (frozenEnvironment(ahead.operators, options.definitions ?? APPROVED_DEFINITIONS) ??
            environment);
      const prepared = prepareMovePreview(
        currentNode,
        suggestionSet,
        ahead.constants.length === 0 || !isDataRecord(freshRequest)
          ? freshRequest
          : { ...freshRequest, constants: ahead.constants },
        previewEnvironment,
      );
      if (!prepared.ok) {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          prepared.diagnostics[0]?.message ?? "The move preview was rejected.",
        );
      }
      await transaction.insertPreview(session.id, prepared.preview);
      if (stale === undefined || options.regeneration === undefined) {
        return { status: "committed" as const, preview: prepared.preview, replayed: false };
      }

      const event = await appendInteractionEvent(
        transaction,
        session.id,
        currentNode,
        options.regeneration.actor,
        options.now,
        {
          id: `event:${freshId}`,
          kind: "preview-regenerated",
          commandId: options.regeneration.commandId,
          stalePreviewId: stale.id,
          previewId: prepared.preview.id,
          operationChanged:
            stale.moveId !== prepared.preview.moveId ||
            !jsonEquals(stale.operation, prepared.preview.operation),
          changedDefinitions: definitionChanges(
            stale.definitions ?? [],
            prepared.preview.definitions ?? [],
          ),
        },
      );
      if (event === undefined) {
        // Throwing rolls the regenerated preview back with the event.
        throw new Error("The preview-regeneration event failed runtime validation.");
      }
      return {
        status: "committed" as const,
        preview: prepared.preview,
        replayed: false,
        regeneratedFrom: stale.id,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The move-preview transaction failed.");
  }
}

/** A stored macro preview in the request's shape, or undefined for an ordinary preview. */
function macroRequestOf(preview: MovePreview): unknown {
  return preview.macro === undefined
    ? undefined
    : {
        steps: preview.macro.steps.map(({ id, moveId, operation }) => ({ id, moveId, operation })),
      };
}

/** The stored preview and the request name the same displayed choice and menu choices. */
function sameDisplayedChoice(preview: MovePreview, request: unknown): boolean {
  return (
    isDataRecord(request) &&
    request.suggestionSetId === preview.suggestionSetId &&
    request.chosenSuggestionId === preview.chosenSuggestionId &&
    jsonEquals(
      isDataRecord(request.menuSelection) ? request.menuSelection.choices : undefined,
      preview.menuSelection?.choices,
    )
  );
}

async function previewWasApplied(
  transaction: ProofStoreTransaction,
  sessionId: ProofSessionId,
  previewId: MovePreviewId,
): Promise<boolean> {
  const edges = await transaction.listEdges(sessionId);
  return edges.some(
    (row) =>
      isDataRecord(row) &&
      (row.previewId === previewId ||
        (isDataRecord(row.macro) && row.macro.previewId === previewId)),
  );
}

/** A deterministic ID for the regeneration of `stalePreviewId` with this exact content. */
function regeneratedPreviewId(stalePreviewId: MovePreviewId, request: unknown): MovePreviewId {
  const content = isDataRecord(request)
    ? {
        moveId: request.moveId,
        operation: request.operation,
        macro: request.macro,
        menuSelection: request.menuSelection,
        definitions: request.definitions,
      }
    : {};
  const digest = definitionHash(content).slice("sha256:".length, "sha256:".length + 16);
  return `${stalePreviewId}:regenerated:${digest}` as MovePreviewId;
}

/** The operations a preview request carries: its own, or a macro's steps'. */
function previewOperations(request: unknown): readonly unknown[] {
  if (!isDataRecord(request)) return [];
  const steps = isDataRecord(request.macro) ? request.macro.steps : undefined;
  return Array.isArray(steps)
    ? steps.map((step) => (isDataRecord(step) ? step.operation : undefined))
    : [request.operation];
}

function movePreviewRequestMatches(preview: MovePreview, request: unknown): boolean {
  const keys = ["id", "suggestionSetId", "chosenSuggestionId", "moveId", "operation"];
  if (!isDataRecord(request)) return false;
  if (request.menuSelection !== undefined) keys.push("menuSelection");
  if (request.definitions !== undefined) keys.push("definitions");
  if (request.macro !== undefined) keys.push("macro");
  return (
    isStrictDataRecord(request, keys) &&
    jsonEquals(request.macro, macroRequestOf(preview)) &&
    request.id === preview.id &&
    request.suggestionSetId === preview.suggestionSetId &&
    request.chosenSuggestionId === preview.chosenSuggestionId &&
    request.moveId === preview.moveId &&
    jsonEquals(request.operation, preview.operation) &&
    jsonEquals(request.menuSelection, preview.menuSelection) &&
    jsonEquals(request.definitions, preview.definitions)
  );
}
