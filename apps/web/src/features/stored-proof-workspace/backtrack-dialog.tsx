"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  BacktrackAncestor,
  BacktrackAnalysis,
  BacktrackAnalysisRequest,
  ProofNode,
} from "@proof/protocol";
import type { Presentation } from "@proof/language";
import { StatementView } from "../proof-workspace/presentation";
import type { WorkspaceView } from "../proof-workspace";
import { ToolbarDialog } from "./toolbar-dialog";
import {
  backtrackWithInformationEnvelope,
  toolbarCommandId,
  type SelectedProposition,
} from "./toolbar-actions";
import { describeCommandFailure, requestBacktrackAnalysis } from "./toolbar-requests";
import type { RunToolbarCommand } from "./toolbar-action-bar";
import styles from "./toolbar-actions.module.css";

export type BacktrackDialogProps = Readonly<{
  sessionId: string;
  proposition: SelectedProposition;
  node: ProofNode;
  rootNodeId: string;
  nodes: readonly ProofNode[];
  presentation: Presentation;
  view: WorkspaceView;
  runCommand: RunToolbarCommand;
  onClose: () => void;
}>;

/**
 * Backtracking with information (design plan §16.3): split on the selected proposition `P` at an
 * ancestor where its symbols are available. The ancestors and their unavailable symbols come from
 * the proof service's dry-run analysis (`POST .../backtrack-analysis`); the worker repeats the
 * analysis when the command arrives, so the listing here never decides what is committed.
 */
export function BacktrackDialog({
  sessionId,
  proposition,
  node,
  rootNodeId,
  nodes,
  presentation,
  view,
  runCommand,
  onClose,
}: BacktrackDialogProps) {
  const groupId = useId();
  // The selection object is rebuilt on every render; its content keys the request.
  const requestKey = JSON.stringify({
    sourceNodeId: node.id,
    sourceTarget: proposition.target,
    proposition: proposition.expression,
  });
  const [analysis, setAnalysis] = useState<AnalysisState>({ kind: "loading" });
  const [chosen, setChosen] = useState<string | undefined>();
  const choices = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void requestBacktrackAnalysis(
      sessionId,
      JSON.parse(requestKey) as BacktrackAnalysisRequest,
      controller.signal,
    ).then((outcome) => {
      if (controller.signal.aborted) return;
      if (outcome.ok) {
        setAnalysis({ kind: "ready", analysis: outcome.value });
        setChosen(outcome.value.closestEligibleAncestorNodeId);
      } else {
        setAnalysis({ kind: "failed", message: outcome.message });
      }
    });
    return () => controller.abort();
  }, [requestKey, sessionId]);
  const ready = analysis.kind === "ready" ? analysis.analysis : undefined;
  const closest = ready?.closestEligibleAncestorNodeId;
  // The dialog opened before the listing existed: move focus to the preselected ancestor.
  useEffect(() => {
    if (ready !== undefined)
      choices.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, [ready]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const byId = useMemo(() => new Map(nodes.map((entry) => [entry.id as string, entry])), [nodes]);

  const submit = async () => {
    if (chosen === undefined) return;
    setPending(true);
    setError(undefined);
    const outcome = await runCommand(
      "Backtrack with information",
      backtrackWithInformationEnvelope({
        commandId: toolbarCommandId("backtrack-with-information"),
        nodeId: node.id,
        proposition,
        ancestorNodeId: chosen,
      }),
    );
    setPending(false);
    if (outcome.ok) onClose();
    else setError(describeCommandFailure("Backtrack with information", outcome));
  };

  return (
    <ToolbarDialog
      title="Backtrack with information"
      description={
        <p>
          Insert a classical case split on P and on not P at an earlier node. The current branch
          stays in the discovery tree; a case whose goal is P closes at once, and the other case
          becomes the current node.
        </p>
      }
      onClose={onClose}
    >
      <p className={styles.proposition} data-testid="backtrack-proposition">
        <span>P = </span>
        <StatementView
          expression={proposition.expression}
          declarations={declarationsOf(node, proposition)}
          presentation={presentation}
          view={view}
        />
      </p>
      {analysis.kind === "loading" ? (
        <p role="status" className={styles.muted}>
          Asking the proof service where P can be split…
        </p>
      ) : null}
      {ready !== undefined ? (
        <>
          <p className={styles.muted}>
            Free symbols: {ready.freeSymbols.length === 0 ? "none" : ready.freeSymbols.join(", ")}
          </p>
          <fieldset ref={choices} className={styles.choices}>
            <legend id={groupId}>Ancestor to split at (closest first)</legend>
            {ready.ancestors.map((ancestor) => (
              <AncestorOption
                key={ancestor.nodeId}
                ancestor={ancestor}
                isRoot={ancestor.nodeId === rootNodeId}
                closest={ancestor.nodeId === closest}
                checked={chosen === ancestor.nodeId}
                onChoose={() => setChosen(ancestor.nodeId)}
                goal={byId.get(ancestor.nodeId)}
                presentation={presentation}
                view={view}
              />
            ))}
          </fieldset>
          {closest === undefined ? (
            <p role="alert" className={styles.error}>
              No ancestor declares every symbol of P, so P cannot be split on earlier.
            </p>
          ) : null}
        </>
      ) : null}
      {analysis.kind === "failed" ? (
        <p role="alert" className={styles.error}>
          Backtracking is unavailable: {analysis.message}
        </p>
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
          className={styles.primaryButton}
          disabled={pending || chosen === undefined}
          onClick={() => void submit()}
        >
          {pending ? "Splitting…" : "Split on P here"}
        </button>
      </div>
    </ToolbarDialog>
  );
}

type AnalysisState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; analysis: BacktrackAnalysis }>
  | Readonly<{ kind: "failed"; message: string }>;

function AncestorOption({
  ancestor,
  isRoot,
  closest,
  checked,
  onChoose,
  goal,
  presentation,
  view,
}: Readonly<{
  ancestor: BacktrackAncestor;
  isRoot: boolean;
  closest: boolean;
  checked: boolean;
  onChoose: () => void;
  goal: ProofNode | undefined;
  presentation: Presentation;
  view: WorkspaceView;
}>) {
  const target = goal?.state[ancestor.target.kind === "goal" ? "goals" : "obligations"].find(
    ({ id }) => id === ancestor.target.id,
  );
  const reason = ancestor.eligible
    ? undefined
    : ancestor.unavailableSymbols.length > 0
      ? `Unavailable symbols: ${ancestor.unavailableSymbols.join(", ")}`
      : "P is not a well-formed proposition there";
  return (
    <label
      className={styles.choice}
      data-ancestor-node-id={ancestor.nodeId}
      data-eligible={ancestor.eligible}
    >
      <input
        type="radio"
        name="backtrack-ancestor"
        value={ancestor.nodeId}
        checked={checked}
        disabled={!ancestor.eligible}
        onChange={onChoose}
      />
      <span>
        <strong>
          {ancestor.nodeId}
          {isRoot ? " (root)" : ""}
        </strong>{" "}
        · {ancestor.distance} {ancestor.distance === 1 ? "step" : "steps"} up
        {closest ? " · closest eligible" : ""}
        {target === undefined ? null : (
          <span className={styles.choiceDetail}>
            {ancestor.target.kind === "goal" ? "Goal: " : "Obligation: "}
            <StatementView
              expression={target.sequent.conclusion.expression}
              declarations={target.sequent.context.declarations}
              presentation={presentation}
              view={view}
            />
          </span>
        )}
        {reason === undefined ? null : <span className={styles.choiceReason}>{reason}</span>}
      </span>
    </label>
  );
}

function declarationsOf(node: ProofNode, proposition: SelectedProposition) {
  const collection = proposition.target.kind === "goal" ? node.state.goals : node.state.obligations;
  return collection.find(({ id }) => id === proposition.target.id)?.sequent.context.declarations;
}
