"use client";

import { useEffect, useRef, useState } from "react";
import type { ProofNode } from "@proof/protocol";
import { useHydrated } from "../hydration/use-hydrated";
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

export const PROOF_PLAN_ID = "proof-plan";

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
  pending: "Pending",
  realized: "Done",
  skipped: "skipped",
  "no-move": "Missing move",
  "missing-construction": "Missing value",
  uncertain: "Uncertain",
  unsupported: "Unsupported",
  stuck: "Stuck",
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
  selections?: readonly string[];
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
  const hydrated = useHydrated();
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
  ): Promise<Stored | undefined> => {
    if (busy || !onApplyStart()) return undefined;
    setPhase({ kind: "applying", label: moveTitle(translation.choice.label) });
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
      const applied: Stored = {
        ...current,
        walk: next,
        appliedMoves: [
          ...(current.appliedMoves ?? []),
          {
            callId: translation.callId,
            stepNumber: unit?.number ?? "",
            label: name,
            motivation: step?.motivation ?? null,
            selections: translation.choice.selections,
            actor: translation.actor.kind,
            transitionClass: translation.preview.transitionClass,
          },
        ],
      };
      update(applied);
      const adopted = await onApplied({ nodeId: outcome.nodeId, name: moveTitle(name) });
      setPhase(IDLE);
      return adopted ? applied : undefined;
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
          current = applied;
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

  const blocked = !hydrated || busy || working || running;
  const moveBlocked = blocked || walkUnavailable !== undefined || moved;
  const report =
    stored === undefined || walk === undefined ? undefined : missingMoveReport(walk, stored.view);

  const unit = walk === undefined ? undefined : currentUnit(walk);
  const step = stored?.view.plan.steps.find(({ id }) => id === unit?.stepId);
  const canResume = moved && !working;
  const finished = walk !== undefined && walkFinished(walk);
  const { goals, obligations } = node.state;

  return (
    <section
      id={PROOF_PLAN_ID}
      tabIndex={-1}
      className={`${styles.panel} ${planStyles.panel}`}
      aria-labelledby="proof-plan-heading"
      data-testid="proof-plan"
    >
      <div className={planStyles.heading}>
        <h2 id="proof-plan-heading">Proof plan</h2>
        {walk === undefined || finished ? null : (
          <span className={planStyles.progress}>
            Step {walk.index + 1} of {walk.units.length}
          </span>
        )}
      </div>
      {draft === undefined ? (
        <div className={planStyles.stage}>
          <p className={styles.hint}>
            Draft an argument, adapt it to this workspace, then use Jev to turn each step into proof
            moves.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              disabled={blocked || draftUnavailable !== undefined}
              onClick={() => void writePlan("draft")}
            >
              {working ? "Drafting proof…" : "Draft proof"}
            </button>
            <PromptTip label="Independent proof" prompt={draftPrompt} />
          </div>
          {draftUnavailable === undefined ? null : (
            <p className={styles.reason}>{draftUnavailable}</p>
          )}
        </div>
      ) : stored === undefined ? (
        <div className={planStyles.stage}>
          <p className={styles.hint}>
            Adapt the draft to the current goal, available moves and library.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              disabled={blocked || blueprintUnavailable !== undefined}
              onClick={() => void writePlan("blueprint")}
            >
              {working ? "Adapting proof…" : "Adapt to workspace"}
            </button>
            <PromptTip label="Blueprint" prompt={blueprintPrompt} />
          </div>
          {blueprintUnavailable === undefined ? null : (
            <p className={styles.reason}>{blueprintUnavailable}</p>
          )}
        </div>
      ) : null}

      {phase.kind === "note" ? (
        <p className={styles.note} data-tone={phase.tone} role="status">
          {phase.message}
        </p>
      ) : null}
      {stored === undefined || walk === undefined ? null : (
        <section className={planStyles.stage} aria-label="Translate the blueprint">
          {step === undefined ? null : (
            <div className={planStyles.currentStep}>
              {step.assumptions.length === 0 ? null : (
                <p className={planStyles.detail}>
                  Assume{" "}
                  {step.assumptions.map((assumption, index) => {
                    const latex = stored.view.rendered.steps[step.id]?.assumptions[index];
                    return (
                      <span key={index}>
                        {index === 0 ? "" : ", "}
                        {latex == null ? assumption.prose : <InlineLatex latex={latex} />}
                      </span>
                    );
                  })}
                </p>
              )}
              <strong>
                {step.form === "qed"
                  ? "Close the goal"
                  : (step.claim?.prose ?? FORM_KEYWORDS[step.form])}
              </strong>
              {step.motivation === null ? null : (
                <p className={planStyles.detail}>{step.motivation}</p>
              )}
            </div>
          )}
          {walkUnavailable === undefined ? null : (
            <p className={styles.reason}>{walkUnavailable}</p>
          )}
          {phase.kind === "stopped" && !canResume ? (
            <StoppedUnit
              translation={phase.translation}
              busy={moveBlocked}
              onChoose={(candidate, callId) => void chooseInstead(candidate, callId)}
            />
          ) : null}
          <div role="status" className={`${styles.hint} ${planStyles.live}`}>
            {phase.kind === "translating" ? "Finding a move for this step…" : null}
            {phase.kind === "applying" ? `Applying ${phase.label}…` : null}
            {phase.kind === "idle" && !walkFinished(walk) && (stored.appliedMoves?.length ?? 0) > 0
              ? `Applied ${moveTitle(stored.appliedMoves?.at(-1)?.label ?? "")}.`
              : null}
          </div>
          {canResume ? (
            <div className={styles.note} data-tone="warning" role="status">
              <p>The proof changed outside the plan.</p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => {
                    update({ ...stored, walk: continueFrom(walk, node.id) });
                    setPhase(IDLE);
                  }}
                  disabled={blocked || walkUnavailable !== undefined}
                >
                  Continue from here
                </button>
              </div>
            </div>
          ) : finished ? (
            <p className={styles.note} role="status">
              {goals.length === 0 && obligations.length === 0
                ? "Blueprint finished. No open goals or obligations."
                : "Blueprint finished. This proof still has open goals or obligations."}
            </p>
          ) : phase.kind === "proposed" && !running ? null : (
            <div className={styles.actions}>
              {running ? (
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => {
                    runningRef.current = false;
                  }}
                >
                  Pause
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={moveBlocked}
                    onClick={() => void nextMove()}
                  >
                    Preview next move
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={moveBlocked}
                    onClick={() => void runToEnd()}
                  >
                    Run with Jev
                  </button>
                  <button
                    type="button"
                    className={styles.ghost}
                    disabled={moveBlocked}
                    onClick={skip}
                  >
                    Skip step
                  </button>
                </>
              )}
            </div>
          )}

          {phase.kind === "proposed" && !canResume && !running ? (
            <ProposedMove
              translation={phase.translation}
              busy={moveBlocked}
              onApply={() => void apply(stored, phase.translation)}
              onDismiss={() => setPhase(IDLE)}
              onChoose={(candidate) => void chooseInstead(candidate, phase.translation.callId)}
            />
          ) : null}

          {stored.appliedMoves === undefined || stored.appliedMoves.length === 0 ? null : (
            <details className={planStyles.disclosure}>
              <summary>Applied moves ({stored.appliedMoves.length})</summary>
              <ol className={planStyles.draftSteps} aria-label="Applied proof moves">
                {stored.appliedMoves.map((move) => (
                  <li key={move.callId}>
                    <strong>
                      {move.stepNumber}{" "}
                      {move.selections === undefined ? move.label : moveTitle(move.label)}
                    </strong>{" "}
                    <TransitionClassBadge transitionClass={move.transitionClass} />
                    {move.actor === "human" ? (
                      <span className={styles.hint}> Chosen manually</span>
                    ) : null}
                    <CandidateSelections selections={move.selections ?? []} />
                    {move.motivation === null ? null : (
                      <p className={planStyles.prose}>{move.motivation}</p>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {report === undefined || report.entries.length === 0 ? null : (
            <MissingMoves report={report} />
          )}
        </section>
      )}

      {stored === undefined || walk === undefined ? null : (
        <details className={planStyles.disclosure}>
          <summary>Blueprint</summary>
          <div className={planStyles.detailsBody}>
            <p className={planStyles.prose}>{stored.view.plan.sketch}</p>
            <PlanTree view={stored.view} walk={walk} />
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                disabled={blocked || blueprintUnavailable !== undefined || draft === undefined}
                onClick={() => void writePlan("blueprint")}
              >
                Rebuild blueprint
              </button>
              <PromptTip label="Blueprint" prompt={stored.view.prompt ?? blueprintPrompt} />
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
            </div>
          </div>
        </details>
      )}
      {draft === undefined ? null : (
        <details className={planStyles.disclosure}>
          <summary>Independent proof</summary>
          <div className={planStyles.detailsBody}>
            <p className={planStyles.prose}>{draft.draft.sketch}</p>
            <ol className={planStyles.draftSteps}>
              {draft.draft.steps.map(({ title, motivation, reasoning }, index) => (
                <li key={index}>
                  <strong>{title}</strong>
                  <p className={planStyles.prose}>{reasoning}</p>
                  <p className={planStyles.detail}>{motivation}</p>
                </li>
              ))}
            </ol>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                disabled={blocked || draftUnavailable !== undefined}
                onClick={() => void writePlan("draft")}
              >
                Draft again
              </button>
              <PromptTip label="Independent proof" prompt={draft.prompt ?? draftPrompt} />
            </div>
          </div>
        </details>
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
            style={{ marginInlineStart: `min(${((numbered?.level ?? 1) - 1) * 0.75}rem, 10%)` }}
            aria-current={step.id === current ? "step" : undefined}
            data-step={step.id}
            data-status={status}
          >
            <div className={planStyles.stepHead}>
              <span className={planStyles.number}>{numbered?.number}</span>
              <span className={planStyles.keyword}>{FORM_KEYWORDS[step.form] ?? step.form}</span>
              <StepStatement step={step} rendered={view.rendered.steps[step.id]} />
              {step.form === "case" || status === "pending" ? null : (
                <span className={planStyles.status} data-status={status}>
                  {STATUS_WORDS[status]}
                  {record?.skipped === true ? ", skipped" : ""}
                </span>
              )}
            </div>
            {step.motivation === null ? null : (
              <p className={planStyles.detail}>
                <strong>Motivation</strong> {step.motivation}
              </p>
            )}
            <p className={planStyles.detail}>
              <strong>Justification</strong> {justificationText(step)}
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

function moveTitle(label: string): string {
  return label.split(" — on ", 1)[0] ?? label;
}

function CandidateSelections({ selections }: Readonly<{ selections: readonly string[] }>) {
  if (selections.length === 0) return null;
  return (
    <p className={planStyles.detail}>
      {selections.map((latex, index) => (
        <span key={index}>
          {index === 0 ? "" : ", "}
          <InlineLatex latex={latex} />
        </span>
      ))}
    </p>
  );
}

function ProposedMove({
  translation,
  busy,
  onApply,
  onDismiss,
  onChoose,
}: Readonly<{
  translation: Extract<Translation, { status: "proposed" }>;
  busy: boolean;
  onApply: () => void;
  onDismiss: () => void;
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
        <strong>{moveTitle(choice.label)}</strong>
        <TransitionClassBadge transitionClass={translation.preview.transitionClass} />
      </div>
      <CandidateSelections selections={choice.selections} />
      <p className={planStyles.detail}>
        {translation.actor.kind === "agent"
          ? `Jev chose this move (confidence ${Math.round(translation.confidence * 100)}%).`
          : "You chose this move."}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={busy} onClick={onApply}>
          Apply move
        </button>
        <button type="button" className={styles.ghost} disabled={busy} onClick={onDismiss}>
          Dismiss preview
        </button>
      </div>
      {translation.alternatives.length === 0 ? null : (
        <details className={planStyles.disclosure}>
          <summary>Other moves</summary>
          <ul className={planStyles.alternatives}>
            {translation.alternatives.map((candidate) => (
              <li key={candidate.id}>
                {moveTitle(candidate.label)}
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
                <CandidateSelections selections={candidate.selections} />
              </li>
            ))}
          </ul>
        </details>
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
          {alternatives.length > 0
            ? "Choose another move below or skip this step."
            : "Skip this step or make a move in the workspace."}
        </p>
      )}
      {callId === undefined || alternatives.length === 0 ? null : (
        <ul className={planStyles.alternatives}>
          {alternatives.map((candidate) => (
            <li key={candidate.id}>
              {moveTitle(candidate.label)}
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
              <CandidateSelections selections={candidate.selections} />
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
