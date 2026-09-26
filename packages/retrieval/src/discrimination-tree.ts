import type { PlainMathJson } from "@proof/mathjson-model";
import {
  functionParts,
  groupedAssociativeOperands,
  isAssociativeOperator,
  symbolValue,
  usesAssociativeGrouping,
  type PatternMatchOptions,
} from "./matching";

/** The edge taken by a pattern variable; it skips one whole subterm of the query. */
export const WILDCARD_EDGE = "*";

type Edge<Value> = Readonly<{ arity: number; node: TreeNode<Value> }>;

type TreeNode<Value> = {
  readonly edges: Map<string, Edge<Value>>;
  /** Values at a leaf, bucketed by a secondary key that is filtered without scanning. */
  readonly leaves: Map<string, Value[]>;
};

type PendingTerms = Readonly<{ term: PlainMathJson; next: PendingTerms | undefined }>;

export type DiscriminationTreeQueryOptions = Readonly<{
  /**
   * Query-side abstraction holes. A term for which this returns true matches
   * any pattern subtree: retrieval skips one complete pattern subterm there.
   */
  isQueryWildcard?: ((term: PlainMathJson) => boolean) | undefined;
  /** Secondary-key filter applied to leaf buckets; omitted means every bucket. */
  acceptBucket?: ((bucket: string) => boolean) | undefined;
}>;

/**
 * A discrimination tree over the preorder traversal of pattern MathJSON.
 *
 * Edges are `fn:<head>/<arity>` for a function node with a fixed head,
 * `fnv:<head>` for a binary associative node that may also match a variadic
 * occurrence (see {@link PatternMatchOptions.associativeGrouping}),
 * the same function edge with head `*` when the head is a pattern variable,
 * `sym:<name>` for a fixed symbol, `lit:<canonical JSON>` for any other
 * literal, and {@link WILDCARD_EDGE} for a pattern variable, which consumes
 * one whole query subterm.
 *
 * Retrieval is an over-approximation of first-order matching: every pattern
 * that matches the query term is retrieved, and repeated-variable consistency
 * and sorts are left to the exact matcher.
 */
export class DiscriminationTree<Value> {
  readonly #root: TreeNode<Value> = createNode();
  #size = 0;

  get size(): number {
    return this.#size;
  }

  insert(
    pattern: PlainMathJson,
    wildcardSymbols: ReadonlySet<string>,
    options: PatternMatchOptions,
    bucket: string,
    value: Value,
  ): void {
    let node = this.#root;
    for (const [key, arity] of patternKeys(pattern, wildcardSymbols, options)) {
      let edge = node.edges.get(key);
      if (edge === undefined) {
        edge = { arity, node: createNode() };
        node.edges.set(key, edge);
      }
      node = edge.node;
    }
    const values = node.leaves.get(bucket) ?? [];
    values.push(value);
    node.leaves.set(bucket, values);
    this.#size += 1;
  }

  /** Every stored value whose pattern could match the query term, without duplicates. */
  retrieve(query: PlainMathJson, options: DiscriminationTreeQueryOptions = {}): readonly Value[] {
    const found = new Set<Value>();
    const acceptedBuckets = new Map<string, boolean>();
    const collect = (node: TreeNode<Value>): void => {
      node.leaves.forEach((values, bucket) => {
        let accepted = acceptedBuckets.get(bucket);
        if (accepted === undefined) {
          accepted = options.acceptBucket?.(bucket) ?? true;
          acceptedBuckets.set(bucket, accepted);
        }
        if (accepted) values.forEach((value) => found.add(value));
      });
    };
    const visit = (node: TreeNode<Value>, pending: PendingTerms | undefined): void => {
      if (pending === undefined) {
        collect(node);
        return;
      }
      const { term, next } = pending;
      if (options.isQueryWildcard?.(term) === true) {
        skipSubterms(node, 1).forEach((target) => visit(target, next));
        return;
      }
      const wildcard = node.edges.get(WILDCARD_EDGE);
      if (wildcard !== undefined) visit(wildcard.node, next);

      const symbol = symbolValue(term);
      if (symbol !== undefined) {
        const edge = node.edges.get(symbolKey(symbol));
        if (edge !== undefined) visit(edge.node, next);
        return;
      }
      const parts = functionParts(term);
      if (parts === undefined) {
        const edge = node.edges.get(literalKey(term));
        if (edge !== undefined) visit(edge.node, next);
        return;
      }
      const exact = node.edges.get(functionKey(parts.operator, parts.operands.length));
      if (exact !== undefined) visit(exact.node, pushTerms(parts.operands, next));
      const variableHead = node.edges.get(variableHeadKey(parts.operands.length));
      if (variableHead !== undefined) visit(variableHead.node, pushTerms(parts.operands, next));
      if (isAssociativeOperator(parts.operator)) {
        const grouped = node.edges.get(groupedFunctionKey(parts.operator));
        const operands = groupedAssociativeOperands(parts.operator, parts.operands);
        if (grouped !== undefined && operands !== undefined) {
          visit(grouped.node, pushTerms(operands, next));
        }
      }
    };
    visit(this.#root, { term: query, next: undefined });
    return [...found];
  }
}

function createNode<Value>(): TreeNode<Value> {
  return { edges: new Map(), leaves: new Map() };
}

/** The nodes reached from `node` after consuming `count` complete pattern subterms. */
function skipSubterms<Value>(node: TreeNode<Value>, count: number): readonly TreeNode<Value>[] {
  if (count === 0) return [node];
  return [...node.edges.values()].flatMap((edge) =>
    skipSubterms(edge.node, count - 1 + edge.arity),
  );
}

function pushTerms(
  terms: readonly PlainMathJson[],
  next: PendingTerms | undefined,
): PendingTerms | undefined {
  let pending = next;
  for (let index = terms.length - 1; index >= 0; index -= 1) {
    pending = { term: terms[index] as PlainMathJson, next: pending };
  }
  return pending;
}

/** The preorder edge sequence of a pattern, with each edge's number of child subterms. */
export function patternKeys(
  pattern: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
  options: PatternMatchOptions,
): readonly (readonly [string, number])[] {
  const keys: (readonly [string, number])[] = [];
  const walk = (expression: PlainMathJson): void => {
    const symbol = symbolValue(expression);
    if (symbol !== undefined) {
      keys.push(wildcardSymbols.has(symbol) ? [WILDCARD_EDGE, 0] : [symbolKey(symbol), 0]);
      return;
    }
    const parts = functionParts(expression);
    if (parts === undefined) {
      keys.push([literalKey(expression), 0]);
      return;
    }
    if (wildcardSymbols.has(parts.operator)) {
      keys.push([variableHeadKey(parts.operands.length), parts.operands.length]);
      parts.operands.forEach(walk);
      return;
    }
    keys.push(
      usesAssociativeGrouping(parts, wildcardSymbols, options)
        ? [groupedFunctionKey(parts.operator), 2]
        : [functionKey(parts.operator, parts.operands.length), parts.operands.length],
    );
    parts.operands.forEach(walk);
  };
  walk(pattern);
  return keys;
}

function symbolKey(symbol: string): string {
  return `sym:${symbol}`;
}

function functionKey(operator: string, arity: number): string {
  return `fn:${operator}/${arity}`;
}

function variableHeadKey(arity: number): string {
  return `fn:*/${arity}`;
}

function groupedFunctionKey(operator: string): string {
  return `fnv:${operator}`;
}

function literalKey(expression: PlainMathJson): string {
  return `lit:${canonicalJson(expression)}`;
}

/** JSON with sorted object keys, so structurally equal literals share one edge. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
