/**
 * Who may talk to the proof HTTP service. Two independent gates run before any route:
 *
 * - the `Host` header must name this server (a DNS-rebinding defence: a hostile page can make a
 *   browser reach a loopback worker under its own name, but not under a name the worker accepts);
 * - when `PROOF_HTTP_TOKEN` is set, the request must carry it as a bearer token.
 *
 * Binding a non-loopback address requires a token of at least `MIN_REMOTE_TOKEN_LENGTH`
 * characters, so the worker cannot be exposed to a network without a secret. The default local
 * setup (loopback bind, no token) needs no configuration.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIPv4, isIPv6 } from "node:net";
import { writeJson } from "./http-util";

/** The shortest `PROOF_HTTP_TOKEN` accepted when the worker listens on a non-loopback address. */
export const MIN_REMOTE_TOKEN_LENGTH = 32;

export type HttpAccessPolicy = Readonly<{
  /** The shared secret; when present, every request must send `Authorization: Bearer <token>`. */
  token?: string;
  /**
   * Host names accepted in addition to `localhost`, `127.0.0.1`, `[::1]` and the bind host: lower
   * case, without port or IPv6 brackets.
   */
  allowedHosts: readonly string[];
}>;

/** The policy of a service created without access options: no token, loopback host names only. */
export const DEFAULT_HTTP_ACCESS_POLICY: HttpAccessPolicy = Object.freeze({ allowedHosts: [] });

export type AccessDenial = Readonly<{
  status: 401 | 403;
  code: "unauthorized" | "host-not-allowed";
  message: string;
}>;

const LOOPBACK_HOST_NAMES: readonly string[] = ["localhost", "127.0.0.1", "::1"];

/** A `Host` header value: a reg-name or IPv4 literal or bracketed IPv6 literal, then any port. */
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(?::[0-9]{1,5})?$/i;

/** A token that survives a round trip through an HTTP header value unchanged. */
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/;

/**
 * The lower-case host name of a `Host` header value or host setting, without port or IPv6
 * brackets; undefined when the value is not a plain `host[:port]` (userinfo, a path, spaces, ...).
 */
export function normalizedHostName(hostHeader: string): string | undefined {
  const name = HOST_HEADER.exec(hostHeader)?.[1];
  return name?.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Whether a bind host stays on this machine: 127.0.0.0/8, `::1` or `localhost`. */
export function isLoopbackHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (name === "localhost") return true;
  if (isIPv4(name)) return name.split(".", 1)[0] === "127";
  if (isIPv6(name)) {
    try {
      return new URL(`http://[${name}]/`).hostname === "[::1]";
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Read `PROOF_HTTP_TOKEN` and `PROOF_HTTP_ALLOWED_HOSTS` (comma-separated host names; any port is
 * ignored). An empty token counts as unset. Throws on a token that cannot travel in a header or a
 * host entry that is not a plain host name, so a typo fails at start instead of at the first call.
 */
export function accessPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): HttpAccessPolicy {
  const token = env.PROOF_HTTP_TOKEN === "" ? undefined : env.PROOF_HTTP_TOKEN;
  if (token !== undefined && !HEADER_SAFE_TOKEN.test(token)) {
    throw new Error(
      "PROOF_HTTP_TOKEN must contain only printable ASCII characters and no whitespace.",
    );
  }
  const allowedHosts: string[] = [];
  for (const entry of (env.PROOF_HTTP_ALLOWED_HOSTS ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const name = normalizedHostName(trimmed);
    if (name === undefined) {
      throw new Error(
        `Invalid PROOF_HTTP_ALLOWED_HOSTS entry ${JSON.stringify(trimmed)}; ` +
          "use comma-separated host names such as proof-worker or 10.0.0.5.",
      );
    }
    allowedHosts.push(name);
  }
  return Object.freeze({
    ...(token === undefined ? {} : { token }),
    allowedHosts: Object.freeze(allowedHosts),
  });
}

/** Refuse a non-loopback bind unless the policy carries a token of sufficient length. */
export function assertBindAllowed(policy: HttpAccessPolicy, host: string): void {
  if (isLoopbackHost(host)) return;
  if (policy.token === undefined || policy.token.length < MIN_REMOTE_TOKEN_LENGTH) {
    throw new Error(
      `Refusing to listen on non-loopback host ${JSON.stringify(host)} without authentication: ` +
        `set PROOF_HTTP_TOKEN to a secret of at least ${MIN_REMOTE_TOKEN_LENGTH} characters ` +
        '(for example the output of "openssl rand -hex 32"), or bind PROOF_HTTP_HOST to a ' +
        "loopback address.",
    );
  }
}

/**
 * Compare a presented token with the configured one without leaking where they differ or how long
 * the secret is: both are hashed to equal-length digests, which `timingSafeEqual` compares.
 */
export function tokensMatch(expected: string, presented: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const presentedDigest = createHash("sha256").update(presented).digest();
  return timingSafeEqual(expectedDigest, presentedDigest);
}

/**
 * Judge one request: the `Host` check first (it also protects a token-less loopback worker), then
 * the bearer token. `bindHost` is the host the server listens on; undefined before `listen`.
 */
export function checkRequestAccess(
  policy: HttpAccessPolicy,
  bindHost: string | undefined,
  request: Pick<IncomingMessage, "headers">,
): AccessDenial | undefined {
  const hostHeader = request.headers.host;
  const hostName = hostHeader === undefined ? undefined : normalizedHostName(hostHeader);
  const bindName = bindHost?.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostName === undefined ||
    !(
      LOOPBACK_HOST_NAMES.includes(hostName) ||
      (bindName !== undefined && !isWildcardAddress(bindName) && hostName === bindName) ||
      policy.allowedHosts.includes(hostName)
    )
  ) {
    return {
      status: 403,
      code: "host-not-allowed",
      message:
        "The Host header does not name this proof worker. " +
        "Add the host name to PROOF_HTTP_ALLOWED_HOSTS to allow it.",
    };
  }
  if (policy.token !== undefined) {
    const presented = /^bearer +(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (presented === undefined || !tokensMatch(policy.token, presented)) {
      return {
        status: 401,
        code: "unauthorized",
        message: "A valid bearer token is required.",
      };
    }
  }
  return undefined;
}

/** Answer a denied request. The connection is closed: its unread body is not worth draining. */
export function writeAccessDenied(response: ServerResponse, denial: AccessDenial): void {
  if (denial.status === 401) response.setHeader("www-authenticate", "Bearer");
  response.setHeader("connection", "close");
  writeJson(response, denial.status, {
    diagnostics: [{ code: denial.code, message: denial.message }],
  });
}

/** `0.0.0.0` and `::` are listen addresses, not names a client sends in `Host`. */
function isWildcardAddress(name: string): boolean {
  return name === "" || name === "0.0.0.0" || name === "::";
}
