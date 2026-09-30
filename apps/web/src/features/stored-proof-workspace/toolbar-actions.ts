/**
 * Pure helpers behind the toolbar's proof actions (design plan §17.2; roadmap N31): whether an
 * action fits the current selection, the N25 command envelopes the actions send, and the
 * deletion and replay facts read from the stored history. Nothing here computes mathematics:
 * selected propositions are sent by occurrence in the stored snapshot, and the worker validates
 * every command again.
 */
import {
  planPreviousMoveDeletion,
  protocolCommandEnvelopeSchema,
  type mathOccurrenceSchema,
  type OperatorDeclaration,
  type ProofEdge,
  type ProofNode,
  type ProtocolCommandEnvelope,
  type ReplayOverride,
} from "@proof/protocol";
import type { PlainMathJson } from "@proof/mathjson-model";
import type { z } from "zod";
import {
  resolveProofSelection,
  type AnchoredExactSelection,
  type AnchoredProofSelection,
} from "@proof/selections";

/** Every toolbar command is sent by the human at this browser. */
export const WEB_ACTOR = Object.freeze({ id: "actor:web", kind: "human" } as const);

/** An occurrence as the envelope takes it (before the worker brands its identifiers). */
export type OccurrenceInput = z.input<typeof mathOccurrenceSchema>;

export type ToolbarTarget = Readonly<{ kind: "goal" | "obligation"; id: string }>;

export type Availability<Value> =
  Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; reason: string }>;

/** Why every mutating action is disabled in a session imported from an artifact (N27). */
export const READ_ONLY_REASON = "This session is read-only (imported artifact)";

function unavailable<Value>(reason: string): Availability<Value> {
  return { ok: false, reason };
}

/** A selected proposition, with the occurrence that names it in the stored snapshot. */
export type SelectedProposition = Readonly<{
  target: ToolbarTarget;
  occurrence: OccurrenceInput;
  expression: PlainMathJson;
  selection: AnchoredExactSelection;
}>;

/** The one goal or obligation every selection lies in. */
export function selectedTarget(
  node: ProofNode,
  selections: readonly AnchoredProofSelection[],
): Availability<ToolbarTarget> {
  if (selections.length === 0) {
    return unavailable("Select an occurrence in a goal or obligation first.");
  }
  if (selections.some(({ anchor }) => anchor.stateId !== node.state.id)) {
    return unavailable("The selection belongs to an older proof-state snapshot.");
  }
  const [first] = selections;
  const target = first!.anchor.target;
  if (
    selections.some(
      ({ anchor }) => anchor.target.kind !== target.kind || anchor.target.id !== target.id,
    )
  ) {
    return unavailable("The selections lie in different targets; select within one target.");
  }
  const exists = (target.kind === "goal" ? node.state.goals : node.state.obligations).some(
    ({ id }) => id === target.id,
  );
  return exists
    ? { ok: true, value: { kind: target.kind, id: target.id } }
    : unavailable("The selected target is not open in this snapshot.");
}

/** Mark sorry: the selection names the whole target it lies in. */
export function sorryAvailability(
  node: ProofNode,
  selections: readonly AnchoredProofSelection[],
): Availability<ToolbarTarget> {
  return selectedTarget(node, selections);
}

/**
 * Case split and backtracking take one exactly selected proposition. The occurrence is what the
 * envelope sends; the expression is shown to the user and never sent.
 */
export function selectedProposition(
  node: ProofNode,
  selections: readonly AnchoredProofSelection[],
  operators: readonly OperatorDeclaration[],
): Availability<SelectedProposition> {
  const target = selectedTarget(node, selections);
  if (!target.ok) return target;
  if (selections.length !== 1) {
    return unavailable("Select exactly one proposition (not several occurrences).");
  }
  const selection = selections[0]!;
  if (selection.kind !== "exact") {
    return unavailable("Select a whole proposition, not a range of operands.");
  }
  const resolved = resolveProofSelection(node.state, selection, { operators });
  if (!resolved.ok) {
    return unavailable(resolved.diagnostics[0].message);
  }
  if (resolved.selection.position.role !== "proposition" || !("fragment" in resolved.selection)) {
    return unavailable("The selection is a term, not a proposition.");
  }
  return {
    ok: true,
    value: {
      target: target.value,
      occurrence: occurrenceOf(node.id, selection),
      expression: resolved.selection.fragment,
      selection,
    },
  };
}

/** The N25 occurrence of an exact selection in the snapshot of `nodeId`. */
export function occurrenceOf(nodeId: string, selection: AnchoredExactSelection): OccurrenceInput {
  const { target, statement } = selection.anchor;
  return {
    nodeId,
    target: { kind: target.kind, id: target.id },
    statement: statement.kind === "conclusion" ? "conclusion" : statement.id,
    path: [...selection.path],
  };
}

/** A fresh command ID for one toolbar action. */
export function toolbarCommandId(action: string): string {
  return `command:web-${action}-${crypto.randomUUID()}`;
}

type EnvelopeInput = Readonly<{ commandId: string; nodeId: string }>;

function envelope(input: EnvelopeInput, command: unknown): ProtocolCommandEnvelope {
  return protocolCommandEnvelopeSchema.parse({
    commandId: input.commandId,
    actor: WEB_ACTOR,
    basis: { nodeId: input.nodeId },
    command,
  });
}

export function sorryEnvelope(
  input: EnvelopeInput & Readonly<{ target: ToolbarTarget }>,
): ProtocolCommandEnvelope {
  return envelope(input, { kind: "sorry", target: { ...input.target } });
}

export function caseSplitEnvelope(
  input: EnvelopeInput & Readonly<{ proposition: SelectedProposition }>,
): ProtocolCommandEnvelope {
  return envelope(input, {
    kind: "case-split",
    target: { ...input.proposition.target },
    proposition: { occurrence: input.proposition.occurrence },
  });
}

export function deletePreviousMoveEnvelope(
  input: EnvelopeInput & Readonly<{ confirmDescendants: boolean }>,
): ProtocolCommandEnvelope {
  return envelope(input, {
    kind: "delete-previous-move",
    ...(input.confirmDescendants ? { confirmDescendants: true } : {}),
  });
}

export function backtrackWithInformationEnvelope(
  input: EnvelopeInput &
    Readonly<{ proposition: SelectedProposition; ancestorNodeId: string | undefined }>,
): ProtocolCommandEnvelope {
  return envelope(input, {
    kind: "backtrack-with-information",
    sourceNodeId: input.nodeId,
    sourceTarget: { ...input.proposition.target },
    proposition: { occurrence: input.proposition.occurrence },
    ...(input.ancestorNodeId === undefined ? {} : { ancestorNodeId: input.ancestorNodeId }),
  });
}

export type ReplaySource = Readonly<{ fromNodeId: string; toNodeId: string }>;

export function replayEnvelope(
  input: EnvelopeInput & Readonly<{ source: ReplaySource; overrides: readonly ReplayOverride[] }>,
): ProtocolCommandEnvelope {
  return envelope(input, {
    kind: "replay",
    source: { ...input.source },
    targetNodeId: input.nodeId,
    ...(input.overrides.length === 0 ? {} : { overrides: input.overrides.map((o) => ({ ...o })) }),
  });
}

// ---------------------------------------------------------------------------------------------
// Stored history
// ---------------------------------------------------------------------------------------------

export type HistoryEdge = Readonly<{ edge: ProofEdge; name: string }>;

export type DeletionImpact =
  | Readonly<{ kind: "root" }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{
      kind: "ready";
      /** The move that entered the current node. */
      moveName: string;
      parentNodeId: string;
      /** Nodes removed: the current node and its descendants. */
      deletedNodeCount: number;
      /** Nodes below the current node; confirmation is required when positive. */
      descendantCount: number;
    }>;

/** What "Delete previous move" would remove, planned by the protocol from the stored tree. */
export function deletionImpact(
  rootNodeId: string,
  currentNodeId: string,
  edges: readonly HistoryEdge[],
): DeletionImpact {
  if (currentNodeId === rootNodeId) return { kind: "root" };
  const planned = planPreviousMoveDeletion({
    rootNodeId,
    currentNodeId,
    edges: edges.map(({ edge }) => edge),
    confirmDescendants: true,
  });
  if (!planned.ok) return { kind: "unavailable", reason: planned.diagnostics[0].message };
  const entering = edges.find(({ edge }) => edge.childNodeId === currentNodeId);
  return {
    kind: "ready",
    moveName: entering?.name ?? "the previous move",
    parentNodeId: planned.plan.parentNodeId,
    deletedNodeCount: planned.plan.deletedNodeIds.length,
    descendantCount: planned.plan.deletedNodeIds.length - 1,
  };
}

/** The edges from the root down to `nodeId`, or undefined when there is no such path. */
export function pathFromRoot(
  edges: readonly HistoryEdge[],
  nodeId: string,
): readonly HistoryEdge[] | undefined {
  const incoming = new Map(edges.map((record) => [record.edge.childNodeId as string, record]));
  const path: HistoryEdge[] = [];
  const visited = new Set<string>();
  let current: string | undefined = nodeId;
  for (;;) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const record = incoming.get(current);
    if (record === undefined) break;
    path.push(record);
    current = record.edge.parentNodeId;
  }
  return path.reverse();
}

/** The strict ancestors of `nodeId`, root first. */
export function ancestorsOf(edges: readonly HistoryEdge[], nodeId: string): readonly string[] {
  return (pathFromRoot(edges, nodeId) ?? []).map(({ edge }) => edge.parentNodeId);
}

/** The steps a replay of `source` would re-match: the edges from `fromNodeId` down to `toNodeId`. */
export function replaySteps(
  edges: readonly HistoryEdge[],
  source: ReplaySource,
): readonly HistoryEdge[] | undefined {
  const path = pathFromRoot(edges, source.toNodeId);
  if (path === undefined) return undefined;
  const start = path.findIndex(({ edge }) => edge.parentNodeId === source.fromNodeId);
  return start === -1 ? undefined : path.slice(start);
}

/**
 * The default start of a replay ending at `toNodeId`: where its branch leaves the current
 * node's branch, so a sibling branch's own steps are replayed; its parent when that is not a
 * strict ancestor of `toNodeId`.
 */
export function defaultReplayStart(
  edges: readonly HistoryEdge[],
  currentNodeId: string,
  toNodeId: string,
): string | undefined {
  const toAncestors = ancestorsOf(edges, toNodeId);
  const currentLine = new Set([...ancestorsOf(edges, currentNodeId), currentNodeId]);
  for (let index = toAncestors.length - 1; index >= 0; index -= 1) {
    const candidate = toAncestors[index]!;
    if (currentLine.has(candidate)) return candidate;
  }
  return toAncestors[toAncestors.length - 1];
}
