// Client interaction events: recording, validating and listing them.

import {
  actorSchema,
  interactionEventIdSchema,
  interactionEventRequestFields,
  interactionEventSchema,
  proofNodeIdSchema,
  recordInteractionEventRequestSchema,
  type Actor,
  type DisplayedSuggestionSet,
  type InteractionEvent,
  type InteractionEventId,
  type MovePreviewId,
  type ProofNode,
  type SuggestionSetId,
} from "@proof/protocol";
import { z } from "zod";
import {
  proofSessionIdSchema,
  type ProofSessionId,
  type ProofSession,
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
import { loadSession, loadNode, loadSuggestionSet } from "./proof-repository-records";

export type RecordInteractionEventResult =
  Readonly<{ status: "committed"; event: InteractionEvent; replayed: boolean }> | RepositoryFailure;

export type ListInteractionEventsResult =
  Readonly<{ status: "loaded"; events: readonly InteractionEvent[] }> | RepositoryFailure;

type InteractionEventFields = Readonly<Record<string, unknown>> &
  Readonly<{ id: string; kind: InteractionEvent["kind"] }>;

/** Assign the next sequence number and insert one validated event anchored at `node`. */
export async function appendInteractionEvent(
  transaction: ProofStoreTransaction,
  sessionId: ProofSessionId,
  node: ProofNode,
  actor: Actor,
  now: (() => Date) | undefined,
  fields: InteractionEventFields,
): Promise<InteractionEvent | undefined> {
  const last = await transaction.lastInteractionSequence(sessionId);
  if (!Number.isSafeInteger(last) || last < 0) {
    throw new Error("The stored interaction-event sequence is invalid.");
  }
  const parsed = safeParse(interactionEventSchema, {
    ...fields,
    sequence: last + 1,
    nodeId: node.id,
    stateId: node.state.id,
    actor: { id: actor.id, kind: actor.kind },
    recordedAt: (now?.() ?? new Date()).toISOString(),
  });
  const event = parsed === undefined ? undefined : freezeDetached(parsed);
  if (event === undefined) return undefined;
  await transaction.insertInteractionEvent(sessionId, event);
  return event;
}

/**
 * Record one client interaction event (refinement §12.1). It is anchored to an existing node of
 * the session and receives the next per-session sequence number. Retrying the same event ID with
 * the same content replays the stored event; different content under that ID is rejected.
 */
export async function recordInteractionEvent(
  store: ProofStore,
  sessionIdInput: unknown,
  requestInput: unknown,
  trustedActorInput: unknown,
  options: Readonly<{ now?: () => Date }> = {},
): Promise<RecordInteractionEventResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const request = safeParse(recordInteractionEventRequestSchema, requestInput);
  const actor = safeParse(actorSchema, trustedActorInput);
  if (sessionId === undefined || request === undefined || actor === undefined) {
    return repositoryFailure(
      "rejected",
      "interaction-event-rejected",
      "The session ID, interaction event, or trusted actor is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;

      const existingInput = await transaction.readInteractionEvent(
        session.id,
        request.id as InteractionEventId,
      );
      if (existingInput !== undefined) {
        const existing = parseInteractionEventRecord(existingInput, session, request.id);
        if (existing === undefined) {
          return repositoryFailure(
            "rejected",
            "invalid-interaction-event-record",
            "The stored interaction event failed runtime validation or identity checks.",
          );
        }
        if (
          !jsonEquals(interactionEventRequestFields(existing), request) ||
          existing.actor.id !== actor.id ||
          existing.actor.kind !== actor.kind
        ) {
          return repositoryFailure(
            "rejected",
            "interaction-event-conflict",
            "The interaction-event ID is already recorded with different content.",
          );
        }
        return { status: "committed" as const, event: existing, replayed: true };
      }

      const loadedNode = await loadNode(
        transaction,
        session,
        environment,
        request.nodeId as ProofNode["id"],
        "interaction-event-rejected",
        "invalid-current-node",
      );
      if (!loadedNode.ok) return loadedNode.failure;
      const node = loadedNode.node;
      const invalid = await interactionEventReferenceFailure(transaction, session, node, request);
      if (invalid !== undefined) {
        return repositoryFailure("rejected", "interaction-event-rejected", invalid);
      }
      const event = await appendInteractionEvent(
        transaction,
        session.id,
        node,
        actor,
        options.now,
        request,
      );
      return event === undefined
        ? repositoryFailure(
            "rejected",
            "interaction-event-rejected",
            "The interaction event failed runtime validation against its anchor node.",
          )
        : { status: "committed" as const, event, replayed: false };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The interaction event could not be recorded.");
  }
}

/** Why an event's references do not belong to its anchor node, or undefined when they do. */
async function interactionEventReferenceFailure(
  transaction: ProofStoreTransaction,
  session: ProofSession,
  node: ProofNode,
  request: z.infer<typeof recordInteractionEventRequestSchema>,
): Promise<string | undefined> {
  const targets = new Set([
    ...node.state.goals.map(({ id }) => `goal\u0000${id}`),
    ...node.state.obligations.map(({ id }) => `obligation\u0000${id}`),
  ]);
  const hasTarget = (target: Readonly<{ kind: string; id: string }>) =>
    targets.has(`${target.kind}\u0000${target.id}`);
  const anchoredSet = async (
    suggestionSetId: SuggestionSetId,
  ): Promise<DisplayedSuggestionSet | string> => {
    const loaded = await loadSuggestionSet(transaction, session, suggestionSetId);
    if (!loaded.ok) return "The referenced suggestion set does not exist in this session.";
    return loaded.suggestionSet.nodeId === node.id
      ? loaded.suggestionSet
      : "The referenced suggestion set is anchored to a different proof node.";
  };

  switch (request.kind) {
    case "selection-changed":
      return request.selections.every(
        ({ anchor }) => anchor.stateId === node.state.id && hasTarget(anchor.target),
      )
        ? undefined
        : "Every selection must be anchored to a goal or obligation of the event's node.";
    case "suggestions-requested": {
      // The request precedes the set; if it already exists it must belong to this node.
      const input = await transaction.readSuggestionSet(
        session.id,
        request.suggestionSetId as SuggestionSetId,
      );
      if (input === undefined) return undefined;
      const set = await anchoredSet(request.suggestionSetId as SuggestionSetId);
      return typeof set === "string" ? set : undefined;
    }
    case "suggestions-displayed": {
      const set = await anchoredSet(request.suggestionSetId as SuggestionSetId);
      if (typeof set === "string") return set;
      const order = set.suggestions.map(({ id }) => id);
      let cursor = 0;
      for (const id of request.suggestionIds) {
        const index = order.indexOf(id, cursor);
        if (index < 0) return "Displayed suggestions must appear in the set, in stored order.";
        cursor = index + 1;
      }
      return undefined;
    }
    case "preview-requested":
    case "menu-expanded": {
      const set = await anchoredSet(request.suggestionSetId as SuggestionSetId);
      if (typeof set === "string") return set;
      const suggestionId =
        request.kind === "preview-requested" ? request.chosenSuggestionId : request.suggestionId;
      return set.suggestions.some(({ id }) => id === suggestionId)
        ? undefined
        : "The referenced suggestion was not displayed in that suggestion set.";
    }
    case "preview-rejected": {
      const input = await transaction.readPreview(session.id, request.previewId as MovePreviewId);
      return isDataRecord(input) && input.id === request.previewId && input.nodeId === node.id
        ? undefined
        : "The rejected preview does not exist at the event's proof node.";
    }
    case "focus-changed":
      return hasTarget(request.target)
        ? undefined
        : "The focus target is not a goal or obligation of the event's node.";
    case "objective-changed":
      return undefined;
    case "interaction-ended-without-action": {
      if (request.suggestionSetId === undefined) return undefined;
      const set = await anchoredSet(request.suggestionSetId as SuggestionSetId);
      return typeof set === "string" ? set : undefined;
    }
  }
}

/** Read a session's interaction events in sequence order, optionally for one anchor node. */
export async function listInteractionEvents(
  store: ProofStore,
  sessionIdInput: unknown,
  queryInput: unknown = {},
): Promise<ListInteractionEventsResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const query = safeParse(interactionEventQuerySchema, queryInput);
  if (sessionId === undefined || query === undefined) {
    return repositoryFailure(
      "rejected",
      "interaction-event-rejected",
      "The session ID or interaction-event query is invalid.",
    );
  }
  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session } = loadedSession;
      const rows = await transaction.listInteractionEvents(session.id, {
        ...(query.nodeId === undefined ? {} : { nodeId: query.nodeId as ProofNode["id"] }),
        afterSequence: query.afterSequence ?? 0,
        limit: query.limit ?? MAX_INTERACTION_EVENTS_PER_READ,
      });
      if (!Array.isArray(rows)) {
        return repositoryFailure(
          "rejected",
          "invalid-interaction-event-record",
          "The stored interaction-event collection is invalid.",
        );
      }
      const events: InteractionEvent[] = [];
      for (const row of rows) {
        const eventId = isDataRecord(row) ? row.eventId : undefined;
        const event =
          typeof eventId === "string"
            ? parseInteractionEventRecord(row, session, eventId)
            : undefined;
        const previous = events.at(-1);
        if (
          event === undefined ||
          event.sequence <= (query.afterSequence ?? 0) ||
          (query.nodeId !== undefined && event.nodeId !== query.nodeId) ||
          (previous !== undefined && event.sequence <= previous.sequence)
        ) {
          return repositoryFailure(
            "rejected",
            "invalid-interaction-event-record",
            "A stored interaction event failed validation, identity, or ordering checks.",
          );
        }
        events.push(event);
      }
      return { status: "loaded" as const, events };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The interaction events could not be read.");
  }
}

export const MAX_INTERACTION_EVENTS_PER_READ = 1000;

export const interactionEventQuerySchema = z
  .object({
    nodeId: proofNodeIdSchema.optional(),
    afterSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(MAX_INTERACTION_EVENTS_PER_READ).optional(),
  })
  .strict();

export function parseInteractionEventRecord(
  input: unknown,
  session: ProofSession,
  expectedEventId: string,
): InteractionEvent | undefined {
  if (!isStrictDataRecord(input, ["sessionId", "eventId", "sequence", "nodeId", "event"])) {
    return undefined;
  }
  const event = safeParse(interactionEventSchema, input.event);
  if (
    event === undefined ||
    safeParse(proofSessionIdSchema, input.sessionId) !== session.id ||
    safeParse(interactionEventIdSchema, input.eventId) !== expectedEventId ||
    event.id !== expectedEventId ||
    input.sequence !== event.sequence ||
    input.nodeId !== event.nodeId
  ) {
    return undefined;
  }
  return freezeDetached(event);
}
