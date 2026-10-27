"use client";

import { useMemo, useState } from "react";
import { createPresentation } from "@proof/language";
import {
  operatorDeclarationSchema,
  plainMathJsonSchema,
  type OperatorDeclaration,
  type PlainMathJson,
} from "@proof/protocol";
import { z } from "zod";
import { invalidAnswer, nonProposalSchema, postAi } from "./ai-api";
import type { AcceptedBackground, ApprovedLibrary } from "./draft-form";
import styles from "./problem-entry.module.css";

const resultSchema = z.object({
  artifact: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    statement: z.object({ expression: plainMathJsonSchema }),
    premises: z.array(z.object({ expression: plainMathJsonSchema })),
    renderings: z.object({ latex: z.string(), naturalLanguage: z.string() }),
  }),
  variants: z.array(z.object({ id: z.string() })),
  newConstantSymbols: z.array(z.string()),
});
type LibraryResult = z.infer<typeof resultSchema>;

const answerSchema = z.union([
  z.object({
    status: z.literal("proposed"),
    callId: z.string(),
    results: z.array(resultSchema),
    rejected: z.array(z.object({ id: z.string(), name: z.string(), reasons: z.array(z.string()) })),
    newConstants: z.array(z.object({ operator: operatorDeclarationSchema, rationale: z.string() })),
  }),
  nonProposalSchema,
]);
const decisionAnswerSchema = z.object({
  status: z.literal("recorded"),
  approvedLibrary: z.object({ variantCount: z.number().int().nonnegative() }),
});

type Built = Readonly<{
  callId: string;
  /** The accepted background and the packs the library was built for. */
  backgroundDecisionId: string;
  packsKey: string;
  results: readonly LibraryResult[];
  rejected: readonly Readonly<{ id: string; name: string; reasons: readonly string[] }>[];
  newConstants: readonly Readonly<{ operator: OperatorDeclaration; rationale: string }>[];
}>;
type Status =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>;
type PendingDecision = Readonly<{
  decisionId: string;
  decidedAt: string;
  approvedResultIds: readonly string[];
}>;
type DecisionState =
  | Readonly<{ kind: "undecided" }>
  | Readonly<{ kind: "recording"; pending: PendingDecision }>
  /** Transient failure: a retry reuses the same decision, so it stays idempotent. */
  | Readonly<{ kind: "unrecorded"; pending: PendingDecision; message: string }>
  /** The worker refused this selection; retrying cannot help, changing it can. */
  | Readonly<{ kind: "refused"; message: string }>;

export type LibraryStepProps = Readonly<{
  /** Whether the proof service has the library builder configured. */
  available: boolean;
  constructionId: string;
  createId: (prefix: string) => string;
  /** The accepted background the library is built from; none until one is accepted. */
  accepted: AcceptedBackground | undefined;
  /** The notation packs of the setup, which the library builder works with. */
  packs: readonly string[];
  /** The operators of the selected packs and the accepted constants, for rendering results. */
  operators: readonly OperatorDeclaration[];
  approved: ApprovedLibrary | undefined;
  onApprove: (library: ApprovedLibrary) => void;
  onForget: () => void;
}>;

/**
 * "Build library": after a background is accepted, the library builder proposes general results
 * for that background and its constants (it never sees the problem). The user reviews them,
 * removes any they do not want, and approves the rest in bulk. Nothing is added anywhere until
 * the setup is approved; the approval only records which results the user kept.
 */
export function LibraryStep({
  available,
  constructionId,
  createId,
  accepted,
  packs,
  operators,
  approved,
  onApprove,
  onForget,
}: LibraryStepProps) {
  const [built, setBuilt] = useState<Built>();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [decision, setDecision] = useState<DecisionState>({ kind: "undecided" });
  const packsKey = JSON.stringify(packs);

  const presentation = useMemo(() => {
    const known = new Set(operators.map(({ symbol }) => symbol));
    const added = (built?.newConstants ?? [])
      .map(({ operator }) => operator)
      .filter(({ symbol }) => !known.has(symbol));
    try {
      return createPresentation({ operators: [...operators, ...added] });
    } catch {
      return undefined;
    }
  }, [operators, built]);

  const loading = status.kind === "loading";
  const recording = decision.kind === "recording";
  const kept =
    built === undefined ? [] : built.results.filter(({ artifact }) => !removed.has(artifact.id));
  const keptVariants = kept.reduce((sum, { variants }) => sum + variants.length, 0);
  const usedConstants =
    built === undefined
      ? []
      : built.newConstants.filter(({ operator }) =>
          kept.some(({ newConstantSymbols }) => newConstantSymbols.includes(operator.symbol)),
        );
  const isApproved = built !== undefined && approved?.callId === built.callId;
  const staleBackground =
    built !== undefined && built.backgroundDecisionId !== accepted?.decisionId;
  const stalePacks = built !== undefined && built.packsKey !== packsKey;

  const build = async () => {
    if (accepted === undefined) return;
    setStatus({ kind: "loading" });
    const answer = await postAi("/api/ai/library", {
      constructionId,
      id: createId("llm-call:library"),
      approvedBackground: { decisionId: accepted.decisionId },
      packs,
    });
    if (!answer.ok) return setStatus({ kind: "failed", message: answer.message });
    const parsed = answerSchema.safeParse(answer.data);
    if (!parsed.success) return setStatus(invalidAnswer());
    if (parsed.data.status !== "proposed") {
      return setStatus({ kind: "failed", message: nonProposalMessage(parsed.data.result) });
    }
    // A new proposal replaces the library that was approved from an earlier one.
    if (approved !== undefined) onForget();
    setBuilt({
      callId: parsed.data.callId,
      backgroundDecisionId: accepted.decisionId,
      packsKey,
      results: parsed.data.results,
      rejected: parsed.data.rejected,
      newConstants: parsed.data.newConstants,
    });
    setRemoved(new Set());
    setDecision({ kind: "undecided" });
    setStatus({ kind: "idle" });
  };

  const toggle = (id: string) => {
    setRemoved((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
    // Another selection is another library: it has to be approved again.
    if (isApproved) onForget();
    setDecision({ kind: "undecided" });
  };

  const approve = async () => {
    if (built === undefined || kept.length === 0) return;
    const ids = kept.map(({ artifact }) => artifact.id);
    const pending: PendingDecision =
      decision.kind === "unrecorded" && sameIds(decision.pending.approvedResultIds, ids)
        ? decision.pending
        : {
            decisionId: createId("library-decision"),
            decidedAt: new Date().toISOString(),
            approvedResultIds: ids,
          };
    setDecision({ kind: "recording", pending });
    const answer = await postAi("/api/ai/library/decisions", {
      constructionId,
      callId: built.callId,
      ...pending,
    });
    if (!answer.ok && answer.status === 409) {
      return setDecision({ kind: "refused", message: answer.message });
    }
    const recorded = answer.ok ? decisionAnswerSchema.safeParse(answer.data) : undefined;
    if (!answer.ok || recorded === undefined || !recorded.success) {
      return setDecision({
        kind: "unrecorded",
        pending,
        message: answer.ok ? "The proof service returned an invalid response." : answer.message,
      });
    }
    setDecision({ kind: "undecided" });
    onApprove({
      decisionId: pending.decisionId,
      callId: built.callId,
      backgroundDecisionId: built.backgroundDecisionId,
      results: kept.map(({ artifact }) => ({ id: artifact.id, name: artifact.name })),
      variantCount: recorded.data.approvedLibrary.variantCount,
      constants: usedConstants.map(({ operator }) => operator),
    });
  };

  const buildHint = !available
    ? "Not configured."
    : accepted === undefined
      ? "Accept a background first; the library is built from it."
      : null;

  return (
    <div className={styles.aiStep}>
      <h3>Build library</h3>
      <p className={styles.sectionIntro}>
        Proposes general results about the accepted background&apos;s constants, at its level. The
        model does not see the problem. You keep the ones you want, and they are added to this
        problem&apos;s library when you start exploring.
      </p>
      <button
        type="button"
        className={styles.secondary}
        disabled={!available || accepted === undefined || loading}
        onClick={() => void build()}
      >
        {loading ? "Building…" : "Build library"}
      </button>
      {buildHint === null ? null : <em className={styles.reason}> {buildHint}</em>}
      {approved !== undefined && !loading ? (
        <em className={styles.hint}>
          {" "}
          Building again replaces the approved library until you approve the new one.
        </em>
      ) : null}
      {status.kind === "failed" ? (
        <p role="alert" className={styles.error}>
          {status.message}
        </p>
      ) : null}

      {built === undefined ? null : (
        <div
          className={styles.aiProposal}
          data-state={isApproved ? "accepted" : "proposed"}
          role="group"
          aria-label="Proposed library"
        >
          <div className={styles.proposalTags}>
            <span className={styles.aiChip}>✦ AI proposal</span>
            {isApproved ? <span className={styles.successChip}>✓ Approved</span> : null}
          </div>
          <p className={styles.provenance}>
            {isApproved
              ? "Proposed by AI and approved by you."
              : "Proposed by AI. Nothing is added until you approve the results you keep."}
          </p>
          {built.results.length === 0 ? (
            <p role="status">None of the proposed results passed the checks.</p>
          ) : (
            <>
              <p role="status">
                {kept.length} of {built.results.length}{" "}
                {built.results.length === 1 ? "result" : "results"} kept
                {keptVariants === 0
                  ? "."
                  : `, plus ${keptVariants} generated ${keptVariants === 1 ? "variant" : "variants"} (equivalent reshapings such as contrapositives).`}
              </p>
              <ul className={styles.libraryList}>
                {built.results.map((result) => (
                  <ResultItem
                    key={result.artifact.id}
                    result={result}
                    presentation={presentation}
                    removed={removed.has(result.artifact.id)}
                    onToggle={() => toggle(result.artifact.id)}
                  />
                ))}
              </ul>
            </>
          )}
          {usedConstants.length === 0 ? null : (
            <p className={styles.hint}>
              The kept results add notation to the setup:{" "}
              {usedConstants.map(({ operator, rationale }) => (
                <span key={operator.id}>
                  <code className={styles.token}>{operator.symbol}</code> {rationale}{" "}
                </span>
              ))}
            </p>
          )}
          {built.rejected.length === 0 ? null : (
            <details>
              <summary className={styles.disclosure}>
                {built.rejected.length} proposed{" "}
                {built.rejected.length === 1 ? "result" : "results"} did not pass checks
              </summary>
              <ul className={styles.rejectedList}>
                {built.rejected.map((item) => (
                  <li key={item.id}>
                    <strong>{item.name}</strong> {item.reasons.join(" ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {staleBackground ? (
            <p className={styles.hint} role="note">
              The accepted background changed since this library was built. Build it again.
            </p>
          ) : null}
          {stalePacks && !staleBackground ? (
            <p className={styles.hint} role="note">
              You changed the notation packs since this library was built. Check setup tells you if
              a result no longer fits.
            </p>
          ) : null}
          <div className={styles.aiDecision}>
            <button
              type="button"
              className={styles.primary}
              disabled={kept.length === 0 || recording || isApproved || staleBackground}
              onClick={() => void approve()}
            >
              {recording ? "Approving…" : isApproved ? "Approved" : "Approve library"}
            </button>
          </div>
          {kept.length === 0 && built.results.length > 0 ? (
            <p className={styles.reason}>Keep at least one result to approve a library.</p>
          ) : null}
          {!isApproved && kept.length > 0 && !staleBackground ? (
            <p className={styles.hint}>
              Approving records your choice; the results are added to the problem when you start
              exploring. You can still change the selection, then approve again.
            </p>
          ) : null}
          {isApproved && approved !== undefined ? (
            <p role="status" className={styles.accepted}>
              Approved: {approved.results.length}{" "}
              {approved.results.length === 1 ? "result" : "results"}
              {approved.variantCount === 0 ? "" : ` and ${approved.variantCount} variants`} will be
              added to this problem&apos;s library, and drafting and checking the setup take them
              into account.{" "}
              <button type="button" className={styles.linkButton} onClick={onForget}>
                Stop using this library
              </button>
            </p>
          ) : null}
          {decision.kind === "unrecorded" ? (
            <p role="alert" className={styles.error}>
              Your approval was not recorded: {decision.message} Trying again is safe.
            </p>
          ) : null}
          {decision.kind === "refused" ? (
            <p role="alert" className={styles.error}>
              This selection cannot be approved: {decision.message}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ResultItem({
  result,
  presentation,
  removed,
  onToggle,
}: Readonly<{
  result: LibraryResult;
  presentation: ReturnType<typeof createPresentation> | undefined;
  removed: boolean;
  onToggle: () => void;
}>) {
  const { artifact, newConstantSymbols } = result;
  const statement = render(presentation, artifact.statement.expression, artifact.renderings);
  const premises =
    presentation === undefined
      ? []
      : artifact.premises.map(({ expression }) => render(presentation, expression, undefined));
  return (
    <li
      className={
        removed ? `${styles.libraryItem} ${styles.libraryItemRemoved}` : styles.libraryItem
      }
    >
      <div className={styles.libraryBody}>
        <strong>{artifact.name}</strong>
        <span className={styles.rendered}>
          <code>{statement.latex}</code>
          <span className={styles.prose}>{statement.prose}</span>
        </span>
        {premises.length === 0 ? null : (
          <span className={styles.hint}>
            Assuming:{" "}
            {premises.map((premise, index) => (
              <code key={index} className={styles.token}>
                {premise.latex}
              </code>
            ))}
          </span>
        )}
        <span className={styles.hint}>{artifact.description}</span>
        {newConstantSymbols.length === 0 ? null : (
          <span className={styles.hint}>Uses new notation: {newConstantSymbols.join(", ")}.</span>
        )}
        {removed ? (
          <em className={styles.hint} data-note="removed">
            Removed: it will not be added.
          </em>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.removeButton}
        aria-label={`${removed ? "Restore" : "Remove"} ${artifact.name}`}
        onClick={onToggle}
      >
        {removed ? "Restore" : "Remove"}
      </button>
    </li>
  );
}

/** A formula in LaTeX and in words; the worker's own rendering stands in when ours fails. */
function render(
  presentation: ReturnType<typeof createPresentation> | undefined,
  expression: PlainMathJson,
  fallback: Readonly<{ latex: string; naturalLanguage: string }> | undefined,
): { latex: string; prose: string } {
  try {
    if (presentation !== undefined) {
      return {
        latex: presentation.latex(expression),
        prose: presentation.naturalLanguage(expression),
      };
    }
  } catch {
    // Fall through to the worker's rendering.
  }
  return {
    latex: fallback?.latex ?? JSON.stringify(expression),
    prose: fallback?.naturalLanguage ?? "",
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function nonProposalMessage(result: z.infer<typeof nonProposalSchema>["result"]): string {
  return result.kind === "declined"
    ? `The library builder declined: ${result.reason}`
    : `The library builder asked for more detail (${result.requestedCategories.join(", ")}): ${result.rationale} Refine the accepted background and try again.`;
}
