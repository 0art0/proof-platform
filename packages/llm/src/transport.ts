import {
  llmContextEnvelopeSchema,
  llmOutputSchemaForRole,
  preparedLlmCallSchema,
  type LlmTransport,
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

export type JsonSchemaObject = Readonly<Record<string, unknown>>;
export type FetchLike = typeof fetch;

export type VercelStructuredTransportOptions = Readonly<{
  apiKey: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  maxOutputTokens?: number;
  timeoutMs?: number;
  outputSchema?: (call: PreparedLlmCall) => JsonSchemaObject;
  fetch?: FetchLike;
  baseUrl?: string;
}>;

/**
 * A single non-streaming, schema-constrained generation call through the AI Gateway.
 * Only the parsed structured object enters call evidence; provider envelopes and reasoning
 * metadata are intentionally not copied there.
 */
export function createVercelStructuredOutputTransport(
  options: VercelStructuredTransportOptions,
): LlmTransport {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const model = options.model ?? DEFAULT_FORMALIZER_MODEL;
  return async (callInput) => {
    const call = preparedLlmCallSchema.parse(callInput);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(
        `${trimSlash(options.baseUrl ?? VERCEL_AI_GATEWAY_BASE_URL)}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
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
          }),
        },
      );
      if (!response.ok) throw new Error("AI Gateway structured generation failed.");
      const body: unknown = await response.json();
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
    } finally {
      clearTimeout(timeout);
    }
  };
}

export type VercelJevShortlisterOptions = Readonly<{
  apiKey: string;
  model?: string;
  minimumConfidence?: number;
  timeoutMs?: number;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(
        `${trimSlash(options.baseUrl ?? VERCEL_AI_GATEWAY_BASE_URL)}/v1/evaluate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            model,
            state: envelope,
            questions: {
              shortlist: {
                type: "choice",
                instructions:
                  "Choose the single most relevant displayed suggestion for the exact selected fragment and proof snapshot.",
                criteria,
              },
            },
          }),
        },
      );
      if (!response.ok) throw new Error("AI Gateway evaluation failed.");
      const body: unknown = await response.json();
      const responseBody = asRecord(body);
      const answers = asRecord(responseBody?.answers);
      const answer = asRecord(answers?.shortlist);
      const gatewayConfidence = asRecord(
        asRecord(responseBody?.providerMetadata)?.typesafe,
      )?.confidence;
      const confidenceRecord = asRecord(gatewayConfidence);
      const confidence =
        typeof answer?.confidence === "number"
          ? answer.confidence
          : typeof confidenceRecord?.shortlist === "number"
            ? confidenceRecord.shortlist
            : typeof gatewayConfidence === "number"
              ? gatewayConfidence
              : undefined;
      return {
        kind: "jev-choice",
        minimumConfidence,
        providerRequest: {
          model,
          state: envelope,
          questions: {
            shortlist: {
              type: "choice",
              instructions:
                "Choose the single most relevant displayed suggestion for the exact selected fragment and proof snapshot.",
              criteria,
            },
          },
        },
        providerOutput: {
          type: answer?.type ?? null,
          choice: answer?.choice ?? null,
          probabilities: answer?.probabilities ?? null,
          confidence: confidence ?? null,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  };
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
