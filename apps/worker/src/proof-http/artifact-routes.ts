/**
 * HTTP routes for proof artifacts (design plan §19, roadmap N27):
 *
 * - `GET /proof-sessions/:id/export`: the session's versioned artifact (200), built from stored
 *   rows only, with `Content-Disposition: attachment`.
 * - `POST /artifacts` with the artifact as the JSON body (at most 16 MiB): full revalidation, then
 *   a new read-only session. 201 `{ sessionId, digest, sourceSessionId, readOnly, replayed }`
 *   creates it, 200 answers an identical re-upload with the same session, 422 `{ diagnostics }`
 *   names the first failed check (nothing is written), 409 when the derived session ID holds
 *   other content.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  proofArtifactImportResponseSchema,
  proofArtifactRejectionResponseSchema,
} from "@proof/protocol";
import type { z } from "zod";
import { exportProofArtifact } from "../artifact-export";
import { importProofArtifact } from "../artifact-import";
import { proofSessionIdSchema } from "../proof-repository";
import { repositoryFailureStatus, type ServiceContext } from "./shared";

/** Upload limit for one artifact; stored snapshots make artifacts much larger than commands. */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** Handle an artifact route; false when the request is for another route. */
export async function handleArtifactRoute(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const segments = pathSegments(request.url);
  if (segments === undefined) return false;

  if (segments.length === 1 && segments[0] === "artifacts") {
    if (request.method !== "POST") {
      methodNotAllowed(response, "POST");
      return true;
    }
    const body = await readArtifactBody(request);
    if (!body.ok) {
      writeJson(response, body.status, {
        diagnostics: [{ code: "invalid-request", message: body.message }],
      });
      return true;
    }
    const result = await importProofArtifact(context.store, body.value, {
      definitions: context.definitions,
      ...(context.now === undefined ? {} : { now: context.now }),
    });
    switch (result.status) {
      case "imported":
        writeValidatedJson(
          response,
          result.replayed ? 200 : 201,
          proofArtifactImportResponseSchema,
          {
            sessionId: result.sessionId,
            digest: result.digest,
            sourceSessionId: result.sourceSessionId,
            readOnly: true,
            replayed: result.replayed,
          },
        );
        return true;
      case "invalid":
        writeValidatedJson(response, 422, proofArtifactRejectionResponseSchema, {
          diagnostics: result.diagnostics,
        });
        return true;
      case "conflict":
        writeValidatedJson(response, 409, proofArtifactRejectionResponseSchema, {
          diagnostics: result.diagnostics,
        });
        return true;
      case "failed":
        writeJson(response, repositoryFailureStatus(result.failure), {
          diagnostics: result.failure.diagnostics,
        });
        return true;
    }
  }

  if (segments.length === 3 && segments[0] === "proof-sessions" && segments[2] === "export") {
    const sessionId = proofSessionIdSchema.safeParse(segments[1]);
    if (!sessionId.success) return false;
    if (request.method !== "GET") {
      methodNotAllowed(response, "GET");
      return true;
    }
    const exported = await exportProofArtifact(context.store, sessionId.data, {
      library: context.library,
      definitions: context.definitions,
    });
    if (exported.status !== "exported") {
      writeJson(response, repositoryFailureStatus(exported), {
        diagnostics: exported.diagnostics,
      });
      return true;
    }
    response.setHeader(
      "content-disposition",
      `attachment; filename="${artifactFileName(sessionId.data)}"`,
    );
    writeJson(response, 200, exported.artifact);
    return true;
  }
  return false;
}

/** A download file name for a session's artifact: the ID with unsafe characters replaced. */
export function artifactFileName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, "-")}.proof-artifact.json`;
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

type ArtifactBody =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; status: 400 | 413 | 415; message: string }>;

async function readArtifactBody(request: IncomingMessage): Promise<ArtifactBody> {
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
      if (size <= MAX_ARTIFACT_BYTES) chunks.push(chunk);
    }
  } catch {
    return { ok: false, status: 400, message: "The artifact body could not be read." };
  }
  if (size > MAX_ARTIFACT_BYTES) {
    return { ok: false, status: 413, message: "The artifact is too large." };
  }
  if (size === 0) return { ok: false, status: 400, message: "An artifact body is required." };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400, message: "The artifact is not valid JSON." };
  }
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
