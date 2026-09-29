"use client";

import type { Presentation } from "@proof/language";
import type { WorkspaceView } from "../proof-workspace";
import { StatementView } from "../proof-workspace/presentation";
import { evidenceText, type ConstructionTaskModel } from "./construction-view";
import styles from "./inquiry-panel.module.css";

export type ConstructionTaskViewProps = Readonly<{
  model: ConstructionTaskModel;
  presentation: Presentation;
  view: WorkspaceView;
}>;

/**
 * One construction task (refinement §5): what it must produce, where it may draw from, and its
 * requirements grouped by role. The three roles are always listed so that an empty role is
 * visibly empty; a heuristic requirement is labelled as neither an assumption nor an obligation.
 */
export function ConstructionTaskView({ model, presentation, view }: ConstructionTaskViewProps) {
  const { task } = model;
  const declarations = task.scope.declarations;
  return (
    <article
      className={styles.task}
      aria-label={`Construction of ${task.displayName}`}
      data-testid="construction-task"
      data-task-id={task.id}
      data-status={task.status}
    >
      <header className={styles.taskHeader}>
        <h4>
          {task.displayName} <small>{model.sort}</small>
        </h4>
        <span className={styles.badge} data-status={task.status}>
          {model.statusLabel}
        </span>
      </header>
      <dl className={styles.facts}>
        <dt>Origin</dt>
        <dd>{model.origin.text}</dd>
        <dt>Scope</dt>
        <dd>
          {model.scope.length === 0
            ? "no declarations"
            : model.scope.map(({ symbol, sort }) => `${symbol}: ${sort}`).join("; ")}
        </dd>
        <dt>May depend on</dt>
        <dd data-testid="construction-dependencies">
          {model.dependencies.declarations.length === 0 && model.dependencies.tasks.length === 0
            ? "nothing: a closed choice"
            : [
                ...model.dependencies.declarations,
                ...model.dependencies.tasks.map(
                  ({ id, displayName }) => `${displayName ?? "task"} (${id})`,
                ),
              ].join(", ")}
        </dd>
      </dl>
      {model.roles.map((group) => (
        <section
          key={group.role}
          className={styles.roleGroup}
          data-role={group.role}
          aria-label={`${group.label} requirements`}
        >
          <h5>
            {group.label} <span>({group.requirements.length})</span>
          </h5>
          <p className={styles.meaning}>{group.meaning}</p>
          {group.requirements.length === 0 ? (
            <p className={styles.empty}>None recorded.</p>
          ) : (
            <ul className={styles.requirements}>
              {group.requirements.map((requirement) => {
                const evidence = evidenceText(requirement);
                return (
                  <li key={requirement.id} data-requirement-id={requirement.id}>
                    <StatementView
                      expression={requirement.statement.expression}
                      declarations={declarations}
                      presentation={presentation}
                      view={view}
                    />
                    <small>
                      Evidence: {evidence.text}. Attempt {requirement.attemptId}.
                    </small>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
      <section className={styles.roleGroup} aria-label="Candidates">
        <h5>
          Candidates <span>({model.candidates.length})</span>
        </h5>
        {model.candidates.length === 0 ? (
          <p className={styles.empty}>None recorded.</p>
        ) : (
          <ul className={styles.requirements}>
            {model.candidates.map((candidate) => (
              <li key={candidate.id} data-candidate-id={candidate.id}>
                <StatementView
                  expression={candidate.value}
                  declarations={declarations}
                  presentation={presentation}
                  view={view}
                />
                <small>Attempt {candidate.attemptId}.</small>
              </li>
            ))}
          </ul>
        )}
      </section>
      {model.outcome === undefined ? null : <p className={styles.meaning}>{model.outcome}</p>}
    </article>
  );
}
