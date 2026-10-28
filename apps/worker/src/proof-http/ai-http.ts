/**
 * Small HTTP helpers shared by the AI routes (`ai-routes.ts`, `ai-execute-routes.ts`,
 * `ai-library-routes.ts`): the bounded JSON body, the cost-guard admission and the status of an
 * LLM-call repository failure.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readLlmCall, type LlmCallOwner } from "../llm-call-repository";
import { readJsonBody, writeJson, type JsonBodyResult } from "./http-util";
import { type ServiceContext } from "./shared";

const MAX_AI_REQUEST_BYTES = 256 * 1024;

/** The single human actor of the web application; reviews are recorded under it. */
export const WEB_REVIEWER_ID = "actor:web";

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

/** The AI routes' JSON body, bounded at `MAX_AI_REQUEST_BYTES`. */
export function readBody(request: IncomingMessage): Promise<JsonBodyResult> {
  return readJsonBody(request, { maxBytes: MAX_AI_REQUEST_BYTES });
}

export function methodNotAllowed(response: ServerResponse, method: string): true {
  writeJson(response, 405, {
    diagnostics: [{ code: "method-not-allowed", message: `Use ${method} for this resource.` }],
  });
  return true;
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
