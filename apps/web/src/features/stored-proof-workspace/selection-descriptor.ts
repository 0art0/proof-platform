import type { AnchoredProofSelection } from "@proof/selections";
import type { ProofSelectionDescriptor } from "./api-contract";

/**
 * A selection as the proof service takes it: its anchor in a stored snapshot and the occurrence's
 * path. `abstraction` is retrieval-only and never part of the occurrence itself.
 */
export function toDescriptor(
  selection: AnchoredProofSelection,
  abstraction?: ProofSelectionDescriptor["abstraction"],
): ProofSelectionDescriptor {
  const retrievalOnly = abstraction === undefined ? {} : { abstraction };
  return selection.kind === "exact"
    ? { kind: "exact", anchor: selection.anchor, path: [...selection.path], ...retrievalOnly }
    : {
        ...retrievalOnly,
        kind: "associative",
        anchor: selection.anchor,
        containerPath: [...selection.containerPath],
        startOperand: selection.startOperand,
        endOperand: selection.endOperand,
        ...(selection.displayRange === undefined
          ? {}
          : { displayRange: [...selection.displayRange] as [number, number] }),
      };
}
