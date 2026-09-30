/**
 * Authored-move routes (roadmap N35). Writes go through the command envelope
 * (`author-move-draft`, `review-move-draft`); these routes only read and dry-run:
 *
 * - `GET /proof-sessions/:id/authored-moves`: every authored move of the session with its draft
 *   revisions, their recorded reviews, and whether the approved version is retrievable.
 * - `POST /proof-sessions/:id/authored-moves/validate` `{ template }`: run the template's
 *   validation (examples through the kernel) in the session's environment. Nothing is recorded.
 *
 * Also exports the session scoping used by every other route: a request for a session sees the
 * base definitions plus that session's approved authored moves.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { validateMoveTemplate } from "@proof/moves/authoring";
import { readAuthoredMoves, sessionDefinitions } from "../move-authoring";
import { loadSession, proofSessionIdSchema, transactionFailure } from "../proof-repository";
import { repositoryFailureStatus, type ServiceContext } from "./shared";

const MAX_BODY_BYTES = 256 * 1024;

/** The session ID a request URL addresses (`/proof-sessions/:id/...`), if any. */
export function requestSessionId(requestTarget: string | undefined): string | undefined {
  const segments = pathSegments(requestTarget);
  return segments?.[0] === "proof-sessions" ? segments[1] : undefined;
}

/** The context whose definitions include the session's approved authored moves. */
export async function scopedContext(
  context: ServiceContext,
  sessionId: string | undefined,
): Promise<ServiceContext> {
  if (sessionId === undefined || context.library === undefined) return context;
  if (!proofSessionIdSchema.safeParse(sessionId).success) return context;
  const definitions = await sessionDefinitions(context.definitions, context.library, sessionId);
  return definitions === context.definitions ? context : { ...context, definitions };
}

/** Handle an authored-move route; false when the request is for another route. */
export async function handleAuthoredMoveRoute(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const segments = pathSegments(request.url);
  if (
    segments === undefined ||
    segments[0] !== "proof-sessions" ||
    segments[2] !== "authored-moves"
  ) {
    return false;
  }
  const validate = segments.length === 4 && segments[3] === "validate";
  if (segments.length !== 3 && !validate) return false;
  const sessionId = proofSessionIdSchema.safeParse(segments[1]);
  if (!sessionId.success) return false;
  const expected = validate ? "POST" : "GET";
  if (request.method !== expected) {
    response.setHeader("allow", expected);
    writeJson(response, 405, {
      diagnostics: [{ code: "method-not-allowed", message: `Use ${expected}.` }],
    });
    return true;
  }
  if (validate) await handleValidate(context, request, response, sessionId.data);
  else await handleList(context, response, sessionId.data);
  return true;
}

async function sessionBasis(context: ServiceContext, sessionId: string) {
  try {
    return await context.store.transaction(async (transaction) => {
      const loaded = await loadSession(
        transaction,
        sessionId as Parameters<typeof loadSession>[1],
        context.definitions,
      );
      if (!loaded.ok) return { failure: loaded.failure };
      return { operators: loaded.session.operators };
    });
  } catch (error: unknown) {
    return { failure: transactionFailure(error, "The proof session could not be read.") };
  }
}

async function handleList(
  context: ServiceContext,
  response: ServerResponse,
  sessionId: string,
): Promise<void> {
  const basis = await sessionBasis(context, sessionId);
  if ("failure" in basis) {
    writeJson(response, repositoryFailureStatus(basis.failure), {
      diagnostics: basis.failure.diagnostics,
    });
    return;
  }
  if (context.library === undefined) {
    writeJson(response, 200, { sessionId, moves: [] });
    return;
  }
  const read = await readAuthoredMoves(context.library, sessionId);
  if (read.status !== "found") {
    writeJson(response, repositoryFailureStatus(read), { diagnostics: read.diagnostics });
    return;
  }
  writeJson(response, 200, { sessionId, moves: read.moves });
}

async function handleValidate(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string,
): Promise<void> {
  const body = await readBody(request);
  if (!body.ok) {
    writeJson(response, body.status, {
      diagnostics: [{ code: "invalid-request", message: body.message }],
    });
    return;
  }
  const template =
    typeof body.value === "object" && body.value !== null && !Array.isArray(body.value)
      ? (body.value as Record<string, unknown>)["template"]
      : undefined;
  if (template === undefined) {
    writeJson(response, 400, {
      diagnostics: [{ code: "invalid-request", message: "Send { template }." }],
    });
    return;
  }
  const basis = await sessionBasis(context, sessionId);
  if ("failure" in basis) {
    writeJson(response, repositoryFailureStatus(basis.failure), {
      diagnostics: basis.failure.diagnostics,
    });
    return;
  }
  const catalog = context.definitions.catalog(basis.operators);
  const validation = validateMoveTemplate(template, {
    operators: basis.operators,
    ...(catalog.kernelResults === undefined ? {} : { results: catalog.kernelResults }),
    artifactExists: (reference) =>
      reference.kind === "result" && catalog.results.some(({ id }) => id === reference.id),
  });
  writeJson(
    response,
    200,
    validation.ok
      ? { sessionId, ok: true, report: validation.report }
      : { sessionId, ok: false, diagnostics: validation.diagnostics },
  );
}

type Body =
  Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; status: number; message: string }>;

async function readBody(request: IncomingMessage): Promise<Body> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { ok: false, status: 415, message: "Content-Type must be application/json." };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return { ok: false, status: 413, message: "The request body is too large." };
    }
    chunks.push(buffer);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400, message: "The request body is not valid JSON." };
  }
}

function pathSegments(requestTarget: string | undefined): string[] | undefined {
  try {
    return new URL(requestTarget ?? "/", "http://proof.local").pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}
