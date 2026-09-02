from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from agentctl.config import Config


def config_for(root: Path, *, review_enabled: bool = False) -> Config:
    raw = {
        "schemaVersion": 1,
        "project": {"name": "test", "baseBranch": "main"},
        "runtime": {
            "maxParallel": 2,
            "pollIntervalSeconds": 0.1,
            "workerTimeoutSeconds": 5,
            "verificationTimeoutSeconds": 5,
            "rateLimitFallbackSeconds": 60,
            "maxTaskAttempts": 3,
            "tmuxSessionPrefix": "test-agentctl",
        },
        "codex": {
            "command": "codex",
            "model": None,
            "implementerSandbox": "workspace-write",
            "reviewerSandbox": "read-only",
            "approvalPolicy": "never",
            "reviewEnabled": review_enabled,
        },
        "paths": {"stateDirectory": ".agent-state", "worktreeDirectory": ".worktrees"},
        "scope": {
            "protectedPaths": [
                ".git/**",
                ".agent-state/**",
                ".worktrees/**",
                "AGENTS.md",
                "orchestration/**",
            ],
            "elevatedReviewPaths": ["package.json", "**/package.json"],
        },
        "verification": {"candidateCommands": [], "integrationCommands": []},
        "integration": {
            "requireHumanApproval": True,
            "requireCleanCanonicalWorktree": True,
            "retainCompletedWorktrees": True,
            "push": False,
        },
    }
    return Config(root=root.resolve(), raw=raw)


def git(root: Path, *arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        environment.pop(key, None)
    return subprocess.run(
        ["git", *arguments],
        cwd=root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
        check=check,
    )


def initialize_repository(root: Path) -> str:
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init", "--initial-branch=main")
    git(root, "config", "user.name", "Agentctl Test")
    git(root, "config", "user.email", "agentctl-test@example.invalid")
    (root / ".gitignore").write_text(".agent-state/\n.worktrees/\n", encoding="utf-8")
    (root / "README.md").write_text("base\n", encoding="utf-8")
    git(root, "add", ".gitignore", "README.md")
    git(root, "commit", "-m", "initial")
    return git(root, "rev-parse", "HEAD").stdout.strip()


def initialize_separate_repository(root: Path) -> str:
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init", "--bare", "--initial-branch=main", ".git-data")
    git_dir = root / ".git-data"
    common = (f"--git-dir={git_dir}", f"--work-tree={root}")
    git(root, f"--git-dir={git_dir}", "config", "core.bare", "false")
    git(root, f"--git-dir={git_dir}", "config", "core.worktree", "..")
    (root / ".gitignore").write_text(
        ".agent-state/\n.worktrees/\n.git-data/\n", encoding="utf-8"
    )
    (root / "README.md").write_text("base\n", encoding="utf-8")
    git(root, *common, "add", ".gitignore", "README.md")
    git(
        root,
        *common,
        "-c",
        "user.name=Agentctl Test",
        "-c",
        "user.email=agentctl-test@example.invalid",
        "commit",
        "-m",
        "initial",
    )
    return git(root, *common, "rev-parse", "HEAD").stdout.strip()
