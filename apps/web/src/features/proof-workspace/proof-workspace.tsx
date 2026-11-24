"use client";

import { useEffect, useId, useMemo, useReducer, useRef } from "react";
import {
  createProofNodeSchema,
  PROBLEM_SETUP_SORT_CHOICES,
  type OperatorDeclaration,
  type ProofNode,
} from "@proof/protocol";
import {
  governingProposition,
  resolveProofSelection,
  type AnchoredProofSelection,
  type ResolveProofSelectionResult,
  type StatementAnchor,
} from "@proof/selections";
import { canonicalJson, canonicalJsonEquals, type PlainMathJson } from "@proof/mathjson-model";
import type { Presentation } from "@proof/language";
import {
  MathLiveStatement,
  POLARITY_LABELS,
  type MathLiveStatementGesture,
  type SelectionPolarity,
} from "./mathlive-statement";
import {
  NaturalLanguageText,
  StatementView as PresentedStatement,
  usePresentation,
  type WorkspaceView,
} from "./presentation";
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
  /** A link shown in the Active selections card once something is selected; following it focuses the suggestions panel. */
  suggestionsLink?: SuggestionsLink | undefined;
}>;

export type SuggestionsLink = Readonly<{ href: string; text: string }>;

/** Render a ProofNode only after validating its complete runtime boundary. */
export function ProofWorkspace({
  node: nodeInput,
  operators = EMPTY_OPERATORS,
  view = "formal",
  onSelectionChange,
  gestures,
  selectionRequest,
  suggestionsLink,
}: ProofWorkspaceProps) {
  const node = useMemo(() => parseProofNode(nodeInput, operators), [nodeInput, operators]);
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
      suggestionsLink={suggestionsLink}
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
  suggestionsLink?: SuggestionsLink | undefined;
}>;

const INITIAL_SELECTION_NOTICE =
  "Select a statement by its label or click part of a formula. Ctrl/Cmd-click adds another selection.";

function ValidatedProofWorkspace({
  node,
  operators,
  view,
  onSelectionChange,
  gestures,
  selectionRequest,
  suggestionsLink,
}: ValidatedProofWorkspaceProps) {
  const [selectionState, dispatch] = useReducer(
    selectionGestureReducer,
    EMPTY_SELECTION_GESTURE_STATE,
  );
  const presentation = usePresentation(operators, node.state);
  const selectionHeadingId = useId();
  const onSelectionChangeRef = useRef(onSelectionChange);
  const workspaceRef = useRef<HTMLElement>(null);

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
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        workspaceRef.current?.closest("[inert]")
      )
        return;
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
  const selectedStatements = new Set<string>();
  for (const { selection, resolved } of resolvedSelections) {
    const key = canonicalJson(selection.anchor);
    if (selection.kind === "exact" && selection.path.length === 0) selectedStatements.add(key);
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
        : "Select a statement by its label. Switch to LaTeX to select part of a formula."
      : describeSelectionFeedback(selectionState.feedback);
  const statementEnvironment: StatementEnvironment = {
    view,
    presentation,
    operators,
    selectedAnchors,
    selectedStatements,
    onGesture: handleGesture,
    gestures: view === "formal" ? gestures : undefined,
  };

  return (
    <section ref={workspaceRef} className={styles.workspace} aria-label="Proof workspace">
      <div className={styles.workspaceBody}>
        <div className={styles.sequentColumn}>
          <TargetGroup
            kind="goal"
            targets={node.state.goals}
            stateId={node.state.id}
            environment={statementEnvironment}
          />
          {node.state.obligations.length > 0 ? (
            <TargetGroup
              kind="obligation"
              targets={node.state.obligations}
              stateId={node.state.id}
              environment={statementEnvironment}
            />
          ) : null}
        </div>

        <aside className={styles.selectionPanel} aria-labelledby={selectionHeadingId}>
          <h2 className="visually-hidden" id={selectionHeadingId}>
            Active selections
          </h2>
          {hasSelection ? (
            <>
              <ol className={styles.selectionList}>
                {resolvedSelections.map(({ selection, resolved }) => (
                  <SelectionSummary
                    key={proofSelectionKey(selection)}
                    resolved={resolved}
                    selection={selection}
                    presentation={presentation}
                    view={view}
                  />
                ))}
              </ol>
              <div className={styles.selectionActions}>
                {suggestionsLink === undefined ? null : (
                  <a className={styles.suggestionsLink} href={suggestionsLink.href}>
                    {suggestionsLink.text}
                  </a>
                )}
                <button
                  className={styles.clearButton}
                  type="button"
                  aria-keyshortcuts="Escape"
                  onClick={() => dispatch({ type: "clear" })}
                >
                  Clear selections <kbd aria-hidden="true">Esc</kbd>
                </button>
              </div>
            </>
          ) : null}
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
      <div className={styles.proofDetails}>
        <details className={styles.legendDetails}>
          <summary>Colour and symbol key</summary>
          <FamilyLegend />
        </details>
        <details className={styles.legendDetails}>
          <summary>Snapshot IDs</summary>
          <dl className={styles.snapshotFacts}>
            <div>
              <dt>Node</dt>
              <dd className={styles.snapshotFact}>{node.id}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd className={styles.snapshotFact}>{node.state.id}</dd>
            </div>
          </dl>
        </details>
      </div>
    </section>
  );
}

type Target = ProofNode["state"]["goals"][number];
type TargetKind = "goal" | "obligation";

type StatementEnvironment = Readonly<{
  view: WorkspaceView;
  presentation: Presentation;
  operators: readonly OperatorDeclaration[];
  /** Selected statement anchors, keyed by serialized anchor, with their selection polarity. */
  selectedAnchors: ReadonlyMap<string, SelectionPolarity | undefined>;
  selectedStatements: ReadonlySet<string>;
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
      <li>Hover over part of a statement to see its position.</li>
    </ul>
  );
}

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
        <span className={styles.count} aria-label={`${targets.length} ${label.toLowerCase()}`}>
          {targets.length}
        </span>
      </div>
      {targets.length === 0 ? (
        <p className={styles.emptyGroup}>No open {label.toLowerCase()}.</p>
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
        <h3 id={titleId} className={styles.sequentTitle}>
          <FamilyGlyph family={kind} />
          {targetLabel} {ordinal}
        </h3>
      </header>

      {declarations.length > 0 ? (
        <section
          className={`${styles.contextSection} ${styles.declarations}`}
          data-family="variable"
          aria-labelledby={declarationsId}
        >
          <h4 id={declarationsId} className={styles.declarationsLabel}>
            Variables
          </h4>
          <ul className={styles.declarationList}>
            {declarations.map((declaration) => (
              <li
                key={declaration.id}
                data-family="variable"
                aria-label={`Variable ${declaration.symbol}: ${sortLabel(declaration.sort)}, ${declarationRoleLabel(declaration.role).toLowerCase()}`}
              >
                <strong>{declaration.symbol}</strong>
                <span>{sortLabel(declaration.sort)}</span>
                {declaration.role === "universal-parameter" ? null : (
                  <small>{declarationRoleLabel(declaration.role)}</small>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {target.sequent.context.hypotheses.length > 0 ? (
        <section
          className={styles.contextSection}
          data-family="hypothesis"
          aria-labelledby={hypothesesId}
        >
          <h4 id={hypothesesId} className="visually-hidden">
            Hypotheses for {targetLabel.toLowerCase()} {ordinal}
          </h4>
          <ol className={styles.statementList}>
            {target.sequent.context.hypotheses.map((hypothesis, index) => {
              const anchor: StatementAnchor = {
                stateId,
                target: targetAnchor,
                statement: { kind: "hypothesis", id: hypothesis.id },
              };
              return (
                <li key={hypothesis.id} data-family="hypothesis" data-polarity="negative">
                  <StatementSelector
                    anchor={anchor}
                    environment={environment}
                    label={`Select hypothesis ${index + 1} of ${targetLabel.toLowerCase()} ${ordinal}`}
                  >
                    H{index + 1}
                  </StatementSelector>
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
        </section>
      ) : null}

      <section
        className={styles.conclusionSection}
        data-family={kind}
        data-polarity="positive"
        aria-labelledby={conclusionId}
      >
        <h4 id={conclusionId} className="visually-hidden">
          Conclusion for {targetLabel.toLowerCase()} {ordinal}
        </h4>
        <div className={styles.conclusionRow}>
          <StatementSelector
            anchor={conclusionAnchor}
            environment={environment}
            label={`Select ${targetLabel.toLowerCase()} ${ordinal}`}
          >
            {kind === "goal" ? "Goal" : "Prove"}
          </StatementSelector>
          <StatementView
            anchor={conclusionAnchor}
            declarations={declarations}
            expression={target.sequent.conclusion.expression}
            label={`${targetLabel} ${ordinal} conclusion`}
            environment={environment}
          />
        </div>
      </section>
    </article>
  );
}

function StatementSelector({
  anchor,
  environment,
  label,
  children,
}: Readonly<{
  anchor: StatementAnchor;
  environment: StatementEnvironment;
  label: string;
  children: React.ReactNode;
}>) {
  return (
    <button
      type="button"
      className={styles.statementLabel}
      data-family={anchor.statement.kind === "hypothesis" ? "hypothesis" : anchor.target.kind}
      aria-label={label}
      aria-pressed={environment.selectedStatements.has(canonicalJson(anchor))}
      title={label}
      onClick={(event) =>
        environment.onGesture({
          selection: { kind: "exact", anchor, path: [] },
          modifier: event.ctrlKey || event.metaKey,
          repeatable: false,
        })
      }
    >
      {children}
    </button>
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
  const key = canonicalJson(anchor);
  const selected = environment.selectedAnchors.has(key);
  const polarity = environment.selectedAnchors.get(key);
  const gestures = environment.gestures;
  const polarityAtRoot = anchor.statement.kind === "conclusion" ? "positive" : "negative";
  return (
    <div className={styles.statement}>
      {environment.view === "natural-language" ? (
        <p
          className={styles.naturalLanguage}
          aria-label={label}
          title={POLARITY_LABELS[polarityAtRoot]}
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
          governingProposition={(path) =>
            governingProposition(
              expression,
              path,
              { polarity: polarityAtRoot, role: "proposition" },
              declarations,
              environment.operators,
            )
          }
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
  const known = PROBLEM_SETUP_SORT_CHOICES.find((choice) => canonicalJsonEquals(choice.sort, sort));
  if (known !== undefined) return known.label;
  if (sort.kind === "proposition") return "proposition";
  if (sort.kind === "named") {
    const sortArguments = sort.arguments?.map(sortLabel).join(", ");
    const name = sort.id.replace(/^sort:/, "");
    return sortArguments ? `${name} (${sortArguments})` : name;
  }
  return `(${sort.signature.parameters.map(sortLabel).join(", ")}) → ${sortLabel(
    sort.signature.result,
  )}`;
}

function SelectionSummary({
  selection,
  resolved,
  presentation,
  view,
}: Readonly<{
  selection: AnchoredProofSelection;
  resolved: ResolveProofSelectionResult;
  presentation: Presentation;
  view: WorkspaceView;
}>) {
  const family =
    selection.anchor.statement.kind === "hypothesis" ? "hypothesis" : selection.anchor.target.kind;
  const polarity = resolved.ok ? resolved.selection.position.polarity : undefined;

  return (
    <li
      data-selection-key={proofSelectionKey(selection)}
      data-family={family}
      data-polarity={polarity}
    >
      <span>{FAMILIES[family].label}</span>
      {resolved.ok ? (
        <PresentedStatement
          expression={resolved.selection.fragment}
          presentation={presentation}
          view={view}
        />
      ) : (
        "Selection unavailable"
      )}
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
