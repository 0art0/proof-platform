/**
 * Request and response helpers shared by every proof-http route module: the URL path split, the
 * JSON answer, and the one bounded JSON request-body reader.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The decoded, non-empty path segments of a request target; undefined when the target does not
 * parse or has an undecodable percent escape.
 */
export function pathSegments(requestTarget: string | undefined): string[] | undefined {
  try {
    return new URL(requestTarget ?? "/", "http://proof.local").pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

/** Answer with a JSON body. Every answer is `no-store`; the proof state is never cacheable. */
export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  // An oversize body is deliberately left unread (see `readJsonBody`), so do not reuse the
  // connection for another request.
  if (status === 413) response.setHeader("connection", "close");
  response.end(JSON.stringify(body));
}

export type JsonBodyResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; status: 400 | 413 | 415; message: string }>;

/** Whether the `Content-Type` is `application/json`, case-insensitively and with any parameters. */
function isJsonContentType(contentType: string | undefined): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/**
 * Read the request body as one JSON value of at most `maxBytes` bytes.
 *
 * - 415 unless the `Content-Type` media type is `application/json` (parameters such as
 *   `; charset=utf-8` are allowed; the media type is matched case-insensitively and exactly);
 * - 413 as soon as the body exceeds `maxBytes`: reading stops there and the rest is not buffered.
 *   The request is not destroyed, so the caller can still write the 413 answer (which then closes
 *   the connection, see `writeJson`);
 * - 400 for an empty, unreadable or malformed body.
 */
export async function readJsonBody(
  request: IncomingMessage,
  options: Readonly<{ maxBytes: number }>,
): Promise<JsonBodyResult> {
  if (!isJsonContentType(request.headers["content-type"])) {
    return { ok: false, status: 415, message: "Content-Type must be application/json." };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const input of request.iterator({ destroyOnReturn: false })) {
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input as Uint8Array);
      size += chunk.byteLength;
      if (size > options.maxBytes) {
        return { ok: false, status: 413, message: "The JSON request body is too large." };
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, status: 400, message: "The JSON request body could not be read." };
  }
  if (size === 0) return { ok: false, status: 400, message: "A JSON request body is required." };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400, message: "The JSON request body is malformed." };
  }
}
