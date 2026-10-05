import { describe, expect, it } from "vitest";
import {
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  type ProofNode,
} from "@proof/protocol";
import {
  buildMoveShortlisterContext,
  buildProofStateFormalizerContext,
  createVercelJevShortlisterTransport,
  createVercelStructuredOutputTransport,
  executePreparedLlmCall,
  prepareLlmCall,
  validateLlmOutput,
  type PreparedLlmCall,
} from "./index";

function formalizerCall(): PreparedLlmCall {
  const built = buildProofStateFormalizerContext({
    id: "llm-call:formalizer-transport",
    problem: { title: "Injectivity", statement: "Show f is injective." },
    background: { level: "undergraduate", summary: "Functions.", assumptions: [] },
    libraryLayerIds: ["layer:global"],
    packs: ["pack:elementary-logic"],
    approvedLibrary: { results: [], operators: [], sorts: ["real-function"] },
  });
  if (!built.ok) throw new Error(built.diagnostics[0].message);
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
  return prepared.call;
}

function shortlistCall(): PreparedLlmCall {
  const node: ProofNode = createProofNodeSchema().parse({
    id: "node:current",
    state: {
      id: "state:current",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: ["p", "q"].map((symbol, index) => ({
                id: `declaration:${index}`,
                symbol,
                sort: { kind: "proposition" },
                role: "universal-parameter",
              })),
              hypotheses: [],
            },
            conclusion: { expression: ["And", "p", "q"] },
          },
        },
      ],
      obligations: [],
    },
  });
  const suggestionSet = displayedSuggestionSetSchema.parse({
    id: "suggestion-set:current",
    nodeId: node.id,
    stateId: node.state.id,
    selection: {
      kind: "exact",
      anchor: {
        stateId: node.state.id,
        target: { kind: "goal", id: "goal:main" },
        statement: { kind: "conclusion" },
      },
      path: [0],
      fragment: "p",
      declarations: node.state.goals[0]!.sequent.context.declarations,
      position: { polarity: "positive", role: "proposition" },
    },
    suggestions: ["two", "one"].map((suffix, index) => ({
      id: `suggestion:${suffix}`,
      source: "result",
      artifactId: `result:${suffix}`,
      patternId: `pattern:${suffix}`,
      name: `Candidate ${suffix}`,
      exactRepresentationMatch: index === 0,
      substitutions: [],
      rank: [2 - index],
      reasons: [`Candidate ${suffix} was retrieved deterministically.`],
      selectionMatches: [{ selectionId: "selection:primary", patternId: `pattern:${suffix}` }],
      unresolvedSelectionSlots: [],
      unresolvedParameters: [],
      applicability: "applicable",
      abstractionFit: "not-used",
    })),
    variantGroups: [],
  });
  const built = buildMoveShortlisterContext({
    id: "llm-call:shortlist-transport",
    node,
    suggestionSet,
    candidateIds: ["suggestion:one", "suggestion:two"],
    trigger: "explicit-user",
    maxChoices: 2,
  });
  if (!built.ok) throw new Error(built.diagnostics[0].message);
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
  return prepared.call;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Vercel structured formalizer transport", () => {
  it("sends the Luna model, high reasoning, bounded tokens, and a strict generated schema", async () => {
    const call = formalizerCall();
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    const transport = createVercelStructuredOutputTransport({
      apiKey: "test-key",
      baseUrl: "https://gateway.test/",
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  result: { kind: "declined", reason: "Need clarification." },
                }),
              },
            },
          ],
          usage: { completion_tokens: 7 },
          reasoning: "transport must not retain reasoning metadata",
        });
      },
    });

    const output = await transport(call);
    expect(requestUrl).toBe("https://gateway.test/v1/chat/completions");
    expect(requestBody).toMatchObject({
      model: "openai/gpt-6-luna",
      stream: false,
      max_completion_tokens: 32_000,
      reasoning_effort: "high",
      messages: call.messages,
      response_format: {
        type: "json_schema",
        json_schema: { strict: true, name: "proof_proof_state_formalizer_output" },
      },
    });
    expect(requestBody?.temperature).toBeUndefined();
    const responseFormat = requestBody?.response_format as {
      json_schema: { schema: Record<string, unknown> };
    };
    expect(responseFormat.json_schema.schema).toMatchObject({
      type: "object",
      required: ["result"],
      additionalProperties: false,
    });
    expect(output).toEqual({ result: { kind: "declined", reason: "Need clarification." } });
    expect(JSON.stringify(output)).not.toContain("reasoning");
    expect(JSON.stringify(output)).not.toContain("completion_tokens");
    expect(validateLlmOutput(call, output)).toMatchObject({
      ok: true,
      output: { kind: "declined" },
    });
  });

  it("turns refusals, truncated responses, malformed JSON, and timeouts into bounded outcomes", async () => {
    const call = formalizerCall();
    const refusal = createVercelStructuredOutputTransport({
      apiKey: "test-key",
      fetch: async () =>
        response({
          choices: [{ finish_reason: "stop", message: { refusal: "Cannot help.", content: null } }],
        }),
    });
    expect(await refusal(call)).toMatchObject({ kind: "declined" });

    const truncated = createVercelStructuredOutputTransport({
      apiKey: "test-key",
      fetch: async () =>
        response({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }),
    });
    const truncatedEvidence = await executePreparedLlmCall(call, truncated);
    expect(truncatedEvidence).toMatchObject({ status: "rejected", rawResponse: null });

    const malformed = createVercelStructuredOutputTransport({
      apiKey: "test-key",
      fetch: async () =>
        response({ choices: [{ finish_reason: "stop", message: { content: "{bad json" } }] }),
    });
    const malformedEvidence = await executePreparedLlmCall(call, malformed);
    expect(malformedEvidence).toMatchObject({
      status: "rejected",
      rawResponse: null,
      diagnostics: [{ code: "invalid-output" }],
    });

    const timed = createVercelStructuredOutputTransport({
      apiKey: "test-key",
      timeoutMs: 5,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const timedEvidence = await executePreparedLlmCall(call, timed);
    expect(timedEvidence).toMatchObject({
      status: "transport-failed",
      diagnostics: [{ code: "transport-failed" }],
    });
  });
});

describe("Vercel Jev shortlist transport", () => {
  it("sends only the local shortlist state and exact candidate criteria", async () => {
    const call = shortlistCall();
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    const transport = createVercelJevShortlisterTransport({
      apiKey: "test-key",
      baseUrl: "https://gateway.test",
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({
          answers: {
            shortlist: {
              type: "choice",
              choice: "suggestion:two",
              probabilities: { "suggestion:one": 0.2, "suggestion:two": 0.8 },
              confidence: 0.91,
            },
          },
          providerMetadata: { typesafe: { confidence: { shortlist: 0.9 } } },
          chainOfThought: "must not be copied into the result",
        });
      },
    });
    const result = await transport(call);
    expect(requestUrl).toBe("https://gateway.test/v1/evaluate");
    expect(requestBody).toMatchObject({
      model: "typesafe-ai/jev",
      state: call.envelope,
      questions: {
        shortlist: {
          type: "choice",
          criteria: {
            "suggestion:one": "Candidate one",
            "suggestion:two": "Candidate two",
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("chainOfThought");
    expect(JSON.stringify(result)).not.toContain("providerMetadata");
    expect(validateLlmOutput(call, result)).toMatchObject({
      ok: true,
      output: { kind: "move-shortlist", choices: [{ suggestionId: "suggestion:two" }] },
    });
  });

  it("retains low-confidence and invalid native choice evidence and rejects forged candidate maps", async () => {
    const call = shortlistCall();
    const lowConfidenceTransport = createVercelJevShortlisterTransport({
      apiKey: "test-key",
      minimumConfidence: 0.8,
      fetch: async () =>
        response({
          answers: {
            shortlist: {
              type: "choice",
              choice: "suggestion:two",
              probabilities: { "suggestion:one": 0.2, "suggestion:two": 0.8 },
              confidence: 0.4,
            },
          },
        }),
    });
    const lowConfidenceEvidence = await executePreparedLlmCall(call, lowConfidenceTransport);
    expect(lowConfidenceEvidence).toMatchObject({
      status: "validated",
      rawResponse: {
        kind: "jev-choice",
        minimumConfidence: 0.8,
        providerOutput: { choice: "suggestion:two", confidence: 0.4 },
      },
      output: { kind: "declined" },
    });

    const invalidMapTransport = createVercelJevShortlisterTransport({
      apiKey: "test-key",
      fetch: async () =>
        response({
          answers: {
            shortlist: {
              type: "choice",
              choice: "suggestion:two",
              probabilities: { "suggestion:two": 1 },
              confidence: 0.95,
            },
          },
        }),
    });
    const invalidEvidence = await executePreparedLlmCall(call, invalidMapTransport);
    expect(invalidEvidence).toMatchObject({
      status: "rejected",
      rawResponse: { providerOutput: { probabilities: { "suggestion:two": 1 } } },
      diagnostics: [{ code: "invalid-output" }],
    });

    const nativeResult = await invalidMapTransport(call);
    if (typeof nativeResult !== "object" || nativeResult === null)
      throw new Error("Missing Jev result.");
    const forgedState = structuredClone(nativeResult) as {
      providerRequest: { state: { context: { candidates: { name: string }[] } } };
    };
    forgedState.providerRequest.state.context.candidates[0]!.name = "Forged candidate";
    expect(validateLlmOutput(call, forgedState)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-output" }],
    });
  });
});

function fakeClock() {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    retry: {
      now: () => time,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        time += ms;
      },
      random: () => 0.5,
    },
  };
}

function stopResponse(): Response {
  return response({
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: JSON.stringify({ result: { kind: "declined", reason: "Need clarification." } }),
        },
      },
    ],
  });
}

describe("transport failure classification and retries", () => {
  const SECRET = "sk-secret-key-123";
  it.each([
    [429, "rate-limited", 3],
    [500, "server-error", 3],
    [503, "server-error", 3],
    [408, "server-error", 3],
    [401, "auth", 1],
    [403, "auth", 1],
    [400, "bad-request", 1],
    [404, "bad-request", 1],
  ])("classifies HTTP %i as %s with %i attempt(s)", async (status, subcode, attempts) => {
    let calls = 0;
    const clock = fakeClock();
    const transport = createVercelStructuredOutputTransport({
      apiKey: SECRET,
      retry: clock.retry,
      fetch: async () => {
        calls += 1;
        return new Response(`provider says ${SECRET}`, { status });
      },
    });
    const evidence = await executePreparedLlmCall(formalizerCall(), transport);
    expect(calls).toBe(attempts);
    expect(evidence).toMatchObject({
      status: "transport-failed",
      diagnostics: [{ code: "transport-failed", subcode }],
    });
    expect(JSON.stringify(evidence)).not.toContain(SECRET);
    expect(JSON.stringify(evidence)).not.toContain("provider says");
  });

  it("retries network errors and succeeds on a later attempt, with exponential jittered waits", async () => {
    let calls = 0;
    const clock = fakeClock();
    const transport = createVercelStructuredOutputTransport({
      apiKey: SECRET,
      retry: { ...clock.retry, baseDelayMs: 100 },
      fetch: async () => {
        calls += 1;
        if (calls < 3) throw new Error(`socket reset for Bearer ${SECRET}`);
        return stopResponse();
      },
    });
    const evidence = await executePreparedLlmCall(formalizerCall(), transport);
    expect(evidence.status).toBe("validated");
    expect(calls).toBe(3);
    // random = 0.5 => delay = backoff * 0.75
    expect(clock.sleeps).toEqual([75, 150]);
  });

  it("reports a persistent network error as network and never leaks the thrown message", async () => {
    const clock = fakeClock();
    const transport = createVercelStructuredOutputTransport({
      apiKey: SECRET,
      retry: clock.retry,
      fetch: async () => {
        throw new Error(`socket reset for Bearer ${SECRET}`);
      },
    });
    const evidence = await executePreparedLlmCall(formalizerCall(), transport);
    expect(evidence).toMatchObject({ diagnostics: [{ subcode: "network" }] });
    expect(JSON.stringify(evidence)).not.toContain(SECRET);
  });

  it("does not send the key anywhere but the Authorization header", async () => {
    let seenBody = "";
    const transport = createVercelStructuredOutputTransport({
      apiKey: SECRET,
      fetch: async (_input, init) => {
        seenBody = String(init?.body);
        return stopResponse();
      },
    });
    const evidence = await executePreparedLlmCall(formalizerCall(), transport);
    expect(seenBody).not.toContain(SECRET);
    expect(JSON.stringify(evidence)).not.toContain(SECRET);
  });

  it("honours Retry-After seconds when it exceeds the computed backoff", async () => {
    let calls = 0;
    const clock = fakeClock();
    const transport = createVercelStructuredOutputTransport({
      apiKey: SECRET,
      retry: { ...clock.retry, baseDelayMs: 100 },
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response("", { status: 429, headers: { "Retry-After": "2" } });
        return stopResponse();
      },
    });
    const evidence = await executePreparedLlmCall(formalizerCall(), transport);
    expect(evidence.status).toBe("validated");
    expect(clock.sleeps).toEqual([2000]);
  });

  it("gives up instead of waiting past the total time budget", async () => {
    let calls = 0;
    const clock = fakeClock();
    const transport = createVercelStructuredOutputTransport({
      apiKey: SECRET,
      timeoutMs: 10_000,
      retry: clock.retry,
      fetch: async () => {
        calls += 1;
        return new Response("", { status: 429, headers: { "Retry-After": "60" } });
      },
    });
    const evidence = await executePreparedLlmCall(formalizerCall(), transport);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(evidence).toMatchObject({ diagnostics: [{ subcode: "rate-limited" }] });
  });

  it("bounds the total waiting by the budget across attempts", async () => {
    const clock = fakeClock();
    const start = clock.retry.now();
    const transport = createVercelStructuredOutputTransport({
      apiKey: SECRET,
      timeoutMs: 1_000,
      retry: { ...clock.retry, maxAttempts: 10, baseDelayMs: 300, maxDelayMs: 5_000 },
      fetch: async () => new Response("", { status: 503 }),
    });
    await executePreparedLlmCall(formalizerCall(), transport);
    expect(clock.retry.now() - start).toBeLessThan(1_000);
  });

  it("classifies an aborted request as a non-retried timeout", async () => {
    let calls = 0;
    const transport = createVercelStructuredOutputTransport({
      apiKey: SECRET,
      timeoutMs: 5,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          calls += 1;
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const evidence = await executePreparedLlmCall(formalizerCall(), transport);
    expect(calls).toBe(1);
    expect(evidence).toMatchObject({ diagnostics: [{ subcode: "timeout" }] });
  });

  it("classifies a 200 response with a non-JSON body as invalid-response without retrying", async () => {
    let calls = 0;
    const transport = createVercelStructuredOutputTransport({
      apiKey: SECRET,
      fetch: async () => {
        calls += 1;
        return new Response("<html>gateway</html>", { status: 200 });
      },
    });
    const evidence = await executePreparedLlmCall(formalizerCall(), transport);
    expect(calls).toBe(1);
    expect(evidence).toMatchObject({ diagnostics: [{ subcode: "invalid-response" }] });
  });

  it("applies the same classification and retries to the Jev transport", async () => {
    let calls = 0;
    const clock = fakeClock();
    const transport = createVercelJevShortlisterTransport({
      apiKey: SECRET,
      retry: clock.retry,
      fetch: async () => {
        calls += 1;
        return new Response(SECRET, { status: 502 });
      },
    });
    const evidence = await executePreparedLlmCall(shortlistCall(), transport);
    expect(calls).toBe(3);
    expect(evidence).toMatchObject({ diagnostics: [{ subcode: "server-error" }] });
    expect(JSON.stringify(evidence)).not.toContain(SECRET);
  });
});

describe("Jev confidence extraction", () => {
  const probabilities = { "suggestion:one": 0.2, "suggestion:two": 0.8 };
  function jevWith(answerExtras: object, top: object) {
    return createVercelJevShortlisterTransport({
      apiKey: "test-key",
      fetch: async () =>
        response({
          answers: {
            shortlist: {
              type: "choice",
              choice: "suggestion:two",
              probabilities,
              ...answerExtras,
            },
          },
          ...top,
        }),
    });
  }

  it("reads confidence from the answer", async () => {
    const result = await jevWith({ confidence: 0.7 }, {})(shortlistCall());
    expect(result).toMatchObject({ providerOutput: { confidence: 0.7 } });
  });

  it("falls back to providerMetadata.typesafe.confidence.shortlist", async () => {
    const top = { providerMetadata: { typesafe: { confidence: { shortlist: 0.66 } } } };
    const result = await jevWith({}, top)(shortlistCall());
    expect(result).toMatchObject({ providerOutput: { confidence: 0.66 } });
  });

  it("falls back to a scalar providerMetadata.typesafe.confidence", async () => {
    const top = { providerMetadata: { typesafe: { confidence: 0.61 } } };
    const result = await jevWith({}, top)(shortlistCall());
    expect(result).toMatchObject({ providerOutput: { confidence: 0.61 } });
  });

  it("prefers the answer confidence over provider metadata", async () => {
    const top = { providerMetadata: { typesafe: { confidence: 0.1 } } };
    const result = await jevWith({ confidence: 0.9 }, top)(shortlistCall());
    expect(result).toMatchObject({ providerOutput: { confidence: 0.9 } });
  });

  it("reports a missing confidence as its own diagnostic, not invalid-output", async () => {
    const evidence = await executePreparedLlmCall(shortlistCall(), jevWith({}, {}));
    expect(evidence).toMatchObject({
      status: "transport-failed",
      diagnostics: [{ code: "transport-failed", subcode: "missing-confidence" }],
    });
  });
});
