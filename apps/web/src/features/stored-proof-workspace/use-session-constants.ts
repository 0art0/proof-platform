"use client";

import { useEffect, useRef, useState } from "react";
import { constantsAnswerSchema, type LibraryConstants } from "./library-top-up-contract";

/** The session's constants as the page last read them. */
export type ConstantsView =
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "ready";
      constants: LibraryConstants;
      /** Symbols a committed step activated since the previous read, for a brief highlight. */
      added: readonly string[];
    }>
  | Readonly<{ kind: "unavailable" }>;

/**
 * Read the session's constants (`GET …/library/constants`) when the page opens and again after
 * every change of the current node: a step that applied a library result may have added a
 * constant to the proof. The previous list stays on screen while the next one loads, and a failed
 * read keeps it (the proof is unaffected), so the list never flickers or disappears.
 */
export function useSessionConstants(
  sessionId: string,
  nodeId: string,
): Readonly<{ view: ConstantsView }> {
  const [view, setView] = useState<ConstantsView>({ kind: "loading" });
  const known = useRef<{ sessionId: string; symbols: ReadonlySet<string> } | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      let constants: LibraryConstants | undefined;
      try {
        const response = await fetch(
          `/api/proof-sessions/${encodeURIComponent(sessionId)}/library/constants`,
          { cache: "no-store", signal: controller.signal },
        );
        const parsed = constantsAnswerSchema.safeParse(await response.json());
        if (parsed.success && parsed.data.ok) constants = parsed.data.data;
      } catch {
        // Unreachable or unreadable: keep what the page already shows.
      }
      if (controller.signal.aborted) return;
      if (constants === undefined) {
        setView((current) => (current.kind === "ready" ? current : { kind: "unavailable" }));
        return;
      }
      const previous = known.current?.sessionId === sessionId ? known.current.symbols : undefined;
      const symbols = new Set(constants.activated.map(({ symbol }) => symbol));
      known.current = { sessionId, symbols };
      setView({
        kind: "ready",
        constants,
        // The first read of a session highlights nothing: only a change is news.
        added:
          previous === undefined
            ? []
            : constants.activated
                .map(({ symbol }) => symbol)
                .filter((symbol) => !previous.has(symbol)),
      });
    })();
    return () => controller.abort();
  }, [sessionId, nodeId]);

  return { view };
}
