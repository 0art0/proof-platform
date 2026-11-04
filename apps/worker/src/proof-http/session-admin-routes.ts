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
 * - `PATCH /proof-sessions/:id/title` with `{ title: string | null }`: 200 `{ sessionId, title }`.
 *   Renames the session; `null` restores the approved problem title. Not a proof write.
 *
 * The worker deliberately has no session-listing route, so private sessions cannot be enumerated.
 * Exporting a private session needs `?confirmPrivateExport=true` (see `artifact-routes.ts`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { proofSessionIdSchema, sessionTitleSchema } from "../proof-repository";
import {
  deleteProofSession,
  readSessionVisibility,
  setSessionTitle,
  setSessionVisibility,
} from "../session-admin";
import { pathSegments, readJsonBody, writeJson } from "./http-util";
import { repositoryFailureStatus, type ServiceContext } from "./shared";

const MAX_BODY_BYTES = 4 * 1024;

const setVisibilityRequestSchema = z.object({ visibility: z.enum(["private", "shared"]) }).strict();
const setTitleRequestSchema = z.object({ title: sessionTitleSchema.nullable() }).strict();

/** Handle a session-admin route; false when the request is for another route. */
export async function handleSessionAdminRoute(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const segments = pathSegments(request.url);
  if (segments === undefined || segments[0] !== "proof-sessions") return false;
  if (
    segments.length !== 2 &&
    !(segments.length === 3 && (segments[2] === "visibility" || segments[2] === "title"))
  ) {
    return false;
  }
  const sessionId = proofSessionIdSchema.safeParse(segments[1]);
  if (!sessionId.success) return false;
  const method = request.method ?? "GET";

  if (segments[2] === "title") {
    if (method !== "PATCH") {
      methodNotAllowed(response, "PATCH");
      return true;
    }
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) {
      writeInvalid(response, body.status, body.message);
      return true;
    }
    const parsed = setTitleRequestSchema.safeParse(
      // Surrounding spaces are not part of a title.
      typeof body.value === "object" &&
        body.value !== null &&
        "title" in body.value &&
        typeof body.value.title === "string"
        ? { ...body.value, title: body.value.title.trim() }
        : body.value,
    );
    if (!parsed.success) {
      writeInvalid(
        response,
        400,
        'The body must be exactly { "title": string | null }, with 1 to 200 characters.',
      );
      return true;
    }
    const renamed = await setSessionTitle(context.store, sessionId.data, parsed.data.title);
    if (renamed.status !== "renamed") {
      writeJson(response, repositoryFailureStatus(renamed), { diagnostics: renamed.diagnostics });
      return true;
    }
    writeJson(response, 200, { sessionId: renamed.sessionId, title: renamed.title });
    return true;
  }

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
  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
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

function writeInvalid(response: ServerResponse, status: number, message: string): void {
  writeJson(response, status, { diagnostics: [{ code: "invalid-request", message }] });
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("allow", allow);
  writeJson(response, 405, {
    diagnostics: [{ code: "method-not-allowed", message: `Use ${allow}.` }],
  });
}
