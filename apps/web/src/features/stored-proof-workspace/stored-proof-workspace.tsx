"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createMovePreviewSchema,
  createProofEdgeSchema,
  createProofNodeSchema,
  commandIdSchema,
  suggestionIdSchema,
  type DisplayedSuggestionSet,
  type MenuChoices,
  type MovePreview,
  type OperatorDeclaration,
  type ProofEdge,
  type ProofNode,
} from "@proof/protocol";
import { resolveProofSelection, type AnchoredProofSelection } from "@proof/selections";
import { ProofWorkspace, type WorkspaceView } from "../proof-workspace";
import {
  EMPTY_ABSTRACT_SELECTION_STATE,
  abstractSelectionReducer,
  abstractionForRole,
  isSelectionAbstract,
  type AbstractSelectionAction,
  type AbstractSelectionState,
} from "../proof-workspace/selection-state";
import { StatementView, usePresentation } from "../proof-workspace/presentation";
import type { Presentation } from "@proof/language";
import { LibraryDrawer } from "../library-drawer";
import { ConditionalLemmaPanel } from "../conditional-lemma";
import { InquiryPanel } from "../inquiry-panel";
import { GestureTray, useDragGestures } from "../gestures";
import {
  explainMacroFailure,
  macroDisplayName,
  macroStepLabel,
  humanizeMoveId,
} from "../macro-labels";
import { recordRecentSession } from "../problem-entry/recent-sessions";
import { macroNames, useMacroInfo, type MacroInfoMap } from "./macro-info";
import { WorkspaceHeader, branchBreadcrumb } from "./workspace-header";
import { WorkspaceToolbar, movesHref } from "./workspace-toolbar";
import { requestParameterMenus } from "./parameter-menu-request";
import type { MoveState, PendingMenus } from "./suggestion-card";
import { SUGGESTION_PANEL_ID, SuggestionPanel, type SuggestionState } from "./suggestion-panel";
import {
  backtrackApiResponseSchema,
  commandApiResponseSchema,
  movePreviewApiResponseSchema,
  proofHistoryApiResponseSchema,
  suggestionApiResponseSchema,
  suggestionRequestSchema,
  type MoveChoiceRequest,
} from "./api-contract";
import { toDescriptor } from "./selection-descriptor";
import { createInteractionRecorder } from "./interaction-recorder";
import { ConstantsPanel } from "./constants-panel";
import { useLibraryTopUp } from "./library-top-up";
import { useSessionConstants } from "./use-session-constants";
import { MoveInstructions } from "./move-instructions";
import { ToolbarActionBar, type RunToolbarCommand } from "./toolbar-action-bar";
import { READ_ONLY_REASON } from "./toolbar-actions";
import {
  describeCommandFailure,
  postProtocolCommand,
  readCurrentSession,
} from "./toolbar-requests";
import styles from "./stored-proof-workspace.module.css";

export type StoredProofSession = Readonly<{
  id: string;
  rootNodeId: string;
  currentNodeId: string;
  operators: readonly OperatorDeclaration[];
  /** Set for a session imported from an artifact (N27): nothing in it can be changed. */
  readOnly?: true | undefined;
  visibility?: "shared" | undefined;
  /** Problem metadata, when the page supplies it: the header's title and collapsed statement. */
  title?: string | undefined;
  statement?: string | undefined;
  background?: string | undefined;
}>;

export type StoredProofWorkspaceProps = Readonly<{
  session: StoredProofSession;
  node: ProofNode;
  /** Whether the proof service can rank suggestions with a model. */
  aiShortlist?: boolean | undefined;
  /** Whether the proof service can turn a described step into kernel steps with a model. */
  aiExecutor?: boolean | undefined;
  /** Whether the proof service can add library results during a proof with a model. */
  aiLibrarian?: boolean | undefined;
}>;
type HistoryState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; nodes: readonly ProofNode[]; edges: readonly HistoryEdge[] }>
  | Readonly<{ kind: "rejected"; message: string }>;
type Notice = Readonly<{ state: "committed" | "rejected"; message: string }>;
type SuggestionId = string;
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
  aiShortlist = false,
  aiExecutor = false,
  aiLibrarian = false,
}: StoredProofWorkspaceProps) {
  const [session, setSession] = useState(initialSession);
  const [node, setNode] = useState(initialNode);
  const [suggestions, setSuggestions] = useState<SuggestionState>({ kind: "idle" });
  const [moveState, setMoveState] = useState<MoveState>({ kind: "idle" });
  const [history, setHistory] = useState<HistoryState>({ kind: "loading" });
  const [notice, setNotice] = useState<Notice>();
  const [mutationPending, setMutationPending] = useState(false);
  const readOnly = initialSession.readOnly === true;
  const [view, setView] = useState<WorkspaceView>("formal");
  const [selections, setSelections] = useState<readonly AnchoredProofSelection[]>([]);
  // Selections marked abstract: a retrieval-only flag, mirrored in a ref for synchronous reads.
  const [abstractKeys, setAbstractKeys] = useState<AbstractSelectionState>(
    EMPTY_ABSTRACT_SELECTION_STATE,
  );
  const abstractRef = useRef<AbstractSelectionState>(EMPTY_ABSTRACT_SELECTION_STATE);
  const presentation = usePresentation(session.operators, node.state);
  const requestGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const commandIds = useRef(new Map<string, MoveChoiceRequest["commandId"]>());
  const mutationPendingRef = useRef(false);
  const instructionsRef = useRef<HTMLTextAreaElement | null>(null);
  // Whether the last reported selection was empty. A snapshot starts with no selection.
  const selectionEmpty = useRef(true);
  const recordInteraction = useMemo(() => createInteractionRecorder(session.id), [session.id]);
  // The displayed suggestion set and the shown preview, for interaction events.
  const displayedSetId = useRef<string | undefined>(undefined);
  const shownPreview = useRef<MovePreview | undefined>(undefined);
  // Drag gestures are created after previewSuggestion; these let earlier callbacks reach them.
  const notifyDragSelection = useRef<
    ((selections: readonly AnchoredProofSelection[]) => void) | undefined
  >(undefined);
  const resetDrag = useRef<(() => void) | undefined>(undefined);

  const updateAbstract = useCallback((action: AbstractSelectionAction) => {
    abstractRef.current = abstractSelectionReducer(abstractRef.current, action);
    setAbstractKeys(abstractRef.current);
  }, []);

  const loadHistory = useCallback(async () => {
    const generation = ++historyGeneration.current;
    const result = await requestHistory(session.id);
    if (historyGeneration.current !== generation) return;
    setHistory(
      result.ok
        ? { kind: "ready", nodes: result.nodes, edges: result.edges }
        : { kind: "rejected", message: result.message },
    );
  }, [session.id]);

  useEffect(() => void loadHistory(), [loadHistory]);

  // Sessions opened by URL join the home page's recent proofs (a known title is kept).
  useEffect(() => {
    recordRecentSession({ id: initialSession.id, title: initialSession.title });
  }, [initialSession.id, initialSession.title]);
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
    setSelections([]);
    updateAbstract({ type: "clear" });
    resetDrag.current?.();
  }, [updateAbstract]);

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
      setSelections(selections);
      updateAbstract({ type: "retain", selections });
      notifyDragSelection.current?.(selections);
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
        selections: selections.map((selection, position) =>
          toDescriptor(
            selection,
            isSelectionAbstract(abstractRef.current, selection)
              ? abstractionForRole(
                  position,
                  selectionRole(node.state, session.operators, selection),
                )
              : undefined,
          ),
        ),
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
        // Abstraction is retrieval-only; the recorded selection is always the concrete occurrence.
        selections: selections.map((selection) => toDescriptor(selection)),
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
    [
      node.id,
      node.state,
      recordInteraction,
      rejectShownPreview,
      session.id,
      session.operators,
      updateAbstract,
    ],
  );

  /** "Abstract this selection": flip the flag and re-request suggestions; nothing else changes. */
  const toggleAbstract = useCallback(
    (selection: AnchoredProofSelection) => {
      updateAbstract({ type: "toggle", selection });
      handleSelectionChange(selections);
    },
    [handleSelectionChange, selections, updateAbstract],
  );
  const abstraction = useMemo(
    () => ({
      abstractKeys,
      roleOf: (selection: AnchoredProofSelection) =>
        selectionRole(node.state, session.operators, selection),
      toggle: toggleAbstract,
      disabled: mutationPending,
    }),
    [abstractKeys, mutationPending, node.state, session.operators, toggleAbstract],
  );

  const commandIdFor = useCallback(
    (setId: string, suggestionId: SuggestionId, choices: MenuChoices) => {
      // A recorded preview binds its command ID to its menu choices, so other choices need
      // another command ID.
      const key = `${setId}\u0000${suggestionId}\u0000${choicesKey(choices)}`;
      const existing = commandIds.current.get(key);
      if (existing !== undefined) return existing;
      const created = commandIdSchema.parse(stableAttemptId("command:web", node.state.id));
      commandIds.current.set(key, created);
      return created;
    },
    [node.state.id],
  );

  const previewSuggestion = useCallback(
    async (
      set: DisplayedSuggestionSet,
      suggestionId: SuggestionId,
      choices: MenuChoices = {},
      menu?: PendingMenus,
    ): Promise<void> => {
      const generation = ++actionGeneration.current;
      const commandId = commandIdFor(set.id, suggestionId, choices);
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
      setMoveState({ kind: "previewing", suggestionId, menu });
      const choice = withChoices(
        { commandId, suggestionSetId: set.id, chosenSuggestionId },
        choices,
      );
      let result = await requestMovePreview(session.id, choice, session.operators);
      if (actionGeneration.current !== generation) return;
      if (!result.ok && result.code === "requires-input") {
        // The move needs menu choices: ask the command protocol for the menus it offers.
        const menus = await requestParameterMenus(session.id, {
          commandId,
          nodeId: node.id,
          suggestionSetId: set.id,
          suggestionId,
          menuChoices: choices,
        });
        if (actionGeneration.current !== generation) return;
        if (!menus.ok) {
          setMoveState({ kind: "rejected", suggestionId, message: menus.message });
          return;
        }
        if (!("previewRecorded" in menus)) {
          const shown = new Set(menu?.missingParameters ?? []);
          for (const parameterId of menus.missingParameters) {
            if (shown.has(parameterId)) continue;
            recordInteraction({
              kind: "menu-expanded",
              nodeId: node.id,
              suggestionSetId: set.id,
              suggestionId: chosenSuggestionId,
              parameterId,
            });
          }
          setMoveState({
            kind: "choosing",
            suggestionId,
            menu: { menus: menus.menus, missingParameters: menus.missingParameters, choices },
          });
          return;
        }
        // Nothing was missing after all, so the preview was recorded under this command ID;
        // requesting it again reads the recorded preview back.
        result = await requestMovePreview(session.id, choice, session.operators);
        if (actionGeneration.current !== generation) return;
      }
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
        setMoveState({
          kind: "previewed",
          suggestionId,
          commandId,
          preview: result.preview,
          choices,
        });
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

  const previewDropped = useCallback(
    (set: DisplayedSuggestionSet, suggestionId: string) =>
      void previewSuggestion(set, suggestionId),
    [previewSuggestion],
  );
  const drag = useDragGestures({
    stateId: node.state.id,
    enabled: view === "formal" && !mutationPending && !readOnly,
    disabledReason: readOnly ? READ_ONLY_REASON : undefined,
    suggestions,
    previewSuggestion: previewDropped,
  });
  useEffect(() => {
    notifyDragSelection.current = drag.notifySelectionChange;
    resetDrag.current = drag.reset;
  }, [drag.notifySelectionChange, drag.reset]);

  const applySuggestion = useCallback(
    async (set: DisplayedSuggestionSet, suggestionId: SuggestionId) => {
      if (moveState.kind !== "previewed" || moveState.suggestionId !== suggestionId) return;
      if (mutationPendingRef.current) return;
      mutationPendingRef.current = true;
      setMutationPending(true);
      const generation = ++actionGeneration.current;
      const retryState = moveState;
      const choice = withChoices(
        {
          commandId: commandIdSchema.parse(moveState.commandId),
          suggestionSetId: set.id,
          chosenSuggestionId: suggestionIdSchema.parse(suggestionId),
        },
        moveState.choices,
      );
      setMoveState({ kind: "applying", suggestionId });
      const result = await requestApply(session.id, choice);
      mutationPendingRef.current = false;
      setMutationPending(false);
      if (actionGeneration.current !== generation) return;
      if (!result.ok && result.code === "preview-regenerated") {
        // The approved definitions changed since the preview: show the regenerated preview,
        // which the next Apply of the same command confirms.
        await previewSuggestion(set, suggestionId, retryState.choices);
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
      // A readable name, never the raw suggestion ID; a macro reports its steps and composed class.
      const appliedName =
        set.suggestions.find(({ id }) => id === suggestionId)?.name ?? "the chosen step";
      const macroSteps = retryState.preview.macro?.steps.length;
      setNotice({
        state: "committed",
        message:
          macroSteps === undefined
            ? `Applied “${appliedName}”; advanced to ${result.node.id} (${result.receipt.transitionClass}).`
            : `Applied “${appliedName}” (${macroSteps} steps in a row); advanced to ${result.node.id} (${retryState.preview.transitionClass}).`,
      });
      void loadHistory();
    },
    [loadHistory, moveState, previewSuggestion, resetTransientState, session.id],
  );

  const backtrackTo = useCallback(
    async (targetNodeId: string) => {
      if (targetNodeId === node.id || mutationPendingRef.current) return;
      mutationPendingRef.current = true;
      setMutationPending(true);
      const generation = ++actionGeneration.current;
      const result = await requestBacktrack(session.id, {
        expectedCurrentNodeId: node.id,
        targetNodeId,
      });
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
    [loadHistory, node.id, resetTransientState, session.id],
  );

  /** Toolbar actions (N31): one command envelope, then the new current node and history. */
  const runToolbarCommand = useCallback<RunToolbarCommand>(
    async (action, envelope, summarize) => {
      if (mutationPendingRef.current) {
        return {
          ok: false,
          status: 0,
          code: "busy",
          message: "Another proof command is still running.",
        };
      }
      mutationPendingRef.current = true;
      setMutationPending(true);
      actionGeneration.current += 1;
      const outcome = await postProtocolCommand(session.id, envelope);
      if (!outcome.ok) {
        mutationPendingRef.current = false;
        setMutationPending(false);
        setNotice({ state: "rejected", message: describeCommandFailure(action, outcome) });
        void loadHistory();
        return outcome;
      }
      const current = await readCurrentSession(session.id);
      mutationPendingRef.current = false;
      setMutationPending(false);
      if (!current.ok || current.value.node.id !== outcome.response.cursor.nodeId) {
        setNotice({
          state: "rejected",
          message: `${action} was committed, but the new current node could not be loaded; reload the page.`,
        });
        void loadHistory();
        return outcome;
      }
      rejectShownPreview("superseded");
      setSession(current.value.session);
      setNode(current.value.node);
      resetTransientState();
      setNotice({
        state: "committed",
        message:
          summarize?.(outcome.response) ??
          `${action} committed${outcome.response.replayed ? " (already recorded)" : ""}; now at ${current.value.node.id}.`,
      });
      void loadHistory();
      return outcome;
    },
    [loadHistory, rejectShownPreview, resetTransientState, session.id],
  );

  // Library top-ups (architecture §2): "Find more results" for the current selections, and the
  // automatic request after a committed step first used a constant the library had no results for.
  const constantsRead = useSessionConstants(session.id, node.id);
  const topUp = useLibraryTopUp({
    sessionId: session.id,
    nodeId: node.id,
    enabled: aiLibrarian && !readOnly,
    activated:
      constantsRead.view.kind === "ready" ? constantsRead.view.constants.activated : undefined,
  });
  // Library results and previews may use library constants the proof does not have yet; they are
  // shown in their own notation, while the proof state itself uses only the proof's constants.
  const availableOperators = useMemo(
    () =>
      constantsRead.view.kind === "ready"
        ? constantsRead.view.constants.available
            .map(({ operator }) => operator)
            .filter(({ symbol }) => !session.operators.some((own) => own.symbol === symbol))
        : [],
    [constantsRead.view, session.operators],
  );
  const catalogOperators = useMemo(
    () => [...session.operators, ...availableOperators],
    [availableOperators, session.operators],
  );
  const catalogPresentation = usePresentation(catalogOperators, node.state);
  const findMoreResults = useCallback(() => {
    void topUp.findMoreResults(selections);
  }, [selections, topUp]);
  const findMoreDisabledReason = readOnly
    ? "This session is read-only, so its library cannot grow."
    : aiLibrarian
      ? undefined
      : "The library assistant is not set up for this service, so it cannot look for more results.";

  /** "Describe a move" on the shortlist's none-relevant notice: go to the description box. */
  const focusInstructions = useCallback(() => {
    const box = instructionsRef.current;
    if (box === null) return;
    box.scrollIntoView?.({ block: "center" });
    box.focus();
  }, []);

  /** The move-instruction box commits a plan like any other proof command: one at a time. */
  const beginExecutorApply = useCallback(() => {
    if (mutationPendingRef.current) return false;
    mutationPendingRef.current = true;
    setMutationPending(true);
    actionGeneration.current += 1;
    return true;
  }, []);
  const endExecutorApply = useCallback(() => {
    mutationPendingRef.current = false;
    setMutationPending(false);
  }, []);
  const adoptExecutorResult = useCallback(
    async ({ nodeId, stepCount }: Readonly<{ nodeId: string; stepCount: number }>) => {
      const current = await readCurrentSession(session.id);
      if (!current.ok || current.value.node.id !== nodeId) {
        setNotice({
          state: "rejected",
          message:
            "The steps were applied, but the new current node could not be loaded; reload the page.",
        });
        void loadHistory();
        return;
      }
      rejectShownPreview("superseded");
      setSession(current.value.session);
      setNode(current.value.node);
      resetTransientState();
      setNotice({
        state: "committed",
        message: `Applied ${stepCount} step${stepCount === 1 ? "" : "s"} from your description; now at ${nodeId}.`,
      });
      void loadHistory();
    },
    [loadHistory, rejectShownPreview, resetTransientState, session.id],
  );

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
  const panelActions = useMemo(
    () => ({
      onPreview: (set: DisplayedSuggestionSet, id: string) => void previewSuggestion(set, id),
      onChooseInputs: (set: DisplayedSuggestionSet, id: string) => void previewSuggestion(set, id),
      onSubmitChoices: (set: DisplayedSuggestionSet, id: string, choices: MenuChoices) =>
        void previewSuggestion(
          set,
          id,
          choices,
          moveState.kind === "choosing" && moveState.suggestionId === id
            ? moveState.menu
            : undefined,
        ),
      onCancelChoices: () => {
        actionGeneration.current += 1;
        setMoveState({ kind: "idle" });
      },
      onApply: (set: DisplayedSuggestionSet, id: string) => void applySuggestion(set, id),
      onInputSummaryExpanded: (set: DisplayedSuggestionSet, id: string) =>
        recordInteraction({
          kind: "menu-expanded",
          nodeId: node.id,
          suggestionSetId: set.id,
          suggestionId: suggestionIdSchema.parse(id),
        }),
    }),
    [applySuggestion, moveState, node.id, previewSuggestion, recordInteraction],
  );

  // Macro names and step counts are read once something on the page could be a multi-step move.
  const macrosWanted =
    (suggestions.kind === "ready" || suggestions.kind === "empty"
      ? suggestions.suggestionSet.suggestions.some(
          ({ source, artifactId }) => source === "move" && !artifactId.startsWith("move:"),
        )
      : false) ||
    (history.kind === "ready" && history.edges.some(({ edge }) => edge.macro !== undefined));
  const macros = useMacroInfo(session.id, macrosWanted);
  const suggestionCount =
    suggestions.kind === "ready" || suggestions.kind === "empty"
      ? suggestions.suggestionSet.suggestions.length
      : undefined;
  const suggestionsLink =
    suggestionCount === undefined
      ? undefined
      : {
          href: `#${SUGGESTION_PANEL_ID}`,
          text:
            suggestionCount === 0
              ? "No suggestions fit this selection (see below)"
              : `${suggestionCount} suggestion${suggestionCount === 1 ? "" : "s"} below`,
        };
  return (
    <section className={styles.storedWorkspace} aria-label="Stored proof session">
      <WorkspaceHeader
        sessionId={session.id}
        title={session.title}
        statement={session.statement}
        background={session.background}
        currentNodeId={node.id}
        counts={{ goals: node.state.goals.length, obligations: node.state.obligations.length }}
        readOnly={readOnly}
        breadcrumb={breadcrumb}
      />
      <WorkspaceToolbar
        view={view}
        onViewChange={setView}
        sessionId={session.id}
        node={node}
        readOnly={readOnly}
      >
        <details className={styles.proofActions}>
          <summary>More proof actions</summary>
          <ToolbarActionBar
            sessionId={session.id}
            readOnly={readOnly}
            node={node}
            rootNodeId={session.rootNodeId}
            operators={session.operators}
            selections={selections}
            history={history}
            macroNames={macroNames(macros)}
            mutationPending={mutationPending}
            presentation={presentation}
            view={view}
            runCommand={runToolbarCommand}
          />
        </details>
      </WorkspaceToolbar>
      <LibraryDrawer
        sessionId={session.id}
        presentation={catalogPresentation}
        view={view}
        gestures={drag.bindings}
      />
      <ConstantsPanel view={constantsRead.view} />
      {notice ? (
        <p className={styles.actionNotice} data-state={notice.state} role="status">
          {notice.message}
        </p>
      ) : null}
      <GestureTray
        bindings={drag.bindings}
        selections={selections}
        view={view}
        abstraction={abstraction}
      />
      <div className={styles.stateRow}>
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
            gestures={drag.bindings}
            selectionRequest={drag.selectionRequest}
            suggestionsLink={suggestionsLink}
          />
        </div>
        <MoveInstructions
          sessionId={session.id}
          node={node}
          operators={session.operators}
          selections={selections}
          presentation={presentation}
          view={view}
          enabled={aiExecutor}
          readOnly={readOnly}
          busy={mutationPending}
          textareaRef={instructionsRef}
          onApplyStart={beginExecutorApply}
          onApplyEnd={endExecutorApply}
          onApplied={adoptExecutorResult}
        />
      </div>

      {readOnly ? (
        <p className={styles.readOnlyReason} role="note" data-testid="read-only-reason">
          {READ_ONLY_REASON}: suggestions can be viewed but not applied.
        </p>
      ) : null}
      {/* "Find more results" is a library top-up (docs/ai-agents-architecture.md §2); where it is
          unavailable the button is disabled and says why. "Describe a move" is offered only when
          the move-instruction box can take a description. */}
      <SuggestionPanel
        suggestions={suggestions}
        move={moveState}
        mutationPending={mutationPending || readOnly}
        authorMovesHref={readOnly ? undefined : movesHref(session.id)}
        macros={macros}
        presentation={catalogPresentation}
        view={view}
        aiShortlist={
          aiShortlist && !readOnly ? { sessionId: session.id, nodeId: node.id } : undefined
        }
        onDescribeMove={aiExecutor && !readOnly ? focusInstructions : undefined}
        onFindMoreResults={findMoreResults}
        findMoreDisabledReason={findMoreDisabledReason}
        findMoreStatus={topUp.status}
        onAskAgain={() => handleSelectionChange(selections)}
        {...panelActions}
      />
      <InquiryPanel
        sessionId={session.id}
        node={node}
        history={history}
        selections={selections}
        suggestions={suggestions}
        move={moveState}
        mutationPending={mutationPending || readOnly}
        presentation={presentation}
        operators={session.operators}
        view={view}
        runCommand={runToolbarCommand}
      />
      <ConditionalLemmaPanel
        sessionId={session.id}
        view={view}
        readOnly={readOnly}
        busy={mutationPending}
        refreshKey={history}
      />
      <HistoryView
        history={history}
        currentNodeId={node.id}
        macros={macros}
        mutationPending={mutationPending || readOnly}
        presentation={presentation}
        view={view}
        onBacktrack={backtrackTo}
      />
    </section>
  );
}

type ReadOnlyPresentation = Readonly<{ presentation: Presentation; view: WorkspaceView }>;

function HistoryView({
  history,
  currentNodeId,
  macros,
  mutationPending,
  presentation,
  view,
  onBacktrack,
}: ReadOnlyPresentation &
  Readonly<{
    history: HistoryState;
    currentNodeId: string;
    macros: MacroInfoMap;
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
          {orderedHistory(history.nodes, history.edges).map(({ node, incoming, depth }) => {
            const link = incoming?.edge.macro;
            return (
              <Fragment key={node.id}>
                {link === undefined || link.stepIndex !== 1 ? null : (
                  <li
                    className={styles.historyMacroHeader}
                    data-macro-application={link.previewId}
                    style={{ paddingLeft: `${depth * 1.1}rem` }}
                  >
                    <strong>Macro: {macroDisplayName(link.moveId, macroNames(macros))}</strong>{" "}
                    <span>
                      {link.stepCount} steps applied as one move. Deleting the previous move removes
                      them all.
                    </span>
                  </li>
                )}
                <li
                  className={styles.historyItem}
                  data-macro-step={link?.stepIndex}
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
                        : link === undefined
                          ? `${incoming.name} · ${incoming.edge.transitionClass}${proposalNote(incoming.edge)} · ${node.id}`
                          : `${macroStepLabel(link, macroNames(macros))} · ${humanizeMoveId(incoming.name)} · ${incoming.edge.transitionClass} · ${node.id}`}
                    </small>
                  </button>
                </li>
              </Fragment>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

/** A step a model proposed and the user confirmed says so in the history. */
function proposalNote(edge: ProofEdge): string {
  if (edge.proposal === undefined) return "";
  const origin =
    edge.proposal.source === "user-proposal"
      ? "from your description"
      : "from a suggested technique";
  return ` · AI step ${edge.proposal.stepIndex} of ${edge.proposal.stepCount} ${origin}`;
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
      <StatementView
        expression={first.sequent.conclusion.expression}
        declarations={first.sequent.context.declarations}
        presentation={presentation}
        view={view}
      />
    </>
  );
}

/** The role of the selected occurrence (proposition, term or binder), or undefined if unresolved. */
function selectionRole(
  state: ProofNode["state"],
  operators: readonly OperatorDeclaration[],
  selection: AnchoredProofSelection,
): "proposition" | "term" | "binder" | undefined {
  const resolved = resolveProofSelection(state, selection, { operators });
  return resolved.ok ? resolved.selection.position.role : undefined;
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
    if (!parsed.data.ok) {
      return {
        ok: false,
        code: parsed.data.error.code,
        message: explainMacroFailure(parsed.data.error.code, parsed.data.error.message),
      };
    }
    const preview = createMovePreviewSchema({ operators }).safeParse(parsed.data.data.preview);
    return preview.success ? { ok: true, preview: preview.data } : invalidActionResponse();
  } catch {
    return { ok: false, message: "The preview service could not be reached." };
  }
}

async function requestApply(sessionId: string, choice: MoveChoiceRequest) {
  try {
    const response = await postChoice(sessionId, "commands", choice);
    const parsed = commandApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return invalidActionResponse();
    if (!parsed.data.ok) {
      return {
        ok: false as const,
        code: parsed.data.error.code,
        message: explainMacroFailure(parsed.data.error.code, parsed.data.error.message),
      };
    }
    // A step that applied a library result may have added constants to the proof: the node is
    // read in the operators the answer's session states, which include them.
    const node = createProofNodeSchema({
      operators: parsed.data.data.session.operators,
    }).safeParse(parsed.data.data.node);
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

async function requestHistory(sessionId: string) {
  try {
    const response = await fetch(`/api/proof-sessions/${encodeURIComponent(sessionId)}/history`, {
      cache: "no-store",
    });
    const parsed = proofHistoryApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return invalidActionResponse();
    if (!parsed.data.ok) return { ok: false as const, message: parsed.data.error.message };
    // The history is read in the operators its session states: later nodes may use constants
    // that steps added.
    const stated = parsed.data.data.session.operators;
    const nodes = parsed.data.data.nodes.map((value) =>
      createProofNodeSchema({ operators: stated }).safeParse(value),
    );
    const edges = parsed.data.data.edges.map(({ edge, name }) => ({
      name,
      parsed: createProofEdgeSchema({ operators: stated }).safeParse(edge),
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
    const node = createProofNodeSchema({
      operators: parsed.data.data.session.operators,
    }).safeParse(parsed.data.data.node);
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

function choicesKey(choices: MenuChoices): string {
  return JSON.stringify(Object.entries(choices).sort(([left], [right]) => (left < right ? -1 : 1)));
}

function withChoices(choice: MoveChoiceRequest, choices: MenuChoices): MoveChoiceRequest {
  return Object.keys(choices).length === 0 ? choice : { ...choice, menuChoices: choices };
}
