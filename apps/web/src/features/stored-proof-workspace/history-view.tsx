"use client";

import { Fragment, useMemo } from "react";
import type { Presentation } from "@proof/language";
import type { ProofEdge, ProofNode } from "@proof/protocol";
import { macroDisplayName, macroStepLabel, humanizeMoveId } from "../macro-labels";
import type { WorkspaceView } from "../proof-workspace";
import { StatementView } from "../proof-workspace/presentation";
import { macroNames, type MacroInfoMap } from "./macro-info";
import type { HistoryEdge } from "./toolbar-actions";
import styles from "./stored-proof-workspace.module.css";

export type HistoryState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; nodes: readonly ProofNode[]; edges: readonly HistoryEdge[] }>
  | Readonly<{ kind: "rejected"; message: string }>;

type ReadOnlyPresentation = Readonly<{ presentation: Presentation; view: WorkspaceView }>;

export function HistoryView({
  history,
  currentNodeId,
  macros,
  mutationPending,
  presentation,
  view,
  onBacktrack,
}: ReadOnlyPresentation &
  Readonly<{
    history: HistoryState;
    currentNodeId: string;
    macros: MacroInfoMap;
    mutationPending: boolean;
    onBacktrack: (id: string) => Promise<void>;
  }>) {
  const rows = useMemo(
    () => (history.kind === "ready" ? orderedHistory(history.nodes, history.edges) : []),
    [history],
  );
  return (
    <section className={styles.historyPanel} aria-label="Proof-discovery tree">
      <div className={styles.historyHeading}>
        <div>
          <h2>Proof-discovery tree</h2>
          <p>Backtracking preserves every existing branch.</p>
        </div>
        {history.kind === "ready" ? (
          <span className={styles.historyCount}>{history.edges.length} transitions</span>
        ) : null}
      </div>
      {history.kind === "loading" ? <p>Loading retained history…</p> : null}
      {history.kind === "rejected" ? (
        <p role="alert">History unavailable: {history.message}</p>
      ) : null}
      {history.kind === "ready" ? (
        <ol className={styles.historyList}>
          {rows.map(({ node, incoming, depth }) => {
            const link = incoming?.edge.macro;
            return (
              <Fragment key={node.id}>
                {link === undefined || link.stepIndex !== 1 ? null : (
                  <li
                    className={styles.historyMacroHeader}
                    data-macro-application={link.previewId}
                    style={{ paddingLeft: `${depth * 1.1}rem` }}
                  >
                    <strong>Macro: {macroDisplayName(link.moveId, macroNames(macros))}</strong>{" "}
                    <span>
                      {link.stepCount} steps applied as one move. Deleting the previous move removes
                      them all.
                    </span>
                  </li>
                )}
                <li
                  className={styles.historyItem}
                  data-macro-step={link?.stepIndex}
                  style={{ paddingLeft: `${depth * 1.1}rem` }}
                >
                  <button
                    className={styles.historyNode}
                    data-current={node.id === currentNodeId}
                    aria-current={node.id === currentNodeId ? "true" : undefined}
                    data-history-node-id={node.id}
                    disabled={node.id === currentNodeId || mutationPending}
                    type="button"
                    onClick={() => void onBacktrack(node.id)}
                  >
                    <span>
                      <HistoryNodeLabel node={node} presentation={presentation} view={view} />
                    </span>
                    <small>
                      {incoming === undefined
                        ? `Root · ${node.id}`
                        : link === undefined
                          ? `${incoming.name} · ${incoming.edge.transitionClass}${proposalNote(incoming.edge)} · ${node.id}`
                          : `${macroStepLabel(link, macroNames(macros))} · ${humanizeMoveId(incoming.name)} · ${incoming.edge.transitionClass} · ${node.id}`}
                    </small>
                  </button>
                </li>
              </Fragment>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

/** A step a model proposed and the user confirmed says so in the history. */
function proposalNote(edge: ProofEdge): string {
  if (edge.proposal === undefined) return "";
  const origin =
    edge.proposal.source === "user-proposal"
      ? "from your description"
      : "from a suggested technique";
  return ` · AI step ${edge.proposal.stepIndex} of ${edge.proposal.stepCount} ${origin}`;
}

type HistoryRow = Readonly<{
  node: ProofNode;
  incoming: HistoryEdge | undefined;
  depth: number;
}>;

/**
 * The retained nodes in depth-first order, each branch in the order its edges were recorded, with
 * the edge that led to the node and its depth. The walk keeps its own stack, so a long chain of
 * steps cannot overflow the call stack.
 */
export function orderedHistory(
  nodes: readonly ProofNode[],
  edges: readonly HistoryEdge[],
): readonly HistoryRow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(edges.map((record) => [record.edge.childNodeId, record]));
  const children = new Map<string, HistoryEdge[]>();
  for (const record of edges) {
    const siblings = children.get(record.edge.parentNodeId);
    if (siblings === undefined) children.set(record.edge.parentNodeId, [record]);
    else siblings.push(record);
  }
  const root = nodes.find((candidate) => !incoming.has(candidate.id));
  if (root === undefined) return [];
  const result: HistoryRow[] = [];
  const pending: HistoryRow[] = [{ node: root, incoming: undefined, depth: 0 }];
  for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
    result.push(row);
    const outgoing = children.get(row.node.id) ?? [];
    // Pushed last-first, so the first recorded branch is visited first.
    for (let index = outgoing.length - 1; index >= 0; index -= 1) {
      const childEdge = outgoing[index];
      const child = childEdge === undefined ? undefined : byId.get(childEdge.edge.childNodeId);
      if (child !== undefined) {
        pending.push({ node: child, incoming: childEdge, depth: row.depth + 1 });
      }
    }
  }
  return result;
}

function HistoryNodeLabel({
  node,
  presentation,
  view,
}: ReadOnlyPresentation & Readonly<{ node: ProofNode }>) {
  const goal = node.state.goals[0];
  const first = goal ?? node.state.obligations[0];
  if (first === undefined) return <>No open goals</>;
  return (
    <>
      {goal === undefined ? "Obligation: " : "Goal: "}
      <StatementView
        expression={first.sequent.conclusion.expression}
        declarations={first.sequent.context.declarations}
        presentation={presentation}
        view={view}
      />
    </>
  );
}
