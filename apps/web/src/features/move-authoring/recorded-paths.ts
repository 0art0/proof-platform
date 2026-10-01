/**
 * Recorded paths of the stored proof-discovery tree as sources for authored moves (design plan
 * §13.1, roadmap N35). Nothing here recomputes history: a step's selections, menu choices and
 * operation are read from the stored edge, its stored snapshots and the suggestion set the edge
 * was applied from (`deriveSemanticStep`, the same derivation the N21 replay uses).
 */
import {
  deriveSemanticStep,
  type DisplayedSuggestionSet,
  type OperatorDeclaration,
  type ProofNode,
  type SemanticStep,
} from "@proof/protocol";
import { replaySteps, type HistoryEdge } from "../stored-proof-workspace/toolbar-actions";

/** A recorded path whose steps could be derived from stored data. */
export type DerivedPath = Readonly<{
  edges: readonly HistoryEdge[];
  steps: readonly SemanticStep[];
  startNode: ProofNode;
  endNode: ProofNode;
}>;

export type DerivePathResult =
  | Readonly<{ ok: true; path: DerivedPath }>
  | Readonly<{ ok: false; stepIndex: number | undefined; message: string }>;

/** The edges from `fromNodeId` down to `toNodeId`, or undefined when that is no path. */
export function pathEdges(
  edges: readonly HistoryEdge[],
  fromNodeId: string,
  toNodeId: string,
): readonly HistoryEdge[] | undefined {
  return replaySteps(edges, { fromNodeId, toNodeId });
}

/** The suggestion sets a path's edges were applied from, by ID. */
export function suggestionSetIdsOf(path: readonly HistoryEdge[]): readonly string[] {
  return [
    ...new Set(
      path.flatMap(({ edge }) =>
        edge.suggestionSetId === undefined ? [] : [edge.suggestionSetId],
      ),
    ),
  ];
}

/**
 * Derive the recorded step of every edge of `path` from the stored snapshots and displayed
 * suggestion sets. Fails, naming the step, when an edge was not applied from a displayed
 * suggestion or applies a library result (a macro contains only primitive moves).
 */
export function deriveRecordedPath(input: {
  nodes: readonly ProofNode[];
  path: readonly HistoryEdge[];
  suggestionSets: ReadonlyMap<string, DisplayedSuggestionSet>;
  operators: readonly OperatorDeclaration[];
}): DerivePathResult {
  const { nodes, path, suggestionSets, operators } = input;
  const first = path[0];
  const last = path[path.length - 1];
  if (first === undefined || last === undefined) {
    return { ok: false, stepIndex: undefined, message: "Choose at least one recorded step." };
  }
  const byId = new Map(nodes.map((node) => [node.id as string, node]));
  const steps: SemanticStep[] = [];
  for (const [index, record] of path.entries()) {
    const parent = byId.get(record.edge.parentNodeId);
    const child = byId.get(record.edge.childNodeId);
    if (parent === undefined || child === undefined) {
      return {
        ok: false,
        stepIndex: index,
        message: `Step ${index + 1} (“${record.name}”) names a node that is not in the stored history.`,
      };
    }
    const suggestionSet =
      record.edge.suggestionSetId === undefined
        ? undefined
        : suggestionSets.get(record.edge.suggestionSetId);
    const derived = deriveSemanticStep({
      parent,
      child,
      edge: record.edge,
      ...(suggestionSet === undefined ? {} : { suggestionSet }),
      operators,
    });
    if (!derived.ok) {
      return {
        ok: false,
        stepIndex: index,
        message: `Step ${index + 1} (“${record.name}”) cannot be used: ${derived.diagnostics[0].message}`,
      };
    }
    if (derived.step.source !== "move") {
      return {
        ok: false,
        stepIndex: index,
        message: `Step ${index + 1} (“${record.name}”) applies a library result; a move is built from primitive steps only.`,
      };
    }
    steps.push(derived.step);
  }
  const startNode = byId.get(first.edge.parentNodeId);
  const endNode = byId.get(last.edge.childNodeId);
  if (startNode === undefined || endNode === undefined) {
    return { ok: false, stepIndex: undefined, message: "The path leaves the stored history." };
  }
  return { ok: true, path: { edges: path, steps, startNode, endNode } };
}

/**
 * Every recorded path of the tree whose steps apply exactly these moves in order: the places a
 * template with this plan has already been done by hand, and so candidates for positive examples.
 */
export function pathsWithMoves(
  edges: readonly HistoryEdge[],
  moveIds: readonly string[],
  limit = 24,
): readonly (readonly HistoryEdge[])[] {
  if (moveIds.length === 0) return [];
  const children = new Map<string, HistoryEdge[]>();
  for (const record of edges) {
    const list = children.get(record.edge.parentNodeId) ?? [];
    list.push(record);
    children.set(record.edge.parentNodeId, list);
  }
  const found: (readonly HistoryEdge[])[] = [];
  const extend = (prefix: readonly HistoryEdge[], index: number) => {
    if (found.length >= limit) return;
    if (index === moveIds.length) {
      found.push(prefix);
      return;
    }
    const tail = prefix[prefix.length - 1];
    const candidates =
      tail === undefined
        ? edges.filter(({ edge }) => edge.moveId === moveIds[0])
        : (children.get(tail.edge.childNodeId) ?? []).filter(
            ({ edge }) => edge.moveId === moveIds[index],
          );
    for (const record of candidates) extend([...prefix, record], index + 1);
  };
  extend([], 0);
  return found;
}
