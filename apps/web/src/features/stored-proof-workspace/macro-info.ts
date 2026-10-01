"use client";

import { useEffect, useRef, useState } from "react";
import { authoredMovesApiResponseSchema, type AuthoredMoves } from "../move-authoring/api-contract";

/** What the workspace knows about an approved multi-step macro, read from its stored template. */
export type MacroInfo = Readonly<{ name: string; stepCount: number }>;
export type MacroInfoMap = ReadonlyMap<string, MacroInfo>;

export const NO_MACROS: MacroInfoMap = new Map();

function planStepCount(template: Readonly<Record<string, unknown>>): number | undefined {
  const plan = template["plan"];
  if (typeof plan !== "object" || plan === null) return undefined;
  const steps = (plan as { steps?: unknown }).steps;
  return Array.isArray(steps) ? steps.length : undefined;
}

/** The authored moves whose latest approved (else latest) revision plans more than one step. */
export function macroInfoFrom(moves: AuthoredMoves): MacroInfoMap {
  const info = new Map<string, MacroInfo>();
  for (const move of moves.moves) {
    const approved = move.revisions.filter(({ status }) => status === "approved");
    const pool = approved.length > 0 ? approved : move.revisions;
    let latest: (typeof pool)[number] | undefined;
    for (const revision of pool) {
      if (latest === undefined || revision.revision > latest.revision) latest = revision;
    }
    const stepCount = latest === undefined ? undefined : planStepCount(latest.template);
    if (stepCount !== undefined && stepCount >= 2) {
      info.set(move.moveId, { name: move.name, stepCount });
    }
  }
  return info;
}

export function macroNames(info: MacroInfoMap): ReadonlyMap<string, string> {
  return new Map([...info].map(([id, { name }]) => [id, name]));
}

/**
 * The session's multi-step macros, fetched once when something on the page could be one (an
 * authored suggestion or a macro step in the history). A failed read leaves the map empty: the
 * cards then fall back to what the preview itself reports.
 */
export function useMacroInfo(sessionId: string, wanted: boolean): MacroInfoMap {
  const [info, setInfo] = useState<MacroInfoMap>(NO_MACROS);
  const requested = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!wanted || requested.current) return;
    requested.current = true;
    void (async () => {
      try {
        const response = await fetch(
          `/api/proof-sessions/${encodeURIComponent(sessionId)}/authored-moves`,
          { cache: "no-store" },
        );
        const parsed = authoredMovesApiResponseSchema.safeParse(await response.json());
        if (alive.current && parsed.success && parsed.data.ok) {
          setInfo(macroInfoFrom(parsed.data.data));
        }
      } catch {
        // Macro names are a convenience; the workspace works without them.
      }
    })();
  }, [sessionId, wanted]);
  return info;
}
