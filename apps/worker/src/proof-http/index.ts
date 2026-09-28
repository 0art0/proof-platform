import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  actorSchema,
  backtrackAnalysisRequestSchema,
  backtrackAnalysisSchema,
  backtrackWithInformationCommandSchema,
  createMovePreviewSchema,
  createProofEdgeSchema,
  createProofNodeSchema,
  deletePreviousMoveCommandSchema,
  deletePreviousMoveReceiptSchema,
  displayedSuggestionSetSchema,
  inquiryRecordListSchema,
  interactionEventListSchema,
  interactionEventSchema,
  moveRequiresInputResponseSchema,
  previewRegeneratedResponseSchema,
  proofCommandReceiptSchema,
  proofSessionMetadataSchema,
  recordInquiryCommandRequestSchema,
  recordInteractionEventRequestSchema,
  stableIdentifierSchema,
  suggestionIdSchema,
  suggestionSetIdSchema,
  transitionClassSchema,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { createRetrievalIndex, type RetrievalIndex } from "@proof/retrieval";
import type { Pool } from "pg";
import { z } from "zod";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "../approved-catalog";
import {
  executeTryResultCommand,
  hypothesisInvestigationRequestSchema,
  investigateHypothesis,
} from "../inquiry-methods";
import {
  inquiryRecordQuerySchema,
  listInquiryRecords,
  recordInquiryCommand,
} from "../inquiry-repository";
import { postgresProofStore } from "../postgres-proof-store";
import {
  analyzeBacktrackWithInformation,
  backtrackProofSession,
  backtrackProofSessionSchema,
  backtrackWithInformation,
  deletePreviousMove,
  derivedMoveRecordIds,
  executeProofCommand,
  interactionEventQuerySchema,
  listInteractionEvents,
  loadProofHistory,
  loadCurrentProofSession,
  materializeMoveChoice,
  moveChoiceSchema,
  proofSessionSchema,
  proofSessionIdSchema,
  readDisplayedSuggestionSet,
  recordDisplayedSuggestionSet,
  recordInteractionEvent,
  recordMovePreview,
  type ProofSession,
  type MaterializeMoveChoiceResult,
  type ProofStore,
  type RepositoryFailure,
} from "../proof-repository";
import {
  semanticReplayCommandSchema,
  semanticReplayPreviewRequestSchema,
  semanticReplayReportSchema,
} from "@proof/protocol";
import { commitSemanticReplay, previewSemanticReplay } from "../proof-repository";

/** Semantic replay (design plan §16.4); the service supplies the actor. */
export const proofHttpReplayPreviewRequestSchema = semanticReplayPreviewRequestSchema;
export const proofHttpReplayRequestSchema = semanticReplayCommandSchema.omit({ actor: true });

export const proofHttpReplayPreviewResponseSchema = z
  .object({ report: semanticReplayReportSchema, finalNode: z.unknown() })
  .strict();

export const proofHttpReplayResponseSchema = z
  .object({
    session: proofSessionSchema.refine(
      (session) => session.metadata === undefined,
      "HTTP session objects omit metadata.",
    ),
    node: z.unknown(),
    receipts: z.array(proofCommandReceiptSchema).min(1),
    report: semanticReplayReportSchema,
    replayed: z.boolean(),
  })
  .strict();

/** A step did not re-match; nothing was recorded. */
export const proofHttpReplayFailedResponseSchema = z
  .object({
    status: z.literal("replay-failed"),
    report: semanticReplayReportSchema,
    diagnostics: z.tuple([
      z.object({ code: z.literal("replay-failed"), message: z.string().min(1) }).strict(),
    ]),
  })
  .strict();

/**
 * Session objects in HTTP responses never carry metadata: existing clients parse them strictly.
 * `GET /proof-sessions/:id?include=metadata` returns stored metadata beside the session instead.
 */
const proofHttpSessionSchema = proofSessionSchema.refine(
  (session) => session.metadata === undefined,
  "HTTP session objects omit metadata.",
);

function withoutMetadata(session: ProofSession): ProofSession {
  const { id, rootNodeId, currentNodeId, operators } = session;
  return { id, rootNodeId, currentNodeId, operators };
}

function includesMetadata(requestTarget: string | undefined): boolean {
  try {
    const url = new URL(requestTarget ?? "/", "http://proof.local");
    return url.searchParams.getAll("include").includes("metadata");
  } catch {
    return false;
  }
}

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

export const proofHttpSuggestionRequestSchema = z
  .object({
    id: suggestionSetIdSchema,
    selections: z.array(proofHttpSelectionDescriptorSchema).min(1).max(16),
  })
  .strict();

export const proofHttpMoveChoiceRequestSchema = moveChoiceSchema;
/**
 * Applying a displayed choice. `inquiryMethod: "try-result"` applies a result suggestion as
 * "Try this theorem" and records its inquiry records with the transition (refinement §3.4).
 */
export const proofHttpCommandRequestSchema = moveChoiceSchema.extend({
  inquiryMethod: z.literal("try-result").optional(),
});
export const proofHttpBacktrackRequestSchema = backtrackProofSessionSchema;
/** The web actor is supplied by the service; clients never name the actor. */
export const proofHttpDeletePreviousMoveRequestSchema = deletePreviousMoveCommandSchema.omit({
  actor: true,
});

/** Backtracking with information (design plan §16.3); the service supplies the actor. */
export const proofHttpBacktrackWithInformationRequestSchema =
  backtrackWithInformationCommandSchema.omit({ actor: true });
export const proofHttpBacktrackAnalysisRequestSchema = backtrackAnalysisRequestSchema;

export const proofHttpTransitionClassificationSchema = z
  .object({ suggestionId: suggestionIdSchema, transitionClass: transitionClassSchema })
  .strict();

export const proofHttpSuggestionResponseSchema = z
  .object({
    suggestionSet: displayedSuggestionSetSchema,
    replayed: z.boolean().optional(),
    transitionClasses: z.array(proofHttpTransitionClassificationSchema),
  })
  .strict();

export const proofHttpPreviewResponseSchema = z
  .object({
    preview: z.unknown(),
    replayed: z.boolean(),
    /** Present when a stale preview for this command was regenerated from current definitions. */
    regeneratedFrom: stableIdentifierSchema.optional(),
  })
  .strict();

export const proofHttpInteractionEventRequestSchema = recordInteractionEventRequestSchema;

export const proofHttpInteractionEventResponseSchema = z
  .object({ event: interactionEventSchema, replayed: z.boolean() })
  .strict();

export const proofHttpInteractionEventListResponseSchema = z
  .object({ events: interactionEventListSchema })
  .strict();

export const proofHttpInquiryCommandRequestSchema = recordInquiryCommandRequestSchema;

export const proofHttpInquiryCommandResponseSchema = z
  .object({ records: inquiryRecordListSchema.min(1), replayed: z.boolean() })
  .strict();

export const proofHttpInquiryRecordListResponseSchema = z
  .object({ records: inquiryRecordListSchema })
  .strict();

export const proofHttpCommandResponseSchema = z
  .object({
    session: proofHttpSessionSchema,
    node: z.unknown(),
    receipt: proofCommandReceiptSchema,
    replayed: z.boolean(),
    /** The "Try this theorem" inquiry records, when the command named that method. */
    inquiryRecords: inquiryRecordListSchema.min(1).optional(),
  })
  .strict();

/** "Investigate this hypothesis" (refinement §6, §10); the service supplies the actor. */
export const proofHttpHypothesisInvestigationRequestSchema = hypothesisInvestigationRequestSchema;

export const proofHttpHistoryResponseSchema = z
  .object({
    session: proofHttpSessionSchema,
    nodes: z.array(z.unknown()),
    edges: z.array(z.object({ edge: z.unknown(), name: z.string().min(1) }).strict()),
  })
  .strict();

export const proofHttpBacktrackResponseSchema = z
  .object({ session: proofHttpSessionSchema, node: z.unknown(), replayed: z.boolean() })
  .strict();

export const proofHttpDeletePreviousMoveResponseSchema = z
  .object({
    session: proofHttpSessionSchema,
    node: z.unknown(),
    receipt: deletePreviousMoveReceiptSchema,
    replayed: z.boolean(),
  })
  .strict();

export const proofHttpBacktrackAnalysisResponseSchema = z
  .object({ analysis: backtrackAnalysisSchema })
  .strict();

export const proofHttpBacktrackWithInformationResponseSchema = z
  .object({
    session: proofHttpSessionSchema,
    /** The node the cursor moved to; `backtrack.focusTarget` is its open case. */
    node: z.unknown(),
    receipts: z.array(proofCommandReceiptSchema).min(1).max(2),
    backtrack: interactionEventSchema,
    replayed: z.boolean(),
  })
  .strict();

const WEB_ACTOR = actorSchema.parse({ id: "actor:web", kind: "human" });

export type ProofHttpListenOptions = Readonly<{
  host?: string;
  port?: number;
}>;

export type ProofHttpService = Readonly<{
  server: Server;
  listen(options?: ProofHttpListenOptions): Promise<Readonly<{ origin: string }>>;
  close(): Promise<void>;
}>;

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export type ProofHttpServiceOptions = Readonly<{
  /** The approved move and library definitions; tests inject changed definitions. */
  definitions?: DefinitionCatalog;
  now?: () => Date;
}>;

type HandlerContext = Readonly<{
  store: ProofStore;
  definitions: DefinitionCatalog;
  now: (() => Date) | undefined;
}>;

/** Create the dependency-free product HTTP boundary over a proof repository. */
export function createProofHttpService(
  store: ProofStore,
  options: ProofHttpServiceOptions = {},
): ProofHttpService {
  const context: HandlerContext = {
    store,
    definitions: options.definitions ?? APPROVED_DEFINITIONS,
    now: options.now,
  };
  const server = createServer((request, response) => {
    void handleRequest(context, request, response).catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, {
          diagnostics: [{ code: "internal-error", message: "The request could not be handled." }],
        });
      } else {
        response.destroy();
      }
    });
  });

  return Object.freeze({
    server,
    async listen(options: ProofHttpListenOptions = {}) {
      if (server.listening) throw new Error("The proof HTTP service is already listening.");
      const host = options.host ?? "127.0.0.1";
      const port = options.port ?? 0;
      await listen(server, port, host);
      const address = server.address();
      if (address === null || typeof address === "string") {
        await close(server);
        throw new Error("The proof HTTP service did not receive a TCP address.");
      }
      return Object.freeze({ origin: originFor(address, host) });
    },
    async close() {
      if (!server.listening) return;
      await close(server);
    },
  });
}

/** PostgreSQL is the only product persistence adapter for this HTTP service. */
export function createPostgresProofHttpService(pool: Pool): ProofHttpService {
  return createProofHttpService(postgresProofStore(pool));
}

async function handleRequest(
  { store, definitions, now }: HandlerContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const route = parseRoute(request.url);
  if (route === undefined) {
    writeJson(response, 404, notFound("The requested proof resource does not exist."));
    return;
  }

  if (route.kind === "session" && request.method === "GET") {
    const loaded = await loadCurrentProofSession(store, route.sessionId);
    if (loaded.status !== "loaded") {
      writeRepositoryFailure(response, loaded);
      return;
    }
    const metadata = includesMetadata(request.url) ? loaded.session.metadata : undefined;
    writeValidatedJson(
      response,
      200,
      z
        .object({
          session: proofHttpSessionSchema,
          node: createProofNodeSchema({ operators: loaded.session.operators }),
          metadata: proofSessionMetadataSchema.optional(),
        })
        .strict(),
      {
        session: withoutMetadata(loaded.session),
        node: loaded.node,
        ...(metadata === undefined ? {} : { metadata }),
      },
    );
    return;
  }

  if (route.kind === "suggestion-collection" && request.method === "POST") {
    if (!hasJsonContentType(request)) {
      writeJson(response, 415, invalidRequest("Content-Type must be application/json."));
      return;
    }
    const body = await readJsonBody(request);
    if (!body.ok) {
      writeJson(response, body.status, invalidRequest(body.message));
      return;
    }
    const parsedRequest = proofHttpSuggestionRequestSchema.safeParse(body.value);
    if (!parsedRequest.success) {
      writeJson(
        response,
        400,
        invalidRequest(
          "Only strict snapshot-anchored exact-occurrence or associative-range selections are accepted.",
        ),
      );
      return;
    }

    const loaded = await loadCurrentProofSession(store, route.sessionId);
    if (loaded.status !== "loaded") {
      writeRepositoryFailure(response, loaded);
      return;
    }
    const index = approvedRetrievalIndex(definitions, loaded.session.operators);
    if (!index.ok) {
      writeJson(response, 500, {
        diagnostics: [{ code: "invalid-catalog", message: index.message }],
      });
      return;
    }
    const requestSelection =
      parsedRequest.data.selections.length === 1
        ? parsedRequest.data.selections[0]
        : {
            kind: "selection-query" as const,
            selections: parsedRequest.data.selections.map((selection, index) => ({
              id: `selection:request-${index + 1}`,
              selection,
            })),
          };
    const recorded = await recordDisplayedSuggestionSet(store, index.index, route.sessionId, {
      id: parsedRequest.data.id,
      selection: requestSelection,
    });
    if (recorded.status !== "committed") {
      writeRepositoryFailure(response, recorded);
      return;
    }
    writeValidatedJson(response, recorded.replayed ? 200 : 201, proofHttpSuggestionResponseSchema, {
      suggestionSet: recorded.suggestionSet,
      replayed: recorded.replayed,
      transitionClasses: transitionClassesFor(definitions, recorded.suggestionSet),
    });
    return;
  }

  if (route.kind === "suggestion" && request.method === "GET") {
    const loaded = await readDisplayedSuggestionSet(store, route.sessionId, route.suggestionSetId);
    if (loaded.status !== "loaded") {
      writeRepositoryFailure(response, loaded);
      return;
    }
    writeValidatedJson(response, 200, proofHttpSuggestionResponseSchema, {
      suggestionSet: loaded.suggestionSet,
      transitionClasses: transitionClassesFor(definitions, loaded.suggestionSet),
    });
    return;
  }

  if (route.kind === "preview-collection" && request.method === "POST") {
    const choice = await readStrictJsonRequest(request, proofHttpMoveChoiceRequestSchema);
    if (!choice.ok) {
      writeJson(response, choice.status, invalidRequest(choice.message));
      return;
    }
    const materialized = await materializeMoveChoice(
      store,
      route.sessionId,
      choice.value,
      definitions,
    );
    if (materialized.status !== "materialized") {
      writeMaterializationFailure(response, materialized);
      return;
    }
    const recorded = await recordMovePreview(store, route.sessionId, materialized.request, {
      definitions,
      regeneration: { commandId: choice.value.commandId, actor: WEB_ACTOR },
      ...(now === undefined ? {} : { now }),
    });
    if (recorded.status !== "committed") {
      writeRepositoryFailure(response, recorded);
      return;
    }
    const loaded = await loadCurrentProofSession(store, route.sessionId);
    if (loaded.status !== "loaded") {
      writeRepositoryFailure(response, loaded);
      return;
    }
    if (recorded.preview.nodeId !== loaded.node.id) {
      writeJson(response, 409, {
        diagnostics: [
          {
            code: "preview-rejected",
            message: "The stored preview is stale for the session's current proof node.",
          },
        ],
      });
      return;
    }
    const schema = proofHttpPreviewResponseSchema.extend({
      preview: createMovePreviewSchema({ operators: loaded.session.operators }),
    });
    writeValidatedJson(response, recorded.replayed ? 200 : 201, schema, {
      preview: recorded.preview,
      replayed: recorded.replayed,
      ...(recorded.regeneratedFrom === undefined
        ? {}
        : { regeneratedFrom: recorded.regeneratedFrom }),
    });
    return;
  }

  if (route.kind === "command-collection" && request.method === "POST") {
    const command = await readStrictJsonRequest(request, proofHttpCommandRequestSchema);
    if (!command.ok) {
      writeJson(response, command.status, invalidRequest(command.message));
      return;
    }
    const { inquiryMethod, ...choice } = command.value;
    const materialized = await materializeMoveChoice(store, route.sessionId, choice, definitions);
    if (materialized.status !== "materialized") {
      writeMaterializationFailure(response, materialized);
      return;
    }
    const recordedPreview = await recordMovePreview(store, route.sessionId, materialized.request, {
      definitions,
      regeneration: { commandId: choice.commandId, actor: WEB_ACTOR },
      ...(now === undefined ? {} : { now }),
    });
    if (recordedPreview.status !== "committed") {
      writeRepositoryFailure(response, recordedPreview);
      return;
    }
    if (recordedPreview.regeneratedFrom !== undefined && !recordedPreview.replayed) {
      // The previewed definitions changed. The fresh preview is recorded, never applied unseen:
      // the client shows it and confirms by repeating the command.
      const loaded = await loadCurrentProofSession(store, route.sessionId);
      if (loaded.status !== "loaded") {
        writeRepositoryFailure(response, loaded);
        return;
      }
      writeValidatedJson(
        response,
        409,
        previewRegeneratedResponseSchema.extend({
          preview: createMovePreviewSchema({ operators: loaded.session.operators }),
        }),
        {
          status: "preview-regenerated",
          stalePreviewId: recordedPreview.regeneratedFrom,
          preview: recordedPreview.preview,
          diagnostics: [
            {
              code: "preview-regenerated",
              message:
                "The approved definitions behind the preview changed; review the regenerated preview before applying.",
            },
          ],
        },
      );
      return;
    }
    const ids = derivedMoveRecordIds(choice.commandId);
    const proofCommand = {
      commandId: choice.commandId,
      kind: "apply-kernel-operation",
      actor: WEB_ACTOR,
      parentNodeId: recordedPreview.preview.nodeId,
      resultNodeId: ids.resultNodeId,
      edgeId: ids.edgeId,
      eventId: ids.eventId,
      moveId: recordedPreview.preview.moveId,
      suggestionSetId: recordedPreview.preview.suggestionSetId,
      chosenSuggestionId: recordedPreview.preview.chosenSuggestionId,
      previewId: recordedPreview.preview.id,
      operation: recordedPreview.preview.operation,
      ...(recordedPreview.preview.menuSelection === undefined
        ? {}
        : { menuSelection: recordedPreview.preview.menuSelection }),
    };
    const executed =
      inquiryMethod === "try-result"
        ? await executeTryResultCommand(store, route.sessionId, proofCommand, WEB_ACTOR, {
            definitions,
            ...(now === undefined ? {} : { now }),
          })
        : await executeProofCommand(store, route.sessionId, proofCommand, WEB_ACTOR, definitions);
    if (executed.status !== "committed") {
      writeRepositoryFailure(response, executed);
      return;
    }
    const loaded = await loadCurrentProofSession(store, route.sessionId);
    if (loaded.status !== "loaded") {
      writeRepositoryFailure(response, loaded);
      return;
    }
    const schema = proofHttpCommandResponseSchema.extend({
      node: createProofNodeSchema({ operators: loaded.session.operators }),
    });
    writeValidatedJson(response, executed.replayed ? 200 : 201, schema, {
      session: withoutMetadata(loaded.session),
      node: loaded.node,
      receipt: executed.result.receipt,
      replayed: executed.replayed,
      ...("records" in executed ? { inquiryRecords: executed.records } : {}),
    });
    return;
  }

  if (route.kind === "hypothesis-investigations" && request.method === "POST") {
    const requested = await readStrictJsonRequest(
      request,
      proofHttpHypothesisInvestigationRequestSchema,
    );
    if (!requested.ok) {
      writeJson(response, requested.status, invalidRequest(requested.message));
      return;
    }
    const recorded = await investigateHypothesis(
      store,
      route.sessionId,
      requested.value,
      WEB_ACTOR,
      { definitions, ...(now === undefined ? {} : { now }) },
    );
    if (recorded.status !== "committed") {
      writeRepositoryFailure(response, recorded);
      return;
    }
    writeValidatedJson(
      response,
      recorded.replayed ? 200 : 201,
      proofHttpInquiryCommandResponseSchema,
      { records: recorded.records, replayed: recorded.replayed },
    );
    return;
  }

  if (route.kind === "interaction-events" && request.method === "POST") {
    const requested = await readStrictJsonRequest(request, proofHttpInteractionEventRequestSchema);
    if (!requested.ok) {
      writeJson(response, requested.status, invalidRequest(requested.message));
      return;
    }
    const recorded = await recordInteractionEvent(
      store,
      route.sessionId,
      requested.value,
      WEB_ACTOR,
      now === undefined ? {} : { now },
    );
    if (recorded.status !== "committed") {
      writeRepositoryFailure(response, recorded);
      return;
    }
    writeValidatedJson(
      response,
      recorded.replayed ? 200 : 201,
      proofHttpInteractionEventResponseSchema,
      { event: recorded.event, replayed: recorded.replayed },
    );
    return;
  }

  if (route.kind === "interaction-events" && request.method === "GET") {
    const query = interactionEventQuery(request.url);
    if (query === undefined) {
      writeJson(response, 400, invalidRequest("The interaction-event query is invalid."));
      return;
    }
    const listed = await listInteractionEvents(store, route.sessionId, query);
    if (listed.status !== "loaded") {
      writeRepositoryFailure(response, listed);
      return;
    }
    writeValidatedJson(response, 200, proofHttpInteractionEventListResponseSchema, {
      events: listed.events,
    });
    return;
  }

  if (route.kind === "inquiry-commands" && request.method === "POST") {
    const requested = await readStrictJsonRequest(request, proofHttpInquiryCommandRequestSchema);
    if (!requested.ok) {
      writeJson(response, requested.status, invalidRequest(requested.message));
      return;
    }
    const recorded = await recordInquiryCommand(
      store,
      route.sessionId,
      requested.value,
      WEB_ACTOR,
      {
        definitions,
        ...(now === undefined ? {} : { now }),
      },
    );
    if (recorded.status !== "committed") {
      writeRepositoryFailure(response, recorded);
      return;
    }
    writeValidatedJson(
      response,
      recorded.replayed ? 200 : 201,
      proofHttpInquiryCommandResponseSchema,
      { records: recorded.records, replayed: recorded.replayed },
    );
    return;
  }

  if (route.kind === "inquiry-records" && request.method === "GET") {
    const query = inquiryRecordQuery(request.url);
    if (query === undefined) {
      writeJson(response, 400, invalidRequest("The inquiry-record query is invalid."));
      return;
    }
    const listed = await listInquiryRecords(store, route.sessionId, query);
    if (listed.status !== "loaded") {
      writeRepositoryFailure(response, listed);
      return;
    }
    writeValidatedJson(response, 200, proofHttpInquiryRecordListResponseSchema, {
      records: listed.records,
    });
    return;
  }

  if (route.kind === "history" && request.method === "GET") {
    const history = await loadProofHistory(store, route.sessionId);
    if (history.status !== "loaded") {
      writeRepositoryFailure(response, history);
      return;
    }
    const schema = proofHttpHistoryResponseSchema.extend({
      nodes: z.array(createProofNodeSchema({ operators: history.session.operators })),
      edges: z.array(
        z
          .object({
            edge: createProofEdgeSchema({ operators: history.session.operators }),
            name: z.string().min(1),
          })
          .strict(),
      ),
    });
    writeValidatedJson(response, 200, schema, {
      session: withoutMetadata(history.session),
      nodes: history.nodes,
      edges: history.edges,
    });
    return;
  }

  if (route.kind === "backtrack" && request.method === "POST") {
    const requested = await readStrictJsonRequest(request, proofHttpBacktrackRequestSchema);
    if (!requested.ok) {
      writeJson(response, requested.status, invalidRequest(requested.message));
      return;
    }
    const backtracked = await backtrackProofSession(store, route.sessionId, requested.value);
    if (backtracked.status !== "committed") {
      writeRepositoryFailure(response, backtracked);
      return;
    }
    const schema = proofHttpBacktrackResponseSchema.extend({
      node: createProofNodeSchema({ operators: backtracked.session.operators }),
    });
    writeValidatedJson(response, 200, schema, {
      session: withoutMetadata(backtracked.session),
      node: backtracked.node,
      replayed: backtracked.replayed,
    });
    return;
  }

  if (route.kind === "delete-previous-move" && request.method === "POST") {
    const requested = await readStrictJsonRequest(
      request,
      proofHttpDeletePreviousMoveRequestSchema,
    );
    if (!requested.ok) {
      writeJson(response, requested.status, invalidRequest(requested.message));
      return;
    }
    const deleted = await deletePreviousMove(
      store,
      route.sessionId,
      { ...requested.value, actor: WEB_ACTOR },
      WEB_ACTOR,
    );
    if (deleted.status !== "committed") {
      writeRepositoryFailure(response, deleted);
      return;
    }
    const loaded = await loadCurrentProofSession(store, route.sessionId);
    if (loaded.status !== "loaded") {
      writeRepositoryFailure(response, loaded);
      return;
    }
    const schema = proofHttpDeletePreviousMoveResponseSchema.extend({
      node: createProofNodeSchema({ operators: loaded.session.operators }),
    });
    writeValidatedJson(response, 200, schema, {
      session: withoutMetadata(loaded.session),
      node: loaded.node,
      receipt: deleted.receipt,
      replayed: deleted.replayed,
    });
    return;
  }

  if (route.kind === "backtrack-analysis" && request.method === "POST") {
    const requested = await readStrictJsonRequest(request, proofHttpBacktrackAnalysisRequestSchema);
    if (!requested.ok) {
      writeJson(response, requested.status, invalidRequest(requested.message));
      return;
    }
    const analyzed = await analyzeBacktrackWithInformation(store, route.sessionId, requested.value);
    if (analyzed.status !== "loaded") {
      writeRepositoryFailure(response, analyzed);
      return;
    }
    writeValidatedJson(response, 200, proofHttpBacktrackAnalysisResponseSchema, {
      analysis: analyzed.analysis,
    });
    return;
  }

  if (route.kind === "backtrack-with-information" && request.method === "POST") {
    const requested = await readStrictJsonRequest(
      request,
      proofHttpBacktrackWithInformationRequestSchema,
    );
    if (!requested.ok) {
      writeJson(response, requested.status, invalidRequest(requested.message));
      return;
    }
    const backtracked = await backtrackWithInformation(
      store,
      route.sessionId,
      { ...requested.value, actor: WEB_ACTOR },
      WEB_ACTOR,
      { definitions, ...(now === undefined ? {} : { now }) },
    );
    if (backtracked.status !== "committed") {
      writeRepositoryFailure(response, backtracked);
      return;
    }
    const schema = proofHttpBacktrackWithInformationResponseSchema.extend({
      node: createProofNodeSchema({ operators: backtracked.session.operators }),
    });
    writeValidatedJson(response, backtracked.replayed ? 200 : 201, schema, {
      session: withoutMetadata(backtracked.session),
      node: backtracked.node,
      receipts: backtracked.receipts,
      backtrack: backtracked.backtrack,
      replayed: backtracked.replayed,
    });
    return;
  }

  if (route.kind === "replay-preview" && request.method === "POST") {
    const requested = await readStrictJsonRequest(request, proofHttpReplayPreviewRequestSchema);
    if (!requested.ok) {
      writeJson(response, requested.status, invalidRequest(requested.message));
      return;
    }
    const previewed = await previewSemanticReplay(
      store,
      route.sessionId,
      requested.value,
      WEB_ACTOR,
      { definitions },
    );
    if (previewed.status !== "loaded") {
      writeRepositoryFailure(response, previewed);
      return;
    }
    const loaded = await loadCurrentProofSession(store, route.sessionId);
    if (loaded.status !== "loaded") {
      writeRepositoryFailure(response, loaded);
      return;
    }
    writeValidatedJson(
      response,
      200,
      proofHttpReplayPreviewResponseSchema.extend({
        finalNode: createProofNodeSchema({ operators: loaded.session.operators }),
      }),
      { report: previewed.report, finalNode: previewed.finalNode },
    );
    return;
  }

  if (route.kind === "replay" && request.method === "POST") {
    const requested = await readStrictJsonRequest(request, proofHttpReplayRequestSchema);
    if (!requested.ok) {
      writeJson(response, requested.status, invalidRequest(requested.message));
      return;
    }
    const committed = await commitSemanticReplay(
      store,
      route.sessionId,
      { ...requested.value, actor: WEB_ACTOR },
      WEB_ACTOR,
      { definitions, ...(now === undefined ? {} : { now }) },
    );
    if (committed.status === "replay-failed") {
      writeValidatedJson(response, 422, proofHttpReplayFailedResponseSchema, {
        status: "replay-failed",
        report: committed.report,
        diagnostics: [
          {
            code: "replay-failed",
            message: committed.report.firstFailure?.diagnostic.message ?? "A replayed step failed.",
          },
        ],
      });
      return;
    }
    if (committed.status !== "committed") {
      writeRepositoryFailure(response, committed);
      return;
    }
    const schema = proofHttpReplayResponseSchema.extend({
      node: createProofNodeSchema({ operators: committed.session.operators }),
    });
    writeValidatedJson(response, committed.replayed ? 200 : 201, schema, {
      session: withoutMetadata(committed.session),
      node: committed.node,
      receipts: committed.receipts,
      report: committed.report,
      replayed: committed.replayed,
    });
    return;
  }

  response.setHeader(
    "allow",
    route.kind === "interaction-events"
      ? "GET, POST"
      : route.kind === "session" ||
          route.kind === "suggestion" ||
          route.kind === "history" ||
          route.kind === "inquiry-records"
        ? "GET"
        : "POST",
  );
  writeJson(response, 405, invalidRequest("The HTTP method is not supported for this resource."));
}

type ParsedRoute =
  | Readonly<{ kind: "session"; sessionId: string }>
  | Readonly<{ kind: "suggestion-collection"; sessionId: string }>
  | Readonly<{ kind: "suggestion"; sessionId: string; suggestionSetId: string }>
  | Readonly<{ kind: "preview-collection"; sessionId: string }>
  | Readonly<{ kind: "command-collection"; sessionId: string }>
  | Readonly<{ kind: "history"; sessionId: string }>
  | Readonly<{ kind: "backtrack"; sessionId: string }>
  | Readonly<{ kind: "delete-previous-move"; sessionId: string }>
  | Readonly<{ kind: "backtrack-analysis"; sessionId: string }>
  | Readonly<{ kind: "backtrack-with-information"; sessionId: string }>
  | Readonly<{ kind: "replay-preview"; sessionId: string }>
  | Readonly<{ kind: "replay"; sessionId: string }>
  | Readonly<{ kind: "interaction-events"; sessionId: string }>
  | Readonly<{ kind: "inquiry-commands"; sessionId: string }>
  | Readonly<{ kind: "inquiry-records"; sessionId: string }>
  | Readonly<{ kind: "hypothesis-investigations"; sessionId: string }>;

function parseRoute(requestTarget: string | undefined): ParsedRoute | undefined {
  try {
    const url = new URL(requestTarget ?? "/", "http://proof.local");
    const segments = url.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
    if (segments[0] !== "proof-sessions" || segments[1] === undefined) return undefined;
    const sessionId = proofSessionIdSchema.safeParse(segments[1]);
    if (!sessionId.success) return undefined;
    if (segments.length === 2) return { kind: "session", sessionId: sessionId.data };
    if (segments.length === 3) {
      if (segments[2] === "suggestion-sets") {
        return { kind: "suggestion-collection", sessionId: sessionId.data };
      }
      if (segments[2] === "move-previews") {
        return { kind: "preview-collection", sessionId: sessionId.data };
      }
      if (segments[2] === "commands") {
        return { kind: "command-collection", sessionId: sessionId.data };
      }
      if (segments[2] === "history") return { kind: "history", sessionId: sessionId.data };
      if (segments[2] === "backtrack") return { kind: "backtrack", sessionId: sessionId.data };
      if (segments[2] === "delete-previous-move") {
        return { kind: "delete-previous-move", sessionId: sessionId.data };
      }
      if (segments[2] === "backtrack-analysis") {
        return { kind: "backtrack-analysis", sessionId: sessionId.data };
      }
      if (segments[2] === "backtrack-with-information") {
        return { kind: "backtrack-with-information", sessionId: sessionId.data };
      }
      if (segments[2] === "replay-preview") {
        return { kind: "replay-preview", sessionId: sessionId.data };
      }
      if (segments[2] === "replay") return { kind: "replay", sessionId: sessionId.data };
      if (segments[2] === "interaction-events") {
        return { kind: "interaction-events", sessionId: sessionId.data };
      }
      if (segments[2] === "inquiry-commands") {
        return { kind: "inquiry-commands", sessionId: sessionId.data };
      }
      if (segments[2] === "inquiry-records") {
        return { kind: "inquiry-records", sessionId: sessionId.data };
      }
      if (segments[2] === "hypothesis-investigations") {
        return { kind: "hypothesis-investigations", sessionId: sessionId.data };
      }
      return undefined;
    }
    if (segments[2] !== "suggestion-sets" || segments.length !== 4 || segments[3] === undefined) {
      return undefined;
    }
    const suggestionSetId = suggestionSetIdSchema.safeParse(segments[3]);
    return suggestionSetId.success
      ? { kind: "suggestion", sessionId: sessionId.data, suggestionSetId: suggestionSetId.data }
      : undefined;
  } catch {
    return undefined;
  }
}

/** `?nodeId=…&after=…&limit=…`; each parameter at most once. */
function interactionEventQuery(
  requestTarget: string | undefined,
): z.infer<typeof interactionEventQuerySchema> | undefined {
  try {
    const url = new URL(requestTarget ?? "/", "http://proof.local");
    const allowed = ["nodeId", "after", "limit"];
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => !allowed.includes(key)) || new Set(keys).size !== keys.length) {
      return undefined;
    }
    const integer = (value: string | null): number | undefined | null =>
      value === null ? undefined : /^(0|[1-9][0-9]{0,9})$/.test(value) ? Number(value) : null;
    const after = integer(url.searchParams.get("after"));
    const limit = integer(url.searchParams.get("limit"));
    if (after === null || limit === null) return undefined;
    const nodeId = url.searchParams.get("nodeId");
    const parsed = interactionEventQuerySchema.safeParse({
      ...(nodeId === null ? {} : { nodeId }),
      ...(after === undefined ? {} : { afterSequence: after }),
      ...(limit === undefined ? {} : { limit }),
    });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** `?nodeId=…&commandId=…&after=…&limit=…`; each parameter at most once. */
function inquiryRecordQuery(
  requestTarget: string | undefined,
): z.infer<typeof inquiryRecordQuerySchema> | undefined {
  try {
    const url = new URL(requestTarget ?? "/", "http://proof.local");
    const allowed = ["nodeId", "commandId", "after", "limit"];
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => !allowed.includes(key)) || new Set(keys).size !== keys.length) {
      return undefined;
    }
    const integer = (value: string | null): number | undefined | null =>
      value === null ? undefined : /^(0|[1-9][0-9]{0,9})$/.test(value) ? Number(value) : null;
    const after = integer(url.searchParams.get("after"));
    const limit = integer(url.searchParams.get("limit"));
    if (after === null || limit === null) return undefined;
    const nodeId = url.searchParams.get("nodeId");
    const commandId = url.searchParams.get("commandId");
    const parsed = inquiryRecordQuerySchema.safeParse({
      ...(nodeId === null ? {} : { nodeId }),
      ...(commandId === null ? {} : { commandId }),
      ...(after === undefined ? {} : { afterSequence: after }),
      ...(limit === undefined ? {} : { limit }),
    });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function approvedRetrievalIndex(
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

type JsonBodyResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; status: 400 | 413; message: string }>;

type StrictJsonRequestResult<Output> =
  | Readonly<{ ok: true; value: Output }>
  | Readonly<{ ok: false; status: 400 | 413 | 415; message: string }>;

async function readStrictJsonRequest<Output>(
  request: IncomingMessage,
  schema: z.ZodType<Output>,
): Promise<StrictJsonRequestResult<Output>> {
  if (!hasJsonContentType(request)) {
    return { ok: false, status: 415, message: "Content-Type must be application/json." };
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body;
  const parsed = schema.safeParse(body.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, status: 400, message: "The JSON request does not match its strict schema." };
}

async function readJsonBody(request: IncomingMessage): Promise<JsonBodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  try {
    for await (const input of request) {
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input as Uint8Array);
      size += chunk.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
      } else {
        chunks.push(chunk);
      }
    }
    if (tooLarge) return { ok: false, status: 413, message: "The JSON request body is too large." };
    if (size === 0) return { ok: false, status: 400, message: "A JSON request body is required." };
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400, message: "The JSON request body is malformed." };
  }
}

function hasJsonContentType(request: IncomingMessage): boolean {
  return (
    request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
  );
}

function writeRepositoryFailure(response: ServerResponse, failure: RepositoryFailure): void {
  const code = failure.diagnostics[0].code;
  const status =
    failure.status === "uncertain"
      ? 503
      : code === "session-not-found" ||
          code === "suggestion-set-not-found" ||
          code === "preview-not-found" ||
          code === "current-node-not-found"
        ? 404
        : code === "serialized-stale-command" ||
            code === "serialized-stale-backtrack" ||
            code === "serialized-stale-delete" ||
            code === "delete-requires-confirmation" ||
            code === "command-deleted" ||
            code === "interaction-event-conflict" ||
            code === "inquiry-command-conflict" ||
            code === "backtrack-with-information-conflict" ||
            code === "replay-conflict"
          ? 409
          : code === "backtrack-symbols-unavailable"
            ? 422
            : code === "suggestion-set-rejected" ||
                code === "preview-rejected" ||
                code === "command-rejected" ||
                code === "backtrack-rejected" ||
                code === "delete-rejected" ||
                code === "interaction-event-rejected" ||
                code === "inquiry-command-rejected" ||
                code === "backtrack-with-information-rejected" ||
                code === "replay-rejected"
              ? 400
              : 500;
  writeJson(response, status, { diagnostics: failure.diagnostics });
}

/**
 * A choice that still needs menu input is not a malformed request: the worker answers 422 with
 * the menus to choose from and the parameters still missing. Nothing is recorded.
 */
function writeMaterializationFailure(
  response: ServerResponse,
  failure: Exclude<MaterializeMoveChoiceResult, { status: "materialized" }>,
): void {
  if (failure.status !== "requires-input") {
    writeRepositoryFailure(response, failure);
    return;
  }
  writeValidatedJson(response, 422, moveRequiresInputResponseSchema, failure);
}

function transitionClassesFor(
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

function invalidRequest(message: string): unknown {
  return { diagnostics: [{ code: "invalid-request", message }] };
}

function notFound(message: string): unknown {
  return { diagnostics: [{ code: "not-found", message }] };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function writeValidatedJson<Output>(
  response: ServerResponse,
  status: number,
  schema: z.ZodType<Output>,
  body: unknown,
): void {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    writeJson(response, 500, {
      diagnostics: [
        { code: "invalid-response", message: "The response failed runtime validation." },
      ],
    });
    return;
  }
  writeJson(response, status, parsed.data);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function originFor(address: AddressInfo, requestedHost: string): string {
  const host = requestedHost.includes(":") ? `[${requestedHost}]` : requestedHost;
  return `http://${host}:${address.port}`;
}
