/**
 * HTTP routes for manual problem and session creation (roadmap N26):
 *
 * - `GET /problem-setup/options`: sort, layer and pack menus;
 * - `POST /problem-drafts/validate` `{ draft }`: 200 `{ ok: true, review }` or 422
 *   `{ ok: false, diagnostics }` with draft paths; writes nothing;
 * - `POST /proof-sessions` `{ sessionId, draft, reviewedDigest }`: approval. 201 creates the
 *   session and root node; 200 replays an identical approval; 422 an invalid draft; 409 a stale
 *   review or an existing session with other content. Only a 201 writes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createProofNodeSchema,
  problemDraftValidationRequestSchema,
  problemDraftValidationResponseSchema,
  problemSetupDiagnosticSchema,
  problemSetupOptionsSchema,
  proofSessionMetadataSchema,
} from "@proof/protocol";
import { z } from "zod";
import { approveProblemSession, problemSetupOptions, validateProblemDraft } from "../problem-setup";
import { proofSessionSchema, type ProofSession } from "../proof-repository";
import { repositoryFailureStatus, type ServiceContext } from "./shared";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export const problemSessionResponseSchema = z
  .object({
    session: proofSessionSchema.refine(
      (session) => session.metadata === undefined,
      "HTTP session objects omit metadata.",
    ),
    /** The root node the approval created. */
    node: z.unknown(),
    metadata: proofSessionMetadataSchema,
    replayed: z.boolean(),
  })
  .strict();

export const problemDraftFailureResponseSchema = z
  .object({ diagnostics: z.array(problemSetupDiagnosticSchema).min(1) })
  .strict();

/** Handle a problem-setup route; false when the request is for another route. */
export async function handleProblemSetupRoute(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const path = pathname(request.url);
  if (path === "/problem-setup/options" && request.method === "GET") {
    writeValidatedJson(response, 200, problemSetupOptionsSchema, problemSetupOptions());
    return true;
  }

  if (path === "/problem-drafts/validate" && request.method === "POST") {
    const body = await readStrictJson(request, problemDraftValidationRequestSchema);
    if (!body.ok) {
      writeJson(response, body.status, invalidRequest(body.message));
      return true;
    }
    const validated = validateProblemDraft(body.value.draft);
    if (validated.ok) {
      writeValidatedJson(response, 200, problemDraftValidationResponseSchema, {
        ok: true,
        review: validated.value.review,
      });
    } else {
      writeValidatedJson(response, 422, problemDraftValidationResponseSchema, {
        ok: false,
        diagnostics: validated.diagnostics,
      });
    }
    return true;
  }

  if (path === "/proof-sessions" && request.method === "POST") {
    const body = await readStrictJson(request, z.unknown());
    if (!body.ok) {
      writeJson(response, body.status, invalidRequest(body.message));
      return true;
    }
    const approved = await approveProblemSession(context.store, body.value);
    switch (approved.status) {
      case "invalid-request":
        writeJson(response, 400, invalidRequest(approved.message));
        return true;
      case "invalid-draft":
        writeValidatedJson(response, 422, problemDraftFailureResponseSchema, {
          diagnostics: approved.diagnostics,
        });
        return true;
      case "review-stale":
      case "session-conflict":
        writeJson(response, 409, {
          diagnostics: [{ code: approved.status, message: approved.message }],
        });
        return true;
      case "failed":
        writeJson(response, repositoryFailureStatus(approved.failure), {
          diagnostics: approved.failure.diagnostics,
        });
        return true;
      case "created":
      case "replayed":
        writeValidatedJson(
          response,
          approved.status === "created" ? 201 : 200,
          problemSessionResponseSchema.extend({
            node: createProofNodeSchema({ operators: approved.session.operators }),
          }),
          {
            session: withoutMetadata(approved.session),
            node: approved.node,
            metadata: approved.session.metadata,
            replayed: approved.status === "replayed",
          },
        );
        return true;
    }
  }
  return false;
}

function withoutMetadata(session: ProofSession): ProofSession {
  const { id, rootNodeId, currentNodeId, operators } = session;
  return { id, rootNodeId, currentNodeId, operators };
}

function pathname(requestTarget: string | undefined): string | undefined {
  try {
    return new URL(requestTarget ?? "/", "http://proof.local").pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

type StrictJson<Output> =
  | Readonly<{ ok: true; value: Output }>
  | Readonly<{ ok: false; status: 400 | 413 | 415; message: string }>;

async function readStrictJson<Output>(
  request: IncomingMessage,
  schema: z.ZodType<Output>,
): Promise<StrictJson<Output>> {
  const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return { ok: false, status: 415, message: "Content-Type must be application/json." };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const input of request) {
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input as Uint8Array);
      size += chunk.byteLength;
      if (size <= MAX_REQUEST_BODY_BYTES) chunks.push(chunk);
    }
  } catch {
    return { ok: false, status: 400, message: "The JSON request body could not be read." };
  }
  if (size > MAX_REQUEST_BODY_BYTES) {
    return { ok: false, status: 413, message: "The JSON request body is too large." };
  }
  if (size === 0) return { ok: false, status: 400, message: "A JSON request body is required." };
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return { ok: false, status: 400, message: "The JSON request body is malformed." };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, status: 400, message: "The JSON request does not match its strict schema." };
}

function invalidRequest(message: string): unknown {
  return { diagnostics: [{ code: "invalid-request", message }] };
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
