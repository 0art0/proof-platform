"use client";

import { useRef, useState } from "react";
import { useHydrated } from "../hydration/use-hydrated";
import { ToolbarDialog } from "./toolbar-dialog";
import styles from "./stored-proof-workspace.module.css";

export type SessionVisibility = "private" | "shared";

/** The stored-artifact export of a session (design plan §19; served by the N27 proxy). */
export function exportHref(sessionId: string, confirmPrivate = false): string {
  const base = `/api/proof-sessions/${encodeURIComponent(sessionId)}/export`;
  return confirmPrivate ? `${base}?confirmPrivateExport=true` : base;
}

/** A download name that is safe on every file system. */
export function exportFileName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, "-")}.proof.json`;
}

/**
 * Read a session's visibility (roadmap N36). Rejects with a readable message when it cannot be
 * read, so no caller ever falls back to a link that the worker would refuse.
 */
export async function fetchSessionVisibility(sessionId: string): Promise<SessionVisibility> {
  const failure = "The session's visibility could not be read, so it was not exported.";
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(`/api/proof-sessions/${encodeURIComponent(sessionId)}/visibility`, {
      cache: "no-store",
    });
    body = (await response.json()) as unknown;
  } catch {
    throw new Error(`${failure} The proof service could not be reached.`);
  }
  const data =
    typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  const visibility =
    typeof data === "object" && data !== null
      ? (data as { visibility?: unknown }).visibility
      : undefined;
  if (!response.ok || (visibility !== "private" && visibility !== "shared")) {
    throw new Error(failure);
  }
  return visibility;
}

function browserDownload(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

type ExportState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "checking" }>
  | Readonly<{ kind: "confirming" }>
  | Readonly<{ kind: "failed"; message: string }>;

/**
 * "Export proof": a shared session downloads directly; a private one first asks for an explicit
 * acknowledgement and only then requests the export with `confirmPrivateExport=true`.
 */
export function ExportAction({
  sessionId,
  startDownload = browserDownload,
}: Readonly<{ sessionId: string; startDownload?: (url: string, fileName: string) => void }>) {
  const [state, setState] = useState<ExportState>({ kind: "idle" });
  const generation = useRef(0);
  const hydrated = useHydrated();

  const begin = async () => {
    const current = ++generation.current;
    setState({ kind: "checking" });
    try {
      const visibility = await fetchSessionVisibility(sessionId);
      if (generation.current !== current) return;
      if (visibility === "shared") {
        setState({ kind: "idle" });
        startDownload(exportHref(sessionId), exportFileName(sessionId));
      } else {
        setState({ kind: "confirming" });
      }
    } catch (error) {
      if (generation.current !== current) return;
      setState({
        kind: "failed",
        message: error instanceof Error ? error.message : "The export failed.",
      });
    }
  };

  const cancel = () => {
    generation.current += 1;
    setState({ kind: "idle" });
  };

  const confirm = () => {
    generation.current += 1;
    setState({ kind: "idle" });
    startDownload(exportHref(sessionId, true), exportFileName(sessionId));
  };

  return (
    <>
      <button
        type="button"
        className={styles.toolbarButton}
        disabled={state.kind === "checking"}
        data-hydrated={hydrated}
        onClick={() => void begin()}
      >
        Export proof
      </button>
      <span className={styles.copyFeedback} aria-live="polite" data-state={state.kind}>
        {state.kind === "failed" ? state.message : null}
      </span>
      {state.kind === "confirming" ? (
        <ToolbarDialog
          title="Export a private session"
          description="Exporting saves the full proof history and problem setup as one file. This session is private. Export it anyway?"
          onClose={cancel}
        >
          <div className={styles.toolbar}>
            <button type="button" className={styles.toolbarButton} onClick={confirm}>
              Export anyway
            </button>
            <button type="button" className={styles.toolbarButton} onClick={cancel}>
              Cancel
            </button>
          </div>
        </ToolbarDialog>
      ) : null}
    </>
  );
}
