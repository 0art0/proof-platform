"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createMovePreviewSchema,
  createProofEdgeSchema,
  createProofNodeSchema,
  commandIdSchema,
  suggestionIdSchema,
  type DisplayedSuggestionSet,
  type MovePreview,
  type OperatorDeclaration,
  type ProofEdge,
  type ProofNode,
} from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import { ProofWorkspace, type WorkspaceView } from "../proof-workspace";
import { InlineLatex, NaturalLanguageText, usePresentation } from "../proof-workspace/presentation";
import type { Presentation } from "@proof/language";
import { WorkspaceHeader, branchBreadcrumb } from "./workspace-header";
import { WorkspaceToolbar } from "./workspace-toolbar";
import {
  backtrackApiResponseSchema,
  commandApiResponseSchema,
  movePreviewApiResponseSchema,
  proofHistoryApiResponseSchema,
  suggestionApiResponseSchema,
  suggestionRequestSchema,
  type MoveChoiceRequest,
  type ProofSelectionDescriptor,
} from "./api-contract";
import { createInteractionRecorder } from "./interaction-recorder";
import styles from "./stored-proof-workspace.module.css";

export type StoredProofSession = Readonly<{
  id: string;
  rootNodeId: string;
  currentNodeId: string;
  operators: readonly OperatorDeclaration[];
}>;

export type StoredProofWorkspaceProps = Readonly<{ session: StoredProofSession; node: ProofNode }>;
type ClassEntry = Readonly<{ suggestionId: string; transitionClass: TransitionClass }>;
type SuggestionState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "empty";
      suggestionSet: DisplayedSuggestionSet;
      transitionClasses: readonly ClassEntry[];
    }>
  | Readonly<{
      kind: "ready";
      suggestionSet: DisplayedSuggestionSet;
      transitionClasses: readonly ClassEntry[];
    }>
  | Readonly<{ kind: "rejected"; message: string }>
  | Readonly<{ kind: "stale"; message: string }>;
type MoveState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "previewing" | "applying"; suggestionId: string }>
  | Readonly<{
      kind: "previewed";
      suggestionId: string;
      commandId: MoveChoiceRequest["commandId"];
      preview: MovePreview;
    }>
  | Readonly<{ kind: "rejected"; suggestionId: string; message: string }>;
type HistoryState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; nodes: readonly ProofNode[]; edges: readonly HistoryEdge[] }>
  | Readonly<{ kind: "rejected"; message: string }>;
type Notice = Readonly<{ state: "committed" | "rejected"; message: string }>;
type TransitionClass = ProofEdge["transitionClass"];
type SuggestionId = DisplayedSuggestionSet["suggestions"][number]["id"];
type HistoryEdge = Readonly<{ edge: ProofEdge; name: string }>;

/** Bind a validated stored snapshot to the reusable interactive proof-state view. */
export function StoredProofWorkspace(props: StoredProofWorkspaceProps) {
  const initialKey = JSON.stringify({
    sessionId: props.session.id,
    node: props.node,
    operators: props.session.operators,
  });
  return <StatefulStoredWorkspace key={initialKey} {...props} />;
}

function StatefulStoredWorkspace({
  session: initialSession,
  node: initialNode,
}: StoredProofWorkspaceProps) {
  const [session, setSession] = useState(initialSession);
  const [node, setNode] = useState(initialNode);
  const [suggestions, setSuggestions] = useState<SuggestionState>({ kind: "idle" });
  const [moveState, setMoveState] = useState<MoveState>({ kind: "idle" });
  const [history, setHistory] = useState<HistoryState>({ kind: "loading" });
  const [notice, setNotice] = useState<Notice>();
  const [mutationPending, setMutationPending] = useState(false);
  const [view, setView] = useState<WorkspaceView>("formal");
  const presentation = usePresentation(session.operators);
  const requestGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const commandIds = useRef(new Map<string, MoveChoiceRequest["commandId"]>());
  const mutationPendingRef = useRef(false);
  // Whether the last reported selection was empty. A snapshot starts with no selection.
  const selectionEmpty = useRef(true);
  const recordInteraction = useMemo(() => createInteractionRecorder(session.id), [session.id]);
  // The displayed suggestion set and the shown preview, for interaction events.
  const displayedSetId = useRef<string | undefined>(undefined);
  const shownPreview = useRef<MovePreview | undefined>(undefined);

  const loadHistory = useCallback(async () => {
    const generation = ++historyGeneration.current;
    const result = await requestHistory(session.id, session.operators);
    if (historyGeneration.current !== generation) return;
    setHistory(
      result.ok
        ? { kind: "ready", nodes: result.nodes, edges: result.edges }
        : { kind: "rejected", message: result.message },
    );
  }, [session.id, session.operators]);

  useEffect(() => void loadHistory(), [loadHistory]);
  useEffect(
    () => () => {
      requestGeneration.current += 1;
      actionGeneration.current += 1;
      historyGeneration.current += 1;
      activeRequest.current?.abort();
    },
    [],
  );

  const resetTransientState = useCallback(() => {
    requestGeneration.current += 1;
    actionGeneration.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = undefined;
    commandIds.current.clear();
    selectionEmpty.current = true;
    displayedSetId.current = undefined;
    shownPreview.current = undefined;
    setSuggestions({ kind: "idle" });
    setMoveState({ kind: "idle" });
  }, []);

  /** Record that the shown preview was left without being applied. */
  const rejectShownPreview = useCallback(
    (reason: "superseded" | "selection-changed") => {
      const preview = shownPreview.current;
      if (preview === undefined) return;
      shownPreview.current = undefined;
      recordInteraction({
        kind: "preview-rejected",
        nodeId: preview.nodeId,
        previewId: preview.id,
        reason,
      });
    },
    [recordInteraction],
  );

  const handleSelectionChange = useCallback(
    (selections: readonly AnchoredProofSelection[]) => {
      if (mutationPendingRef.current) return;
      // The workspace of a newly committed snapshot reports its empty selection once it mounts.
      // Nothing changed, so keep the notice of the apply or backtrack that produced it.
      const empty = selections.length === 0;
      if (empty && selectionEmpty.current) return;
      selectionEmpty.current = empty;
      rejectShownPreview("selection-changed");
      if (empty) {
        recordInteraction({ kind: "selection-changed", nodeId: node.id, selections: [] });
        if (displayedSetId.current !== undefined) {
          recordInteraction({
            kind: "interaction-ended-without-action",
            nodeId: node.id,
            suggestionSetId: displayedSetId.current,
            reason: "selection-cleared",
          });
        }
      }
      displayedSetId.current = undefined;
      const generation = ++requestGeneration.current;
      actionGeneration.current += 1;
      activeRequest.current?.abort();
      activeRequest.current = undefined;
      commandIds.current.clear();
      setMoveState({ kind: "idle" });
      setNotice(undefined);
      if (selections.length === 0) {
        setSuggestions({ kind: "idle" });
        return;
      }
      const request = suggestionRequestSchema.safeParse({
        id: suggestionSetId(node.state.id, generation),
        selections: selections.map(toDescriptor),
      });
      if (!request.success) {
        setSuggestions({
          kind: "rejected",
          message: "The selected occurrence could not be encoded safely.",
        });
        return;
      }
      if (request.data.selections.some(({ anchor }) => anchor.stateId !== node.state.id)) {
        setSuggestions({
          kind: "stale",
          message: "The selection belongs to an older proof-state snapshot.",
        });
        return;
      }
      recordInteraction({
        kind: "selection-changed",
        nodeId: node.id,
        selections: request.data.selections,
      });
      recordInteraction({
        kind: "suggestions-requested",
        nodeId: node.id,
        suggestionSetId: request.data.id,
      });
      const controller = new AbortController();
      activeRequest.current = controller;
      setSuggestions({ kind: "loading" });
      void requestSuggestions(session.id, request.data, controller.signal).then((result) => {
        if (requestGeneration.current !== generation || controller.signal.aborted) return;
        activeRequest.current = undefined;
        if (!result.ok) {
          setSuggestions({
            kind: isStaleFailure(result.error.code, result.error.message) ? "stale" : "rejected",
            message: result.error.message,
          });
          return;
        }
        const { suggestionSet, transitionClasses } = result.data;
        if (suggestionSet.nodeId !== node.id || suggestionSet.stateId !== node.state.id) {
          setSuggestions({
            kind: "stale",
            message: "The returned suggestions belong to an older proof snapshot.",
          });
          return;
        }
        displayedSetId.current = suggestionSet.id;
        recordInteraction({
          kind: "suggestions-displayed",
          nodeId: node.id,
          suggestionSetId: suggestionSet.id,
          suggestionIds: suggestionSet.suggestions.map(({ id }) => id),
        });
        setSuggestions({
          kind: suggestionSet.suggestions.length === 0 ? "empty" : "ready",
          suggestionSet,
          transitionClasses,
        });
      });
    },
    [node.id, node.state.id, recordInteraction, rejectShownPreview, session.id],
  );

  const commandIdFor = useCallback(
    (setId: string, suggestionId: SuggestionId) => {
      const key = `${setId}\u0000${suggestionId}`;
      const existing = commandIds.current.get(key);
      if (existing !== undefined) return existing;
      const created = commandIdSchema.parse(stableAttemptId("command:web", node.state.id));
      commandIds.current.set(key, created);
      return created;
    },
    [node.state.id],
  );

  const previewSuggestion = useCallback(
    async (set: DisplayedSuggestionSet, suggestionId: SuggestionId) => {
      const generation = ++actionGeneration.current;
      const commandId = commandIdFor(set.id, suggestionId);
      const chosenSuggestionId = suggestionIdSchema.parse(suggestionId);
      if (shownPreview.current?.chosenSuggestionId !== suggestionId) {
        rejectShownPreview("superseded");
      }
      recordInteraction({
        kind: "preview-requested",
        nodeId: node.id,
        suggestionSetId: set.id,
        chosenSuggestionId,
        commandId,
      });
      setNotice(undefined);
      setMoveState({ kind: "previewing", suggestionId });
      const result = await requestMovePreview(
        session.id,
        { commandId, suggestionSetId: set.id, chosenSuggestionId },
        session.operators,
      );
      if (actionGeneration.current !== generation) return;
      if (!result.ok) {
        setMoveState({ kind: "rejected", suggestionId, message: result.message });
      } else if (
        result.preview.nodeId !== node.id ||
        result.preview.stateId !== node.state.id ||
        result.preview.suggestionSetId !== set.id ||
        result.preview.chosenSuggestionId !== suggestionId
      ) {
        setMoveState({
          kind: "rejected",
          suggestionId,
          message: "The preview belongs to a different proof snapshot or choice.",
        });
      } else {
        shownPreview.current = result.preview;
        setMoveState({ kind: "previewed", suggestionId, commandId, preview: result.preview });
      }
    },
    [
      commandIdFor,
      node.id,
      node.state.id,
      recordInteraction,
      rejectShownPreview,
      session.id,
      session.operators,
    ],
  );

  const applySuggestion = useCallback(
    async (set: DisplayedSuggestionSet, suggestionId: SuggestionId) => {
      if (moveState.kind !== "previewed" || moveState.suggestionId !== suggestionId) return;
      if (mutationPendingRef.current) return;
      mutationPendingRef.current = true;
      setMutationPending(true);
      const generation = ++actionGeneration.current;
      const retryState = moveState;
      const choice: MoveChoiceRequest = {
        commandId: moveState.commandId,
        suggestionSetId: set.id,
        chosenSuggestionId: suggestionIdSchema.parse(suggestionId),
      };
      setMoveState({ kind: "applying", suggestionId });
      const result = await requestApply(session.id, choice, session.operators);
      mutationPendingRef.current = false;
      setMutationPending(false);
      if (actionGeneration.current !== generation) return;
      if (!result.ok && result.code === "preview-regenerated") {
        // The approved definitions changed since the preview: show the regenerated preview,
        // which the next Apply of the same command confirms.
        await previewSuggestion(set, suggestionId);
        setNotice({
          state: "rejected",
          message: `Apply paused: ${result.message}`,
        });
        return;
      }
      if (!result.ok) {
        setMoveState(retryState);
        setNotice({ state: "rejected", message: `Apply rejected: ${result.message}` });
        return;
      }
      setSession(result.session);
      setNode(result.node);
      resetTransientState();
      setNotice({
        state: "committed",
        message: `Applied ${suggestionId}; advanced to ${result.node.id} (${result.receipt.transitionClass}).`,
      });
      void loadHistory();
    },
    [loadHistory, moveState, previewSuggestion, resetTransientState, session.id, session.operators],
  );

  const backtrackTo = useCallback(
    async (targetNodeId: string) => {
      if (targetNodeId === node.id || mutationPendingRef.current) return;
      mutationPendingRef.current = true;
      setMutationPending(true);
      const generation = ++actionGeneration.current;
      const result = await requestBacktrack(
        session.id,
        { expectedCurrentNodeId: node.id, targetNodeId },
        session.operators,
      );
      mutationPendingRef.current = false;
      setMutationPending(false);
      if (actionGeneration.current !== generation) return;
      if (!result.ok) {
        setNotice({ state: "rejected", message: `Backtrack rejected: ${result.message}` });
        return;
      }
      setSession(result.session);
      setNode(result.node);
      resetTransientState();
      setNotice({ state: "committed", message: `Backtracked to ${result.node.id}.` });
      void loadHistory();
    },
    [loadHistory, node.id, resetTransientState, session.id, session.operators],
  );

  const displayedSet =
    suggestions.kind === "ready" || suggestions.kind === "empty"
      ? suggestions.suggestionSet
      : undefined;
  const breadcrumb = useMemo(() => {
    if (history.kind === "loading") return { kind: "loading" } as const;
    const crumbs =
      history.kind === "ready"
        ? branchBreadcrumb(history.nodes, history.edges, node.id)
        : undefined;
    return crumbs === undefined
      ? ({ kind: "unavailable" } as const)
      : ({ kind: "ready", crumbs } as const);
  }, [history, node.id]);
  const statusText = useMemo(() => suggestionStatusText(suggestions), [suggestions]);
  const classes = new Map(
    suggestions.kind === "ready" || suggestions.kind === "empty"
      ? suggestions.transitionClasses.map((entry) => [entry.suggestionId, entry.transitionClass])
      : [],
  );

  return (
    <section className={styles.storedWorkspace} aria-label="Stored proof session">
      <WorkspaceHeader
        sessionId={session.id}
        currentNodeId={node.id}
        counts={{ goals: node.state.goals.length, obligations: node.state.obligations.length }}
        breadcrumb={breadcrumb}
      />
      <WorkspaceToolbar view={view} onViewChange={setView} sessionId={session.id} node={node} />
      {notice ? (
        <p className={styles.actionNotice} data-state={notice.state} role="status">
          {notice.message}
        </p>
      ) : null}
      <div
        className={styles.interactionShell}
        data-busy={mutationPending}
        aria-busy={mutationPending}
      >
        <ProofWorkspace
          key={node.id}
          node={node}
          operators={session.operators}
          view={view}
          onSelectionChange={handleSelectionChange}
        />
      </div>

      <section className={styles.suggestionPanel} aria-label="Persisted suggestions">
        <div className={styles.suggestionHeading}>
          <div>
            <h2>Suggestions</h2>
            <p className={styles.suggestionMeta}>
              Deterministically ranked and persisted by the proof service.
            </p>
          </div>
          {displayedSet ? <code data-testid="suggestion-set-id">{displayedSet.id}</code> : null}
        </div>
        <p className={styles.status} data-state={suggestions.kind} role="status">
          {statusText}
        </p>
        {suggestions.kind === "ready" ? (
          <ol className={styles.suggestions} data-testid="suggestion-list">
            {suggestions.suggestionSet.suggestions.map((suggestion) => {
              const classification = classes.get(suggestion.id);
              const active = moveState.kind !== "idle" && moveState.suggestionId === suggestion.id;
              const preview =
                moveState.kind === "previewed" && moveState.suggestionId === suggestion.id
                  ? moveState.preview
                  : undefined;
              const actionable =
                suggestion.applicability === "applicable" && suggestion.source === "move";
              return (
                <li
                  className={styles.suggestionCard}
                  data-applicability={suggestion.applicability}
                  data-artifact-id={suggestion.artifactId}
                  data-suggestion-id={suggestion.id}
                  key={suggestion.id}
                >
                  <header>
                    <div>
                      <h3>{suggestion.name}</h3>
                      <code>{suggestion.artifactId}</code>
                    </div>
                    <span
                      className={styles.applicability}
                      data-applicability={suggestion.applicability}
                    >
                      {suggestion.applicability === "applicable" ? "Applicable" : "Needs input"}
                    </span>
                  </header>
                  <div className={styles.cardFacts}>
                    <span>{suggestion.source === "move" ? "Move" : "Result"}</span>
                    <span>
                      {suggestion.exactRepresentationMatch ? "Exact match" : "Structural match"}
                    </span>
                    {classification ? (
                      <span
                        className={styles.transitionClass}
                        data-transition-class={classification}
                      >
                        {classification}
                      </span>
                    ) : null}
                  </div>
                  <div>
                    <strong>Why it applies</strong>
                    <ul aria-label={`Reasons for ${suggestion.name}`}>
                      {suggestion.reasons.map((reason, index) => (
                        <li key={`${suggestion.id}:reason:${index}`}>{reason}</li>
                      ))}
                    </ul>
                  </div>
                  <div className={styles.selectionMatches}>
                    <strong>Matched selections</strong>
                    <ul aria-label={`Matched selections for ${suggestion.name}`}>
                      {suggestion.selectionMatches.map((match) => (
                        <li
                          key={`${match.selectionId}:${match.selectionSlotId ?? match.patternId}`}
                        >
                          {match.selectionId} → {match.selectionSlotId ?? match.patternId}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {suggestion.applicability === "requires-input" ? (
                    <div className={styles.missingInput} role="note">
                      <strong>Additional input required</strong>
                      <span>{missingInputText(suggestion)}</span>
                      <details
                        onToggle={(event) => {
                          if (!event.currentTarget.open) return;
                          recordInteraction({
                            kind: "menu-expanded",
                            nodeId: node.id,
                            suggestionSetId: suggestions.suggestionSet.id,
                            suggestionId: suggestionIdSchema.parse(suggestion.id),
                          });
                        }}
                      >
                        <summary>Input menus</summary>
                        <ul aria-label={`Input menus for ${suggestion.name}`}>
                          {[
                            ...suggestion.unresolvedSelectionSlots,
                            ...suggestion.unresolvedParameters,
                          ].map((input) => (
                            <li key={input}>{`Choose ${input}`}</li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  ) : null}
                  <div className={styles.cardActions}>
                    <button
                      type="button"
                      disabled={
                        mutationPending || !actionable || (active && moveState.kind !== "rejected")
                      }
                      onClick={() =>
                        void previewSuggestion(suggestions.suggestionSet, suggestion.id)
                      }
                    >
                      {active && moveState.kind === "previewing" ? "Previewing…" : "Preview"}
                    </button>
                    <button
                      type="button"
                      disabled={
                        mutationPending ||
                        !actionable ||
                        preview === undefined ||
                        moveState.kind === "applying"
                      }
                      onClick={() => void applySuggestion(suggestions.suggestionSet, suggestion.id)}
                    >
                      {active && moveState.kind === "applying" ? "Applying…" : "Apply"}
                    </button>
                  </div>
                  {moveState.kind === "rejected" && moveState.suggestionId === suggestion.id ? (
                    <p className={styles.status} data-state="rejected" role="alert">
                      Move rejected: {moveState.message}
                    </p>
                  ) : null}
                  {preview ? (
                    <PreviewDetails preview={preview} presentation={presentation} view={view} />
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : null}
      </section>
      <HistoryView
        history={history}
        currentNodeId={node.id}
        mutationPending={mutationPending}
        presentation={presentation}
        view={view}
        onBacktrack={backtrackTo}
      />
    </section>
  );
}

type ReadOnlyPresentation = Readonly<{ presentation: Presentation; view: WorkspaceView }>;

/** A read-only statement in the selected view; the stored MathJSON is never altered. */
function ReadOnlyStatement({
  expression,
  declarations,
  presentation,
  view,
}: ReadOnlyPresentation &
  Readonly<{
    expression: ProofNode["state"]["goals"][number]["sequent"]["conclusion"]["expression"];
    declarations: ProofNode["state"]["goals"][number]["sequent"]["context"]["declarations"];
  }>) {
  return view === "natural-language" ? (
    <NaturalLanguageText text={presentation.naturalLanguage(expression, { declarations })} />
  ) : (
    <InlineLatex latex={presentation.latex(expression)} />
  );
}

function PreviewDetails({
  preview,
  presentation,
  view,
}: ReadOnlyPresentation & Readonly<{ preview: MovePreview }>) {
  const added = preview.afterState.obligations.filter((item) =>
    preview.delta.obligations.added.includes(item.id),
  );
  return (
    <section className={styles.previewPanel} aria-label="Move preview">
      <strong>Expected proof-state difference</strong>
      <span className={styles.transitionClass} data-transition-class={preview.transitionClass}>
        {preview.transitionClass}
      </span>
      <dl>
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
        <strong>New obligations</strong>
        {added.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {added.map((item) => (
              <li key={item.id}>
                <ReadOnlyStatement
                  expression={item.sequent.conclusion.expression}
                  declarations={item.sequent.context.declarations}
                  presentation={presentation}
                  view={view}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function HistoryView({
  history,
  currentNodeId,
  mutationPending,
  presentation,
  view,
  onBacktrack,
}: ReadOnlyPresentation &
  Readonly<{
    history: HistoryState;
    currentNodeId: string;
    mutationPending: boolean;
    onBacktrack: (id: string) => Promise<void>;
  }>) {
  return (
    <section className={styles.historyPanel} aria-label="Proof-discovery tree">
      <div className={styles.historyHeading}>
        <div>
          <h2>Proof-discovery tree</h2>
          <p>Backtracking preserves every existing branch.</p>
        </div>
        {history.kind === "ready" ? <span>{history.edges.length} transitions</span> : null}
      </div>
      {history.kind === "loading" ? <p>Loading retained history…</p> : null}
      {history.kind === "rejected" ? (
        <p role="alert">History unavailable: {history.message}</p>
      ) : null}
      {history.kind === "ready" ? (
        <ol className={styles.historyList}>
          {orderedHistory(history.nodes, history.edges).map(({ node, incoming, depth }) => (
            <li
              className={styles.historyItem}
              key={node.id}
              style={{ paddingLeft: `${depth * 1.1}rem` }}
            >
              <button
                className={styles.historyNode}
                data-current={node.id === currentNodeId}
                data-history-node-id={node.id}
                disabled={node.id === currentNodeId || mutationPending}
                type="button"
                onClick={() => void onBacktrack(node.id)}
              >
                <span>
                  <HistoryNodeLabel node={node} presentation={presentation} view={view} />
                </span>
                <small>
                  {incoming === undefined
                    ? `Root · ${node.id}`
                    : `${incoming.name} · ${incoming.edge.transitionClass} · ${node.id}`}
                </small>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function orderedHistory(nodes: readonly ProofNode[], edges: readonly HistoryEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(edges.map((record) => [record.edge.childNodeId, record]));
  const children = new Map<string, HistoryEdge[]>();
  for (const record of edges)
    children.set(record.edge.parentNodeId, [
      ...(children.get(record.edge.parentNodeId) ?? []),
      record,
    ]);
  const root = nodes.find((candidate) => !incoming.has(candidate.id));
  if (root === undefined) return [];
  const result: Array<{ node: ProofNode; incoming: HistoryEdge | undefined; depth: number }> = [];
  const visit = (current: ProofNode, edge: HistoryEdge | undefined, depth: number) => {
    result.push({ node: current, incoming: edge, depth });
    for (const childEdge of children.get(current.id) ?? []) {
      const child = byId.get(childEdge.edge.childNodeId);
      if (child !== undefined) visit(child, childEdge, depth + 1);
    }
  };
  visit(root, undefined, 0);
  return result;
}

function HistoryNodeLabel({
  node,
  presentation,
  view,
}: ReadOnlyPresentation & Readonly<{ node: ProofNode }>) {
  const goal = node.state.goals[0];
  const first = goal ?? node.state.obligations[0];
  if (first === undefined) return <>No open goals</>;
  return (
    <>
      {goal === undefined ? "Obligation: " : "Goal: "}
      <ReadOnlyStatement
        expression={first.sequent.conclusion.expression}
        declarations={first.sequent.context.declarations}
        presentation={presentation}
        view={view}
      />
    </>
  );
}

function missingInputText(suggestion: DisplayedSuggestionSet["suggestions"][number]): string {
  const inputs = [...suggestion.unresolvedSelectionSlots, ...suggestion.unresolvedParameters];
  if (suggestion.abstractionFit !== "not-used")
    inputs.push("a concrete replacement for the abstraction");
  return inputs.length === 0 ? "This suggestion cannot yet be executed." : inputs.join(", ");
}

function deltaText(delta: MovePreview["delta"]["goals"]): string {
  return `+${delta.added.length} −${delta.removed.length} ~${delta.updated.length}`;
}

function toDescriptor(selection: AnchoredProofSelection): ProofSelectionDescriptor {
  return selection.kind === "exact"
    ? { kind: "exact", anchor: selection.anchor, path: [...selection.path] }
    : {
        kind: "associative",
        anchor: selection.anchor,
        containerPath: [...selection.containerPath],
        startOperand: selection.startOperand,
        endOperand: selection.endOperand,
        ...(selection.displayRange === undefined
          ? {}
          : { displayRange: [...selection.displayRange] as [number, number] }),
      };
}

function suggestionSetId(stateId: string, generation: number): string {
  return stableAttemptId(`suggestion-set:web-${generation}`, stateId);
}

function stableAttemptId(prefix: string, stateId: string): string {
  return `${prefix}-${stateId.replace(/[^A-Za-z0-9._:/-]/g, "-")}-${crypto.randomUUID()}`;
}

async function requestSuggestions(sessionId: string, request: unknown, signal: AbortSignal) {
  try {
    const response = await fetch(
      `/api/proof-sessions/${encodeURIComponent(sessionId)}/suggestion-sets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        cache: "no-store",
        signal,
      },
    );
    const parsed = suggestionApiResponseSchema.safeParse(await response.json());
    return !parsed.success || parsed.data.ok !== response.ok
      ? invalidBrowserResponse()
      : parsed.data;
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code:
          error instanceof DOMException && error.name === "AbortError" ? "aborted" : "unavailable",
        message: "The suggestion service could not be reached.",
      },
    };
  }
}

async function requestMovePreview(
  sessionId: string,
  choice: MoveChoiceRequest,
  operators: readonly OperatorDeclaration[],
): Promise<{ ok: true; preview: MovePreview } | ActionFailure> {
  try {
    const response = await postChoice(sessionId, "move-previews", choice);
    const parsed = movePreviewApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return invalidActionResponse();
    if (!parsed.data.ok) return { ok: false, message: parsed.data.error.message };
    const preview = createMovePreviewSchema({ operators }).safeParse(parsed.data.data.preview);
    return preview.success ? { ok: true, preview: preview.data } : invalidActionResponse();
  } catch {
    return { ok: false, message: "The preview service could not be reached." };
  }
}

async function requestApply(
  sessionId: string,
  choice: MoveChoiceRequest,
  operators: readonly OperatorDeclaration[],
) {
  try {
    const response = await postChoice(sessionId, "commands", choice);
    const parsed = commandApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return invalidActionResponse();
    if (!parsed.data.ok) {
      return {
        ok: false as const,
        code: parsed.data.error.code,
        message: parsed.data.error.message,
      };
    }
    const node = createProofNodeSchema({ operators }).safeParse(parsed.data.data.node);
    if (!node.success || parsed.data.data.session.currentNodeId !== node.data.id)
      return invalidActionResponse();
    return {
      ok: true as const,
      session: parsed.data.data.session,
      node: node.data,
      receipt: parsed.data.data.receipt,
    };
  } catch {
    return { ok: false as const, message: "The command service could not be reached." };
  }
}

async function requestHistory(sessionId: string, operators: readonly OperatorDeclaration[]) {
  try {
    const response = await fetch(`/api/proof-sessions/${encodeURIComponent(sessionId)}/history`, {
      cache: "no-store",
    });
    const parsed = proofHistoryApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return invalidActionResponse();
    if (!parsed.data.ok) return { ok: false as const, message: parsed.data.error.message };
    const nodes = parsed.data.data.nodes.map((value) =>
      createProofNodeSchema({ operators }).safeParse(value),
    );
    const edges = parsed.data.data.edges.map(({ edge, name }) => ({
      name,
      parsed: createProofEdgeSchema({ operators }).safeParse(edge),
    }));
    if (nodes.some((value) => !value.success) || edges.some(({ parsed }) => !parsed.success))
      return invalidActionResponse();
    return {
      ok: true as const,
      nodes: nodes.map((value) => value.data as ProofNode),
      edges: edges.map(({ name, parsed }) => ({ name, edge: parsed.data as ProofEdge })),
    };
  } catch {
    return { ok: false as const, message: "The proof history could not be reached." };
  }
}

async function requestBacktrack(
  sessionId: string,
  request: Readonly<{ expectedCurrentNodeId: string; targetNodeId: string }>,
  operators: readonly OperatorDeclaration[],
) {
  try {
    const response = await fetch(`/api/proof-sessions/${encodeURIComponent(sessionId)}/backtrack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
    });
    const parsed = backtrackApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return invalidActionResponse();
    if (!parsed.data.ok) return { ok: false as const, message: parsed.data.error.message };
    const node = createProofNodeSchema({ operators }).safeParse(parsed.data.data.node);
    if (!node.success || parsed.data.data.session.currentNodeId !== node.data.id)
      return invalidActionResponse();
    return { ok: true as const, session: parsed.data.data.session, node: node.data };
  } catch {
    return { ok: false as const, message: "The backtrack service could not be reached." };
  }
}

function postChoice(
  sessionId: string,
  resource: string,
  choice: MoveChoiceRequest,
): Promise<Response> {
  return fetch(`/api/proof-sessions/${encodeURIComponent(sessionId)}/${resource}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(choice),
    cache: "no-store",
  });
}

type ActionFailure = { ok: false; message: string; code?: string };
function invalidBrowserResponse() {
  return {
    ok: false as const,
    error: {
      code: "invalid_response",
      message: "The suggestion service returned an invalid response.",
    },
  };
}
function invalidActionResponse(): ActionFailure {
  return { ok: false, message: "The proof service returned an invalid response." };
}
function isStaleFailure(code: string, message: string) {
  return code === "stale_snapshot" || /stale|older|does not match proof state/i.test(message);
}
function suggestionStatusText(state: SuggestionState): string {
  if (state.kind === "idle")
    return "Select one or more anchored occurrences to retrieve suggestions.";
  if (state.kind === "loading") return "Loading suggestions for the current selection…";
  if (state.kind === "empty") return "No persisted suggestions apply to this selection.";
  if (state.kind === "stale") return `Stale selection: ${state.message}`;
  if (state.kind === "rejected") return `Suggestion request rejected: ${state.message}`;
  return `${state.suggestionSet.suggestions.length} persisted suggestion${state.suggestionSet.suggestions.length === 1 ? "" : "s"} in stored order.`;
}
