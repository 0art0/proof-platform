"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { Presentation } from "@proof/language";
import type { OperatorDeclaration, ProofNode, ProtocolCommandEnvelope } from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import type { WorkspaceView } from "../proof-workspace";
import { NaturalLanguageText } from "../proof-workspace/presentation";
import type { MoveState } from "../stored-proof-workspace/suggestion-card";
import type { SuggestionState } from "../stored-proof-workspace/suggestion-panel";
import type {
  RunToolbarCommand,
  ToolbarHistory,
} from "../stored-proof-workspace/toolbar-action-bar";
import {
  describeCommandFailure,
  postProtocolCommand,
} from "../stored-proof-workspace/toolbar-requests";
import { ConstructionTaskView } from "./construction-task-view";
import { constructionTaskModel } from "./construction-view";
import {
  constructAvailability,
  constructEnvelope,
  findConditionsAvailability,
  findConditionsEnvelope,
  inquiryCommandId,
  investigateAvailability,
  investigateEnvelope,
  tryMethodAvailability,
  tryMethodEnvelope,
  useThisAvailability,
  useThisEnvelope,
  type Availability,
} from "./inquiry-actions";
import { fetchInquiryRecords } from "./inquiry-requests";
import {
  createSummaryExplainer,
  describeInquiry,
  explanationContext,
  summarizeInquiry,
} from "./inquiry-summary";
import type { InquiryRecord } from "@proof/protocol";
import styles from "./inquiry-panel.module.css";

export type InquiryPanelProps = Readonly<{
  sessionId: string;
  node: ProofNode;
  history: ToolbarHistory;
  selections: readonly AnchoredProofSelection[];
  suggestions: SuggestionState;
  move: MoveState;
  mutationPending: boolean;
  presentation: Presentation;
  operators: readonly OperatorDeclaration[];
  view: WorkspaceView;
  /** The workspace's command path, for actions that move the cursor to a new node. */
  runCommand: RunToolbarCommand;
}>;

type RecordsState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; records: readonly InquiryRecord[] }>
  | Readonly<{ kind: "failed"; message: string; records: readonly InquiryRecord[] }>;

type Feedback = Readonly<{ state: "committed" | "rejected"; text: string }>;

/**
 * The compact inquiry panel (refinement §10, roadmap N34): the active objective, the current
 * attempt, the top obstruction or next requirement, the unresolved constructions, and the
 * inquiry actions. Everything shown is read from stored records and the stored snapshot; the
 * sentences are the deterministic N23 templates. Each action is one command envelope through the
 * single command service; unavailable actions stay visible and say why.
 */
export function InquiryPanel(props: InquiryPanelProps) {
  const { sessionId, node, history, selections, suggestions, move } = props;
  const { mutationPending, presentation, operators, view, runCommand } = props;
  const [records, setRecords] = useState<RecordsState>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();
  const busy = mutationPending || pending;

  useEffect(() => {
    const controller = new AbortController();
    void fetchInquiryRecords(sessionId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setRecords((previous) =>
        result.ok
          ? { kind: "ready", records: result.records }
          : {
              kind: "failed",
              message: result.message,
              records: previous.kind === "loading" ? [] : previous.records,
            },
      );
    });
    return () => controller.abort();
  }, [sessionId, node.id, reloads]);

  const loaded = records.kind === "loading" ? [] : records.records;
  const summary = useMemo(
    () =>
      records.kind === "loading"
        ? undefined
        : summarizeInquiry({ records: loaded, state: node.state }),
    [records, node.state],
  );
  const explainer = useMemo(() => createSummaryExplainer(operators), [operators]);
  const description = useMemo(() => {
    if (summary === undefined) return undefined;
    const nodes = new Map<string, ProofNode["state"]>([[node.id, node.state]]);
    const transitions = new Map<string, "equivalence" | "strengthening" | "weakening">();
    if (history.kind === "ready") {
      history.nodes.forEach((stored) => nodes.set(stored.id, stored.state));
      history.edges.forEach(({ edge }) => transitions.set(edge.childNodeId, edge.transitionClass));
    }
    const set =
      suggestions.kind === "ready" || suggestions.kind === "empty"
        ? suggestions.suggestionSet
        : undefined;
    const context = explanationContext({
      records: loaded,
      nodes,
      transitions,
      ...(set === undefined
        ? {}
        : {
            suggestions: {
              setId: set.id,
              items: set.suggestions.map(({ id, name, source, artifactId }) => ({
                id,
                name,
                source,
                artifactId,
              })),
            },
          }),
    });
    return describeInquiry(summary, explainer, context);
  }, [summary, explainer, history, node, suggestions, records]);

  const reload = useCallback(() => setReloads((count) => count + 1), []);

  /** Record-only actions leave the cursor where it is: send, then reread the records. */
  const record = useCallback(
    async (action: string, envelope: ProtocolCommandEnvelope) => {
      setPending(true);
      setFeedback(undefined);
      const outcome = await postProtocolCommand(sessionId, envelope);
      setPending(false);
      if (!outcome.ok) {
        setFeedback({ state: "rejected", text: describeCommandFailure(action, outcome) });
        return;
      }
      setFeedback({
        state: "committed",
        text: outcome.response.replayed
          ? `${action} was already recorded in this inquiry.`
          : `Recorded in this inquiry: ${action}.`,
      });
      reload();
    },
    [reload, sessionId],
  );

  /** Actions that advance the proof state go through the workspace's command path. */
  const advance = useCallback(
    async (action: string, envelope: ProtocolCommandEnvelope) => {
      setPending(true);
      setFeedback(undefined);
      const outcome = await runCommand(action, envelope);
      setPending(false);
      if (!outcome.ok) {
        setFeedback({ state: "rejected", text: describeCommandFailure(action, outcome) });
        return;
      }
      const created = outcome.response.result.inquiryRecords;
      setFeedback({
        state: "committed",
        text: `${action} started${Array.isArray(created) && created.length > 0 ? ". Related inquiry details were added." : "."}`,
      });
      reload();
    },
    [reload, runCommand],
  );

  const investigate = investigateAvailability(node, selections);
  const tryMethod = tryMethodAvailability(suggestions, move);
  const construct = constructAvailability(node, selections);
  const findConditions = findConditionsAvailability(node, selections);
  const useThis = useThisAvailability(node, selections, summary);

  const open = summary?.unresolvedConstructions ?? [];
  const allTasks = node.state.constructions ?? [];
  const closed = allTasks.filter(({ status }) => status === "resolved" || status === "abandoned");

  return (
    <section className={styles.panel} aria-label="Inquiry">
      <div className={styles.heading}>
        <div>
          <h2>Inquiry</h2>
          <p className={styles.meta}>What is being tried and what stands in the way.</p>
        </div>
      </div>
      {records.kind === "loading" ? (
        <p className={styles.status} aria-live="polite">
          Loading inquiry records…
        </p>
      ) : null}
      {records.kind === "failed" ? (
        <p className={styles.error} aria-live="polite">
          Inquiry records unavailable: {records.message}
        </p>
      ) : null}

      <dl className={styles.summary} data-testid="inquiry-summary">
        <SummaryRow label="Active objective" testId="inquiry-objective">
          {description?.objective === undefined ? (
            <span className={styles.empty}>
              None yet. Select a goal and find sufficient conditions, or select a hypothesis to
              investigate it.
            </span>
          ) : (
            <>
              <Sentence text={description.objective.text} />
              <small>
                {description.objective.necessity === "required" ? "Required" : "Elective"} ·{" "}
                {description.objective.status}
              </small>
            </>
          )}
        </SummaryRow>
        <SummaryRow label="Current attempt" testId="inquiry-attempt">
          {description?.attempt === undefined ? (
            <span className={styles.empty}>None yet.</span>
          ) : (
            <>
              <Sentence text={description.attempt.text} />
              <small>
                {description.attempt.proposedBy ? "Proposed this objective · " : ""}
                {description.attempt.status}
              </small>
              {description.sufficiency === undefined ? null : (
                <Sentence text={description.sufficiency} />
              )}
            </>
          )}
        </SummaryRow>
        <SummaryRow
          label={
            description?.blocker?.kind === "requirement" ? "Next requirement" : "Top obstruction"
          }
          testId="inquiry-blocker"
        >
          {description?.blocker === undefined ? (
            <span className={styles.empty}>None recorded.</span>
          ) : (
            <Sentence text={description.blocker.text} />
          )}
        </SummaryRow>
      </dl>

      {description !== undefined && description.later.length > 0 ? (
        <section className={styles.later} aria-label="Later interpretations">
          <h3>Later interpretations</h3>
          <p className={styles.meaning}>Recorded afterwards; not the reason for the action.</p>
          <ul>
            {description.later.map((entry) => (
              <li key={entry.id}>
                <Sentence text={entry.text} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={styles.constructions} aria-label="Unresolved constructions">
        <h3>
          Unresolved constructions <span>({open.length})</span>
        </h3>
        {open.length === 0 ? (
          <p className={styles.empty}>None. Select an existential goal to construct an object.</p>
        ) : (
          <ul className={styles.taskList}>
            {open.map((task) => (
              <li key={task.id}>
                <details data-testid="construction-entry">
                  <summary>
                    <strong>{task.displayName}</strong> · {task.status.replace("-", " ")} ·{" "}
                    {task.requirements.length} requirement
                    {task.requirements.length === 1 ? "" : "s"}
                  </summary>
                  <ConstructionTaskView
                    model={constructionTaskModel(task, allTasks)}
                    presentation={presentation}
                    view={view}
                  />
                </details>
              </li>
            ))}
          </ul>
        )}
        {closed.length === 0 ? null : (
          <details>
            <summary>Closed constructions ({closed.length})</summary>
            <ul className={styles.taskList}>
              {closed.map((task) => (
                <li key={task.id}>
                  <ConstructionTaskView
                    model={constructionTaskModel(task, allTasks)}
                    presentation={presentation}
                    view={view}
                  />
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <div className={styles.actions} role="group" aria-label="Inquiry actions">
        <strong className={styles.actionsHeading}>Choose a next step</strong>
        <ActionButton
          label="Use this"
          availability={useThis}
          busy={busy}
          onClick={() => {
            if (!useThis.ok) return;
            void record(
              "Use this",
              useThisEnvelope({
                commandId: inquiryCommandId("use-this"),
                nodeId: node.id,
                plan: useThis.value,
              }),
            );
          }}
        />
        <ActionButton
          label="Construct an object"
          availability={construct}
          busy={busy}
          onClick={() => {
            if (!construct.ok) return;
            void advance(
              "Construct an object",
              constructEnvelope({ nodeId: node.id, plan: construct.value }),
            );
          }}
        />
        <ActionButton
          label="Find sufficient conditions"
          availability={findConditions}
          busy={busy}
          onClick={() => {
            if (!findConditions.ok) return;
            void record(
              "Find sufficient conditions",
              findConditionsEnvelope({
                commandId: inquiryCommandId("find-conditions"),
                nodeId: node.id,
                plan: findConditions.value,
              }),
            );
          }}
        />
        <ActionButton
          label="Investigate this hypothesis"
          availability={investigate}
          busy={busy}
          onClick={() => {
            if (!investigate.ok) return;
            void record(
              "Investigate this hypothesis",
              investigateEnvelope({
                commandId: inquiryCommandId("investigate"),
                nodeId: node.id,
                plan: investigate.value,
              }),
            );
          }}
        />
        <ActionButton
          label="Try this method"
          availability={tryMethod}
          busy={busy}
          onClick={() => {
            if (!tryMethod.ok) return;
            void advance(
              "Try this method",
              tryMethodEnvelope({ nodeId: node.id, plan: tryMethod.value }),
            );
          }}
        />
      </div>
      {feedback === undefined ? null : (
        <p
          className={feedback.state === "rejected" ? styles.error : styles.status}
          {...(feedback.state === "rejected"
            ? { role: "alert" }
            : { "aria-live": "polite" as const })}
          data-testid="inquiry-feedback"
        >
          {feedback.text}
        </p>
      )}
    </section>
  );
}

function SummaryRow({
  label,
  testId,
  children,
}: Readonly<{ label: string; testId: string; children: React.ReactNode }>) {
  return (
    <div className={styles.row} data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A template sentence; its inline mathematics is typeset like the rest of the workspace. */
function Sentence({ text }: Readonly<{ text: string }>) {
  return (
    <p className={styles.sentence}>
      <NaturalLanguageText text={text} />
    </p>
  );
}

/** An action that stays visible when unavailable and says why. */
function ActionButton({
  label,
  availability,
  busy,
  onClick,
}: Readonly<{
  label: string;
  availability: Availability<unknown>;
  busy: boolean;
  onClick: () => void;
}>) {
  const reasonId = useId();
  return (
    <span className={styles.action}>
      <button
        type="button"
        className={styles.actionButton}
        disabled={busy || !availability.ok}
        {...(availability.ok ? {} : { "aria-describedby": reasonId })}
        onClick={onClick}
      >
        {label}
      </button>
      {availability.ok ? null : (
        <span id={reasonId} className={styles.reason}>
          {availability.reason}
        </span>
      )}
    </span>
  );
}
