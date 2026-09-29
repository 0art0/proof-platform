"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProofNode } from "@proof/protocol";
import type { WorkspaceView } from "../proof-workspace";
import styles from "./stored-proof-workspace.module.css";

export type WorkspaceToolbarProps = Readonly<{
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  sessionId: string;
  node: ProofNode;
  /** The proof actions (N31), rendered as a second toolbar row. */
  children?: ReactNode;
}>;

type CopyState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "copied" }>
  | Readonly<{ kind: "failed"; message: string }>;

const VIEWS: readonly Readonly<{ view: WorkspaceView; label: string }>[] = [
  { view: "formal", label: "Formal (LaTeX)" },
  { view: "natural-language", label: "Natural language" },
];

/** The stored-artifact export of a session (design plan §19; served by the N27 proxy). */
export function exportHref(sessionId: string): string {
  return `/api/proof-sessions/${encodeURIComponent(sessionId)}/export`;
}

/** The static discovery-tree viewer of a session (roadmap N28). */
export function treeHref(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/tree`;
}

/** A download name that is safe on every file system. */
export function exportFileName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, "-")}.proof.json`;
}

/** The exact stored snapshot, serialized deterministically; nothing is recomputed. */
export function proofStateJson(sessionId: string, node: ProofNode): string {
  return JSON.stringify({ sessionId, nodeId: node.id, state: node.state }, null, 2);
}

export function WorkspaceToolbar({
  view,
  onViewChange,
  sessionId,
  node,
  children,
}: WorkspaceToolbarProps) {
  const [copy, setCopy] = useState<CopyState>({ kind: "idle" });
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setCopy({ kind: "idle" });
  }, [node.id]);

  const copyState = async () => {
    const current = ++generation.current;
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    let result: CopyState;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      result = {
        kind: "failed",
        message: "Copy failed: the clipboard is unavailable here. Use “View raw MathJSON” instead.",
      };
    } else {
      try {
        await clipboard.writeText(proofStateJson(sessionId, node));
        result = { kind: "copied" };
      } catch {
        result = {
          kind: "failed",
          message: "Copy failed: clipboard permission was denied. Use “View raw MathJSON” instead.",
        };
      }
    }
    if (generation.current === current) setCopy(result);
  };

  return (
    <div className={styles.toolbarShell}>
      <div className={styles.toolbar} role="toolbar" aria-label="Workspace tools">
        <div className={styles.viewToggle} role="group" aria-label="Statement view">
          {VIEWS.map((option) => (
            <button
              key={option.view}
              type="button"
              aria-pressed={view === option.view}
              onClick={() => onViewChange(option.view)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button type="button" className={styles.toolbarButton} onClick={() => void copyState()}>
          Copy proof state as JSON
        </button>
        <span className={styles.copyFeedback} aria-live="polite" data-state={copy.kind}>
          {copy.kind === "copied" ? "Proof state copied to the clipboard." : null}
          {copy.kind === "failed" ? copy.message : null}
        </span>
        <a
          className={styles.toolbarButton}
          href={exportHref(sessionId)}
          download={exportFileName(sessionId)}
        >
          Export proof
        </a>
        <Link className={styles.toolbarButton} href={treeHref(sessionId)}>
          Open full discovery tree
        </Link>
      </div>
      {children}
      <details className={styles.rawState}>
        <summary>View raw MathJSON</summary>
        <pre data-testid="raw-proof-state">{proofStateJson(sessionId, node)}</pre>
      </details>
    </div>
  );
}
