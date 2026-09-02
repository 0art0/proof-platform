from __future__ import annotations

import fcntl
import os
import signal
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .config import Config
from .gitops import prepare_worktree
from .scope import scopes_overlap
from .state import State, TASK_TRANSITIONS
from .tmux import has_session, list_sessions, start_session
from .util import AgentCtlError, epoch_now


ACTIVE_STATUSES = frozenset({"preparing", "running", "verifying", "reviewing"})
SCHEDULABLE_STATUSES = frozenset({"queued", "rework", "retry_wait"})


@contextmanager
def daemon_lock(config: Config, *, blocking: bool = False) -> Iterator[None]:
    path = config.state_dir / "daemon.lock"
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        flags = fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB)
        try:
            fcntl.flock(descriptor, flags)
        except BlockingIOError as exc:
            raise AgentCtlError("another orchestrator daemon holds the scheduler lock") from exc
        os.ftruncate(descriptor, 0)
        os.write(descriptor, f"{os.getpid()}\n".encode())
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def _dependencies_ready(state: State, task: dict[str, Any]) -> tuple[bool, bool]:
    dependencies = state.dependencies(task["id"])
    if not dependencies:
        return True, False
    statuses = [state.get_task(dependency)["status"] for dependency in dependencies]
    blocked = any(status in {"failed", "cancelled", "blocked_dependency"} for status in statuses)
    return all(status == "integrated" for status in statuses), blocked


def reconcile(config: Config, state: State) -> None:
    sessions = set(list_sessions(config))
    for task in state.list_tasks():
        session = task.get("tmux_session")
        if task["status"] in ACTIVE_STATUSES and session and session not in sessions:
            state.transition(
                task["id"],
                "failed",
                actor="reconciler",
                payload={"reason": "recorded tmux session is absent"},
                fields={"last_error": "worker session disappeared before recording a terminal state"},
            )
        worktree = task.get("worktree")
        if worktree and task["status"] not in {"queued", "cancelled"} and not Path(worktree).exists():
            current = state.get_task(task["id"])
            if current["status"] not in {"integrated", "failed", "cancelled", "needs_resolution"}:
                if "failed" in TASK_TRANSITIONS[current["status"]]:
                    state.transition(
                        task["id"],
                        "failed",
                        actor="reconciler",
                        fields={"last_error": "recorded worktree is missing"},
                    )

    message_sessions = {name for name in sessions if "-orchestrator-" in name}
    for message in state.list_messages():
        if message["status"] == "running":
            expected = f"{config.tmux_prefix}-orchestrator-{message['id'][-6:]}"
            if expected not in message_sessions:
                state.update_message(
                    message["id"],
                    status="failed",
                    actor="reconciler",
                    last_error="orchestrator tmux session disappeared",
                )


def _launch_message(config: Config, state: State) -> bool:
    message = state.pending_message()
    if message is None:
        return False
    pool_retry = state.pool_retry_at("codex-default")
    if pool_retry and pool_retry > epoch_now():
        return False
    name = f"{config.tmux_prefix}-orchestrator-{message['id'][-6:]}"
    state.update_message(message["id"], status="running", actor="supervisor")
    try:
        start_session(
            config,
            name,
            [
                sys.executable,
                "-m",
                "agentctl.orchestrator_agent",
                "--root",
                str(config.root),
                "--message",
                message["id"],
            ],
            cwd=config.root,
        )
    except AgentCtlError as exc:
        state.update_message(
            message["id"], status="failed", actor="supervisor", last_error=str(exc)
        )
        return False
    return True


def _launch_tasks(config: Config, state: State) -> int:
    tasks = state.list_tasks()
    active = [task for task in tasks if task["status"] in ACTIVE_STATUSES]
    available = max(0, config.max_parallel - len(active))
    if available == 0:
        return 0
    pool_retry = state.pool_retry_at("codex-default")
    if pool_retry and pool_retry > epoch_now():
        return 0
    launched = 0
    candidates = sorted(
        (task for task in tasks if task["status"] in SCHEDULABLE_STATUSES),
        key=lambda task: (-int(task["priority"]), task["created_at"], task["id"]),
    )
    for task in candidates:
        if launched >= available:
            break
        if task["status"] == "rework" and int(task["failure_count"]) >= int(task["max_attempts"]):
            state.transition(
                task["id"],
                "failed",
                actor="scheduler",
                fields={"last_error": "automatic rework budget exhausted"},
                payload={
                    "failureCount": task["failure_count"],
                    "maxAttempts": task["max_attempts"],
                },
            )
            continue
        if task["status"] == "retry_wait" and float(task.get("next_wake_at") or 0) > epoch_now():
            continue
        ready, blocked = _dependencies_ready(state, task)
        if blocked and task["status"] == "queued":
            state.transition(
                task["id"],
                "blocked_dependency",
                actor="scheduler",
                payload={"dependencies": state.dependencies(task["id"])},
            )
            continue
        if not ready:
            continue
        if any(scopes_overlap(task["scope"], other["scope"]) for other in active):
            continue
        source_status = task["status"]
        phase = (
            "review"
            if source_status == "retry_wait"
            and task.get("candidate_sha")
            and str(task.get("last_error") or "").startswith("reviewer rate limited")
            else "implement"
        )
        try:
            base_sha, branch, worktree = prepare_worktree(config, task)
            session = f"{config.tmux_prefix}-worker-{task['id'][-8:]}"
            state.transition(
                task["id"],
                "preparing",
                actor="scheduler",
                expected=source_status,
                fields={
                    "base_sha": base_sha,
                    "branch": branch,
                    "worktree": str(worktree),
                    "tmux_session": session,
                    "next_wake_at": None,
                },
                payload={"phase": phase},
            )
            attempt_number = int(task["attempt"]) + 1
            log_path = config.state_dir / "logs" / f"{task['id']}-{attempt_number}-{phase}.jsonl"
            result_path = config.state_dir / "results" / f"{task['id']}-{attempt_number}-{phase}.json"
            token = state.begin_attempt(
                task["id"], phase, log_path=log_path, result_path=result_path
            )
            start_session(
                config,
                session,
                [
                    sys.executable,
                    "-m",
                    "agentctl.worker",
                    "--root",
                    str(config.root),
                    "--task",
                    task["id"],
                    "--token",
                    token,
                    "--phase",
                    phase,
                ],
                cwd=config.root,
            )
            launched_task = state.get_task(task["id"])
            active.append(launched_task)
            launched += 1
        except AgentCtlError as exc:
            current = state.get_task(task["id"])
            if current["status"] == "preparing":
                state.transition(
                    task["id"],
                    "failed",
                    actor="scheduler",
                    fields={"last_error": str(exc)},
                    payload={"error": str(exc)},
                )
    return launched


def run_once(config: Config, state: State) -> int:
    reconcile(config, state)
    launched_message = _launch_message(config, state)
    launched_tasks = _launch_tasks(config, state)
    return int(launched_message) + launched_tasks


def next_sleep(config: Config, state: State) -> float:
    now = epoch_now()
    deadlines = [
        float(task["next_wake_at"])
        for task in state.list_tasks()
        if task["status"] == "retry_wait" and task.get("next_wake_at")
    ]
    deadlines.extend(
        float(message["next_wake_at"])
        for message in state.list_messages()
        if message["status"] == "retry_wait" and message.get("next_wake_at")
    )
    pool = state.pool_retry_at("codex-default")
    if pool:
        deadlines.append(pool)
    until_deadline = min((deadline - now for deadline in deadlines if deadline > now), default=config.poll_interval)
    return max(0.1, min(config.poll_interval, until_deadline))


def daemon(config: Config, *, once: bool = False) -> int:
    config.ensure_runtime_directories()
    state = State(config.database_path)
    state.migrate()
    stopping = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        with daemon_lock(config):
            while not stopping:
                run_once(config, state)
                if once:
                    break
                time.sleep(next_sleep(config, state))
    finally:
        state.close()
    return 0
