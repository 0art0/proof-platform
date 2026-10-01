"use client";

import { useState, type FormEvent } from "react";
import { exportHref, fetchSessionVisibility } from "../stored-proof-workspace/export-action";
import { useHydrated } from "../hydration/use-hydrated";
import styles from "./problem-entry.module.css";

type Diagnostic = Readonly<{ code: string; message: string; path?: readonly (string | number)[] }>;

type UploadNotice =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "uploading" }>
  | Readonly<{ kind: "failed"; message: string; diagnostics: readonly Diagnostic[] }>;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/**
 * "Upload artifact" (design plan §4.1, roadmap N27): read a previously exported artifact file and
 * post it to `/api/artifacts`. The worker revalidates it completely and creates a read-only
 * session, which then opens; a rejection lists the worker's diagnostics.
 */
export function ArtifactUpload({
  navigate = (url) => window.location.assign(url),
}: Readonly<{ navigate?: (url: string) => void }>) {
  const [file, setFile] = useState<File | undefined>(undefined);
  const [notice, setNotice] = useState<UploadNotice>({ kind: "idle" });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (file === undefined) return;
    setNotice({ kind: "uploading" });
    let artifact: unknown;
    try {
      artifact = JSON.parse(await file.text()) as unknown;
    } catch {
      setNotice({ kind: "failed", message: "The file is not valid JSON.", diagnostics: [] });
      return;
    }
    let response: Response;
    let body: unknown;
    try {
      response = await fetch("/api/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(artifact),
      });
      body = (await response.json()) as unknown;
    } catch {
      setNotice({
        kind: "failed",
        message: "The proof service could not be reached.",
        diagnostics: [],
      });
      return;
    }
    const sessionId = uploadedSessionId(body);
    if (response.ok && sessionId !== undefined) {
      setNotice({ kind: "idle" });
      navigate(`/sessions/${encodeURIComponent(sessionId)}`);
      return;
    }
    setNotice(failureNotice(body));
  }

  return (
    <form className={styles.fetchForm} onSubmit={(event) => void submit(event)}>
      <input
        type="file"
        accept="application/json,.json"
        aria-label="Artifact file"
        onChange={(event) => {
          setFile(event.currentTarget.files?.[0]);
          setNotice({ kind: "idle" });
        }}
      />
      <button type="submit" disabled={file === undefined || notice.kind === "uploading"}>
        Open proof file
      </button>
      {notice.kind === "uploading" ? <p role="status">Revalidating the artifact…</p> : null}
      {notice.kind === "failed" ? (
        <div role="alert" className={styles.warning}>
          <p>{notice.message}</p>
          {notice.diagnostics.length > 0 ? (
            <ul>
              {notice.diagnostics.map((diagnostic, index) => (
                <li key={index} data-code={diagnostic.code}>
                  <code>{diagnostic.code}</code>
                  {diagnostic.path === undefined || diagnostic.path.length === 0
                    ? null
                    : ` at ${diagnostic.path.join(".")}`}
                  : {diagnostic.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

type DownloadState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "checking" }>
  | Readonly<{ kind: "confirming"; id: string }>
  | Readonly<{ kind: "failed"; message: string }>;

/**
 * "Download artifact": the export proxy answers with the artifact as an attachment. A shared
 * session downloads directly; a private one needs an explicit acknowledgement first (roadmap N36),
 * and only then is the export requested with `confirmPrivateExport=true`.
 */
export function ArtifactDownload({
  navigate = (url) => window.location.assign(url),
}: Readonly<{ navigate?: (url: string) => void }>) {
  const [sessionId, setSessionId] = useState("");
  const [state, setState] = useState<DownloadState>({ kind: "idle" });
  const hydrated = useHydrated();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = sessionId.trim();
    if (!SESSION_ID_PATTERN.test(id)) return;
    setState({ kind: "checking" });
    try {
      const visibility = await fetchSessionVisibility(id);
      if (visibility === "shared") {
        setState({ kind: "idle" });
        navigate(exportHref(id));
      } else {
        setState({ kind: "confirming", id });
      }
    } catch (error) {
      setState({
        kind: "failed",
        message: error instanceof Error ? error.message : "The export failed.",
      });
    }
  }

  return (
    <form className={styles.fetchForm} onSubmit={(event) => void submit(event)}>
      <input
        aria-label="Saved proof ID to download"
        placeholder="session:…"
        required
        pattern="[A-Za-z0-9][A-Za-z0-9._:/\-]*"
        value={sessionId}
        onChange={(event) => {
          setSessionId(event.currentTarget.value);
          setState({ kind: "idle" });
        }}
      />
      <button type="submit" disabled={state.kind === "checking"} data-hydrated={hydrated}>
        Download artifact
      </button>
      {state.kind === "failed" ? (
        <p role="alert" className={styles.warning}>
          {state.message}
        </p>
      ) : null}
      {state.kind === "confirming" ? (
        <div role="alert" className={styles.warning}>
          <p>This session is private. Export it anyway?</p>
          <button
            type="button"
            onClick={() => {
              setState({ kind: "idle" });
              navigate(exportHref(state.id, true));
            }}
          >
            Export anyway
          </button>{" "}
          <button type="button" onClick={() => setState({ kind: "idle" })}>
            Cancel
          </button>
        </div>
      ) : null}
    </form>
  );
}

function uploadedSessionId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as Readonly<{ ok?: unknown; data?: unknown }>).data;
  if (
    (body as Readonly<{ ok?: unknown }>).ok !== true ||
    typeof data !== "object" ||
    data === null
  ) {
    return undefined;
  }
  const sessionId = (data as Readonly<{ sessionId?: unknown }>).sessionId;
  return typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId)
    ? sessionId
    : undefined;
}

function failureNotice(body: unknown): UploadNotice {
  const failure = (typeof body === "object" && body !== null ? body : {}) as Readonly<{
    error?: Readonly<{ message?: unknown }>;
    details?: Readonly<{ diagnostics?: unknown }>;
  }>;
  const diagnostics = Array.isArray(failure.details?.diagnostics)
    ? (failure.details.diagnostics as unknown[]).filter(isDiagnostic)
    : [];
  const message =
    typeof failure.error?.message === "string" && failure.error.message.length > 0
      ? failure.error.message
      : "The artifact was rejected.";
  return { kind: "failed", message: `The artifact was not imported: ${message}`, diagnostics };
}

function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Diagnostic).code === "string" &&
    typeof (value as Diagnostic).message === "string"
  );
}
