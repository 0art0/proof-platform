from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

from .util import AgentCtlError, epoch_now, json_dumps, safe_slug, stable_token, utc_now


TASK_TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"preparing", "cancelled", "blocked_dependency"}),
    "preparing": frozenset({"running", "retry_wait", "failed", "cancelled"}),
    "running": frozenset({"verifying", "retry_wait", "needs_input", "failed", "cancelled"}),
    "verifying": frozenset({"reviewing", "retry_wait", "rework", "failed", "cancelled"}),
    "reviewing": frozenset({"awaiting_approval", "ready_to_integrate", "retry_wait", "rework", "needs_input", "failed", "cancelled"}),
    "rework": frozenset({"preparing", "cancelled", "failed"}),
    "retry_wait": frozenset({"preparing", "cancelled", "failed"}),
    "needs_input": frozenset({"queued", "cancelled", "failed"}),
    "awaiting_approval": frozenset({"ready_to_integrate", "rework", "cancelled"}),
    "ready_to_integrate": frozenset({"integrating", "rework", "cancelled"}),
    "integrating": frozenset({"integrated", "needs_resolution", "failed"}),
    "needs_resolution": frozenset({"ready_to_integrate", "cancelled", "failed"}),
    "blocked_dependency": frozenset({"queued", "cancelled"}),
    "failed": frozenset({"queued", "cancelled"}),
    "cancelled": frozenset(),
    "integrated": frozenset(),
}


SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    base_branch TEXT NOT NULL,
    base_sha TEXT,
    branch TEXT,
    worktree TEXT,
    tmux_session TEXT,
    thread_id TEXT,
    reviewer_thread_id TEXT,
    scope_json TEXT NOT NULL,
    checks_json TEXT NOT NULL,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    attempt INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    fencing_token TEXT,
    next_wake_at REAL,
    candidate_sha TEXT,
    integrated_sha TEXT,
    result_summary TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    PRIMARY KEY (task_id, depends_on),
    CHECK (task_id <> depends_on)
);

CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    fencing_token TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    exit_code INTEGER,
    thread_id TEXT,
    log_path TEXT,
    result_path TEXT,
    output_digest TEXT,
    UNIQUE(task_id, attempt, phase)
);

CREATE TABLE IF NOT EXISTS verification_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    candidate_sha TEXT,
    phase TEXT NOT NULL,
    command_json TEXT NOT NULL,
    cwd TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    exit_code INTEGER,
    elapsed_seconds REAL NOT NULL,
    output TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_pools (
    pool TEXT PRIMARY KEY,
    retry_at REAL NOT NULL,
    reason TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    reply TEXT,
    thread_id TEXT,
    next_wake_at REAL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (task_id IS NOT NULL OR message_id IS NOT NULL OR kind LIKE 'system.%')
);

CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS tasks_wake_idx ON tasks(next_wake_at) WHERE next_wake_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_status_idx ON messages(status, created_at);
CREATE INDEX IF NOT EXISTS events_task_idx ON events(task_id, id);
"""


class State:
    def __init__(self, path: Path):
        self.path = path
        self.connection = sqlite3.connect(path, timeout=10, isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA busy_timeout = 10000")
        self.connection.execute("PRAGMA journal_mode = WAL")
        self.connection.execute("PRAGMA synchronous = FULL")

    def close(self) -> None:
        self.connection.close()

    def migrate(self) -> None:
        self.connection.executescript(SCHEMA)
        with self.transaction():
            self.connection.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)",
                (utc_now(),),
            )
            columns = {
                str(row[1]) for row in self.connection.execute("PRAGMA table_info(tasks)").fetchall()
            }
            if "failure_count" not in columns:
                self.connection.execute(
                    "ALTER TABLE tasks ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0"
                )
            self.connection.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, ?)",
                (utc_now(),),
            )

    @contextmanager
    def transaction(self) -> Iterator[None]:
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.connection.execute("ROLLBACK")
            raise
        else:
            self.connection.execute("COMMIT")

    def integrity_check(self) -> str:
        row = self.connection.execute("PRAGMA integrity_check").fetchone()
        return str(row[0]) if row else "unknown"

    def backup(self, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        target = sqlite3.connect(destination)
        try:
            self.connection.backup(target)
        finally:
            target.close()

    def event(
        self,
        *,
        actor: str,
        kind: str,
        payload: dict[str, Any],
        task_id: str | None = None,
        message_id: str | None = None,
    ) -> None:
        self.connection.execute(
            "INSERT INTO events(task_id, message_id, actor, kind, payload_json, created_at) VALUES(?,?,?,?,?,?)",
            (task_id, message_id, actor, kind, json_dumps(payload), utc_now()),
        )

    def create_task(
        self,
        *,
        title: str,
        prompt: str,
        scopes: Sequence[str],
        checks: Sequence[str],
        base_branch: str,
        max_attempts: int,
        dependencies: Sequence[str] = (),
        priority: int = 0,
        capabilities: Sequence[str] = (),
    ) -> str:
        if not title.strip() or not prompt.strip():
            raise AgentCtlError("task title and prompt must not be empty")
        if not scopes:
            raise AgentCtlError("at least one write scope is required")
        task_id = f"{safe_slug(title, limit=28)}-{uuid.uuid4().hex[:8]}"
        now = utc_now()
        with self.transaction():
            self.connection.execute(
                """
                INSERT INTO tasks(
                    id, title, prompt, status, priority, base_branch, scope_json,
                    checks_json, capabilities_json, max_attempts, created_at, updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    task_id,
                    title.strip(),
                    prompt.strip(),
                    "queued",
                    priority,
                    base_branch,
                    json_dumps(list(scopes)),
                    json_dumps(list(checks)),
                    json_dumps(list(capabilities)),
                    max_attempts,
                    now,
                    now,
                ),
            )
            for dependency in dependencies:
                self.connection.execute(
                    "INSERT INTO task_dependencies(task_id, depends_on) VALUES(?,?)",
                    (task_id, dependency),
                )
            self.event(
                task_id=task_id,
                actor="supervisor",
                kind="task.created",
                payload={"title": title, "scopes": list(scopes), "dependencies": list(dependencies)},
            )
        return task_id

    def get_task(self, task_id: str) -> dict[str, Any]:
        row = self.connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise AgentCtlError(f"unknown task: {task_id}")
        return self._decode_task(row)

    def list_tasks(self) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM tasks ORDER BY created_at, id"
        ).fetchall()
        return [self._decode_task(row) for row in rows]

    def dependencies(self, task_id: str) -> list[str]:
        rows = self.connection.execute(
            "SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY depends_on",
            (task_id,),
        ).fetchall()
        return [str(row[0]) for row in rows]

    def events(self, task_id: str, limit: int = 100) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?",
            (task_id, limit),
        ).fetchall()
        return [dict(row) | {"payload": json.loads(row["payload_json"])} for row in reversed(rows)]

    def transition(
        self,
        task_id: str,
        target: str,
        *,
        actor: str,
        payload: dict[str, Any] | None = None,
        fields: dict[str, Any] | None = None,
        expected: str | None = None,
    ) -> dict[str, Any]:
        payload = payload or {}
        fields = fields or {}
        with self.transaction():
            current_row = self.connection.execute(
                "SELECT * FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
            if current_row is None:
                raise AgentCtlError(f"unknown task: {task_id}")
            current = str(current_row["status"])
            if expected is not None and current != expected:
                raise AgentCtlError(
                    f"stale task transition for {task_id}: expected {expected}, found {current}"
                )
            if target not in TASK_TRANSITIONS.get(current, frozenset()):
                raise AgentCtlError(f"illegal task transition: {current} -> {target}")
            allowed_fields = {
                "base_sha",
                "branch",
                "worktree",
                "tmux_session",
                "thread_id",
                "reviewer_thread_id",
                "attempt",
                "failure_count",
                "fencing_token",
                "next_wake_at",
                "candidate_sha",
                "integrated_sha",
                "result_summary",
                "last_error",
            }
            unknown = set(fields) - allowed_fields
            if unknown:
                raise AgentCtlError(f"unsupported task fields: {', '.join(sorted(unknown))}")
            assignments = ["status = ?", "updated_at = ?"]
            values: list[Any] = [target, utc_now()]
            for key, value in fields.items():
                assignments.append(f"{key} = ?")
                values.append(value)
            values.extend((task_id, current))
            cursor = self.connection.execute(
                f"UPDATE tasks SET {', '.join(assignments)} WHERE id = ? AND status = ?",
                values,
            )
            if cursor.rowcount != 1:
                raise AgentCtlError(f"concurrent transition rejected for {task_id}")
            self.event(
                task_id=task_id,
                actor=actor,
                kind="task.transition",
                payload={"from": current, "to": target, **payload},
            )
        return self.get_task(task_id)

    def update_task(self, task_id: str, *, actor: str, fields: dict[str, Any], kind: str) -> None:
        allowed_fields = {
            "base_sha",
            "branch",
            "worktree",
            "tmux_session",
            "thread_id",
            "reviewer_thread_id",
            "next_wake_at",
            "candidate_sha",
            "integrated_sha",
            "result_summary",
            "last_error",
        }
        unknown = set(fields) - allowed_fields
        if unknown:
            raise AgentCtlError(f"unsupported task fields: {', '.join(sorted(unknown))}")
        with self.transaction():
            assignments = ["updated_at = ?"]
            values: list[Any] = [utc_now()]
            for key, value in fields.items():
                assignments.append(f"{key} = ?")
                values.append(value)
            values.append(task_id)
            cursor = self.connection.execute(
                f"UPDATE tasks SET {', '.join(assignments)} WHERE id = ?", values
            )
            if cursor.rowcount != 1:
                raise AgentCtlError(f"unknown task: {task_id}")
            self.event(task_id=task_id, actor=actor, kind=kind, payload=fields)

    def fence_task(self, task_id: str, *, actor: str, reason: str) -> str:
        token = stable_token(task_id, "fence", str(epoch_now()))
        with self.transaction():
            cursor = self.connection.execute(
                "UPDATE tasks SET fencing_token = ?, updated_at = ? WHERE id = ?",
                (token, utc_now(), task_id),
            )
            if cursor.rowcount != 1:
                raise AgentCtlError(f"unknown task: {task_id}")
            self.event(
                task_id=task_id,
                actor=actor,
                kind="task.fenced",
                payload={"reason": reason, "fencingToken": token},
            )
        return token

    def note_failure(self, task_id: str, *, actor: str, reason: str) -> int:
        with self.transaction():
            cursor = self.connection.execute(
                """
                UPDATE tasks
                SET failure_count = failure_count + 1, updated_at = ?
                WHERE id = ?
                """,
                (utc_now(), task_id),
            )
            if cursor.rowcount != 1:
                raise AgentCtlError(f"unknown task: {task_id}")
            row = self.connection.execute(
                "SELECT failure_count FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
            count = int(row[0])
            self.event(
                task_id=task_id,
                actor=actor,
                kind="task.failure_recorded",
                payload={"reason": reason, "failureCount": count},
            )
        return count

    def begin_attempt(self, task_id: str, phase: str, *, log_path: Path, result_path: Path) -> str:
        with self.transaction():
            row = self.connection.execute(
                "SELECT attempt, version, status FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
            if row is None:
                raise AgentCtlError(f"unknown task: {task_id}")
            attempt = int(row["attempt"]) + 1
            token = stable_token(task_id, str(row["version"]), str(attempt), str(epoch_now()))
            self.connection.execute(
                "UPDATE tasks SET attempt = ?, fencing_token = ?, updated_at = ? WHERE id = ?",
                (attempt, token, utc_now(), task_id),
            )
            self.connection.execute(
                """
                INSERT INTO attempts(task_id, attempt, fencing_token, phase, started_at, log_path, result_path)
                VALUES(?,?,?,?,?,?,?)
                """,
                (task_id, attempt, token, phase, utc_now(), str(log_path), str(result_path)),
            )
            self.event(
                task_id=task_id,
                actor="supervisor",
                kind="attempt.started",
                payload={"attempt": attempt, "phase": phase, "fencingToken": token},
            )
        return token

    def finish_attempt(
        self,
        task_id: str,
        token: str,
        *,
        exit_code: int,
        thread_id: str | None,
        output_digest: str,
    ) -> bool:
        with self.transaction():
            current = self.connection.execute(
                "SELECT fencing_token FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
            if current is None or current[0] != token:
                self.event(
                    task_id=task_id,
                    actor="supervisor",
                    kind="attempt.stale_output",
                    payload={"fencingToken": token, "exitCode": exit_code},
                )
                return False
            self.connection.execute(
                """
                UPDATE attempts SET finished_at = ?, exit_code = ?, thread_id = ?, output_digest = ?
                WHERE fencing_token = ?
                """,
                (utc_now(), exit_code, thread_id, output_digest, token),
            )
            self.event(
                task_id=task_id,
                actor="supervisor",
                kind="attempt.finished",
                payload={"fencingToken": token, "exitCode": exit_code, "threadId": thread_id},
            )
        return True

    def record_verification(
        self,
        *,
        task_id: str,
        candidate_sha: str | None,
        phase: str,
        command: Sequence[str],
        cwd: Path,
        started_at: str,
        finished_at: str,
        exit_code: int | None,
        elapsed_seconds: float,
        output: str,
    ) -> None:
        with self.transaction():
            self.connection.execute(
                """
                INSERT INTO verification_runs(
                    task_id, candidate_sha, phase, command_json, cwd, started_at,
                    finished_at, exit_code, elapsed_seconds, output
                ) VALUES(?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    task_id,
                    candidate_sha,
                    phase,
                    json_dumps(list(command)),
                    str(cwd),
                    started_at,
                    finished_at,
                    exit_code,
                    elapsed_seconds,
                    output[-20000:],
                ),
            )
            self.event(
                task_id=task_id,
                actor="verifier",
                kind="verification.finished",
                payload={"phase": phase, "command": list(command), "exitCode": exit_code},
            )

    def set_rate_limit(self, pool: str, retry_at: float, reason: str) -> None:
        with self.transaction():
            self.connection.execute(
                """
                INSERT INTO rate_limit_pools(pool, retry_at, reason, updated_at) VALUES(?,?,?,?)
                ON CONFLICT(pool) DO UPDATE SET
                    retry_at = MAX(rate_limit_pools.retry_at, excluded.retry_at),
                    reason = excluded.reason,
                    updated_at = excluded.updated_at
                """,
                (pool, retry_at, reason, utc_now()),
            )

    def pool_retry_at(self, pool: str) -> float | None:
        row = self.connection.execute(
            "SELECT retry_at FROM rate_limit_pools WHERE pool = ?", (pool,)
        ).fetchone()
        return float(row[0]) if row else None

    def create_message(self, content: str) -> str:
        if not content.strip():
            raise AgentCtlError("message must not be empty")
        message_id = f"msg-{uuid.uuid4().hex[:12]}"
        now = utc_now()
        with self.transaction():
            self.connection.execute(
                "INSERT INTO messages(id, content, status, created_at, updated_at) VALUES(?,?,?,?,?)",
                (message_id, content.strip(), "pending", now, now),
            )
            self.event(
                message_id=message_id,
                actor="user",
                kind="message.created",
                payload={"content": content.strip()},
            )
        return message_id

    def list_messages(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.connection.execute("SELECT * FROM messages ORDER BY created_at")]

    def pending_message(self) -> dict[str, Any] | None:
        row = self.connection.execute(
            """
            SELECT * FROM messages
            WHERE status = 'pending' OR (status = 'retry_wait' AND next_wake_at <= ?)
            ORDER BY created_at LIMIT 1
            """,
            (epoch_now(),),
        ).fetchone()
        return dict(row) if row else None

    def update_message(self, message_id: str, *, status: str, actor: str, **fields: Any) -> None:
        allowed = {"reply", "thread_id", "next_wake_at", "last_error"}
        unknown = set(fields) - allowed
        if unknown:
            raise AgentCtlError(f"unsupported message fields: {', '.join(sorted(unknown))}")
        with self.transaction():
            assignments = ["status = ?", "updated_at = ?"]
            values: list[Any] = [status, utc_now()]
            for key, value in fields.items():
                assignments.append(f"{key} = ?")
                values.append(value)
            values.append(message_id)
            cursor = self.connection.execute(
                f"UPDATE messages SET {', '.join(assignments)} WHERE id = ?", values
            )
            if cursor.rowcount != 1:
                raise AgentCtlError(f"unknown message: {message_id}")
            self.event(
                message_id=message_id,
                actor=actor,
                kind="message.status",
                payload={"status": status, **fields},
            )

    def _decode_task(self, row: sqlite3.Row) -> dict[str, Any]:
        task = dict(row)
        for key in ("scope_json", "checks_json", "capabilities_json"):
            task[key.removesuffix("_json")] = json.loads(task.pop(key))
        return task
