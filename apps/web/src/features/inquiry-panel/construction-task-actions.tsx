"use client";

import { useId, useMemo, useState } from "react";
import type { Presentation } from "@proof/language";
import type { ParameterMenuItem } from "@proof/moves";
import type { ConstructionTask } from "@proof/mathjson-model";
import type { OperatorDeclaration, ProofNode, ProtocolCommandEnvelope } from "@proof/protocol";
import type { WorkspaceView } from "../proof-workspace";
import { StatementView } from "../proof-workspace/presentation";
import {
  constructionActionEnvelope,
  constructionOptions,
  requirementRoleText,
  type ConstructionActionKind,
} from "./construction-actions";
import styles from "./inquiry-panel.module.css";

export type ConstructionTaskActionsProps = Readonly<{
  node: ProofNode;
  operators: readonly OperatorDeclaration[];
  task: ConstructionTask;
  presentation: Presentation;
  view: WorkspaceView;
  busy: boolean;
  /** Send one envelope through the workspace's command path. */
  onSend: (action: string, envelope: ProtocolCommandEnvelope) => void;
}>;

type Form = "add-requirement" | "add-candidate" | "resolve-placeholder";

const CONFIRM: Readonly<Record<Form, string>> = {
  "add-requirement": "Record requirement",
  "add-candidate": "Record candidate",
  "resolve-placeholder": "Use this candidate",
};

const PROMPT: Readonly<Record<Form, string>> = {
  "add-requirement": "Choose a requirement to record",
  "add-candidate": "Choose a candidate to record",
  "resolve-placeholder": "Choose the candidate to use",
};

/**
 * The actions on one open construction: add a requirement, add a candidate, use a candidate, or
 * abandon it. Each is one construction move whose choices come from menus built from the stored
 * snapshot, so nothing is typed. An action that cannot apply stays visible and says why; a choice
 * opens in place only after the button is pressed, never as a modal.
 */
export function ConstructionTaskActions(props: ConstructionTaskActionsProps) {
  const { node, operators, task, presentation, view, busy, onSend } = props;
  const [form, setForm] = useState<Form>();
  const [itemId, setItemId] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const groupName = useId();

  const options = useMemo(
    () => ({
      "add-requirement": constructionOptions(node, operators, "add-requirement", task),
      "add-candidate": constructionOptions(node, operators, "add-candidate", task),
      "resolve-placeholder": constructionOptions(node, operators, "resolve-placeholder", task),
      "abandon-placeholder": constructionOptions(node, operators, "abandon-placeholder", task),
    }),
    [node, operators, task],
  );

  const send = (kind: ConstructionActionKind, label: string, chosen?: string) => {
    const envelope = constructionActionEnvelope({
      node,
      operators,
      kind,
      task,
      ...(chosen === undefined ? {} : { itemId: chosen }),
    });
    if (!envelope.ok) {
      setProblem(envelope.reason);
      return;
    }
    setProblem(undefined);
    setForm(undefined);
    setItemId(undefined);
    onSend(`${label} (${task.displayName})`, envelope.value);
  };

  const open = (next: Form) => {
    setProblem(undefined);
    setItemId(undefined);
    setForm(form === next ? undefined : next);
  };

  const declarations = task.scope.declarations;
  const formOptions = form === undefined ? undefined : options[form];
  return (
    <div
      className={styles.taskActions}
      role="group"
      aria-label={`Actions for ${task.displayName}`}
      data-testid="construction-actions"
    >
      <strong className={styles.actionsHeading}>What next for {task.displayName}?</strong>
      <TaskButton
        label="Add requirement"
        hint={`Note something ${task.displayName} must or should satisfy, taken from the proof state.`}
        availability={options["add-requirement"]}
        pressed={form === "add-requirement"}
        busy={busy}
        onClick={() => open("add-requirement")}
      />
      <TaskButton
        label="Add candidate"
        hint={`Offer a term ${task.displayName} could be.`}
        availability={options["add-candidate"]}
        pressed={form === "add-candidate"}
        busy={busy}
        onClick={() => open("add-candidate")}
      />
      <TaskButton
        label="Use this candidate"
        hint={`Replace ${task.displayName} by a candidate everywhere.`}
        availability={options["resolve-placeholder"]}
        pressed={form === "resolve-placeholder"}
        busy={busy}
        onClick={() => open("resolve-placeholder")}
      />
      <TaskButton
        label="Abandon"
        hint={`Give up on ${task.displayName}; the record is kept.`}
        availability={options["abandon-placeholder"]}
        pressed={false}
        busy={busy}
        onClick={() => send("abandon-placeholder", "Abandon")}
      />
      {form !== undefined && formOptions?.ok === true ? (
        <fieldset className={styles.choice} data-testid="construction-choice">
          <legend>{PROMPT[form]}</legend>
          {form === "resolve-placeholder" ? (
            <p className={styles.meaning}>
              The candidate is substituted for {task.displayName} in every goal and obligation. The
              proof state changes to match; it is not closed.
            </p>
          ) : null}
          <ul className={styles.choiceList}>
            {formOptions.items.map((item) => (
              <li key={item.id}>
                <label>
                  <input
                    type="radio"
                    name={groupName}
                    checked={itemId === item.id}
                    onChange={() => setItemId(item.id)}
                  />{" "}
                  <ItemView
                    item={item}
                    declarations={declarations}
                    presentation={presentation}
                    view={view}
                  />
                  {form === "add-requirement" ? (
                    <small className={styles.reason}>{requirementRoleText(item)}</small>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
          <div className={styles.choiceActions}>
            <button
              type="button"
              className={styles.actionButton}
              disabled={busy || itemId === undefined}
              onClick={() => send(form, CONFIRM[form].replace("Record ", "Add "), itemId)}
            >
              {CONFIRM[form]}
            </button>
            <button
              type="button"
              className={styles.actionButton}
              onClick={() => {
                setForm(undefined);
                setItemId(undefined);
              }}
            >
              Cancel
            </button>
            {itemId === undefined ? (
              <span className={styles.reason}>Choose one of the items above first.</span>
            ) : null}
          </div>
        </fieldset>
      ) : null}
      {problem === undefined ? null : (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

function ItemView({
  item,
  declarations,
  presentation,
  view,
}: Readonly<{
  item: ParameterMenuItem;
  declarations: ConstructionTask["scope"]["declarations"];
  presentation: Presentation;
  view: WorkspaceView;
}>) {
  const { label } = item;
  return label.kind === "math" ? (
    <StatementView
      expression={label.expression}
      declarations={declarations}
      presentation={presentation}
      view={view}
    />
  ) : (
    <span>{label.text}</span>
  );
}

function TaskButton({
  label,
  hint,
  availability,
  pressed,
  busy,
  onClick,
}: Readonly<{
  label: string;
  hint: string;
  availability: ReturnType<typeof constructionOptions>;
  pressed: boolean;
  busy: boolean;
  onClick: () => void;
}>) {
  const noteId = useId();
  return (
    <span className={styles.action}>
      <button
        type="button"
        className={styles.actionButton}
        disabled={busy || !availability.ok}
        aria-pressed={pressed}
        aria-describedby={noteId}
        onClick={onClick}
      >
        {label}
      </button>
      <span id={noteId} className={styles.reason}>
        {availability.ok ? hint : availability.reason}
      </span>
    </span>
  );
}
