import {
  createVercelJevShortlisterTransport,
  createVercelJevStepTranslatorTransport,
  createVercelStructuredOutputTransport,
  DEFAULT_BACKGROUND_PROPOSER_MAX_OUTPUT_TOKENS,
  DEFAULT_BACKGROUND_PROPOSER_MODEL,
  DEFAULT_BACKGROUND_PROPOSER_REASONING_EFFORT,
  DEFAULT_EXECUTOR_MAX_OUTPUT_TOKENS,
  DEFAULT_EXECUTOR_MODEL,
  DEFAULT_EXECUTOR_REASONING_EFFORT,
  DEFAULT_FORMALIZER_MAX_OUTPUT_TOKENS,
  DEFAULT_FORMALIZER_MODEL,
  DEFAULT_FORMALIZER_REASONING_EFFORT,
  DEFAULT_LIBRARIAN_MAX_OUTPUT_TOKENS,
  DEFAULT_LIBRARIAN_MODEL,
  DEFAULT_LIBRARIAN_REASONING_EFFORT,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_MOVE_AUTHOR_MAX_OUTPUT_TOKENS,
  DEFAULT_MOVE_AUTHOR_MODEL,
  DEFAULT_MOVE_AUTHOR_REASONING_EFFORT,
  DEFAULT_PLANNER_MAX_OUTPUT_TOKENS,
  DEFAULT_PLANNER_MODEL,
  DEFAULT_PLANNER_REASONING_EFFORT,
  DEFAULT_PLANNER_TIMEOUT_MS,
  DEFAULT_TRANSLATOR_MIN_CONFIDENCE,
  DEFAULT_TRANSLATOR_MODEL,
  DEFAULT_SHORTLISTER_MIN_CONFIDENCE,
  DEFAULT_SHORTLISTER_MODEL,
  DEFAULT_TOPIC_EXTRACTOR_MAX_OUTPUT_TOKENS,
  DEFAULT_TOPIC_EXTRACTOR_MODEL,
  DEFAULT_TOPIC_EXTRACTOR_REASONING_EFFORT,
  configuredVercelApiKey,
  type LlmTransport,
  type SupportedLlmRole,
} from "@proof/llm";
import type { LlmDispatchConfiguration } from "./llm-call-repository";
import {
  createAiLimiter,
  DEFAULT_AI_MAX_CONCURRENT,
  DEFAULT_AI_RATE_PER_MINUTE,
  type AiLimiter,
} from "./proof-http/ai-rate-limit";

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
  const reasoningEffort = parseReasoningEffort(
    "PROOF_AI_FORMALIZER_REASONING_EFFORT",
    env.PROOF_AI_FORMALIZER_REASONING_EFFORT,
    DEFAULT_FORMALIZER_REASONING_EFFORT,
  );
  const topicModel = nonEmpty(env.PROOF_AI_TOPIC_MODEL) ?? DEFAULT_TOPIC_EXTRACTOR_MODEL;
  const topicTokens = positiveInteger(
    env.PROOF_AI_TOPIC_MAX_OUTPUT_TOKENS,
    DEFAULT_TOPIC_EXTRACTOR_MAX_OUTPUT_TOKENS,
  );
  const topicReasoningEffort = parseReasoningEffort(
    "PROOF_AI_TOPIC_REASONING_EFFORT",
    env.PROOF_AI_TOPIC_REASONING_EFFORT,
    DEFAULT_TOPIC_EXTRACTOR_REASONING_EFFORT,
  );
  const backgroundModel =
    nonEmpty(env.PROOF_AI_BACKGROUND_MODEL) ?? DEFAULT_BACKGROUND_PROPOSER_MODEL;
  const backgroundTokens = positiveInteger(
    env.PROOF_AI_BACKGROUND_MAX_OUTPUT_TOKENS,
    DEFAULT_BACKGROUND_PROPOSER_MAX_OUTPUT_TOKENS,
  );
  const backgroundReasoningEffort = parseReasoningEffort(
    "PROOF_AI_BACKGROUND_REASONING_EFFORT",
    env.PROOF_AI_BACKGROUND_REASONING_EFFORT,
    DEFAULT_BACKGROUND_PROPOSER_REASONING_EFFORT,
  );
  const executorModel = nonEmpty(env.PROOF_AI_EXECUTOR_MODEL) ?? DEFAULT_EXECUTOR_MODEL;
  const executorTokens = positiveInteger(
    env.PROOF_AI_EXECUTOR_MAX_OUTPUT_TOKENS,
    DEFAULT_EXECUTOR_MAX_OUTPUT_TOKENS,
  );
  const executorReasoningEffort = parseReasoningEffort(
    "PROOF_AI_EXECUTOR_REASONING_EFFORT",
    env.PROOF_AI_EXECUTOR_REASONING_EFFORT,
    DEFAULT_EXECUTOR_REASONING_EFFORT,
  );
  const authorModel = nonEmpty(env.PROOF_AI_MOVE_AUTHOR_MODEL) ?? DEFAULT_MOVE_AUTHOR_MODEL;
  const authorTokens = positiveInteger(
    env.PROOF_AI_MOVE_AUTHOR_MAX_OUTPUT_TOKENS,
    DEFAULT_MOVE_AUTHOR_MAX_OUTPUT_TOKENS,
  );
  const authorReasoningEffort = parseReasoningEffort(
    "PROOF_AI_MOVE_AUTHOR_REASONING_EFFORT",
    env.PROOF_AI_MOVE_AUTHOR_REASONING_EFFORT,
    DEFAULT_MOVE_AUTHOR_REASONING_EFFORT,
  );
  const librarianModel = nonEmpty(env.PROOF_AI_LIBRARIAN_MODEL) ?? DEFAULT_LIBRARIAN_MODEL;
  const librarianTokens = positiveInteger(
    env.PROOF_AI_LIBRARIAN_MAX_OUTPUT_TOKENS,
    DEFAULT_LIBRARIAN_MAX_OUTPUT_TOKENS,
  );
  const librarianReasoningEffort = parseReasoningEffort(
    "PROOF_AI_LIBRARIAN_REASONING_EFFORT",
    env.PROOF_AI_LIBRARIAN_REASONING_EFFORT,
    DEFAULT_LIBRARIAN_REASONING_EFFORT,
  );
  const plannerModel = nonEmpty(env.PROOF_AI_PLANNER_MODEL) ?? DEFAULT_PLANNER_MODEL;
  const plannerTokens = positiveInteger(
    env.PROOF_AI_PLANNER_MAX_OUTPUT_TOKENS,
    DEFAULT_PLANNER_MAX_OUTPUT_TOKENS,
  );
  const plannerReasoningEffort = parseReasoningEffort(
    "PROOF_AI_PLANNER_REASONING_EFFORT",
    env.PROOF_AI_PLANNER_REASONING_EFFORT,
    DEFAULT_PLANNER_REASONING_EFFORT,
  );
  // Writing a whole proof at high effort takes minutes, so the planner has its own budget.
  const plannerTimeoutMs = positiveInteger(
    env.PROOF_AI_PLANNER_TIMEOUT_MS,
    DEFAULT_PLANNER_TIMEOUT_MS,
  );
  const translatorModel = nonEmpty(env.PROOF_AI_TRANSLATOR_MODEL) ?? DEFAULT_TRANSLATOR_MODEL;
  const translatorConfidence = boundedNumber(
    "PROOF_AI_TRANSLATOR_MIN_CONFIDENCE",
    env.PROOF_AI_TRANSLATOR_MIN_CONFIDENCE,
    DEFAULT_TRANSLATOR_MIN_CONFIDENCE,
  );
  const shortlisterModel = nonEmpty(env.PROOF_AI_SHORTLISTER_MODEL) ?? DEFAULT_SHORTLISTER_MODEL;
  const minimumConfidence = boundedNumber(
    "PROOF_AI_SHORTLISTER_MIN_CONFIDENCE",
    env.PROOF_AI_SHORTLISTER_MIN_CONFIDENCE,
    DEFAULT_SHORTLISTER_MIN_CONFIDENCE,
  );

  return Object.freeze({
    "topic-extractor": {
      transport: createVercelStructuredOutputTransport({
        apiKey: key.apiKey,
        model: topicModel,
        reasoningEffort: topicReasoningEffort,
        maxOutputTokens: topicTokens,
        timeoutMs,
      }),
      dispatch: Object.freeze({
        provider: "vercel-ai-gateway",
        model: topicModel,
        promptVersion: "topic-extractor-v1",
        maxOutputTokens: topicTokens,
        reasoningEffort: topicReasoningEffort,
      }),
    },
    "background-proposer": {
      transport: createVercelStructuredOutputTransport({
        apiKey: key.apiKey,
        model: backgroundModel,
        reasoningEffort: backgroundReasoningEffort,
        maxOutputTokens: backgroundTokens,
        timeoutMs,
      }),
      dispatch: Object.freeze({
        provider: "vercel-ai-gateway",
        model: backgroundModel,
        promptVersion: "background-proposer-v2",
        maxOutputTokens: backgroundTokens,
        reasoningEffort: backgroundReasoningEffort,
      }),
    },
    librarian: {
      transport: createVercelStructuredOutputTransport({
        apiKey: key.apiKey,
        model: librarianModel,
        reasoningEffort: librarianReasoningEffort,
        maxOutputTokens: librarianTokens,
        timeoutMs,
      }),
      dispatch: Object.freeze({
        provider: "vercel-ai-gateway",
        model: librarianModel,
        promptVersion: "librarian-v2",
        maxOutputTokens: librarianTokens,
        reasoningEffort: librarianReasoningEffort,
      }),
    },
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
        promptVersion: "proof-state-formalizer-v3",
        maxOutputTokens: formalizerTokens,
        reasoningEffort,
      }),
    },
    "move-executor": {
      transport: createVercelStructuredOutputTransport({
        apiKey: key.apiKey,
        model: executorModel,
        reasoningEffort: executorReasoningEffort,
        maxOutputTokens: executorTokens,
        timeoutMs,
      }),
      dispatch: Object.freeze({
        provider: "vercel-ai-gateway",
        model: executorModel,
        promptVersion: "move-executor-v2",
        maxOutputTokens: executorTokens,
        reasoningEffort: executorReasoningEffort,
      }),
    },
    "move-author": {
      transport: createVercelStructuredOutputTransport({
        apiKey: key.apiKey,
        model: authorModel,
        reasoningEffort: authorReasoningEffort,
        maxOutputTokens: authorTokens,
        timeoutMs,
      }),
      dispatch: Object.freeze({
        provider: "vercel-ai-gateway",
        model: authorModel,
        promptVersion: "move-author-v2",
        maxOutputTokens: authorTokens,
        reasoningEffort: authorReasoningEffort,
      }),
    },
    "proof-planner": {
      transport: createVercelStructuredOutputTransport({
        apiKey: key.apiKey,
        model: plannerModel,
        reasoningEffort: plannerReasoningEffort,
        maxOutputTokens: plannerTokens,
        timeoutMs: plannerTimeoutMs,
      }),
      dispatch: Object.freeze({
        provider: "vercel-ai-gateway",
        model: plannerModel,
        promptVersion: "proof-planner-v1",
        maxOutputTokens: plannerTokens,
        reasoningEffort: plannerReasoningEffort,
      }),
    },
    "step-translator": {
      transport: createVercelJevStepTranslatorTransport({
        apiKey: key.apiKey,
        model: translatorModel,
        timeoutMs,
      }),
      dispatch: Object.freeze({
        provider: "vercel-ai-gateway-evaluation",
        model: translatorModel,
        promptVersion: "step-translator-jev-v1",
        minimumConfidence: translatorConfidence,
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
        promptVersion: "move-shortlister-jev-v2",
        minimumConfidence,
      }),
    },
  });
}

/** Build the AI cost guard from `PROOF_AI_MAX_CONCURRENT` and `PROOF_AI_RATE_PER_MINUTE`. */
export function createAiLimiterFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): AiLimiter {
  return createAiLimiter({
    maxConcurrent: positiveInteger(env.PROOF_AI_MAX_CONCURRENT, DEFAULT_AI_MAX_CONCURRENT),
    ratePerMinute: positiveInteger(env.PROOF_AI_RATE_PER_MINUTE, DEFAULT_AI_RATE_PER_MINUTE),
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

function boundedNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return parsed;
}

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

function parseReasoningEffort(
  name: string,
  value: string | undefined,
  fallback: ReasoningEffort,
): ReasoningEffort {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new Error(`${name} must be low, medium, high, or xhigh.`);
}
