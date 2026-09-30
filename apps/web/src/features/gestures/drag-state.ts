import type { AnchoredProofSelection } from "@proof/selections";

/**
 * What is being carried. A source is only ever an occurrence the proof state already contains
 * (a selection) or a library result named by its stored artifact ID; it never carries mathematics.
 */
export type DragSource =
  | Readonly<{ kind: "hypothesis"; selection: AnchoredProofSelection; label: string }>
  | Readonly<{ kind: "term"; selection: AnchoredProofSelection; label: string }>
  | Readonly<{ kind: "result"; artifactId: string; label: string }>;

/** Pointer drags use native drag events; keyboard users pick up and then drop on the selection. */
export type DragInput = "pointer" | "keyboard";

export type DragOutcome = Readonly<{
  kind: "previewing" | "no-move" | "cancelled";
  message: string;
}>;

export type DragState =
  | Readonly<{ phase: "idle"; outcome?: DragOutcome }>
  | Readonly<{ phase: "carrying"; source: DragSource; input: DragInput; over: boolean }>
  | Readonly<{ phase: "resolving"; source: DragSource; target: AnchoredProofSelection }>;

export type DragAction =
  | Readonly<{ type: "pick-up"; source: DragSource; input: DragInput }>
  | Readonly<{ type: "hover"; over: boolean }>
  | Readonly<{ type: "drop"; target: AnchoredProofSelection }>
  | Readonly<{ type: "cancel" }>
  /** The proof snapshot changed; nothing carried or pending can still apply. */
  | Readonly<{ type: "reset" }>
  /** The drop was turned into a preview, or no displayed move applied. */
  | Readonly<{ type: "settle"; outcome: DragOutcome }>;

export const IDLE_DRAG_STATE: DragState = Object.freeze({ phase: "idle" });

/**
 * The drag state machine: idle → carrying → resolving → idle. Hovering and cancelling only act
 * while carrying, a drop only acts while carrying, and a settle only acts while resolving, so a
 * stray or late event can never start a second resolution.
 */
export function dragReducer(state: DragState, action: DragAction): DragState {
  switch (action.type) {
    case "pick-up":
      // Picking something up replaces whatever was carried; it never interrupts a resolution.
      return state.phase === "resolving"
        ? state
        : { phase: "carrying", source: action.source, input: action.input, over: false };
    case "hover":
      return state.phase === "carrying" && state.over !== action.over
        ? { ...state, over: action.over }
        : state;
    case "drop":
      return state.phase === "carrying"
        ? { phase: "resolving", source: state.source, target: action.target }
        : state;
    case "reset":
      return state.phase === "idle" && state.outcome === undefined ? state : IDLE_DRAG_STATE;
    case "cancel":
      return state.phase === "carrying"
        ? { phase: "idle", outcome: { kind: "cancelled", message: "Drag cancelled." } }
        : state;
    case "settle":
      return state.phase === "resolving" ? { phase: "idle", outcome: action.outcome } : state;
  }
}
