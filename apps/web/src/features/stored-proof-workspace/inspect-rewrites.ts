import type { DisplayedSuggestionSet } from "@proof/protocol";
import { proofSelectionKey } from "../proof-workspace/selection-state";
import type { InspectRewrites } from "../proof-workspace/rewrite-inspection";
import type { InteractionRecorder } from "./interaction-recorder";
import { toDescriptor } from "./selection-descriptor";
import { requestSuggestions } from "./stored-proof-requests";

/** Cache only completed inspections for this snapshot and catalog. Aborted and failed reads can retry. */
export function createRewriteInspector(
  sessionId: string,
  nodeId: DisplayedSuggestionSet["nodeId"],
  record: InteractionRecorder,
  relation: string,
): InspectRewrites {
  const cache = new Map<string, DisplayedSuggestionSet>();
  return async (selection, signal) => {
    const key = proofSelectionKey(selection);
    let set = cache.get(key);
    if (set === undefined) {
      const id = `suggestion-set:hover-${crypto.randomUUID()}`;
      record({ kind: "suggestions-requested", nodeId, suggestionSetId: id });
      const response = await requestSuggestions(
        sessionId,
        {
          id,
          selections: [toDescriptor(selection)],
          rewritesOnly: true,
          ...(relation ? { rewriteRelation: relation } : {}),
        },
        signal,
      );
      if (!response.ok || signal.aborted) return undefined;
      set = response.data.suggestionSet;
      if (set.nodeId !== nodeId || set.stateId !== selection.anchor.stateId) return undefined;
      const oldest = cache.keys().next();
      if (cache.size >= 64 && !oldest.done) cache.delete(oldest.value);
      cache.set(key, set);
    }
    const matches = set.suggestions.filter(
      (item) =>
        item.rewriteRelation !== undefined && (!relation || item.rewriteRelation === relation),
    );
    const shown = matches.slice(0, 3);
    record({
      kind: "suggestions-displayed",
      nodeId,
      suggestionSetId: set.id,
      suggestionIds: shown.map((item) => item.id),
    });
    return {
      names: shown.map(
        (item) => `${item.source === "result" ? "Library" : "Context"} · ${item.name}`,
      ),
      remaining: matches.length - shown.length,
    };
  };
}
