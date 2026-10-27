import { useSyncExternalStore } from "react";

/**
 * Whether the workspace is laid out in two columns (the proof and the move instructions on the
 * left, the suggestions on the right). Keep it equal to the `min-width` of the media query in
 * stored-proof-workspace.module.css that places the columns.
 */
const WIDE_LAYOUT_QUERY = "(min-width: 72rem)";

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(WIDE_LAYOUT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function currentlyWide(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(WIDE_LAYOUT_QUERY).matches;
}

/**
 * True when the two-column layout applies. The server and the first client render report the
 * stacked layout, so hydration agrees; the columns are placed by CSS either way, and only the
 * order of the elements in the document follows this flag so that Tab visits them in the order
 * they appear: stacked, the suggestions follow the proof; in two columns, the move instructions
 * (left) come before the suggestions (right).
 */
export function useWideLayout(): boolean {
  return useSyncExternalStore(subscribe, currentlyWide, () => false);
}
