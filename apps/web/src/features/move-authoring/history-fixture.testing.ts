import {
  createProofEdgeSchema,
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  type DisplayedSuggestionSet,
  type ProofNode,
} from "@proof/protocol";
import { fixtureArtifactJson } from "../discovery-viewer/fixture.testing";
import type { HistoryEdge } from "../stored-proof-workspace/toolbar-actions";

type Tree = Readonly<{
  nodes: readonly unknown[];
  edges: readonly unknown[];
  suggestionSets: readonly unknown[];
}>;

const MOVE_NAMES: Readonly<Record<string, string>> = {
  "move:introduce-implication": "Introduce implication",
  "move:apply-result-forward": "Apply result forward",
  "move:close-by-hypothesis": "Close by hypothesis",
};

/**
 * The stored discovery tree of the N27 fixture export (a real worker run of the contraposition
 * problem), parsed the way the browser parses the history API. Nothing is recomputed.
 */
export function fixtureHistory(): Readonly<{
  nodes: readonly ProofNode[];
  edges: readonly HistoryEdge[];
  suggestionSets: ReadonlyMap<string, DisplayedSuggestionSet>;
}> {
  const tree = (fixtureArtifactJson as { tree: Tree }).tree;
  const nodeSchema = createProofNodeSchema({ operators: [] });
  const nodes = tree.nodes.map((node) => nodeSchema.parse(node));
  const edges = tree.edges.map((value) => {
    const edge = createProofEdgeSchema({ operators: [] }).parse(value);
    return { edge, name: MOVE_NAMES[edge.moveId ?? ""] ?? edge.operation.kind };
  });
  const sets = tree.suggestionSets.map((value) => displayedSuggestionSetSchema.parse(value));
  return { nodes, edges, suggestionSets: new Map(sets.map((set) => [set.id as string, set])) };
}

export function nodeById(nodes: readonly ProofNode[], id: string): ProofNode {
  const node = nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`The fixture has no node ${id}.`);
  return node;
}
