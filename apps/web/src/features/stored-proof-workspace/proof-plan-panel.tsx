"use client";

import { useEffect, useRef, useState } from "react";
import type { ProofNode } from "@proof/protocol";
import { PromptTip } from "../problem-entry/prompt-tip";
import { InlineLatex } from "../proof-workspace/presentation";
import {
  proofDraftViewSchema,
  readProofPlan,
  requestPlanApply,
  requestPlanTranslation,
  requestProofPlan,
  type PlanCandidate,
  type PlanStep,
  type PlanView,
  type ProofDraftView,
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
  draftEnabled: boolean;
  blueprintEnabled: boolean;
  translatorEnabled: boolean;
  hasStatement: boolean;
  draftPrompt?: string | undefined;
  blueprintPrompt?: string | undefined;
  readOnly: boolean;
  /** Another proof command is being applied. */
  busy: boolean;
  onApplyStart: () => boolean;
  onApplyEnd: () => void;
  /** Called after a move was committed; the page reloads the proof. */
  onApplied: (applied: Readonly<{ nodeId: string; name: string }>) => boolean | Promise<boolean>;
  createId?: (prefix: string) => string;
}>;

type AppliedMove = Readonly<{
  callId: string;
  stepNumber: string;
  label: string;
  motivation: string | null;
  actor: "agent" | "human";
  transitionClass: Extract<Translation, { status: "proposed" }>["preview"]["transitionClass"];
}>;
type Stored = Readonly<{ view: PlanView; walk: Walk; appliedMoves?: readonly AppliedMove[] }>;

type Phase =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "planning"; stage: "draft" | "blueprint" }>
  | Readonly<{ kind: "translating" }>
  | Readonly<{ kind: "proposed"; translation: Extract<Translation, { status: "proposed" }> }>
  | Readonly<{ kind: "applying"; label: string }>
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
  draftEnabled,
  blueprintEnabled,
  translatorEnabled,
  hasStatement,
  draftPrompt,
  blueprintPrompt,
  readOnly,
  busy,
  onApplyStart,
  onApplyEnd,
  onApplied,
  createId = (prefix) => `${prefix}-${crypto.randomUUID()}`,
}: ProofPlanPanelProps) {
  const [stored, setStored] = useState<Stored>();
  const [draft, setDraft] = useState<ProofDraftView>();
  const [phase, setPhase] = useState<Phase>(IDLE);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setStored(loadStored(sessionId));
    try {
      const saved = window.sessionStorage.getItem(`proof-draft:${sessionId}`);
      setDraft(saved === null ? undefined : proofDraftViewSchema.safeParse(JSON.parse(saved)).data);
    } catch {
      setDraft(undefined);
    }
    return () => {
      mounted.current = false;
      runningRef.current = false;
    };
  }, [sessionId]);

  const update = (next: Stored | undefined) => {
    setStored(next);
    saveStored(sessionId, next);
  };

  const working =
    phase.kind === "planning" || phase.kind === "translating" || phase.kind === "applying";
  const walk = stored?.walk;
  const moved = walk !== undefined && walk.nodeId !== node.id;
  const draftUnavailable = !hasStatement
    ? "This session has no problem statement."
    : !draftEnabled
      ? "The proof draft model is unavailable."
      : undefined;
  const blueprintUnavailable = readOnly
    ? READ_ONLY_REASON
    : !blueprintEnabled
      ? "The blueprint model is unavailable."
      : undefined;
  const walkUnavailable = readOnly
    ? READ_ONLY_REASON
    : !translatorEnabled
      ? "Jev is unavailable."
      : undefined;

  const writePlan = async (stage: "draft" | "blueprint") => {
    if (working || running || busy) return;
    const callId = createId(`llm-call:${stage}`);
    const request =
      stage === "draft"
        ? { id: callId, stage }
        : {
            id: callId,
            expectedCurrentNodeId: node.id,
            draftCallId: draft?.callId ?? "",
          };
    setPhase({ kind: "planning", stage });
    let outcome = await requestProofPlan(sessionId, request);
    const began = Date.now();
    while (outcome.kind === "planning" && mounted.current && Date.now() - began < POLL_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (!mounted.current) return;
      outcome = await readProofPlan(sessionId, outcome.callId);
    }
    if (!mounted.current) return;
    if (outcome.kind === "drafted") {
      setDraft(outcome.view);
      try {
        window.sessionStorage.setItem(`proof-draft:${sessionId}`, JSON.stringify(outcome.view));
      } catch {
        // The draft remains available for this page.
      }
      update(undefined);
      setPhase(IDLE);
    } else if (outcome.kind === "planned") {
      update({
        view: outcome.view,
        walk: startWalk(outcome.view, outcome.view.initialState.nodeId),
      });
      setPhase(IDLE);
    } else {
      setPhase({
        kind: "note",
        tone: outcome.kind === "note" ? "info" : "warning",
        message:
          outcome.kind === "planning"
            ? "The model did not finish in time. Try again later."
            : outcome.message,
      });
    }
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
    setPhase({ kind: "applying", label: translation.choice.label });
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
      const unit = currentUnit(current.walk);
      const step = current.view.plan.steps.find(({ id }) => id === unit?.stepId);
      update({
        ...current,
        walk: next,
        appliedMoves: [
          ...(current.appliedMoves ?? []),
          {
            callId: translation.callId,
            stepNumber: unit?.number ?? "",
            label: name,
            motivation: step?.motivation ?? null,
            actor: translation.actor.kind,
            transitionClass: translation.preview.transitionClass,
          },
        ],
      });
      const adopted = await onApplied({ nodeId: outcome.nodeId, name });
      setPhase(IDLE);
      return adopted ? next : undefined;
    } finally {
      onApplyEnd();
    }
  };

  const nextMove = async () => {
    if (stored === undefined || working || busy) return;
    await translate(stored);
  };

  const runToEnd = async () => {
    if (stored === undefined || working || busy || runningRef.current) return;
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
          if (!runningRef.current) return;
          const applied = await apply(current, translation);
          if (applied === undefined) return;
          current = { ...current, walk: applied };
        } else if (translation?.status !== "realized") {
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

  const blocked = busy || working || running;
  const moveBlocked = blocked || walkUnavailable !== undefined || moved;
  const report =
    stored === undefined || walk === undefined ? undefined : missingMoveReport(walk, stored.view);

  return (
    <section className={styles.panel} aria-label="Proof plan" data-testid="proof-plan">
      <h2>Proof plan</h2>
      <section className={planStyles.stage} aria-label="Independent proof">
        <h3>
          Independent proof{" "}
          <PromptTip label="Independent proof" prompt={draft?.prompt ?? draftPrompt} />
        </h3>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            disabled={blocked || draftUnavailable !== undefined}
            onClick={() => void writePlan("draft")}
          >
            {phase.kind === "planning" && phase.stage === "draft"
              ? "Writing the independent proof…"
              : draft === undefined
                ? "Write independent proof"
                : "Write a new independent proof"}
          </button>
          {draftUnavailable === undefined ? null : (
            <span className={styles.reason}>{draftUnavailable}</span>
          )}
        </div>
        {draft === undefined ? null : (
          <>
            <p className={planStyles.prose}>{draft.draft.sketch}</p>
            <ol className={planStyles.draftSteps}>
              {draft.draft.steps.map(({ title, motivation, reasoning }, index) => (
                <li key={index}>
                  <strong>{title}</strong>
                  <p className={planStyles.prose}>
                    <em>Motivation</em> {motivation}
                  </p>
                  <p className={planStyles.prose}>{reasoning}</p>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      <section className={planStyles.stage} aria-label="Blueprint">
        <h3>
          Blueprint <PromptTip label="Blueprint" prompt={stored?.view.prompt ?? blueprintPrompt} />
        </h3>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            disabled={blocked || draft === undefined || blueprintUnavailable !== undefined}
            onClick={() => void writePlan("blueprint")}
          >
            {phase.kind === "planning" && phase.stage === "blueprint"
              ? "Adapting the proof…"
              : stored === undefined
                ? "Build blueprint"
                : "Rebuild blueprint"}
          </button>
          {stored === undefined ? null : (
            <button
              type="button"
              className={styles.ghost}
              disabled={blocked}
              onClick={() => {
                update(undefined);
                setPhase(IDLE);
              }}
            >
              Close blueprint
            </button>
          )}
          {blueprintUnavailable === undefined ? null : (
            <span className={styles.reason}>{blueprintUnavailable}</span>
          )}
        </div>
        {stored === undefined || walk === undefined ? null : (
          <>
            <p className={planStyles.prose}>
              <strong>Goal</strong> {stored.view.plan.theorem.prose}
            </p>
            <p className={planStyles.prose}>{stored.view.plan.sketch}</p>
            <PlanTree view={stored.view} walk={walk} />
          </>
        )}
      </section>

      {phase.kind === "note" ? (
        <p className={styles.note} data-tone={phase.tone} role="status">
          {phase.message}
        </p>
      ) : null}
      <section className={planStyles.stage} aria-label="Proof on the platform">
        <h3>Proof on the platform</h3>
        {walkUnavailable === undefined ? null : <p className={styles.reason}>{walkUnavailable}</p>}
        {phase.kind === "stopped" ? (
          <StoppedUnit
            translation={phase.translation}
            busy={moveBlocked}
            onChoose={(candidate, callId) => void chooseInstead(candidate, callId)}
          />
        ) : null}
        {stored === undefined || walk === undefined ? (
          <p className={styles.hint}>Build a blueprint to start Jev.</p>
        ) : (
          <>
            <div role="status" className={styles.hint}>
              {phase.kind === "translating"
                ? `Jev is choosing a move for step ${currentUnit(walk)?.number ?? ""}.`
                : null}
              {phase.kind === "applying" ? `Applying ${phase.label}…` : null}
              {phase.kind === "idle" &&
              !walkFinished(walk) &&
              (stored.appliedMoves?.length ?? 0) > 0
                ? `Applied ${stored.appliedMoves?.at(-1)?.label}.`
                : null}
            </div>
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
                    disabled={blocked || walkUnavailable !== undefined}
                  >
                    Continue from here
                  </button>
                </div>
              </div>
            ) : walkFinished(walk) ? (
              <p className={styles.note} role="status">
                Jev reached the end of the blueprint.
              </p>
            ) : (
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={moveBlocked || phase.kind === "proposed"}
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
                    disabled={moveBlocked || phase.kind === "proposed"}
                    onClick={() => void runToEnd()}
                  >
                    Run to the end
                  </button>
                )}
                <button
                  type="button"
                  className={styles.ghost}
                  disabled={moveBlocked}
                  onClick={skip}
                >
                  Skip step
                </button>
              </div>
            )}

            {phase.kind === "proposed" ? (
              <ProposedMove
                translation={phase.translation}
                busy={moveBlocked}
                onApply={() => void apply(stored, phase.translation)}
                onChoose={(candidate) => void chooseInstead(candidate, phase.translation.callId)}
              />
            ) : null}

            {stored.appliedMoves === undefined || stored.appliedMoves.length === 0 ? null : (
              <ol className={planStyles.draftSteps} aria-label="Applied proof moves">
                {stored.appliedMoves.map((move) => (
                  <li key={move.callId}>
                    <strong>
                      {move.stepNumber} {move.label}
                    </strong>{" "}
                    <TransitionClassBadge transitionClass={move.transitionClass} />
                    {move.actor === "human" ? (
                      <span className={styles.hint}> Chosen manually</span>
                    ) : null}
                    {move.motivation === null ? null : (
                      <p className={planStyles.prose}>{move.motivation}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {report === undefined || report.entries.length === 0 ? null : (
              <MissingMoves report={report} />
            )}
          </>
        )}
      </section>
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
    latex === null || latex === undefined || latex === prose ? (
      <span>{prose}</span>
    ) : (
      <span>
        {prose} <InlineLatex latex={latex} />
      </span>
    );
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
