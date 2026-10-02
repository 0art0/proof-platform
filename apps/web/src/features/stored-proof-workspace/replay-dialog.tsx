"use client";

import { useEffect, useId, useMemo, useState } from "react";
import {
  compactMathText,
  semanticReplayReportSchema,
  type ProofNode,
  type SemanticReplayPreviewRequest,
  type ProtocolCommandResponse,
  type ReplayCandidate,
  type ReplayOverride,
  type SemanticReplayReport,
} from "@proof/protocol";
import { humanizeMoveId } from "../macro-labels";
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
import { describeCommandFailure, requestReplayPreview } from "./toolbar-requests";
import type { RunToolbarCommand } from "./toolbar-action-bar";
import styles from "./toolbar-actions.module.css";

export type ReplayDialogProps = Readonly<{
  sessionId: string;
  node: ProofNode;
  rootNodeId: string;
  nodes: readonly ProofNode[];
  edges: readonly HistoryEdge[];
  runCommand: RunToolbarCommand;
  onClose: () => void;
}>;

/** The dry-run report of one request, tagged with the request it answers. */
type PreviewResult = Readonly<{
  key: string;
  outcome:
    Readonly<{ ok: true; report: SemanticReplayReport }> | Readonly<{ ok: false; message: string }>;
}>;

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

/** One replay step: a single stored edge, or the edges of one macro application. */
export type ReplayStepEntry = Readonly<{
  id: string;
  name: string;
  transitionClass: string;
  /** Present for a whole macro application, which replays as one step. */
  macroSteps?: number;
}>;

const CLASS_ORDER = ["equivalence", "strengthening", "weakening"];

/**
 * The replay steps of a source path. The edges of one complete macro application share a macro
 * link and replay as ONE step; every other edge is a step of its own.
 */
export function replayStepEntries(steps: readonly HistoryEdge[]): readonly ReplayStepEntry[] {
  const entries: ReplayStepEntry[] = [];
  for (let position = 0; position < steps.length;) {
    const { edge, name } = steps[position] as HistoryEdge;
    const link = edge.macro;
    const application = link === undefined ? [] : steps.slice(position, position + link.stepCount);
    if (
      link !== undefined &&
      link.stepIndex === 1 &&
      application.length === link.stepCount &&
      application.every(
        ({ edge: other }, offset) =>
          other.macro?.previewId === link.previewId && other.macro.stepIndex === offset + 1,
      )
    ) {
      const weakest = application.reduce(
        (worst, { edge: other }) => Math.max(worst, CLASS_ORDER.indexOf(other.transitionClass)),
        0,
      );
      entries.push({
        id: edge.id,
        name: humanizeMoveId(link.moveId),
        transitionClass: CLASS_ORDER[weakest] ?? edge.transitionClass,
        macroSteps: link.stepCount,
      });
      position += link.stepCount;
      continue;
    }
    entries.push({ id: edge.id, name, transitionClass: edge.transitionClass });
    position += 1;
  }
  return entries;
}

/** How a replayed step was originally applied, in plain words (nothing for a chosen suggestion). */
function stepSourceLabel(
  source: SemanticReplayReport["steps"][number]["source"],
  macroSteps: number | undefined,
): string | undefined {
  switch (source) {
    case undefined:
    case "suggestion":
      return undefined;
    case "backtrack":
      return "case split by backtracking (or closing the case it proves)";
    case "raw-operation":
      return "raw operation, applied without a suggestion";
    case "macro":
      return `macro applied again as one step${
        macroSteps === undefined ? "" : ` (${macroSteps} steps)`
      }`;
  }
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
 * source path from the stored history, and the proof service's dry run (`POST .../replay-preview`)
 * reports every step (exact or adapted, new substitutions and obligations) and the first failure
 * with its repair candidates BEFORE anything is written. The preview is requested with the
 * commit's own command ID, so repair candidates chosen from it are valid overrides of the commit.
 * The commit re-matches every step again; a step that no longer matches writes nothing.
 */
export function ReplayDialog({
  sessionId,
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
  const [commitError, setCommitError] = useState<string>();
  const [preview, setPreview] = useState<PreviewResult>();
  const [pending, setPending] = useState(false);

  const source: ReplaySource | undefined =
    toNodeId === undefined || fromNodeId === undefined ? undefined : { fromNodeId, toNodeId };
  const edgeSteps = source === undefined ? undefined : replaySteps(edges, source);
  const steps = edgeSteps === undefined ? undefined : replayStepEntries(edgeSteps);
  const startOptions = toNodeId === undefined ? [] : ancestorsOf(edges, toNodeId);

  // The dry run asks exactly what a commit would send; only the request's content keys it.
  const previewKey =
    source === undefined || steps === undefined || steps.length === 0
      ? undefined
      : JSON.stringify({
          commandId,
          source,
          targetNodeId: node.id,
          ...(overrides.length === 0 ? {} : { overrides }),
        });
  useEffect(() => {
    if (previewKey === undefined) return;
    const controller = new AbortController();
    void requestReplayPreview(
      sessionId,
      JSON.parse(previewKey) as SemanticReplayPreviewRequest,
      controller.signal,
    ).then((result) => {
      if (controller.signal.aborted) return;
      setPreview({
        key: previewKey,
        outcome: result.ok
          ? { ok: true, report: result.value }
          : { ok: false, message: result.message },
      });
    });
    return () => controller.abort();
  }, [previewKey, sessionId]);
  const current = preview !== undefined && preview.key === previewKey ? preview.outcome : undefined;
  const loadingPreview = previewKey !== undefined && current === undefined;
  const report = current?.ok === true ? current.report : undefined;

  const resetAttempt = () => {
    setCommandId(toolbarCommandId("replay"));
    setOverrides([]);
    setRepairs({});
    setCommitError(undefined);
  };

  const chooseEnd = (id: string) => {
    setToNodeId(id);
    setFromNodeId(defaultReplayStart(edges, node.id, id));
    resetAttempt();
  };

  const submit = async (withOverrides: readonly ReplayOverride[]) => {
    if (source === undefined || steps === undefined || steps.length === 0) return;
    setPending(true);
    setCommitError(undefined);
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
    setCommitError(describeCommandFailure("Replay", outcome));
    // The worker's own report replaces the preview: the commit found a step that no longer matches.
    if (outcome.replayReport !== undefined && previewKey !== undefined) {
      setPreview({ key: previewKey, outcome: { ok: true, report: outcome.replayReport } });
    }
  };

  /** Fold the chosen repair candidates into the overrides; the changed request is previewed again. */
  const previewWithRepairs = () => {
    const index = report?.firstFailure?.index;
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
    setOverrides([...kept, ...chosen] as readonly ReplayOverride[]);
    setRepairs({});
    setCommitError(undefined);
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
            {steps.map(({ id, name, transitionClass, macroSteps }, index) => {
              const reported = report?.steps[index];
              const sourceLabel =
                reported === undefined ? undefined : stepSourceLabel(reported.source, macroSteps);
              return (
                <li key={id} data-step-status={reported?.status ?? "pending"}>
                  <strong>{name}</strong> · {transitionClass}
                  {reported === undefined ? null : (
                    <span className={styles.stepStatus}> · {stepStatusLabel(reported.status)}</span>
                  )}
                  {sourceLabel === undefined ? null : (
                    <span className={styles.muted} data-step-source={reported?.source}>
                      {" "}
                      · {sourceLabel}
                    </span>
                  )}
                  {reported?.diagnostic === undefined ? null : (
                    <span className={styles.choiceReason}>{reported.diagnostic.message}</span>
                  )}
                </li>
              );
            })}
          </ol>
          <p className={styles.muted}>
            Nothing is written until you replay; the preview below is a dry run of these steps.
          </p>
        </section>
      )}

      {loadingPreview ? (
        <p role="status" className={styles.muted}>
          Previewing the replay…
        </p>
      ) : null}
      {report === undefined ? null : (
        <ReplayReportView report={report} repairs={repairs} onRepair={setRepairs} />
      )}
      {current?.ok === false ? (
        <p role="alert" className={styles.error}>
          The replay could not be previewed: {current.message}
        </p>
      ) : null}
      {commitError === undefined ? null : (
        <p role="alert" className={styles.error}>
          {commitError}
        </p>
      )}

      <div className={styles.dialogActions}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        {report?.firstFailure === undefined ? null : (
          <button
            type="button"
            className={styles.primaryButton}
            disabled={pending || Object.keys(repairs).length === 0}
            onClick={previewWithRepairs}
          >
            Preview with the chosen repairs
          </button>
        )}
        <button
          type="button"
          className={styles.primaryButton}
          disabled={pending || report?.complete !== true}
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
      <p data-testid="replay-report-summary">
        {report.steps.filter(({ status }) => status === "exact").length} exact,{" "}
        {report.steps.filter(({ status }) => status === "adapted").length} adapted
        {report.complete ? "; every step matches here." : "; a step does not match here."}
      </p>
      {report.steps.flatMap((step) =>
        step.parameters.map(({ parameterId, match }) => (
          <p key={`${step.index}:${parameterId}`} className={styles.muted}>
            Step {step.index}: parameter {parameterId} re-chosen by {match}.
          </p>
        )),
      )}
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
