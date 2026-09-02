from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from agentctl.gitops import commit_candidate, prepare_worktree
from agentctl.integrate import integrate_task
from agentctl.scope import validate_scope
from agentctl.state import State

from helpers import config_for, initialize_repository


class IntegrationTests(unittest.TestCase):
    def test_verified_candidate_is_staged_then_fast_forwarded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = initialize_repository(root)
            config = config_for(root)
            config.ensure_runtime_directories()
            state = State(config.database_path)
            state.migrate()
            try:
                task_id = state.create_task(
                    title="Add kernel primitive",
                    prompt="Add a primitive",
                    scopes=["packages/kernel/**"],
                    checks=["python3 -c 'print(1)'"],
                    base_branch="main",
                    max_attempts=3,
                )
                task = state.get_task(task_id)
                base_sha, branch, worktree = prepare_worktree(config, task)
                state.transition(
                    task_id,
                    "preparing",
                    actor="test",
                    fields={"base_sha": base_sha, "branch": branch, "worktree": str(worktree)},
                )
                state.transition(task_id, "running", actor="test")
                source = worktree / "packages" / "kernel" / "primitive.ts"
                source.parent.mkdir(parents=True)
                source.write_text("export const primitive = true;\n", encoding="utf-8")
                report = validate_scope(
                    worktree=worktree,
                    base_sha=base_sha,
                    allowed=["packages/kernel/**"],
                    protected=config.protected_paths,
                    elevated=config.elevated_paths,
                )
                state.transition(task_id, "verifying", actor="test")
                candidate = commit_candidate(config, state.get_task(task_id), report)
                state.transition(
                    task_id,
                    "reviewing",
                    actor="test",
                    fields={"candidate_sha": candidate},
                )
                state.transition(task_id, "awaiting_approval", actor="test")
                state.transition(task_id, "ready_to_integrate", actor="user")
                integrated = integrate_task(config, state, task_id)
                self.assertEqual(state.get_task(task_id)["status"], "integrated")
                self.assertEqual(integrated, state.get_task(task_id)["integrated_sha"])
                self.assertEqual(
                    (root / "packages" / "kernel" / "primitive.ts").read_text(encoding="utf-8"),
                    "export const primitive = true;\n",
                )
                self.assertNotEqual(base, integrated)
            finally:
                state.close()


if __name__ == "__main__":
    unittest.main()

