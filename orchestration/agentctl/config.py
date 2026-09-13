from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .util import AgentCtlError


@dataclass(frozen=True)
class Config:
    root: Path
    raw: dict[str, Any]

    @classmethod
    def load(cls, root: Path) -> "Config":
        root = root.resolve()
        path = root / "orchestration" / "config.json"
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise AgentCtlError(f"missing orchestrator configuration: {path}") from exc
        except json.JSONDecodeError as exc:
            raise AgentCtlError(f"invalid orchestrator configuration: {exc}") from exc
        if raw.get("schemaVersion") != 1:
            raise AgentCtlError("unsupported orchestration/config.json schemaVersion")
        return cls(root=root, raw=raw)

    @property
    def base_branch(self) -> str:
        return str(self.raw["project"]["baseBranch"])

    @property
    def project_name(self) -> str:
        return str(self.raw["project"]["name"])

    @property
    def state_dir(self) -> Path:
        return self.root / str(self.raw["paths"]["stateDirectory"])

    @property
    def worktree_dir(self) -> Path:
        return self.root / str(self.raw["paths"]["worktreeDirectory"])

    @property
    def pnpm_store_dir(self) -> Path:
        return self.root / ".tools" / "pnpm-home" / "store"

    @property
    def database_path(self) -> Path:
        return self.state_dir / "state.sqlite3"

    @property
    def socket_path(self) -> Path:
        return self.state_dir / "tmux.sock"

    @property
    def max_parallel(self) -> int:
        return int(self.raw["runtime"]["maxParallel"])

    @property
    def poll_interval(self) -> float:
        return float(self.raw["runtime"]["pollIntervalSeconds"])

    @property
    def worker_timeout(self) -> float:
        return float(self.raw["runtime"]["workerTimeoutSeconds"])

    @property
    def verification_timeout(self) -> float:
        return float(self.raw["runtime"]["verificationTimeoutSeconds"])

    @property
    def rate_limit_fallback(self) -> float:
        return float(self.raw["runtime"]["rateLimitFallbackSeconds"])

    @property
    def max_task_attempts(self) -> int:
        return int(self.raw["runtime"]["maxTaskAttempts"])

    @property
    def tmux_prefix(self) -> str:
        return str(self.raw["runtime"]["tmuxSessionPrefix"])

    @property
    def protected_paths(self) -> tuple[str, ...]:
        return tuple(map(str, self.raw["scope"]["protectedPaths"]))

    @property
    def elevated_paths(self) -> tuple[str, ...]:
        return tuple(map(str, self.raw["scope"]["elevatedReviewPaths"]))

    @property
    def candidate_commands(self) -> tuple[str, ...]:
        return tuple(map(str, self.raw["verification"]["candidateCommands"]))

    @property
    def integration_commands(self) -> tuple[str, ...]:
        return tuple(map(str, self.raw["verification"]["integrationCommands"]))

    @property
    def codex_command(self) -> str:
        return str(self.raw["codex"]["command"])

    def codex_model(self, role: str) -> str | None:
        role_config = self.raw["codex"].get("roles", {}).get(role, {})
        value = role_config.get("model", self.raw["codex"].get("model"))
        return str(value) if value else None

    def codex_reasoning_effort(self, role: str) -> str | None:
        role_config = self.raw["codex"].get("roles", {}).get(role, {})
        value = role_config.get(
            "reasoningEffort", self.raw["codex"].get("reasoningEffort")
        )
        return str(value) if value else None

    @property
    def advisor_enabled(self) -> bool:
        return bool(self.raw["codex"].get("advisor", {}).get("enabled", False))

    @property
    def advisor_milestone_interval(self) -> int:
        value = int(self.raw["codex"].get("advisor", {}).get("milestoneInterval", 8))
        return max(1, value)

    @property
    def advisor_max_subagents(self) -> int:
        value = int(self.raw["codex"].get("advisor", {}).get("maxSubagents", 2))
        return max(0, min(3, value))

    @property
    def advisor_subagent_model(self) -> str:
        return str(
            self.raw["codex"].get("advisor", {}).get("subagentModel", "gpt-5.6-sol")
        )

    @property
    def advisor_subagent_reasoning_effort(self) -> str:
        return str(
            self.raw["codex"]
            .get("advisor", {})
            .get("subagentReasoningEffort", "xhigh")
        )

    @property
    def review_enabled(self) -> bool:
        return bool(self.raw["codex"]["reviewEnabled"])

    @property
    def require_human_approval(self) -> bool:
        return bool(self.raw["integration"]["requireHumanApproval"])

    def ensure_runtime_directories(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.worktree_dir.mkdir(parents=True, exist_ok=True)
        for name in ("logs", "contracts", "results", "backups", "tmp"):
            (self.state_dir / name).mkdir(parents=True, exist_ok=True, mode=0o700)
