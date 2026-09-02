from __future__ import annotations

import os
from pathlib import Path
from typing import Sequence

from .config import Config
from .util import AgentCtlError, run


def _base(config: Config) -> list[str]:
    return ["tmux", "-S", str(config.socket_path)]


def has_session(config: Config, name: str) -> bool:
    result = run(_base(config) + ["has-session", "-t", name], cwd=config.root, check=False)
    return result.returncode == 0


def start_session(config: Config, name: str, argv: Sequence[str], *, cwd: Path) -> None:
    if has_session(config, name):
        raise AgentCtlError(f"tmux session already exists: {name}")
    config.socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    run(
        _base(config)
        + ["new-session", "-d", "-s", name, "-c", str(cwd), *list(argv)],
        cwd=config.root,
    )
    if config.socket_path.exists():
        os.chmod(config.socket_path, 0o600)


def stop_session(config: Config, name: str) -> None:
    run(_base(config) + ["kill-session", "-t", name], cwd=config.root, check=False)


def list_sessions(config: Config) -> tuple[str, ...]:
    result = run(
        _base(config) + ["list-sessions", "-F", "#{session_name}"],
        cwd=config.root,
        check=False,
    )
    if result.returncode != 0:
        return ()
    return tuple(line for line in result.stdout.splitlines() if line)


def attach(config: Config, name: str) -> int:
    os.execvp("tmux", _base(config) + ["attach-session", "-t", name])
    return 127

