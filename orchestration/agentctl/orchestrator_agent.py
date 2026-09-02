from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .codex import run_codex, validate_result_shape
from .config import Config
from .scope import validate_proposed_scopes
from .state import State
from .util import AgentCtlError, epoch_now, json_dumps
from .verify import parse_command


def _task_snapshot(state: State) -> list[dict[str, Any]]:
    return [
        {
            "id": task["id"],
            "title": task["title"],
            "status": task["status"],
            "scopes": task["scope"],
            "dependencies": state.dependencies(task["id"]),
            "summary": task["result_summary"],
            "error": task["last_error"],
        }
        for task in state.list_tasks()
    ]


def _topological_tasks(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    keys = {str(task["key"]) for task in tasks}
    if len(keys) != len(tasks):
        raise AgentCtlError("orchestrator proposed duplicate task keys")
    remaining = {str(task["key"]): task for task in tasks}
    ordered: list[dict[str, Any]] = []
    completed: set[str] = set()
    while remaining:
        ready = [
            task
            for task in remaining.values()
            if set(map(str, task["dependsOn"])).issubset(completed)
        ]
        if not ready:
            dangling = {
                dependency
                for task in remaining.values()
                for dependency in map(str, task["dependsOn"])
                if dependency not in keys
            }
            if dangling:
                raise AgentCtlError(
                    "orchestrator proposed unknown task dependencies: " + ", ".join(sorted(dangling))
                )
            raise AgentCtlError("orchestrator proposed a cyclic task dependency graph")
        for task in sorted(ready, key=lambda item: str(item["key"])):
            key = str(task["key"])
            ordered.append(task)
            completed.add(key)
            del remaining[key]
    return ordered


def _validate_proposal(config: Config, result: dict[str, Any]) -> list[dict[str, Any]]:
    tasks = result.get("tasks")
    if not isinstance(tasks, list) or len(tasks) > 12:
        raise AgentCtlError("orchestrator result contains an invalid task list")
    for task in tasks:
        if not isinstance(task, dict):
            raise AgentCtlError("orchestrator task must be an object")
        scopes = task.get("writeScopes")
        checks = task.get("checks")
        if not isinstance(scopes, list) or not scopes:
            raise AgentCtlError(f"task {task.get('key')} has no write scope")
        if not isinstance(checks, list) or not checks:
            raise AgentCtlError(f"task {task.get('key')} has no verification commands")
        task["writeScopes"] = list(validate_proposed_scopes(scopes, config.protected_paths))
        for command in checks:
            parse_command(str(command))
    return _topological_tasks(tasks)


def execute(root: Path, message_id: str) -> int:
    config = Config.load(root)
    state = State(config.database_path)
    try:
        state.migrate()
        messages = {message["id"]: message for message in state.list_messages()}
        message = messages.get(message_id)
        if message is None:
            raise AgentCtlError(f"unknown message: {message_id}")
        if message["status"] != "running":
            raise AgentCtlError(f"message {message_id} is not leased for processing")
        prompt_template = (config.root / "orchestration" / "prompts" / "orchestrator.md").read_text(
            encoding="utf-8"
        )
        prompt = (
            f"{prompt_template}\n\n## User request\n\n{message['content']}\n\n"
            f"## Durable task snapshot\n\n{json_dumps(_task_snapshot(state))}\n"
        )
        log_path = config.state_dir / "logs" / f"{message_id}-orchestrator.jsonl"
        result_path = config.state_dir / "results" / f"{message_id}-orchestrator.json"
        outcome = run_codex(
            config=config,
            cwd=config.root,
            prompt=prompt,
            schema=config.root / "orchestration" / "schemas" / "orchestrator-result.schema.json",
            result_path=result_path,
            log_path=log_path,
            sandbox="read-only",
            timeout=config.worker_timeout,
            resume_thread_id=str(message.get("thread_id") or "") or None,
        )
        if outcome.rate_limited:
            retry_at = outcome.retry_at or epoch_now() + config.rate_limit_fallback
            state.set_rate_limit("codex-default", retry_at, outcome.output[-2000:])
            state.update_message(
                message_id,
                status="retry_wait",
                actor="orchestrator",
                thread_id=outcome.thread_id,
                next_wake_at=retry_at,
                last_error=f"rate limited; retry at {retry_at}",
            )
            return 0
        if outcome.returncode != 0:
            state.update_message(
                message_id,
                status="failed",
                actor="orchestrator",
                thread_id=outcome.thread_id,
                last_error=outcome.output[-8000:],
            )
            return 1
        result = validate_result_shape(outcome.result, ("reply", "needsUserInput", "tasks"))
        proposed = _validate_proposal(config, result)
        key_to_id: dict[str, str] = {}
        created: list[str] = []
        for proposal in proposed:
            dependencies = [key_to_id[str(key)] for key in proposal["dependsOn"]]
            non_goals = "\n".join(f"- {item}" for item in proposal["nonGoals"])
            objective = str(proposal["objective"])
            if non_goals:
                objective += f"\n\nNon-goals:\n{non_goals}"
            task_id = state.create_task(
                title=str(proposal["title"]),
                prompt=objective,
                scopes=list(map(str, proposal["writeScopes"])),
                checks=list(map(str, proposal["checks"])),
                base_branch=config.base_branch,
                max_attempts=config.max_task_attempts,
                dependencies=dependencies,
            )
            key_to_id[str(proposal["key"])] = task_id
            created.append(task_id)
        reply = str(result["reply"])
        if created:
            reply += "\n\nCreated tasks: " + ", ".join(created)
        state.update_message(
            message_id,
            status="needs_input" if result["needsUserInput"] else "completed",
            actor="orchestrator",
            reply=reply,
            thread_id=outcome.thread_id,
            next_wake_at=None,
            last_error=None,
        )
        return 0
    except AgentCtlError as exc:
        try:
            state.update_message(
                message_id,
                status="failed",
                actor="supervisor",
                last_error=str(exc),
            )
        except AgentCtlError:
            pass
        print(f"agentctl orchestrator: {exc}", file=sys.stderr)
        return 1
    finally:
        state.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--message", required=True)
    arguments = parser.parse_args(argv)
    return execute(arguments.root.resolve(), arguments.message)


if __name__ == "__main__":
    raise SystemExit(main())

