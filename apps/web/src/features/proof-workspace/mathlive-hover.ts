import type { OperandPath } from "@proof/selections";
import { operandPathFromElementData } from "./mathlive-selection";

export type HoverBox = Readonly<{ left: number; right: number; top: number; bottom: number }>;

/** One drawn atom. Only annotated leaves have a `path`; operators and brackets do not. */
export type OccurrenceEntry = Readonly<{
  path?: OperandPath | undefined;
  bracket?: "open" | "close" | undefined;
  box: HoverBox;
}>;

const ROOT_ANNOTATION = "data-proof-path-0";
const BRACKETS: ReadonlyMap<string | null, "open" | "close"> = new Map([
  ["(", "open"],
  [")", "close"],
]);

function nearestLeafPath(element: Element): OperandPath | undefined {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const data = Object.fromEntries(
      current
        .getAttributeNames()
        .filter((name) => name.startsWith("data-"))
        .map((name) => [name.slice("data-".length), current?.getAttribute(name) ?? undefined]),
    );
    const path = operandPathFromElementData(data);
    if (path !== undefined) return path.length > 0 ? path : undefined;
  }
  return undefined;
}

/**
 * Every visible atom of a field's shadow root, in document order, measured now. The field's own
 * geometry cannot be used: `getElementInfo` serves bounds from a cache of viewport coordinates that
 * scrolling does not invalidate, and `getOffsetFromPoint` can answer with the statement root near a
 * glyph's edge. Either would name the position of the wrong thing.
 */
export function readOccurrenceTable(root: ParentNode | null): readonly OccurrenceEntry[] {
  const entries: OccurrenceEntry[] = [];
  for (const element of root?.querySelectorAll("[data-atom-id]") ?? []) {
    // The root annotation wraps the whole statement: it is the field, not an atom within it.
    if (element.hasAttribute(ROOT_ANNOTATION)) continue;
    const { left, right, top, bottom } = element.getBoundingClientRect();
    if (right <= left) continue;
    const path = nearestLeafPath(element);
    const box = { left, right, top, bottom };
    const bracket = path === undefined ? BRACKETS.get(element.textContent) : undefined;
    entries.push(bracket === undefined ? { path, box } : { path, bracket, box });
  }
  return entries;
}

const contains = (box: HoverBox, { x, y }: Point) =>
  x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

const area = (box: HoverBox) => (box.right - box.left) * (box.bottom - box.top);

/** Squared distance from a point to a box; zero inside it. */
function distance(box: HoverBox, { x, y }: Point): number {
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - y, 0, y - box.bottom);
  return dx * dx + dy * dy;
}

type Point = Readonly<{ x: number; y: number }>;

function union(boxes: readonly HoverBox[]): HoverBox | undefined {
  if (boxes.length === 0) return undefined;
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    right: Math.max(...boxes.map((box) => box.right)),
    top: Math.min(...boxes.map((box) => box.top)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

function commonPrefix(left: OperandPath, right: OperandPath): OperandPath {
  const end = left.findIndex((part, index) => part !== right[index]);
  return end < 0 ? left.slice(0, right.length) : left.slice(0, end);
}

/** The leaves between a bracket and its partner; undefined for an unmatched bracket. */
function bracketedLeaves(
  entries: readonly OccurrenceEntry[],
  index: number,
): readonly OperandPath[] | undefined {
  const own = entries[index]?.bracket;
  const step = own === "open" ? 1 : -1;
  const leaves: OperandPath[] = [];
  let depth = 0;
  for (let cursor = index; cursor >= 0 && cursor < entries.length; cursor += step) {
    const { bracket, path } = entries[cursor]!;
    if (path !== undefined) leaves.push(path);
    if (bracket !== undefined) depth += bracket === own ? 1 : -1;
    if (depth === 0) return leaves;
  }
  return undefined;
}

/**
 * An operator belongs to what it joins. A bracket belongs to what it encloses, however its
 * neighbours nest. Between two leaves, an operator belongs to their common ancestor: `>` in `x > 0`
 * to the relation, `⇒` to the implication. A prefix such as `¬` or `∀` has a leaf on one side only,
 * and belongs to that leaf's parent.
 */
function operatorPath(entries: readonly OccurrenceEntry[], index: number): OperandPath {
  const enclosed = entries[index]?.bracket === undefined ? [] : bracketedLeaves(entries, index);
  if (enclosed !== undefined && enclosed.length > 0) return enclosed.reduce(commonPrefix);

  const before = entries.slice(0, index).findLast((entry) => entry.path !== undefined)?.path;
  const after = entries.slice(index + 1).find((entry) => entry.path !== undefined)?.path;
  if (before !== undefined && after !== undefined) return commonPrefix(before, after);
  return (before ?? after ?? []).slice(0, -1);
}

/**
 * The operand path drawn at a point, or undefined outside the rendered statement. A point on
 * several atoms takes the smallest, so `a` wins over the fraction around it. A point in the gap
 * between atoms takes the nearest.
 */
export function occurrenceAtPoint(
  entries: readonly OccurrenceEntry[],
  point: Point,
): Readonly<{ path: OperandPath; entry: OccurrenceEntry }> | undefined {
  const content = union(entries.map((entry) => entry.box));
  if (content === undefined || !contains(content, point)) return undefined;

  const rank = (entry: OccurrenceEntry) => [distance(entry.box, point), area(entry.box)] as const;
  let bestIndex = 0;
  entries.forEach((entry, index) => {
    const [bestDistance, bestArea] = rank(entries[bestIndex]!);
    const [entryDistance, entryArea] = rank(entry);
    if (entryDistance < bestDistance || (entryDistance === bestDistance && entryArea < bestArea)) {
      bestIndex = index;
    }
  });
  const entry = entries[bestIndex]!;
  return { path: entry.path ?? operatorPath(entries, bestIndex), entry };
}

/** The box around every leaf under `path`, plus the atom the pointer is on. */
export function occurrenceBox(
  entries: readonly OccurrenceEntry[],
  path: OperandPath,
  hovered: OccurrenceEntry,
): HoverBox {
  const leaves = entries.filter((entry) =>
    path.length === 0
      ? true
      : path.every((part, index) => entry.path !== undefined && entry.path[index] === part),
  );
  return union([...leaves.map((entry) => entry.box), hovered.box]) ?? hovered.box;
}
