import type { MovePreview } from "@proof/protocol";
import type { Presentation } from "@proof/language";
import type { WorkspaceView } from "../proof-workspace";
import { StatementView } from "../proof-workspace/presentation";
import { MenuItemLabel } from "./parameter-menu";
import {
  previewDiff,
  transitionEvidenceOf,
  type PreviewTarget,
  type StatementChange,
} from "./preview-diff";
import { EvidenceBadge, TransitionClassBadge, transitionMeaning } from "./suggestion-badges";
import styles from "./suggestion-panel.module.css";

type ViewProps = Readonly<{ presentation: Presentation; view: WorkspaceView }>;

/**
 * A recorded move preview as a before → after difference of statements, rendered in the
 * selected LaTeX or natural-language view. It reads only the stored preview snapshots.
 */
export function PreviewDetails({
  preview,
  presentation,
  view,
}: ViewProps & Readonly<{ preview: MovePreview }>) {
  const diff = previewDiff(preview);
  const isNewObligation = (
    change: StatementChange,
  ): change is Extract<StatementChange, { kind: "added" }> =>
    change.kind === "added" && change.collection === "obligation";
  const newObligations = diff.changes.filter(isNewObligation);
  const otherChanges = diff.changes.filter((change) => !isNewObligation(change));
  const chosen = preview.menuSelection === undefined ? [] : chosenItems(preview.menuSelection);
  return (
    <section className={styles.previewPanel} aria-label="Move preview">
      <div className={styles.previewHeading}>
        <strong>Review the changes before applying</strong>
        <span className={styles.badgeRow}>
          <TransitionClassBadge transitionClass={preview.transitionClass} />
          <EvidenceBadge evidence={transitionEvidenceOf(preview.operation)} />
        </span>
      </div>
      <p className={styles.previewMeaning}>{transitionMeaning(preview.transitionClass)}</p>
      <dl className={styles.previewCounts}>
        <div>
          <dt>Goals</dt>
          <dd>{deltaText(preview.delta.goals)}</dd>
        </div>
        <div>
          <dt>Obligations</dt>
          <dd>{deltaText(preview.delta.obligations)}</dd>
        </div>
      </dl>
      {chosen.length > 0 ? (
        <div>
          <strong>Chosen inputs</strong>
          <ul aria-label="Chosen inputs">
            {chosen.map(({ label, item }) => (
              <li key={item.id} data-menu-item-id={item.id}>
                {label}: <MenuItemLabel item={item} presentation={presentation} view={view} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <strong>State changes</strong>
        {otherChanges.length === 0 ? (
          <p>No goal or obligation changes besides new obligations.</p>
        ) : (
          <ul className={styles.changeList} aria-label="State changes">
            {otherChanges.map((change) => (
              <ChangeItem
                key={`${change.kind}:${targetOf(change).id}`}
                change={change}
                presentation={presentation}
                view={view}
              />
            ))}
          </ul>
        )}
      </div>
      <div>
        <strong>New obligations</strong>
        {newObligations.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul className={styles.changeList} aria-label="New obligations">
            {newObligations.map((change) => (
              <ChangeItem
                key={change.after.id}
                change={change}
                presentation={presentation}
                view={view}
              />
            ))}
          </ul>
        )}
      </div>
      {diff.assumptionsAdded.length > 0 ? (
        <div>
          <strong>New additional assumptions</strong>
          <ul className={styles.changeList} aria-label="New additional assumptions">
            {diff.assumptionsAdded.map((assumption) => (
              <li key={assumption.id} data-change="assumption-added">
                <span className={styles.changeMarker}>
                  <span aria-hidden="true">⊘ </span>Assumed (sorry)
                </span>
                <StatementView
                  expression={assumption.statement.expression}
                  declarations={assumption.declarations}
                  presentation={presentation}
                  view={view}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ChangeItem({
  change,
  presentation,
  view,
}: ViewProps & Readonly<{ change: StatementChange }>) {
  const noun = change.collection === "goal" ? "Goal" : "Obligation";
  if (change.kind === "removed") {
    return (
      <li data-change="removed" data-collection={change.collection}>
        <span className={styles.changeMarker}>
          <span aria-hidden="true">− </span>
          {noun} closed
        </span>
        <TargetStatement target={change.before} presentation={presentation} view={view} />
      </li>
    );
  }
  if (change.kind === "added") {
    return (
      <li data-change="added" data-collection={change.collection}>
        <span className={styles.changeMarker}>
          <span aria-hidden="true">+ </span>
          {noun} added
          {change.collection === "obligation" ? provenanceText(change.after) : null}
        </span>
        <TargetStatement target={change.after} presentation={presentation} view={view} />
        <HypothesisList
          label="with hypotheses"
          hypotheses={change.after.sequent.context.hypotheses}
          declarations={change.after.sequent.context.declarations}
          presentation={presentation}
          view={view}
        />
      </li>
    );
  }
  return (
    <li data-change="updated" data-collection={change.collection}>
      <span className={styles.changeMarker}>
        <span aria-hidden="true">~ </span>
        {noun} changed
      </span>
      {change.conclusionChanged ? (
        <span className={styles.beforeAfter}>
          <span data-side="before">
            <span className={styles.sideLabel}>Before</span>
            <TargetStatement target={change.before} presentation={presentation} view={view} />
          </span>
          <span aria-hidden="true">→</span>
          <span data-side="after">
            <span className={styles.sideLabel}>After</span>
            <TargetStatement target={change.after} presentation={presentation} view={view} />
          </span>
        </span>
      ) : (
        <TargetStatement target={change.after} presentation={presentation} view={view} />
      )}
      <HypothesisList
        label="Hypotheses removed"
        hypotheses={change.hypothesesRemoved}
        declarations={change.before.sequent.context.declarations}
        presentation={presentation}
        view={view}
      />
      <HypothesisList
        label="Hypotheses added"
        hypotheses={change.hypothesesAdded}
        declarations={change.after.sequent.context.declarations}
        presentation={presentation}
        view={view}
      />
    </li>
  );
}

function TargetStatement({
  target,
  presentation,
  view,
}: ViewProps & Readonly<{ target: PreviewTarget }>) {
  return (
    <StatementView
      expression={target.sequent.conclusion.expression}
      declarations={target.sequent.context.declarations}
      presentation={presentation}
      view={view}
    />
  );
}

function HypothesisList({
  label,
  hypotheses,
  declarations,
  presentation,
  view,
}: ViewProps &
  Readonly<{
    label: string;
    hypotheses: readonly PreviewTarget["sequent"]["context"]["hypotheses"][number][];
    declarations: PreviewTarget["sequent"]["context"]["declarations"];
  }>) {
  if (hypotheses.length === 0) return null;
  return (
    <span className={styles.hypothesisChanges}>
      <span className={styles.sideLabel}>{label}</span>
      <ul aria-label={label}>
        {hypotheses.map((hypothesis) => (
          <li key={hypothesis.id}>
            <StatementView
              expression={hypothesis.statement.expression}
              declarations={declarations}
              presentation={presentation}
              view={view}
            />
          </li>
        ))}
      </ul>
    </span>
  );
}

function provenanceText(target: PreviewTarget): string | null {
  if (!("provenance" in target) || target.provenance === undefined) return null;
  const provenance = target.provenance;
  switch (provenance.kind) {
    case "premise-of-result":
      return ` · premise of ${provenance.resultId}`;
    case "side-condition":
      return ` · side condition of ${provenance.resultId}`;
    case "construction-requirement":
      return ` · construction requirement`;
    default:
      return ` · ${provenance.kind}`;
  }
}

function targetOf(change: StatementChange): PreviewTarget {
  return change.kind === "added" ? change.after : change.before;
}

function chosenItems(selection: NonNullable<MovePreview["menuSelection"]>) {
  return Object.entries(selection.choices).flatMap(([parameterId, itemId]) => {
    const menu = selection.menus.find((candidate) => candidate.parameterId === parameterId);
    const item = menu?.items.find(({ id }) => id === itemId);
    return menu === undefined || item === undefined ? [] : [{ label: menu.label, item }];
  });
}

function deltaText(delta: MovePreview["delta"]["goals"]): string {
  return `+${delta.added.length} −${delta.removed.length} ~${delta.updated.length}`;
}
