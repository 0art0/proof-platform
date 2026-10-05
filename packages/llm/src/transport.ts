import {
  LlmTransportError,
  llmContextEnvelopeSchema,
  llmOutputSchemaForRole,
  preparedLlmCallSchema,
  type LlmTransport,
  type LlmTransportFailureSubcode,
  type PreparedLlmCall,
} from "./index";
import { z } from "zod";

export const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
export const DEFAULT_FORMALIZER_MODEL = "openai/gpt-6-luna";
export const DEFAULT_SHORTLISTER_MODEL = "typesafe-ai/jev";
export const DEFAULT_FORMALIZER_REASONING_EFFORT = "high" as const;
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;
export const DEFAULT_FORMALIZER_MAX_OUTPUT_TOKENS = 32_000;
export const DEFAULT_SHORTLISTER_MIN_CONFIDENCE = 0.55;

export const DEFAULT_LLM_MAX_ATTEMPTS = 3;
export const DEFAULT_LLM_RETRY_BASE_DELAY_MS = 500;
export const DEFAULT_LLM_RETRY_MAX_DELAY_MS = 8_000;

export type JsonSchemaObject = Readonly<Record<string, unknown>>;
export type FetchLike = typeof fetch;

/**
 * Bounded retry policy. `timeoutMs` is the total wall-clock budget for all attempts and waits;
 * a retry whose wait would not fit inside the remaining budget is not attempted. `now`, `sleep`
 * and `random` are injectable for tests.
 */
export type LlmRetryOptions = Readonly<{
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}>;

export type VercelStructuredTransportOptions = Readonly<{
  apiKey: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  maxOutputTokens?: number;
  timeoutMs?: number;
  retry?: LlmRetryOptions;
  outputSchema?: (call: PreparedLlmCall) => JsonSchemaObject;
  fetch?: FetchLike;
  baseUrl?: string;
}>;

/**
 * A single non-streaming, schema-constrained generation call through the AI Gateway.
 * Only the parsed structured object enters call evidence; provider envelopes and reasoning
 * metadata are intentionally not copied there.
 *
 * Streaming is deliberately not used: the Gateway contract this code relies on is the
 * non-streaming `stream: false` chat-completions response with a strict JSON schema, and nothing
 * here documents streamed structured-output chunks. Long calls are instead bounded by a
 * configurable total budget (`timeoutMs`, `PROOF_AI_FORMALIZER_TIMEOUT_MS`).
 *
 * Outcome matrix. Only the subcode is stored with a transport failure; provider text, headers
 * and credentials never are.
 *
 * | Situation                                    | Result                     | Retried |
 * | -------------------------------------------- | -------------------------- | ------- |
 * | 200, finish_reason `stop`, JSON content      | parsed object              |         |
 * | 200, finish_reason `stop`, `refusal` set     | `declined` output          |         |
 * | 200, finish_reason `length`/other, no choice | `null` -> rejected         |         |
 * | 200, `stop`, empty or non-JSON content       | `null` -> rejected         |         |
 * | 200, body is not JSON                        | failed: invalid-response   | no      |
 * | 429                                          | failed: rate-limited       | yes     |
 * | 408, 5xx                                     | failed: server-error       | yes     |
 * | 401, 403                                     | failed: auth               | no      |
 * | other 4xx, other non-ok                      | failed: bad-request        | no      |
 * | fetch rejects (not aborted)                  | failed: network            | yes     |
 * | total time budget exhausted                  | failed: timeout            | no      |
 *
 * Retries use exponential backoff with jitter, honour `Retry-After`, and never exceed the total
 * `timeoutMs` budget.
 */
export function createVercelStructuredOutputTransport(
  options: VercelStructuredTransportOptions,
): LlmTransport {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const model = options.model ?? DEFAULT_FORMALIZER_MODEL;
  return async (callInput) => {
    const call = preparedLlmCallSchema.parse(callInput);
    const body = await postJson({
      fetcher,
      url: `${trimSlash(options.baseUrl ?? VERCEL_AI_GATEWAY_BASE_URL)}/v1/chat/completions`,
      apiKey: options.apiKey,
      timeoutMs,
      retry: options.retry,
      payload: {
        model,
        messages: call.messages,
        stream: false,
        max_completion_tokens: options.maxOutputTokens ?? DEFAULT_FORMALIZER_MAX_OUTPUT_TOKENS,
        reasoning_effort: options.reasoningEffort ?? DEFAULT_FORMALIZER_REASONING_EFFORT,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: `proof_${call.role.replaceAll("-", "_")}_output`,
            strict: true,
            schema:
              options.outputSchema?.(call) ??
              (z.toJSONSchema(llmOutputSchemaForRole(call.role)) as JsonSchemaObject),
          },
        },
      },
    });
    const completion = asRecord(body);
    const choices = Array.isArray(completion?.choices) ? completion.choices : undefined;
    const first = choices?.[0];
    if (asRecord(first)?.finish_reason !== "stop") return null;
    const message = asRecord(asRecord(first)?.message);
    if (message?.refusal !== undefined && message.refusal !== null) {
      return { kind: "declined", reason: "The model declined this formalization request." };
    }
    const content = message?.content;
    if (typeof content !== "string" || content.length === 0) return null;
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return null;
    }
  };
}

export type VercelJevShortlisterOptions = Readonly<{
  apiKey: string;
  model?: string;
  minimumConfidence?: number;
  timeoutMs?: number;
  retry?: LlmRetryOptions;
  fetch?: FetchLike;
  baseUrl?: string;
}>;

/**
 * Jev is an evaluation model, not a chat model. A single typed Choice question returns a
 * probability distribution over the displayed suggestion IDs. The distribution is converted
 * into a ranked proposal and then checked again by validateLlmOutput.
 */
export function createVercelJevShortlisterTransport(
  options: VercelJevShortlisterOptions,
): LlmTransport {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const model = options.model ?? DEFAULT_SHORTLISTER_MODEL;
  const minimumConfidence = options.minimumConfidence ?? DEFAULT_SHORTLISTER_MIN_CONFIDENCE;
  return async (callInput) => {
    const call = preparedLlmCallSchema.parse(callInput);
    if (call.role !== "move-shortlister") return null;
    const envelope = llmContextEnvelopeSchema.parse(call.envelope);
    if (envelope.role !== "move-shortlister") return null;
    const criteria = Object.fromEntries(
      envelope.context.candidates.map((candidate) => [candidate.id, candidate.name]),
    );
    const providerRequest = {
      model,
      state: envelope,
      questions: {
        shortlist: {
          type: "choice" as const,
          instructions:
            "Choose the single most relevant displayed suggestion for the exact selected fragment and proof snapshot.",
          criteria,
        },
      },
    };
    const body = await postJson({
      fetcher,
      url: `${trimSlash(options.baseUrl ?? VERCEL_AI_GATEWAY_BASE_URL)}/v1/evaluate`,
      apiKey: options.apiKey,
      timeoutMs,
      retry: options.retry,
      payload: providerRequest,
    });
    const responseBody = asRecord(body);
    const answers = asRecord(responseBody?.answers);
    const answer = asRecord(answers?.shortlist);
    const confidence = extractJevConfidence(responseBody, answer);
    // A well-formed answer without any confidence is a distinct provider-contract failure,
    // not a malformed choice: confidence gates whether a shortlist is shown.
    if (answer !== undefined && confidence === undefined) {
      throw new LlmTransportError("missing-confidence");
    }
    return {
      kind: "jev-choice",
      minimumConfidence,
      providerRequest,
      providerOutput: {
        type: answer?.type ?? null,
        choice: answer?.choice ?? null,
        probabilities: answer?.probabilities ?? null,
        confidence: confidence ?? null,
      },
    };
  };
}

/**
 * Jev confidence is read from the first location that holds a number: the answer itself, the
 * gateway's `providerMetadata.typesafe.confidence.shortlist`, then a scalar
 * `providerMetadata.typesafe.confidence`.
 */
export function extractJevConfidence(
  responseBody: Record<string, unknown> | undefined,
  answer: Record<string, unknown> | undefined,
): number | undefined {
  if (typeof answer?.confidence === "number") return answer.confidence;
  const gatewayConfidence = asRecord(
    asRecord(responseBody?.providerMetadata)?.typesafe,
  )?.confidence;
  const perQuestion = asRecord(gatewayConfidence)?.shortlist;
  if (typeof perQuestion === "number") return perQuestion;
  return typeof gatewayConfidence === "number" ? gatewayConfidence : undefined;
}

type PostJsonInput = Readonly<{
  fetcher: FetchLike;
  url: string;
  apiKey: string;
  timeoutMs: number;
  retry: LlmRetryOptions | undefined;
  payload: unknown;
}>;

/**
 * POST JSON with classified failures and bounded retries. Errors thrown here are always
 * LlmTransportError carrying only a closed subcode; nothing from the provider or the request
 * (keys, headers, response text) is copied into them.
 */
async function postJson(input: PostJsonInput): Promise<unknown> {
  const retry = input.retry ?? {};
  const now = retry.now ?? Date.now;
  const sleep = retry.sleep ?? defaultSleep;
  const random = retry.random ?? Math.random;
  const maxAttempts = Math.max(1, retry.maxAttempts ?? DEFAULT_LLM_MAX_ATTEMPTS);
  const baseDelay = retry.baseDelayMs ?? DEFAULT_LLM_RETRY_BASE_DELAY_MS;
  const maxDelay = retry.maxDelayMs ?? DEFAULT_LLM_RETRY_MAX_DELAY_MS;
  const deadline = now() + input.timeoutMs;
  const serialized = JSON.stringify(input.payload);
  for (let attempt = 1; ; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new LlmTransportError("timeout");
    const outcome = await attemptOnce(input, serialized, remaining);
    if (outcome.ok) return outcome.body;
    if (!outcome.retryable || attempt >= maxAttempts) throw new LlmTransportError(outcome.subcode);
    const backoff = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
    const jittered = backoff / 2 + (random() * backoff) / 2;
    const delay = Math.max(jittered, outcome.retryAfterMs ?? 0);
    if (delay >= deadline - now()) throw new LlmTransportError(outcome.subcode);
    await sleep(delay);
  }
}

type AttemptOutcome =
  | Readonly<{ ok: true; body: unknown }>
  | Readonly<{
      ok: false;
      subcode: LlmTransportFailureSubcode;
      retryable: boolean;
      retryAfterMs?: number;
    }>;

async function attemptOnce(
  input: PostJsonInput,
  serialized: string,
  budgetMs: number,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budgetMs);
  try {
    let response: Response;
    try {
      response = await input.fetcher(input.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
        signal: controller.signal,
        body: serialized,
      });
    } catch {
      return timedOut
        ? { ok: false, subcode: "timeout", retryable: false }
        : { ok: false, subcode: "network", retryable: true };
    }
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      return {
        ok: false,
        ...classifyStatus(response.status),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    try {
      return { ok: true, body: (await response.json()) as unknown };
    } catch {
      return timedOut
        ? { ok: false, subcode: "timeout", retryable: false }
        : { ok: false, subcode: "invalid-response", retryable: false };
    }
  } finally {
    clearTimeout(timeout);
  }
}

function classifyStatus(status: number): {
  subcode: LlmTransportFailureSubcode;
  retryable: boolean;
} {
  if (status === 429) return { subcode: "rate-limited", retryable: true };
  if (status === 408 || status >= 500) return { subcode: "server-error", retryable: true };
  if (status === 401 || status === 403) return { subcode: "auth", retryable: false };
  return { subcode: "bad-request", retryable: false };
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function configuredVercelApiKey(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ ok: true; apiKey: string }> | Readonly<{ ok: false; reason: "missing-api-key" }> {
  const apiKey = env.AI_GATEWAY_API_KEY?.trim() || env.AI_API_KEY?.trim();
  return apiKey === undefined || apiKey.length === 0
    ? { ok: false, reason: "missing-api-key" }
    : { ok: true, apiKey };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
