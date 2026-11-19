"use client";

import { createContext } from "react";
import type { AnchoredProofSelection } from "@proof/selections";

/** An inspection is read-only. Choosing a move still goes through the selection and preview. */
export type RewriteInspection = Readonly<{ names: readonly string[]; remaining: number }>;
export type InspectRewrites = (
  selection: AnchoredProofSelection,
  signal: AbortSignal,
) => Promise<RewriteInspection | undefined>;

export const RewriteInspectionContext = createContext<InspectRewrites | undefined>(undefined);

const RELATION_NAMES: Readonly<Record<string, string>> = {
  Equal: "Equality (=)",
  Equivalent: "Equivalence (⇔)",
  Implies: "Implication (⇒)",
  Less: "Strict order (<)",
  LessEqual: "Order (≤)",
  Greater: "Strict order (>)",
  GreaterEqual: "Order (≥)",
  Congruent: "Modular congruence (≡)",
};

export const ALL_REWRITES = "*";
export const COMMON_REWRITE_RELATIONS = Object.keys(RELATION_NAMES);

export function relationName(symbol: string): string {
  return RELATION_NAMES[symbol] ?? symbol;
}
