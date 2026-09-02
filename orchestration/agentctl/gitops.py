from __future__ import annotations

import os
from pathlib import Path
from typing import Sequence

from .config import Config
from .scope import ScopeReport, changed_paths, validate_scope
from .util import AgentCtlError, Completed, run, safe_slug


def git_environment(root: Path) -> dict[str, str]:
    environment = os.environ.copy()
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        environment.pop(key, None)
    separate = root.resolve() / ".git-data"
    if not (separate / "HEAD").is_file():
        return environment
    environment["GIT_DIR"] = str(separate)
    environment["GIT_WORK_TREE"] = str(root.resolve())
    return environment


def root_git(root: Path, arguments: Sequence[str], *, check: bool = True) -> Completed:
    return run(["git", *arguments], cwd=root, check=check, env=git_environment(root))


def ensure_repository(root: Path) -> None:
    inside = root_git(root, ["rev-parse", "--is-inside-work-tree"], check=False)
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        raise AgentCtlError(
            "this checkout is not a valid Git repository; initialize a writable repository and "
            "create an initial commit before running autonomous workers"
        )
    head = root_git(root, ["rev-parse", "--verify", "HEAD"], check=False)
    if head.returncode != 0:
        raise AgentCtlError("Git repository has no initial commit; worktrees require one")


def resolve_ref(root: Path, ref: str) -> str:
    return root_git(root, ["rev-parse", "--verify", f"{ref}^{{commit}}"]).stdout.strip()


def current_branch(root: Path) -> str:
    return root_git(root, ["branch", "--show-current"]).stdout.strip()


def canonical_clean(root: Path) -> bool:
    output = root_git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout
    return not output.strip()


def prepare_worktree(config: Config, task: dict[str, object]) -> tuple[str, str, Path]:
    ensure_repository(config.root)
    task_id = str(task["id"])
    title = str(task["title"])
    base_sha = str(task.get("base_sha") or resolve_ref(config.root, config.base_branch))
    branch = str(task.get("branch") or f"agent/{task_id[:18]}-{safe_slug(title, limit=18)}")
    worktree = Path(str(task.get("worktree") or config.worktree_dir / task_id)).resolve()
    if worktree.exists():
        registered = run(
            ["git", "-C", str(worktree), "rev-parse", "--show-toplevel"],
            cwd=config.root,
            check=False,
        )
        if registered.returncode != 0 or Path(registered.stdout.strip()).resolve() != worktree:
            raise AgentCtlError(f"refusing to reuse non-worktree path: {worktree}")
        actual_branch = current_branch(worktree)
        if actual_branch != branch:
            raise AgentCtlError(
                f"worktree branch mismatch for {task_id}: expected {branch}, found {actual_branch}"
            )
        return base_sha, branch, worktree

    worktree.parent.mkdir(parents=True, exist_ok=True)
    branch_exists = root_git(
        config.root,
        ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"],
        check=False,
    ).returncode == 0
    command = ["worktree", "add"]
    if branch_exists:
        command.extend([str(worktree), branch])
    else:
        command.extend(["-b", branch, str(worktree), base_sha])
    root_git(config.root, command)
    return base_sha, branch, worktree


def commit_candidate(
    config: Config,
    task: dict[str, object],
    report: ScopeReport,
) -> str:
    worktree = Path(str(task["worktree"]))
    base_sha = str(task["base_sha"])
    dirty_paths = changed_paths(worktree, "HEAD")
    if not dirty_paths:
        raise AgentCtlError("worker produced no new changes in this implementation attempt")
    if not set(dirty_paths).issubset(set(report.changed_paths)):
        raise AgentCtlError("uncommitted paths are not present in the validated cumulative diff")
    run(["git", "add", "-A", "--", *dirty_paths], cwd=worktree)
    staged = run(["git", "diff", "--cached", "--name-only", "-z"], cwd=worktree).stdout
    staged_paths = tuple(path for path in staged.split("\0") if path)
    if set(staged_paths) != set(dirty_paths):
        raise AgentCtlError("staged candidate does not match the validated path set")
    message = (
        f"agent: {task['title']}\n\n"
        f"Agent-Task: {task['id']}\n"
        f"Base-SHA: {base_sha}\n"
        f"Scope-Fingerprint: {','.join(report.changed_paths)}"
    )
    run(
        [
            "git",
            "-c",
            "user.name=Proof Platform Orchestrator",
            "-c",
            "user.email=orchestrator@proof-platform.local",
            "commit",
            "-m",
            message,
        ],
        cwd=worktree,
    )
    candidate = resolve_ref(worktree, "HEAD")
    run(["git", "merge-base", "--is-ancestor", base_sha, candidate], cwd=worktree)
    if not canonical_clean(worktree):
        raise AgentCtlError("candidate worktree is not clean after trusted commit")
    return candidate


def validate_candidate(config: Config, task: dict[str, object]) -> ScopeReport:
    candidate = str(task.get("candidate_sha") or "")
    branch = str(task.get("branch") or "")
    worktree = Path(str(task["worktree"]))
    if not candidate or resolve_ref(config.root, branch) != candidate:
        raise AgentCtlError("candidate branch no longer points to the recorded candidate SHA")
    root_git(config.root, ["merge-base", "--is-ancestor", str(task["base_sha"]), candidate])
    return validate_scope(
        worktree=worktree,
        base_sha=str(task["base_sha"]),
        allowed=task["scope"],  # type: ignore[arg-type]
        protected=config.protected_paths,
        elevated=config.elevated_paths,
    )


def remove_worktree(root: Path, path: Path) -> None:
    root_git(root, ["worktree", "remove", "--force", str(path)])
