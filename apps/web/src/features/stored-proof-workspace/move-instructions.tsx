"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { HAND_AUTHORED_MOVES } from "@proof/moves";
import type { OperatorDeclaration, ProofNode } from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import type { Presentation } from "@proof/language";
import type { WorkspaceView } from "../proof-workspace";
import {
  proposalHref,
  requestMoveProposal,
  stashMoveProposal,
} from "../move-authoring/proposal-contract";
import {
  requestMoveInstructionApply,
  requestMoveInstructionPreview,
  type ExecutorPreview,
  type MoveInstructionOutcome,
} from "./move-instructions-contract";
import { StateChangeSections, deltaText } from "./preview-details";
import { previewDiff } from "./preview-diff";
import { toDescriptor } from "./selection-descriptor";
import { EvidenceBadge, TransitionClassBadge, transitionMeaning } from "./suggestion-badges";
import { READ_ONLY_REASON } from "./toolbar-actions";
import { movesHref } from "./workspace-toolbar";
import previewStyles from "./suggestion-panel.module.css";
import styles from "./move-instructions.module.css";

export const MOVE_INSTRUCTIONS_PLACEHOLDER =
  "Describe a step, e.g. 'split into cases on whether n is even'";

export type MoveInstructionsProps = Readonly<{
  sessionId: string;
  node: ProofNode;
  operators: readonly OperatorDeclaration[];
  /** The occurrences currently selected in the proof state. */
  selections: readonly AnchoredProofSelection[];
  presentation: Presentation;
  view: WorkspaceView;
  /** Whether the proof service has a configured move executor. */
  enabled: boolean;
  /** Whether the proof service has a configured move author ("Save as reusable move"). */
  moveAuthorEnabled?: boolean | undefined;
  readOnly: boolean;
  /** Another proof command is being applied. */
  busy: boolean;
  /** The description box, so the rest of the page can send the user to it. */
  textareaRef?: RefObject<HTMLTextAreaElement | null> | undefined;
  /** Claim the page's single proof-command slot; false when another command is running. */
  onApplyStart: () => boolean;
  /** Release the slot, whatever the outcome. */
  onApplyEnd: () => void;
  /** Called after a plan was committed, with what happened; the page reloads the proof. */
  onApplied: (applied: Readonly<{ nodeId: string; stepCount: number }>) => void | Promise<void>;
  createId?: (prefix: string) => string;
  /** Open an address; the page is replaced. Defaults to the browser's navigation. */
  navigate?: ((href: string) => void) | undefined;
}>;

type Phase =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "previewing" }>
  | Readonly<{ kind: "previewed"; preview: ExecutorPreview }>
  | Readonly<{ kind: "applying"; preview: ExecutorPreview }>
  | Readonly<{
      kind: "plan-failed";
      explanation: string;
      failure: Extract<MoveInstructionOutcome, { kind: "plan-failed" }>["failure"];
    }>
  | Readonly<{ kind: "note"; tone: "info" | "warning"; message: string }>;

const IDLE: Phase = { kind: "idle" };

/** The step just applied, which can be turned into a reusable move. */
type SaveState =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "offered"; callId: string }>
  | Readonly<{ kind: "asking"; callId: string }>
  | Readonly<{ kind: "note"; callId: string; message: string }>;

const NO_SAVE: SaveState = { kind: "none" };

export const SAVE_AS_MOVE_HINT =
  "Turn this step into a general move you can reuse. You'll review it before it's added.";

type Target = Readonly<{ kind: "goal" | "obligation"; id: string }>;

/** The goal or obligation a described step is about: the selection's, else the first open one. */
function chooseTarget(
  node: ProofNode,
  selections: readonly AnchoredProofSelection[],
):
  | Readonly<{ ok: true; target: Target; fromSelection: boolean }>
  | Readonly<{ ok: false; reason: string }> {
  const first = selections[0];
  if (first !== undefined) {
    const { target } = first.anchor;
    const sameTarget = selections.every(
      ({ anchor }) => anchor.target.kind === target.kind && anchor.target.id === target.id,
    );
    return sameTarget
      ? { ok: true, target: { kind: target.kind, id: target.id }, fromSelection: true }
      : {
          ok: false,
          reason: "Your selections are in different goals. Select within one goal or obligation.",
        };
  }
  const goal = node.state.goals[0];
  if (goal !== undefined)
    return { ok: true, target: { kind: "goal", id: goal.id }, fromSelection: false };
  const obligation = node.state.obligations[0];
  if (obligation !== undefined) {
    return { ok: true, target: { kind: "obligation", id: obligation.id }, fromSelection: false };
  }
  return { ok: false, reason: "There is nothing left to prove at this point." };
}

/** "Introduce implication", from the kernel operation's name. */
function stepName(kind: string): string {
  const move = HAND_AUTHORED_MOVES.find(
    ({ implementation }) => implementation.operationKind === kind,
  );
  return move?.name ?? kind.replace(/-/g, " ");
}

/**
 * "Move instructions" (architecture §5): describe a step in words, see what a model proposes as
 * checked kernel steps, and apply it only after reading the result. The model never changes the
 * proof; the proof service runs every step through the kernel first and again when applying.
 */
export function MoveInstructions({
  sessionId,
  node,
  operators,
  selections,
  presentation,
  view,
  enabled,
  moveAuthorEnabled = false,
  readOnly,
  busy,
  textareaRef,
  onApplyStart,
  onApplyEnd,
  onApplied,
  createId = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  navigate = (href) => window.location.assign(href),
}: MoveInstructionsProps) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>(IDLE);
  const [save, setSave] = useState<SaveState>(NO_SAVE);
  const textId = useId();
  const reasonId = useId();
  const hintId = useId();
  const saveHintId = useId();
  const saveReasonId = useId();
  // Identifies the latest request: an answer to an older one, or one for a proof that moved on,
  // is dropped.
  const latest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A preview belongs to one proof node. When the proof moves on, it is discarded.
  useEffect(() => {
    latest.current += 1;
    setPhase(IDLE);
  }, [node.id]);

  const target = chooseTarget(node, selections);
  const trimmed = text.trim();
  const working = phase.kind === "previewing" || phase.kind === "applying";
  const unavailable = !enabled
    ? "Move instructions are unavailable: no AI provider is configured for this service."
    : readOnly
      ? `${READ_ONLY_REASON}: no step can be described or applied.`
      : undefined;
  const previewBlocked =
    unavailable ??
    (busy
      ? "Another step is being applied; wait for it to finish."
      : !target.ok
        ? target.reason
        : trimmed.length === 0
          ? "Describe a step first."
          : working
            ? "A request is already running."
            : undefined);

  const preview = async () => {
    if (previewBlocked !== undefined || !target.ok) return;
    const request = ++latest.current;
    setPhase({ kind: "previewing" });
    const outcome = await requestMoveInstructionPreview(
      sessionId,
      {
        id: createId("llm-call:execute"),
        expectedCurrentNodeId: node.id,
        instruction: trimmed,
        source: "user-instruction",
        target: target.target,
        ...(selections.length === 0 ? {} : { selections: selections.map((s) => toDescriptor(s)) }),
      },
      operators,
    );
    if (!mounted.current || latest.current !== request) return;
    if (outcome.kind === "previewed") {
      setPhase(
        outcome.preview.nodeId === node.id
          ? { kind: "previewed", preview: outcome.preview }
          : { kind: "note", tone: "warning", message: STALE_MESSAGE },
      );
    } else if (outcome.kind === "plan-failed") {
      setPhase({
        kind: "plan-failed",
        explanation: outcome.explanation,
        failure: outcome.failure,
      });
    } else if (outcome.kind === "model-note") {
      setPhase({
        kind: "note",
        tone: "info",
        message:
          outcome.tone === "needs-detail"
            ? `The model needs more detail: ${outcome.message}`
            : `The model did not propose a step: ${outcome.message}`,
      });
    } else {
      setPhase({ kind: "note", tone: "warning", message: outcome.message });
    }
  };

  const apply = async () => {
    if (phase.kind !== "previewed" || busy || !onApplyStart()) return;
    const { preview: shown } = phase;
    const request = ++latest.current;
    setPhase({ kind: "applying", preview: shown });
    try {
      const outcome = await requestMoveInstructionApply(sessionId, {
        callId: shown.callId,
        expectedCurrentNodeId: node.id,
      });
      if (!mounted.current || latest.current !== request) return;
      if (outcome.kind === "error") {
        setPhase({ kind: "note", tone: "warning", message: outcome.message });
        return;
      }
      setText("");
      setPhase(IDLE);
      // Only a step the user described in their own words can become a move.
      setSave(
        shown.provenance === "user-proposal" ? { kind: "offered", callId: shown.callId } : NO_SAVE,
      );
      await onApplied({ nodeId: outcome.nodeId, stepCount: outcome.stepCount });
    } finally {
      onApplyEnd();
    }
  };

  const discard = () => {
    latest.current += 1;
    setPhase(IDLE);
  };

  const saveBlocked = !moveAuthorEnabled
    ? "Saving a step as a move is unavailable: no AI provider is configured for this service."
    : readOnly
      ? `${READ_ONLY_REASON}: no move can be proposed.`
      : busy
        ? "Another step is being applied; wait for it to finish."
        : save.kind === "asking"
          ? "The model is working on it."
          : undefined;

  const saveAsMove = async () => {
    if (saveBlocked !== undefined || (save.kind !== "offered" && save.kind !== "note")) return;
    const { callId } = save;
    setSave({ kind: "asking", callId });
    const outcome = await requestMoveProposal(sessionId, {
      id: createId("llm-call:author"),
      executorCallId: callId,
    });
    if (!mounted.current) return;
    if (outcome.kind === "proposed") {
      if (!stashMoveProposal(sessionId, outcome.proposal)) {
        setSave({
          kind: "note",
          callId,
          message:
            "Your browser does not allow the storage needed to open the proposal. Allow site data and try again.",
        });
        return;
      }
      navigate(proposalHref(movesHref(sessionId), outcome.proposal.callId));
      setSave({ kind: "offered", callId });
      return;
    }
    setSave({
      kind: "note",
      callId,
      message:
        outcome.kind === "error"
          ? outcome.message
          : outcome.tone === "needs-detail"
            ? `The model needs more detail: ${outcome.message}`
            : `The model did not propose a move: ${outcome.message}`,
    });
  };

  const selectionHint =
    selections.length > 0
      ? `Using your current selection (${selections.length} occurrence${selections.length === 1 ? "" : "s"}).`
      : target.ok
        ? "Nothing is selected, so the step is about the first open goal. Select part of a statement to point at it."
        : "";

  return (
    <section
      className={styles.panel}
      aria-label="Move instructions"
      data-testid="move-instructions"
    >
      <h2>Move instructions</h2>
      <p id={hintId} className={styles.hint}>
        Say in your own words what to do next. A model proposes kernel steps from your description
        and your selection; you see exactly what they change before anything is applied, and the
        kernel checks every step.
      </p>
      <label htmlFor={textId} className={styles.label}>
        Describe a step
      </label>
      <textarea
        id={textId}
        ref={textareaRef}
        className={styles.textarea}
        rows={3}
        maxLength={2000}
        value={text}
        placeholder={MOVE_INSTRUCTIONS_PLACEHOLDER}
        disabled={unavailable !== undefined || working}
        aria-describedby={`${hintId} ${reasonId}`}
        onChange={(event) => setText(event.target.value)}
      />
      {selectionHint === "" || unavailable !== undefined ? null : (
        <p className={styles.hint}>{selectionHint}</p>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={previewBlocked !== undefined}
          aria-describedby={reasonId}
          onClick={() => void preview()}
        >
          {phase.kind === "previewing" ? "Asking the model…" : "Preview"}
        </button>
        <span id={reasonId} className={styles.reason}>
          {previewBlocked ?? ""}
        </span>
      </div>

      {phase.kind === "note" ? (
        <p className={styles.note} data-tone={phase.tone} role="status">
          {phase.message}
        </p>
      ) : null}

      {save.kind === "none" ? null : (
        <div className={styles.saveMove} data-testid="save-as-move">
          <p className={styles.hint} id={saveHintId}>
            {SAVE_AS_MOVE_HINT}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={saveBlocked !== undefined}
              aria-describedby={`${saveHintId} ${saveReasonId}`}
              onClick={() => void saveAsMove()}
            >
              {save.kind === "asking" ? "Asking the model…" : "Save as reusable move"}
            </button>
            <button
              type="button"
              disabled={save.kind === "asking"}
              onClick={() => setSave(NO_SAVE)}
            >
              Not now
            </button>
            <span id={saveReasonId} className={styles.reason}>
              {saveBlocked ?? ""}
            </span>
          </div>
          {save.kind === "note" ? (
            <p className={styles.note} data-tone="warning" role="status">
              {save.message}
            </p>
          ) : null}
        </div>
      )}

      {phase.kind === "plan-failed" ? (
        <div className={styles.note} data-tone="warning" role="status" data-testid="plan-failed">
          <p>
            <strong>
              The proposed plan stopped at step {phase.failure.stepIndex} of{" "}
              {phase.failure.stepCount}.
            </strong>{" "}
            The kernel said: {phase.failure.message} Nothing was changed.
          </p>
          <p>
            What the model meant: {phase.explanation} Try rewording the step, or select the part of
            the proof it is about.
          </p>
        </div>
      ) : null}

      {phase.kind === "previewed" || phase.kind === "applying" ? (
        <PreviewCard
          preview={phase.preview}
          applying={phase.kind === "applying"}
          busy={busy}
          presentation={presentation}
          view={view}
          onApply={() => void apply()}
          onDiscard={discard}
        />
      ) : null}
    </section>
  );
}

const STALE_MESSAGE =
  "The proof moved on while the model was working. Nothing was changed; preview again.";

function PreviewCard({
  preview,
  applying,
  busy,
  presentation,
  view,
  onApply,
  onDiscard,
}: Readonly<{
  preview: ExecutorPreview;
  applying: boolean;
  busy: boolean;
  presentation: Presentation;
  view: WorkspaceView;
  onApply: () => void;
  onDiscard: () => void;
}>) {
  const diff = previewDiff(preview);
  return (
    <section
      className={previewStyles.previewPanel}
      aria-label="Proposed steps"
      data-testid="executor-preview"
      data-transition-class={preview.transitionClass}
    >
      <div className={previewStyles.previewHeading}>
        <strong>Review the proposed steps before applying</strong>
        <span className={previewStyles.badgeRow}>
          <TransitionClassBadge transitionClass={preview.transitionClass} />
          <EvidenceBadge evidence={preview.evidence} />
        </span>
      </div>
      <p className={styles.meaning} data-testid="executor-meaning">
        {transitionMeaning(preview.transitionClass)}
      </p>
      <p className={previewStyles.previewMeaning}>
        {preview.explanation} Proposed by an AI model from{" "}
        {preview.provenance === "user-proposal" ? "your description" : "a suggested technique"}; the
        kernel has checked each step.
      </p>
      <dl className={previewStyles.previewCounts}>
        <div>
          <dt>Goals</dt>
          <dd>{deltaText(preview.delta.goals)}</dd>
        </div>
        <div>
          <dt>Obligations</dt>
          <dd>{deltaText(preview.delta.obligations)}</dd>
        </div>
      </dl>
      <div>
        <strong>The steps ({preview.steps.length})</strong>
        <ol className={styles.steps} aria-label="Steps of this plan">
          {preview.steps.map((step) => (
            <li key={step.index} data-step={step.index}>
              {stepName(step.operation.kind)}{" "}
              <TransitionClassBadge transitionClass={step.transitionClass} />
            </li>
          ))}
        </ol>
      </div>
      <StateChangeSections diff={diff} presentation={presentation} view={view} />
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={applying || busy}
          onClick={onApply}
        >
          {applying ? "Applying…" : "Apply"}
        </button>
        <button type="button" disabled={applying} onClick={onDiscard}>
          Discard
        </button>
      </div>
    </section>
  );
}
