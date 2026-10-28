"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPresentation } from "@proof/language";
import {
  backgroundProfileSchema,
  operatorDeclarationSchema,
  problemDraftSchema,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProblemDraft,
} from "@proof/protocol";
import { z } from "zod";
import { invalidAnswer, nonProposalSchema, postAi } from "./ai-api";
import type { AcceptedBackground, ApprovedLibrary, FormProblem, SetupContext } from "./draft-form";
import { LibraryStep } from "./library-step";
import styles from "./problem-entry.module.css";
import { SETUP_SECTION } from "./setup-progress";
import { Formula } from "./typeset";

/** Which setup roles the worker reports as configured. */
export type AiSetupCapabilities = Readonly<{
  background: boolean;
  library: boolean;
  formalizer: boolean;
}>;
export const NO_AI_SETUP: AiSetupCapabilities = Object.freeze({
  background: false,
  library: false,
  formalizer: false,
});

export type AiAssistProps = Readonly<{
  capabilities: AiSetupCapabilities;
  /** What the roles may see: problem, background, preferences, layers and packs. */
  context: SetupContext;
  /** Required problem and background fields that are still empty. */
  missing: readonly FormProblem[];
  /** Owner of every call made from this form, so its evidence stays together. */
  constructionId: string;
  createId: (prefix: string) => string;
  /** The background the user accepted, if any; the setup uses its constants. */
  accepted: AcceptedBackground | undefined;
  onAcceptBackground: (accepted: AcceptedBackground) => void;
  onForgetBackground: () => void;
  /** The operators of the selected packs and the accepted constants, for rendering results. */
  operators: readonly OperatorDeclaration[];
  /** The library the user approved, if any; the setup records its results. */
  approvedLibrary: ApprovedLibrary | undefined;
  onApproveLibrary: (library: ApprovedLibrary) => void;
  onForgetLibrary: () => void;
  /**
   * Load a drafted setup into the form. `check` is true for a draft that passed the worker's
   * check, which the form then checks again and shows for review; false for one loaded by hand.
   */
  onUseDraft: (draft: ProblemDraft, callId: string, check: boolean) => void;
  /** Suggest a background as soon as the form opens (the statement came from the landing page). */
  proposeOnOpen?: boolean;
}>;

const proposalSchema = z
  .object({
    kind: z.literal("background-proposal"),
    background: backgroundProfileSchema,
    constants: z.array(
      z.object({ operator: operatorDeclarationSchema, rationale: z.string() }).strict(),
    ),
  })
  .strict();
type Proposal = z.infer<typeof proposalSchema>;

const backgroundAnswerSchema = z.union([
  z.object({ status: z.literal("proposed"), callId: z.string(), proposal: proposalSchema }),
  nonProposalSchema,
]);
const formalizeAnswerSchema = z.union([
  z.object({
    status: z.literal("ready-for-review"),
    callId: z.string(),
    draft: problemDraftSchema,
  }),
  nonProposalSchema,
]);
const needsReviewSchema = z.object({
  status: z.literal("needs-review"),
  callId: z.string(),
  draft: problemDraftSchema,
  diagnostics: z.array(z.object({ code: z.string(), message: z.string() })).min(1),
});
const decisionAnswerSchema = z.object({
  status: z.literal("recorded"),
  decision: z.object({ decision: z.literal("approved") }),
});
type Failure = Readonly<{ kind: "failed"; message: string }>;
type Proposed = Readonly<{
  callId: string;
  /** The problem and preferences the proposal was made from. */
  problemKey: string;
  proposal: Proposal;
}>;
type RequestStatus =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading"; action: "propose" | "revise" }>
  | Failure;
type PendingDecision = Readonly<{
  decisionId: string;
  decidedAt: string;
  decision: "approved";
  rationale: string;
}>;
type DecisionState =
  | Readonly<{ kind: "undecided" }>
  | Readonly<{ kind: "recording"; pending: PendingDecision }>
  /** Transient failure: a retry reuses the same decision, so it stays idempotent. */
  | Readonly<{ kind: "unrecorded"; pending: PendingDecision; message: string }>
  /** The worker refused this proposal; retrying cannot help, a revision can. */
  | Readonly<{ kind: "refused"; message: string }>
  | Readonly<{ kind: "recorded" }>;
type DraftState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Failure
  | Readonly<{
      kind: "proposed" | "needs-review";
      callId: string;
      contextKey: string;
      draft: ProblemDraft;
      diagnostics: readonly string[];
      used: boolean;
    }>;

/**
 * AI help while setting up a problem (`docs/ai-agents-architecture.md` sections 1 to 3), so the
 * statement is all a user has to type. Every role returns proposals only. The background proposer
 * sees the problem statement and preferences, suggests a background and the constants the problem
 * needs, and can revise its suggestion from the user's feedback; nothing changes until the user
 * accepts, which fills the background fields and makes the constants available to the setup.
 * Accepting a background drafts the setup at once; a draft that passes the worker's check is
 * loaded into the form and checked, so the user lands on the review and still approves it before
 * exploring starts. A draft that fails the check is loaded only on request. Once a background is
 * accepted, the library builder proposes general results for it (it never sees the problem), and
 * the user keeps the ones they want.
 */
export function AiAssist({
  capabilities,
  context,
  missing,
  constructionId,
  createId,
  accepted,
  onAcceptBackground,
  onForgetBackground,
  operators,
  approvedLibrary,
  onApproveLibrary,
  onForgetLibrary,
  onUseDraft,
  proposeOnOpen = false,
}: AiAssistProps) {
  const [proposed, setProposed] = useState<Proposed>();
  const [status, setStatus] = useState<RequestStatus>({ kind: "idle" });
  const [feedback, setFeedback] = useState("");
  const [decision, setDecision] = useState<DecisionState>({ kind: "undecided" });
  const [draft, setDraft] = useState<DraftState>({ kind: "idle" });
  const problemKey = JSON.stringify([context.problem, context.preferences]);
  const contextKey = JSON.stringify([context, accepted?.decisionId, approvedLibrary?.decisionId]);
  const anyAvailable = capabilities.background || capabilities.library || capabilities.formalizer;
  const statementFilled = context.problem.statement.length > 0;
  const loading = status.kind === "loading";
  // The decision whose acceptance here drafts the setup once the form has its background.
  const draftAfter = useRef<string>(undefined);
  const proposedOnOpen = useRef(false);

  const ask = async (action: "propose" | "revise") => {
    const previous = action === "revise" ? proposed : undefined;
    setStatus({ kind: "loading", action });
    const answer = await postAi("/api/ai/background", {
      constructionId,
      id: createId("llm-call:background"),
      problem: context.problem,
      ...(context.preferences === undefined ? {} : { preferences: context.preferences }),
      ...(previous === undefined
        ? {}
        : { revision: { previousCallId: previous.callId, feedback: feedback.trim() } }),
    });
    if (!answer.ok) return setStatus({ kind: "failed", message: answer.message });
    const parsed = backgroundAnswerSchema.safeParse(answer.data);
    if (!parsed.success) return setStatus(invalidAnswer());
    if (parsed.data.status !== "proposed") {
      return setStatus({ kind: "failed", message: nonProposalMessage(parsed.data.result) });
    }
    setProposed({
      callId: parsed.data.callId,
      problemKey,
      proposal: parsed.data.proposal,
    });
    setFeedback("");
    setDecision({ kind: "undecided" });
    setStatus({ kind: "idle" });
  };

  const accept = async () => {
    if (proposed === undefined) return;
    const pending: PendingDecision =
      decision.kind === "unrecorded"
        ? decision.pending
        : {
            decisionId: createId("background-decision"),
            decidedAt: new Date().toISOString(),
            decision: "approved",
            rationale: "Accepted in the problem setup form.",
          };
    setDecision({ kind: "recording", pending });
    const answer = await postAi("/api/ai/background/decisions", {
      constructionId,
      callId: proposed.callId,
      ...pending,
    });
    const parsed = answer.ok ? decisionAnswerSchema.safeParse(answer.data) : undefined;
    if (!answer.ok && answer.status === 409) {
      return setDecision({ kind: "refused", message: answer.message });
    }
    if (!answer.ok || parsed === undefined || !parsed.success) {
      return setDecision({
        kind: "unrecorded",
        pending,
        message: answer.ok ? "The proof service returned an invalid response." : answer.message,
      });
    }
    setDecision({ kind: "recorded" });
    if (capabilities.formalizer) draftAfter.current = pending.decisionId;
    onAcceptBackground({
      decisionId: pending.decisionId,
      callId: proposed.callId,
      profile: proposed.proposal.background,
      constants: proposed.proposal.constants,
    });
  };

  // Runs after the accepted background has reached the form, so the draft request carries it.
  const draftAfterAccept = useEffectEvent(() => {
    if (accepted === undefined || draftAfter.current !== accepted.decisionId) return;
    draftAfter.current = undefined;
    if (missing.length === 0) void draftSetup();
  });
  useEffect(() => {
    draftAfterAccept();
  }, [accepted]);

  // Suggests a background once, when the form opens with a statement already typed.
  const proposeWhenOpened = useEffectEvent(() => {
    if (proposedOnOpen.current || !proposeOnOpen || !capabilities.background) return;
    proposedOnOpen.current = true;
    if (statementFilled) void ask("propose");
  });
  useEffect(() => {
    proposeWhenOpened();
  }, [proposeOnOpen, capabilities.background]);

  const draftSetup = async () => {
    setDraft({ kind: "loading" });
    const answer = await postAi("/api/ai/formalize", {
      constructionId,
      id: createId("llm-call:formalize"),
      ...context,
      ...(accepted === undefined
        ? {}
        : { approvedBackground: { decisionId: accepted.decisionId } }),
      ...(approvedLibrary === undefined
        ? {}
        : { approvedLibrary: { decisionId: approvedLibrary.decisionId } }),
    });
    if (!answer.ok) {
      const review = needsReviewSchema.safeParse(answer.details);
      return setDraft(
        review.success
          ? {
              kind: "needs-review",
              callId: review.data.callId,
              contextKey,
              draft: review.data.draft,
              diagnostics: review.data.diagnostics.map(({ message }) => message),
              used: false,
            }
          : { kind: "failed", message: answer.message },
      );
    }
    const parsed = formalizeAnswerSchema.safeParse(answer.data);
    if (!parsed.success) return setDraft(invalidAnswer());
    if (parsed.data.status !== "ready-for-review") {
      return setDraft({ kind: "failed", message: nonProposalMessage(parsed.data.result) });
    }
    setDraft({
      kind: "proposed",
      callId: parsed.data.callId,
      contextKey,
      draft: parsed.data.draft,
      diagnostics: [],
      used: true,
    });
    onUseDraft(parsed.data.draft, parsed.data.callId, true);
  };

  const isAccepted = proposed !== undefined && accepted?.callId === proposed.callId;
  const acceptedElsewhere = accepted !== undefined && !isAccepted;

  return (
    <section className={styles.section} aria-label="Background and setup">
      <div className={styles.sectionHeader}>
        <h2>Background and setup</h2>
        <p className={styles.sectionIntro}>
          A model suggests the background your problem is set against, with the constants (operators
          and notation) it needs. Once you accept a background, the variables, hypotheses and goals
          are drafted and checked for you. Its answers are proposals: nothing changes until you
          accept them, and you approve the setup before exploring starts.
        </p>
      </div>
      {!anyAvailable ? (
        <p className={styles.hint} role="note">
          AI assistance is not configured on this proof service. You can enter the setup by hand
          below.
        </p>
      ) : null}

      <div className={styles.aiStep} id={SETUP_SECTION.background}>
        <h3>Background</h3>
        <p className={styles.sectionIntro}>
          Suggested from the problem statement and your preferences only. Accept it, or describe
          what to change and ask for a revision.
        </p>
        <button
          type="button"
          className={proposed === undefined ? styles.primary : styles.secondary}
          disabled={!capabilities.background || !statementFilled || loading}
          onClick={() => void ask("propose")}
        >
          {status.kind === "loading" && status.action === "propose"
            ? "Suggesting…"
            : proposed === undefined
              ? "Suggest background"
              : "Suggest again"}
        </button>
        {!capabilities.background ? (
          <em className={styles.reason}> Not configured.</em>
        ) : !statementFilled ? (
          <em className={styles.reason}> Enter the problem statement first.</em>
        ) : null}
        {status.kind === "failed" ? (
          <p role="alert" className={styles.error}>
            {status.message}
          </p>
        ) : null}
        {acceptedElsewhere ? (
          <AcceptedNote accepted={accepted} onForget={onForgetBackground} elsewhere />
        ) : null}
        {proposed === undefined ? null : (
          <BackgroundProposal
            proposed={proposed}
            stale={proposed.problemKey !== problemKey}
            accepted={isAccepted ? accepted : undefined}
            decision={decision}
            feedback={feedback}
            onFeedback={setFeedback}
            revising={status.kind === "loading" && status.action === "revise"}
            busy={loading}
            onRevise={() => void ask("revise")}
            onAccept={() => void accept()}
            onForget={onForgetBackground}
          />
        )}
      </div>

      <LibraryStep
        available={capabilities.library}
        constructionId={constructionId}
        createId={createId}
        accepted={accepted}
        packs={context.packs}
        operators={operators}
        approved={approvedLibrary}
        onApprove={onApproveLibrary}
        onForget={onForgetLibrary}
      />

      <div className={styles.aiStep}>
        <h3>Setup</h3>
        <p className={styles.sectionIntro}>
          Drafted when you accept a background: variables, hypotheses and goals using the selected
          notation packs, any accepted constants and the approved library. Draft again after
          changing any of them.
        </p>
        <button
          type="button"
          className={styles.secondary}
          disabled={!capabilities.formalizer || missing.length > 0 || draft.kind === "loading"}
          onClick={() => void draftSetup()}
        >
          {draft.kind === "loading"
            ? "Drafting…"
            : draft.kind === "idle"
              ? "Draft the setup"
              : "Draft the setup again"}
        </button>
        {!capabilities.formalizer ? (
          <em className={styles.reason}> Not configured.</em>
        ) : missing.length > 0 ? (
          <em className={styles.reason}>
            {" "}
            Accept a background first, or fill in {missing.map(({ field }) => field).join(", ")} by
            hand.
          </em>
        ) : null}
        {draft.kind === "failed" ? (
          <p role="alert" className={styles.error}>
            {draft.message}
          </p>
        ) : null}
        {draft.kind === "proposed" ? (
          <p role="status" className={styles.hint}>
            {draft.contextKey === contextKey
              ? `Drafted by AI (${draft.callId}) and loaded into the setup for you to review.`
              : "You have edited the problem, background, packs, constants or library since the setup was drafted."}
          </p>
        ) : null}
        {draft.kind === "needs-review" ? (
          <DraftProposal
            state={draft}
            stale={draft.contextKey !== contextKey}
            onUse={() => {
              onUseDraft(draft.draft, draft.callId, false);
              setDraft({ ...draft, used: true });
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function BackgroundProposal({
  proposed,
  stale,
  accepted,
  decision,
  feedback,
  onFeedback,
  revising,
  busy,
  onRevise,
  onAccept,
  onForget,
}: Readonly<{
  proposed: Proposed;
  stale: boolean;
  /** Set when this very proposal is the one the user accepted. */
  accepted: AcceptedBackground | undefined;
  decision: DecisionState;
  feedback: string;
  onFeedback: (feedback: string) => void;
  revising: boolean;
  busy: boolean;
  onRevise: () => void;
  onAccept: () => void;
  onForget: () => void;
}>) {
  const { background, constants } = proposed.proposal;
  const recording = decision.kind === "recording";
  const noFeedback = feedback.trim().length === 0;
  return (
    <div
      className={styles.aiProposal}
      data-state={accepted === undefined ? "proposed" : "accepted"}
      role="group"
      aria-label="Proposed background"
    >
      <div className={styles.proposalTags}>
        <span className={styles.aiChip}>✦ AI proposal</span>
        {accepted === undefined ? null : <span className={styles.successChip}>✓ Accepted</span>}
      </div>
      <p className={styles.provenance}>
        {accepted === undefined
          ? "Proposed by AI from your problem statement. It has not been accepted."
          : "Proposed by AI and accepted by you."}
      </p>
      <dl className={styles.reviewList}>
        <dt>Background level</dt>
        <dd>{background.level}</dd>
        <dt>Background summary</dt>
        <dd>{background.summary}</dd>
        <dt>Assumptions</dt>
        <dd>{background.assumptions.length === 0 ? "None" : background.assumptions.join("; ")}</dd>
        <dt>Domains</dt>
        <dd>
          {background.domains === undefined || background.domains.length === 0
            ? "None"
            : background.domains.join(", ")}
          {background.maximumLevel === undefined ? null : (
            <em className={styles.hint}> Up to {background.maximumLevel} level.</em>
          )}
        </dd>
        <dt>Constants</dt>
        <dd>
          {constants.length === 0 ? (
            "None. The problem needs no notation beyond built-in mathematics."
          ) : (
            <>
              <em className={styles.hint}>
                The operators and notation the setup may use besides built-in mathematics.
              </em>
              <ul className={styles.constantList}>
                {constants.map(({ operator, rationale }) => (
                  <ConstantItem key={operator.id} operator={operator} rationale={rationale} />
                ))}
              </ul>
            </>
          )}
        </dd>
      </dl>
      {stale ? (
        <p className={styles.hint} role="note">
          You have edited the problem or preferences since this was proposed.
        </p>
      ) : null}

      {accepted === undefined ? null : <AcceptedNote accepted={accepted} onForget={onForget} />}

      <label className={styles.field}>
        <span className={styles.label}>Feedback for a revision</span>
        <textarea
          rows={2}
          placeholder="e.g. also allow the greatest common divisor"
          value={feedback}
          onChange={(event) => onFeedback(event.currentTarget.value)}
        />
      </label>
      <div className={styles.aiDecision}>
        <button
          type="button"
          className={styles.secondary}
          disabled={noFeedback || busy || recording}
          onClick={onRevise}
        >
          {revising ? "Revising…" : "Revise with feedback"}
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={accepted !== undefined || busy || recording}
          onClick={onAccept}
        >
          {recording ? "Accepting…" : accepted === undefined ? "Accept" : "Accepted"}
        </button>
      </div>
      {noFeedback || accepted === undefined ? (
        <p className={styles.hint}>
          {noFeedback ? "To revise, describe what to change first. " : null}
          {accepted === undefined
            ? "Accepting fills in the background and drafts the setup; you can still edit both."
            : null}
        </p>
      ) : null}
      {decision.kind === "unrecorded" ? (
        <p role="alert" className={styles.error}>
          Your acceptance was not recorded: {decision.message} Trying again is safe.
        </p>
      ) : null}
      {decision.kind === "refused" ? (
        <p role="alert" className={styles.error}>
          This proposal cannot be accepted: {decision.message}
        </p>
      ) : null}
    </div>
  );
}

function AcceptedNote({
  accepted,
  onForget,
  elsewhere = false,
}: Readonly<{ accepted: AcceptedBackground; onForget: () => void; elsewhere?: boolean }>) {
  const count = accepted.constants.length;
  return (
    <p role="status" className={styles.accepted}>
      {elsewhere ? "An earlier proposal is accepted and in use. " : "Accepted. "}
      {count === 0
        ? "Its background fills in the fields below; no constants are added."
        : `Its background fills in the fields below, and its ${count === 1 ? "constant" : `${count} constants`} (${accepted.constants
            .map(({ operator }) => operator.symbol)
            .join(", ")}) will be used when drafting and checking the setup.`}{" "}
      {count === 0 ? null : (
        <button type="button" className={styles.linkButton} onClick={onForget}>
          Stop using these constants
        </button>
      )}
    </p>
  );
}

function ConstantItem({
  operator,
  rationale,
}: Readonly<{ operator: OperatorDeclaration; rationale: string }>) {
  const { latex, prose } = renderConstant(operator);
  return (
    <li>
      <Formula latex={latex} />{" "}
      <strong>{operator.presentation?.displayName ?? operator.symbol}</strong>
      <span className={styles.prose}> {prose}</span>
      <span className={styles.hint}> {rationale}</span>
    </li>
  );
}

/** A constant applied to placeholder operands, in LaTeX and in words. */
function renderConstant(operator: OperatorDeclaration): { latex: string; prose: string } {
  const operands = operator.signature.parameters.map((_, index) => `x_${index + 1}`);
  try {
    const presentation = createPresentation({ operators: [operator] });
    const expression: PlainMathJson = [operator.symbol, ...operands];
    return {
      latex: presentation.latex(expression),
      prose: presentation.naturalLanguage(expression),
    };
  } catch {
    return { latex: `${operator.symbol}(${operands.join(", ")})`, prose: "" };
  }
}

function DraftProposal({
  state,
  stale,
  onUse,
}: Readonly<{
  state: Extract<DraftState, { callId: string }>;
  stale: boolean;
  onUse: () => void;
}>) {
  const { draft } = state;
  const statement = (input: ProblemDraft["goals"][number]) =>
    input.format === "latex" ? input.latex : JSON.stringify(input.expression);
  return (
    <div className={styles.aiProposal} role="group" aria-label="Drafted setup">
      <div className={styles.proposalTags}>
        <span className={styles.aiChip}>✦ AI proposal</span>
      </div>
      <p className={styles.provenance}>Drafted by AI. It has not been approved.</p>
      <div role="alert" className={styles.warning}>
        <p>The draft did not pass the setup check:</p>
        <ul>
          {state.diagnostics.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
        <p>You can still load it and fix it by hand.</p>
      </div>
      <dl className={styles.reviewList}>
        <dt>Variables and objects</dt>
        <dd>
          {draft.declarations.length === 0
            ? "None"
            : draft.declarations.map(({ symbol, sort }) => (
                <code key={symbol} className={styles.token}>
                  {symbol}: {sort}
                </code>
              ))}
        </dd>
        <dt>Hypotheses</dt>
        <dd>
          {draft.hypotheses.length === 0 ? (
            "None"
          ) : (
            <ol>
              {draft.hypotheses.map((input, index) => (
                <li key={index}>
                  <code>{statement(input)}</code>
                </li>
              ))}
            </ol>
          )}
        </dd>
        <dt>Goals</dt>
        <dd>
          <ol>
            {draft.goals.map((input, index) => (
              <li key={index}>
                <code>{statement(input)}</code>
              </li>
            ))}
          </ol>
        </dd>
      </dl>
      {stale ? (
        <p className={styles.hint} role="note">
          You have edited the problem, background, packs or accepted constants since this draft was
          made.
        </p>
      ) : null}
      {state.used ? (
        <p role="status">Loaded into the setup below. Fix it there, then use “Check setup”.</p>
      ) : (
        <button type="button" className={styles.secondary} onClick={onUse}>
          Replace my variables, hypotheses and goals with this draft
        </button>
      )}
    </div>
  );
}

function nonProposalMessage(result: z.infer<typeof nonProposalSchema>["result"]): string {
  return result.kind === "declined"
    ? `The model declined: ${result.reason}`
    : `The model asked for more detail (${result.requestedCategories.join(", ")}): ${result.rationale} Add that detail to the problem statement or the background and try again.`;
}
