"use client";

import { useEffect, useRef, useState } from "react";
import type { ProofNode } from "@proof/protocol";
import { InlineLatex } from "../proof-workspace/presentation";
import {
  readProofPlan,
  requestPlanApply,
  requestPlanTranslation,
  requestProofPlan,
  type PlanCandidate,
  type PlanStep,
  type PlanView,
  type Translation,
} from "./proof-plan-contract";
import {
  afterApplied,
  afterTranslation,
  continueFrom,
  currentUnit,
  focusUnknown,
  missingMoveReport,
  skipUnit,
  startWalk,
  unitStart,
  walkFinished,
  type UnitStatus,
  type Walk,
} from "./proof-plan-walk";
import { TransitionClassBadge } from "./suggestion-badges";
import { READ_ONLY_REASON } from "./toolbar-actions";
import styles from "./move-instructions.module.css";
import planStyles from "./proof-plan.module.css";

const POLL_INTERVAL_MS = 3_000;
/** A plan that is not stored after this long is reported as not arriving. */
const POLL_LIMIT_MS = 12 * 60_000;
const MAX_RUN_MOVES = 200;

export const PROOF_PLAN_HINT =
  "A model writes the whole proof as numbered steps, each with why it is a natural next step. The platform then turns each step into its own moves, one at a time, and says when a step needs a move it does not have. You see and confirm every move.";

const FORM_KEYWORDS: Readonly<Record<string, string>> = {
  suffices: "SUFFICES",
  have: "HAVE",
  cases: "CASES",
  case: "CASE",
  pick: "PICK",
  witness: "WITNESS",
  assume: "ASSUME",
  qed: "QED",
};

const STATUS_WORDS: Readonly<Record<UnitStatus, string>> = {
  pending: "to do",
  realized: "✓ done",
  skipped: "skipped",
  "no-move": "⚠ missing move",
  "missing-construction": "⚠ missing value",
  uncertain: "⚠ unsure",
  unsupported: "⚠ not supported",
  stuck: "⚠ stuck",
};

export type ProofPlanPanelProps = Readonly<{
  sessionId: string;
  node: ProofNode;
  /** Whether the proof service has both a planner and a step translator. */
  enabled: boolean;
  readOnly: boolean;
  /** Another proof command is being applied. */
  busy: boolean;
  onApplyStart: () => boolean;
  onApplyEnd: () => void;
  /** Called after a move was committed; the page reloads the proof. */
  onApplied: (applied: Readonly<{ nodeId: string; name: string }>) => void | Promise<void>;
  createId?: (prefix: string) => string;
}>;

type Stored = Readonly<{ view: PlanView; walk: Walk }>;

type Phase =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "planning"; callId: string }>
  | Readonly<{ kind: "translating" }>
  | Readonly<{ kind: "proposed"; translation: Extract<Translation, { status: "proposed" }> }>
  | Readonly<{ kind: "applying" }>
  /** The unit stopped (missing move, unsure, stuck); its alternatives can still be chosen. */
  | Readonly<{
      kind: "stopped";
      translation: Exclude<Translation, { status: "proposed" | "realized" }>;
    }>
  | Readonly<{ kind: "note"; tone: "info" | "warning"; message: string }>;

const IDLE: Phase = { kind: "idle" };

function storageKey(sessionId: string) {
  return `proof-plan:${sessionId}`;
}

function loadStored(sessionId: string): Stored | undefined {
  try {
    const text = window.sessionStorage.getItem(storageKey(sessionId));
    return text === null ? undefined : (JSON.parse(text) as Stored);
  } catch {
    return undefined;
  }
}

function saveStored(sessionId: string, stored: Stored | undefined) {
  try {
    if (stored === undefined) window.sessionStorage.removeItem(storageKey(sessionId));
    else window.sessionStorage.setItem(storageKey(sessionId), JSON.stringify(stored));
  } catch {
    // Without storage the walk lasts for the page.
  }
}

/**
 * The proof-plan panel (`docs/motivated-proof-plans.md` section 5): a structured proof written by a
 * model, walked step by step with Jev choosing among the moves the platform displays.
 */
export function ProofPlanPanel({
  sessionId,
  node,
  enabled,
  readOnly,
  busy,
  onApplyStart,
  onApplyEnd,
  onApplied,
  createId = (prefix) => `${prefix}-${crypto.randomUUID()}`,
}: ProofPlanPanelProps) {
  const [stored, setStored] = useState<Stored>();
  const [phase, setPhase] = useState<Phase>(IDLE);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setStored(loadStored(sessionId));
    return () => {
      mounted.current = false;
      runningRef.current = false;
    };
  }, [sessionId]);

  const update = (next: Stored | undefined) => {
    setStored(next);
    saveStored(sessionId, next);
  };

  const unavailable = !enabled
    ? "Proof plans are unavailable: the planner or the step translator is not configured for this service."
    : readOnly
      ? `${READ_ONLY_REASON}: no plan can be walked.`
      : undefined;
  const working =
    phase.kind === "planning" || phase.kind === "translating" || phase.kind === "applying";
  const walk = stored?.walk;
  const moved = walk !== undefined && walk.nodeId !== node.id;

  const adoptPlan = (view: PlanView) => {
    update({ view, walk: startWalk(view, node.id) });
    setPhase(
      view.initialState.nodeId === node.id
        ? IDLE
        : {
            kind: "note",
            tone: "info",
            message: "The proof moved on while the plan was written; the walk starts from here.",
          },
    );
  };

  const writePlan = async () => {
    if (unavailable !== undefined || working) return;
    const callId = createId("llm-call:plan");
    setPhase({ kind: "planning", callId });
    let outcome = await requestProofPlan(sessionId, { id: callId, expectedCurrentNodeId: node.id });
    const began = Date.now();
    while (outcome.kind === "planning" && mounted.current && Date.now() - began < POLL_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      outcome = await readProofPlan(sessionId, outcome.callId);
    }
    if (!mounted.current) return;
    if (outcome.kind === "planned") adoptPlan(outcome.view);
    else if (outcome.kind === "planning") {
      setPhase({
        kind: "note",
        tone: "warning",
        message: "The plan did not arrive in time. Try again later.",
      });
    } else
      setPhase({
        kind: "note",
        tone: outcome.kind === "note" ? "info" : "warning",
        message: outcome.message,
      });
  };

  /** Translate the next move of the current unit; returns the walk and translation it led to. */
  const translate = async (
    current: Stored,
    chosenCandidateId?: string,
    reuseCallId?: string,
  ): Promise<Readonly<{ walk: Walk; translation?: Translation }> | undefined> => {
    const unit = currentUnit(current.walk);
    if (unit === undefined) return undefined;
    const start = unitStart(current.walk);
    if (start === undefined) {
      const next = focusUnknown(current.walk);
      update({ ...current, walk: next });
      return { walk: next };
    }
    setPhase({ kind: "translating" });
    const outcome = await requestPlanTranslation(sessionId, {
      id: reuseCallId ?? createId("llm-call:translate"),
      planCallId: current.walk.planCallId,
      stepId: unit.stepId,
      expectedCurrentNodeId: current.walk.nodeId,
      start,
      movesSoFar: current.walk.movesSoFar,
      refs: current.walk.refs,
      ...(chosenCandidateId === undefined ? {} : { chosenCandidateId }),
    });
    if (!mounted.current) return undefined;
    if (outcome.kind === "error") {
      setPhase({ kind: "note", tone: "warning", message: outcome.message });
      return undefined;
    }
    const next = afterTranslation(current.walk, outcome.translation);
    update({ ...current, walk: next });
    const { translation } = outcome;
    if (translation.status === "proposed") setPhase({ kind: "proposed", translation });
    else if (translation.status === "realized") setPhase(IDLE);
    else setPhase({ kind: "stopped", translation });
    return { walk: next, translation };
  };

  const apply = async (
    current: Stored,
    translation: Extract<Translation, { status: "proposed" }>,
  ): Promise<Walk | undefined> => {
    if (busy || !onApplyStart()) return undefined;
    setPhase({ kind: "applying" });
    try {
      const outcome = await requestPlanApply(sessionId, {
        callId: translation.callId,
        candidateId: translation.choice.id,
        expectedCurrentNodeId: current.walk.nodeId,
      });
      if (!mounted.current) return undefined;
      if (outcome.kind === "error") {
        setPhase({ kind: "note", tone: "warning", message: outcome.message });
        return undefined;
      }
      const name = translation.choice.label;
      const next = afterApplied(current.walk, name, outcome.nodeId);
      update({ ...current, walk: next });
      setPhase(IDLE);
      await onApplied({ nodeId: outcome.nodeId, name });
      return next;
    } finally {
      onApplyEnd();
    }
  };

  const nextMove = async () => {
    if (stored === undefined || working || busy) return;
    await translate(stored);
  };

  const runToEnd = async () => {
    if (stored === undefined || working || busy) return;
    runningRef.current = true;
    setRunning(true);
    let current: Stored = stored;
    try {
      for (
        let moves = 0;
        moves < MAX_RUN_MOVES && runningRef.current && !walkFinished(current.walk);
        moves += 1
      ) {
        const translated = await translate(current);
        if (translated === undefined) return;
        current = { ...current, walk: translated.walk };
        const { translation } = translated;
        if (translation?.status === "proposed") {
          const applied = await apply(current, translation);
          if (applied === undefined) return;
          current = { ...current, walk: applied };
        } else if (translation?.status !== "realized" && translation?.status !== "unsupported") {
          return;
        }
      }
    } finally {
      runningRef.current = false;
      if (mounted.current) setRunning(false);
    }
  };

  const skip = () => {
    if (stored === undefined || working) return;
    update({ ...stored, walk: skipUnit(stored.walk) });
    setPhase(IDLE);
  };

  const chooseInstead = async (candidate: PlanCandidate, callId: string) => {
    if (stored === undefined || working) return;
    await translate(stored, candidate.id, callId);
  };

  const blocked =
    unavailable ??
    (busy
      ? "Another step is being applied; wait for it to finish."
      : working
        ? "A request is already running."
        : undefined);

  const report =
    stored === undefined || walk === undefined ? undefined : missingMoveReport(walk, stored.view);

  return (
    <section className={styles.panel} aria-label="Proof plan" data-testid="proof-plan">
      <h2>Proof plan</h2>
      <p className={styles.hint}>{PROOF_PLAN_HINT}</p>
      <div className={styles.actions}>
        <button
          type="button"
          className={stored === undefined ? styles.primary : styles.secondary}
          disabled={blocked !== undefined}
          onClick={() => void writePlan()}
        >
          {phase.kind === "planning"
            ? "Writing the plan…"
            : stored === undefined
              ? "Write a proof plan"
              : "Write a new plan"}
        </button>
        {stored === undefined ? null : (
          <button
            type="button"
            className={styles.ghost}
            disabled={working}
            onClick={() => {
              update(undefined);
              setPhase(IDLE);
            }}
          >
            Close plan
          </button>
        )}
        <span className={styles.reason}>
          {blocked ??
            (phase.kind === "planning" ? "Writing a careful proof can take a few minutes." : "")}
        </span>
      </div>

      {phase.kind === "note" ? (
        <p className={styles.note} data-tone={phase.tone} role="status">
          {phase.message}
        </p>
      ) : null}
      {phase.kind === "stopped" ? (
        <StoppedUnit
          translation={phase.translation}
          busy={busy || working}
          onChoose={(candidate, callId) => void chooseInstead(candidate, callId)}
        />
      ) : null}

      {stored === undefined || walk === undefined ? null : (
        <>
          <p className={planStyles.detail}>
            <strong>Theorem.</strong>{" "}
            {stored.view.rendered.theorem === null ? (
              stored.view.plan.theorem.prose
            ) : (
              <InlineLatex latex={stored.view.rendered.theorem} />
            )}
          </p>
          <p className={planStyles.detail}>
            <strong>Sketch.</strong> {stored.view.plan.sketch}
          </p>
          <PlanTree view={stored.view} walk={walk} />

          {moved && !working ? (
            <div className={styles.note} data-tone="warning" role="status">
              <p>
                The proof changed outside the plan. Continue the plan from the current state, or
                close it.
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => update({ ...stored, walk: continueFrom(walk, node.id) })}
                >
                  Continue from here
                </button>
              </div>
            </div>
          ) : walkFinished(walk) ? (
            <p className={styles.note} role="status">
              The walk reached the end of the plan.
            </p>
          ) : (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                disabled={blocked !== undefined || phase.kind === "proposed"}
                onClick={() => void nextMove()}
              >
                {phase.kind === "translating" ? "Translating…" : "Next move"}
              </button>
              {running ? (
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => {
                    runningRef.current = false;
                  }}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={blocked !== undefined || phase.kind === "proposed"}
                  onClick={() => void runToEnd()}
                >
                  Run to the end
                </button>
              )}
              <button type="button" className={styles.ghost} disabled={working} onClick={skip}>
                Skip step
              </button>
            </div>
          )}

          {phase.kind === "proposed" ? (
            <ProposedMove
              translation={phase.translation}
              busy={busy || working}
              onApply={() => void apply(stored, phase.translation)}
              onChoose={(candidate) => void chooseInstead(candidate, phase.translation.callId)}
            />
          ) : null}

          {report === undefined || report.entries.length === 0 ? null : (
            <MissingMoves report={report} />
          )}
        </>
      )}
    </section>
  );
}

function PlanTree({ view, walk }: Readonly<{ view: PlanView; walk: Walk }>) {
  const numbers = new Map(view.numbers.map((entry) => [entry.stepId, entry]));
  const current = currentUnit(walk)?.stepId;
  return (
    <ol className={planStyles.tree} aria-label="Steps of the plan">
      {view.plan.steps.map((step) => {
        const numbered = numbers.get(step.id);
        const record = walk.records[step.id];
        const status: UnitStatus = record?.status ?? "pending";
        return (
          <li
            key={step.id}
            className={planStyles.step}
            style={{ marginLeft: `${((numbered?.level ?? 1) - 1) * 1.25}rem` }}
            aria-current={step.id === current ? "step" : undefined}
            data-step={step.id}
            data-status={status}
          >
            <div className={planStyles.stepHead}>
              <span className={planStyles.number}>{numbered?.number}</span>
              <span className={planStyles.keyword}>{FORM_KEYWORDS[step.form] ?? step.form}</span>
              <StepStatement step={step} rendered={view.rendered.steps[step.id]} />
              {step.form === "case" ? null : (
                <span className={planStyles.status} data-status={status}>
                  {STATUS_WORDS[status]}
                  {record?.skipped === true ? ", skipped" : ""}
                </span>
              )}
            </div>
            {step.motivation === null ? null : (
              <p className={planStyles.detail}>
                <em>Why:</em> {step.motivation}
              </p>
            )}
            <p className={planStyles.detail}>
              <em>By:</em> {justificationText(step)}
            </p>
            {record?.reason === undefined ? null : (
              <p className={planStyles.detail}>{record.reason}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepStatement({
  step,
  rendered,
}: Readonly<{ step: PlanStep; rendered: PlanView["rendered"]["steps"][string] | undefined }>) {
  const show = (latex: string | null | undefined, prose: string) =>
    latex === null || latex === undefined ? <span>{prose}</span> : <InlineLatex latex={latex} />;
  return (
    <span>
      {step.assumptions.length === 0 ? null : (
        <>
          ASSUME{" "}
          {step.assumptions.map((assumption, index) => (
            <span key={index}>
              {index === 0 ? "" : ", "}
              {show(rendered?.assumptions[index], assumption.prose)}
            </span>
          ))}{" "}
          PROVE{" "}
        </>
      )}
      {step.variables.length === 0 ? null : (
        <>NEW {step.variables.map(({ name }) => name).join(", ")} </>
      )}
      {step.term === null ? null : <>{show(rendered?.term, step.term.prose)} : </>}
      {step.claim === null ? null : show(rendered?.claim, step.claim.prose)}
    </span>
  );
}

function justificationText(step: PlanStep): string {
  const parts = [
    ...(step.by.method === null ? [] : [step.by.method]),
    ...(step.by.facts.length === 0 ? [] : [`using ${step.by.facts.join(", ")}`]),
    ...(step.by.results.length === 0 ? [] : [`results ${step.by.results.join(", ")}`]),
    ...(step.by.background === null ? [] : [`background: ${step.by.background}`]),
  ];
  return parts.length === 0 ? "the steps above" : parts.join("; ");
}

function ProposedMove({
  translation,
  busy,
  onApply,
  onChoose,
}: Readonly<{
  translation: Extract<Translation, { status: "proposed" }>;
  busy: boolean;
  onApply: () => void;
  onChoose: (candidate: PlanCandidate) => void;
}>) {
  const { choice } = translation;
  return (
    <section
      className={planStyles.card}
      aria-label="Proposed move"
      data-testid="proof-plan-proposal"
    >
      <div className={planStyles.stepHead}>
        <strong>{choice.label}</strong>
        <TransitionClassBadge transitionClass={translation.preview.transitionClass} />
      </div>
      <p className={planStyles.detail}>
        On:{" "}
        {choice.selections.map((latex, index) => (
          <span key={index}>
            {index === 0 ? "" : "; "}
            <InlineLatex latex={latex} />
          </span>
        ))}
      </p>
      <p className={planStyles.detail}>
        {translation.actor.kind === "agent"
          ? `Jev chose this move (confidence ${Math.round(translation.confidence * 100)}%).`
          : "You chose this move."}{" "}
        {Object.keys(translation.menuChoices).length === 0
          ? ""
          : "Its menu values were chosen from the displayed items."}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={onApply}>
          Apply
        </button>
      </div>
      {translation.alternatives.length === 0 ? null : (
        <div>
          <p className={planStyles.detail}>Other moves Jev considered:</p>
          <ul className={planStyles.alternatives}>
            {translation.alternatives.map((candidate) => (
              <li key={candidate.id}>
                {candidate.label}
                {candidate.probability === undefined
                  ? ""
                  : ` (${Math.round(candidate.probability * 100)}%)`}{" "}
                <button
                  type="button"
                  className={styles.ghost}
                  disabled={busy}
                  onClick={() => onChoose(candidate)}
                >
                  Choose this instead
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const STOPPED_HEADINGS: Readonly<Record<string, string>> = {
  "no-move": "This step needs a move the platform does not have.",
  "missing-construction": "The move exists, but not with the value this step needs.",
  uncertain: "Jev is not sure which move carries out this step.",
  unsupported: "This kind of step cannot be carried out on the platform yet.",
  stuck: "This step did not come out as planned.",
};

function StoppedUnit({
  translation,
  busy,
  onChoose,
}: Readonly<{
  translation: Exclude<Translation, { status: "proposed" | "realized" }>;
  busy: boolean;
  onChoose: (candidate: PlanCandidate, callId: string) => void;
}>) {
  const { callId } = translation;
  const alternatives = translation.alternatives ?? [];
  return (
    <div
      className={styles.note}
      data-tone={translation.status === "unsupported" ? "info" : "warning"}
      role="status"
      data-testid="proof-plan-stopped"
    >
      <p>
        <strong>{STOPPED_HEADINGS[translation.status]}</strong> {translation.reason}
      </p>
      {translation.status === "unsupported" ? null : (
        <p>
          You can choose one of the moves below, describe the step in the move-instructions box, or
          skip it.
        </p>
      )}
      {callId === undefined || alternatives.length === 0 ? null : (
        <ul className={planStyles.alternatives}>
          {alternatives.map((candidate) => (
            <li key={candidate.id}>
              {candidate.label}
              {candidate.probability === undefined
                ? ""
                : ` (${Math.round(candidate.probability * 100)}%)`}{" "}
              <button
                type="button"
                className={styles.ghost}
                disabled={busy}
                onClick={() => onChoose(candidate, callId)}
              >
                Choose this instead
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MissingMoves({ report }: Readonly<{ report: ReturnType<typeof missingMoveReport> }>) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(report, null, 2);
  return (
    <details className={planStyles.report} data-testid="proof-plan-report">
      <summary>
        Missing moves ({report.entries.length} step{report.entries.length === 1 ? "" : "s"} the
        platform could not carry out)
      </summary>
      <ul>
        {report.entries.map((entry) => (
          <li key={entry.stepId}>
            <strong>{entry.number}</strong> {entry.claim ?? FORM_KEYWORDS[entry.form]}:{" "}
            {entry.reason}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={styles.secondary}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? "Copied" : "Copy report as JSON"}
      </button>
      <pre>{text}</pre>
    </details>
  );
}
