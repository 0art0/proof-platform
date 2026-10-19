"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnchoredProofSelection } from "@proof/selections";
import {
  constantsAnswerSchema,
  describeTopUpFailure,
  describeTopUpOutcome,
  topUpAnswerSchema,
} from "./library-top-up-contract";
import { toDescriptor } from "./selection-descriptor";
import styles from "./suggestion-panel.module.css";

/** What the page says about a library top-up (architecture §2). */
export type TopUpStatus =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "working" }>
  | Readonly<{ kind: "done"; message: string; added: number }>
  | Readonly<{ kind: "failed"; message: string }>;

const IDLE: TopUpStatus = { kind: "idle" };

export type LibraryTopUpOptions = Readonly<{
  sessionId: string;
  /** The current node: after each change the session's activated constants are read again. */
  nodeId: string;
  /** False when the librarian is not configured or the session is read-only: nothing is sent. */
  enabled: boolean;
  createId?: (prefix: string) => string;
}>;

export type LibraryTopUp = Readonly<{
  status: TopUpStatus;
  /** "Find more results": a `no-relevant-results` top-up for these selections. */
  findMoreResults: (selections: readonly AnchoredProofSelection[]) => Promise<void>;
}>;

type Answer =
  Readonly<{ kind: "answer"; status: number; value: unknown }> | Readonly<{ kind: "unreachable" }>;

async function send(url: string, init: RequestInit): Promise<Answer> {
  try {
    const response = await fetch(url, { ...init, cache: "no-store" });
    return { kind: "answer", status: response.status, value: await response.json() };
  } catch {
    return { kind: "unreachable" };
  }
}

/**
 * Library top-ups during a proof. Two kinds, both asking the worker, which builds the librarian's
 * context itself and admits whatever its gate admits as ordinary library additions:
 *
 * - **Find more results** (user-initiated, from the none-relevant notice or the empty state) sends
 *   the current selections. The request is announced inline and answered inline.
 * - **New constants** (automatic): whenever the current node changes, the session's activated
 *   constants are read, and each one that a committed step activated and no recorded top-up
 *   covered gets one `new-constants` request, once per page. There is no review step, and every
 *   failure (rate limit, disabled, stale, unreachable) is silent: the proof is unaffected. Only a
 *   top-up that added results leaves a brief note.
 */
export function useLibraryTopUp({
  sessionId,
  nodeId,
  enabled,
  createId = (prefix) => `${prefix}-${crypto.randomUUID()}`,
}: LibraryTopUpOptions): LibraryTopUp {
  const [status, setStatus] = useState<TopUpStatus>(IDLE);
  const mounted = useRef(true);
  const manual = useRef(false);
  const automatic = useRef(false);
  const rerun = useRef(false);
  const attempted = useRef(new Set<string>());
  // What the in-flight handlers read when their answer arrives; refreshed after every render.
  const latest = useRef({ sessionId, nodeId, createId });
  useEffect(() => {
    latest.current = { sessionId, nodeId, createId };
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const base = `/api/proof-sessions/${encodeURIComponent(sessionId)}`;

  const findMoreResults = useCallback(
    async (selections: readonly AnchoredProofSelection[]) => {
      if (manual.current || !enabled) return;
      if (selections.length === 0) {
        setStatus({
          kind: "failed",
          message: "Select part of the statement first, then ask for more results.",
        });
        return;
      }
      manual.current = true;
      setStatus({ kind: "working" });
      const asked = sessionId;
      const answer = await send(`${base}/ai-library-top-up`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: latest.current.createId("llm-call:find-more"),
          kind: "no-relevant-results",
          expectedCurrentNodeId: latest.current.nodeId,
          // The concrete selection: an abstraction is retrieval-only and is never sent.
          selections: selections.map((selection) => toDescriptor(selection)),
        }),
      });
      manual.current = false;
      if (!mounted.current || latest.current.sessionId !== asked) return;
      if (answer.kind === "unreachable") {
        setStatus({ kind: "failed", message: "The proof service could not be reached." });
        return;
      }
      const parsed = topUpAnswerSchema.safeParse(answer.value);
      if (!parsed.success) {
        setStatus({ kind: "failed", message: "The proof service returned an invalid response." });
        return;
      }
      if (!parsed.data.ok) {
        setStatus({
          kind: "failed",
          message: describeTopUpFailure(
            answer.status,
            parsed.data.error.code,
            parsed.data.error.message,
          ),
        });
        return;
      }
      const outcome = describeTopUpOutcome(parsed.data.data);
      setStatus({ kind: "done", message: outcome.message, added: outcome.added });
    },
    [base, enabled, sessionId],
  );

  useEffect(() => {
    if (!enabled) return;
    const run = async (): Promise<void> => {
      if (automatic.current) {
        rerun.current = true;
        return;
      }
      automatic.current = true;
      const asked = sessionId;
      try {
        const read = await send(`${base}/library/constants`, { method: "GET" });
        if (read.kind !== "answer" || !mounted.current || latest.current.sessionId !== asked)
          return;
        const constants = constantsAnswerSchema.safeParse(read.value);
        if (!constants.success || !constants.data.ok) return;
        const pending = constants.data.data.activated
          .filter(({ topUp, symbol }) => topUp === null && !attempted.current.has(symbol))
          .map(({ symbol }) => symbol);
        if (pending.length === 0) return;
        pending.forEach((symbol) => attempted.current.add(symbol));
        const answer = await send(`${base}/ai-library-top-up`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: latest.current.createId("llm-call:new-constants"),
            kind: "new-constants",
            constants: pending,
          }),
        });
        if (answer.kind !== "answer" || !mounted.current || latest.current.sessionId !== asked)
          return;
        const parsed = topUpAnswerSchema.safeParse(answer.value);
        // Silent unless results were added: a refusal, rate limit or disabled role changes nothing.
        if (!parsed.success || !parsed.data.ok || parsed.data.data.status !== "topped-up") return;
        const { addedCount } = parsed.data.data;
        if (addedCount === 0) return;
        setStatus((current) =>
          current.kind === "working"
            ? current
            : {
                kind: "done",
                added: addedCount,
                message: `The library now has ${addedCount} result${addedCount === 1 ? "" : "s"} about ${pending.join(", ")}, added automatically.`,
              },
        );
      } finally {
        automatic.current = false;
        if (rerun.current) {
          rerun.current = false;
          if (mounted.current) void run();
        }
      }
    };
    void run();
  }, [base, enabled, nodeId, sessionId]);

  return { status, findMoreResults };
}

/** The inline status of a top-up, with a way to ask for suggestions again once results arrived. */
export function TopUpNotice({
  status,
  onAskAgain,
}: Readonly<{ status: TopUpStatus; onAskAgain?: (() => void) | undefined }>) {
  if (status.kind === "idle") return null;
  return (
    <p
      role="status"
      className={styles.topUpNote}
      data-state={status.kind}
      data-testid="library-top-up-status"
    >
      {status.kind === "working" ? "Looking for more results…" : status.message}
      {status.kind === "done" && status.added > 0 && onAskAgain !== undefined ? (
        <>
          {" "}
          <button type="button" className={styles.emptyGuideButton} onClick={onAskAgain}>
            Ask for suggestions again
          </button>
        </>
      ) : null}
    </p>
  );
}
