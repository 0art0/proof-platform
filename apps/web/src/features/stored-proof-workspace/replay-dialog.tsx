"use client";

import { useId, useMemo, useState } from "react";
import {
  compactMathText,
  semanticReplayReportSchema,
  type ProofNode,
  type ProtocolCommandResponse,
  type ReplayCandidate,
  type ReplayOverride,
  type SemanticReplayReport,
} from "@proof/protocol";
import { ToolbarDialog } from "./toolbar-dialog";
import {
  ancestorsOf,
  defaultReplayStart,
  replayEnvelope,
  replaySteps,
  toolbarCommandId,
  type HistoryEdge,
  type ReplaySource,
} from "./toolbar-actions";
import { describeCommandFailure } from "./toolbar-requests";
import type { RunToolbarCommand } from "./toolbar-action-bar";
import styles from "./toolbar-actions.module.css";

export type ReplayDialogProps = Readonly<{
  node: ProofNode;
  rootNodeId: string;
  nodes: readonly ProofNode[];
  edges: readonly HistoryEdge[];
  runCommand: RunToolbarCommand;
  onClose: () => void;
}>;

type Failure = Readonly<{ message: string; report?: SemanticReplayReport }>;

/** Nodes whose branch can be replayed here: every node off the current node's own line. */
export function replayEndOptions(
  nodes: readonly ProofNode[],
  edges: readonly HistoryEdge[],
  currentNodeId: string,
  rootNodeId: string,
): readonly string[] {
  const line = new Set([...ancestorsOf(edges, currentNodeId), currentNodeId]);
  return nodes.map(({ id }) => id as string).filter((id) => id !== rootNodeId && !line.has(id));
}

/** A one-line summary of a committed replay's report. */
export function replaySummary(response: ProtocolCommandResponse): string | undefined {
  const report = semanticReplayReportSchema.safeParse(response.result.report);
  if (!report.success) return undefined;
  const count = (status: string) => report.data.steps.filter((step) => step.status === status);
  return `Replayed ${report.data.steps.length} step${report.data.steps.length === 1 ? "" : "s"} (${
    count("exact").length
  } exact, ${count("adapted").length} adapted); now at ${report.data.finalNodeId}.`;
}

/**
 * Replay a recorded sequence onto the current node (design plan §16.4). The user chooses the
 * source path from the stored history and reviews its steps before anything is sent. The proof
 * service re-matches every step; a step that does not match writes nothing and returns the
 * report, whose repair candidates can be chosen and sent again under the same command.
 */
export function ReplayDialog({
  node,
  rootNodeId,
  nodes,
  edges,
  runCommand,
  onClose,
}: ReplayDialogProps) {
  const endId = useId();
  const startId = useId();
  const endOptions = useMemo(
    () => replayEndOptions(nodes, edges, node.id, rootNodeId),
    [edges, node.id, nodes, rootNodeId],
  );
  const incoming = useMemo(
    () => new Map(edges.map((record) => [record.edge.childNodeId as string, record])),
    [edges],
  );
  const [toNodeId, setToNodeId] = useState<string | undefined>(endOptions[0]);
  const [fromNodeId, setFromNodeId] = useState<string | undefined>(() =>
    endOptions[0] === undefined ? undefined : defaultReplayStart(edges, node.id, endOptions[0]),
  );
  // One command per chosen source: a failed replay wrote nothing, and its repair candidates are
  // named relative to this command ID, so a retry must reuse it.
  const [commandId, setCommandId] = useState(() => toolbarCommandId("replay"));
  const [overrides, setOverrides] = useState<readonly ReplayOverride[]>([]);
  const [repairs, setRepairs] = useState<Readonly<Record<string, string>>>({});
  const [failure, setFailure] = useState<Failure>();
  const [pending, setPending] = useState(false);

  const source: ReplaySource | undefined =
    toNodeId === undefined || fromNodeId === undefined ? undefined : { fromNodeId, toNodeId };
  const steps = source === undefined ? undefined : replaySteps(edges, source);
  const startOptions = toNodeId === undefined ? [] : ancestorsOf(edges, toNodeId);

  const resetAttempt = () => {
    setCommandId(toolbarCommandId("replay"));
    setOverrides([]);
    setRepairs({});
    setFailure(undefined);
  };

  const chooseEnd = (id: string) => {
    setToNodeId(id);
    setFromNodeId(defaultReplayStart(edges, node.id, id));
    resetAttempt();
  };

  const submit = async (withOverrides: readonly ReplayOverride[]) => {
    if (source === undefined || steps === undefined || steps.length === 0) return;
    setPending(true);
    const outcome = await runCommand(
      "Replay",
      replayEnvelope({ commandId, nodeId: node.id, source, overrides: withOverrides }),
      replaySummary,
    );
    setPending(false);
    if (outcome.ok) {
      onClose();
      return;
    }
    setOverrides(withOverrides);
    setRepairs({});
    setFailure({
      message: describeCommandFailure("Replay", outcome),
      ...(outcome.replayReport === undefined ? {} : { report: outcome.replayReport }),
    });
  };

  const retryWithRepairs = () => {
    const index = failure?.report?.firstFailure?.index;
    if (index === undefined) return;
    const chosen = Object.entries(repairs).map(([slotId, candidateId]) => ({
      stepIndex: index,
      slotId,
      candidateId,
    }));
    const kept = overrides.filter(
      (override) =>
        !chosen.some(
          (next) => next.stepIndex === override.stepIndex && next.slotId === override.slotId,
        ),
    );
    void submit([...kept, ...chosen] as readonly ReplayOverride[]);
  };

  const nodeLabel = (id: string) => {
    const record = incoming.get(id);
    return record === undefined ? `${id} (root)` : `${id} — after “${record.name}”`;
  };

  return (
    <ToolbarDialog
      title="Replay a sequence here"
      description={
        <p>
          Choose a recorded path; its steps are matched again against the current node {node.id} and
          create fresh nodes here. The original branch is unchanged.
        </p>
      }
      onClose={onClose}
    >
      {endOptions.length === 0 ? (
        <p role="alert" className={styles.error}>
          No other branch is recorded yet; there is no sequence to replay here.
        </p>
      ) : (
        <div className={styles.fieldGrid}>
          <label htmlFor={endId}>Replay the path ending at</label>
          <select
            id={endId}
            value={toNodeId ?? ""}
            onChange={(event) => chooseEnd(event.target.value)}
          >
            {endOptions.map((id) => (
              <option key={id} value={id}>
                {nodeLabel(id)}
              </option>
            ))}
          </select>
          <label htmlFor={startId}>Starting after</label>
          <select
            id={startId}
            value={fromNodeId ?? ""}
            onChange={(event) => {
              setFromNodeId(event.target.value);
              resetAttempt();
            }}
          >
            {startOptions.map((id) => (
              <option key={id} value={id}>
                {nodeLabel(id)}
              </option>
            ))}
          </select>
        </div>
      )}

      {steps === undefined || steps.length === 0 ? null : (
        <section aria-label="Steps to replay" className={styles.reportSection}>
          <h3>Steps to replay ({steps.length})</h3>
          <ol className={styles.stepList}>
            {steps.map(({ edge, name }, index) => {
              const reported = failure?.report?.steps[index];
              return (
                <li key={edge.id} data-step-status={reported?.status ?? "pending"}>
                  <strong>{name}</strong> · {edge.transitionClass}
                  {reported === undefined ? null : (
                    <span className={styles.stepStatus}> · {stepStatusLabel(reported.status)}</span>
                  )}
                  {reported?.diagnostic === undefined ? null : (
                    <span className={styles.choiceReason}>{reported.diagnostic.message}</span>
                  )}
                </li>
              );
            })}
          </ol>
          {failure?.report === undefined ? (
            <p className={styles.muted}>
              Nothing is written until you replay. A dry-run preview is not available in this
              version: if a step does not match here, the replay stops before writing and its
              report, with repair candidates, is shown.
            </p>
          ) : null}
        </section>
      )}

      {failure?.report === undefined ? null : (
        <ReplayReportView report={failure.report} repairs={repairs} onRepair={setRepairs} />
      )}

      {failure === undefined ? null : (
        <p role="alert" className={styles.error}>
          {failure.message}
        </p>
      )}

      <div className={styles.dialogActions}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        {failure?.report?.firstFailure === undefined ? null : (
          <button
            type="button"
            className={styles.primaryButton}
            disabled={pending || Object.keys(repairs).length === 0}
            onClick={retryWithRepairs}
          >
            Replay again with the chosen repairs
          </button>
        )}
        <button
          type="button"
          className={styles.primaryButton}
          disabled={pending || steps === undefined || steps.length === 0}
          onClick={() => void submit(overrides)}
        >
          {pending
            ? "Replaying…"
            : `Replay ${steps?.length ?? 0} step${steps?.length === 1 ? "" : "s"} here`}
        </button>
      </div>
    </ToolbarDialog>
  );
}

function stepStatusLabel(status: SemanticReplayReport["steps"][number]["status"]): string {
  switch (status) {
    case "exact":
      return "matched exactly";
    case "adapted":
      return "adapted";
    case "failed":
      return "failed";
    case "not-attempted":
      return "not attempted";
  }
}

function ReplayReportView({
  report,
  repairs,
  onRepair,
}: Readonly<{
  report: SemanticReplayReport;
  repairs: Readonly<Record<string, string>>;
  onRepair: (repairs: Readonly<Record<string, string>>) => void;
}>) {
  const obligations = report.steps.flatMap((step) =>
    step.obligations.filter(({ inSource }) => !inSource),
  );
  return (
    <section aria-label="Replay report" className={styles.reportSection}>
      <h3>Replay report</h3>
      {report.substitutions.length === 0 ? null : (
        <p>
          Changed substitutions:{" "}
          {report.substitutions
            .map(({ symbol, expression }) => `${symbol} ↦ ${compactMathText(expression)}`)
            .join(", ")}
        </p>
      )}
      {obligations.length === 0 ? null : (
        <p>
          New obligations:{" "}
          {obligations.map(({ expression }) => compactMathText(expression)).join("; ")}
        </p>
      )}
      {report.firstFailure === undefined ? null : (
        <>
          <p>
            First failure: step {report.firstFailure.index} —{" "}
            {report.firstFailure.diagnostic.message}
          </p>
          {report.firstFailure.repairs.length === 0 ? (
            <p className={styles.muted}>No alternate selection matches this step here.</p>
          ) : (
            report.firstFailure.repairs.map(({ slotId, candidates }) => (
              <fieldset key={slotId} className={styles.choices}>
                <legend>Repair candidates for {slotId}</legend>
                {candidates.map((candidate) => (
                  <RepairOption
                    key={candidate.id}
                    slotId={slotId}
                    candidate={candidate}
                    checked={repairs[slotId] === candidate.id}
                    onChoose={() => onRepair({ ...repairs, [slotId]: candidate.id })}
                  />
                ))}
              </fieldset>
            ))
          )}
        </>
      )}
    </section>
  );
}

function RepairOption({
  slotId,
  candidate,
  checked,
  onChoose,
}: Readonly<{
  slotId: string;
  candidate: ReplayCandidate;
  checked: boolean;
  onChoose: () => void;
}>) {
  return (
    <label className={styles.choice} data-candidate-id={candidate.id}>
      <input
        type="radio"
        name={`repair-${slotId}`}
        value={candidate.id}
        checked={checked}
        onChange={onChoose}
      />
      <span>
        <code>{compactMathText(candidate.fragment)}</code> in {candidate.target.kind}{" "}
        {candidate.target.id} ({candidate.statement.role}) · {candidate.match} match
      </span>
    </label>
  );
}
