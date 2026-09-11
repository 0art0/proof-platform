"use client";

import { useEffect, useId, useReducer, useRef, useState } from "react";
import { createProofNodeSchema, type OperatorDeclaration, type ProofNode } from "@proof/protocol";
import {
  formatOperandPath,
  resolveProofSelection,
  type AnchoredProofSelection,
  type StatementAnchor,
} from "@proof/selections";
import { MathLiveStatement, type MathLiveStatementGesture } from "./mathlive-statement";
import {
  EMPTY_SELECTION_GESTURE_STATE,
  proofSelectionKey,
  selectionGestureReducer,
} from "./selection-state";
import styles from "./proof-workspace.module.css";

const EMPTY_OPERATORS: readonly OperatorDeclaration[] = Object.freeze([]);

export type ProofWorkspaceProps = Readonly<{
  node: unknown;
  operators?: readonly OperatorDeclaration[];
  onSelectionChange?: (selections: readonly AnchoredProofSelection[]) => void;
}>;

/** Render a ProofNode only after validating its complete runtime boundary. */
export function ProofWorkspace({
  node: nodeInput,
  operators = EMPTY_OPERATORS,
  onSelectionChange,
}: ProofWorkspaceProps) {
  const node = parseProofNode(nodeInput, operators);
  if (node === undefined) {
    return <InvalidProofWorkspace onSelectionChange={onSelectionChange} />;
  }

  // A structural key also clears selection when content changes under reused IDs.
  return (
    <ValidatedProofWorkspace
      key={JSON.stringify(node)}
      node={node}
      operators={operators}
      onSelectionChange={onSelectionChange}
    />
  );
}

function InvalidProofWorkspace({
  onSelectionChange,
}: Readonly<{
  onSelectionChange?: ((selections: readonly AnchoredProofSelection[]) => void) | undefined;
}>) {
  const onSelectionChangeRef = useRef(onSelectionChange);

  useEffect(() => {
    onSelectionChangeRef.current?.([]);
  }, []);

  return (
    <section className={styles.invalidWorkspace} role="alert">
      This proof workspace cannot render because its ProofNode snapshot is invalid.
    </section>
  );
}

function parseProofNode(
  input: unknown,
  operators: readonly OperatorDeclaration[],
): ProofNode | undefined {
  try {
    const parsed = createProofNodeSchema({ operators }).safeParse(input);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

type ValidatedProofWorkspaceProps = Readonly<{
  node: ProofNode;
  operators: readonly OperatorDeclaration[];
  onSelectionChange?: ((selections: readonly AnchoredProofSelection[]) => void) | undefined;
}>;

function ValidatedProofWorkspace({
  node,
  operators,
  onSelectionChange,
}: ValidatedProofWorkspaceProps) {
  const [selectionState, dispatch] = useReducer(
    selectionGestureReducer,
    EMPTY_SELECTION_GESTURE_STATE,
  );
  const [selectionNotice, setSelectionNotice] = useState(
    "Select a hypothesis or conclusion. Ctrl/Cmd-click adds an independent occurrence.",
  );
  const selectionHeadingId = useId();
  const onSelectionChangeRef = useRef(onSelectionChange);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    onSelectionChangeRef.current?.(selectionState.active);
  }, [selectionState.active]);

  const handleGesture = (gesture: MathLiveStatementGesture) => {
    dispatch({ type: "select", selection: gesture.selection, modifier: gesture.modifier });
    setSelectionNotice(
      gesture.fallbackReason ??
        (gesture.modifier
          ? "The occurrence was added to or removed from the active selection set."
          : "The occurrence replaced the active set; repeat the click to expand."),
    );
  };

  const selectedAnchors = new Set(
    selectionState.active.map((selection) => JSON.stringify(selection.anchor)),
  );

  return (
    <section className={styles.workspace} aria-label="Proof workspace">
      <header className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>Proof snapshot</p>
          <h1>Contextual sequents</h1>
        </div>
        <dl className={styles.snapshotFacts}>
          <div>
            <dt>Node</dt>
            <dd>{node.id}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{node.state.id}</dd>
          </div>
        </dl>
      </header>

      <div className={styles.workspaceBody}>
        <div className={styles.sequentColumn}>
          <TargetGroup
            kind="goal"
            targets={node.state.goals}
            stateId={node.state.id}
            selectedAnchors={selectedAnchors}
            onGesture={handleGesture}
          />
          <TargetGroup
            kind="obligation"
            targets={node.state.obligations}
            stateId={node.state.id}
            selectedAnchors={selectedAnchors}
            onGesture={handleGesture}
          />
        </div>

        <aside className={styles.selectionPanel} aria-labelledby={selectionHeadingId}>
          <div className={styles.selectionHeading}>
            <div>
              <p className={styles.eyebrow}>Gesture state</p>
              <h2 id={selectionHeadingId}>Active selections</h2>
            </div>
            <span className={styles.selectionCount}>{selectionState.active.length}</span>
          </div>

          {selectionState.active.length === 0 ? (
            <p className={styles.emptySelection}>No active occurrence.</p>
          ) : (
            <ol className={styles.selectionList}>
              {selectionState.active.map((selection) => (
                <SelectionSummary
                  key={proofSelectionKey(selection)}
                  node={node}
                  operators={operators}
                  selection={selection}
                />
              ))}
            </ol>
          )}

          <button
            className={styles.clearButton}
            type="button"
            disabled={selectionState.active.length === 0}
            onClick={() => {
              dispatch({ type: "clear" });
              setSelectionNotice("The active selection set was cleared.");
            }}
          >
            Clear selections
          </button>
          <p className={styles.selectionNotice} aria-live="polite">
            {selectionNotice}
          </p>
        </aside>
      </div>
    </section>
  );
}

type Target = ProofNode["state"]["goals"][number];

type TargetGroupProps = Readonly<{
  kind: "goal" | "obligation";
  targets: readonly Target[];
  stateId: ProofNode["state"]["id"];
  selectedAnchors: ReadonlySet<string>;
  onGesture: (gesture: MathLiveStatementGesture) => void;
}>;

function TargetGroup({ kind, targets, stateId, selectedAnchors, onGesture }: TargetGroupProps) {
  const headingId = useId();
  const label = kind === "goal" ? "Goals" : "Obligations";
  return (
    <section className={styles.targetGroup} aria-labelledby={headingId}>
      <div className={styles.groupHeading}>
        <h2 id={headingId}>{label}</h2>
        <span>{targets.length}</span>
      </div>
      {targets.length === 0 ? (
        <p className={styles.emptyGroup}>No {label.toLowerCase()} in this snapshot.</p>
      ) : (
        targets.map((target, index) => (
          <ContextualSequentView
            key={target.id}
            kind={kind}
            ordinal={index + 1}
            stateId={stateId}
            target={target}
            selectedAnchors={selectedAnchors}
            onGesture={onGesture}
          />
        ))
      )}
    </section>
  );
}

type ContextualSequentViewProps = Readonly<{
  kind: "goal" | "obligation";
  ordinal: number;
  stateId: ProofNode["state"]["id"];
  target: Target;
  selectedAnchors: ReadonlySet<string>;
  onGesture: (gesture: MathLiveStatementGesture) => void;
}>;

function ContextualSequentView({
  kind,
  ordinal,
  stateId,
  target,
  selectedAnchors,
  onGesture,
}: ContextualSequentViewProps) {
  const titleId = useId();
  const declarationsId = useId();
  const hypothesesId = useId();
  const conclusionId = useId();
  const targetLabel = kind === "goal" ? "Goal" : "Obligation";
  const targetAnchor = { kind, id: target.id } as const;
  const conclusionAnchor: StatementAnchor = {
    stateId,
    target: targetAnchor,
    statement: { kind: "conclusion" },
  };

  return (
    <article className={styles.sequent} data-target-id={target.id} aria-labelledby={titleId}>
      <header className={styles.sequentHeader}>
        <div>
          <p className={styles.sequentKind}>{targetLabel}</p>
          <h3 id={titleId}>
            {targetLabel} {ordinal}
          </h3>
        </div>
        <code>{target.id}</code>
      </header>

      <section className={styles.contextSection} aria-labelledby={declarationsId}>
        <h4 id={declarationsId}>
          Declarations for {targetLabel.toLowerCase()} {ordinal}
        </h4>
        {target.sequent.context.declarations.length === 0 ? (
          <p className={styles.emptyContext}>No declarations in this sequent.</p>
        ) : (
          <ul className={styles.declarationList}>
            {target.sequent.context.declarations.map((declaration) => (
              <li key={declaration.id}>
                <span aria-hidden="true" className={styles.declarationMark} />
                <span>
                  <strong>{declaration.symbol}</strong>
                  <small>{declarationRoleLabel(declaration.role)}</small>
                </span>
                <code>{sortLabel(declaration.sort)}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.contextSection} aria-labelledby={hypothesesId}>
        <h4 id={hypothesesId}>
          Hypotheses for {targetLabel.toLowerCase()} {ordinal}
        </h4>
        {target.sequent.context.hypotheses.length === 0 ? (
          <p className={styles.emptyContext}>No hypotheses in this sequent.</p>
        ) : (
          <ol className={styles.statementList}>
            {target.sequent.context.hypotheses.map((hypothesis, index) => {
              const anchor: StatementAnchor = {
                stateId,
                target: targetAnchor,
                statement: { kind: "hypothesis", id: hypothesis.id },
              };
              return (
                <li key={hypothesis.id}>
                  <span className={styles.statementLabel}>H{index + 1}</span>
                  <MathLiveStatement
                    anchor={anchor}
                    expression={hypothesis.statement.expression}
                    label={`${targetLabel} ${ordinal} hypothesis ${index + 1}`}
                    selected={selectedAnchors.has(JSON.stringify(anchor))}
                    onGesture={onGesture}
                  />
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className={styles.conclusionSection} aria-labelledby={conclusionId}>
        <h4 id={conclusionId}>
          Conclusion for {targetLabel.toLowerCase()} {ordinal}
        </h4>
        <MathLiveStatement
          anchor={conclusionAnchor}
          expression={target.sequent.conclusion.expression}
          label={`${targetLabel} ${ordinal} conclusion`}
          selected={selectedAnchors.has(JSON.stringify(conclusionAnchor))}
          onGesture={onGesture}
        />
      </section>
    </article>
  );
}

function declarationRoleLabel(
  role: Target["sequent"]["context"]["declarations"][number]["role"],
): string {
  if (role === "universal-parameter") return "Universal parameter";
  if (role === "local-witness") return "Local witness";
  return "Resolved construction";
}

function sortLabel(sort: Target["sequent"]["context"]["declarations"][number]["sort"]): string {
  if (sort.kind === "proposition") return "proposition";
  if (sort.kind === "named") {
    const sortArguments = sort.arguments?.map(sortLabel).join(", ");
    return sortArguments ? `${sort.id}<${sortArguments}>` : sort.id;
  }
  return `(${sort.signature.parameters.map(sortLabel).join(", ")}) → ${sortLabel(
    sort.signature.result,
  )}`;
}

type SelectionSummaryProps = Readonly<{
  node: ProofNode;
  operators: readonly OperatorDeclaration[];
  selection: AnchoredProofSelection;
}>;

function SelectionSummary({ node, operators, selection }: SelectionSummaryProps) {
  const resolved = resolveProofSelection(node.state, selection, { operators });
  const path =
    selection.kind === "exact"
      ? formatOperandPath(selection.path)
      : `${formatOperandPath(selection.containerPath)} [${selection.startOperand}, ${
          selection.endOperand
        })`;
  const statement = selection.anchor.statement;
  const statementLabel =
    statement.kind === "conclusion" ? "conclusion" : `hypothesis ${statement.id}`;

  return (
    <li data-selection-key={proofSelectionKey(selection)}>
      <p>
        <strong>
          {selection.anchor.target.kind} {selection.anchor.target.id}
        </strong>
        <span>{statementLabel}</span>
      </p>
      <code>{selection.kind === "exact" ? `path ${path}` : `lens ${path}`}</code>
      <pre>
        {resolved.ok ? JSON.stringify(resolved.selection.fragment) : "Unavailable occurrence"}
      </pre>
    </li>
  );
}

export { proofSelectionKey, selectionGestureReducer } from "./selection-state";
export type { SelectionGestureAction, SelectionGestureState } from "./selection-state";
