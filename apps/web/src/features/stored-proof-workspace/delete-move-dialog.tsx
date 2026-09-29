"use client";

import { useId, useState } from "react";
import { ToolbarDialog } from "./toolbar-dialog";
import {
  deletePreviousMoveEnvelope,
  toolbarCommandId,
  type DeletionImpact,
} from "./toolbar-actions";
import { describeCommandFailure } from "./toolbar-requests";
import type { RunToolbarCommand } from "./toolbar-action-bar";
import styles from "./toolbar-actions.module.css";

export type DeleteMoveDialogProps = Readonly<{
  impact: Extract<DeletionImpact, { kind: "ready" }>;
  currentNodeId: string;
  runCommand: RunToolbarCommand;
  onClose: () => void;
}>;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Delete the move that produced the current node (design plan §16.2). The dialog states what the
 * stored tree says will be removed; when the node has descendants the deletion is sent only
 * after the user explicitly confirms removing them.
 */
export function DeleteMoveDialog({
  impact,
  currentNodeId,
  runCommand,
  onClose,
}: DeleteMoveDialogProps) {
  const confirmId = useId();
  const [confirmed, setConfirmed] = useState(false);
  // The worker may know of descendants this view's history had not loaded yet.
  const [serverDescendants, setServerDescendants] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const needsConfirmation = impact.descendantCount > 0 || serverDescendants;

  const submit = async () => {
    if (needsConfirmation && !confirmed) return;
    setPending(true);
    setError(undefined);
    const outcome = await runCommand(
      "Delete previous move",
      deletePreviousMoveEnvelope({
        commandId: toolbarCommandId("delete-previous-move"),
        nodeId: currentNodeId,
        confirmDescendants: needsConfirmation,
      }),
    );
    setPending(false);
    if (outcome.ok) {
      onClose();
      return;
    }
    if (outcome.code === "delete-requires-confirmation") {
      setServerDescendants(true);
      setConfirmed(false);
    }
    setError(describeCommandFailure("Delete previous move", outcome));
  };

  return (
    <ToolbarDialog
      title="Delete previous move"
      description={
        <p>
          Removes “{impact.moveName}” and returns to its parent node {impact.parentNodeId}. Deleted
          work leaves the discovery record and export; only an audit tombstone is kept. To keep this
          branch, backtrack instead.
        </p>
      }
      onClose={onClose}
    >
      <dl className={styles.facts} data-testid="deletion-impact">
        <div>
          <dt>Nodes removed</dt>
          <dd>{plural(impact.deletedNodeCount, "node")}</dd>
        </div>
        <div>
          <dt>Descendant nodes</dt>
          <dd>{plural(impact.descendantCount, "descendant node")}</dd>
        </div>
      </dl>
      {needsConfirmation ? (
        <label className={styles.confirmation} htmlFor={confirmId}>
          <input
            id={confirmId}
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {impact.descendantCount > 0
            ? `Also delete the ${plural(impact.descendantCount, "descendant node")} below the current node`
            : "Also delete the descendant nodes the proof service reported"}
        </label>
      ) : null}
      {error === undefined ? null : (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.dialogActions}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.dangerButton}
          disabled={pending || (needsConfirmation && !confirmed)}
          onClick={() => void submit()}
        >
          {pending ? "Deleting…" : "Delete move"}
        </button>
      </div>
    </ToolbarDialog>
  );
}
