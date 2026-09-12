import { ProofServiceError } from "../../../server/proof-service";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
} as const;

const MAX_REQUEST_BYTES = 64 * 1024;

export function proofApiSuccess<Data>(data: Data, status = 200): Response {
  return Response.json({ ok: true, data }, { status, headers: NO_STORE_HEADERS });
}

export function proofApiFailure(code: string, message: string, status: number): Response {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: NO_STORE_HEADERS },
  );
}

export function proofServiceFailure(error: unknown): Response {
  if (error instanceof ProofServiceError) {
    return proofApiFailure(error.code, error.message, error.status);
  }
  return proofApiFailure("service_unavailable", "The proof service could not be reached.", 503);
}

export function validateSameOriginJsonRequest(request: Request): Response | undefined {
  let requestOrigin: string;
  let suppliedOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
    const origin = request.headers.get("origin");
    if (origin === null) throw new Error("Missing origin.");
    const parsedOrigin = new URL(origin);
    if (origin !== parsedOrigin.origin) throw new Error("Origin includes a path.");
    suppliedOrigin = parsedOrigin.origin;
  } catch {
    return proofApiFailure(
      "forbidden_origin",
      "Proof mutations are accepted only from this application origin.",
      403,
    );
  }
  if (
    suppliedOrigin !== requestOrigin ||
    request.headers.get("sec-fetch-site")?.toLowerCase() !== "same-origin"
  ) {
    return proofApiFailure(
      "forbidden_origin",
      "Proof mutations are accepted only from this application origin.",
      403,
    );
  }

  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return proofApiFailure(
      "unsupported_media_type",
      "Proof mutations require an application/json body.",
      415,
    );
  }
  return undefined;
}

export async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new RequestBodyError("The JSON request body is too large.", 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new RequestBodyError("The JSON request body could not be read.", 400);
  }
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new RequestBodyError("The JSON request body is too large.", 413);
  }
  if (text.length === 0) throw new RequestBodyError("A JSON request body is required.", 400);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestBodyError("The JSON request body is malformed.", 400);
  }
}

export class RequestBodyError extends Error {
  readonly status: 400 | 413;

  constructor(message: string, status: 400 | 413) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
  }
}
