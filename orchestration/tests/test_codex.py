from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agentctl.codex import run_codex

from helpers import config_for


class _CompletedProcess:
    pid = 1234
    returncode = 0

    def communicate(self, prompt: str, timeout: float) -> tuple[str, None]:
        return '{"type":"thread.started","thread_id":"new-thread"}\n', None


class CodexCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config = config_for(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_and_capture_command(
        self, role: str, resume_thread_id: str | None = None
    ) -> list[str]:
        with patch("agentctl.codex.subprocess.Popen", return_value=_CompletedProcess()) as popen:
            run_codex(
                config=self.config,
                role=role,
                cwd=self.root,
                prompt="do the task",
                schema=self.root / "schema.json",
                result_path=self.root / "result.json",
                log_path=self.root / "codex.log",
                sandbox="workspace-write",
                timeout=5,
                resume_thread_id=resume_thread_id,
            )
        return popen.call_args.args[0]

    def assert_model_configuration(
        self, command: list[str], model: str, reasoning_effort: str
    ) -> None:
        model_index = command.index("--model")
        config_index = command.index("--config")
        exec_index = command.index("exec")
        self.assertLess(model_index, exec_index)
        self.assertLess(config_index, exec_index)
        self.assertEqual(command[model_index + 1], model)
        self.assertEqual(
            command[config_index + 1],
            f'model_reasoning_effort="{reasoning_effort}"',
        )

    def test_orchestrator_uses_sol(self) -> None:
        command = self.run_and_capture_command("orchestrator")

        self.assert_model_configuration(command, "gpt-5.6-sol", "xhigh")
        self.assertEqual(command[command.index("exec") + 1], "--json")

    def test_advisor_uses_astra(self) -> None:
        command = self.run_and_capture_command("advisor")

        self.assert_model_configuration(command, "gpt-6-astra", "xhigh")

    def test_implementer_uses_delegated_model(self) -> None:
        command = self.run_and_capture_command("implementer")

        self.assert_model_configuration(command, "gpt-5.6-sol", "xhigh")

    def test_resumed_reviewer_uses_delegated_model(self) -> None:
        command = self.run_and_capture_command("reviewer", "existing-thread")

        self.assert_model_configuration(command, "gpt-5.6-sol", "xhigh")
        self.assertEqual(command[command.index("exec") + 1], "resume")
        self.assertEqual(command[-2:], ["existing-thread", "-"])

    def test_legacy_global_model_configuration_is_supported(self) -> None:
        self.config.raw["codex"].pop("roles")
        self.config.raw["codex"]["model"] = "legacy-model"
        self.config.raw["codex"]["reasoningEffort"] = "high"

        command = self.run_and_capture_command("implementer")

        self.assert_model_configuration(command, "legacy-model", "high")


class CodexOutputSchemaTests(unittest.TestCase):
    def test_orchestrator_nullable_consultation_uses_supported_any_of(self) -> None:
        schema_path = (
            Path(__file__).resolve().parents[1]
            / "schemas"
            / "orchestrator-result.schema.json"
        )
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        consultation = schema["properties"]["consultation"]

        self.assertNotIn("oneOf", consultation)
        self.assertEqual(
            [option["type"] for option in consultation["anyOf"]],
            ["null", "object"],
        )


if __name__ == "__main__":
    unittest.main()
