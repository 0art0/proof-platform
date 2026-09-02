from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import subprocess
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

from .config import Config
from .util import AgentCtlError, atomic_write, epoch_now


RATE_LIMIT_PATTERN = re.compile(
    r"(?:rate[ -]?limit|usage limit|too many requests|quota(?: has been)? exceeded|http\s*429)",
    re.IGNORECASE,
)
RELATIVE_RETRY_PATTERN = re.compile(
    r"(?:try again in|retry(?:[- ]after| after)?[: ]+)\s*(\d+(?:\.\d+)?)\s*"
    r"(seconds?|secs?|minutes?|mins?|hours?|hrs?)",
    re.IGNORECASE,
)
ISO_RETRY_PATTERN = re.compile(r"20\d\d-\d\d-\d\d[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)")


@dataclass(frozen=True)
class CodexOutcome:
    returncode: int
    thread_id: str | None
    result: dict[str, Any] | None
    output: str
    rate_limited: bool
    retry_at: float | None
    elapsed_seconds: float

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.output.encode("utf-8", errors="replace")).hexdigest()


def _thread_id_from_jsonl(output: str) -> str | None:
    for line in output.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            if value.get("type") == "thread.started" and isinstance(value.get("thread_id"), str):
                return value["thread_id"]
            for key in ("thread_id", "threadId", "session_id", "sessionId"):
                if isinstance(value.get(key), str) and value[key]:
                    return value[key]
    return None


def classify_rate_limit(output: str, fallback_seconds: float) -> tuple[bool, float | None]:
    if not RATE_LIMIT_PATTERN.search(output):
        return False, None
    now = datetime.now(UTC)
    relative = RELATIVE_RETRY_PATTERN.search(output)
    if relative:
        amount = float(relative.group(1))
        unit = relative.group(2).casefold()
        if unit.startswith(("min",)):
            amount *= 60
        elif unit.startswith(("hour", "hr")):
            amount *= 3600
        return True, (now + timedelta(seconds=max(1, amount))).timestamp()
    iso = ISO_RETRY_PATTERN.search(output)
    if iso:
        try:
            parsed = datetime.fromisoformat(iso.group(0).replace("Z", "+00:00"))
            return True, max(epoch_now() + 1, parsed.timestamp())
        except ValueError:
            pass
    retry_after = re.search(r"retry-after\s*[:=]\s*([^\r\n,;]+)", output, re.IGNORECASE)
    if retry_after:
        raw = retry_after.group(1).strip()
        try:
            return True, epoch_now() + max(1, float(raw))
        except ValueError:
            try:
                parsed = parsedate_to_datetime(raw)
                return True, max(epoch_now() + 1, parsed.timestamp())
            except (TypeError, ValueError, OverflowError):
                pass
    return True, epoch_now() + fallback_seconds


def _sanitized_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for key in (
        "TMUX",
        "TMUX_PANE",
        "AGENTCTL_FENCING_TOKEN",
        "AGENTCTL_STATE_DATABASE",
        "GIT_DIR",
        "GIT_WORK_TREE",
    ):
        environment.pop(key, None)
    environment["NO_COLOR"] = "1"
    return environment


def run_codex(
    *,
    config: Config,
    cwd: Path,
    prompt: str,
    schema: Path,
    result_path: Path,
    log_path: Path,
    sandbox: str,
    timeout: float,
    resume_thread_id: str | None = None,
) -> CodexOutcome:
    result_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    result_path.unlink(missing_ok=True)
    command = [
        config.codex_command,
        "--sandbox",
        sandbox,
        "--ask-for-approval",
        str(config.raw["codex"]["approvalPolicy"]),
    ]
    if config.codex_model:
        command.extend(["--model", config.codex_model])
    if resume_thread_id:
        command.extend(
            [
                "exec",
                "resume",
                "--json",
                "--output-schema",
                str(schema),
                "--output-last-message",
                str(result_path),
                "--skip-git-repo-check",
                resume_thread_id,
                "-",
            ]
        )
    else:
        command.extend(
            [
                "exec",
                "--json",
                "--color",
                "never",
                "--output-schema",
                str(schema),
                "--output-last-message",
                str(result_path),
                "--skip-git-repo-check",
                "--cd",
                str(cwd),
                "-",
            ]
        )

    started = time.monotonic()
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=_sanitized_environment(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, _ = process.communicate(prompt, timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, _ = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, _ = process.communicate()
        stdout += f"\nagentctl: Codex process timed out after {timeout}s\n"
        returncode = 124
    else:
        returncode = process.returncode
    elapsed = time.monotonic() - started
    atomic_write(log_path, stdout, mode=0o600)

    result: dict[str, Any] | None = None
    if result_path.exists():
        try:
            decoded = json.loads(result_path.read_text(encoding="utf-8"))
            if isinstance(decoded, dict):
                result = decoded
        except (OSError, json.JSONDecodeError):
            result = None
    thread_id = _thread_id_from_jsonl(stdout) or resume_thread_id
    rate_limited, retry_at = (
        classify_rate_limit(stdout, config.rate_limit_fallback)
        if returncode != 0
        else (False, None)
    )
    return CodexOutcome(
        returncode=returncode,
        thread_id=thread_id,
        result=result,
        output=stdout,
        rate_limited=rate_limited,
        retry_at=retry_at,
        elapsed_seconds=elapsed,
    )


def validate_result_shape(result: dict[str, Any] | None, required: tuple[str, ...]) -> dict[str, Any]:
    if result is None:
        raise AgentCtlError("Codex did not produce a JSON result")
    missing = [key for key in required if key not in result]
    if missing:
        raise AgentCtlError(f"Codex result is missing fields: {', '.join(missing)}")
    return result
