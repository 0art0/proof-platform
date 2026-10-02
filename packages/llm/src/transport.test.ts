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
