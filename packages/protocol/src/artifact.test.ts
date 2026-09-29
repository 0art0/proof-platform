import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CLOSURE_OPERATOR_DECLARATIONS, SET_OPERATOR_DECLARATIONS } from "@proof/library";
import {
  ARTIFACT_SESSION_ID_FIELDS,
  PROOF_ARTIFACT_VERSION,
  canonicalArtifactJson,
  deriveArtifactFinalMaterial,
  deriveTranslationDictionary,
  parseProofArtifact,
  proofArtifactContent,
  withArtifactSessionId,
  proofNodeSchema,
  type ProofArtifact,
} from "./index";

const root = proofNodeSchema.parse({
  id: "node:root",
  state: {
    id: "state:root",
    goals: [
      {
        id: "goal:main",
        sequent: {
          context: {
            declarations: [
              {
                id: "declaration:p",
                symbol: "p",
                sort: { kind: "proposition" },
                role: "universal-parameter",
              },
            ],
            hypotheses: [{ id: "hypothesis:1", statement: { expression: "p" } }],
          },
          conclusion: { expression: "p" },
        },
      },
    ],
    obligations: [],
  },
});

function minimalArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const tree = {
    rootNodeId: root.id,
    currentNodeId: root.id,
    nodes: [root],
    edges: [],
    events: [],
    commands: [],
    suggestionSets: [],
    previews: [],
    replaySteps: [],
    deletions: [],
  };
  return {
    artifactVersion: PROOF_ARTIFACT_VERSION,
    kind: "proof-artifact",
    digest: `sha256:${"a".repeat(64)}`,
    sessionId: "session:source",
    provenance: { kind: "session" },
    problemSetup: { metadata: null },
    initialState: { rootNodeId: root.id, operators: [] },
    library: { operators: [], additionEvents: [], backgroundRevisions: [], finalLibrary: [] },
    tree,
    interactionEvents: [],
    inquiryRecords: [],
    final: deriveArtifactFinalMaterial(tree),
    translationDictionary: deriveTranslationDictionary([]),
    llmCalls: [],
    ...overrides,
  };
}

describe("parseProofArtifact", () => {
  it("accepts a minimal artifact and rejects every other shape with a path", () => {
    expect(parseProofArtifact(minimalArtifact())).toMatchObject({ ok: true });
    expect(parseProofArtifact(null)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-artifact" }],
    });
    expect(parseProofArtifact(minimalArtifact({ artifactVersion: 2 }))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "unsupported-version", path: ["artifactVersion"] }],
    });
    expect(parseProofArtifact(minimalArtifact({ extra: true }))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-artifact" }],
    });
    expect(
      parseProofArtifact(
        minimalArtifact({ initialState: { rootNodeId: root.id, operators: [{ symbol: "X" }] } }),
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-artifact", path: ["initialState", "operators"] }],
    });
    expect(
      parseProofArtifact(
        minimalArtifact({ initialState: { rootNodeId: "node:other", operators: [] } }),
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-artifact", path: ["initialState", "rootNodeId"] }],
    });
  });

  it("validates snapshots against the session operators", () => {
    const undeclared = {
      ...root,
      state: {
        ...root.state,
        goals: [
          {
            ...root.state.goals[0],
            sequent: {
              ...root.state.goals[0]?.sequent,
              conclusion: { expression: ["Closure", "p"] },
            },
          },
        ],
      },
    };
    const artifact = minimalArtifact();
    const tree = { ...(artifact.tree as object), nodes: [undeclared] };
    expect(parseProofArtifact({ ...artifact, tree })).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "invalid-artifact",
          path: ["tree", "nodes", 0, "state", "goals", 0, "sequent", "conclusion", "expression"],
        },
      ],
    });
  });

  it("requires the library environment to declare the session operators identically", () => {
    const operators = [...SET_OPERATOR_DECLARATIONS];
    expect(
      parseProofArtifact(
        minimalArtifact({
          initialState: { rootNodeId: root.id, operators },
          library: { operators: [], additionEvents: [], backgroundRevisions: [], finalLibrary: [] },
          translationDictionary: deriveTranslationDictionary(operators),
        }),
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ path: ["initialState", "operators", 0] }] });
  });
});

describe("canonicalArtifactJson", () => {
  it("is independent of key order and drops undefined properties (property)", () => {
    const value = fc.letrec((tie) => ({
      leaf: fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
      node: fc.oneof(
        { depthSize: "small" },
        tie("leaf"),
        fc.array(tie("node"), { maxLength: 4 }),
        fc.dictionary(fc.string({ maxLength: 4 }), tie("node"), { maxKeys: 4 }),
      ),
    })).node;
    const reversed = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(reversed);
      if (typeof input === "object" && input !== null) {
        return Object.fromEntries(
          Object.entries(input)
            .reverse()
            .map(([key, child]) => [key, reversed(child)]),
        );
      }
      return input;
    };
    fc.assert(
      fc.property(value, (input) => {
        expect(canonicalArtifactJson(reversed(input))).toBe(canonicalArtifactJson(input));
        expect(JSON.parse(canonicalArtifactJson(input))).toEqual(JSON.parse(JSON.stringify(input)));
      }),
    );
    expect(canonicalArtifactJson({ b: 1, a: undefined, c: [undefined] })).toBe(
      '{"b":1,"c":[null]}',
    );
  });
});

describe("withArtifactSessionId", () => {
  it("rewrites exactly the documented session-ID fields and inverts (property)", () => {
    const artifact = parseProofArtifact(minimalArtifact());
    if (!artifact.ok) throw new Error("fixture");
    const withLlm = {
      ...artifact.artifact,
      llmCalls: [
        { id: "call:1", owner: { kind: "proof-session", id: "session:source" } },
        { id: "call:2", owner: { kind: "construction", id: "session:source" } },
      ],
    } as ProofArtifact;
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9:-]{0,20}$/), (sessionId) => {
        const rebased = withArtifactSessionId(withLlm, sessionId);
        expect(rebased.sessionId).toBe(sessionId);
        expect(rebased.llmCalls[0]?.owner).toEqual({ kind: "proof-session", id: sessionId });
        expect(rebased.llmCalls[1]?.owner).toEqual({ kind: "construction", id: "session:source" });
        expect({ ...rebased, sessionId: "x", llmCalls: [] }).toEqual({
          ...withLlm,
          sessionId: "x",
          llmCalls: [],
        });
        expect(withArtifactSessionId(rebased, "session:source")).toEqual(withLlm);
      }),
    );
    expect(ARTIFACT_SESSION_ID_FIELDS.length).toBeGreaterThan(0);
    expect(proofArtifactContent(withLlm)).not.toHaveProperty("digest");
  });
});

describe("derived sections", () => {
  it("builds the translation dictionary from stored operator presentation metadata", () => {
    const operators = [...SET_OPERATOR_DECLARATIONS, ...CLOSURE_OPERATOR_DECLARATIONS];
    const dictionary = deriveTranslationDictionary(operators);
    expect(dictionary.activePackIds).toEqual(expect.arrayContaining(["pack:sets", "pack:closure"]));
    const closure = dictionary.entries.find(({ symbol }) => symbol === "Closure");
    expect(closure).toMatchObject({
      packIds: ["pack:closure"],
      presentation: { latex: { template: expect.stringContaining("operatorname{cl}") } },
    });
    expect(dictionary.entries).toHaveLength(operators.length);
  });

  it("reports an unsolved root and collects sorry assumptions by ID", () => {
    const final = deriveArtifactFinalMaterial({ rootNodeId: root.id, nodes: [root], edges: [] });
    expect(final).toMatchObject({ solved: false, prunedProof: null, sorryAssumptions: [] });
    expect(final.analysis).toMatchObject({ ok: true, solved: false });
  });
});
