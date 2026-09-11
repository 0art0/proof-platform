"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DisplayedSuggestionSet, OperatorDeclaration, ProofNode } from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import { ProofWorkspace } from "../proof-workspace";
import {
  suggestionApiResponseSchema,
  suggestionRequestSchema,
  type ProofSelectionDescriptor,
} from "./api-contract";
import styles from "./stored-proof-workspace.module.css";

export type StoredProofSession = Readonly<{
  id: string;
  currentNodeId: string;
  operators: readonly OperatorDeclaration[];
}>;

export type StoredProofWorkspaceProps = Readonly<{
  session: StoredProofSession;
  node: ProofNode;
}>;

type SuggestionState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "empty"; suggestionSet: DisplayedSuggestionSet }>
  | Readonly<{ kind: "ready"; suggestionSet: DisplayedSuggestionSet }>
  | Readonly<{ kind: "rejected"; message: string }>
  | Readonly<{ kind: "stale"; message: string }>;

/** Bind a validated stored snapshot to the reusable interactive proof-state view. */
export function StoredProofWorkspace(props: StoredProofWorkspaceProps) {
  const snapshotKey = JSON.stringify({
    sessionId: props.session.id,
    nodeId: props.node.id,
    stateId: props.node.state.id,
    node: props.node,
    operators: props.session.operators,
  });

  return <SnapshotWorkspace key={snapshotKey} {...props} snapshotKey={snapshotKey} />;
}

function SnapshotWorkspace({
  session,
  node,
  snapshotKey,
}: StoredProofWorkspaceProps & Readonly<{ snapshotKey: string }>) {
  const [suggestions, setSuggestions] = useState<SuggestionState>({ kind: "idle" });
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      requestGeneration.current += 1;
      activeRequest.current?.abort();
    },
    [],
  );

  const handleSelectionChange = useCallback(
    (selections: readonly AnchoredProofSelection[]) => {
      const generation = ++requestGeneration.current;
      activeRequest.current?.abort();
      activeRequest.current = undefined;

      if (selections.length === 0) {
        setSuggestions({ kind: "idle" });
        return;
      }

      const request = suggestionRequestSchema.safeParse({
        id: suggestionSetId(node.state.id, generation),
        selections: selections.map(toDescriptor),
      });
      if (!request.success) {
        setSuggestions({
          kind: "rejected",
          message: "The selected occurrence could not be encoded safely.",
        });
        return;
      }
      if (request.data.selections.some(({ anchor }) => anchor.stateId !== node.state.id)) {
        setSuggestions({
          kind: "stale",
          message: "The selection belongs to an older proof-state snapshot.",
        });
        return;
      }

      const controller = new AbortController();
      activeRequest.current = controller;
      setSuggestions({ kind: "loading" });

      void requestSuggestions(session.id, request.data, controller.signal).then((result) => {
        if (requestGeneration.current !== generation || controller.signal.aborted) {
          return;
        }
        activeRequest.current = undefined;
        if (!result.ok) {
          setSuggestions({
            kind: isStaleFailure(result.error.code, result.error.message) ? "stale" : "rejected",
            message: result.error.message,
          });
          return;
        }
        const suggestionSet = result.data.suggestionSet;
        if (suggestionSet.nodeId !== node.id || suggestionSet.stateId !== node.state.id) {
          setSuggestions({
            kind: "stale",
            message: "The returned suggestions belong to an older proof snapshot.",
          });
          return;
        }
        setSuggestions(
          suggestionSet.suggestions.length === 0
            ? { kind: "empty", suggestionSet }
            : { kind: "ready", suggestionSet },
        );
      });
    },
    [node.id, node.state.id, session.id, snapshotKey],
  );

  const displayedSet =
    suggestions.kind === "ready" || suggestions.kind === "empty"
      ? suggestions.suggestionSet
      : undefined;
  const statusText = useMemo(() => suggestionStatusText(suggestions), [suggestions]);

  return (
    <section className={styles.storedWorkspace} aria-label="Stored proof session">
      <header className={styles.sessionHeader}>
        <div>
          <span>Stored development session</span>
          <strong>{session.id}</strong>
        </div>
        <span>Current node {session.currentNodeId}</span>
      </header>

      <ProofWorkspace
        node={node}
        operators={session.operators}
        onSelectionChange={handleSelectionChange}
      />

      <section className={styles.suggestionPanel} aria-label="Persisted suggestions">
        <div className={styles.suggestionHeading}>
          <div>
            <h2>Suggestions</h2>
            <p className={styles.suggestionMeta}>
              Deterministically ranked and persisted by the proof service.
            </p>
          </div>
          {displayedSet ? <code data-testid="suggestion-set-id">{displayedSet.id}</code> : null}
        </div>

        <p className={styles.status} data-state={suggestions.kind} role="status">
          {statusText}
        </p>

        {suggestions.kind === "ready" ? (
          <ol className={styles.suggestions} data-testid="suggestion-list">
            {suggestions.suggestionSet.suggestions.map((suggestion) => (
              <li
                className={styles.suggestionCard}
                data-artifact-id={suggestion.artifactId}
                data-suggestion-id={suggestion.id}
                key={suggestion.id}
              >
                <header>
                  <div>
                    <h3>{suggestion.name}</h3>
                    <code>{suggestion.artifactId}</code>
                  </div>
                  <span
                    className={styles.applicability}
                    data-applicability={suggestion.applicability}
                  >
                    {suggestion.applicability === "applicable" ? "Applicable" : "Needs input"}
                  </span>
                </header>
                <ul aria-label={`Reasons for ${suggestion.name}`}>
                  {suggestion.reasons.map((reason, index) => (
                    <li key={`${suggestion.id}:reason:${index}`}>{reason}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </section>
  );
}

function toDescriptor(selection: AnchoredProofSelection): ProofSelectionDescriptor {
  return selection.kind === "exact"
    ? { kind: "exact", anchor: selection.anchor, path: [...selection.path] }
    : {
        kind: "associative",
        anchor: selection.anchor,
        containerPath: [...selection.containerPath],
        startOperand: selection.startOperand,
        endOperand: selection.endOperand,
        ...(selection.displayRange === undefined
          ? {}
          : { displayRange: [...selection.displayRange] as [number, number] }),
      };
}

function suggestionSetId(stateId: string, generation: number): string {
  const safeStateId = stateId.replace(/[^A-Za-z0-9._:/-]/g, "-");
  return `suggestion-set:web-${safeStateId}-${generation}-${crypto.randomUUID()}`;
}

async function requestSuggestions(
  sessionId: string,
  request: unknown,
  signal: AbortSignal,
): Promise<ReturnType<typeof suggestionApiResponseSchema.parse>> {
  try {
    const response = await fetch(
      `/api/proof-sessions/${encodeURIComponent(sessionId)}/suggestion-sets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        cache: "no-store",
        signal,
      },
    );
    const parsed = suggestionApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) {
      return {
        ok: false,
        error: {
          code: "invalid_response",
          message: "The suggestion service returned an invalid response.",
        },
      };
    }
    return parsed.data;
  } catch (error) {
    return {
      ok: false,
      error: {
        code:
          error instanceof DOMException && error.name === "AbortError" ? "aborted" : "unavailable",
        message: "The suggestion service could not be reached.",
      },
    };
  }
}

function isStaleFailure(code: string, message: string): boolean {
  return code === "stale_snapshot" || /stale|older|does not match proof state/i.test(message);
}

function suggestionStatusText(state: SuggestionState): string {
  if (state.kind === "idle")
    return "Select one or more anchored occurrences to retrieve suggestions.";
  if (state.kind === "loading") return "Loading suggestions for the current selection…";
  if (state.kind === "empty") return "No persisted suggestions apply to this selection.";
  if (state.kind === "stale") return `Stale selection: ${state.message}`;
  if (state.kind === "rejected") return `Suggestion request rejected: ${state.message}`;
  return `${state.suggestionSet.suggestions.length} persisted suggestion${
    state.suggestionSet.suggestions.length === 1 ? "" : "s"
  } in stored order.`;
}
