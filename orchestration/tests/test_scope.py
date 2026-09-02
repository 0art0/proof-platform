from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from agentctl.scope import path_matches, scopes_overlap, validate_proposed_scopes, validate_scope
from agentctl.util import AgentCtlError

from helpers import initialize_repository


class ScopeTests(unittest.TestCase):
    def test_globs_and_overlap_are_conservative(self) -> None:
        self.assertTrue(path_matches("packages/kernel/src/a.ts", "packages/kernel/**"))
        self.assertFalse(path_matches("packages/library/a.ts", "packages/kernel/**"))
        self.assertTrue(scopes_overlap(["packages/kernel/**"], ["packages/kernel/src/**"]))
        self.assertFalse(scopes_overlap(["packages/kernel/**"], ["packages/library/**"]))

    def test_protected_scope_is_rejected_before_scheduling(self) -> None:
        with self.assertRaises(AgentCtlError):
            validate_proposed_scopes(["orchestration/**"], ["orchestration/**"])

    def test_complete_diff_scope_gate_includes_untracked_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = initialize_repository(root)
            allowed = root / "packages" / "kernel" / "new.ts"
            allowed.parent.mkdir(parents=True)
            allowed.write_text("export {};\n", encoding="utf-8")
            report = validate_scope(
                worktree=root,
                base_sha=base,
                allowed=["packages/kernel/**"],
                protected=["orchestration/**"],
                elevated=[],
            )
            self.assertEqual(report.changed_paths, ("packages/kernel/new.ts",))
            (root / "outside.txt").write_text("not allowed\n", encoding="utf-8")
            with self.assertRaisesRegex(AgentCtlError, "outside task scope"):
                validate_scope(
                    worktree=root,
                    base_sha=base,
                    allowed=["packages/kernel/**"],
                    protected=["orchestration/**"],
                    elevated=[],
                )

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_symlink_escape_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as outside:
            root = Path(temporary)
            base = initialize_repository(root)
            link = root / "packages" / "kernel" / "escape"
            link.parent.mkdir(parents=True)
            link.symlink_to(Path(outside))
            with self.assertRaisesRegex(AgentCtlError, "symlink escapes"):
                validate_scope(
                    worktree=root,
                    base_sha=base,
                    allowed=["packages/kernel/**"],
                    protected=[],
                    elevated=[],
                )


if __name__ == "__main__":
    unittest.main()

