from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import Config
from .util import atomic_write, json_dumps


def task_contract(config: Config, task: dict[str, Any], feedback: str | None = None) -> str:
    contract = {
        "taskId": task["id"],
        "taskVersion": task["version"],
        "objective": task["prompt"],
        "baseBranch": task["base_branch"],
        "baseSha": task["base_sha"],
        "branch": task["branch"],
        "worktree": task["worktree"],
        "writeScopes": task["scope"],
        "capabilities": task["capabilities"],
        "requiredChecks": [*config.candidate_commands, *task["checks"]],
        "feedbackFromPriorAttempt": feedback,
        "reporting": "Return only JSON conforming to worker-result.schema.json",
    }
    path = config.state_dir / "contracts" / f"{task['id']}-v{task['version']}.json"
    atomic_write(path, json_dumps(contract) + "\n")
    return json_dumps(contract)


def implementer_prompt(config: Config, task: dict[str, Any]) -> str:
    prefix = (config.root / "orchestration" / "prompts" / "implementer.md").read_text(
        encoding="utf-8"
    )
    return f"{prefix}\n\n## Immutable task contract\n\n{task_contract(config, task, task.get('last_error'))}\n"


def reviewer_prompt(config: Config, task: dict[str, Any]) -> str:
    prefix = (config.root / "orchestration" / "prompts" / "reviewer.md").read_text(
        encoding="utf-8"
    )
    contract = {
        "taskId": task["id"],
        "objective": task["prompt"],
        "baseSha": task["base_sha"],
        "candidateSha": task["candidate_sha"],
        "writeScopes": task["scope"],
        "checks": [*config.candidate_commands, *task["checks"]],
        "instructions": "Inspect the repository diff from baseSha to candidateSha using read-only commands.",
    }
    return f"{prefix}\n\n## Review contract\n\n{json_dumps(contract)}\n"

