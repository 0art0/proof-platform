import type { ProofNode } from "@proof/protocol";
import styles from "./stored-proof-workspace.module.css";

export type BranchCrumb = Readonly<{ nodeId: string; label: string }>;
/** The part of a stored history edge that the breadcrumb reads. */
export type HistoryEdgeRecord = Readonly<{
  edge: Readonly<{ parentNodeId: string; childNodeId: string }>;
  name: string;
}>;

/**
 * The retained branch from the history root to `currentNodeId`, following parent edges. Returns
 * undefined when the history does not contain a well-formed path to the current node.
 */
export function branchBreadcrumb(
  nodes: readonly ProofNode[],
  edges: readonly HistoryEdgeRecord[],
  currentNodeId: string,
): readonly BranchCrumb[] | undefined {
  const known = new Set<string>(nodes.map((node) => node.id));
  if (!known.has(currentNodeId)) return undefined;
  const incoming = new Map(edges.map((record) => [record.edge.childNodeId, record]));
  const crumbs: BranchCrumb[] = [];
  const visited = new Set<string>();
  let nodeId: string | undefined = currentNodeId;
  while (nodeId !== undefined) {
    if (visited.has(nodeId) || !known.has(nodeId)) return undefined;
    visited.add(nodeId);
    const record = incoming.get(nodeId);
    crumbs.push({ nodeId, label: record === undefined ? "Root" : record.name });
    nodeId = record?.edge.parentNodeId;
  }
  return crumbs.reverse();
}

const MAX_VISIBLE_CRUMBS = 5;

/** Keep the root and the last steps; `undefined` marks the collapsed middle. */
function collapseCrumbs(crumbs: readonly BranchCrumb[]): readonly (BranchCrumb | undefined)[] {
  if (crumbs.length <= MAX_VISIBLE_CRUMBS) return crumbs;
  return [crumbs[0], undefined, ...crumbs.slice(-(MAX_VISIBLE_CRUMBS - 2))];
}

export type SnapshotCounts = Readonly<{ goals: number; obligations: number }>;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Target counts of the displayed snapshot. This is not the provability-route result (N17). */
export function snapshotStatusText({ goals, obligations }: SnapshotCounts): string {
  return goals === 0 && obligations === 0
    ? "No open goals"
    : `Open: ${plural(goals, "goal")}, ${plural(obligations, "obligation")}`;
}

export type WorkspaceHeaderProps = Readonly<{
  sessionId: string;
  /** Problem metadata is not stored yet (N05/N26); the session id is the fallback title. */
  title?: string | undefined;
  background?: string | undefined;
  currentNodeId: string;
  counts: SnapshotCounts;
  /** An imported artifact: shown as a badge; every mutating action is disabled elsewhere. */
  readOnly?: boolean | undefined;
  breadcrumb:
    | Readonly<{ kind: "loading" }>
    | Readonly<{ kind: "ready"; crumbs: readonly BranchCrumb[] }>
    | Readonly<{ kind: "unavailable" }>;
}>;

export function WorkspaceHeader({
  sessionId,
  title,
  background,
  currentNodeId,
  counts,
  readOnly = false,
  breadcrumb,
}: WorkspaceHeaderProps) {
  const closed = counts.goals === 0 && counts.obligations === 0;
  return (
    <header className={styles.sessionHeader} aria-label="Problem">
      <div className={styles.headerTitle}>
        <p className={styles.headerEyebrow}>{title === undefined ? "Proof session" : sessionId}</p>
        <h1>{title ?? sessionId}</h1>
        {background === undefined || background.length === 0 ? null : (
          <p className={styles.headerBackground}>{background}</p>
        )}
      </div>
      <div className={styles.headerFacts}>
        <p
          className={styles.snapshotStatus}
          data-closed={closed}
          data-testid="snapshot-status"
          title="Counts the open targets of the displayed snapshot. It is not a provability check."
        >
          <span aria-hidden="true">{closed ? "✓" : "○"}</span>{" "}
          <span className={styles.snapshotStatusLabel}>Snapshot targets:</span>{" "}
          <strong>{snapshotStatusText(counts)}</strong>
        </p>
        {readOnly ? (
          <span
            className={styles.readOnlyBadge}
            data-testid="read-only-badge"
            title="This session is read-only (imported artifact)"
          >
            Read-only · imported artifact
          </span>
        ) : null}
        <span>Current node {currentNodeId}</span>
      </div>
      <nav className={styles.breadcrumb} aria-label="Current branch">
        {breadcrumb.kind === "loading" ? <span>Loading branch…</span> : null}
        {breadcrumb.kind === "unavailable" ? <span>Branch unavailable</span> : null}
        {breadcrumb.kind === "ready" ? (
          <ol>
            {collapseCrumbs(breadcrumb.crumbs).map((crumb, index, shown) => {
              if (crumb === undefined) {
                const hidden = breadcrumb.crumbs.length - (shown.length - 1);
                return (
                  <li key="collapsed" aria-label={`${hidden} earlier steps`}>
                    …
                  </li>
                );
              }
              const current = index === shown.length - 1;
              return (
                <li
                  key={crumb.nodeId}
                  data-crumb-node-id={crumb.nodeId}
                  aria-current={current ? "step" : undefined}
                  title={crumb.nodeId}
                >
                  {crumb.label}
                </li>
              );
            })}
          </ol>
        ) : null}
      </nav>
    </header>
  );
}
