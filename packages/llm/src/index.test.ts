import { describe, expect, it } from "vitest";
import {
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  type DisplayedSuggestionSet,
  type ProofNode,
} from "@proof/protocol";
import {
  buildMoveShortlisterContext,
  buildTopicExtractorContext,
  executePreparedLlmCall,
  llmCallEvidenceSchema,
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
