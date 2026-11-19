"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { createPresentation, notationRoundTrips, type Presentation } from "@proof/language";
import {
  createProofNodeSchema,
  operatorDeclarationSchema,
  type BackgroundProfile,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProblemDraft,
  type ProblemSetupOptions,
  type ProblemSetupReview,
  type ProofNode,
} from "@proof/protocol";
import { z } from "zod";
import {
  draftStatementRows,
  emptyProblemForm,
  problemTitle,
  withBackgroundProfile,
  type AcceptedBackground,
  type ApprovedLibrary,
  type ProblemForm,
} from "./draft-form";
import {
  approveBackground,
  approveLibrary,
  buildLibrary,
  checkSetup,
  draftSetup,
  proposeBackground,
  startSession,
  type ApprovalReferences,
  type BackgroundAmendment,
  type BackgroundProposal,
  type BuiltLibrary,
  type LibraryResult,
} from "./guided-requests";
import {
  appliedSymbols,
  editedOperator,
  filledTemplate,
  templateIssue,
  type ConstantEdit,
} from "./notation-edit";
import { ProblemEntryForm, type ProblemEntryFormProps } from "./problem-entry-form";
import { PromptTip } from "./prompt-tip";
import { recordRecentSession } from "./recent-sessions";
import { SetupStatements } from "./setup-statements";
import { Formula } from "./typeset";
import styles from "./problem-entry.module.css";

export type GuidedProblemEntryProps = Readonly<{
  options: ProblemSetupOptions;
  /** Which later roles the proof service offers; the background proposer is required. */
  capabilities: Readonly<{ library: boolean; formalizer: boolean }>;
  /** What each role is told, shown behind an ⓘ. */
  prompts?: Readonly<{ background?: string | undefined; library?: string | undefined }>;
  initialStatement?: string;
  initialTitle?: string;
  navigate?: (url: string) => void;
  createId?: (prefix: string) => string;
  createSessionId?: () => string;
}>;

type Problem = Readonly<{ title: string; statement: string }>;
type Pending = Readonly<{ kind: "idle" }> | Readonly<{ kind: "loading" }>;
type Failed = Readonly<{ kind: "failed"; message: string }>;
type BackgroundState =
  | Pending
  | Failed
  | Readonly<{ kind: "ready"; callId: string; proposal: BackgroundProposal; problem: Problem }>;
type LibraryState = Pending | Failed | Readonly<{ kind: "ready"; built: BuiltLibrary }>;
type ProfileEdit = Readonly<{ level: string; summary: string; assumptions: string }>;
type StartState = Readonly<{ kind: "idle" }> | Readonly<{ kind: "running"; step: string }> | Failed;
type Handover = NonNullable<ProblemEntryFormProps["handover"]>;

type CheckedSetup = Readonly<{
  sessionId: string;
  draft: ProblemDraft;
  review: ProblemSetupReview;
  references: ApprovalReferences;
  node: ProofNode;
  presentation: Presentation;
  edit: Handover;
}>;

/** Propose the background and library, then let the person review the checked formal setup. */
export function GuidedProblemEntry({
  options,
  capabilities,
  prompts = {},
  initialStatement = "",
  initialTitle = "",
  navigate = (url) => window.location.assign(url),
  createId = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  createSessionId = () => `session:${crypto.randomUUID()}`,
}: GuidedProblemEntryProps) {
  const [constructionId] = useState(() => createId("construction:web"));
  const [statement, setStatement] = useState(initialStatement);
  const [title, setTitle] = useState(initialTitle);
  const [titleOpen, setTitleOpen] = useState(initialTitle.length > 0);
  const [background, setBackground] = useState<BackgroundState>({ kind: "idle" });
  const [profile, setProfile] = useState<ProfileEdit>();
  const [edits, setEdits] = useState<Readonly<Record<string, ConstantEdit>>>({});
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [feedback, setFeedback] = useState("");
  const [library, setLibrary] = useState<LibraryState>({ kind: "idle" });
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [start, setStart] = useState<StartState>({ kind: "idle" });
  const [handover, setHandover] = useState<Handover>();
  const [checkedSetup, setCheckedSetup] = useState<CheckedSetup>();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (checkedSetup !== undefined) reviewHeading.current?.focus();
  }, [checkedSetup]);
  const unknownCommands = useUnknownCommands();
  // Only the latest request of each kind may update the page.
  const generation = useRef(0);

  const problem: Problem = {
    title: problemTitle({ title, statement }),
    statement: statement.trim(),
  };
  const asked = background.kind === "ready" ? background.problem : undefined;
  const statementChanged =
    asked !== undefined && (asked.statement !== problem.statement || asked.title !== problem.title);

  const propose = async (
    forProblem: Problem,
    revision?: Readonly<{ previousCallId: string; feedback: string }>,
  ) => {
    const current = (generation.current += 1);
    setBackground({ kind: "loading" });
    setLibrary({ kind: "idle" });
    setStart({ kind: "idle" });
    const answer = await proposeBackground({
      constructionId,
      createId,
      problem: forProblem,
      revision,
    });
    if (generation.current !== current) return;
    if (!answer.ok) return setBackground({ kind: "failed", message: answer.message });
    setBackground({
      kind: "ready",
      callId: answer.callId,
      proposal: answer.proposal,
      problem: forProblem,
    });
    setProfile({
      level: answer.proposal.background.level,
      summary: answer.proposal.background.summary,
      assumptions: answer.proposal.background.assumptions.join("\n"),
    });
    setEdits({});
    setRemoved(new Set());
    setFeedback("");
    if (capabilities.library) void build(answer.callId, current);
  };

  const build = async (backgroundCallId: string, current = generation.current) => {
    setLibrary({ kind: "loading" });
    setUnticked(new Set());
    const answer = await buildLibrary({ constructionId, createId, backgroundCallId });
    if (generation.current !== current) return;
    setLibrary(
      answer.ok ? { kind: "ready", built: answer } : { kind: "failed", message: answer.message },
    );
  };

  // A statement typed on the landing page is already decided: ask for its background at once.
  const askedOnOpen = useRef(false);
  const askOnOpen = useEffectEvent(() => {
    if (askedOnOpen.current || initialStatement.trim().length === 0) return;
    askedOnOpen.current = true;
    void propose({
      title: problemTitle({ title: initialTitle, statement: initialStatement }),
      statement: initialStatement.trim(),
    });
  });
  useEffect(() => {
    askOnOpen();
  }, []);

  const packOperators = useMemo(() => allPackOperators(options), [options]);
  const registrySymbols = useMemo(
    () => new Set(packOperators.all.map(({ symbol }) => symbol)),
    [packOperators],
  );

  const proposal = background.kind === "ready" ? background.proposal : undefined;
  const constants = useMemo(
    () =>
      (proposal?.constants ?? []).map((constant) => {
        const { operator } = constant;
        const fromPack = registrySymbols.has(operator.symbol);
        const edit = edits[operator.id];
        const arity = operator.signature.parameters.length;
        const edited = fromPack || edit === undefined ? operator : editedOperator(operator, edit);
        const template = edited.presentation?.latex?.template ?? "";
        const issue = fromPack
          ? undefined
          : (templateIssue(template, arity, unknownCommands) ??
            (notationRoundTrips(edited)
              ? undefined
              : `Typed, this would read as something else; try \\operatorname{${operator.symbol}}.`));
        return { constant, fromPack, edited, removed: removed.has(operator.id), issue };
      }),
    [proposal, edits, removed, registrySymbols, unknownCommands],
  );
  const kept = constants.filter((entry) => !entry.removed);
  const removedSymbols = new Set(
    constants.filter((entry) => entry.removed).map(({ constant }) => constant.operator.symbol),
  );
  const built = library.kind === "ready" ? library.built : undefined;

  const presentation = useMemo(() => {
    const operators = uniqueBySymbol([
      ...packOperators.active,
      ...kept.map(({ edited }) => edited),
      ...(built?.newConstants ?? []).map(({ operator }) => operator),
    ]);
    try {
      return createPresentation({ operators });
    } catch {
      return undefined;
    }
  }, [packOperators, kept, built]);

  const results = (built?.results ?? []).map((result) => {
    const symbols = new Set([
      ...appliedSymbols(result.artifact.statement.expression),
      ...result.artifact.premises.flatMap(({ expression }) => [...appliedSymbols(expression)]),
    ]);
    const blocked = [...symbols].some((symbol) => removedSymbols.has(symbol));
    return { result, blocked, kept: !blocked && !unticked.has(result.artifact.id) };
  });
  const keptResults = results.filter((entry) => entry.kept).map(({ result }) => result);

  const profileValue: BackgroundProfile | undefined =
    proposal === undefined || profile === undefined
      ? undefined
      : {
          ...proposal.background,
          level: profile.level.trim(),
          summary: profile.summary.trim(),
          assumptions: lines(profile.assumptions),
        };
  const issues = kept.flatMap(({ issue }) => (issue === undefined ? [] : [issue]));
  const profileMissing =
    profileValue === undefined || profileValue.level === "" || profileValue.summary === "";
  const running = start.kind === "running";
  const libraryBusy = library.kind === "loading";
  const canPrepare =
    background.kind === "ready" &&
    !statementChanged &&
    issues.length === 0 &&
    !profileMissing &&
    !running &&
    !libraryBusy;

  const prepareSetup = async () => {
    if (!canPrepare || proposal === undefined || profileValue === undefined) return;
    const edited = kept.map(({ edited: operator }) => operator);
    const amended =
      !jsonEqual(profileValue, proposal.background) ||
      kept.length !== proposal.constants.length ||
      kept.some(({ edited: operator, constant }) => !jsonEqual(operator, constant.operator));
    const amendment: BackgroundAmendment | undefined = amended
      ? { background: profileValue, constants: edited }
      : undefined;

    setStart({ kind: "running", step: "Saving background…" });
    const backgroundDecisionId = createId("background-decision");
    const approved = await approveBackground({
      constructionId,
      decisionId: backgroundDecisionId,
      callId: background.callId,
      amendment,
    });
    if (!approved.ok) return setStart({ kind: "failed", message: approved.message });
    const accepted: AcceptedBackground = {
      decisionId: backgroundDecisionId,
      callId: background.callId,
      profile: profileValue,
      constants: kept.map(({ edited: operator, constant }) => ({
        operator,
        rationale: constant.rationale,
      })),
    };

    let approvedLibrary: ApprovedLibrary | undefined;
    if (built !== undefined && keptResults.length > 0) {
      const libraryDecisionId = createId("library-decision");
      const recorded = await approveLibrary({
        constructionId,
        decisionId: libraryDecisionId,
        callId: built.callId,
        resultIds: keptResults.map(({ artifact }) => artifact.id),
      });
      if (!recorded.ok) return setStart({ kind: "failed", message: recorded.message });
      const used = new Set(keptResults.flatMap(({ newConstantSymbols }) => newConstantSymbols));
      approvedLibrary = {
        decisionId: libraryDecisionId,
        callId: built.callId,
        backgroundDecisionId,
        results: keptResults.map(({ artifact }) => ({ id: artifact.id, name: artifact.name })),
        variantCount: recorded.variantCount,
        constants: built.newConstants
          .map(({ operator }) => operator)
          .filter(({ symbol }) => used.has(symbol)),
      };
    }

    const buildHandover = (
      reason: string,
      draft?: Readonly<{ callId: string; draft: ProblemDraft }>,
    ): Handover => {
      let key = 1000;
      const form: Partial<ProblemForm> = {
        title,
        statement,
        ...withBackgroundProfile(profileValue),
        layerIds: [...layerIds(options)],
        ...(draft === undefined ? {} : draftStatementRows(draft.draft, () => (key += 1))),
      };
      return {
        form,
        constructionId,
        accepted,
        approvedLibrary,
        draftCallId: draft?.callId,
        reason,
      };
    };
    const handTo = (...args: Parameters<typeof buildHandover>) =>
      setHandover(buildHandover(...args));
    if (!capabilities.formalizer) {
      return handTo("Background approved. Now enter what to prove, then check the setup.");
    }

    setStart({ kind: "running", step: "Formalizing the problem…" });
    const drafted = await draftSetup({
      constructionId,
      createId,
      context: {
        problem,
        background: profileValue,
        libraryLayerIds: [...layerIds(options)],
        packs: [],
      },
      backgroundDecisionId,
      libraryDecisionId: approvedLibrary?.decisionId,
    });
    if (!drafted.ok) {
      return "draft" in drafted
        ? handTo(`The drafted setup needs a look: ${drafted.message}`, drafted)
        : handTo(`The setup could not be drafted (${drafted.message}). Enter it here.`);
    }

    setStart({ kind: "running", step: "Checking the formal setup…" });
    const references: ApprovalReferences = {
      approvedBackground: { constructionId, decisionId: backgroundDecisionId },
      ...(approvedLibrary === undefined
        ? {}
        : { approvedLibrary: { constructionId, decisionId: approvedLibrary.decisionId } }),
    };
    const checked = await checkSetup(drafted.draft, references);
    if (!checked.ok) {
      return handTo(`The drafted setup needs a look: ${checked.message}`, drafted);
    }

    const operators = z.array(operatorDeclarationSchema).safeParse(checked.review.operators);
    if (!operators.success)
      return handTo("The setup could not be displayed. Check it here.", drafted);
    const node = createProofNodeSchema({ operators: operators.data }).safeParse(
      checked.review.rootNode,
    );
    if (!node.success) return handTo("The setup could not be displayed. Check it here.", drafted);

    setCheckedSetup({
      sessionId: createSessionId(),
      draft: drafted.draft,
      review: checked.review,
      references,
      node: node.data,
      presentation: createPresentation({ operators: operators.data }),
      edit: buildHandover(
        "Edit the variables, hypotheses or goals, then check the setup.",
        drafted,
      ),
    });
    setStart({ kind: "idle" });
  };

  const openWorkspace = async (setup: CheckedSetup) => {
    setStart({ kind: "running", step: "Opening workspace…" });
    const started = await startSession(setup);
    if (!started.ok) return setStart({ kind: "failed", message: started.message });
    recordRecentSession({ id: setup.sessionId, title: setup.review.metadata.problem.title });
    navigate(`/sessions/${encodeURIComponent(setup.sessionId)}`);
  };

  if (handover !== undefined) {
    return (
      <ProblemEntryForm
        options={options}
        navigate={navigate}
        createSessionId={createSessionId}
        handover={handover}
      />
    );
  }

  if (checkedSetup !== undefined) {
    return (
      <section className={styles.review} aria-labelledby="formal-setup-heading">
        <h2 id="formal-setup-heading" ref={reviewHeading} tabIndex={-1}>
          Review the formal setup
        </h2>
        <p className={styles.originalStatement}>{problem.statement}</p>
        <dl className={styles.reviewList}>
          <SetupStatements
            node={checkedSetup.node}
            presentation={checkedSetup.presentation}
            sorts={options.sorts}
          />
        </dl>
        <div className={styles.reviewFooter}>
          {start.kind === "failed" ? (
            <p role="alert" className={styles.inlineError}>
              {start.message}
            </p>
          ) : null}
          <button
            type="button"
            className={styles.secondary}
            disabled={running}
            onClick={() => setHandover(checkedSetup.edit)}
          >
            Edit setup
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={running}
            onClick={() => void openWorkspace(checkedSetup)}
          >
            {start.kind === "running" ? start.step : "Open workspace"}
          </button>
        </div>
      </section>
    );
  }

  const statementFilled = problem.statement.length > 0;
  return (
    <fieldset aria-label="Prepare problem" className={styles.guided} disabled={running}>
      <form
        className={styles.statementCard}
        aria-label="Problem"
        onSubmit={(event) => {
          event.preventDefault();
          if (statementFilled && !running && background.kind !== "loading") void propose(problem);
        }}
      >
        <label htmlFor="guided-statement" className={styles.label}>
          Problem statement
        </label>
        <textarea
          id="guided-statement"
          className={styles.statementInput}
          placeholder="Show that any two consecutive integers are coprime."
          rows={3}
          value={statement}
          onChange={(event) => setStatement(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              statementFilled &&
              !running &&
              background.kind !== "loading"
            ) {
              event.preventDefault();
              void propose(problem);
            }
          }}
        />
        <div className={styles.statementFooter}>
          {titleOpen ? (
            <input
              className={styles.titleInput}
              aria-label="Title"
              placeholder="Title"
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          ) : (
            <button type="button" className={styles.quietButton} onClick={() => setTitleOpen(true)}>
              + Add title
            </button>
          )}
          {background.kind === "idle" || statementChanged ? (
            <button
              type="submit"
              className={statementChanged ? styles.secondary : styles.primary}
              disabled={!statementFilled}
            >
              {statementChanged ? "Refresh setup" : "Suggest a background"}
            </button>
          ) : null}
        </div>
      </form>

      {background.kind === "idle" ? null : (
        <section
          className={styles.stepCard}
          aria-label="Background"
          aria-busy={background.kind === "loading"}
        >
          <header className={styles.stepHeader}>
            <h2>Background</h2>
            <PromptTip label="Background proposer" prompt={prompts.background} />
          </header>
          {background.kind === "loading" ? (
            <p role="status" className={styles.pending}>
              Suggesting a background…
            </p>
          ) : null}
          {background.kind === "failed" ? (
            <div role="alert" className={styles.inlineError}>
              {background.message}{" "}
              <button
                type="button"
                className={styles.quietButton}
                onClick={() => void propose(problem)}
              >
                Try again
              </button>
            </div>
          ) : null}
          {background.kind === "ready" && profile !== undefined ? (
            <>
              <div className={styles.profileGrid}>
                <label className={styles.compactField}>
                  <span>Level</span>
                  <input
                    value={profile.level}
                    onChange={(event) => {
                      const level = event.currentTarget.value;
                      setProfile((previous) => previous && { ...previous, level });
                    }}
                  />
                </label>
                <label className={styles.compactField}>
                  <span>Summary</span>
                  <textarea
                    aria-label="Background summary"
                    rows={2}
                    value={profile.summary}
                    onChange={(event) => {
                      const summary = event.currentTarget.value;
                      setProfile((previous) => previous && { ...previous, summary });
                    }}
                  />
                </label>
                <label className={styles.compactField}>
                  <span>Assumptions</span>
                  <textarea
                    aria-label="Background assumptions"
                    rows={Math.max(2, lines(profile.assumptions).length)}
                    placeholder="One per line"
                    value={profile.assumptions}
                    onChange={(event) => {
                      const assumptions = event.currentTarget.value;
                      setProfile((previous) => previous && { ...previous, assumptions });
                    }}
                  />
                </label>
              </div>

              {constants.length === 0 ? null : (
                <ul className={styles.constantList} aria-label="Notation">
                  {constants.map((entry) => (
                    <ConstantRow
                      key={entry.constant.operator.id}
                      entry={entry}
                      edit={editOf(entry.constant.operator, edits[entry.constant.operator.id])}
                      onEdit={(edit) =>
                        setEdits((previous) => ({
                          ...previous,
                          [entry.constant.operator.id]: edit,
                        }))
                      }
                      onToggle={() =>
                        setRemoved((previous) => toggled(previous, entry.constant.operator.id))
                      }
                    />
                  ))}
                </ul>
              )}

              <form
                className={styles.reviseRow}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (feedback.trim().length === 0) return;
                  void propose(background.problem, {
                    previousCallId: background.callId,
                    feedback: feedback.trim(),
                  });
                }}
              >
                <input
                  aria-label="Ask for a change"
                  placeholder="Ask for a change…"
                  value={feedback}
                  onChange={(event) => setFeedback(event.currentTarget.value)}
                />
                <button
                  type="submit"
                  className={styles.quietButton}
                  disabled={feedback.trim().length === 0}
                >
                  Revise
                </button>
              </form>
            </>
          ) : null}
        </section>
      )}

      {capabilities.library && background.kind === "ready" ? (
        <section className={styles.stepCard} aria-label="Library" aria-busy={libraryBusy}>
          <header className={styles.stepHeader}>
            <h2>Library</h2>
            <PromptTip label="Librarian" prompt={prompts.library} />
          </header>
          {library.kind === "loading" ? (
            <p role="status" className={styles.pending}>
              Finding library results…
            </p>
          ) : null}
          {library.kind === "failed" ? (
            <div role="alert" className={styles.inlineError}>
              {library.message}{" "}
              <button
                type="button"
                className={styles.quietButton}
                onClick={() => void build(background.callId)}
              >
                Try again
              </button>
            </div>
          ) : null}
          {built !== undefined && built.results.length === 0 ? (
            <p className={styles.libraryNote}>
              No library this time{built.note === undefined ? "." : `: ${built.note}`} The proof can
              start without one.
            </p>
          ) : null}
          {built === undefined || built.results.length === 0 ? null : (
            <details className={styles.libraryResults}>
              <summary>
                Review suggested results{" "}
                <span className={styles.count}>
                  {keptResults.length} of {built.results.length} selected
                </span>
              </summary>
              <ul className={styles.resultList}>
                {results.map(({ result, blocked, kept: isKept }) => (
                  <ResultRow
                    key={result.artifact.id}
                    result={result}
                    presentation={presentation}
                    kept={isKept}
                    blocked={blocked}
                    onToggle={() =>
                      setUnticked((previous) => toggled(previous, result.artifact.id))
                    }
                  />
                ))}
              </ul>
            </details>
          )}
        </section>
      ) : null}

      {background.kind === "ready" ? (
        <div className={styles.startBar}>
          {start.kind === "failed" ? (
            <p role="alert" className={styles.inlineError}>
              {start.message}
            </p>
          ) : null}
          {issues.length > 0 ? <p className={styles.startNote}>Fix the notation above.</p> : null}
          {profileMissing ? (
            <p className={styles.startNote}>The background needs a level and a summary.</p>
          ) : null}
          {start.kind === "running" ? (
            <p role="status" className={styles.startNote}>
              {start.step}
            </p>
          ) : null}
          <button
            type="button"
            className={styles.primary}
            disabled={!canPrepare}
            onClick={() => void prepareSetup()}
          >
            {capabilities.formalizer ? "Review setup" : "Enter formal setup"}
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}

function ConstantRow({
  entry,
  edit,
  onEdit,
  onToggle,
}: Readonly<{
  entry: Readonly<{
    constant: Readonly<{ operator: OperatorDeclaration; rationale: string }>;
    fromPack: boolean;
    edited: OperatorDeclaration;
    removed: boolean;
    issue: string | undefined;
  }>;
  edit: ConstantEdit;
  onEdit: (edit: ConstantEdit) => void;
  onToggle: () => void;
}>) {
  const { constant, fromPack, edited, removed, issue } = entry;
  const arity = constant.operator.signature.parameters.length;
  const name = edited.presentation?.displayName ?? constant.operator.symbol;
  const preview = filledTemplate(edited.presentation?.latex?.template ?? "", arity);
  return (
    <li className={styles.constantRow} data-removed={removed} title={constant.rationale}>
      <span className={styles.constantPreview}>
        {issue === undefined ? <Formula latex={preview} /> : <code>{preview}</code>}
      </span>
      {removed ? (
        <span className={styles.constantName}>
          <s>{name}</s>
        </span>
      ) : fromPack ? (
        <span className={styles.constantName}>
          {name} <em className={styles.hint}>standard notation</em>
        </span>
      ) : (
        <span className={styles.constantFields}>
          <input
            aria-label={`Name of ${constant.operator.symbol}`}
            value={edit.displayName}
            onChange={(event) => onEdit({ ...edit, displayName: event.currentTarget.value })}
          />
          <input
            aria-label={`LaTeX of ${constant.operator.symbol}`}
            className={styles.latexInput}
            spellCheck={false}
            value={edit.template}
            aria-invalid={issue !== undefined}
            onChange={(event) => onEdit({ ...edit, template: event.currentTarget.value })}
          />
          {issue === undefined ? null : <span className={styles.fieldIssue}>{issue}</span>}
        </span>
      )}
      <button
        type="button"
        className={styles.iconButton}
        aria-label={`${removed ? "Restore" : "Remove"} ${name}`}
        title={removed ? "Restore" : "Remove"}
        onClick={onToggle}
      >
        {removed ? "↺" : "×"}
      </button>
    </li>
  );
}

function ResultRow({
  result,
  presentation,
  kept,
  blocked,
  onToggle,
}: Readonly<{
  result: LibraryResult;
  presentation: Presentation | undefined;
  kept: boolean;
  blocked: boolean;
  onToggle: () => void;
}>) {
  const { artifact } = result;
  const statement = rendered(
    presentation,
    artifact.statement.expression,
    artifact.renderings.latex,
  );
  const premises = artifact.premises.map(({ expression }) =>
    rendered(presentation, expression, JSON.stringify(expression)),
  );
  return (
    <li className={styles.resultRow} data-kept={kept} title={artifact.description}>
      <label>
        <input type="checkbox" checked={kept} disabled={blocked} onChange={onToggle} />
        <span className={styles.resultBody}>
          <span className={styles.resultName}>{artifact.name}</span>
          <span className={styles.resultFormula}>
            {premises.length === 0 ? null : (
              <>
                {premises.map((premise, index) => (
                  <span key={index}>
                    {index === 0 ? null : <span className={styles.premiseSeparator}>, </span>}
                    <Formula latex={premise} />
                  </span>
                ))}
                <span className={styles.turnstile} aria-label="proves">
                  ⊢
                </span>
              </>
            )}
            <Formula latex={statement} />
          </span>
          {blocked ? <em className={styles.hint}>Uses removed notation</em> : null}
        </span>
      </label>
    </li>
  );
}

/** A formula in the current notation; the worker's rendering stands in when ours fails. */
function rendered(
  presentation: Presentation | undefined,
  expression: PlainMathJson,
  fallback: string,
): string {
  try {
    if (presentation !== undefined) return presentation.latex(expression);
  } catch {
    // Fall through to the worker's rendering.
  }
  return fallback;
}

function editOf(operator: OperatorDeclaration, edit: ConstantEdit | undefined): ConstantEdit {
  return (
    edit ?? {
      displayName: operator.presentation?.displayName ?? operator.symbol,
      template: operator.presentation?.latex?.template ?? "",
    }
  );
}

/**
 * MathLive's LaTeX check, loaded in the browser only: the commands it does not know. Until it has
 * loaded, nothing is reported; the worker checks again when the background is approved.
 */
function useUnknownCommands(): ((latex: string) => readonly string[]) | undefined {
  const [check, setCheck] = useState<(latex: string) => readonly string[]>();
  useEffect(() => {
    let active = true;
    void import("mathlive")
      .then((module) => {
        if (!active || typeof module.validateLatex !== "function") return;
        const validate = module.validateLatex;
        setCheck(
          () => (latex: string) =>
            validate(latex).flatMap((error) =>
              error.code === "unknown-command" && typeof error.arg === "string" ? [error.arg] : [],
            ),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return check;
}

function allPackOperators(options: ProblemSetupOptions): Readonly<{
  /** The operators of the packs every setup includes. */
  active: readonly OperatorDeclaration[];
  all: readonly OperatorDeclaration[];
}> {
  const parse = (input: readonly unknown[]) => {
    const parsed = z.array(operatorDeclarationSchema).safeParse(input);
    return parsed.success ? parsed.data : [];
  };
  return {
    active: options.packs
      .filter((pack) => pack.alwaysActive)
      .flatMap((pack) => parse(pack.operators)),
    all: options.packs.flatMap((pack) => parse(pack.operators)),
  };
}

function uniqueBySymbol(operators: readonly OperatorDeclaration[]): OperatorDeclaration[] {
  const seen = new Map<string, OperatorDeclaration>();
  for (const operator of operators) seen.set(operator.symbol, operator);
  return [...seen.values()];
}

/** The layers a new setup includes: the global results and the problem's own library. */
function layerIds(options: ProblemSetupOptions): ProblemDraft["libraryLayerIds"] {
  const included: readonly string[] = emptyProblemForm().layerIds;
  return options.layers.map(({ id }) => id).filter((id) => included.includes(id));
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
