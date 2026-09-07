"use client";

import Link from "next/link";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ZodType } from "zod";
import {
  apiResponseSchema,
  messagesResponseSchema,
  statusResponseSchema,
  submitIntentRequestSchema,
  submitIntentResponseSchema,
  type OrchestratorMessage,
  type OrchestratorStatus,
  type TaskSummary,
  type TodoNode,
} from "../../lib/orchestrator-contract";

export const ORCHESTRATOR_POLL_INTERVAL_MS = 12_000;

type DataState = "loading" | "ready" | "stale" | "error";

const statusLabels: Readonly<Record<string, string>> = {
  awaiting_approval: "Awaiting approval",
  blocked_dependency: "Blocked by dependency",
  in_progress: "In progress",
  needs_input: "Needs input",
  needs_resolution: "Needs resolution",
  ready_to_integrate: "Ready to integrate",
  retry_wait: "Retry scheduled",
};

function readableStatus(status: string): string {
  return (
    statusLabels[status] ??
    status.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase())
  );
}

function statusTone(status: string): "active" | "blocked" | "complete" | "neutral" {
  if (["done", "integrated", "completed"].includes(status)) return "complete";
  if (
    ["blocked", "blocked_dependency", "failed", "needs_input", "needs_resolution"].includes(status)
  ) {
    return "blocked";
  }
  if (
    ["in_progress", "integrating", "preparing", "reviewing", "running", "verifying"].includes(
      status,
    )
  ) {
    return "active";
  }
  return "neutral";
}

function StatusLabel({ status }: { status: string }) {
  const tone = statusTone(status);
  const icon = tone === "complete" ? "✓" : tone === "blocked" ? "!" : tone === "active" ? "↻" : "•";
  return (
    <span className="orchestrator-status" data-tone={tone}>
      <span aria-hidden="true">{icon}</span>
      <span>{readableStatus(status)}</span>
    </span>
  );
}

function TodoBranch({ node, root = false }: { node: TodoNode; root?: boolean }) {
  return (
    <li className={root ? "todo-node todo-node--root" : "todo-node"}>
      <div className="todo-node__line">
        <span className="todo-node__title">{node.title}</span>
        <StatusLabel status={node.status} />
        {node.taskId ? <span className="todo-node__task">Task {node.taskId}</span> : null}
      </div>
      {node.children.length ? (
        <ul className="todo-tree">
          {node.children.map((child) => (
            <TodoBranch key={child.id} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TaskCard({ task }: { task: TaskSummary }) {
  const attempt =
    task.attempt === 0 ? "Not started" : `Attempt ${task.attempt} of ${task.maxAttempts}`;
  const remainingFailures = Math.max(0, task.maxAttempts - task.failureCount);

  return (
    <article className="task-card" aria-labelledby={`task-${task.id}`}>
      <div className="task-card__heading">
        <div>
          <p className="task-card__path">
            {task.todoPath.length ? task.todoPath.join(" / ") : "Project roadmap"}
          </p>
          <h3 id={`task-${task.id}`}>{task.title}</h3>
        </div>
        <StatusLabel status={task.status} />
      </div>

      <dl className="task-card__facts">
        <div>
          <dt>Attempt</dt>
          <dd>{attempt}</dd>
        </div>
        <div>
          <dt>Failure budget</dt>
          <dd>
            {task.failureCount} used · {remainingFailures} remaining
          </dd>
        </div>
        <div>
          <dt>Dependencies</dt>
          <dd>
            {task.dependencies.length ? (
              <span className="task-card__dependencies">
                {task.dependencies.map((dependency) => (
                  <code key={dependency}>{dependency}</code>
                ))}
              </span>
            ) : (
              "None"
            )}
          </dd>
        </div>
      </dl>

      <div className="task-card__summary">
        <h4>Latest summary</h4>
        <p>{task.summary?.trim() || "No summary has been recorded yet."}</p>
      </div>

      {task.error ? (
        <div className="task-card__error" role="alert">
          <strong>Latest error</strong>
          <p>{task.error}</p>
        </div>
      ) : null}
    </article>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function MessageCard({ message }: { message: OrchestratorMessage }) {
  return (
    <article className="message-card" aria-labelledby={`message-${message.id}`}>
      <div className="message-card__heading">
        <div>
          <h3 id={`message-${message.id}`}>{message.id}</h3>
          <time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time>
        </div>
        <StatusLabel status={message.status} />
      </div>
      <div className="message-card__exchange">
        <div>
          <p className="message-card__speaker">You</p>
          <p>{message.content}</p>
        </div>
        <div>
          <p className="message-card__speaker">Orchestrator</p>
          <p className={!message.reply ? "message-card__pending" : undefined}>
            {message.reply ??
              (message.status === "failed"
                ? "No reply was produced."
                : "The durable supervisor is processing this intent.")}
          </p>
        </div>
      </div>
      {message.lastError ? (
        <p className="message-card__error" role="alert">
          <strong>Error:</strong> {message.lastError}
        </p>
      ) : null}
    </article>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="orchestrator-empty">{children}</div>;
}

async function requestJson<T>(
  input: string,
  dataSchema: ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, { ...init, cache: "no-store" });
  } catch {
    throw new Error("The local dashboard server is unavailable.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("The local dashboard server returned an unreadable response.");
  }

  const envelope = apiResponseSchema(dataSchema).safeParse(body);
  if (!envelope.success) {
    throw new Error("The local dashboard server returned an unexpected response.");
  }
  if (!envelope.data.ok) throw new Error(envelope.data.error.message);
  return envelope.data.data;
}

export function OrchestratorDashboard() {
  const [status, setStatus] = useState<OrchestratorStatus>();
  const [messages, setMessages] = useState<readonly OrchestratorMessage[]>();
  const [dataState, setDataState] = useState<DataState>("loading");
  const [refreshError, setRefreshError] = useState<string>();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number>();
  const [intent, setIntent] = useState("");
  const [submitError, setSubmitError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState<string>();
  const mountedRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const hasDataRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    if (mountedRef.current) setIsRefreshing(true);

    try {
      const [nextStatus, nextMessages] = await Promise.all([
        requestJson("/api/orchestrator/status", statusResponseSchema),
        requestJson("/api/orchestrator/messages?limit=50", messagesResponseSchema),
      ]);
      if (!mountedRef.current) return;
      setStatus(nextStatus);
      setMessages(nextMessages.messages);
      hasDataRef.current = true;
      setDataState("ready");
      setRefreshError(undefined);
      setLastUpdatedAt(Date.now());
    } catch (error) {
      if (!mountedRef.current) return;
      setRefreshError(error instanceof Error ? error.message : "The dashboard could not refresh.");
      setDataState(hasDataRef.current ? "stale" : "error");
    } finally {
      refreshInFlightRef.current = false;
      if (mountedRef.current) setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    let pollTimer: ReturnType<typeof setInterval> | undefined;
    const schedulePolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
      if (!document.hidden) {
        pollTimer = setInterval(() => void refresh(), ORCHESTRATOR_POLL_INTERVAL_MS);
      }
    };
    const handleVisibilityChange = () => {
      schedulePolling();
      if (!document.hidden) void refresh();
    };

    schedulePolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      if (pollTimer) clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refresh]);

  const submitIntent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setConfirmation(undefined);
    const parsed = submitIntentRequestSchema.safeParse({ message: intent });
    if (!parsed.success) {
      setSubmitError("Enter a development intent between 1 and 12,000 characters.");
      return;
    }

    setSubmitError(undefined);
    setIsSubmitting(true);
    try {
      const submitted = await requestJson("/api/orchestrator/intent", submitIntentResponseSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!mountedRef.current) return;
      setIntent("");
      setConfirmation(`Intent ${submitted.messageId} is safely queued as pending.`);
      await refresh();
    } catch (error) {
      if (mountedRef.current) {
        setSubmitError(error instanceof Error ? error.message : "The intent could not be sent.");
      }
    } finally {
      if (mountedRef.current) setIsSubmitting(false);
    }
  };

  const activeTasks =
    status?.tasks.filter((task) => statusTone(task.status) === "active").length ?? 0;
  const blockedTasks =
    status?.tasks.filter((task) => statusTone(task.status) === "blocked").length ?? 0;

  return (
    <section className="orchestrator-dashboard" aria-labelledby="orchestrator-heading">
      <header className="orchestrator-hero">
        <div className="orchestrator-hero__topline">
          <p className="eyebrow">Local control room</p>
          <Link href="/" className="orchestrator-back-link">
            <span aria-hidden="true">←</span> Proof spike
          </Link>
        </div>
        <div className="orchestrator-hero__copy">
          <div>
            <h1 id="orchestrator-heading">Keep the work legible.</h1>
            <p className="lede">
              Submit direction through the bounded supervisor gateway, then follow the durable
              roadmap, attempts, and replies without touching orchestration state directly.
            </p>
          </div>
          <div className="orchestrator-health" aria-label="Current task summary">
            <div>
              <strong>{status?.tasks.length ?? "—"}</strong>
              <span>Total tasks</span>
            </div>
            <div>
              <strong>{status ? activeTasks : "—"}</strong>
              <span>In motion</span>
            </div>
            <div>
              <strong>{status ? blockedTasks : "—"}</strong>
              <span>Need attention</span>
            </div>
          </div>
        </div>
      </header>

      <section className="intent-panel panel" aria-labelledby="intent-heading">
        <div className="intent-panel__copy">
          <p className="panel-kicker">Intent composer</p>
          <h2 id="intent-heading">What should the platform do next?</h2>
          <p>
            This creates a durable message for the read-only planner. It does not approve,
            integrate, or directly change a task.
          </p>
        </div>
        <form className="intent-form" onSubmit={submitIntent}>
          <label htmlFor="orchestrator-intent">Development intent</label>
          <textarea
            id="orchestrator-intent"
            value={intent}
            maxLength={12_000}
            rows={5}
            placeholder="For example: implement the next independently verifiable Stage 1 slice."
            onChange={(event) => setIntent(event.target.value)}
            aria-describedby="intent-guidance intent-count"
            disabled={isSubmitting}
          />
          <div className="intent-form__footer">
            <div>
              <p id="intent-guidance">
                Be explicit about the outcome; the planner will bound the work.
              </p>
              <span id="intent-count">{intent.length.toLocaleString()} / 12,000</span>
            </div>
            <button className="primary-button" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Sending intent…" : "Send to supervisor"}
            </button>
          </div>
          {confirmation ? (
            <p className="intent-confirmation" role="status">
              <span aria-hidden="true">✓</span> {confirmation}
            </p>
          ) : null}
          {submitError ? (
            <p className="intent-error" role="alert">
              <span aria-hidden="true">!</span> {submitError}
            </p>
          ) : null}
        </form>
      </section>

      <div className="orchestrator-refreshbar">
        <div aria-live="polite">
          {dataState === "stale" ? (
            <p className="refresh-state refresh-state--stale">
              <span aria-hidden="true">!</span> Showing the last known durable state. {refreshError}
            </p>
          ) : dataState === "error" ? (
            <p className="refresh-state refresh-state--error">
              <span aria-hidden="true">!</span> Unable to load durable state. {refreshError}
            </p>
          ) : (
            <p className="refresh-state">
              <span aria-hidden="true">●</span>{" "}
              {lastUpdatedAt
                ? `Updated ${new Date(lastUpdatedAt).toLocaleTimeString()}`
                : "Connecting to the local supervisor"}
              {" · Polling pauses while this tab is hidden"}
            </p>
          )}
        </div>
        <button
          className="quiet-button orchestrator-refresh"
          type="button"
          onClick={() => void refresh()}
          disabled={isRefreshing}
        >
          <span aria-hidden="true">↻</span> {isRefreshing ? "Refreshing…" : "Refresh now"}
        </button>
      </div>

      {dataState === "loading" ? (
        <div className="orchestrator-loading" role="status">
          <span className="orchestrator-loading__mark" aria-hidden="true" />
          <div>
            <strong>Reading durable state</strong>
            <p>The gateway is asking the supervisor for the roadmap and recent messages.</p>
          </div>
        </div>
      ) : null}

      {dataState === "error" ? (
        <EmptyState>
          <span className="orchestrator-empty__icon" aria-hidden="true">
            !
          </span>
          <h2>The control room is out of reach</h2>
          <p>{refreshError}</p>
          <button className="primary-button" type="button" onClick={() => void refresh()}>
            Try again
          </button>
        </EmptyState>
      ) : null}

      {status && messages ? (
        <div className="orchestrator-content">
          <section className="roadmap-panel panel" aria-labelledby="roadmap-heading">
            <div className="orchestrator-section-heading">
              <div>
                <p className="panel-kicker">Durable TODO</p>
                <h2 id="roadmap-heading">Roadmap tree</h2>
              </div>
              <span>{status.todo.children.length} top-level branches</span>
            </div>
            {status.todo.children.length ? (
              <ul className="todo-tree todo-tree--root">
                <TodoBranch node={status.todo} root />
              </ul>
            ) : (
              <EmptyState>
                <h3>No roadmap items yet</h3>
                <p>Submit an intent to give the planner its first bounded objective.</p>
              </EmptyState>
            )}
          </section>

          <section className="tasks-panel" aria-labelledby="tasks-heading">
            <div className="orchestrator-section-heading">
              <div>
                <p className="panel-kicker">Execution</p>
                <h2 id="tasks-heading">Task cards</h2>
              </div>
              <span>{status.tasks.length} recorded</span>
            </div>
            {status.tasks.length ? (
              <div className="task-grid">
                {status.tasks.map((task) => (
                  <TaskCard key={task.id} task={task} />
                ))}
              </div>
            ) : (
              <EmptyState>
                <h3>No executable tasks</h3>
                <p>The roadmap is quiet. Planned items will appear here when they become tasks.</p>
              </EmptyState>
            )}
          </section>

          <section className="messages-panel" aria-labelledby="messages-heading">
            <div className="orchestrator-section-heading">
              <div>
                <p className="panel-kicker">Conversation record</p>
                <h2 id="messages-heading">Messages and replies</h2>
              </div>
              <span>Latest {messages.length} of 50</span>
            </div>
            {messages.length ? (
              <div className="message-list">
                {[...messages].reverse().map((message) => (
                  <MessageCard key={message.id} message={message} />
                ))}
              </div>
            ) : (
              <EmptyState>
                <h3>No messages yet</h3>
                <p>Your submitted intent and the orchestrator reply will be retained here.</p>
              </EmptyState>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}
