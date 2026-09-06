from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agentctl.codex import CodexOutcome
from agentctl.config import Config
from agentctl.orchestrator_agent import execute
from agentctl.scheduler import _queue_advisor_checkpoint
from agentctl.state import State

from helpers import config_for


def outcome(result: dict[str, object], thread_id: str) -> CodexOutcome:
    return CodexOutcome(
        returncode=0,
        thread_id=thread_id,
        result=result,
        output="ok",
        rate_limited=False,
        retry_at=None,
        elapsed_seconds=0.1,
    )


class AdvisorLoopTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        config = config_for(self.root)
        (self.root / "orchestration" / "prompts").mkdir(parents=True)
        (self.root / "orchestration" / "schemas").mkdir(parents=True)
        (self.root / "orchestration" / "config.json").write_text(
            json.dumps(config.raw), encoding="utf-8"
        )
        (self.root / "orchestration" / "prompts" / "orchestrator.md").write_text(
            "orchestrate", encoding="utf-8"
        )
        (self.root / "orchestration" / "prompts" / "advisor.md").write_text(
            "advise", encoding="utf-8"
        )
        (self.root / "platform-design-plan.md").write_text(
            "ORIGINAL_DESIGN_MARKER", encoding="utf-8"
        )
        (self.root / "platform-design-refinement.md").write_text(
            "REFINED_DESIGN_MARKER", encoding="utf-8"
        )
        config.ensure_runtime_directories()
        state = State(config.database_path)
        try:
            state.migrate()
            state.ensure_todo_root("test")
            self.message_id = state.create_message("Make the kernel mathematically sound")
            state.update_message(self.message_id, status="running", actor="supervisor")
        finally:
            state.close()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_astra_advice_is_returned_to_sol_before_tasks_are_created(self) -> None:
        provisional = {
            "reply": "I want a second opinion.",
            "needsUserInput": False,
            "consultation": {
                "kind": "technical",
                "reason": "The kernel invariant is a critical mathematical decision.",
                "questions": ["Does the proposed invariant cover every mutation path?"],
            },
            "tasks": [],
        }
        advisory = {
            "summary": "The invariant needs an explicit replay condition.",
            "findings": [],
            "gaps": ["Replay coverage"],
            "recommendations": ["Add an invariant test"],
        }
        final = {
            "reply": "I incorporated the missing replay condition.",
            "needsUserInput": False,
            "consultation": None,
            "tasks": [
                {
                    "key": "kernel-invariant",
                    "title": "Strengthen the kernel invariant",
                    "objective": "Cover replay in every proof-state mutation.",
                    "nonGoals": [],
                    "todoPath": ["Kernel", "Mutation invariant"],
                    "writeScopes": ["src/**"],
                    "checks": ["python3 -m unittest"],
                    "dependsOn": [],
                }
            ],
        }

        with patch(
            "agentctl.orchestrator_agent.run_codex",
            side_effect=[
                outcome(provisional, "sol-thread"),
                outcome(advisory, "astra-thread"),
                outcome(final, "sol-thread"),
            ],
        ) as run:
            returncode = execute(self.root, self.message_id)

        self.assertEqual(returncode, 0)
        self.assertEqual(
            [call.kwargs["role"] for call in run.call_args_list],
            ["orchestrator", "advisor", "orchestrator"],
        )
        initial_prompt = run.call_args_list[0].kwargs["prompt"]
        self.assertIn("ORIGINAL_DESIGN_MARKER", initial_prompt)
        self.assertIn("REFINED_DESIGN_MARKER", initial_prompt)
        self.assertEqual(run.call_args_list[2].kwargs["resume_thread_id"], "sol-thread")
        self.assertIn("gpt-5.6-sol", run.call_args_list[1].kwargs["prompt"])
        self.assertIn("Subagent limit: 2", run.call_args_list[1].kwargs["prompt"])

        state = State(self.root / ".agent-state" / "state.sqlite3")
        try:
            message = state.list_messages()[0]
            self.assertEqual(message["status"], "completed")
            self.assertIn("Created tasks:", message["reply"])
            self.assertEqual(len(state.list_tasks()), 1)
            self.assertIsNotNone(state.latest_event("advisor.technical.completed"))
        finally:
            state.close()

    def test_idle_scheduler_queues_one_spaced_progress_review(self) -> None:
        config = Config.load(self.root)
        state = State(config.database_path)
        try:
            state.update_message(self.message_id, status="completed", actor="test")
            def add_integrated_task(index: int) -> None:
                task_id = state.create_task(
                    title=f"Integrated task {index}",
                    prompt="Completed work",
                    scopes=[f"src/{index}/**"],
                    checks=["python3 -V"],
                    base_branch="main",
                    max_attempts=3,
                )
                state.connection.execute(
                    "UPDATE tasks SET status = 'integrated' WHERE id = ?", (task_id,)
                )

            for index in range(config.advisor_milestone_interval):
                add_integrated_task(index)

            message_id = _queue_advisor_checkpoint(config, state)

            self.assertIsNotNone(message_id)
            self.assertIsNone(_queue_advisor_checkpoint(config, state))
            checkpoint = state.latest_event("advisor.progress_review.requested")
            self.assertEqual(
                checkpoint["payload"]["integratedTaskCount"],
                config.advisor_milestone_interval,
            )
            self.assertEqual(
                [message["status"] for message in state.list_messages()],
                ["completed", "pending"],
            )
            state.update_message(message_id, status="completed", actor="test")
            for index in range(
                config.advisor_milestone_interval,
                config.advisor_milestone_interval * 2 - 1,
            ):
                add_integrated_task(index)
            self.assertIsNone(_queue_advisor_checkpoint(config, state))
            add_integrated_task(config.advisor_milestone_interval * 2 - 1)
            self.assertIsNotNone(_queue_advisor_checkpoint(config, state))
        finally:
            state.close()


if __name__ == "__main__":
    unittest.main()
