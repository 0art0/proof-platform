from __future__ import annotations

import fnmatch
import os
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable, Sequence

from .util import AgentCtlError, run


@dataclass(frozen=True)
class ScopeReport:
    changed_paths: tuple[str, ...]
    elevated_paths: tuple[str, ...]


def normalize_pattern(pattern: str) -> str:
    value = pattern.strip().replace("\\", "/")
    if not value or value.startswith("/") or "\0" in value:
        raise AgentCtlError(f"invalid write scope: {pattern!r}")
    parts = PurePosixPath(value).parts
    if any(part == ".." for part in parts):
        raise AgentCtlError(f"write scope escapes repository: {pattern!r}")
    return value.removeprefix("./")


def path_matches(path: str, pattern: str) -> bool:
    path = path.replace("\\", "/").removeprefix("./")
    pattern = normalize_pattern(pattern)
    if pattern.endswith("/**"):
        prefix = pattern[:-3].rstrip("/")
        return path == prefix or path.startswith(prefix + "/")
    return fnmatch.fnmatchcase(path, pattern)


def pattern_prefix(pattern: str) -> str:
    pattern = normalize_pattern(pattern)
    wildcard_positions = [position for char in "*[?" if (position := pattern.find(char)) >= 0]
    if wildcard_positions:
        pattern = pattern[: min(wildcard_positions)]
    return pattern.rstrip("/")


def scopes_overlap(left: Sequence[str], right: Sequence[str]) -> bool:
    for left_pattern in left:
        left_prefix = pattern_prefix(left_pattern)
        for right_pattern in right:
            right_prefix = pattern_prefix(right_pattern)
            if not left_prefix or not right_prefix:
                return True
            if (
                left_prefix == right_prefix
                or left_prefix.startswith(right_prefix + "/")
                or right_prefix.startswith(left_prefix + "/")
                or path_matches(left_prefix, right_pattern)
                or path_matches(right_prefix, left_pattern)
            ):
                return True
    return False


def changed_paths(worktree: Path, base_sha: str) -> tuple[str, ...]:
    tracked = run(
        ["git", "diff", "--name-only", "--no-renames", "-z", base_sha, "--"],
        cwd=worktree,
    ).stdout.split("\0")
    untracked = run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=worktree
    ).stdout.split("\0")
    paths = sorted({path for path in tracked + untracked if path})
    return tuple(paths)


def validate_scope(
    *,
    worktree: Path,
    base_sha: str,
    allowed: Sequence[str],
    protected: Sequence[str],
    elevated: Sequence[str],
) -> ScopeReport:
    allowed = tuple(normalize_pattern(pattern) for pattern in allowed)
    paths = changed_paths(worktree, base_sha)
    if not paths:
        raise AgentCtlError("worker produced no changes")

    run(["git", "merge-base", "--is-ancestor", base_sha, "HEAD"], cwd=worktree)
    diff_check = run(["git", "diff", "--check", base_sha, "--"], cwd=worktree, check=False)
    if diff_check.returncode != 0:
        raise AgentCtlError(f"git diff --check failed:\n{diff_check.stdout}{diff_check.stderr}")

    root = worktree.resolve()
    denied: list[str] = []
    outside: list[str] = []
    elevated_hits: list[str] = []
    for relative in paths:
        normalized = normalize_pattern(relative)
        if any(path_matches(normalized, pattern) for pattern in protected):
            denied.append(normalized)
        if not any(path_matches(normalized, pattern) for pattern in allowed):
            outside.append(normalized)
        candidate = worktree / normalized
        if candidate.is_symlink():
            resolved = candidate.resolve(strict=False)
            try:
                resolved.relative_to(root)
            except ValueError:
                denied.append(f"{normalized} (symlink escapes worktree)")
        if any(path_matches(normalized, pattern) for pattern in elevated):
            elevated_hits.append(normalized)

    submodules = run(["git", "ls-files", "-s", "--", *paths], cwd=worktree).stdout
    for line in submodules.splitlines():
        if line.startswith("160000 "):
            denied.append(f"{line.rsplit(chr(9), 1)[-1]} (submodule)")

    if denied or outside:
        details: list[str] = []
        if denied:
            details.append("protected or unsafe paths: " + ", ".join(sorted(set(denied))))
        if outside:
            details.append("outside task scope: " + ", ".join(sorted(set(outside))))
        raise AgentCtlError("scope validation failed; " + "; ".join(details))

    return ScopeReport(changed_paths=paths, elevated_paths=tuple(sorted(set(elevated_hits))))


def validate_proposed_scopes(scopes: Sequence[str], protected: Sequence[str]) -> tuple[str, ...]:
    normalized = tuple(normalize_pattern(pattern) for pattern in scopes)
    for pattern in normalized:
        prefix = pattern_prefix(pattern) or pattern
        for denied in protected:
            denied_prefix = pattern_prefix(denied) or denied
            if (
                path_matches(prefix, denied)
                or path_matches(denied_prefix, pattern)
                or prefix == denied_prefix
            ):
                raise AgentCtlError(f"proposed scope intersects protected path: {pattern} / {denied}")
    return normalized

