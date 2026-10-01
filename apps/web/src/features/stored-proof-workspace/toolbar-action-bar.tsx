"use client";

import { useId, useState } from "react";
import type {
  OperatorDeclaration,
  ProofNode,
  ProtocolCommandEnvelope,
  ProtocolCommandResponse,
} from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import type { Presentation } from "@proof/language";
import type { WorkspaceView } from "../proof-workspace";
import { BacktrackDialog } from "./backtrack-dialog";
import { DeleteMoveDialog } from "./delete-move-dialog";
import { ReplayDialog, replayEndOptions } from "./replay-dialog";
import {
  caseSplitEnvelope,
  deletionImpact,
  selectedProposition,
  sorryAvailability,
  sorryEnvelope,
  READ_ONLY_REASON,
  toolbarCommandId,
  type Availability,
  type HistoryEdge,
} from "./toolbar-actions";
import type { ProtocolCommandOutcome } from "./toolbar-requests";
import styles from "./toolbar-actions.module.css";

/**
 * Send one envelope through the workspace's single command path. On success the workspace moves
 * to the new current node and reloads the history; `summarize` phrases the committed notice.
 */
export type RunToolbarCommand = (
  action: string,
  envelope: ProtocolCommandEnvelope,
  summarize?: (response: ProtocolCommandResponse) => string | undefined,
) => Promise<ProtocolCommandOutcome>;

export type ToolbarHistory =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; nodes: readonly ProofNode[]; edges: readonly HistoryEdge[] }>
  | Readonly<{ kind: "rejected"; message: string }>;

export type ToolbarActionBarProps = Readonly<{
  /** The session the dialogs ask for dry runs (backtrack analysis, replay preview). */
  sessionId: string;
  /** An imported artifact: every action is disabled with `READ_ONLY_REASON`. */
  readOnly?: boolean | undefined;
  node: ProofNode;
  rootNodeId: string;
  operators: readonly OperatorDeclaration[];
  selections: readonly AnchoredProofSelection[];
  history: ToolbarHistory;
  mutationPending: boolean;
  presentation: Presentation;
  view: WorkspaceView;
  runCommand: RunToolbarCommand;
}>;

type OpenDialog = "delete" | "backtrack" | "replay" | undefined;

/** The proof actions of the toolbar (design plan §17.2): each is one N25 command envelope. */
export function ToolbarActionBar({
  sessionId,
  readOnly = false,
  node,
  rootNodeId,
  operators,
  selections,
  history,
  mutationPending,
  presentation,
  view,
  runCommand,
}: ToolbarActionBarProps) {
  const [dialog, setDialog] = useState<OpenDialog>();
  const [pending, setPending] = useState(false);
  const busy = mutationPending || pending;

  const historyReason =
    history.kind === "loading"
      ? "The stored history is still loading."
      : history.kind === "rejected"
        ? `The stored history is unavailable: ${history.message}`
        : undefined;
  const impact =
    history.kind === "ready" ? deletionImpact(rootNodeId, node.id, history.edges) : undefined;
  const lock = <Value,>(availability: Availability<Value>): Availability<Value> =>
    readOnly ? { ok: false, reason: READ_ONLY_REASON } : availability;
  const deleteAvailability: Availability<true> =
    historyReason !== undefined
      ? { ok: false, reason: historyReason }
      : impact?.kind === "root"
        ? { ok: false, reason: "The root node has no previous move." }
        : impact?.kind === "unavailable"
          ? { ok: false, reason: impact.reason }
          : { ok: true, value: true };

  const proposition = selectedProposition(node, selections, operators);
  const sorry = sorryAvailability(node, selections);
  const backtrackAvailability: Availability<true> =
    historyReason !== undefined
      ? { ok: false, reason: historyReason }
      : node.id === rootNodeId
        ? { ok: false, reason: "The root node has no ancestor to backtrack to." }
        : !proposition.ok
          ? proposition
          : { ok: true, value: true };
  const replayAvailability: Availability<true> =
    history.kind !== "ready"
      ? { ok: false, reason: historyReason ?? "The stored history is unavailable." }
      : replayEndOptions(history.nodes, history.edges, node.id, rootNodeId).length === 0
        ? { ok: false, reason: "No other branch is recorded yet." }
        : { ok: true, value: true };

  const runImmediate = async (action: string, envelope: ProtocolCommandEnvelope) => {
    setPending(true);
    await runCommand(action, envelope);
    setPending(false);
  };

  return (
    <div className={styles.actionBar} role="group" aria-label="Proof actions">
      {readOnly ? (
        <p className={styles.readOnlyNote} role="note" data-testid="toolbar-read-only-note">
          Read-only: this imported session cannot be changed, so these actions are off.
        </p>
      ) : null}
      <ActionButton
        label="Delete previous move…"
        hint="Remove the latest step, and anything built on it."
        quiet={readOnly}
        availability={lock(deleteAvailability)}
        busy={busy}
        onClick={() => setDialog("delete")}
      />
      <ActionButton
        label="Backtrack with information…"
        hint="Split on the selected statement at an earlier step."
        quiet={readOnly}
        availability={lock(backtrackAvailability)}
        busy={busy}
        onClick={() => setDialog("backtrack")}
      />
      <ActionButton
        label="Replay a sequence here…"
        hint="Repeat the steps of another branch from here."
        quiet={readOnly}
        availability={lock(replayAvailability)}
        busy={busy}
        onClick={() => setDialog("replay")}
      />
      <ActionButton
        label="Mark as sorry (assume)"
        hint="Assume the selected claim without proving it; it stays flagged as a sorry."
        quiet={readOnly}
        availability={lock(sorry)}
        busy={busy}
        onClick={() => {
          if (!sorry.ok) return;
          // The sorry closes the whole target the selection lies in.
          void runImmediate(
            "Mark sorry",
            sorryEnvelope({
              commandId: toolbarCommandId("sorry"),
              nodeId: node.id,
              target: sorry.value,
            }),
          );
        }}
      />
      <ActionButton
        label="Case split on selection"
        hint="Handle the cases where the selected statement is true and where it is false."
        quiet={readOnly}
        availability={lock(proposition)}
        busy={busy}
        onClick={() => {
          if (!proposition.ok) return;
          void runImmediate(
            "Case split",
            caseSplitEnvelope({
              commandId: toolbarCommandId("case-split"),
              nodeId: node.id,
              proposition: proposition.value,
            }),
          );
        }}
      />

      {dialog === "delete" && impact?.kind === "ready" ? (
        <DeleteMoveDialog
          impact={impact}
          currentNodeId={node.id}
          runCommand={runCommand}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog === "backtrack" && proposition.ok && history.kind === "ready" ? (
        <BacktrackDialog
          sessionId={sessionId}
          proposition={proposition.value}
          node={node}
          rootNodeId={rootNodeId}
          nodes={history.nodes}
          presentation={presentation}
          view={view}
          runCommand={runCommand}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {dialog === "replay" && history.kind === "ready" ? (
        <ReplayDialog
          sessionId={sessionId}
          node={node}
          rootNodeId={rootNodeId}
          nodes={history.nodes}
          edges={history.edges}
          runCommand={runCommand}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </div>
  );
}

/** A toolbar action that stays visible when unavailable and says why. */
function ActionButton({
  label,
  hint,
  quiet,
  availability,
  busy,
  onClick,
}: Readonly<{
  label: string;
  /** One plain sentence on what the action does; shown on hover and read by screen readers. */
  hint: string;
  /** Keep the unavailability reason for assistive technology only (the bar states it once). */
  quiet: boolean;
  availability: Availability<unknown>;
  busy: boolean;
  onClick: () => void;
}>) {
  const reasonId = useId();
  const hintId = useId();
  const reason = availability.ok ? undefined : availability.reason;
  return (
    <span className={styles.action} title={reason ?? hint}>
      <button
        type="button"
        className={styles.actionButton}
        disabled={busy || !availability.ok}
        aria-describedby={availability.ok ? hintId : reasonId}
        onClick={onClick}
      >
        {label}
      </button>
      {availability.ok ? (
        <span id={hintId} className="visually-hidden">
          {hint}
        </span>
      ) : (
        <span id={reasonId} className={quiet ? "visually-hidden" : styles.reason}>
          {reason}
        </span>
      )}
    </span>
  );
}
