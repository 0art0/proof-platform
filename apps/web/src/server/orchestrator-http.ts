import "server-only";

import { NextResponse } from "next/server";
import { OrchestratorGatewayError } from "./orchestrator-protocol";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
} as const;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function localRequestOrigin(request: Request): string | undefined {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return undefined;
  }
  if (!isLoopbackHostname(requestUrl.hostname)) return undefined;

  const host = request.headers.get("host");
  if (!host) return undefined;

  try {
    if (new URL(`${requestUrl.protocol}//${host}`).origin !== requestUrl.origin) return undefined;

    const forwardedHost = request.headers.get("x-forwarded-host");
    if (
      forwardedHost !== null &&
      new URL(`${requestUrl.protocol}//${forwardedHost}`).origin !== requestUrl.origin
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  if (
    forwardedProtocol !== null &&
    `${forwardedProtocol.trim().toLowerCase()}:` !== requestUrl.protocol
  ) {
    return undefined;
  }
  return requestUrl.origin;
}

export function gatewaySuccess<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true, data }, { status, headers: NO_STORE_HEADERS });
}

export function invalidRequest(message: string) {
  return NextResponse.json(
    { ok: false, error: { code: "invalid_request", message } },
    { status: 400, headers: NO_STORE_HEADERS },
  );
}

export function validateLocalJsonMutation(request: Request) {
  const expectedOrigin = localRequestOrigin(request);
  const origin = request.headers.get("origin");
  let parsedOrigin: URL;
  try {
    if (!expectedOrigin || !origin) throw new Error("Missing request origin.");
    parsedOrigin = new URL(origin);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "forbidden_origin",
          message: "Intent submission is allowed only from the local dashboard origin.",
        },
      },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  if (
    origin !== parsedOrigin.origin ||
    parsedOrigin.origin !== expectedOrigin ||
    request.headers.get("sec-fetch-site") !== "same-origin"
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "forbidden_origin",
          message: "Intent submission is allowed only from the local dashboard origin.",
        },
      },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "unsupported_media_type",
          message: "Intent submission requires an application/json request.",
        },
      },
      { status: 415, headers: NO_STORE_HEADERS },
    );
  }
  return undefined;
}

export function gatewayFailure(error: unknown) {
  if (error instanceof OrchestratorGatewayError) {
    const status =
      error.code === "gateway_unavailable" || error.code === "gateway_timeout" ? 503 : 502;
    return NextResponse.json(
      { ok: false, error: { code: error.code, message: error.message } },
      { status, headers: NO_STORE_HEADERS },
    );
  }

  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "gateway_unavailable",
        message: "The local orchestrator could not be reached.",
      },
    },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}
