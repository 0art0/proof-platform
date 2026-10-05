import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FORMALIZER_MAX_OUTPUT_TOKENS,
  DEFAULT_FORMALIZER_MODEL,
  DEFAULT_FORMALIZER_REASONING_EFFORT,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_SHORTLISTER_MIN_CONFIDENCE,
  DEFAULT_SHORTLISTER_MODEL,
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

  it("configures Luna formalization and Jev shortlisting with the documented defaults", () => {
    const runtime = createAiRuntime({ AI_GATEWAY_API_KEY: "test-credential" });
    expect(Object.keys(runtime).sort()).toEqual(["move-shortlister", "proof-state-formalizer"]);
    expect(runtime["proof-state-formalizer"]?.dispatch).toEqual({
      provider: "vercel-ai-gateway",
      model: DEFAULT_FORMALIZER_MODEL,
      promptVersion: "proof-state-formalizer-v1",
      maxOutputTokens: DEFAULT_FORMALIZER_MAX_OUTPUT_TOKENS,
      reasoningEffort: DEFAULT_FORMALIZER_REASONING_EFFORT,
    });
    expect(runtime["move-shortlister"]?.dispatch).toEqual({
      provider: "vercel-ai-gateway-evaluation",
      model: DEFAULT_SHORTLISTER_MODEL,
      promptVersion: "move-shortlister-jev-v1",
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
