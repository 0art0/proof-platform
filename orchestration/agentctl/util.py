from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Sequence


class AgentCtlError(RuntimeError):
    """An expected operational failure suitable for display to the user."""


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def epoch_now() -> float:
    return time.time()


def json_dumps(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def stable_token(*parts: str, length: int = 20) -> str:
    digest = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()
    return digest[:length]


def safe_slug(value: str, *, limit: int = 36) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return (slug or "task")[:limit].rstrip("-")


def require_command(name: str) -> str:
    resolved = shutil.which(name)
    if resolved is None:
        raise AgentCtlError(f"required command is not installed: {name}")
    return resolved


@dataclass(frozen=True)
class Completed:
    argv: tuple[str, ...]
    cwd: Path
    returncode: int
    stdout: str
    stderr: str
    elapsed_seconds: float


def run(
    argv: Sequence[str],
    *,
    cwd: Path,
    timeout: float | None = None,
    check: bool = True,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
) -> Completed:
    if not argv or any("\0" in part for part in argv):
        raise AgentCtlError("invalid command arguments")
    started = time.monotonic()
    try:
        result = subprocess.run(
            list(argv),
            cwd=cwd,
            env=env,
            input=input_text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            start_new_session=True,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise AgentCtlError(f"command timed out after {timeout}s: {argv[0]}") from exc
    except OSError as exc:
        raise AgentCtlError(f"could not execute {argv[0]}: {exc}") from exc
    completed = Completed(
        argv=tuple(argv),
        cwd=cwd,
        returncode=result.returncode,
        stdout=result.stdout,
        stderr=result.stderr,
        elapsed_seconds=time.monotonic() - started,
    )
    if check and completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()[-4000:]
        raise AgentCtlError(
            f"command failed ({completed.returncode}): {' '.join(argv)}"
            + (f"\n{detail}" if detail else "")
        )
    return completed


def atomic_write(path: Path, content: str, *, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(content, encoding="utf-8")
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def compact_lines(values: Iterable[str], *, limit: int = 80) -> str:
    lines = list(values)
    visible = lines[:limit]
    if len(lines) > limit:
        visible.append(f"... {len(lines) - limit} more")
    return "\n".join(visible)

