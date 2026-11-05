// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  occurrenceAtPoint,
  occurrenceBox,
  readOccurrenceTable,
  type HoverBox,
  type OccurrenceEntry,
} from "./mathlive-hover";

const box = (left: number, right: number, top = 0, bottom = 10): HoverBox => ({
  left,
  right,
  top,
  bottom,
});

/** `x > 0 ⇒ ¬ P`: the implication's antecedent is a relation, its consequent a negation. */
const x: OccurrenceEntry = { path: [0, 0], box: box(0, 10) };
const greater: OccurrenceEntry = { box: box(15, 25) };
const zero: OccurrenceEntry = { path: [0, 1], box: box(30, 40) };
const implies: OccurrenceEntry = { box: box(45, 65) };
const not: OccurrenceEntry = { box: box(70, 80) };
const p: OccurrenceEntry = { path: [1, 0], box: box(85, 95) };
const entries = [x, greater, zero, implies, not, p];

describe("occurrenceAtPoint", () => {
  it("names the leaf under the pointer", () => {
    expect(occurrenceAtPoint(entries, { x: 5, y: 5 })).toEqual({ path: [0, 0], entry: x });
  });

  it("gives an infix operator to the common ancestor of its neighbours", () => {
    expect(occurrenceAtPoint(entries, { x: 20, y: 5 })?.path).toEqual([0]);
    expect(occurrenceAtPoint(entries, { x: 55, y: 5 })?.path).toEqual([]);
  });

  it("gives a prefix operator to the parent of its operand", () => {
    expect(occurrenceAtPoint([not, p], { x: 75, y: 5 })?.path).toEqual([1]);
  });

  it("takes the nearest atom in a gap and nothing outside the statement", () => {
    expect(occurrenceAtPoint(entries, { x: 12, y: 5 })?.entry).toBe(x);
    expect(occurrenceAtPoint(entries, { x: 200, y: 5 })).toBeUndefined();
    expect(occurrenceAtPoint(entries, { x: 5, y: 50 })).toBeUndefined();
    expect(occurrenceAtPoint([], { x: 0, y: 0 })).toBeUndefined();
  });

  it("prefers the smallest atom when atoms overlap", () => {
    const numerator: OccurrenceEntry = { path: [0], box: box(2, 8, 0, 4) };
    const fraction: OccurrenceEntry = { box: box(0, 10, 0, 10) };
    expect(occurrenceAtPoint([fraction, numerator], { x: 5, y: 2 })?.entry).toBe(numerator);
  });
});

describe("brackets", () => {
  const open: OccurrenceEntry = { bracket: "open", box: box(0, 1) };
  const close: OccurrenceEntry = { bracket: "close", box: box(0, 1) };
  const at = (index: number) => box(index * 10, index * 10 + 9);
  const pathAt = (row: readonly OccurrenceEntry[], index: number) =>
    occurrenceAtPoint(
      row.map((entry, position) => ({ ...entry, box: at(position) })),
      { x: index * 10 + 5, y: 5 },
    )?.path;

  it("belong to what they enclose, not to their neighbours", () => {
    // `(p ⇒ q) ⇒ r`
    const row = [
      open,
      { path: [0, 0] },
      { box: box(0, 1) },
      { path: [0, 1] },
      close,
      { box: box(0, 1) },
      { path: [1] },
    ].map((entry) => ({ box: box(0, 1), ...entry }));
    expect(pathAt(row, 0)).toEqual([0]);
    expect(pathAt(row, 4)).toEqual([0]);
  });

  it("are not fooled by a leaf before the opening bracket", () => {
    // `a ∧ (b ⇒ c)`
    const row = [
      { path: [0] },
      { box: box(0, 1) },
      open,
      { path: [1, 0] },
      { path: [1, 1] },
      close,
    ].map((entry) => ({ box: box(0, 1), ...entry }));
    expect(pathAt(row, 2)).toEqual([1]);
    expect(pathAt(row, 5)).toEqual([1]);
  });

  it("pair up across nesting", () => {
    // `(a ∧ (b ⇒ c)) ⇒ d`
    const row = [
      open,
      { path: [0, 0] },
      open,
      { path: [0, 1, 0] },
      { path: [0, 1, 1] },
      close,
      close,
      { path: [1] },
    ].map((entry) => ({ box: box(0, 1), ...entry }));
    expect(pathAt(row, 5)).toEqual([0, 1]);
    expect(pathAt(row, 6)).toEqual([0]);
    expect(pathAt(row, 0)).toEqual([0]);
  });

  it("fall back to their neighbours when unmatched or empty", () => {
    const unmatched = [{ path: [0, 0] }, close, { path: [0, 1] }].map((entry) => ({
      box: box(0, 1),
      ...entry,
    }));
    expect(pathAt(unmatched, 1)).toEqual([0]);
    const empty = [{ path: [0] }, open, close, { path: [1] }].map((entry) => ({
      box: box(0, 1),
      ...entry,
    }));
    expect(pathAt(empty, 1)).toEqual([]);
  });
});

describe("occurrenceBox", () => {
  it("spans the leaves under a path, including what lies between them", () => {
    expect(occurrenceBox(entries, [0], greater)).toEqual(box(0, 40));
  });

  it("includes the hovered operator, which no leaf covers", () => {
    expect(occurrenceBox(entries, [1], not)).toEqual(box(70, 95));
  });

  it("spans everything for the statement root", () => {
    expect(occurrenceBox(entries, [], implies)).toEqual(box(0, 95));
  });
});

describe("readOccurrenceTable", () => {
  function atom(bounds: HoverBox, attributes: Readonly<Record<string, string>> = {}) {
    const element = document.createElement("span");
    element.setAttribute("data-atom-id", "atom");
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
    element.getBoundingClientRect = () => bounds as DOMRect;
    return element;
  }

  it("keeps atoms in order and drops empty atoms and the root wrapper", () => {
    const root = document.createElement("div");
    const statement = atom(box(0, 9), { "data-proof-path-0": "root" });
    const leaf = atom(box(1, 5), { "data-proof-path-2": "0.1" });
    leaf.append(atom(box(1, 1)), atom(box(1, 5)));
    statement.append(leaf, atom(box(6, 9)));
    root.append(statement);

    expect(readOccurrenceTable(root)).toEqual([
      { path: [0, 1], box: box(1, 5) },
      { path: [0, 1], box: box(1, 5) },
      { path: undefined, box: box(6, 9) },
    ]);
  });

  it("measures each time, so scrolling cannot leave the table stale", () => {
    const root = document.createElement("div");
    const leaf = atom(box(0, 5), { "data-proof-path-1": "0" });
    root.append(leaf);
    expect(readOccurrenceTable(root)[0]?.box).toEqual(box(0, 5));

    leaf.getBoundingClientRect = () => box(0, 5, 100, 110) as DOMRect;
    expect(readOccurrenceTable(root)[0]?.box).toEqual(box(0, 5, 100, 110));
  });

  it("marks brackets, but not a bracket drawn inside an annotated leaf", () => {
    const root = document.createElement("div");
    const opening = atom(box(0, 2));
    opening.textContent = "(";
    const inner = atom(box(3, 5), { "data-proof-path-1": "0" });
    inner.textContent = ")";
    root.append(opening, inner);
    expect(readOccurrenceTable(root)).toEqual([
      { path: undefined, bracket: "open", box: box(0, 2) },
      { path: [0], box: box(3, 5) },
    ]);
  });

  it("reads nothing from a field that has not rendered", () => {
    expect(readOccurrenceTable(null)).toEqual([]);
  });
});
