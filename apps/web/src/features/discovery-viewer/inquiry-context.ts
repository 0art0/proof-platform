/**
 * The stored data that `createInquiryExplainer` reads (roadmap N22/N23), assembled from the
 * artifact alone. Nothing is recomputed: node snapshots, records, transitions and suggestion names
 * are stored rows.
 */
import type { InquiryExplanationContext, InquiryTransitionView } from "@proof/language";
import type { ProofArtifact } from "@proof/protocol";
import { indexArtifact } from "./artifact-data";

export function inquiryExplanationContext(artifact: ProofArtifact): InquiryExplanationContext {
  const index = indexArtifact(artifact);
  const transitions = new Map<string, InquiryTransitionView>();
  for (const edge of artifact.tree.edges) {
    const evidence = index.evidenceByEdge.get(edge.id);
    transitions.set(edge.childNodeId, {
      transitionClass: edge.transitionClass,
      ...(evidence === undefined ? {} : { evidence }),
    });
  }
  const moves = new Map<string, string>();
  const results = new Map<string, string>();
  const suggestionLabels = new Map<string, ReadonlyMap<string, string>>();
  for (const set of artifact.tree.suggestionSets) {
    suggestionLabels.set(set.id, new Map(set.suggestions.map(({ id, name }) => [id, name])));
    for (const suggestion of set.suggestions) {
      (suggestion.source === "move" ? moves : results).set(suggestion.artifactId, suggestion.name);
    }
  }
  return {
    nodes: new Map(artifact.tree.nodes.map((node) => [node.id, node.state])),
    records: new Map(artifact.inquiryRecords.map((record) => [record.id, record])),
    transitions,
    methodNames: { moves, results },
    suggestionLabels,
  };
}
