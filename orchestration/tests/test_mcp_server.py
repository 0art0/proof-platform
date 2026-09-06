from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from agentctl.mcp_server import call_tool, handle

from helpers import config_for


class McpServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        config = config_for(self.root)
        config_path = self.root / "orchestration" / "config.json"
        config_path.parent.mkdir(parents=True)
        config_path.write_text(json.dumps(config.raw), encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_protocol_exposes_only_bounded_orchestrator_tools(self) -> None:
        response = handle(
            self.root,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"},
            },
        )
        self.assertEqual(response["result"]["serverInfo"]["name"], "proof-platform-orchestrator")
        listed = handle(
            self.root, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
        )
        self.assertEqual(
            {tool["name"] for tool in listed["result"]["tools"]},
            {
                "proof_platform_submit_intent",
                "proof_platform_status",
                "proof_platform_messages",
            },
        )

    def test_remote_gateway_can_submit_and_inspect_durable_intent(self) -> None:
        submitted = call_tool(
            self.root, "proof_platform_submit_intent", {"message": "Build the next slice"}
        )
        messages = call_tool(
            self.root,
            "proof_platform_messages",
            {"messageId": submitted["messageId"]},
        )
        self.assertEqual(messages["messages"][0]["content"], "Build the next slice")
        status = call_tool(self.root, "proof_platform_status", {})
        self.assertEqual(status["todo"]["title"], "test")
        self.assertEqual(status["tasks"], [])


if __name__ == "__main__":
    unittest.main()
