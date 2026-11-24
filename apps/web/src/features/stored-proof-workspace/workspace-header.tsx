import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ProofNode } from "@proof/protocol";
import { humanizeMoveId } from "../macro-labels";
import styles from "./stored-proof-workspace.module.css";

export type BranchCrumb = Readonly<{ nodeId: string; label: string }>;
/** The part of a stored history edge that the breadcrumb reads. */
export type HistoryEdgeRecord = Readonly<{
  edge: Readonly<{
    parentNodeId: string;
    childNodeId: string;
    /** Set on a step of a multi-step macro application. */
    macro?: Readonly<{ stepIndex: number; stepCount: number }> | undefined;
  }>;
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
    crumbs.push({
      nodeId,
      label:
        record === undefined
          ? "Start"
          : record.edge.macro === undefined
            ? record.name
            : `${humanizeMoveId(record.name)} (step ${record.edge.macro.stepIndex} of ${record.edge.macro.stepCount})`,
    });
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
  title?: string | undefined;
  /** The problem statement as entered, shown in a collapsed section. */
  statement?: string | undefined;
  background?: string | undefined;
  currentNodeId: string;
  counts: SnapshotCounts;
  /** An imported artifact: shown as a badge; every mutating action is disabled elsewhere. */
  readOnly?: boolean | undefined;
  breadcrumb:
    | Readonly<{ kind: "loading" }>
    | Readonly<{ kind: "ready"; crumbs: readonly BranchCrumb[] }>
    | Readonly<{ kind: "unavailable" }>;
  /**
   * Rename the session; an empty title restores the problem title. Resolves with the title now
   * shown, or rejects with a readable message. Absent: the title cannot be edited here.
   */
  onRename?: ((title: string) => Promise<string | undefined>) | undefined;
}>;

/** The session's title, renamed in place: a quiet button turns it into a text field. */
function SessionTitle({
  sessionId,
  title,
  onRename,
}: Readonly<{
  sessionId: string;
  title: string | undefined;
  onRename: (title: string) => Promise<string | undefined>;
}>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const save = async () => {
    if (saving) return;
    if (draft.trim() === (title ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const shown = await onRename(draft.trim());
      setDraft(shown ?? "");
      setEditing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The title could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <form
        className={styles.titleForm}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <input
          ref={input}
          className={styles.titleInput}
          aria-label="Proof title"
          value={draft}
          maxLength={200}
          placeholder="Untitled proof"
          disabled={saving}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(title ?? "");
              setError(undefined);
              setEditing(false);
            }
          }}
        />
        {error === undefined ? null : (
          <p role="alert" className={styles.titleError}>
            {error}
          </p>
        )}
      </form>
    );
  }
  return (
    <div className={styles.titleRow}>
      <h1 title={sessionId}>{title ?? "Untitled proof"}</h1>
      <button
        type="button"
        className={styles.renameButton}
        aria-label="Rename proof"
        title="Rename"
        onClick={() => {
          setDraft(title ?? "");
          setEditing(true);
        }}
      >
        <span aria-hidden="true">✎</span>
      </button>
    </div>
  );
}

export function WorkspaceHeader({
  sessionId,
  title,
  statement,
  background,
  currentNodeId,
  counts,
  readOnly = false,
  breadcrumb,
  onRename,
}: WorkspaceHeaderProps) {
  const closed = counts.goals === 0 && counts.obligations === 0;
  return (
    <header className={styles.sessionHeader} aria-label="Problem" data-node-id={currentNodeId}>
      <div className={styles.headerTitle}>
        {onRename === undefined ? (
          <h1 title={sessionId}>{title ?? "Untitled proof"}</h1>
        ) : (
          <SessionTitle sessionId={sessionId} title={title} onRename={onRename} />
        )}
        {statement === undefined || statement.length === 0 ? null : (
          <details className={styles.headerStatement}>
            <summary>Problem statement</summary>
            <p>{statement}</p>
          </details>
        )}
        {background === undefined || background.length === 0 ? null : (
          <p className={styles.headerBackground}>{background}</p>
        )}
      </div>
      <div className={styles.headerFacts}>
        <p className={styles.snapshotStatus} data-closed={closed} data-testid="snapshot-status">
          {snapshotStatusText(counts)}
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
        {closed ? (
          <Link
            className={styles.toolbarButton}
            href={`/sessions/${encodeURIComponent(sessionId)}/proof`}
          >
            View proof
          </Link>
        ) : null}
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
