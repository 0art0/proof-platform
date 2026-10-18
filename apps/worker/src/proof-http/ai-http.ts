/**
 * Small HTTP helpers shared by the AI routes (`ai-routes.ts`, `ai-execute-routes.ts`): bounded JSON
 * bodies, JSON answers, the cost-guard admission and the status of an LLM-call repository failure.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readLlmCall, type LlmCallOwner } from "../llm-call-repository";
import { type ServiceContext } from "./shared";

export const MAX_AI_REQUEST_BYTES = 256 * 1024;

export const LIMIT_MESSAGE = "The AI request budget is exhausted; retry later.";

export type ProviderAdmission =
  | Readonly<{ ok: true; release: () => void }>
  | Readonly<{ ok: false; code: string; retryAfterSeconds: number }>;

/**
 * Reserve limiter budget only when a provider call will really be dispatched: a stored call with
 * the same owner and ID is a replay or conflict and never reaches the provider.
 */
export async function admitProviderCall(
  context: ServiceContext,
  owner: LlmCallOwner,
  callId: string,
): Promise<ProviderAdmission> {
  const limiter = context.aiLimiter;
  if (limiter === undefined) return { ok: true, release: () => undefined };
  if (context.llmCalls !== undefined) {
    const existing = await readLlmCall(context.llmCalls, owner, callId);
    if (existing.status === "found") return { ok: true, release: () => undefined };
  }
  return limiter.tryAcquire();
}

export type BodyResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; status: 400 | 413 | 415; message: string }>;

export async function readBody(request: IncomingMessage): Promise<BodyResult> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    return { ok: false, status: 415, message: "Content-Type must be application/json." };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_AI_REQUEST_BYTES) {
      return { ok: false, status: 413, message: "The AI request is too large." };
    }
    chunks.push(bytes);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, status: 400, message: "The request body is not valid JSON." };
  }
}

export function pathSegments(requestTarget: string | undefined): string[] | undefined {
  try {
    return new URL(requestTarget ?? "/", "http://proof.local").pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
  } catch {
    return undefined;
  }
}

export function methodNotAllowed(response: ServerResponse, method: string): true {
  writeJson(response, 405, {
    diagnostics: [{ code: "method-not-allowed", message: `Use ${method} for this resource.` }],
  });
  return true;
}

export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export function problem(message: string) {
  return { diagnostics: [{ code: "invalid-request", message }] };
}

export function repositoryStatus(result: {
  status: "rejected" | "uncertain";
  diagnostics: readonly [{ code: string }];
}): number {
  if (result.status === "uncertain") return 503;
  if (result.diagnostics[0].code === "call-not-found") return 404;
  if (result.diagnostics[0].code === "call-id-conflict") return 409;
  if (result.diagnostics[0].code === "call-in-progress-or-uncertain") return 503;
  return 400;
}
