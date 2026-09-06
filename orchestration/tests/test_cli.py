from __future__ import annotations

import io
import unittest
from contextlib import redirect_stdout

from agentctl.cli import main


class CliHelpTests(unittest.TestCase):
    def test_no_command_prints_idiots_guide(self) -> None:
        output = io.StringIO()

        with redirect_stdout(output):
            returncode = main([])

        self.assertEqual(returncode, 0)
        self.assertIn("Idiot's guide:", output.getvalue())
        self.assertIn('./scripts/agentctl ask "Describe the change you want"', output.getvalue())
        self.assertNotIn("==SUPPRESS==", output.getvalue())


if __name__ == "__main__":
    unittest.main()
