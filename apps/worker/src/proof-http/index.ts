import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CORE_LOGIC_RESULTS } from "@proof/library";
import { HAND_AUTHORED_MOVES } from "@proof/moves";
import {
  stableIdentifierSchema,
  suggestionSetIdSchema,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { createRetrievalIndex, type RetrievalIndex } from "@proof/retrieval";
import type { Pool } from "pg";
import { z } from "zod";
import { postgresProofStore } from "../postgres-proof-store";
import {
  loadCurrentProofSession,
  proofSessionIdSchema,
  readDisplayedSuggestionSet,
  recordDisplayedSuggestionSet,
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
    writeJson(response, 200, { session: loaded.session, node: loaded.node });
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
    writeJson(response, recorded.replayed ? 200 : 201, {
      suggestionSet: recorded.suggestionSet,
      replayed: recorded.replayed,
    });
    return;
  }

  if (route.kind === "suggestion" && request.method === "GET") {
    const loaded = await readDisplayedSuggestionSet(store, route.sessionId, route.suggestionSetId);
    if (loaded.status !== "loaded") {
      writeRepositoryFailure(response, loaded);
      return;
    }
    writeJson(response, 200, { suggestionSet: loaded.suggestionSet });
    return;
  }

  response.setHeader("allow", route.kind === "suggestion-collection" ? "POST" : "GET");
  writeJson(response, 405, invalidRequest("The HTTP method is not supported for this resource."));
}

type ParsedRoute =
  | Readonly<{ kind: "session"; sessionId: string }>
  | Readonly<{ kind: "suggestion-collection"; sessionId: string }>
  | Readonly<{ kind: "suggestion"; sessionId: string; suggestionSetId: string }>;

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
    if (segments[2] !== "suggestion-sets") return undefined;
    if (segments.length === 3) return { kind: "suggestion-collection", sessionId: sessionId.data };
    if (segments.length !== 4 || segments[3] === undefined) return undefined;
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
      : code === "session-not-found" || code === "suggestion-set-not-found"
        ? 404
        : code === "suggestion-set-rejected"
          ? 400
          : 500;
  writeJson(response, status, { diagnostics: failure.diagnostics });
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
