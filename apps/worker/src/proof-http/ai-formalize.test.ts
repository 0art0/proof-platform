import { afterEach, describe, expect, it } from "vitest";
import { createProofNodeSchema, type ProblemDraft } from "@proof/protocol";
import { createExecutableProofStateSchema } from "@proof/mathjson-model";
import { starterLibraryPacks } from "@proof/library";
import { setDraft } from "../problem-setup.testing";
import { InspectableMemoryProofStore } from "../memory-proof-store.testing";
import { MemoryLlmCallStore } from "../memory-llm-call-store";
import type { LlmTransport, PreparedLlmCall } from "@proof/llm";
import { createProofHttpService, type ProofHttpService } from ".";
import type { AiRuntime } from "../ai-runtime";

const services: ProofHttpService[] = [];
const dispatch = {
  provider: "test-provider",
  model: "test-formalizer",
  promptVersion: "formalizer-test-v1",
} as const;

function draftFor(call: PreparedLlmCall): ProblemDraft {
  if (call.envelope.role !== "proof-state-formalizer") {
    throw new Error("Expected a proof-state formalizer call.");
  }
  return setDraft({
    problem: call.envelope.context.problem,
    background: call.envelope.context.background,
    ...(call.envelope.context.preferences === undefined
      ? {}
      : { preferences: call.envelope.context.preferences }),
    libraryLayerIds: call.envelope.context.libraryLayerIds,
    packs: call.envelope.context.packs,
  });
}

function formalizationFor(call: PreparedLlmCall, draft = draftFor(call)) {
  return {
    result: {
      kind: "formalization",
      draft: {
        ...draft,
        background: {
          ...draft.background,
          domains: draft.background.domains ?? null,
          maximumLevel: draft.background.maximumLevel ?? null,
        },
        preferences: {
          domains: draft.preferences?.domains ?? null,
          notation: draft.preferences?.notation ?? null,
        },
      },
    },
  };
}

function runtime(transport: LlmTransport): AiRuntime {
  return {
    "proof-state-formalizer": { transport, dispatch },
  };
}

async function running(options: {
  store?: InspectableMemoryProofStore;
  calls?: MemoryLlmCallStore;
  transport: LlmTransport;
}): Promise<{
  store: InspectableMemoryProofStore;
  calls: MemoryLlmCallStore;
  origin: string;
}> {
  const store = options.store ?? new InspectableMemoryProofStore();
  const calls = options.calls ?? new MemoryLlmCallStore();
  const service = createProofHttpService(store, {
    llmCalls: calls,
    ai: runtime(options.transport),
  });
  services.push(service);
  return { store, calls, origin: (await service.listen()).origin };
}

async function post(origin: string, path: string, body: unknown) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    constructionId: "construction:formalizer",
    id: "llm-call:formalizer",
    problem: {
      title: "Union commutes",
      statement: "Show that A union B = B union A for sets A and B.",
    },
    background: setDraft().background,
    preferences: setDraft().preferences,
    libraryLayerIds: ["layer:global", "layer:initial-problem"],
    packs: ["pack:sets"],
    ...overrides,
  };
}

function counts(store: InspectableMemoryProofStore) {
  return { sessions: store.sessions.size, nodes: store.nodes.size };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("formalizer HTTP endpoint", () => {
  it("returns the admitted executable proof state and N26 review without creating proof state before approval", async () => {
    const calls: PreparedLlmCall[] = [];
    const transport: LlmTransport = async (call) => {
      calls.push(call);
      return formalizationFor(call);
    };
    const { origin, store } = await running({ transport });
    const response = await post(origin, "/ai/formalize", request());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      callId: string;
      proofState: unknown;
      draft: ProblemDraft;
      review: { rootNode: unknown; operators: unknown[]; digest: string };
    };
    expect(body).toMatchObject({
      status: "ready-for-review",
      provenance: { kind: "minimal-context-llm", role: "proof-state-formalizer" },
      draft: { problem: { title: "Union commutes" }, packs: ["pack:sets"] },
      proofState: expect.any(Object),
      review: { digest: expect.stringMatching(/^sha256:/) },
    });
    const reviewedRoot = createProofNodeSchema({ operators: body.review.operators as never }).parse(
      body.review.rootNode,
    );
    const proofState = createExecutableProofStateSchema({
      operators: body.review.operators as never,
    }).parse(body.proofState);
    expect(proofState).toEqual(reviewedRoot.state);
    expect(proofState.id).toBe(reviewedRoot.state.id);
    expect(proofState.goals).toHaveLength(1);
    expect(proofState.obligations).toHaveLength(0);
    expect(proofState.goals[0]?.sequent.context.declarations.map(({ symbol }) => symbol)).toEqual([
      "A",
      "B",
      "p",
    ]);
    expect(proofState.goals[0]?.sequent.context.hypotheses).toHaveLength(1);
    expect(proofState.goals[0]?.sequent.conclusion).toBeDefined();
    expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });
    expect(calls).toHaveLength(1);
    const formalizerEnvelope = calls[0]?.envelope;
    expect(formalizerEnvelope).toMatchObject({
      role: "proof-state-formalizer",
      context: {
        problem: request().problem,
        background: request().background,
        packs: ["pack:sets"],
        approvedLibrary: {
          results: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
        },
      },
    });
    if (formalizerEnvelope?.role !== "proof-state-formalizer") {
      throw new Error("The formalizer context was not stored.");
    }
    const selectedResultIds =
      starterLibraryPacks()
        .find(({ id }) => id === "pack:sets")
        ?.results.map(({ id }) => id) ?? [];
    const arithmeticResultIds = new Set<string>(
      starterLibraryPacks()
        .find(({ id }) => id === "pack:arithmetic")
        ?.results.map(({ id }) => id) ?? [],
    );
    const contextResultIds = formalizerEnvelope.context.approvedLibrary.results.map(({ id }) => id);
    expect(contextResultIds).toEqual(selectedResultIds);
    expect(contextResultIds.some((id) => arithmeticResultIds.has(id))).toBe(false);

    const approval = await post(origin, "/proof-sessions", {
      sessionId: "session:formalized",
      draft: body.draft,
      reviewedDigest: body.review.digest,
    });
    expect(approval.status).toBe(201);
    expect(await approval.json()).toMatchObject({
      replayed: false,
      session: { id: "session:formalized" },
    });
    expect(counts(store)).toEqual({ sessions: 1, nodes: 1 });
    const approvedSession = await fetch(`${origin}/proof-sessions/session%3Aformalized`);
    expect(approvedSession.status).toBe(200);
    const approvedBody = (await approvedSession.json()) as { node: { state: unknown } };
    expect(
      createExecutableProofStateSchema({ operators: body.review.operators as never }).parse(
        approvedBody.node.state,
      ),
    ).toEqual(proofState);
  });

  it("replays an exact call once and rejects changed content under the same construction/call IDs", async () => {
    let transportCalls = 0;
    const transport: LlmTransport = async (call) => {
      transportCalls += 1;
      return formalizationFor(call);
    };
    const { origin, store } = await running({ transport });
    const body = request();
    const first = await post(origin, "/ai/formalize", body);
    const repeated = await post(origin, "/ai/formalize", body);
    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ replayed: true, status: "ready-for-review" });
    expect(transportCalls).toBe(1);
    expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });

    const changed = await post(
      origin,
      "/ai/formalize",
      request({ problem: { title: "Different theorem", statement: "Show something else." } }),
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ diagnostics: [{ code: "call-id-conflict" }] });
    expect(transportCalls).toBe(1);
    expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });
  });

  const contextTamperCases: ReadonlyArray<
    readonly [string, (draft: ProblemDraft) => ProblemDraft]
  > = [
    ["problem", (draft) => ({ ...draft, problem: { ...draft.problem, title: "Forged" } })],
    [
      "background",
      (draft) => ({ ...draft, background: { ...draft.background, level: "research" } }),
    ],
    ["library selection", (draft) => ({ ...draft, packs: ["pack:arithmetic"] })],
  ];
  it.each(contextTamperCases)(
    "rejects a formalizer draft that changes the submitted %s",
    async (_label, tamper) => {
      const transport: LlmTransport = async (call) =>
        formalizationFor(call, tamper(draftFor(call)));
      const { origin, store } = await running({ transport });
      const response = await post(origin, "/ai/formalize", request());
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        status: "rejected",
        diagnostics: [{ code: "invalid-output" }],
      });
      expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });
    },
  );

  it("returns N26 diagnostics for invalid mathematics and rejects caller-supplied approval data", async () => {
    let transportCalls = 0;
    const transport: LlmTransport = async (call) => {
      transportCalls += 1;
      const draft = setDraft({
        ...draftFor(call),
        goals: [{ format: "latex", latex: "A \\cup" }],
      });
      return formalizationFor(call, draft);
    };
    const { origin, store } = await running({ transport });
    const invalid = await post(origin, "/ai/formalize", request());
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      status: "needs-review",
      diagnostics: [
        expect.objectContaining({ code: "latex-parse-failed", path: ["goals", 0, "latex"] }),
      ],
    });
    expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });

    const forged = await post(
      origin,
      "/ai/formalize",
      request({
        id: "llm-call:forged-approved-library",
        approvedLibrary: { results: ["unapproved"] },
      }),
    );
    expect(forged.status).toBe(400);
    expect(transportCalls).toBe(1);
    expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });
  });

  it("retains scoped construction evidence and keeps malformed output away from proof state", async () => {
    const transport: LlmTransport = async () => ({
      result: { kind: "formalization", mutateProofState: true },
    });
    const { origin, calls, store } = await running({ transport });
    const response = await post(origin, "/ai/formalize", request());
    expect(response.status).toBe(422);
    expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });
    const evidenceResponse = await fetch(
      `${origin}/constructions/construction%3Aformalizer/llm-calls/llm-call%3Aformalizer`,
    );
    expect(evidenceResponse.status).toBe(200);
    expect(await evidenceResponse.json()).toMatchObject({
      record: {
        owner: { kind: "construction", id: "construction:formalizer" },
        role: "proof-state-formalizer",
        status: "completed",
        evidence: {
          status: "rejected",
          rawResponse: { result: { mutateProofState: true } },
          preparedCall: {
            envelope: {
              role: "proof-state-formalizer",
              context: {
                packs: ["pack:sets"],
                approvedLibrary: { results: expect.any(Array) },
              },
            },
          },
        },
      },
    });
    expect(
      await (await fetch(`${origin}/constructions/construction%3Aformalizer/llm-calls`)).json(),
    ).toMatchObject({
      records: [expect.objectContaining({ id: "llm-call:formalizer" })],
    });
    expect(
      await calls.listCallsForOwner({ kind: "construction", id: "construction:formalizer" }),
    ).toHaveLength(1);
  });

  it("rejects and records the obsolete parallel presentation response without creating proof state", async () => {
    const transport: LlmTransport = async (call) => ({
      result: {
        kind: "formalization",
        presentation: { proofState: [{ goals: [{ statement: "old parallel output" }] }] },
        draft: formalizationFor(call).result.draft,
      },
    });
    const { origin, store } = await running({ transport });
    const response = await post(origin, "/ai/formalize", request());
    expect(response.status).toBe(422);
    expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });
    const evidence = await fetch(
      `${origin}/constructions/construction%3Aformalizer/llm-calls/llm-call%3Aformalizer`,
    );
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toMatchObject({
      record: {
        role: "proof-state-formalizer",
        evidence: {
          status: "rejected",
          rawResponse: {
            result: { kind: "formalization", presentation: expect.any(Object) },
          },
        },
      },
    });
  });
});
