"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ProofArtifact } from "@proof/protocol";
import type { WorkspaceView } from "../proof-workspace";
import { usePresentation } from "../proof-workspace/presentation";
import { indexArtifact } from "./artifact-data";
import styles from "./discovery-viewer.module.css";
import { SuggestionSetView, StateSnapshotView, ViewToggle } from "./statement-views";
import {
  ROUTE_STATUS_LABELS,
  buildTreeLayout,
  treeEdgeView,
  type TreeEdgeView,
  type TreeRowView,
} from "./tree-layout";
import { ViewerShell } from "./viewer-shell";

const EVIDENCE_LABELS = {
  structural: "Structural",
  "library-result": "Library result",
  "background-inference": "Background inference",
  sorry: "Sorry",
} as const;

function EdgeSummary({ edge }: Readonly<{ edge: TreeEdgeView }>) {
  return (
    <span className={styles.edgeSummary} data-edge-id={edge.edgeId}>
      <span aria-hidden="true">↳ </span>
      <strong>{edge.label}</strong>
      <span className={styles.chip}>{edge.transitionClass}</span>
      {edge.evidence === undefined ? null : (
        <span className={styles.chip}>{EVIDENCE_LABELS[edge.evidence]}</span>
      )}
    </span>
  );
}

function NodeBadges({ row }: Readonly<{ row: TreeRowView }>) {
  return (
    <span className={styles.badges}>
      {row.isRoot ? <span className={styles.chip}>Root</span> : null}
      {row.isCurrent ? <span className={styles.chip}>Current node</span> : null}
      <span className={styles.chip} data-route-status={row.routeStatus}>
        <span aria-hidden="true">
          {row.routeStatus === "abandoned"
            ? "✕ "
            : row.routeStatus === "solved-route"
              ? "✓ "
              : "◐ "}
        </span>
        {ROUTE_STATUS_LABELS[row.routeStatus]}
      </span>
      {row.assumptionCount > 0 ? (
        <span className={styles.chip}>
          <span aria-hidden="true">△ </span>
          {row.assumptionCount} {row.assumptionCount === 1 ? "assumption" : "assumptions"}
        </span>
      ) : null}
    </span>
  );
}

/** The full discovery tree, every retained node and edge (including abandoned branches). */
export function DiscoveryTreeView({ artifact }: Readonly<{ artifact: ProofArtifact }>) {
  const layout = useMemo(() => buildTreeLayout(artifact), [artifact]);
  const index = useMemo(() => indexArtifact(artifact), [artifact]);
  const presentation = usePresentation(artifact.initialState.operators);
  const [view, setView] = useState<WorkspaceView>("formal");
  const [selectedId, setSelectedId] = useState<string>(artifact.tree.currentNodeId);
  const outline = useRef<HTMLOListElement>(null);

  const selectedNode = index.nodes.get(selectedId);
  const selectedEdge = index.edgesByChild.get(selectedId);
  const outgoing = index.edgesByParent.get(selectedId) ?? [];
  const suggestionSets = artifact.tree.suggestionSets.filter((set) => set.nodeId === selectedId);
  const chosenIds = new Set(
    outgoing.flatMap((edge) =>
      edge.chosenSuggestionId === undefined ? [] : [edge.chosenSuggestionId],
    ),
  );

  const moveFocus = (event: KeyboardEvent<HTMLOListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...(outline.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.findIndex((button) => button === document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    buttons[
      Math.min(buttons.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))
    ]?.focus();
  };

  return (
    <ViewerShell artifact={artifact} active="tree">
      <div className={styles.toolbarRow}>
        <ViewToggle view={view} onChange={setView} />
        <span className={styles.muted}>{layout.rows.length} proof states</span>
      </div>
      <div className={styles.treeLayout}>
        <nav aria-label="Discovery tree outline" className={styles.outline}>
          <ol ref={outline} onKeyDown={moveFocus} data-testid="tree-outline">
            {layout.rows.map((row, position) => (
              <li
                key={row.nodeId}
                data-node-id={row.nodeId}
                data-depth={row.depth}
                style={{ paddingInlineStart: `${row.depth * 1.1}rem` }}
              >
                {row.parentEdge === undefined ? null : <EdgeSummary edge={row.parentEdge} />}
                <button
                  type="button"
                  aria-pressed={row.nodeId === selectedId}
                  aria-label={`Node ${row.nodeId}, depth ${row.depth}`}
                  onClick={() => setSelectedId(row.nodeId)}
                >
                  {row.isRoot ? "Starting point" : `State ${position + 1}`}
                </button>
                <NodeBadges row={row} />
                <span className={styles.muted}>
                  {row.goalCount} {row.goalCount === 1 ? "goal" : "goals"}, {row.obligationCount}{" "}
                  {row.obligationCount === 1 ? "obligation" : "obligations"}
                </span>
              </li>
            ))}
          </ol>
        </nav>
        <section className={styles.detail} aria-label="Node detail" data-testid="node-detail">
          {selectedNode === undefined ? (
            <p>This node is not stored in the artifact.</p>
          ) : (
            <>
              <h2>
                {selectedId === artifact.tree.rootNodeId ? "Starting point" : "Selected state"}
              </h2>
              {selectedEdge === undefined ? (
                <p>This is where the proof began.</p>
              ) : (
                <>
                  <p>Reached by {treeEdgeView(index, selectedEdge).label}.</p>
                  <button type="button" onClick={() => setSelectedId(selectedEdge.parentNodeId)}>
                    View previous state
                  </button>
                </>
              )}
              <h3>Proof state here</h3>
              <StateSnapshotView
                state={selectedNode.state}
                presentation={presentation}
                view={view}
              />
              <h3>Suggestions shown here</h3>
              {suggestionSets.length === 0 ? (
                <p>No suggestions were shown here.</p>
              ) : (
                suggestionSets.map((set) => (
                  <SuggestionSetView key={set.id} set={set} chosenSuggestionIds={chosenIds} />
                ))
              )}
              <h3>Next steps tried</h3>
              {outgoing.length === 0 ? (
                <p>No further steps were tried here.</p>
              ) : (
                <ul aria-label="Outgoing transitions">
                  {outgoing.map((edge) => (
                    <li key={edge.id}>
                      <EdgeSummary edge={treeEdgeView(index, edge)} />{" "}
                      <button
                        type="button"
                        data-child-node-id={edge.childNodeId}
                        aria-label={`View state after ${treeEdgeView(index, edge).label}`}
                        onClick={() => setSelectedId(edge.childNodeId)}
                      >
                        View this state
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <details className={styles.technicalDetails}>
                <summary>Recorded details</summary>
                <dl className={styles.facts} aria-label="Incoming transition">
                  <dt>Node</dt>
                  <dd>
                    <code>{selectedNode.id}</code>
                  </dd>
                  {selectedEdge === undefined ? null : (
                    <>
                      <dt>Operation</dt>
                      <dd>
                        <code>{selectedEdge.operation.kind}</code>
                      </dd>
                      <dt>Transition class</dt>
                      <dd>{selectedEdge.transitionClass}</dd>
                      <dt>Command</dt>
                      <dd>
                        <code>{selectedEdge.commandId}</code>
                      </dd>
                    </>
                  )}
                </dl>
              </details>
            </>
          )}
        </section>
      </div>
    </ViewerShell>
  );
}
