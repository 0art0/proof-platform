"use client";

import { useState } from "react";
import type { DisplayedSuggestionSet } from "@proof/protocol";
import { z } from "zod";
import styles from "./suggestion-panel.module.css";

/** The shortlister accepts at most this many displayed candidates. */
const MAX_CANDIDATES = 32;

export type AiShortlistProps = Readonly<{
  sessionId: string;
  nodeId: string;
  suggestionSet: DisplayedSuggestionSet;
  disabled: boolean;
  createId?: (prefix: string) => string;
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

type ShortlistState =
  | Readonly<{ kind: "idle" | "loading" }>
  | Readonly<{ kind: "unavailable"; message: string }>
  | Readonly<{
      kind: "shortlisted";
      choices: readonly Readonly<{ suggestionId: string; rationale: string }>[];
    }>;

/**
 * Ask the shortlister to pick the most promising of the displayed suggestions (design plan
 * §15.2). It sees only the selections and these cards; the deterministic list stays as it is,
 * and any failure leaves it the only list.
 */
export function AiShortlist({
  sessionId,
  nodeId,
  suggestionSet,
  disabled,
  createId = (prefix) => `${prefix}-${crypto.randomUUID()}`,
}: AiShortlistProps) {
  const [state, setState] = useState<ShortlistState>({ kind: "idle" });
  const names = new Map(suggestionSet.suggestions.map(({ id, name }) => [id, name]));
  const candidates = suggestionSet.suggestions.slice(0, MAX_CANDIDATES);

  const rank = async () => {
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
          trigger: "explicit-user",
        }),
        cache: "no-store",
      });
      value = await response.json();
    } catch {
      return setState({ kind: "unavailable", message: "The proof service could not be reached." });
    }
    const parsed = answerSchema.safeParse(value);
    if (!parsed.success) {
      return setState({
        kind: "unavailable",
        message: "The proof service returned an invalid response.",
      });
    }
    if (!parsed.data.ok) {
      return setState({
        kind: "unavailable",
        message:
          response.status === 429
            ? "Too many AI requests right now. Wait a minute and try again."
            : parsed.data.error.message,
      });
    }
    const data = parsed.data.data;
    if (data.status !== "shortlisted" || data.suggestionSetId !== suggestionSet.id) {
      return setState({
        kind: "unavailable",
        message:
          data.status === "shortlisted"
            ? "The ranking belongs to a different list."
            : (data.diagnostics[0]?.message ?? "No ranking was produced."),
      });
    }
    setState({ kind: "shortlisted", choices: data.choices });
  };

  return (
    <div className={styles.aiShortlist} role="group" aria-label="AI ranking">
      <button
        type="button"
        className={styles.aiShortlistButton}
        disabled={disabled || state.kind === "loading"}
        onClick={() => void rank()}
      >
        {state.kind === "loading" ? "Ranking…" : "Ask AI to rank these"}
      </button>
      <span className={styles.aiShortlistHint}>
        A model sees only your selection and these cards. The list below does not change.
        {suggestionSet.suggestions.length > MAX_CANDIDATES
          ? ` Only the first ${MAX_CANDIDATES} are ranked.`
          : ""}
      </span>
      {state.kind === "unavailable" ? (
        <p role="status" className={styles.aiShortlistNote}>
          No AI ranking: {state.message} The suggestions below are unaffected.
        </p>
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
