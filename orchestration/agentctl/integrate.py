from __future__ import annotations

import fcntl
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import Config
from .gitops import (
    canonical_clean,
    current_branch,
    ensure_repository,
    resolve_ref,
    root_git,
    validate_candidate,
)
from .state import State
from .util import AgentCtlError, run
from .verify import run_checks


@contextmanager
def integration_lock(config: Config) -> Iterator[None]:
    path = config.state_dir / "integration.lock"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def integrate_task(config: Config, state: State, task_id: str) -> str:
    ensure_repository(config.root)
    with integration_lock(config):
        task = state.get_task(task_id)
        if task["status"] != "ready_to_integrate":
            raise AgentCtlError(
                f"task must be ready_to_integrate, found {task['status']}; approve it first if required"
            )
        validate_candidate(config, task)
        if current_branch(config.root) != config.base_branch:
            raise AgentCtlError(
                f"canonical checkout must be on {config.base_branch}, found {current_branch(config.root)}"
            )
        if config.raw["integration"]["requireCleanCanonicalWorktree"] and not canonical_clean(config.root):
            raise AgentCtlError("canonical worktree is dirty; preserve or commit user changes first")
        expected_head = resolve_ref(config.root, config.base_branch)
        candidate = str(task["candidate_sha"])
        base_sha = str(task["base_sha"])
        integration_branch = f"integration/{task_id}-{candidate[:8]}"
        staging = (config.worktree_dir / f"integration-{task_id}-{candidate[:8]}").resolve()
        if staging.exists():
            raise AgentCtlError(f"integration staging path already exists: {staging}")
        state.transition(task_id, "integrating", actor="integrator", expected="ready_to_integrate")
        try:
            root_git(
                config.root,
                ["worktree", "add", "-b", integration_branch, str(staging), expected_head],
            )
            commits = root_git(
                config.root, ["rev-list", "--reverse", f"{base_sha}..{candidate}"]
            ).stdout.split()
            if not commits:
                raise AgentCtlError("candidate contains no commits beyond its recorded base")
            cherry_pick = run(["git", "cherry-pick", *commits], cwd=staging, check=False)
            if cherry_pick.returncode != 0:
                raise AgentCtlError(
                    "candidate conflicts with the current base; staging worktree was preserved at "
                    f"{staging}\n{(cherry_pick.stdout + cherry_pick.stderr)[-8000:]}"
                )
            prospective = resolve_ref(staging, "HEAD")
            run_checks(
                config=config,
                state=state,
                task_id=task_id,
                candidate_sha=prospective,
                phase="integration",
                cwd=staging,
                commands=config.integration_commands,
            )
            if not canonical_clean(config.root):
                raise AgentCtlError("canonical worktree changed during integration verification")
            if resolve_ref(config.root, config.base_branch) != expected_head:
                raise AgentCtlError("canonical branch advanced during integration; restage and reverify")
            root_git(config.root, ["merge", "--ff-only", integration_branch])
            integrated = resolve_ref(config.root, "HEAD")
            if integrated != prospective:
                raise AgentCtlError("canonical branch did not reach the verified prospective SHA")
            state.transition(
                task_id,
                "integrated",
                actor="integrator",
                expected="integrating",
                fields={"integrated_sha": integrated, "last_error": None},
                payload={"oldHead": expected_head, "integratedSha": integrated},
            )
            return integrated
        except AgentCtlError as exc:
            current = state.get_task(task_id)
            if current["status"] == "integrating":
                state.transition(
                    task_id,
                    "needs_resolution",
                    actor="integrator",
                    fields={"last_error": str(exc)},
                    payload={"error": str(exc), "staging": str(staging)},
                )
            raise
