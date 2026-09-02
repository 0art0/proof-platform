from __future__ import annotations

import os
import shlex
from pathlib import Path
from typing import Sequence

from .config import Config
from .state import State
from .util import AgentCtlError, run, utc_now


def parse_command(command: str) -> tuple[str, ...]:
    if not command.strip() or "\n" in command or "\0" in command:
        raise AgentCtlError(f"invalid verification command: {command!r}")
    try:
        argv = tuple(shlex.split(command, posix=True))
    except ValueError as exc:
        raise AgentCtlError(f"invalid verification command: {exc}") from exc
    if not argv:
        raise AgentCtlError("verification command is empty")
    return argv


def sanitized_environment(root: Path) -> dict[str, str]:
    keep = ("PATH", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR")
    environment = {key: os.environ[key] for key in keep if key in os.environ}
    environment.update(
        {
            "CI": "1",
            "NO_COLOR": "1",
            "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
            "PNPM_HOME": str(root / ".tools" / "pnpm-home"),
            "PNPM_STORE_DIR": str(root / ".pnpm-store"),
        }
    )
    return environment


def run_checks(
    *,
    config: Config,
    state: State,
    task_id: str,
    candidate_sha: str | None,
    phase: str,
    cwd: Path,
    commands: Sequence[str],
) -> None:
    for command in commands:
        argv = parse_command(command)
        started_at = utc_now()
        result = run(
            argv,
            cwd=cwd,
            timeout=config.verification_timeout,
            check=False,
            env=sanitized_environment(config.root),
        )
        finished_at = utc_now()
        output = (result.stdout + "\n" + result.stderr).strip()
        state.record_verification(
            task_id=task_id,
            candidate_sha=candidate_sha,
            phase=phase,
            command=argv,
            cwd=cwd,
            started_at=started_at,
            finished_at=finished_at,
            exit_code=result.returncode,
            elapsed_seconds=result.elapsed_seconds,
            output=output,
        )
        if result.returncode != 0:
            raise AgentCtlError(
                f"verification failed ({result.returncode}): {command}\n{output[-8000:]}"
            )

