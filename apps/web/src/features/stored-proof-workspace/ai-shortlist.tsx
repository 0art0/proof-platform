"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { DisplayedSuggestionSet } from "@proof/protocol";
import { z } from "zod";
import { readAutoRankPreference, writeAutoRankPreference } from "./ai-ranking-preference";
import styles from "./suggestion-panel.module.css";

/** The shortlister accepts at most this many displayed candidates. */
const MAX_CANDIDATES = 32;
/** How long a new list must stay displayed before it is ranked automatically. */
const DEFAULT_AUTO_DELAY_MS = 600;

export type AiShortlistProps = Readonly<{
  sessionId: string;
  nodeId: string;
  suggestionSet: DisplayedSuggestionSet;
  disabled: boolean;
  createId?: (prefix: string) => string;
  /** Pause before an automatic ranking is requested, so quick selection changes cost nothing. */
  autoDelayMs?: number;
  /** "Describe a move" on the none-relevant notice; the button is shown only when provided. */
  onDescribeMove?: (() => void) | undefined;
  /** "Find more results" on the none-relevant notice; shown only when provided. */
  onFindMoreResults?: (() => void) | undefined;
  /** A top-up is already running; "Find more results" waits for it. */
  findMoreBusy?: boolean | undefined;
  /** Why "Find more results" is unavailable; the button is then disabled and says so. */
  findMoreDisabledReason?: string | undefined;
}>;

const answerSchema = z.union([
  z.object({
    ok: z.literal(true),
    data: z.union([
      z.object({
        status: z.literal("shortlisted"),
        suggestionSetId: z.string(),
        choices: z.array(z.object({ suggestionId: z.string(), rationale: z.string() })).min(1),
      }),
      z.object({
        status: z.literal("none-relevant"),
        suggestionSetId: z.string(),
        reason: z.string(),
      }),
      z.object({
        status: z.enum(["deterministic-fallback", "stale"]),
        diagnostics: z.array(z.object({ message: z.string() })),
      }),
    ]),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

type RunTrigger = "explicit-user" | "automatic";

type ShortlistState =
  | Readonly<{ kind: "idle" | "loading" }>
  | Readonly<{ kind: "unavailable"; message: string }>
  | Readonly<{ kind: "none-relevant"; reason: string }>
  | Readonly<{
      kind: "shortlisted";
      choices: readonly Readonly<{ suggestionId: string; rationale: string }>[];
    }>;

const IDLE: ShortlistState = { kind: "idle" };

/**
 * Ask the shortlister to pick the most promising of the displayed suggestions (design plan
 * §15.2, architecture §4). It sees only the selections and these cards; the deterministic list
 * stays as it is, and any failure leaves it the only list.
 *
 * With automatic ranking on (the default, remembered in this browser) a list of two or more
 * suggestions is ranked once, shortly after it appears. An automatic run that cannot produce a
 * ranking says nothing; only an explicit "Ask AI to rank these" reports why it failed. The
 * component must be keyed by the suggestion set: a new set is a new, independent ranking.
 */
export function AiShortlist({
  sessionId,
  nodeId,
  suggestionSet,
  disabled,
  createId = (prefix) => `${prefix}-${crypto.randomUUID()}`,
  autoDelayMs = DEFAULT_AUTO_DELAY_MS,
  onDescribeMove,
  onFindMoreResults,
  findMoreBusy = false,
  findMoreDisabledReason,
}: AiShortlistProps) {
  const [state, setState] = useState<ShortlistState>(IDLE);
  const [automatic, setAutomatic] = useState(readAutoRankPreference);
  const names = new Map(suggestionSet.suggestions.map(({ id, name }) => [id, name]));
  const candidates = suggestionSet.suggestions.slice(0, MAX_CANDIDATES);
  const hintId = useId();
  const mounted = useRef(true);
  // Identifies the latest request: an answer to an older one, or one cancelled by switching
  // automatic ranking off, is ignored.
  const latestRequest = useRef(0);
  const inFlight = useRef<RunTrigger | undefined>(undefined);
  // The set that has been ranked (or is being ranked) already, so it is never ranked twice.
  const requestedFor = useRef<string | undefined>(undefined);

  const run = async (trigger: RunTrigger) => {
    const request = ++latestRequest.current;
    const silent = trigger === "automatic";
    requestedFor.current = suggestionSet.id;
    inFlight.current = trigger;
    const isCurrent = () => mounted.current && latestRequest.current === request;
    const finish = (next: ShortlistState) => {
      if (!isCurrent()) return;
      inFlight.current = undefined;
      setState(next);
    };
    // An automatic run that fails leaves the deterministic list alone and shows nothing.
    const fail = (message: string) => finish(silent ? IDLE : { kind: "unavailable", message });

    setState({ kind: "loading" });
    let response: Response;
    let value: unknown;
    try {
      response = await fetch(`/api/proof-sessions/${encodeURIComponent(sessionId)}/ai-shortlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: createId("llm-call:shortlist"),
          expectedCurrentNodeId: nodeId,
          suggestionSetId: suggestionSet.id,
          candidateIds: candidates.map(({ id }) => id),
          trigger,
        }),
        cache: "no-store",
      });
      value = await response.json();
    } catch {
      return fail("The proof service could not be reached.");
    }
    if (!isCurrent()) return;
    const parsed = answerSchema.safeParse(value);
    if (!parsed.success) return fail("The proof service returned an invalid response.");
    if (!parsed.data.ok) {
      return fail(
        response.status === 429
          ? "Too many AI requests right now. Wait a minute and try again."
          : parsed.data.error.message,
      );
    }
    const data = parsed.data.data;
    if (data.status !== "shortlisted" && data.status !== "none-relevant") {
      return fail(data.diagnostics[0]?.message ?? "No ranking was produced.");
    }
    if (data.suggestionSetId !== suggestionSet.id) {
      return fail("The ranking belongs to a different list.");
    }
    finish(
      data.status === "none-relevant"
        ? { kind: "none-relevant", reason: data.reason }
        : { kind: "shortlisted", choices: data.choices },
    );
  };

  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!automatic || disabled || requestedFor.current === suggestionSet.id) return;
    const timer = setTimeout(() => {
      if (requestedFor.current === suggestionSet.id) return;
      void runRef.current("automatic");
    }, autoDelayMs);
    return () => clearTimeout(timer);
  }, [automatic, disabled, suggestionSet.id, autoDelayMs]);

  const changeAutomatic = (next: boolean) => {
    setAutomatic(next);
    writeAutoRankPreference(next);
    if (!next && inFlight.current === "automatic") {
      // The user turned it off while it was running: drop that answer, and allow a later run.
      latestRequest.current += 1;
      inFlight.current = undefined;
      requestedFor.current = undefined;
      setState(IDLE);
    }
  };

  const loading = state.kind === "loading";
  return (
    <div className={styles.aiShortlist} role="group" aria-label="AI ranking">
      <label className={styles.aiAutoToggle}>
        <input
          type="checkbox"
          checked={automatic}
          onChange={(event) => changeAutomatic(event.target.checked)}
        />
        Rank suggestions with AI automatically
      </label>
      <button
        type="button"
        className={styles.aiShortlistButton}
        disabled={disabled || loading}
        aria-describedby={hintId}
        onClick={() => void run("explicit-user")}
      >
        {loading ? "Ranking…" : "Ask AI to rank these"}
      </button>
      <span id={hintId} className={styles.aiShortlistHint}>
        A model sees only your selection and these cards. The list below does not change.
        {automatic
          ? " Ranking starts by itself when a list appears; switch it off above to send nothing until you ask."
          : " Automatic ranking is off, so nothing is sent until you ask."}
        {suggestionSet.suggestions.length > MAX_CANDIDATES
          ? ` Only the first ${MAX_CANDIDATES} are ranked.`
          : ""}
        {disabled && !loading ? " Ranking is paused while a step is being applied." : ""}
      </span>
      {state.kind === "unavailable" ? (
        <p role="status" className={styles.aiShortlistNote}>
          No AI ranking: {state.message} The suggestions below are unaffected.
        </p>
      ) : null}
      {state.kind === "none-relevant" ? (
        <div className={styles.aiNoneRelevant} role="status">
          <p className={styles.aiShortlistNote}>
            None of these suggestions look relevant to your selection.
          </p>
          <p className={styles.aiShortlistHint}>
            {state.reason} The list below is unchanged if you want to look anyway.
          </p>
          {onDescribeMove !== undefined || onFindMoreResults !== undefined ? (
            <div className={styles.aiNoneRelevantActions}>
              {onDescribeMove !== undefined ? (
                <button type="button" className={styles.aiShortlistButton} onClick={onDescribeMove}>
                  Describe a move
                </button>
              ) : null}
              {onFindMoreResults !== undefined ? (
                <button
                  type="button"
                  className={styles.aiShortlistButton}
                  disabled={findMoreBusy || findMoreDisabledReason !== undefined}
                  aria-describedby={
                    findMoreDisabledReason === undefined ? undefined : `${hintId}-find-more`
                  }
                  onClick={onFindMoreResults}
                >
                  Find more results
                </button>
              ) : null}
            </div>
          ) : null}
          {onFindMoreResults !== undefined && findMoreDisabledReason !== undefined ? (
            <p id={`${hintId}-find-more`} className={styles.aiShortlistHint}>
              {findMoreDisabledReason}
            </p>
          ) : null}
        </div>
      ) : null}
      {state.kind === "shortlisted" ? (
        <>
          <p className={styles.aiShortlistNote}>AI picks, most promising first:</p>
          <ol aria-label="AI picks" className={styles.aiShortlistPicks}>
            {state.choices.map(({ suggestionId, rationale }) => (
              <li key={suggestionId}>
                <strong>{names.get(suggestionId) ?? suggestionId}</strong> — {rationale}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}
