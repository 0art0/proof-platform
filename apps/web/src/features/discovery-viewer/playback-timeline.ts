/**
 * The chronological playback timeline (design plan §4.6, §16; roadmap N28). It merges the stored
 * transition events, interaction events and inquiry records of an artifact; it reads only stored
 * rows.
 *
 * Order. A version-2 artifact stores a per-session transition sequence on every edge, so its
 * transitions are played in that chronological order. A version-1 artifact stores none (and the
 * artifact has no global clock), so its transitions are ordered deterministically from what is
 * stored: causal order (every parent before its children; siblings in stored event order). Each
 * interaction event or inquiry record follows the transition of its own command (when it names
 * one) or of the transition that created its anchor node (records at the root come first),
 * ordered within that slot by recorded time, then interaction events before inquiry records,
 * then sequence.
 */
import type { InquiryRecord, InteractionEvent, ProofArtifact, ProofEdge } from "@proof/protocol";
import { humanize, indexArtifact } from "./artifact-data";
import { treeEdgeView, type TreeEdgeView } from "./tree-layout";

export type PlaybackEntry =
  | Readonly<{
      kind: "transition";
      key: string;
      /** The node whose snapshot the step shows: the child the transition produced. */
      nodeId: string;
      title: string;
      edge: TreeEdgeView;
      commandId: string;
    }>
  | Readonly<{
      kind: "interaction";
      key: string;
      nodeId: string;
      title: string;
      event: InteractionEvent;
    }>
  | Readonly<{
      kind: "inquiry";
      key: string;
      nodeId: string;
      title: string;
      record: InquiryRecord;
    }>;

export type PlaybackTimeline = Readonly<{
  entries: readonly PlaybackEntry[];
  counts: Readonly<{ transitions: number; interactions: number; inquiries: number }>;
}>;

export const PLAYBACK_KIND_LABELS: Readonly<Record<PlaybackEntry["kind"], string>> = Object.freeze({
  transition: "Proof step",
  interaction: "Interaction",
  inquiry: "Inquiry record",
});

type Slotted = Readonly<{ time: string; rank: number; sequence: number; entry: PlaybackEntry }>;

const ROOT_SLOT = "root";
const UNPLACED_SLOT = "unplaced";

export function interactionTitle(event: InteractionEvent): string {
  return humanize(event.kind);
}

export function buildPlaybackTimeline(artifact: ProofArtifact): PlaybackTimeline {
  const index = indexArtifact(artifact);
  const eventOrder = new Map(
    artifact.tree.events.map((event, position) => [event.edgeId, position]),
  );
  const childrenOf = (nodeId: string): readonly ProofEdge[] =>
    [...(index.edgesByParent.get(nodeId) ?? [])].sort(
      (left, right) =>
        (eventOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (eventOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
    );

  const transitions: PlaybackEntry[] = [];
  const transitionSequence = new Map<string, number>();
  const slotOfNode = new Map<string, string>([[artifact.tree.rootNodeId, ROOT_SLOT]]);
  const slotOfCommand = new Map<string, string>();
  const visited = new Set<string>();
  const walk = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    for (const edge of childrenOf(nodeId)) {
      const key = `transition:${edge.id}`;
      transitions.push({
        kind: "transition",
        key,
        nodeId: edge.childNodeId,
        title: treeEdgeView(index, edge).label,
        edge: treeEdgeView(index, edge),
        commandId: edge.commandId,
      });
      if (edge.sequence !== undefined) transitionSequence.set(key, edge.sequence);
      slotOfNode.set(edge.childNodeId, key);
      slotOfCommand.set(edge.commandId, key);
      walk(edge.childNodeId);
    }
  };
  walk(artifact.tree.rootNodeId);
  // Stored sequences, when every transition has one, replace the derived causal order. A mixed
  // artifact cannot occur (the schema requires all or none), but is left in causal order.
  if (transitionSequence.size === transitions.length) {
    transitions.sort(
      (left, right) =>
        (transitionSequence.get(left.key) as number) -
        (transitionSequence.get(right.key) as number),
    );
  }

  const slots = new Map<string, Slotted[]>();
  const place = (slot: string, item: Slotted) => {
    const list = slots.get(slot) ?? [];
    list.push(item);
    slots.set(slot, list);
  };
  for (const event of artifact.interactionEvents) {
    const commandId = "commandId" in event ? event.commandId : undefined;
    const anchor =
      event.kind === "backtracked-with-information" ? event.caseSplitNodeId : event.nodeId;
    place(
      (commandId === undefined ? undefined : slotOfCommand.get(commandId)) ??
        slotOfNode.get(anchor) ??
        UNPLACED_SLOT,
      {
        time: event.recordedAt,
        rank: 0,
        sequence: event.sequence,
        entry: {
          kind: "interaction",
          key: `interaction:${event.id}`,
          nodeId: event.nodeId,
          title: interactionTitle(event),
          event,
        },
      },
    );
  }
  for (const record of artifact.inquiryRecords) {
    place(slotOfNode.get(record.nodeId) ?? UNPLACED_SLOT, {
      time: record.recordedAt,
      rank: 1,
      sequence: record.sequence,
      entry: {
        kind: "inquiry",
        key: `inquiry:${record.id}`,
        nodeId: record.nodeId,
        title: `${humanize(record.kind)} ${record.id}`,
        record,
      },
    });
  }
  const ordered = (slot: string): readonly PlaybackEntry[] =>
    (slots.get(slot) ?? [])
      .sort(
        (left, right) =>
          left.time.localeCompare(right.time) ||
          left.rank - right.rank ||
          left.sequence - right.sequence,
      )
      .map(({ entry }) => entry);

  const entries: PlaybackEntry[] = [...ordered(ROOT_SLOT)];
  for (const transition of transitions) {
    entries.push(transition, ...ordered(transition.key));
  }
  entries.push(...ordered(UNPLACED_SLOT));
  return {
    entries,
    counts: {
      transitions: transitions.length,
      interactions: artifact.interactionEvents.length,
      inquiries: artifact.inquiryRecords.length,
    },
  };
}
