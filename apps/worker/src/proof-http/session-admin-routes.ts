/**
 * Session privacy and deletion routes (design plan §19.3, roadmap N36). There is no
 * authentication yet, so these are not access control:
 *
 * - `DELETE /proof-sessions/:id`: hard-deletes the session and every dependent row. 204 on
 *   success, 404 when it does not exist (so a repeated delete is 404, never an error state).
 *   Allowed on a read-only imported session.
 * - `GET /proof-sessions/:id/visibility`: `{ sessionId, visibility }`, `private` by default.
 * - `PATCH /proof-sessions/:id/visibility` with `{ visibility: "private" | "shared" }`: 200
 *   `{ sessionId, visibility }`.
 *
 * The worker deliberately has no session-listing route, so private sessions cannot be enumerated.
 * Exporting a private session needs `?confirmPrivateExport=true` (see `artifact-routes.ts`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { proofSessionIdSchema } from "../proof-repository";
import { deleteProofSession, readSessionVisibility, setSessionVisibility } from "../session-admin";
import { repositoryFailureStatus, type ServiceContext } from "./shared";

const MAX_BODY_BYTES = 4 * 1024;

const setVisibilityRequestSchema = z.object({ visibility: z.enum(["private", "shared"]) }).strict();

/** Handle a session-admin route; false when the request is for another route. */
export async function handleSessionAdminRoute(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const segments = pathSegments(request.url);
  if (segments === undefined || segments[0] !== "proof-sessions") return false;
  if (segments.length !== 2 && !(segments.length === 3 && segments[2] === "visibility")) {
    return false;
  }
  const sessionId = proofSessionIdSchema.safeParse(segments[1]);
  if (!sessionId.success) return false;
  const method = request.method ?? "GET";

  if (segments.length === 2) {
    // Every other method on `/proof-sessions/:id` belongs to the proof route.
    if (method !== "DELETE") return false;
    const deleted = await deleteProofSession(context.store, sessionId.data);
    if (deleted.status !== "deleted") {
      writeJson(response, repositoryFailureStatus(deleted), { diagnostics: deleted.diagnostics });
      return true;
    }
    response.statusCode = 204;
    response.setHeader("cache-control", "no-store");
    response.end();
    return true;
  }

  if (method === "GET") {
    const read = await readSessionVisibility(context.store, sessionId.data);
    writeVisibility(response, read);
    return true;
  }
  if (method !== "PATCH") {
    methodNotAllowed(response, "GET, PATCH");
    return true;
  }
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    writeInvalid(response, 415, "Content-Type must be application/json.");
    return true;
  }
  const body = await readJson(request);
  if (!body.ok) {
    writeInvalid(response, body.status, body.message);
    return true;
  }
  const parsed = setVisibilityRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    writeInvalid(response, 400, 'The body must be exactly { "visibility": "private" | "shared" }.');
    return true;
  }
  const changed = await setSessionVisibility(context.store, sessionId.data, parsed.data.visibility);
  writeVisibility(response, changed);
  return true;
}

function writeVisibility(
  response: ServerResponse,
  result: Awaited<ReturnType<typeof readSessionVisibility>>,
): void {
  if (result.status !== "read") {
    writeJson(response, repositoryFailureStatus(result), { diagnostics: result.diagnostics });
    return;
  }
  writeJson(response, 200, { sessionId: result.sessionId, visibility: result.visibility });
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

type JsonBody =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; status: 400 | 413; message: string }>;

async function readJson(request: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const input of request) {
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input as Uint8Array);
      size += chunk.byteLength;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    }
  } catch {
    return { ok: false, status: 400, message: "The request body could not be read." };
  }
  if (size > MAX_BODY_BYTES) return { ok: false, status: 413, message: "The body is too large." };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400, message: "A valid JSON body is required." };
  }
}

function writeInvalid(response: ServerResponse, status: number, message: string): void {
  writeJson(response, status, { diagnostics: [{ code: "invalid-request", message }] });
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("allow", allow);
  writeJson(response, 405, {
    diagnostics: [{ code: "method-not-allowed", message: `Use ${allow}.` }],
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}
