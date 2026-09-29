/**
 * Typed, read-only access to a stored proof artifact for the static viewers (roadmap N28).
 *
 * Nothing here recomputes proof history: the solved status, provability route, pruned proof and
 * sorry assumptions are read from `artifact.final`, and the suggestion menus from the stored
 * displayed suggestion sets. The final material is stored as plain JSON, so it is narrowed with
 * shape guards (it was already validated and recomputed by the exporter and by any importer).
 */
import type { AdditionalAssumption } from "@proof/mathjson-model";
import type {
  DiscoveryEvidence,
  DiscoveryTreeAnalysis,
  DisplayedSuggestionSet,
  ProofArtifact,
  ProofEdge,
  ProofNode,
  PrunedProof,
  TransitionEvent,
} from "@proof/protocol";

export type StoredSuggestion = DisplayedSuggestionSet["suggestions"][number];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAssumption(value: unknown): value is AdditionalAssumption {
  return isRecord(value) && typeof value.id === "string" && isRecord(value.statement);
}

/** The stored N17 analysis, or undefined when the stored tree could not be analyzed. */
export function storedAnalysis(artifact: ProofArtifact): DiscoveryTreeAnalysis | undefined {
  const analysis = artifact.final.analysis;
  if (!isRecord(analysis) || analysis.ok !== true || !isRecord(analysis.route)) return undefined;
  const route = analysis.route;
  if (!Array.isArray(route.nodeIds) || !Array.isArray(route.steps)) return undefined;
  return analysis as unknown as DiscoveryTreeAnalysis;
}

/** The stored pruned proof; null when the tree is not solved. */
export function storedPrunedProof(artifact: ProofArtifact): PrunedProof | undefined {
  const pruned = artifact.final.prunedProof;
  if (!isRecord(pruned) || !Array.isArray(pruned.steps)) return undefined;
  return pruned as unknown as PrunedProof;
}

/** Every closed sorry assumption in the retained snapshots, as stored. */
export function storedSorryAssumptions(artifact: ProofArtifact): readonly AdditionalAssumption[] {
  const found: AdditionalAssumption[] = [];
  for (const value of artifact.final.sorryAssumptions) if (isAssumption(value)) found.push(value);
  return found;
}

export type ArtifactIndex = Readonly<{
  nodes: ReadonlyMap<string, ProofNode>;
  edgesByChild: ReadonlyMap<string, ProofEdge>;
  edgesByParent: ReadonlyMap<string, readonly ProofEdge[]>;
  eventsByEdge: ReadonlyMap<string, TransitionEvent>;
  suggestionSets: ReadonlyMap<string, DisplayedSuggestionSet>;
  /** Stored route evidence by edge ID (only edges of the stored route carry it). */
  evidenceByEdge: ReadonlyMap<string, DiscoveryEvidence>;
}>;

export function indexArtifact(artifact: ProofArtifact): ArtifactIndex {
  const edgesByParent = new Map<string, ProofEdge[]>();
  for (const edge of artifact.tree.edges) {
    const list = edgesByParent.get(edge.parentNodeId) ?? [];
    list.push(edge);
    edgesByParent.set(edge.parentNodeId, list);
  }
  const evidenceByEdge = new Map<string, DiscoveryEvidence>();
  for (const step of storedAnalysis(artifact)?.route.steps ?? []) {
    evidenceByEdge.set(step.edgeId, step.evidence);
  }
  return {
    nodes: new Map(artifact.tree.nodes.map((node) => [node.id, node])),
    edgesByChild: new Map(artifact.tree.edges.map((edge) => [edge.childNodeId, edge])),
    edgesByParent,
    eventsByEdge: new Map(artifact.tree.events.map((event) => [event.edgeId, event])),
    suggestionSets: new Map(artifact.tree.suggestionSets.map((set) => [set.id, set])),
    evidenceByEdge,
  };
}

export function storedSuggestion(
  index: ArtifactIndex,
  suggestionSetId: string | undefined,
  suggestionId: string | undefined,
): StoredSuggestion | undefined {
  if (suggestionSetId === undefined || suggestionId === undefined) return undefined;
  return index.suggestionSets
    .get(suggestionSetId)
    ?.suggestions.find(({ id }) => id === suggestionId);
}

/** "introduce-implication" becomes "Introduce implication". */
export function humanize(identifier: string): string {
  const words = identifier
    .replace(/^[a-z]+:/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return words.length === 0 ? identifier : words.charAt(0).toUpperCase() + words.slice(1);
}

/** The name of the chosen stored suggestion, else the operation kind in words. */
export function edgeLabel(index: ArtifactIndex, edge: ProofEdge): string {
  return (
    storedSuggestion(index, edge.suggestionSetId, edge.chosenSuggestionId)?.name ??
    humanize(edge.operation.kind)
  );
}
