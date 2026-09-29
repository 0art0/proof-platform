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
  suggestionSetIdSchema,
  observeQuerySchema,
  protocolCommandEnvelopeSchema,
  type ObserveQuery,
} from "@proof/protocol";
import type { Pool } from "pg";
import { z } from "zod";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "../approved-catalog";
import { hypothesisInvestigationRequestSchema, investigateHypothesis } from "../inquiry-methods";
import {
  inquiryRecordQuerySchema,
  listInquiryRecords,
  recordInquiryCommand,
} from "../inquiry-repository";
import type { LibraryStore } from "../library-repository";
import { postgresProofStore } from "../postgres-proof-store";
import { handleArtifactRoute } from "./artifact-routes";
import { handleLibraryRoute } from "./library-routes";
import { handleProblemSetupRoute } from "./problem-setup-routes";
import { handleObserve, handleProtocolCommand } from "./protocol-commands";
import {
  applyMoveChoice,
  previewMoveChoice,
  proofHttpSelectionDescriptorSchema,
  proofHttpTransitionClassificationSchema,
  recordSuggestions,
  repositoryFailureStatus,
  transitionClassesFor,
  type ServiceContext,
} from "./shared";
import {
  analyzeBacktrackWithInformation,
  backtrackProofSession,
  backtrackProofSessionSchema,
  backtrackWithInformation,
  deletePreviousMove,
  interactionEventQuerySchema,
  listInteractionEvents,
  loadProofHistory,
  loadCurrentProofSession,
  moveChoiceSchema,
  proofSessionSchema,
  proofSessionIdSchema,
  readDisplayedSuggestionSet,
  recordInteractionEvent,
  type ProofSession,
  type ProofStore,
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

export { proofHttpSelectionDescriptorSchema, proofHttpTransitionClassificationSchema };

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
  /** The session library store; library commands of the envelope need it. */
  library?: LibraryStore;
}>;

type HandlerContext = ServiceContext;

/** Create the dependency-free product HTTP boundary over a proof repository. */
export function createProofHttpService(
  store: ProofStore,
  options: ProofHttpServiceOptions = {},
): ProofHttpService {
  const context: HandlerContext = {
    store,
    definitions: options.definitions ?? APPROVED_DEFINITIONS,
    now: options.now,
    library: options.library,
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
  context: HandlerContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (await handleProblemSetupRoute(context, request, response)) return;
  if (await handleArtifactRoute(context, request, response)) return;
  if (await handleLibraryRoute(context, request, response)) return;
  const { store, definitions, now } = context;
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

    const recorded = await recordSuggestions(
      context,
      route.sessionId,
      parsedRequest.data.id,
      parsedRequest.data.selections,
    );
    if (recorded.status === "invalid-catalog") {
      writeJson(response, 500, {
        diagnostics: [{ code: "invalid-catalog", message: recorded.message }],
      });
      return;
    }
    if (recorded.status === "failed") {
      writeRepositoryFailure(response, recorded.failure);
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
    const previewed = await previewMoveChoice(context, route.sessionId, choice.value, WEB_ACTOR);
    if (previewed.status === "requires-input") {
      writeValidatedJson(response, 422, moveRequiresInputResponseSchema, previewed.input);
      return;
    }
    if (previewed.status === "failed") {
      writeRepositoryFailure(response, previewed.failure);
      return;
    }
    if (previewed.status === "stale-preview") {
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
      preview: createMovePreviewSchema({ operators: previewed.operators }),
    });
    writeValidatedJson(response, previewed.replayed ? 200 : 201, schema, {
      preview: previewed.preview,
      replayed: previewed.replayed,
      ...(previewed.regeneratedFrom === undefined
        ? {}
        : { regeneratedFrom: previewed.regeneratedFrom }),
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
    const applied = await applyMoveChoice(
      context,
      route.sessionId,
      choice,
      inquiryMethod,
      WEB_ACTOR,
    );
    if (applied.status === "requires-input") {
      writeValidatedJson(response, 422, moveRequiresInputResponseSchema, applied.input);
      return;
    }
    if (applied.status === "failed") {
      writeRepositoryFailure(response, applied.failure);
      return;
    }
    if (applied.status === "preview-regenerated") {
      // The previewed definitions changed. The fresh preview is recorded, never applied unseen:
      // the client shows it and confirms by repeating the command.
      writeValidatedJson(
        response,
        409,
        previewRegeneratedResponseSchema.extend({
          preview: createMovePreviewSchema({ operators: applied.operators }),
        }),
        {
          status: "preview-regenerated",
          stalePreviewId: applied.stalePreviewId,
          preview: applied.preview,
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
    const { executed } = applied;
    const schema = proofHttpCommandResponseSchema.extend({
      node: createProofNodeSchema({ operators: applied.session.operators }),
    });
    writeValidatedJson(response, executed.replayed ? 200 : 201, schema, {
      session: withoutMetadata(applied.session),
      node: applied.node,
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

  if (route.kind === "protocol-commands" && request.method === "POST") {
    const envelope = await readStrictJsonRequest(request, protocolCommandEnvelopeSchema);
    if (!envelope.ok) {
      writeJson(response, envelope.status, invalidRequest(envelope.message));
      return;
    }
    const outcome = await handleProtocolCommand(context, route.sessionId, envelope.value);
    writeJson(response, outcome.status, outcome.body);
    return;
  }

  if (route.kind === "observe" && request.method === "GET") {
    const query = observeQuery(request.url);
    if (query === undefined) {
      writeJson(response, 400, invalidRequest("The observe query is invalid."));
      return;
    }
    const outcome = await handleObserve(context, route.sessionId, query);
    writeJson(response, outcome.status, outcome.body);
    return;
  }

  response.setHeader(
    "allow",
    route.kind === "interaction-events"
      ? "GET, POST"
      : route.kind === "session" ||
          route.kind === "suggestion" ||
          route.kind === "history" ||
          route.kind === "inquiry-records" ||
          route.kind === "observe"
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
  | Readonly<{ kind: "hypothesis-investigations"; sessionId: string }>
  | Readonly<{ kind: "protocol-commands"; sessionId: string }>
  | Readonly<{ kind: "observe"; sessionId: string }>;

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
      if (segments[2] === "protocol-commands") {
        return { kind: "protocol-commands", sessionId: sessionId.data };
      }
      if (segments[2] === "observe") return { kind: "observe", sessionId: sessionId.data };
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

/** `?view=…&sinceNode=…&afterEvent=…&afterInquiry=…`; each parameter at most once. */
function observeQuery(requestTarget: string | undefined): ObserveQuery | undefined {
  try {
    const url = new URL(requestTarget ?? "/", "http://proof.local");
    const allowed = ["view", "sinceNode", "afterEvent", "afterInquiry"];
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => !allowed.includes(key)) || new Set(keys).size !== keys.length) {
      return undefined;
    }
    const integer = (value: string | null): number | undefined | null =>
      value === null ? undefined : /^(0|[1-9][0-9]{0,9})$/.test(value) ? Number(value) : null;
    const afterEvent = integer(url.searchParams.get("afterEvent"));
    const afterInquiry = integer(url.searchParams.get("afterInquiry"));
    if (afterEvent === null || afterInquiry === null) return undefined;
    const view = url.searchParams.get("view");
    const sinceNode = url.searchParams.get("sinceNode");
    const parsed = observeQuerySchema.safeParse({
      ...(view === null ? {} : { view }),
      ...(sinceNode === null ? {} : { sinceNode }),
      ...(afterEvent === undefined ? {} : { afterEvent }),
      ...(afterInquiry === undefined ? {} : { afterInquiry }),
    });
    return parsed.success ? parsed.data : undefined;
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

function writeRepositoryFailure(
  response: ServerResponse,
  failure: Readonly<{ status: "rejected" | "uncertain"; diagnostics: readonly [{ code: string }] }>,
): void {
  writeJson(response, repositoryFailureStatus(failure), { diagnostics: failure.diagnostics });
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
