/**
 * The full discovery tree as an ordered outline (design plan §4.6, §16; roadmap N28). Pure: it reads
 * only the stored nodes, edges, suggestion sets and final material of the artifact.
 */
import type { DiscoveryEvidence, MacroLink, ProofArtifact, ProofEdge } from "@proof/protocol";
import { edgeLabel, indexArtifact, storedAnalysis, type ArtifactIndex } from "./artifact-data";

export type TreeEdgeView = Readonly<{
  edgeId: string;
  commandId: string;
  parentNodeId: string;
  childNodeId: string;
  /** The chosen stored suggestion's name, else the operation kind in words. */
  label: string;
  operationKind: string;
  moveId?: string | undefined;
  /** Set on a step of a multi-step macro application. */
  macro?: MacroLink | undefined;
  transitionClass: ProofEdge["transitionClass"];
  /** Stored evidence kind (every edge of a version-2 artifact; the route only for version 1). */
  evidence?: DiscoveryEvidence | undefined;
}>;

export type RouteStatus = "solved-route" | "partial-route" | "abandoned";

export type TreeRowView = Readonly<{
  nodeId: string;
  depth: number;
  /** The edge from the parent, absent for a root. */
  parentEdge?: TreeEdgeView | undefined;
  childCount: number;
  goalCount: number;
  obligationCount: number;
  assumptionCount: number;
  isRoot: boolean;
  isCurrent: boolean;
  routeStatus: RouteStatus;
}>;

export type TreeLayout = Readonly<{
  solved: boolean;
  rows: readonly TreeRowView[];
  edges: readonly TreeEdgeView[];
  routeNodeIds: readonly string[];
}>;

export const ROUTE_STATUS_LABELS: Readonly<Record<RouteStatus, string>> = Object.freeze({
  "solved-route": "On the solved route",
  "partial-route": "On the best partial route",
  abandoned: "Abandoned branch",
});

export function treeEdgeView(index: ArtifactIndex, edge: ProofEdge): TreeEdgeView {
  return {
    edgeId: edge.id,
    commandId: edge.commandId,
    parentNodeId: edge.parentNodeId,
    childNodeId: edge.childNodeId,
    label: edgeLabel(index, edge),
    operationKind: edge.operation.kind,
    moveId: edge.moveId,
    macro: edge.macro,
    transitionClass: edge.transitionClass,
    // The kernel's stored evidence; the route's derived evidence is the version-1 fallback.
    evidence: edge.evidence ?? index.evidenceByEdge.get(edge.id),
  };
}

export function buildTreeLayout(artifact: ProofArtifact): TreeLayout {
  const index = indexArtifact(artifact);
  const solved = artifact.final.solved;
  const routeNodeIds = storedAnalysis(artifact)?.route.nodeIds ?? [];
  const onRoute = new Set<string>(routeNodeIds);
  const routeStatus = (nodeId: string): RouteStatus =>
    !onRoute.has(nodeId) ? "abandoned" : solved ? "solved-route" : "partial-route";

  const eventOrder = new Map(
    artifact.tree.events.map((event, position) => [event.edgeId, position]),
  );
  const childrenOf = (nodeId: string): readonly ProofEdge[] =>
    [...(index.edgesByParent.get(nodeId) ?? [])].sort(
      (left, right) =>
        (eventOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (eventOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
    );

  const rows: TreeRowView[] = [];
  const edges: TreeEdgeView[] = [];
  const visited = new Set<string>();
  const visit = (nodeId: string, depth: number, parentEdge: ProofEdge | undefined) => {
    const node = index.nodes.get(nodeId);
    if (node === undefined || visited.has(nodeId)) return;
    visited.add(nodeId);
    const children = childrenOf(nodeId);
    const edgeView = parentEdge === undefined ? undefined : treeEdgeView(index, parentEdge);
    if (edgeView !== undefined) edges.push(edgeView);
    rows.push({
      nodeId,
      depth,
      parentEdge: edgeView,
      childCount: children.length,
      goalCount: node.state.goals.length,
      obligationCount: node.state.obligations.length,
      assumptionCount: node.state.assumptions?.length ?? 0,
      isRoot: nodeId === artifact.tree.rootNodeId,
      isCurrent: nodeId === artifact.tree.currentNodeId,
      routeStatus: routeStatus(nodeId),
    });
    for (const child of children) visit(child.childNodeId, depth + 1, child);
  };
  visit(artifact.tree.rootNodeId, 0, undefined);
  // A well-formed artifact has no unreachable node; show any that exist rather than hide them.
  for (const node of artifact.tree.nodes) {
    if (!visited.has(node.id)) visit(node.id, 0, index.edgesByChild.get(node.id));
  }
  return { solved, rows, edges, routeNodeIds };
}
