"use client";

import { useEffect, useId, useReducer, useRef } from "react";
import { createProofNodeSchema, type OperatorDeclaration, type ProofNode } from "@proof/protocol";
import {
  formatOperandPath,
  resolveProofSelection,
  type AnchoredProofSelection,
  type ResolveProofSelectionResult,
  type StatementAnchor,
} from "@proof/selections";
import type { PlainMathJson } from "@proof/mathjson-model";
import type { Presentation } from "@proof/language";
import {
  MathLiveStatement,
  type MathLiveStatementGesture,
  type SelectionPolarity,
} from "./mathlive-statement";
import { NaturalLanguageText, usePresentation, type WorkspaceView } from "./presentation";
import {
  EMPTY_SELECTION_GESTURE_STATE,
  describeSelectionFeedback,
  proofSelectionKey,
  selectionGestureReducer,
} from "./selection-state";
import { DragHandle } from "../gestures/gesture-ui";
import type { GestureBindings, SelectionRequest } from "../gestures/use-drag-gestures";
import styles from "./proof-workspace.module.css";

const EMPTY_OPERATORS: readonly OperatorDeclaration[] = Object.freeze([]);

export type ProofWorkspaceProps = Readonly<{
  node: unknown;
  operators?: readonly OperatorDeclaration[];
  /** Formal view keeps interactive MathLive fields; natural language is read-only. */
  view?: WorkspaceView;
  onSelectionChange?: (selections: readonly AnchoredProofSelection[]) => void;
  /** Drag-and-drop surface (design plan §8.3); absent means the statements are not drag-aware. */
  gestures?: GestureBindings;
  /** Makes exactly these selections active when its `id` changes (a drop's source and target). */
  selectionRequest?: SelectionRequest | undefined;
}>;

/** Render a ProofNode only after validating its complete runtime boundary. */
export function ProofWorkspace({
  node: nodeInput,
  operators = EMPTY_OPERATORS,
  view = "formal",
  onSelectionChange,
  gestures,
  selectionRequest,
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
      view={view}
      onSelectionChange={onSelectionChange}
      gestures={gestures}
      selectionRequest={selectionRequest}
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
  view: WorkspaceView;
  onSelectionChange?: ((selections: readonly AnchoredProofSelection[]) => void) | undefined;
  gestures?: GestureBindings | undefined;
  selectionRequest?: SelectionRequest | undefined;
}>;

const INITIAL_SELECTION_NOTICE =
  "Click a goal or hypothesis to see relevant results and methods. Ctrl/Cmd-click adds another selection; Escape clears.";

function ValidatedProofWorkspace({
  node,
  operators,
  view,
  onSelectionChange,
  gestures,
  selectionRequest,
}: ValidatedProofWorkspaceProps) {
  const [selectionState, dispatch] = useReducer(
    selectionGestureReducer,
    EMPTY_SELECTION_GESTURE_STATE,
  );
  const presentation = usePresentation(operators);
  const selectionHeadingId = useId();
  const onSelectionChangeRef = useRef(onSelectionChange);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  useEffect(() => {
    onSelectionChangeRef.current?.(selectionState.active);
  }, [selectionState.active]);

  // A request already present when this snapshot mounts was handled for an earlier snapshot.
  const handledRequestId = useRef(selectionRequest?.id);
  useEffect(() => {
    if (selectionRequest === undefined || selectionRequest.id === handledRequestId.current) return;
    handledRequestId.current = selectionRequest.id;
    dispatch({ type: "set", selections: selectionRequest.selections });
  }, [selectionRequest]);

  const hasSelection = selectionState.active.length > 0;
  useEffect(() => {
    if (!hasSelection) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      dispatch({ type: "clear" });
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [hasSelection]);

  const handleGesture = (gesture: MathLiveStatementGesture) => {
    dispatch({
      type: "select",
      selection: gesture.selection,
      modifier: gesture.modifier,
      repeatable: gesture.repeatable,
      ...(gesture.fallbackReason === undefined ? {} : { fallbackReason: gesture.fallbackReason }),
    });
  };

  const resolvedSelections = selectionState.active.map((selection) => ({
    selection,
    resolved: resolveProofSelection(node.state, selection, { operators }),
  }));
  const selectedAnchors = new Map<string, SelectionPolarity | undefined>();
  for (const { selection, resolved } of resolvedSelections) {
    const key = JSON.stringify(selection.anchor);
    const polarity = resolved.ok ? resolved.selection.position.polarity : undefined;
    const existing = selectedAnchors.get(key);
    // Several selections in one statement with different polarities read as mixed.
    selectedAnchors.set(
      key,
      selectedAnchors.has(key) && existing !== polarity ? "mixed" : polarity,
    );
  }
  const selectionNotice =
    selectionState.feedback === undefined
      ? view === "formal"
        ? INITIAL_SELECTION_NOTICE
        : "Switch to the formal view to select goals and hypotheses."
      : describeSelectionFeedback(selectionState.feedback);
  const statementEnvironment: StatementEnvironment = {
    view,
    presentation,
    selectedAnchors,
    onGesture: handleGesture,
    gestures: view === "formal" ? gestures : undefined,
  };

  return (
    <section className={styles.workspace} aria-label="Proof workspace">
      <header className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>Proof snapshot</p>
          <h2>Contextual sequents</h2>
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
          <FamilyLegend />
          {view === "natural-language" ? (
            <p className={styles.viewNote}>
              Natural-language view is read-only. Switch to the formal view to select occurrences.
            </p>
          ) : null}
          <TargetGroup
            kind="goal"
            targets={node.state.goals}
            stateId={node.state.id}
            environment={statementEnvironment}
          />
          <TargetGroup
            kind="obligation"
            targets={node.state.obligations}
            stateId={node.state.id}
            environment={statementEnvironment}
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
            <p className={styles.emptySelection}>Nothing selected yet.</p>
          ) : (
            <ol className={styles.selectionList}>
              {resolvedSelections.map(({ selection, resolved }) => (
                <SelectionSummary
                  key={proofSelectionKey(selection)}
                  resolved={resolved}
                  selection={selection}
                />
              ))}
            </ol>
          )}

          <button
            className={styles.clearButton}
            type="button"
            disabled={selectionState.active.length === 0}
            aria-keyshortcuts="Escape"
            onClick={() => dispatch({ type: "clear" })}
          >
            Clear selections <kbd aria-hidden="true">Esc</kbd>
          </button>
          <p
            className={styles.selectionNotice}
            aria-live="polite"
            aria-atomic="true"
            data-testid="selection-feedback"
            data-outcome={selectionState.feedback?.outcome}
          >
            {selectionNotice}
          </p>
        </aside>
      </div>
    </section>
  );
}

type Target = ProofNode["state"]["goals"][number];
type TargetKind = "goal" | "obligation";

type StatementEnvironment = Readonly<{
  view: WorkspaceView;
  presentation: Presentation;
  /** Selected statement anchors, keyed by serialized anchor, with their selection polarity. */
  selectedAnchors: ReadonlyMap<string, SelectionPolarity | undefined>;
  onGesture: (gesture: MathLiveStatementGesture) => void;
  gestures?: GestureBindings | undefined;
}>;

/**
 * Visual families (§17.1). Colour is always doubled by a glyph, a label, and a border style so
 * that no family is identified by colour alone.
 */
const FAMILIES = Object.freeze({
  variable: { glyph: "𝑥", label: "Variable" },
  hypothesis: { glyph: "⊢", label: "Hypothesis" },
  goal: { glyph: "◎", label: "Goal" },
  obligation: { glyph: "◇", label: "Obligation" },
} as const);

type Family = keyof typeof FAMILIES;

function FamilyGlyph({ family }: Readonly<{ family: Family }>) {
  return (
    <span className={styles.familyGlyph} data-family={family} aria-hidden="true">
      {FAMILIES[family].glyph}
    </span>
  );
}

function FamilyLegend() {
  return (
    <ul className={styles.familyLegend} aria-label="Colour key">
      {(Object.keys(FAMILIES) as Family[]).map((family) => (
        <li key={family} data-family={family}>
          <FamilyGlyph family={family} />
          {family === "obligation" ? "Obligation / assumption" : FAMILIES[family].label}
        </li>
      ))}
      <li data-polarity="positive">
        <span className={styles.bevelSample} data-polarity="positive" aria-hidden="true" />
        Positive (goal-like): inward bevel
      </li>
      <li data-polarity="negative">
        <span className={styles.bevelSample} data-polarity="negative" aria-hidden="true" />
        Negative (hypothesis-like): outward bevel
      </li>
    </ul>
  );
}

const POLARITY_LABELS: Readonly<Record<SelectionPolarity, string>> = Object.freeze({
  positive: "Positive position (goal-like)",
  negative: "Negative position (hypothesis-like)",
  mixed: "Mixed polarity",
  neutral: "Neutral (term) position",
});

type TargetGroupProps = Readonly<{
  kind: TargetKind;
  targets: readonly Target[];
  stateId: ProofNode["state"]["id"];
  environment: StatementEnvironment;
}>;

function TargetGroup({ kind, targets, stateId, environment }: TargetGroupProps) {
  const headingId = useId();
  const label = kind === "goal" ? "Goals" : "Obligations";
  return (
    <section className={styles.targetGroup} data-family={kind} aria-labelledby={headingId}>
      <div className={styles.groupHeading}>
        <h2 id={headingId}>
          <FamilyGlyph family={kind} /> {label}
        </h2>
        <span aria-label={`${targets.length} ${label.toLowerCase()}`}>{targets.length}</span>
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
            environment={environment}
          />
        ))
      )}
    </section>
  );
}

type ContextualSequentViewProps = Readonly<{
  kind: TargetKind;
  ordinal: number;
  stateId: ProofNode["state"]["id"];
  target: Target;
  environment: StatementEnvironment;
}>;

function ContextualSequentView({
  kind,
  ordinal,
  stateId,
  target,
  environment,
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
  const declarations = target.sequent.context.declarations;

  return (
    <article
      className={styles.sequent}
      data-family={kind}
      data-target-id={target.id}
      aria-labelledby={titleId}
    >
      <header className={styles.sequentHeader}>
        <div>
          <p className={styles.sequentKind}>
            <FamilyGlyph family={kind} /> {kind === "goal" ? "Goal" : "Obligation (assumption)"}
          </p>
          <h3 id={titleId}>
            {targetLabel} {ordinal}
          </h3>
        </div>
        <code>{target.id}</code>
      </header>

      <section
        className={styles.contextSection}
        data-family="variable"
        aria-labelledby={declarationsId}
      >
        <h4 id={declarationsId}>
          Declarations for {targetLabel.toLowerCase()} {ordinal}
        </h4>
        {declarations.length === 0 ? (
          <p className={styles.emptyContext}>No declarations in this sequent.</p>
        ) : (
          <ul className={styles.declarationList}>
            {declarations.map((declaration) => (
              <li
                key={declaration.id}
                data-family="variable"
                aria-label={`Variable ${declaration.symbol}: ${sortLabel(declaration.sort)}, ${declarationRoleLabel(declaration.role).toLowerCase()}`}
              >
                <FamilyGlyph family="variable" />
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

      <section
        className={styles.contextSection}
        data-family="hypothesis"
        aria-labelledby={hypothesesId}
      >
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
                <li key={hypothesis.id} data-family="hypothesis" data-polarity="negative">
                  <span
                    className={styles.statementLabel}
                    data-family="hypothesis"
                    title={`Hypothesis ${index + 1}`}
                  >
                    <span aria-hidden="true">H{index + 1}</span>
                    <span className="visually-hidden">Hypothesis {index + 1}</span>
                  </span>
                  <StatementView
                    anchor={anchor}
                    declarations={declarations}
                    expression={hypothesis.statement.expression}
                    label={`${targetLabel} ${ordinal} hypothesis ${index + 1}`}
                    handleLabel={`hypothesis ${index + 1} of ${targetLabel.toLowerCase()} ${ordinal}`}
                    environment={environment}
                  />
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section
        className={styles.conclusionSection}
        data-family={kind}
        data-polarity="positive"
        aria-labelledby={conclusionId}
      >
        <h4 id={conclusionId}>
          Conclusion for {targetLabel.toLowerCase()} {ordinal}
        </h4>
        <StatementView
          anchor={conclusionAnchor}
          declarations={declarations}
          expression={target.sequent.conclusion.expression}
          label={`${targetLabel} ${ordinal} conclusion`}
          environment={environment}
        />
      </section>
    </article>
  );
}

type StatementViewProps = Readonly<{
  anchor: StatementAnchor;
  declarations: Target["sequent"]["context"]["declarations"];
  expression: PlainMathJson;
  label: string;
  /** Names the statement's drag handle; it must not contain `label`, which finds the field. */
  handleLabel?: string;
  environment: StatementEnvironment;
}>;

/** One statement: an interactive MathLive field (formal) or read-only prose (natural language). */
function StatementView({
  anchor,
  declarations,
  expression,
  label,
  handleLabel,
  environment,
}: StatementViewProps) {
  const key = JSON.stringify(anchor);
  const selected = environment.selectedAnchors.has(key);
  const polarity = environment.selectedAnchors.get(key);
  const gestures = environment.gestures;
  return (
    <div className={styles.statement}>
      {environment.view === "natural-language" ? (
        <p
          className={styles.naturalLanguage}
          aria-label={label}
          data-selected={selected}
          data-selection-polarity={selected ? polarity : undefined}
        >
          <NaturalLanguageText
            text={environment.presentation.naturalLanguage(expression, { declarations })}
          />
        </p>
      ) : (
        <MathLiveStatement
          anchor={anchor}
          expression={expression}
          label={label}
          selected={selected}
          selectionPolarity={polarity}
          onGesture={environment.onGesture}
          dropZone={
            gestures?.carrying === undefined || !gestures.enabled
              ? undefined
              : {
                  onHover: gestures.hover,
                  onDrop: (occurrence) => gestures.dropOn(anchor, occurrence),
                }
          }
        />
      )}
      {gestures !== undefined && anchor.statement.kind === "hypothesis" ? (
        <DragHandle
          source={{
            kind: "hypothesis",
            selection: { kind: "exact", anchor, path: [] },
            label: handleLabel ?? label,
          }}
          label={handleLabel ?? label}
          bindings={gestures}
        />
      ) : null}
      {selected ? (
        <span className={styles.selectedBadge} data-polarity={polarity}>
          Selected{polarity === undefined ? "" : ` · ${POLARITY_LABELS[polarity]}`}
        </span>
      ) : null}
    </div>
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
  selection: AnchoredProofSelection;
  resolved: ResolveProofSelectionResult;
}>;

function SelectionSummary({ selection, resolved }: SelectionSummaryProps) {
  const path =
    selection.kind === "exact"
      ? formatOperandPath(selection.path)
      : `${formatOperandPath(selection.containerPath)} [${selection.startOperand}, ${
          selection.endOperand
        })`;
  const statement = selection.anchor.statement;
  const statementLabel =
    statement.kind === "conclusion" ? "conclusion" : `hypothesis ${statement.id}`;
  const polarity = resolved.ok ? resolved.selection.position.polarity : undefined;
  const family: Family =
    statement.kind === "hypothesis" ? "hypothesis" : selection.anchor.target.kind;

  return (
    <li
      data-selection-key={proofSelectionKey(selection)}
      data-family={family}
      data-polarity={polarity}
    >
      <p>
        <FamilyGlyph family={family} />
        <strong>
          {selection.anchor.target.kind} {selection.anchor.target.id}
        </strong>
        <span>{statementLabel}</span>
        {polarity === undefined ? null : <span>{POLARITY_LABELS[polarity]}</span>}
      </p>
      <code>{selection.kind === "exact" ? `path ${path}` : `lens ${path}`}</code>
      <pre>
        {resolved.ok ? JSON.stringify(resolved.selection.fragment) : "Unavailable occurrence"}
      </pre>
    </li>
  );
}

export { proofSelectionKey, selectionGestureReducer } from "./selection-state";
export type {
  SelectionGestureAction,
  SelectionGestureFeedback,
  SelectionGestureOutcome,
  SelectionGestureState,
} from "./selection-state";
export type { WorkspaceView } from "./presentation";
