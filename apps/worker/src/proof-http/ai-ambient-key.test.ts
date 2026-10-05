import { afterEach, describe, expect, it, vi } from "vitest";
import { InspectableMemoryProofStore } from "../memory-proof-store.testing";
import { setDraft } from "../problem-setup.testing";
import { createProofHttpService, type ProofHttpService } from ".";

const services: ProofHttpService[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("explicit AI runtime", () => {
  it("does not enable AI from an ambient AI_API_KEY when no runtime is passed", async () => {
    vi.stubEnv("AI_API_KEY", "ambient-test-credential");
    vi.stubEnv("AI_GATEWAY_API_KEY", "ambient-test-credential");
    const service = createProofHttpService(new InspectableMemoryProofStore());
    services.push(service);
    const { origin } = await service.listen();
    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.reject(new Error("unexpected outbound request")));
    const draft = setDraft();
    const response = await realFetch(`${origin}/ai/formalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        constructionId: "construction:ambient",
        id: "llm-call:ambient",
        problem: draft.problem,
        background: draft.background,
        preferences: draft.preferences,
        libraryLayerIds: draft.libraryLayerIds,
        packs: draft.packs,
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "disabled",
      diagnostics: [{ code: "ai-disabled" }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
