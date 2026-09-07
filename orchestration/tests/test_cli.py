from __future__ import annotations

import io
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import call, patch

from agentctl.cli import build_parser, command_start, main


class CliHelpTests(unittest.TestCase):
    def test_no_command_prints_idiots_guide(self) -> None:
        output = io.StringIO()

        with redirect_stdout(output):
            returncode = main([])

        self.assertEqual(returncode, 0)
        self.assertIn("Idiot's guide:", output.getvalue())
        self.assertIn('./scripts/agentctl ask "Describe the change you want"', output.getvalue())
        self.assertNotIn("==SUPPRESS==", output.getvalue())

    def test_start_accepts_web_option(self) -> None:
        arguments = build_parser().parse_args(["start", "--web"])

        self.assertTrue(arguments.web)

    def test_stop_accepts_web_option(self) -> None:
        arguments = build_parser().parse_args(["stop", "--web"])

        self.assertTrue(arguments.web)

    @patch("agentctl.cli.ensure_repository")
    @patch("agentctl.cli._state")
    @patch("agentctl.cli.has_session", return_value=False)
    @patch("agentctl.cli.start_session")
    def test_start_web_launches_supervisor_and_dashboard(
        self, start_session, _has_session, state, _ensure_repository
    ) -> None:
        config = SimpleNamespace(root=Path("/repo"), tmux_prefix="proof-platform")

        with redirect_stdout(io.StringIO()):
            returncode = command_start(config, SimpleNamespace(web=True))

        self.assertEqual(returncode, 0)
        self.assertEqual(
            start_session.call_args_list,
            [
                call(
                    config,
                    "proof-platform-orchestrator",
                    ["/repo/scripts/orchestrator-supervise"],
                    cwd=Path("/repo"),
                ),
                call(
                    config,
                    "proof-platform-web",
                    ["/repo/scripts/pnpmw", "--filter", "@proof/web", "dev"],
                    cwd=Path("/repo"),
                ),
            ],
        )
        state.return_value.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
