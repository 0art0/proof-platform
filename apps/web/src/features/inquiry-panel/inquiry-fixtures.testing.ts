import { createProofNodeSchema, inquiryRecordSchema, type ProofNode } from "@proof/protocol";
import type { InquiryRecord } from "@proof/protocol";
import type { ConstructionTask } from "@proof/mathjson-model";
import type { AnchoredProofSelection } from "@proof/selections";

const real = { kind: "named", id: "sort:real" } as const;
const declaration = (symbol: string) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: real,
  role: "universal-parameter",
});

export const EXISTENTIAL = ["Exists", "delta", ["Less", "delta", "eps"]] as const;

/**
 * A snapshot with an existential goal `goal:main` (from `eps > 0`) and a plain goal
 * `goal:premise`.
 */
export function makeNode(id = "node:root"): ProofNode {
  const context = (symbols: string[]) => ({
    declarations: symbols.map(declaration),
    hypotheses: [
      { id: "hypothesis:eps", statement: { expression: ["Greater", "eps", 0] } },
      { id: "hypothesis:small", statement: { expression: ["Less", "eps", 1] } },
    ],
  });
  return createProofNodeSchema().parse({
    id,
    state: {
      id: id.replace("node:", "state:"),
      goals: [
        {
          id: "goal:main",
          sequent: { context: context(["eps", "delta"]), conclusion: { expression: EXISTENTIAL } },
        },
        {
          id: "goal:premise",
          sequent: {
            context: context(["eps"]),
            conclusion: { expression: ["Greater", "eps", 0] },
          },
        },
      ],
      obligations: [],
    },
  });
}

/** The node with construction tasks in its snapshot (read-only views do not re-validate). */
export function withConstructions(node: ProofNode, tasks: readonly ConstructionTask[]): ProofNode {
  return { ...node, state: { ...node.state, constructions: tasks } } as ProofNode;
}

export function selection(
  node: ProofNode,
  statement: AnchoredProofSelection["anchor"]["statement"],
  path: number[],
  targetId = "goal:main",
): AnchoredProofSelection {
  return {
    kind: "exact",
    anchor: {
      stateId: node.state.id,
      target: { kind: "goal", id: targetId },
      statement,
    } as AnchoredProofSelection["anchor"],
    path,
  };
}

/** Stored inquiry records with increasing sequences, recorded by the human web actor. */
export function recordSeries() {
  let sequence = 0;
  return (fields: Record<string, unknown>): InquiryRecord => {
    sequence += 1;
    return inquiryRecordSchema.parse({
      sequence,
      commandId: `command:t${sequence}`,
      nodeId: "node:root",
      stateId: "state:root",
      actor: { id: "actor:web", kind: "human" },
      recordedAt: "2026-09-29T10:00:00.000Z",
      ...fields,
    });
  };
}

export const MAIN_TARGET = { kind: "goal", id: "goal:main" } as const;
export const PREMISE_TARGET = { kind: "goal", id: "goal:premise" } as const;

export const METHOD_ENCODED = {
  provenance: "method-encoded",
  method: { kind: "inquiry-method", methodId: "try-result" },
} as const;

/** A stored construction task over `goal:main`, with one requirement of each role. */
export function makeTask(overrides: Record<string, unknown> = {}): ConstructionTask {
  return {
    id: "construction-task:delta",
    symbol: "m_delta",
    displayName: "delta",
    sort: real,
    origin: {
      kind: "existential-goal",
      target: MAIN_TARGET,
      statement: { expression: EXISTENTIAL },
    },
    scope: {
      declarations: [declaration("eps")],
      hypotheses: [{ id: "hypothesis:eps", statement: { expression: ["Greater", "eps", 0] } }],
    },
    allowedDependencies: { declarations: ["eps"], tasks: [] },
    requirements: [
      {
        id: "requirement:positive",
        role: "necessary",
        statement: { expression: ["Greater", ["m_delta", "eps"], 0] },
        evidence: { kind: "attestation", attestationId: "attestation:1" },
        attemptId: "attempt:1",
      },
      {
        id: "requirement:small",
        role: "sufficient",
        statement: { expression: ["Less", ["m_delta", "eps"], "eps"] },
        evidence: { kind: "target", target: MAIN_TARGET },
        attemptId: "attempt:1",
      },
      {
        id: "requirement:half",
        role: "heuristic",
        statement: { expression: ["Equal", ["m_delta", "eps"], ["Divide", "eps", 2]] },
        evidence: { kind: "none" },
        attemptId: "attempt:2",
      },
    ],
    candidates: [],
    status: "partially-specified",
    ...overrides,
  } as unknown as ConstructionTask;
}
