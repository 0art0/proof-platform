"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DisplayedSuggestionSet, OperatorDeclaration, ProofNode } from "@proof/protocol";
import type { LibraryEntry } from "../library-drawer/api-contract";
import { READ_ONLY_REASON, type HistoryEdge } from "../stored-proof-workspace/toolbar-actions";
import type { AuthoredMoveProvenance, AuthoredMoves, TemplateDiagnosticView } from "./api-contract";
import { describeAuthoringFailure, type AuthoringFailureView } from "./diagnostics";
import { ExamplesPanel } from "./examples-panel";
import { Help, Hint, StepHeading, WhyDisabled } from "./help";
import {
  readStashedMoveProposal,
  requestMoveProposal,
  stashMoveProposal,
  type MoveProposal,
} from "./proposal-contract";
import { ProposalPanel } from "./proposal-panel";
import {
  authorDraftEnvelope,
  type ProposalLink,
  authoringCommandId,
  fetchAuthoredMoves,
  fetchHistory,
  fetchSessionLibrary,
  fetchSuggestionSet,
  postAuthorDraft,
  requestTemplateValidation,
} from "./requests";
import { suggestionSetIdsOf } from "./recorded-paths";
import { RevisionsPanel } from "./revisions-panel";
import { SnapshotPanel } from "./snapshot-panel";
import { StartPanel } from "./start-panel";
import { TemplateForm } from "./template-form";
import {
  assembleTemplate,
  draftFromTemplate,
  parseDraft,
  type TemplateDraft,
} from "./template-builder";
import { DiagnosticList, ValidationPanel, type ValidationState } from "./validation-panel";
import styles from "./move-authoring.module.css";

export type MoveAuthoringProps = Readonly<{
  session: Readonly<{
    id: string;
    operators: readonly OperatorDeclaration[];
    /** An imported artifact: moves can be read but not authored or reviewed. */
    readOnly?: true | undefined;
  }>;
  /**
   * A model's proposal to open in the form ("Save as reusable move" in the workspace): the call ID
   * the workspace stashed the already-checked answer under.
   */
  proposalId?: string | undefined;
  /** Whether the proof service has a configured move author, so a proposal can be revised. */
  canRevise?: boolean | undefined;
}>;

type Loaded<Value> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; value: Value }>
  | Readonly<{ kind: "rejected"; message: string }>;

type HistoryData = Readonly<{
  nodes: readonly ProofNode[];
  edges: readonly HistoryEdge[];
  suggestionSets: ReadonlyMap<string, DisplayedSuggestionSet>;
}>;

/** The latest validation run, tagged with the template it ran on. */
type ValidationRun =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "running" }>
  | Readonly<{
      kind: "done";
      key: string;
      outcome: Extract<ValidationState, { kind: "done" }>["outcome"];
    }>;

const NO_DIAGNOSTICS: readonly TemplateDiagnosticView[] = Object.freeze([]);
const EMPTY_ARTIFACTS: readonly LibraryEntry[] = Object.freeze([]);

/**
 * Move authoring without AI (design plan §13.1, roadmap N35): a visual editor over stored data.
 * A draft is built from a recorded path or a primitive operation, patterns are picked from
 * selections in stored snapshots, examples are recorded paths and captured selections, and the
 * proof service validates the template by running its examples. Saving a draft and reviewing it
 * are N25 envelope commands, so the move becomes retrievable only after a recorded approval.
 */
export function MoveAuthoring({ session, proposalId, canRevise = false }: MoveAuthoringProps) {
  const readOnly = session.readOnly === true;
  const disabledReason = readOnly ? READ_ONLY_REASON : undefined;
  const [history, setHistory] = useState<Loaded<HistoryData>>({ kind: "loading" });
  const [authored, setAuthored] = useState<Loaded<AuthoredMoves>>({ kind: "loading" });
  const [artifacts, setArtifacts] = useState<readonly LibraryEntry[]>(EMPTY_ARTIFACTS);
  const [draft, setDraft] = useState<TemplateDraft>();
  const [source, setSource] = useState("");
  const [run, setRun] = useState<ValidationRun>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<AuthoringFailureView>();
  const [notice, setNotice] = useState<string>();
  // A model's proposal being edited: the proposal itself (read-only evidence) and the link that
  // the saved draft will carry as provenance. Starting from anything else drops both.
  const [proposal, setProposal] = useState<MoveProposal>();
  const [link, setLink] = useState<ProposalLink>();
  const [revising, setRevising] = useState(false);
  const [revisionFailure, setRevisionFailure] = useState<string>();
  const [proposalMissing, setProposalMissing] = useState(false);

  const loadAuthored = useCallback(async () => {
    const result = await fetchAuthoredMoves(session.id);
    setAuthored(
      result.ok
        ? { kind: "ready", value: result.value }
        : { kind: "rejected", message: result.message },
    );
  }, [session.id]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const result = await fetchHistory(session.id, session.operators, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setHistory({ kind: "rejected", message: result.message });
        return;
      }
      // The suggestion sets the stored edges were applied from; they are read, never rebuilt.
      const ids = suggestionSetIdsOf(result.value.edges);
      const sets = await Promise.all(
        ids.map(async (id) => ({
          id,
          result: await fetchSuggestionSet(session.id, id, controller.signal),
        })),
      );
      if (controller.signal.aborted) return;
      const suggestionSets = new Map<string, DisplayedSuggestionSet>();
      for (const { id, result: set } of sets) {
        if (set.ok) suggestionSets.set(id, set.value);
      }
      setHistory({ kind: "ready", value: { ...result.value, suggestionSets } });
    })();
    void loadAuthored();
    void fetchSessionLibrary(session.id, controller.signal).then((result) => {
      if (!controller.signal.aborted && result.ok) setArtifacts(result.value.entries);
    });
    return () => controller.abort();
  }, [loadAuthored, session.id, session.operators]);

  const templateKey = useMemo(
    () => (draft === undefined ? undefined : JSON.stringify(assembleTemplate(draft))),
    [draft],
  );

  const edit = (next: TemplateDraft) => {
    setDraft(next);
    setSaveFailure(undefined);
    setNotice(undefined);
  };

  const start = (next: TemplateDraft, from: string, provenance?: ProposalLink) => {
    setRun({ kind: "idle" });
    setSaveFailure(undefined);
    setNotice(undefined);
    setDraft(next);
    setSource(from);
    setProposal(undefined);
    setLink(provenance);
  };

  /** Open a proposal in the ordinary form, prefilled; the proposal stays beside it as evidence. */
  const openProposal = useCallback((opened: MoveProposal) => {
    setProposal(opened);
    setLink({ callId: opened.callId, executorCallId: opened.executorCallId });
    setRun({ kind: "idle" });
    setSaveFailure(undefined);
    setRevisionFailure(undefined);
    const loaded = draftFromTemplate(opened.template);
    if (loaded === undefined) {
      setDraft(undefined);
      setNotice(
        "The proposal is not well formed enough to edit as a move. The checks below say why; ask the model for a revision.",
      );
      return;
    }
    setDraft(loaded);
    setSource("the model's proposal");
    setNotice(undefined);
  }, []);

  useEffect(() => {
    if (proposalId === undefined) return;
    const stashed = readStashedMoveProposal(session.id, proposalId);
    if (stashed === undefined) setProposalMissing(true);
    else openProposal(stashed);
  }, [openProposal, proposalId, session.id]);

  const reviseProposal = async (feedback: string) => {
    if (proposal === undefined) return;
    setRevising(true);
    setRevisionFailure(undefined);
    const outcome = await requestMoveProposal(session.id, {
      id: `llm-call:author-${crypto.randomUUID()}`,
      executorCallId: proposal.executorCallId,
      revision: { previousCallId: proposal.callId, feedback },
    });
    setRevising(false);
    if (outcome.kind === "error") {
      setRevisionFailure(outcome.message);
      return;
    }
    if (outcome.kind === "model-note") {
      setRevisionFailure(
        outcome.tone === "needs-detail"
          ? `The model needs more detail: ${outcome.message}`
          : `The model did not revise the proposal: ${outcome.message}`,
      );
      return;
    }
    if (stashMoveProposal(session.id, outcome.proposal)) {
      // Keep the address in step with what is open, so a reload opens the same proposal.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?proposal=${encodeURIComponent(outcome.proposal.callId)}`,
      );
    }
    openProposal(outcome.proposal);
    setNotice("The form now holds the revised proposal.");
  };

  const validate = async () => {
    if (draft === undefined || templateKey === undefined) return;
    setRun({ kind: "running" });
    const outcome = await requestTemplateValidation(session.id, assembleTemplate(draft));
    setRun({ kind: "done", key: templateKey, outcome });
  };

  const save = async () => {
    if (draft === undefined) return;
    setSaving(true);
    setSaveFailure(undefined);
    setNotice(undefined);
    const outcome = await postAuthorDraft(
      session.id,
      authorDraftEnvelope(authoringCommandId("author"), assembleTemplate(draft), link),
    );
    setSaving(false);
    if (!outcome.ok) {
      setSaveFailure(describeAuthoringFailure("Save draft", outcome));
      return;
    }
    const advisory = outcome.result.validation.ok
      ? "It passes validation."
      : `Validation still reports ${outcome.result.validation.diagnostics.length} problem${
          outcome.result.validation.diagnostics.length === 1 ? "" : "s"
        }, so it cannot be approved yet.`;
    setNotice(
      `Saved revision ${outcome.result.revision} of ${outcome.result.moveId} as a draft${
        link === undefined ? "" : ", linked to the model's proposal"
      }. ${advisory}`,
    );
    void loadAuthored();
  };

  const validation: ValidationState =
    run.kind === "done"
      ? { kind: "done", stale: run.key !== templateKey, outcome: run.outcome }
      : run;
  const parsed = draft === undefined ? undefined : parseDraft(draft);
  // Diagnostics of the latest check are shown beside the fields they concern, until the move
  // changes; they then describe an older version.
  const shownDiagnostics =
    validation.kind === "done" &&
    !validation.stale &&
    validation.outcome.ok &&
    !validation.outcome.value.ok
      ? validation.outcome.value.diagnostics
      : NO_DIAGNOSTICS;
  const proposalBlocked =
    proposal?.blocked !== undefined && link?.callId === proposal.callId
      ? "The model classes this as a new mathematical principle, which a move cannot add. Ask for a revision, or start from a recorded step."
      : undefined;
  const saveReason = readOnly
    ? READ_ONLY_REASON
    : proposalBlocked !== undefined
      ? proposalBlocked
      : parsed !== undefined && !parsed.ok
        ? `Complete the move first: ${parsed.problems[0] ?? "see the problems listed under the name"}.`
        : undefined;
  const validateBlocked =
    draft === undefined
      ? "Start a move first."
      : parsed !== undefined && !parsed.ok
        ? "Complete the template first."
        : undefined;

  const revise = (
    template: Readonly<Record<string, unknown>>,
    provenance?: AuthoredMoveProvenance,
  ) => {
    const loaded = draftFromTemplate(template);
    if (loaded === undefined) {
      setNotice("This stored revision is not a well-formed template and cannot be edited.");
      return;
    }
    // A revision of a model's proposal stays linked to it.
    const callId = provenance?.["contextId"];
    const executorCallId = provenance?.["sourceContextId"];
    start(
      loaded,
      "a saved revision",
      provenance?.["role"] === "move-author" &&
        typeof callId === "string" &&
        typeof executorCallId === "string"
        ? { callId, executorCallId }
        : undefined,
    );
  };

  return (
    <div className={styles.page} data-testid="move-authoring">
      <header className={styles.pageHeader}>
        <h1>Author moves</h1>
        <Link href={`/sessions/${encodeURIComponent(session.id)}`}>
          Back to the proof workspace
        </Link>
      </header>
      <Hint>
        A move is a reusable step: select something in the proof, and the move is offered as a
        suggestion. You build one from steps you already took, show the kernel it works, and have it
        approved.
      </Hint>
      <Help summary="How does this page work? (six short steps)">
        <ol>
          <li>Start from a step you already did, or from one basic operation.</li>
          <li>Name and describe the move, and say what kind of step it is.</li>
          <li>Add examples: two that should work and one that shouldn&apos;t.</li>
          <li>Check the move: the kernel runs every example.</li>
          <li>Save it as a draft.</li>
          <li>
            Review it: approve, reject, or ask for changes. Approved moves become suggestions.
          </li>
        </ol>
        <p>Nothing here changes your proof; moves only add suggestions.</p>
      </Help>
      {proposalMissing ? (
        <p role="note" className={styles.muted} data-testid="proposal-missing">
          That proposal is no longer available in this browser tab. Go back to the proof workspace
          and choose “Save as reusable move” on the step again.
        </p>
      ) : null}
      {readOnly ? (
        <p role="note" className={styles.muted} data-testid="read-only-reason">
          {READ_ONLY_REASON}: authored moves can be read but not created or reviewed.
        </p>
      ) : null}
      {notice === undefined ? null : (
        <p role="status" className={styles.notice} data-testid="authoring-notice">
          {notice}
        </p>
      )}

      {history.kind === "loading" ? (
        <p role="status" className={styles.muted}>
          Loading the recorded history…
        </p>
      ) : history.kind === "rejected" ? (
        <p role="alert" className={styles.error}>
          The recorded history could not be read: {history.message}
        </p>
      ) : (
        <>
          <StartPanel
            nodes={history.value.nodes}
            edges={history.value.edges}
            operators={session.operators}
            suggestionSets={history.value.suggestionSets}
            disabledReason={disabledReason}
            onStart={start}
          />
          {proposal === undefined ? null : (
            <ProposalPanel
              proposal={proposal}
              reviseBlocked={
                readOnly
                  ? READ_ONLY_REASON
                  : canRevise
                    ? undefined
                    : "Revising is unavailable: no AI provider is configured for this service."
              }
              revising={revising}
              revisionFailure={revisionFailure}
              onRevise={(feedback) => void reviseProposal(feedback)}
            />
          )}
          {draft === undefined ? null : (
            <>
              <p className={styles.muted} data-testid="draft-source">
                Editing a draft started from {source}.
              </p>
              <TemplateForm
                draft={draft}
                onChange={edit}
                artifacts={artifacts}
                diagnostics={shownDiagnostics}
                disabled={saving || readOnly}
              />
              <SnapshotPanel
                nodes={history.value.nodes}
                operators={session.operators}
                draft={draft}
                onChange={edit}
                disabled={saving || readOnly}
              />
              <ExamplesPanel
                draft={draft}
                onChange={edit}
                nodes={history.value.nodes}
                edges={history.value.edges}
                operators={session.operators}
                suggestionSets={history.value.suggestionSets}
                diagnostics={shownDiagnostics}
                disabled={saving || readOnly}
              />
              <ValidationPanel
                state={validation}
                unavailableReason={validateBlocked}
                onValidate={() => void validate()}
              />
              <section className={styles.panel} aria-label="Save">
                <StepHeading step={5}>Save as a draft</StepHeading>
                <Hint>
                  Saving records your move in this session as a draft. A draft is never offered as a
                  suggestion until it has been reviewed and approved below. You can save before the
                  check passes, but it cannot be approved until it does.
                </Hint>
                <div className={styles.inline}>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={saving || saveReason !== undefined}
                    onClick={() => void save()}
                  >
                    {saving ? "Saving…" : "Save draft"}
                  </button>
                  <WhyDisabled reason={saveReason} />
                </div>
                {saveFailure === undefined ? null : (
                  <div role="alert" data-testid="save-refusal">
                    <p className={styles.error}>{saveFailure.message}</p>
                    {saveFailure.diagnostics.length === 0 ? null : (
                      <DiagnosticList
                        diagnostics={saveFailure.diagnostics}
                        label="Why it was refused"
                      />
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}

      {authored.kind === "loading" ? (
        <p role="status" className={styles.muted}>
          Loading authored moves…
        </p>
      ) : authored.kind === "rejected" ? (
        <p role="alert" className={styles.error}>
          Authored moves could not be read: {authored.message}
        </p>
      ) : (
        <RevisionsPanel
          numbered={draft !== undefined}
          sessionId={session.id}
          moves={authored.value.moves}
          disabledReason={disabledReason}
          onRevise={revise}
          onReviewed={(message) => {
            setNotice(message);
            void loadAuthored();
          }}
        />
      )}
    </div>
  );
}
