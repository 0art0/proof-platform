import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CORE_LOGIC_RESULTS } from "@proof/library";
import { HAND_AUTHORED_MOVES } from "@proof/moves";
import {
  actorSchema,
  createMovePreviewSchema,
  createProofEdgeSchema,
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  proofCommandReceiptSchema,
  stableIdentifierSchema,
  suggestionIdSchema,
  suggestionSetIdSchema,
  transitionClassSchema,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { createRetrievalIndex, type RetrievalIndex } from "@proof/retrieval";
import type { Pool } from "pg";
import { z } from "zod";
import { postgresProofStore } from "../postgres-proof-store";
import {
  backtrackProofSession,
  backtrackProofSessionSchema,
  derivedMoveRecordIds,
  executeProofCommand,
  loadProofHistory,
  loadCurrentProofSession,
  materializeMoveChoice,
  moveChoiceSchema,
  proofSessionSchema,
  proofSessionIdSchema,
  readDisplayedSuggestionSet,
  recordDisplayedSuggestionSet,
  recordMovePreview,
  type ProofStore,
  type RepositoryFailure,
} from "../proof-repository";

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
export const proofHttpBacktrackRequestSchema = backtrackProofSessionSchema;

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
  .object({ preview: z.unknown(), replayed: z.boolean() })
  .strict();

export const proofHttpCommandResponseSchema = z
  .object({
    session: proofSessionSchema,
    node: z.unknown(),
    receipt: proofCommandReceiptSchema,
    replayed: z.boolean(),
  })
  .strict();

export const proofHttpHistoryResponseSchema = z
  .object({
    session: proofSessionSchema,
    nodes: z.array(z.unknown()),
    edges: z.array(z.object({ edge: z.unknown(), name: z.string().min(1) }).strict()),
  })
  .strict();

export const proofHttpBacktrackResponseSchema = z
  .object({ session: proofSessionSchema, node: z.unknown(), replayed: z.boolean() })
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

/** Create the dependency-free product HTTP boundary over a proof repository. */
export function createProofHttpService(store: ProofStore): ProofHttpService {
  const server = createServer((request, response) => {
    void handleRequest(store, request, response).catch(() => {
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
  store: ProofStore,
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
    writeValidatedJson(
      response,
      200,
      z
        .object({
          session: proofSessionSchema,
          node: createProofNodeSchema({ operators: loaded.session.operators }),
        })
        .strict(),
      { session: loaded.session, node: loaded.node },
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
    const index = approvedRetrievalIndex(loaded.session.operators);
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
      transitionClasses: transitionClassesFor(recorded.suggestionSet),
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
      transitionClasses: transitionClassesFor(loaded.suggestionSet),
    });
    return;
  }

  if (route.kind === "preview-collection" && request.method === "POST") {
    const choice = await readStrictJsonRequest(request, proofHttpMoveChoiceRequestSchema);
    if (!choice.ok) {
      writeJson(response, choice.status, invalidRequest(choice.message));
      return;
    }
    const materialized = await materializeMoveChoice(store, route.sessionId, choice.value);
    if (materialized.status !== "materialized") {
      writeRepositoryFailure(response, materialized);
      return;
    }
    const recorded = await recordMovePreview(store, route.sessionId, materialized.request);
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
    });
    return;
  }

  if (route.kind === "command-collection" && request.method === "POST") {
    const choice = await readStrictJsonRequest(request, proofHttpMoveChoiceRequestSchema);
    if (!choice.ok) {
      writeJson(response, choice.status, invalidRequest(choice.message));
      return;
    }
    const materialized = await materializeMoveChoice(store, route.sessionId, choice.value);
    if (materialized.status !== "materialized") {
      writeRepositoryFailure(response, materialized);
      return;
    }
    const recordedPreview = await recordMovePreview(store, route.sessionId, materialized.request);
    if (recordedPreview.status !== "committed") {
      writeRepositoryFailure(response, recordedPreview);
      return;
    }
    const ids = derivedMoveRecordIds(choice.value.commandId);
    const executed = await executeProofCommand(
      store,
      route.sessionId,
      {
        commandId: choice.value.commandId,
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
      },
      WEB_ACTOR,
    );
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
      session: loaded.session,
      node: loaded.node,
      receipt: executed.result.receipt,
      replayed: executed.replayed,
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
      session: history.session,
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
      session: backtracked.session,
      node: backtracked.node,
      replayed: backtracked.replayed,
    });
    return;
  }

  response.setHeader(
    "allow",
    route.kind === "session" || route.kind === "suggestion" || route.kind === "history"
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
  | Readonly<{ kind: "backtrack"; sessionId: string }>;

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

function approvedRetrievalIndex(
  operators: NonNullable<ProtocolEnvironment["operators"]>,
): Readonly<{ ok: true; index: RetrievalIndex }> | Readonly<{ ok: false; message: string }> {
  const result = createRetrievalIndex(
    { results: CORE_LOGIC_RESULTS, moves: HAND_AUTHORED_MOVES, variantFamilies: [] },
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
        : code === "serialized-stale-command" || code === "serialized-stale-backtrack"
          ? 409
          : code === "suggestion-set-rejected" ||
              code === "preview-rejected" ||
              code === "command-rejected" ||
              code === "backtrack-rejected"
            ? 400
            : 500;
  writeJson(response, status, { diagnostics: failure.diagnostics });
}

function transitionClassesFor(
  suggestionSet: z.infer<typeof displayedSuggestionSetSchema>,
): readonly z.infer<typeof proofHttpTransitionClassificationSchema>[] {
  const moves = new Map<string, (typeof HAND_AUTHORED_MOVES)[number]>(
    HAND_AUTHORED_MOVES.map((move) => [move.id, move]),
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
