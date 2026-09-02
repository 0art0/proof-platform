from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from agentctl.state import State
from agentctl.util import AgentCtlError


class StateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = State(self.root / "state.sqlite3")
        self.state.migrate()

    def tearDown(self) -> None:
        self.state.close()
        self.temporary.cleanup()

    def create_task(self) -> str:
        return self.state.create_task(
            title="Implement a kernel operation",
            prompt="Implement it with tests",
            scopes=["packages/kernel/**"],
            checks=["python3 -V"],
            base_branch="main",
            max_attempts=3,
        )

    def test_migration_is_idempotent_and_database_is_integral(self) -> None:
        self.state.migrate()
        self.assertEqual(self.state.integrity_check(), "ok")
        migrations = self.state.connection.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]
        self.assertEqual(migrations, 2)

    def test_transition_and_event_are_atomic(self) -> None:
        task_id = self.create_task()
        self.state.transition(task_id, "preparing", actor="test", expected="queued")
        self.assertEqual(self.state.get_task(task_id)["status"], "preparing")
        events = self.state.events(task_id)
        self.assertEqual(events[-1]["payload"]["to"], "preparing")
        with self.assertRaises(AgentCtlError):
            self.state.transition(task_id, "integrated", actor="test")
        self.assertEqual(self.state.get_task(task_id)["status"], "preparing")

    def test_fencing_rejects_late_attempt_output(self) -> None:
        task_id = self.create_task()
        log = self.root / "log"
        result = self.root / "result"
        token = self.state.begin_attempt(task_id, "implement", log_path=log, result_path=result)
        self.state.fence_task(task_id, actor="test", reason="cancel")
        accepted = self.state.finish_attempt(
            task_id,
            token,
            exit_code=0,
            thread_id="thread",
            output_digest="digest",
        )
        self.assertFalse(accepted)
        attempt = self.state.connection.execute(
            "SELECT finished_at FROM attempts WHERE fencing_token = ?", (token,)
        ).fetchone()
        self.assertIsNone(attempt[0])

    def test_failure_budget_is_durable_and_separate_from_launch_attempts(self) -> None:
        task_id = self.create_task()
        self.state.begin_attempt(
            task_id,
            "implement",
            log_path=self.root / "log",
            result_path=self.root / "result",
        )
        self.assertEqual(self.state.get_task(task_id)["failure_count"], 0)
        self.assertEqual(
            self.state.note_failure(task_id, actor="test", reason="review requested changes"), 1
        )
        self.assertEqual(self.state.get_task(task_id)["failure_count"], 1)

    def test_backup_includes_committed_state(self) -> None:
        task_id = self.create_task()
        backup = self.root / "backup.sqlite3"
        self.state.backup(backup)
        copied = State(backup)
        try:
            self.assertEqual(copied.get_task(task_id)["title"], "Implement a kernel operation")
            self.assertEqual(copied.integrity_check(), "ok")
        finally:
            copied.close()

    def test_message_state_survives_reopen(self) -> None:
        message_id = self.state.create_message("Build the next slice")
        self.state.update_message(
            message_id,
            status="retry_wait",
            actor="test",
            thread_id="abc",
            next_wake_at=42.0,
        )
        self.state.close()
        self.state = State(self.root / "state.sqlite3")
        message = self.state.list_messages()[0]
        self.assertEqual(message["id"], message_id)
        self.assertEqual(message["thread_id"], "abc")
        self.assertEqual(message["next_wake_at"], 42.0)


if __name__ == "__main__":
    unittest.main()
