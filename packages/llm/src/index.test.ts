import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  type DisplayedSuggestionSet,
  type ProofNode,
} from "@proof/protocol";
import {
  buildMoveShortlisterContext,
  buildProofStateFormalizerContext,
  buildTopicExtractorContext,
  executePreparedLlmCall,
  llmCallEvidenceSchema,
  llmOutputSchemaForRole,
  prepareLlmCall,
  validateLlmOutput,
  type LlmTransport,
} from "./index";

function node(
  conclusion: unknown = ["And", "p", "q"],
  hypotheses: readonly unknown[] = ["private-remote-fact"],
): ProofNode {
  return createProofNodeSchema().parse({
    id: "node:current",
    state: {
      id: "state:current",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: ["p", "q", "private-remote-symbol", "private-remote-fact"].map(
                (symbol, index) => ({
                  id: `declaration:${index}`,
                  symbol,
                  sort: { kind: "proposition" },
                  role: "universal-parameter",
                }),
              ),
              hypotheses: hypotheses.map((expression, index) => ({
                id: `hypothesis:${index}`,
                statement: { expression },
              })),
            },
            conclusion: { expression: conclusion },
          },
        },
      ],
      obligations: [],
    },
  });
}

function resolvedExact(current: ProofNode, path: readonly number[], fragment: unknown) {
  return {
    kind: "exact",
    anchor: {
      stateId: current.state.id,
      target: { kind: "goal", id: "goal:main" },
      statement: { kind: "conclusion" },
    },
    path,
    fragment,
    declarations: current.state.goals[0]!.sequent.context.declarations,
    position: { polarity: "positive", role: "proposition" },
  };
}

function suggestionSet(
  current: ProofNode,
  options: Readonly<{ abstraction?: boolean; path?: readonly number[]; fragment?: unknown }> = {},
): DisplayedSuggestionSet {
  const selected = resolvedExact(current, options.path ?? [0], options.fragment ?? "p");
  const selectionId = options.abstraction ? "selection:abstracted" : "selection:primary";
  return displayedSuggestionSetSchema.parse({
    id: "suggestion-set:one",
    nodeId: current.id,
    stateId: current.state.id,
    selection: options.abstraction
      ? {
          kind: "selection-query",
          stateId: current.state.id,
          selections: [
            {
              id: selectionId,
              selection: selected,
              abstraction: {
                id: "wildcard:one",
                symbol: "_one",
                role: "retrieval-wildcard",
                sort: { kind: "proposition" },
              },
            },
          ],
        }
      : selected,
    suggestions: [
      {
        id: "suggestion:one",
        source: "result",
        artifactId: "result:one",
        patternId: "pattern:one",
        name: "Candidate one",
        exactRepresentationMatch: !options.abstraction,
        substitutions: [],
        rank: [1, 1],
        reasons: ["The local deterministic matcher supplied this candidate."],
        selectionMatches: [{ selectionId, patternId: "pattern:one" }],
        unresolvedSelectionSlots: [],
        unresolvedParameters: [],
        applicability: options.abstraction ? "requires-input" : "applicable",
        abstractionFit: options.abstraction ? "compatible" : "not-used",
      },
    ],
    variantGroups: [],
  });
}

function topicEnvelope() {
  return buildTopicExtractorContext({
    id: "llm-call:topic",
    problem: "Show that every finite tree has a leaf.",
    background: {
      level: "undergraduate",
      summary: "Elementary graph theory.",
      assumptions: ["Finite graph definitions"],
    },
    preferences: { domains: ["graph theory"], notation: ["Use V and E"] },
  });
}

function shortlisterEnvelope(current = node(), set = suggestionSet(current)) {
  return buildMoveShortlisterContext({
    id: "llm-call:shortlist",
    node: current,
    suggestionSet: set,
    candidateIds: ["suggestion:one"],
    trigger: "explicit-user",
    maxChoices: 1,
  });
}

function formalizerEnvelope(preferences?: { domains?: string[]; notation?: string[] }) {
  return buildProofStateFormalizerContext({
    id: "llm-call:formalizer",
    problem: { title: "Injectivity", statement: "Show that f is injective." },
    background: {
      level: "undergraduate",
      summary: "Basic set theory.",
      assumptions: ["Definitions of functions"],
    },
    ...(preferences === undefined ? {} : { preferences }),
    libraryLayerIds: ["layer:global"],
    packs: ["pack:elementary-logic"],
    approvedLibrary: {
      results: [
        {
          id: "result:function-equality",
          name: "Function equality",
          description: "Equal functions agree on every input.",
          statement: ["Equal", "f", "g"],
          premises: [],
        },
      ],
      operators: [],
      sorts: ["real"],
    },
  });
}

function formalizerWireResult(
  preferences: null | { domains: string[] | null; notation: string[] | null } = null,
) {
  return {
    result: {
      kind: "formalization",
      draft: {
        problem: { title: "Injectivity", statement: "Show that f is injective." },
        background: {
          level: "undergraduate",
          summary: "Basic set theory.",
          assumptions: ["Definitions of functions"],
          domains: null,
          maximumLevel: null,
        },
        preferences: preferences ?? { domains: null, notation: null },
        libraryLayerIds: ["layer:global"],
        packs: ["pack:elementary-logic"],
        declarations: [{ symbol: "f", sort: "real-function" }],
        hypotheses: [],
        goals: [{ format: "latex", latex: "\\forall x,y, f(x)=f(y) \\Rightarrow x=y" }],
      },
    },
  };
}

describe("role-specific LLM context", () => {
  it("builds a frozen topic-only envelope and rejects disguised authority fields", () => {
    const result = topicEnvelope();
    expect(result).toMatchObject({
      ok: true,
      envelope: {
        role: "topic-extractor",
        context: {
          problem: "Show that every finite tree has a leaf.",
          background: { level: "undergraduate" },
        },
      },
    });
    if (result.ok) expect(Object.isFrozen(result.envelope.context)).toBe(true);
    expect(
      buildTopicExtractorContext({
        id: "llm-call:topic",
        problem: "P",
        background: { level: "basic", summary: "Basic.", assumptions: [] },
        approved: true,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-request" }] });
  });

  it("projects only the selected fragment, its free declarations, and supplied cards", () => {
    const current = node();
    const result = shortlisterEnvelope(current);
    expect(result).toMatchObject({
      ok: true,
      envelope: {
        role: "move-shortlister",
        context: {
          selections: [
            {
              expression: "p",
              declarations: [{ symbol: "p" }],
              operators: [],
            },
          ],
          candidates: [
            {
              id: "suggestion:one",
              artifactId: "result:one",
              name: "Candidate one",
            },
          ],
        },
      },
    });
    if (!result.ok) return;
    const serialized = JSON.stringify(result.envelope);
    expect(serialized).not.toContain("private-remote-fact");
    expect(serialized).not.toContain("private-remote-symbol");
    expect(serialized).not.toContain('"q"');
  });

  it("withholds an abstracted fragment and rejects unsupported binder projection", () => {
    const current = node();
    const abstracted = shortlisterEnvelope(current, suggestionSet(current, { abstraction: true }));
    expect(abstracted).toMatchObject({
      ok: true,
      envelope: {
        context: {
          selections: [
            {
              abstraction: { id: "wildcard:one" },
              declarations: [],
              operators: [],
            },
          ],
        },
      },
    });
    if (abstracted.ok && abstracted.envelope.role === "move-shortlister") {
      expect("expression" in abstracted.envelope.context.selections[0]!).toBe(false);
    }

    const quantified = node(["ForAll", "p", "p"], []);
    expect(
      shortlisterEnvelope(quantified, suggestionSet(quantified, { path: [1], fragment: "p" })),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "unsupported-binder-context" }],
    });
  });

  it("rejects stale evidence and undisplayed candidate IDs", () => {
    const current = node();
    expect(
      buildMoveShortlisterContext({
        id: "llm-call:shortlist",
        node: { ...current, id: "node:other" },
        suggestionSet: suggestionSet(current),
        candidateIds: ["suggestion:one"],
        trigger: "explicit-user",
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "stale-evidence" }] });
    expect(
      buildMoveShortlisterContext({
        id: "llm-call:shortlist",
        node: current,
        suggestionSet: suggestionSet(current),
        candidateIds: ["suggestion:missing"],
        trigger: "explicit-user",
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "candidate-not-found" }] });
  });

  it("includes the formalizer's original problem and only the approved library projection", () => {
    const result = formalizerEnvelope();
    expect(result).toMatchObject({
      ok: true,
      envelope: {
        role: "proof-state-formalizer",
        context: {
          problem: { title: "Injectivity", statement: "Show that f is injective." },
          packs: ["pack:elementary-logic"],
          approvedLibrary: {
            results: [{ id: "result:function-equality", statement: ["Equal", "f", "g"] }],
            operators: [],
            sorts: ["real"],
          },
        },
      },
    });
    if (!result.ok) return;
    const serialized = JSON.stringify(result.envelope);
    expect(serialized).not.toContain("rootNode");
    expect(serialized).not.toContain("approval");
    if (result.ok && result.envelope.role === "proof-state-formalizer") {
      expect(Object.isFrozen(result.envelope.context.approvedLibrary.results[0])).toBe(true);
    }
    expect(
      buildProofStateFormalizerContext({
        id: "llm-call:formalizer",
        problem: { title: "P", statement: "P" },
        background: { level: "basic", summary: "Basic.", assumptions: [] },
        libraryLayerIds: ["layer:global"],
        packs: ["pack:elementary-logic"],
        approvedLibrary: { results: [], operators: [], sorts: [] },
        approved: true,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-request" }] });

    const normalizedInput = buildProofStateFormalizerContext({
      id: "llm-call:formalizer-trimmed",
      problem: { title: "  Injectivity  ", statement: "  Show that f is injective.  " },
      background: {
        level: "undergraduate",
        summary: "Basic set theory.",
        assumptions: ["Definitions of functions"],
      },
      preferences: { domains: ["  graph theory  "] },
      libraryLayerIds: ["layer:global"],
      packs: ["pack:elementary-logic"],
      approvedLibrary: { results: [], operators: [], sorts: [] },
    });
    expect(normalizedInput).toMatchObject({
      ok: true,
      envelope: {
        context: {
          problem: { title: "Injectivity", statement: "Show that f is injective." },
          preferences: { domains: ["graph theory"] },
        },
      },
    });
    if (normalizedInput.ok && normalizedInput.envelope.role === "proof-state-formalizer") {
      const call = prepareLlmCall(normalizedInput.envelope);
      if (!call.ok) throw new Error(call.diagnostics[0].message);
      expect(
        validateLlmOutput(
          call.call,
          formalizerWireResult({ domains: ["graph theory"], notation: null }),
        ),
      ).toMatchObject({ ok: true });
    }
  });
});

describe("proof-state formalizer structured boundary", () => {
  it("normalizes nullable provider fields and pins N26 metadata to the request", () => {
    const envelope = formalizerEnvelope();
    if (!envelope.ok) throw new Error(envelope.diagnostics[0].message);
    const prepared = prepareLlmCall(envelope.envelope);
    if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);

    const validated = validateLlmOutput(prepared.call, formalizerWireResult());
    expect(validated).toMatchObject({
      ok: true,
      output: {
        kind: "formalization",
        draft: {
          problem: { title: "Injectivity" },
          background: { level: "undergraduate" },
        },
      },
    });
    if (validated.ok && validated.output.kind === "formalization") {
      expect("preferences" in validated.output.draft).toBe(false);
      expect(validateLlmOutput(prepared.call, { result: validated.output })).toMatchObject({
        ok: true,
        output: { kind: "formalization", draft: { goals: [{ format: "latex" }] } },
      });
    }

    const changedContext = formalizerWireResult();
    changedContext.result.draft.problem.title = "A different problem";
    expect(validateLlmOutput(prepared.call, changedContext)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-output" }],
    });

    const withEmptyPreferences = formalizerEnvelope({ domains: [], notation: [] });
    if (!withEmptyPreferences.ok) throw new Error(withEmptyPreferences.diagnostics[0].message);
    const withEmptyPreferencesCall = prepareLlmCall(withEmptyPreferences.envelope);
    if (!withEmptyPreferencesCall.ok)
      throw new Error(withEmptyPreferencesCall.diagnostics[0].message);
    const emptyPreferenceOutput = formalizerWireResult({ domains: [], notation: [] });
    const emptyPreferencesValidated = validateLlmOutput(
      withEmptyPreferencesCall.call,
      emptyPreferenceOutput,
    );
    expect(emptyPreferencesValidated).toMatchObject({
      ok: true,
      output: { draft: { preferences: { domains: [], notation: [] } } },
    });
    const alteredPack = formalizerWireResult();
    alteredPack.result.draft.packs = [];
    expect(validateLlmOutput(prepared.call, alteredPack)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-output" }],
    });
    const extraNestedField = formalizerWireResult();
    Object.assign(extraNestedField.result.draft.background, { approved: true });
    expect(validateLlmOutput(prepared.call, extraNestedField)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-output" }],
    });

    const legacyPresentation = formalizerWireResult();
    Object.assign(legacyPresentation.result, {
      presentation: { proofState: [] },
    });
    expect(validateLlmOutput(prepared.call, legacyPresentation)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-output" }],
    });
  });

  it("provides a strict object-root JSON schema without opaque MathJSON draft fields", () => {
    const schema = z.toJSONSchema(llmOutputSchemaForRole("proof-state-formalizer"));
    expect(schema).toMatchObject({
      type: "object",
      required: ["result"],
      additionalProperties: false,
    });
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (
        record.type === "object" ||
        (Array.isArray(record.type) && record.type.includes("object"))
      ) {
        expect(record.additionalProperties).toBe(false);
        const properties = record.properties as Record<string, unknown> | undefined;
        if (properties !== undefined) {
          expect(record.required).toEqual(Object.keys(properties));
        }
      }
      expect(Object.keys(record)).not.toEqual([]);
      Object.values(record).forEach(visit);
    };
    visit(schema);
    const encoded = JSON.stringify(schema);
    expect(encoded).toContain('"format":{"type":"string","const":"latex"}');
    expect(encoded).not.toContain('"expression":{}');
    expect(encoded).not.toContain('"sym":{}');
  });
});

describe("validated LLM call boundary", () => {
  it("accepts only strict pending topic proposals", () => {
    const envelope = topicEnvelope();
    if (!envelope.ok) throw new Error(envelope.diagnostics[0].message);
    const prepared = prepareLlmCall(envelope.envelope);
    if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
    const proposal = {
      kind: "topic-manifest",
      domains: ["graph theory"],
      objectKinds: ["finite graph", "tree"],
      vocabulary: ["leaf"],
      notation: [{ symbol: "V", meaning: "vertex set" }],
      backgroundTopics: ["finite graphs"],
      customOperators: [],
    };
    expect(validateLlmOutput(prepared.call, proposal)).toMatchObject({ ok: true });
    expect(validateLlmOutput(prepared.call, { ...proposal, approved: true })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-output" }],
    });
    expect(
      validateLlmOutput(
        {
          ...prepared.call,
          messages: [
            prepared.call.messages[0],
            { role: "user", content: JSON.stringify({ forged: true }) },
          ],
        },
        proposal,
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-request" }] });
  });

  it("checks shortlist membership, uniqueness, and request bounds", () => {
    const envelope = shortlisterEnvelope();
    if (!envelope.ok) throw new Error(envelope.diagnostics[0].message);
    if (envelope.envelope.role !== "move-shortlister")
      throw new Error("Expected shortlist context.");
    const prepared = prepareLlmCall(envelope.envelope);
    if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
    const choice = { suggestionId: "suggestion:one", rationale: "Best local fit." };
    expect(
      validateLlmOutput(prepared.call, { kind: "move-shortlist", choices: [choice] }),
    ).toMatchObject({ ok: true });
    for (const choices of [[choice, choice], [{ ...choice, suggestionId: "suggestion:missing" }]]) {
      expect(validateLlmOutput(prepared.call, { kind: "move-shortlist", choices })).toMatchObject({
        ok: false,
        diagnostics: [{ code: "invalid-output" }],
      });
    }
    expect(
      validateLlmOutput(prepared.call, {
        kind: "insufficient-context",
        requestedCategories: ["full-proof-history"],
        rationale: "I want more context.",
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-output" }] });
  });

  it("validates Jev context and probability evidence, retaining low-confidence decisions", async () => {
    const envelope = shortlisterEnvelope();
    if (!envelope.ok) throw new Error(envelope.diagnostics[0].message);
    if (envelope.envelope.role !== "move-shortlister")
      throw new Error("Expected shortlist context.");
    const prepared = prepareLlmCall(envelope.envelope);
    if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
    const jevOutput = {
      kind: "jev-choice",
      minimumConfidence: 0.65,
      providerRequest: {
        model: "jev-test-model",
        state: envelope.envelope,
        questions: {
          shortlist: {
            type: "choice",
            instructions: "Choose the best supplied candidate.",
            criteria: { "suggestion:one": "Candidate one" },
          },
        },
      },
      providerOutput: {
        type: "choice",
        choice: "suggestion:one",
        probabilities: { "suggestion:one": 1 },
        confidence: 0.9,
      },
    };
    const validated = validateLlmOutput(prepared.call, { result: jevOutput });
    expect(validated).toMatchObject({
      ok: true,
      output: { kind: "move-shortlist", choices: [{ suggestionId: "suggestion:one" }] },
    });

    const lowConfidence = structuredClone(jevOutput);
    lowConfidence.providerOutput.confidence = 0.4;
    const evidence = await executePreparedLlmCall(prepared.call, async () => lowConfidence);
    expect(evidence).toMatchObject({
      status: "validated",
      rawResponse: lowConfidence,
      output: { kind: "declined" },
    });
    expect(llmCallEvidenceSchema.safeParse(evidence).success).toBe(true);

    const forgedContext = structuredClone(jevOutput);
    forgedContext.providerRequest.state.context.candidates[0]!.name = "Changed candidate";
    expect(validateLlmOutput(prepared.call, forgedContext)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-output" }],
    });
    const wrongProbabilityKeys = structuredClone(jevOutput);
    const forgedProbabilities: Record<string, number> = { "suggestion:missing": 1 };
    Object.assign(wrongProbabilityKeys.providerOutput.probabilities, forgedProbabilities);
    expect(validateLlmOutput(prepared.call, wrongProbabilityKeys)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-output" }],
    });
  });

  it("dispatches the exact frozen request and records every outcome without mutation authority", async () => {
    const envelope = shortlisterEnvelope();
    if (!envelope.ok) throw new Error(envelope.diagnostics[0].message);
    const prepared = prepareLlmCall(envelope.envelope);
    if (!prepared.ok) throw new Error(prepared.diagnostics[0].message);
    let dispatched: unknown;
    const transport: LlmTransport = async (call) => {
      dispatched = call;
      expect(Object.isFrozen(call)).toBe(true);
      return {
        kind: "move-shortlist",
        choices: [{ suggestionId: "suggestion:one", rationale: "Best local fit." }],
      };
    };
    const evidence = await executePreparedLlmCall(prepared.call, transport);
    expect(dispatched).toEqual(prepared.call);
    expect(evidence).toMatchObject({ status: "validated", output: { kind: "move-shortlist" } });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(llmCallEvidenceSchema.safeParse(evidence).success).toBe(true);
    const missingRawResponse = Object.fromEntries(
      Object.entries(evidence).filter(([key]) => key !== "rawResponse"),
    );
    expect(llmCallEvidenceSchema.safeParse(missingRawResponse).success).toBe(false);
    expect(
      llmCallEvidenceSchema.safeParse({
        ...evidence,
        output: {
          kind: "topic-manifest",
          domains: [],
          objectKinds: [],
          vocabulary: [],
          notation: [],
          backgroundTopics: [],
          customOperators: [],
        },
      }).success,
    ).toBe(false);

    const rejected = await executePreparedLlmCall(prepared.call, async () => ({ mutate: true }));
    expect(rejected).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-output" }],
    });
    const failed = await executePreparedLlmCall(prepared.call, async () => {
      throw new Error("offline");
    });
    expect(failed).toMatchObject({
      status: "transport-failed",
      diagnostics: [{ code: "transport-failed" }],
    });
  });
});
