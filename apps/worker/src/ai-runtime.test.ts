import { describe, expect, it, vi } from "vitest";
import {
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
  DEFAULT_SHORTLISTER_MIN_CONFIDENCE,
  DEFAULT_SHORTLISTER_MODEL,
  DEFAULT_TOPIC_EXTRACTOR_MAX_OUTPUT_TOKENS,
  DEFAULT_TOPIC_EXTRACTOR_MODEL,
  DEFAULT_MOVE_AUTHOR_MAX_OUTPUT_TOKENS,
  DEFAULT_MOVE_AUTHOR_MODEL,
  DEFAULT_MOVE_AUTHOR_REASONING_EFFORT,
  DEFAULT_TOPIC_EXTRACTOR_REASONING_EFFORT,
  buildProofStateFormalizerContext,
  prepareLlmCall,
  type PreparedLlmCall,
} from "@proof/llm";
import { createAiLimiterFromEnv, createAiRuntime } from "./ai-runtime";

describe("createAiRuntime", () => {
  it("leaves AI disabled when neither supported key is configured", () => {
    expect(createAiRuntime({})).toEqual({});
    expect(createAiRuntime({ AI_GATEWAY_API_KEY: "  ", AI_API_KEY: "" })).toEqual({});
  });

  it("configures Luna topics, background proposal, library and formalization and Jev shortlisting with the documented defaults", () => {
    const runtime = createAiRuntime({ AI_GATEWAY_API_KEY: "test-credential" });
    expect(Object.keys(runtime).sort()).toEqual([
      "background-proposer",
      "librarian",
      "move-author",
      "move-executor",
      "move-shortlister",
      "proof-state-formalizer",
      "topic-extractor",
    ]);
    expect(DEFAULT_LIBRARIAN_MODEL).toBe("openai/gpt-6-luna");
    expect(DEFAULT_LIBRARIAN_REASONING_EFFORT).toBe("high");
    expect(DEFAULT_LIBRARIAN_MAX_OUTPUT_TOKENS).toBe(32_000);
    expect(runtime.librarian?.dispatch).toEqual({
      provider: "vercel-ai-gateway",
      model: DEFAULT_LIBRARIAN_MODEL,
      promptVersion: "librarian-v2",
      maxOutputTokens: DEFAULT_LIBRARIAN_MAX_OUTPUT_TOKENS,
      reasoningEffort: DEFAULT_LIBRARIAN_REASONING_EFFORT,
    });
    expect(typeof runtime.librarian?.transport).toBe("function");
    expect(DEFAULT_BACKGROUND_PROPOSER_MODEL).toBe("openai/gpt-6-luna");
    expect(DEFAULT_BACKGROUND_PROPOSER_REASONING_EFFORT).toBe("medium");
    expect(DEFAULT_BACKGROUND_PROPOSER_MAX_OUTPUT_TOKENS).toBe(8_000);
    expect(runtime["background-proposer"]?.dispatch).toEqual({
      provider: "vercel-ai-gateway",
      model: DEFAULT_BACKGROUND_PROPOSER_MODEL,
      promptVersion: "background-proposer-v2",
      maxOutputTokens: DEFAULT_BACKGROUND_PROPOSER_MAX_OUTPUT_TOKENS,
      reasoningEffort: DEFAULT_BACKGROUND_PROPOSER_REASONING_EFFORT,
    });
    expect(typeof runtime["background-proposer"]?.transport).toBe("function");
    expect(runtime["move-executor"]?.dispatch).toEqual({
      provider: "vercel-ai-gateway",
      model: DEFAULT_EXECUTOR_MODEL,
      promptVersion: "move-executor-v2",
      maxOutputTokens: DEFAULT_EXECUTOR_MAX_OUTPUT_TOKENS,
      reasoningEffort: DEFAULT_EXECUTOR_REASONING_EFFORT,
    });
    expect(DEFAULT_EXECUTOR_MODEL).toBe("openai/gpt-6-luna");
    expect(DEFAULT_EXECUTOR_REASONING_EFFORT).toBe("high");
    expect(DEFAULT_EXECUTOR_MAX_OUTPUT_TOKENS).toBe(16_000);
    expect(typeof runtime["move-executor"]?.transport).toBe("function");
    expect(DEFAULT_MOVE_AUTHOR_MODEL).toBe("openai/gpt-6-luna");
    expect(DEFAULT_MOVE_AUTHOR_REASONING_EFFORT).toBe("high");
    expect(DEFAULT_MOVE_AUTHOR_MAX_OUTPUT_TOKENS).toBe(32_000);
    expect(runtime["move-author"]?.dispatch).toEqual({
      provider: "vercel-ai-gateway",
      model: DEFAULT_MOVE_AUTHOR_MODEL,
      promptVersion: "move-author-v2",
      maxOutputTokens: DEFAULT_MOVE_AUTHOR_MAX_OUTPUT_TOKENS,
      reasoningEffort: DEFAULT_MOVE_AUTHOR_REASONING_EFFORT,
    });
    expect(typeof runtime["move-author"]?.transport).toBe("function");
    expect(runtime["topic-extractor"]?.dispatch).toEqual({
      provider: "vercel-ai-gateway",
      model: DEFAULT_TOPIC_EXTRACTOR_MODEL,
      promptVersion: "topic-extractor-v1",
      maxOutputTokens: DEFAULT_TOPIC_EXTRACTOR_MAX_OUTPUT_TOKENS,
      reasoningEffort: DEFAULT_TOPIC_EXTRACTOR_REASONING_EFFORT,
    });
    expect(typeof runtime["topic-extractor"]?.transport).toBe("function");
    expect(runtime["proof-state-formalizer"]?.dispatch).toEqual({
      provider: "vercel-ai-gateway",
      model: DEFAULT_FORMALIZER_MODEL,
      promptVersion: "proof-state-formalizer-v3",
      maxOutputTokens: DEFAULT_FORMALIZER_MAX_OUTPUT_TOKENS,
      reasoningEffort: DEFAULT_FORMALIZER_REASONING_EFFORT,
    });
    expect(runtime["move-shortlister"]?.dispatch).toEqual({
      provider: "vercel-ai-gateway-evaluation",
      model: DEFAULT_SHORTLISTER_MODEL,
      promptVersion: "move-shortlister-jev-v2",
      minimumConfidence: DEFAULT_SHORTLISTER_MIN_CONFIDENCE,
    });
    expect(typeof runtime["proof-state-formalizer"]?.transport).toBe("function");
    expect(typeof runtime["move-shortlister"]?.transport).toBe("function");
    expect(JSON.stringify(runtime)).not.toContain("test-credential");
  });

  it("accepts the generic key alias and validated role overrides", () => {
    const runtime = createAiRuntime({
      AI_API_KEY: "test-credential",
      PROOF_AI_TIMEOUT_MS: "30000",
      PROOF_AI_FORMALIZER_MODEL: "openai/luna-test",
      PROOF_AI_FORMALIZER_MAX_OUTPUT_TOKENS: "12000",
      PROOF_AI_FORMALIZER_REASONING_EFFORT: "xhigh",
      PROOF_AI_SHORTLISTER_MODEL: "typesafe-ai/jev-test",
      PROOF_AI_SHORTLISTER_MIN_CONFIDENCE: "0.8",
      PROOF_AI_TOPIC_MODEL: "openai/luna-topics",
      PROOF_AI_TOPIC_MAX_OUTPUT_TOKENS: "4000",
      PROOF_AI_TOPIC_REASONING_EFFORT: "low",
      PROOF_AI_BACKGROUND_MODEL: "openai/luna-background",
      PROOF_AI_BACKGROUND_MAX_OUTPUT_TOKENS: "6000",
      PROOF_AI_BACKGROUND_REASONING_EFFORT: "high",
      PROOF_AI_EXECUTOR_MODEL: "openai/luna-executor",
      PROOF_AI_EXECUTOR_MAX_OUTPUT_TOKENS: "9000",
      PROOF_AI_EXECUTOR_REASONING_EFFORT: "medium",
      PROOF_AI_LIBRARIAN_MODEL: "openai/luna-library",
      PROOF_AI_LIBRARIAN_MAX_OUTPUT_TOKENS: "20000",
      PROOF_AI_LIBRARIAN_REASONING_EFFORT: "xhigh",
      PROOF_AI_MOVE_AUTHOR_MODEL: "openai/luna-author",
      PROOF_AI_MOVE_AUTHOR_MAX_OUTPUT_TOKENS: "24000",
      PROOF_AI_MOVE_AUTHOR_REASONING_EFFORT: "medium",
    });
    expect(runtime["move-author"]?.dispatch).toMatchObject({
      model: "openai/luna-author",
      maxOutputTokens: 24_000,
      reasoningEffort: "medium",
    });
    expect(runtime["move-executor"]?.dispatch).toMatchObject({
      model: "openai/luna-executor",
      maxOutputTokens: 9_000,
      reasoningEffort: "medium",
    });
    expect(runtime.librarian?.dispatch).toMatchObject({
      model: "openai/luna-library",
      maxOutputTokens: 20_000,
      reasoningEffort: "xhigh",
    });
    expect(runtime["topic-extractor"]?.dispatch).toMatchObject({
      model: "openai/luna-topics",
      maxOutputTokens: 4_000,
      reasoningEffort: "low",
    });
    expect(runtime["background-proposer"]?.dispatch).toMatchObject({
      model: "openai/luna-background",
      maxOutputTokens: 6_000,
      reasoningEffort: "high",
    });
    expect(runtime["proof-state-formalizer"]?.dispatch).toMatchObject({
      model: "openai/luna-test",
      maxOutputTokens: 12_000,
      reasoningEffort: "xhigh",
    });
    expect(runtime["move-shortlister"]?.dispatch).toMatchObject({
      model: "typesafe-ai/jev-test",
      minimumConfidence: 0.8,
    });
  });

  it.each([
    ["timeout", { PROOF_AI_TIMEOUT_MS: "0" }],
    ["formalizer timeout", { PROOF_AI_FORMALIZER_TIMEOUT_MS: "abc" }],
    ["max output tokens", { PROOF_AI_FORMALIZER_MAX_OUTPUT_TOKENS: "-2" }],
    ["reasoning effort", { PROOF_AI_FORMALIZER_REASONING_EFFORT: "extreme" }],
    ["minimum confidence", { PROOF_AI_SHORTLISTER_MIN_CONFIDENCE: "1.1" }],
    ["topic max output tokens", { PROOF_AI_TOPIC_MAX_OUTPUT_TOKENS: "0" }],
    ["topic reasoning effort", { PROOF_AI_TOPIC_REASONING_EFFORT: "maximal" }],
    ["background max output tokens", { PROOF_AI_BACKGROUND_MAX_OUTPUT_TOKENS: "0" }],
    ["background reasoning effort", { PROOF_AI_BACKGROUND_REASONING_EFFORT: "maximal" }],
    ["executor max output tokens", { PROOF_AI_EXECUTOR_MAX_OUTPUT_TOKENS: "0" }],
    ["executor reasoning effort", { PROOF_AI_EXECUTOR_REASONING_EFFORT: "maximal" }],
    ["librarian max output tokens", { PROOF_AI_LIBRARIAN_MAX_OUTPUT_TOKENS: "0" }],
    ["librarian reasoning effort", { PROOF_AI_LIBRARIAN_REASONING_EFFORT: "maximal" }],
    ["move author max output tokens", { PROOF_AI_MOVE_AUTHOR_MAX_OUTPUT_TOKENS: "0" }],
    ["move author reasoning effort", { PROOF_AI_MOVE_AUTHOR_REASONING_EFFORT: "maximal" }],
  ])("rejects an invalid %s override", (_name, config) => {
    expect(() => createAiRuntime({ AI_GATEWAY_API_KEY: "test-credential", ...config })).toThrow();
  });

  it("parses the cost-guard limits and rejects invalid ones", () => {
    expect(() => createAiLimiterFromEnv({})).not.toThrow();
    const limiter = createAiLimiterFromEnv({
      PROOF_AI_MAX_CONCURRENT: "1",
      PROOF_AI_RATE_PER_MINUTE: "5",
    });
    expect(limiter.tryAcquire().ok).toBe(true);
    expect(limiter.tryAcquire()).toMatchObject({ ok: false, code: "ai-concurrency-limited" });
    expect(() => createAiLimiterFromEnv({ PROOF_AI_MAX_CONCURRENT: "0" })).toThrow();
    expect(() => createAiLimiterFromEnv({ PROOF_AI_RATE_PER_MINUTE: "x" })).toThrow();
  });

  it("does not contact a provider while constructing configured transports", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    createAiRuntime({ AI_GATEWAY_API_KEY: "test-credential" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(DEFAULT_LLM_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("applies the formalizer timeout independently of the shared timeout", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const runtime = createAiRuntime({
      AI_GATEWAY_API_KEY: "test-credential",
      PROOF_AI_TIMEOUT_MS: "600000",
      PROOF_AI_FORMALIZER_TIMEOUT_MS: "20",
    });
    const started = Date.now();
    await expect(
      runtime["proof-state-formalizer"]?.transport(formalizerPrepared()),
    ).rejects.toMatchObject({ subcode: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
    fetchSpy.mockRestore();
  });
});

function formalizerPrepared(): PreparedLlmCall {
  const built = buildProofStateFormalizerContext({
    id: "llm-call:runtime-timeout",
    problem: { title: "T", statement: "S." },
    background: { level: "undergraduate", summary: "x", assumptions: [] },
    libraryLayerIds: ["layer:global"],
    packs: ["pack:elementary-logic"],
    approvedLibrary: { results: [], operators: [], sorts: [] },
  });
  if (!built.ok) throw new Error(built.diagnostics[0].message);
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
  return prepared.call;
}
