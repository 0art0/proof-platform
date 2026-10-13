"use client";

import { Fragment, useState } from "react";
import { problemDraftSchema, type ProblemDraft } from "@proof/protocol";
import { z } from "zod";
import type { FormProblem, SetupContext, TopicSuggestions } from "./draft-form";
import styles from "./problem-entry.module.css";

/** Which setup roles the worker reports as configured. */
export type AiSetupCapabilities = Readonly<{ topics: boolean; formalizer: boolean }>;
export const NO_AI_SETUP: AiSetupCapabilities = Object.freeze({ topics: false, formalizer: false });

export type AiAssistProps = Readonly<{
  capabilities: AiSetupCapabilities;
  /** What the roles may see: problem, background, preferences, layers and packs. */
  context: SetupContext;
  /** Required problem and background fields that are still empty. */
  missing: readonly FormProblem[];
  /** Owner of every call made from this form, so its evidence stays together. */
  constructionId: string;
  createId: (prefix: string) => string;
  onUseTopics: (topics: TopicSuggestions) => void;
  onUseDraft: (draft: ProblemDraft, callId: string) => void;
}>;

const manifestSchema = z
  .object({
    kind: z.literal("topic-manifest"),
    domains: z.array(z.string()),
    objectKinds: z.array(z.string()),
    vocabulary: z.array(z.string()),
    notation: z.array(z.object({ symbol: z.string(), meaning: z.string() }).strict()),
    backgroundTopics: z.array(z.string()),
    customOperators: z.array(
      z.object({ symbol: z.string(), name: z.string(), arity: z.number() }).strict(),
    ),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;

/** A context request or refusal: the model returned no proposal. */
const nonProposalSchema = z.object({
  status: z.enum(["insufficient-context", "declined"]),
  result: z.union([
    z.object({
      kind: z.literal("insufficient-context"),
      requestedCategories: z.array(z.string()),
      rationale: z.string(),
    }),
    z.object({ kind: z.literal("declined"), reason: z.string() }),
  ]),
});
const topicAnswerSchema = z.union([
  z.object({ status: z.literal("proposed"), callId: z.string(), proposal: manifestSchema }),
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
  decision: z.object({ decision: z.enum(["approved", "rejected"]) }),
});
const apiAnswerSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
    details: z.unknown().optional(),
  }),
]);

type Failure = Readonly<{ kind: "failed"; message: string }>;
type TopicState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Failure
  | Readonly<{ kind: "proposed"; callId: string; contextKey: string; proposal: Manifest }>;
type Decision = Readonly<{
  decisionId: string;
  decidedAt: string;
  decision: "approved" | "rejected";
  rationale: string;
}>;
type DecisionState =
  | Readonly<{ kind: "undecided" }>
  | Readonly<{ kind: "recording"; pending: Decision }>
  | Readonly<{ kind: "unrecorded"; pending: Decision; message: string }>
  | Readonly<{ kind: "recorded"; decision: "approved" | "rejected"; applied: boolean }>;
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
 * Optional AI help while setting up a problem (design plan §4.2 and §4.4). Both roles return
 * proposals only: topics are approved or rejected explicitly, and a drafted setup is loaded into
 * the form only on request, where it still goes through "Check setup" and approval.
 */
export function AiAssist({
  capabilities,
  context,
  missing,
  constructionId,
  createId,
  onUseTopics,
  onUseDraft,
}: AiAssistProps) {
  const [topics, setTopics] = useState<TopicState>({ kind: "idle" });
  const [decision, setDecision] = useState<DecisionState>({ kind: "undecided" });
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<DraftState>({ kind: "idle" });
  const contextKey = JSON.stringify(context);
  const anyAvailable = capabilities.topics || capabilities.formalizer;
  const ready = missing.length === 0;

  const suggestTopics = async () => {
    setTopics({ kind: "loading" });
    setDecision({ kind: "undecided" });
    setNote("");
    const answer = await postAi("/api/ai/topics", {
      constructionId,
      id: createId("llm-call:topics"),
      problem: context.problem,
      background: context.background,
      ...(context.preferences === undefined ? {} : { preferences: context.preferences }),
    });
    if (!answer.ok) return setTopics({ kind: "failed", message: answer.message });
    const parsed = topicAnswerSchema.safeParse(answer.data);
    if (!parsed.success) return setTopics(invalidAnswer());
    if (parsed.data.status !== "proposed") {
      return setTopics({ kind: "failed", message: nonProposalMessage(parsed.data.result) });
    }
    setTopics({
      kind: "proposed",
      callId: parsed.data.callId,
      contextKey,
      proposal: parsed.data.proposal,
    });
  };

  const decide = async (choice: "approved" | "rejected") => {
    if (topics.kind !== "proposed") return;
    // A retry after a failed recording reuses the same decision, so it stays idempotent.
    const pending: Decision =
      decision.kind === "unrecorded" && decision.pending.decision === choice
        ? decision.pending
        : {
            decisionId: createId("topic-decision"),
            decidedAt: new Date().toISOString(),
            decision: choice,
            rationale:
              note.trim() ||
              (choice === "approved"
                ? "Approved in the problem setup form."
                : "Rejected in the problem setup form."),
          };
    setDecision({ kind: "recording", pending });
    const answer = await postAi("/api/ai/topics/decisions", {
      constructionId,
      callId: topics.callId,
      ...pending,
    });
    const parsed = answer.ok ? decisionAnswerSchema.safeParse(answer.data) : undefined;
    if (!answer.ok || parsed === undefined || !parsed.success) {
      return setDecision({
        kind: "unrecorded",
        pending,
        message: answer.ok ? "The proof service returned an invalid response." : answer.message,
      });
    }
    setDecision({ kind: "recorded", decision: parsed.data.decision.decision, applied: false });
  };

  const draftSetup = async () => {
    setDraft({ kind: "loading" });
    const answer = await postAi("/api/ai/formalize", {
      constructionId,
      id: createId("llm-call:formalize"),
      ...context,
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
      used: false,
    });
  };

  return (
    <section className={styles.section} aria-label="AI assistance">
      <h2>AI assistance (optional)</h2>
      <p className={styles.sectionIntro}>
        A model can suggest the topics involved and draft the variables, hypotheses and goals from
        your problem statement. Its answers are proposals: nothing changes until you accept them,
        and a drafted setup is still checked and approved by you before exploring starts.
      </p>
      {!anyAvailable ? (
        <p className={styles.hint} role="note">
          AI assistance is not configured on this proof service. You can enter the setup by hand
          below.
        </p>
      ) : !ready ? (
        <p className={styles.hint} role="note">
          Fill in {missing.map(({ field }) => field).join(", ")} first; the model sees only the
          problem, the background and your preferences.
        </p>
      ) : null}

      <div className={styles.aiStep}>
        <h3>Suggest topics</h3>
        <p className={styles.sectionIntro}>
          Areas, objects, vocabulary and notation the problem appears to involve. Approved notation
          and areas can be added to your preferences.
        </p>
        <button
          type="button"
          className={styles.secondary}
          disabled={!capabilities.topics || !ready || topics.kind === "loading"}
          onClick={() => void suggestTopics()}
        >
          {topics.kind === "loading" ? "Suggesting topics…" : "Suggest topics"}
        </button>
        {capabilities.topics ? null : <em className={styles.hint}> Not configured.</em>}
        {topics.kind === "failed" ? (
          <p role="alert" className={styles.warning}>
            {topics.message}
          </p>
        ) : null}
        {topics.kind === "proposed" ? (
          <TopicProposal
            proposal={topics.proposal}
            stale={topics.contextKey !== contextKey}
            decision={decision}
            note={note}
            onNote={setNote}
            onDecide={(choice) => void decide(choice)}
            onUse={() => {
              onUseTopics({ domains: topics.proposal.domains, notation: topics.proposal.notation });
              setDecision({ kind: "recorded", decision: "approved", applied: true });
            }}
          />
        ) : null}
      </div>

      <div className={styles.aiStep}>
        <h3>Draft the setup</h3>
        <p className={styles.sectionIntro}>
          Proposes variables, hypotheses and goals using the selected notation packs.
        </p>
        <button
          type="button"
          className={styles.secondary}
          disabled={!capabilities.formalizer || !ready || draft.kind === "loading"}
          onClick={() => void draftSetup()}
        >
          {draft.kind === "loading" ? "Drafting…" : "Draft the setup"}
        </button>
        {capabilities.formalizer ? null : <em className={styles.hint}> Not configured.</em>}
        {draft.kind === "failed" ? (
          <p role="alert" className={styles.warning}>
            {draft.message}
          </p>
        ) : null}
        {draft.kind === "proposed" || draft.kind === "needs-review" ? (
          <DraftProposal
            state={draft}
            stale={draft.contextKey !== contextKey}
            onUse={() => {
              onUseDraft(draft.draft, draft.callId);
              setDraft({ ...draft, used: true });
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function TopicProposal({
  proposal,
  stale,
  decision,
  note,
  onNote,
  onDecide,
  onUse,
}: Readonly<{
  proposal: Manifest;
  stale: boolean;
  decision: DecisionState;
  note: string;
  onNote: (note: string) => void;
  onDecide: (choice: "approved" | "rejected") => void;
  onUse: () => void;
}>) {
  const rows: readonly (readonly [string, readonly string[]])[] = [
    ["Areas of mathematics", proposal.domains],
    ["Kinds of objects", proposal.objectKinds],
    ["Vocabulary", proposal.vocabulary],
    ["Notation", proposal.notation.map(({ symbol, meaning }) => `${symbol}: ${meaning}`)],
    ["Background topics", proposal.backgroundTopics],
    [
      "Operators likely needed",
      proposal.customOperators.map(({ symbol, name, arity }) => `${symbol} (${name}, ${arity})`),
    ],
  ];
  const recording = decision.kind === "recording";
  return (
    <div className={styles.aiProposal} role="group" aria-label="Suggested topics">
      <p className={styles.provenance}>Suggested by AI from your problem and background.</p>
      <dl className={styles.reviewList}>
        {rows.map(([label, values]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{values.length === 0 ? "None" : values.join("; ")}</dd>
          </Fragment>
        ))}
      </dl>
      {stale ? (
        <p className={styles.hint} role="note">
          You have edited the problem or background since these topics were suggested.
        </p>
      ) : null}
      {decision.kind === "recorded" ? (
        <>
          <p role="status">
            {decision.decision === "approved"
              ? "You approved these topics."
              : "You rejected these topics; nothing was changed."}
          </p>
          {decision.decision === "approved" ? (
            <button
              type="button"
              className={styles.secondary}
              disabled={decision.applied}
              onClick={onUse}
            >
              {decision.applied
                ? "Added to your preferences"
                : "Add these areas and notation to my preferences"}
            </button>
          ) : null}
        </>
      ) : (
        <>
          <label className={styles.field}>
            <span data-marker="optional">Note on your decision</span>
            <input value={note} onChange={(event) => onNote(event.currentTarget.value)} />
          </label>
          <div className={styles.aiDecision}>
            <button
              type="button"
              className={styles.secondary}
              disabled={recording}
              onClick={() => onDecide("approved")}
            >
              Approve topics
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={recording}
              onClick={() => onDecide("rejected")}
            >
              Reject topics
            </button>
          </div>
          {decision.kind === "unrecorded" ? (
            <p role="alert" className={styles.warning}>
              Your decision was not recorded: {decision.message} Trying again is safe.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function DraftProposal({
  state,
  stale,
  onUse,
}: Readonly<{
  state: Extract<DraftState, { kind: "proposed" | "needs-review" }>;
  stale: boolean;
  onUse: () => void;
}>) {
  const { draft } = state;
  const statement = (input: ProblemDraft["goals"][number]) =>
    input.format === "latex" ? input.latex : JSON.stringify(input.expression);
  return (
    <div className={styles.aiProposal} role="group" aria-label="Drafted setup">
      <p className={styles.provenance}>Drafted by AI. It has not been approved.</p>
      {state.kind === "needs-review" ? (
        <div role="alert" className={styles.warning}>
          <p>The draft did not pass the setup check:</p>
          <ul>
            {state.diagnostics.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
          <p>You can still load it and fix it by hand.</p>
        </div>
      ) : null}
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
          You have edited the problem, background or packs since this draft was made.
        </p>
      ) : null}
      {state.used ? (
        <p role="status">
          Loaded into the form below. Use “Check setup” to review it before starting.
        </p>
      ) : (
        <button type="button" className={styles.secondary} onClick={onUse}>
          Replace my variables, hypotheses and goals with this draft
        </button>
      )}
    </div>
  );
}

type AiAnswer =
  | Readonly<{ ok: true; data: unknown }>
  | Readonly<{ ok: false; message: string; details?: unknown }>;

async function postAi(url: string, body: unknown): Promise<AiAnswer> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, message: "The proof service could not be reached." };
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    value = undefined;
  }
  const parsed = apiAnswerSchema.safeParse(value);
  if (!parsed.success || parsed.data.ok !== response.ok) {
    return { ok: false, message: "The proof service returned an invalid response." };
  }
  if (parsed.data.ok) return { ok: true, data: parsed.data.data };
  return {
    ok: false,
    message: failureMessage(response.status, parsed.data.error),
    details: parsed.data.details,
  };
}

function failureMessage(status: number, error: Readonly<{ code: string; message: string }>) {
  if (status === 429) return "Too many AI requests right now. Wait a minute and try again.";
  if (error.code === "ai-disabled") return "AI assistance is not configured on this server.";
  if (error.code === "invalid-output") {
    return "The model's answer did not pass validation and was discarded. Nothing changed.";
  }
  return error.message;
}

function nonProposalMessage(result: z.infer<typeof nonProposalSchema>["result"]): string {
  return result.kind === "declined"
    ? `The model declined: ${result.reason}`
    : `The model asked for more detail (${result.requestedCategories.join(", ")}): ${result.rationale} Add it to the background or preferences and try again.`;
}

function invalidAnswer(): Failure {
  return { kind: "failed", message: "The proof service returned an invalid response." };
}
