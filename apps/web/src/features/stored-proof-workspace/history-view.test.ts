import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ProofNode } from "@proof/protocol";
import { orderedHistory } from "./history-view";
import type { HistoryEdge } from "./toolbar-actions";

// Only the identifiers matter to the walk, so the fixtures carry nothing else.
const node = (id: string) => ({ id }) as unknown as ProofNode;
const link = (parent: string, child: string) =>
  ({
    edge: { parentNodeId: parent, childNodeId: child },
    name: `${parent}>${child}`,
  }) as unknown as HistoryEdge;

type Row = Readonly<{ id: string; incoming: string | undefined; depth: number }>;

const summarize = (rows: ReturnType<typeof orderedHistory>): Row[] =>
  rows.map(({ node: n, incoming, depth }) => ({ id: n.id, incoming: incoming?.name, depth }));

/** The recursive walk the view used before it kept its own stack. */
function recursiveReference(nodes: readonly ProofNode[], edges: readonly HistoryEdge[]): Row[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(edges.map((record) => [record.edge.childNodeId, record]));
  const children = new Map<string, HistoryEdge[]>();
  for (const record of edges) {
    children.set(record.edge.parentNodeId, [
      ...(children.get(record.edge.parentNodeId) ?? []),
      record,
    ]);
  }
  const root = nodes.find((candidate) => !incoming.has(candidate.id));
  if (root === undefined) return [];
  const result: Row[] = [];
  const visit = (current: ProofNode, edge: HistoryEdge | undefined, depth: number) => {
    result.push({ id: current.id, incoming: edge?.name, depth });
    for (const childEdge of children.get(current.id) ?? []) {
      const child = byId.get(childEdge.edge.childNodeId);
      if (child !== undefined) visit(child, childEdge, depth + 1);
    }
  };
  visit(root, undefined, 0);
  return result;
}

describe("orderedHistory", () => {
  it("lists a branching history depth-first, each branch in the order it was recorded", () => {
    const nodes = ["root", "a", "b", "a1", "a2", "b1"].map(node);
    const edges = [
      link("root", "a"),
      link("root", "b"),
      link("a", "a1"),
      link("b", "b1"),
      link("a", "a2"),
    ];
    expect(summarize(orderedHistory(nodes, edges))).toEqual([
      { id: "root", incoming: undefined, depth: 0 },
      { id: "a", incoming: "root>a", depth: 1 },
      { id: "a1", incoming: "a>a1", depth: 2 },
      { id: "a2", incoming: "a>a2", depth: 2 },
      { id: "b", incoming: "root>b", depth: 1 },
      { id: "b1", incoming: "b>b1", depth: 2 },
    ]);
  });

  it("is empty without nodes, and leaves out nodes an edge names but the history lacks", () => {
    expect(orderedHistory([], [])).toEqual([]);
    expect(summarize(orderedHistory([node("root")], [link("root", "missing")]))).toEqual([
      { id: "root", incoming: undefined, depth: 0 },
    ]);
  });

  it("matches the recursive walk on random trees whose edges are recorded in any order", () => {
    const tree = fc.integer({ min: 1, max: 40 }).chain((size) =>
      fc.tuple(
        fc.array(fc.nat(), { minLength: size - 1, maxLength: size - 1 }),
        fc.shuffledSubarray(
          Array.from({ length: Math.max(size - 1, 0) }, (_, index) => index),
          { minLength: size - 1, maxLength: size - 1 },
        ),
        fc.shuffledSubarray(
          Array.from({ length: size }, (_, index) => index),
          { minLength: size, maxLength: size },
        ),
      ),
    );
    fc.assert(
      fc.property(tree, ([parents, edgeOrder, nodeOrder]) => {
        const ids = nodeOrder.map((index) => `node:${index}`);
        const edges = parents.map((parent, offset) =>
          link(`node:${parent % (offset + 1)}`, `node:${offset + 1}`),
        );
        const nodes = [...ids].map(node);
        const ordered = edgeOrder.map((index) => edges[index] as HistoryEdge);
        expect(summarize(orderedHistory(nodes, ordered))).toEqual(
          recursiveReference(nodes, ordered),
        );
      }),
    );
  });

  it("walks a history far deeper than the call stack allows", () => {
    const depth = 100_000;
    const nodes = Array.from({ length: depth }, (_, index) => node(`node:${index}`));
    const edges = Array.from({ length: depth - 1 }, (_, index) =>
      link(`node:${index}`, `node:${index + 1}`),
    );
    const rows = orderedHistory(nodes, edges);
    expect(rows).toHaveLength(depth);
    expect(rows[depth - 1]).toMatchObject({ depth: depth - 1 });
  });
});
