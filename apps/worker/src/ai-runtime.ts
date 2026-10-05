import {
  createVercelJevShortlisterTransport,
  createVercelStructuredOutputTransport,
  DEFAULT_FORMALIZER_MAX_OUTPUT_TOKENS,
  DEFAULT_FORMALIZER_MODEL,
  DEFAULT_FORMALIZER_REASONING_EFFORT,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_SHORTLISTER_MIN_CONFIDENCE,
  DEFAULT_SHORTLISTER_MODEL,
  configuredVercelApiKey,
  type LlmTransport,
  type SupportedLlmRole,
} from "@proof/llm";
import type { LlmDispatchConfiguration } from "./llm-call-repository";

export type AiRoleRuntime = Readonly<{
  transport: LlmTransport;
  dispatch: LlmDispatchConfiguration;
}>;
export type AiRuntime = Readonly<Partial<Record<SupportedLlmRole, AiRoleRuntime>>>;

export function createAiRuntime(env: Readonly<Record<string, string | undefined>>): AiRuntime {
  const key = configuredVercelApiKey(env);
  if (!key.ok) return Object.freeze({});
  const timeoutMs = positiveInteger(env.PROOF_AI_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS);
  const formalizerTimeoutMs = positiveInteger(env.PROOF_AI_FORMALIZER_TIMEOUT_MS, timeoutMs);
  const formalizerModel = nonEmpty(env.PROOF_AI_FORMALIZER_MODEL) ?? DEFAULT_FORMALIZER_MODEL;
  const formalizerTokens = positiveInteger(
    env.PROOF_AI_FORMALIZER_MAX_OUTPUT_TOKENS,
    DEFAULT_FORMALIZER_MAX_OUTPUT_TOKENS,
  );
  const reasoningEffort = parseReasoningEffort(env.PROOF_AI_FORMALIZER_REASONING_EFFORT);
  const shortlisterModel = nonEmpty(env.PROOF_AI_SHORTLISTER_MODEL) ?? DEFAULT_SHORTLISTER_MODEL;
  const minimumConfidence = boundedNumber(
    env.PROOF_AI_SHORTLISTER_MIN_CONFIDENCE,
    DEFAULT_SHORTLISTER_MIN_CONFIDENCE,
  );

  return Object.freeze({
    "proof-state-formalizer": {
      transport: createVercelStructuredOutputTransport({
        apiKey: key.apiKey,
        model: formalizerModel,
        reasoningEffort,
        maxOutputTokens: formalizerTokens,
        timeoutMs: formalizerTimeoutMs,
      }),
      dispatch: Object.freeze({
        provider: "vercel-ai-gateway",
        model: formalizerModel,
        promptVersion: "proof-state-formalizer-v1",
        maxOutputTokens: formalizerTokens,
        reasoningEffort,
      }),
    },
    "move-shortlister": {
      transport: createVercelJevShortlisterTransport({
        apiKey: key.apiKey,
        model: shortlisterModel,
        minimumConfidence,
        timeoutMs,
      }),
      dispatch: Object.freeze({
        provider: "vercel-ai-gateway-evaluation",
        model: shortlisterModel,
        promptVersion: "move-shortlister-jev-v1",
        minimumConfidence,
      }),
    },
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("Invalid positive AI runtime limit.");
  return parsed;
}

function boundedNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("PROOF_AI_SHORTLISTER_MIN_CONFIDENCE must be between 0 and 1.");
  }
  return parsed;
}

function parseReasoningEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" {
  if (value === undefined || value.trim() === "") return DEFAULT_FORMALIZER_REASONING_EFFORT;
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new Error("PROOF_AI_FORMALIZER_REASONING_EFFORT must be low, medium, high, or xhigh.");
}
